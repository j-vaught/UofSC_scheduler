#!/usr/bin/env python3
"""Build privacy-safe course and instructor grade analytics from registrar files."""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import html
import json
import re
import sqlite3
import statistics
import sys
import threading
import time
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parent
DEFAULT_GRADE_DIR = ROOT / "ANALYSIS_and TODO__UofSC Course Scheduler" / "uofsc_grade_data"
DEFAULT_CACHE = ROOT / "data" / "grade_matching_cache.sqlite"
DEFAULT_OUTPUT = ROOT / "data" / "grade_analytics.json"
BANNER_BASE = "https://banner.onecarolina.sc.edu/StudentRegistrationSsb/ssb"
GRADE_POINTS = {
    "A": 4.0,
    "B+": 3.5,
    "B": 3.0,
    "C+": 2.5,
    "C": 2.0,
    "D+": 1.5,
    "D": 1.0,
    "F": 0.0,
    "FN": 0.0,
}
COUNT_COLUMNS = [
    "AUDIT",
    "A",
    "A_GF",
    "B",
    "B_GF",
    "B+",
    "B+_GF",
    "C",
    "C_GF",
    "C+",
    "C+_GF",
    "D",
    "D_GF",
    "D+",
    "D+_GF",
    "F",
    "F_GF",
    "FN",
    "Incomplete",
    "IP",
    "No Grade",
    "NR",
    "S",
    "T",
    "U",
    "UN",
    "W",
    "WF",
    "Num Grades Posted",
]
_thread_local = threading.local()


def normalize_code(value: Any) -> str:
    """Normalize Excel values without retaining a trailing decimal."""
    if pd.isna(value):
        return ""
    text = str(value).strip().upper()
    return text[:-2] if text.endswith(".0") else text


def normalize_section(value: Any) -> str:
    """Normalize numeric sections to Banner's three-character representation."""
    text = normalize_code(value)
    return text.zfill(3) if text.isdigit() else text


def term_from_path(path: Path) -> str:
    match = re.match(r"(\d{6})", path.name)
    if not match:
        raise ValueError(f"Cannot infer term from {path.name}")
    return match.group(1)


def academic_year(term: str) -> int:
    """Return the ending year for a Summer/Fall through Spring academic year."""
    year = int(term[:4])
    return year + 1 if term[4:] in {"05", "08"} else year


def load_grade_sections(grade_dir: Path, campus: str) -> tuple[pd.DataFrame, dict[str, Any]]:
    frames: list[pd.DataFrame] = []
    raw_rows = 0
    exact_duplicates = 0
    for path in sorted(grade_dir.glob("*.xlsx")):
        frame = pd.read_excel(path)
        raw_rows += len(frame)
        frame["TERM"] = term_from_path(path)
        frame["SOURCE_FILE"] = path.name
        frames.append(frame)
    if not frames:
        raise FileNotFoundError(f"No registrar workbooks found in {grade_dir}")

    combined = pd.concat(frames, ignore_index=True)
    before = len(combined)
    combined = combined.drop_duplicates()
    exact_duplicates = before - len(combined)
    combined["CAMPUS"] = combined["CAMPUS"].map(normalize_code)
    combined = combined[combined["CAMPUS"] == campus.upper()].copy()
    combined["SUBJECT"] = combined["SUBJECT"].map(normalize_code)
    combined["COURSE_NUMBER"] = combined["COURSE_NUMBER"].map(normalize_code)
    combined["COURSE_SECTION_NUMBER"] = combined["COURSE_SECTION_NUMBER"].map(normalize_section)
    combined["TITLE"] = combined["TITLE"].fillna("").astype(str).str.strip()
    for column in COUNT_COLUMNS:
        if column not in combined:
            combined[column] = 0
        combined[column] = pd.to_numeric(combined[column], errors="coerce").fillna(0).astype(int)

    keys = ["TERM", "CAMPUS", "SUBJECT", "COURSE_NUMBER", "COURSE_SECTION_NUMBER"]
    duplicate_groups = int(
        combined.duplicated(keys, keep=False)
        .groupby(combined[keys].apply(tuple, axis=1))
        .any()
        .sum()
    )
    aggregation: dict[str, Any] = {column: "sum" for column in COUNT_COLUMNS}
    aggregation.update({"TITLE": "first", "SOURCE_FILE": "first"})
    sections = combined.groupby(keys, as_index=False).agg(aggregation)
    status_totals = sections[
        [column for column in COUNT_COLUMNS if column != "Num Grades Posted"]
    ].sum(axis=1)
    posted_matches = int((status_totals == sections["Num Grades Posted"]).sum())
    return sections, {
        "raw_rows": raw_rows,
        "campus_rows_after_exact_deduplication": len(combined),
        "normalized_sections": len(sections),
        "exact_duplicates_removed": exact_duplicates,
        "partitioned_section_groups_aggregated": duplicate_groups,
        "posted_grade_count_exact_matches": posted_matches,
        "posted_grade_count_match_rate": round(posted_matches / len(sections), 4),
    }


def initialize_cache(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS subject_search (
            term TEXT NOT NULL,
            subject TEXT NOT NULL,
            payload TEXT NOT NULL,
            PRIMARY KEY (term, subject)
        );
        CREATE TABLE IF NOT EXISTS faculty (
            term TEXT NOT NULL,
            crn TEXT NOT NULL,
            payload TEXT NOT NULL,
            PRIMARY KEY (term, crn)
        );
        """
    )
    return connection


def establish_session(term: str) -> requests.Session:
    session = requests.Session()
    session.headers.update({"User-Agent": "Mozilla/5.0 UofSC-Scheduler-Data/1.0"})
    try:
        session.get(f"{BANNER_BASE}/classSearch/classSearch", timeout=30)
    except requests.RequestException:
        pass
    response = session.post(
        f"{BANNER_BASE}/term/search?mode=search",
        data={
            "term": term,
            "studyPath": "",
            "studyPathText": "",
            "startDatepicker": "",
            "endDatepicker": "",
            "mepCode": "COL",
        },
        timeout=30,
    )
    response.raise_for_status()
    return session


def fetch_term(session: requests.Session, term: str) -> list[dict[str, Any]]:
    def page(offset: int) -> dict[str, Any]:
        for attempt in range(4):
            try:
                response = session.get(
                    f"{BANNER_BASE}/searchResults/searchResults",
                    params={
                        "txt_term": term,
                        "pageOffset": offset,
                        "pageMaxSize": 500,
                    },
                    timeout=60,
                )
                response.raise_for_status()
                return response.json()
            except (requests.RequestException, ValueError):
                if attempt == 3:
                    raise
                time.sleep(0.5 * (2**attempt))
        raise RuntimeError("unreachable")

    first = page(0)
    total = int(first.get("totalCount", 0))
    payloads = [first]
    offsets = list(range(500, total, 500))
    if offsets:
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
            payloads.extend(executor.map(page, offsets))

    rows = []
    for payload in payloads:
        for row in payload.get("data", []):
            rows.append(
                {
                    "subject": row.get("subject"),
                    "courseNumber": row.get("courseNumber"),
                    "sequenceNumber": row.get("sequenceNumber"),
                    "courseReferenceNumber": row.get("courseReferenceNumber"),
                }
            )
    return rows


def cached_subjects(
    connection: sqlite3.Connection, sections: pd.DataFrame
) -> dict[tuple[str, str, str, str], dict[str, Any]]:
    section_index: dict[tuple[str, str, str, str], dict[str, Any]] = {}
    requests_by_term = sections.groupby("TERM")["SUBJECT"].unique().to_dict()
    for term in sorted(requests_by_term):
        session = establish_session(term)
        cached = connection.execute(
            "SELECT payload FROM subject_search WHERE term=? AND subject='*'", (term,)
        ).fetchone()
        if cached:
            rows = json.loads(cached[0])
        else:
            rows = fetch_term(session, term)
            connection.execute(
                "INSERT OR REPLACE INTO subject_search VALUES (?, '*', ?)",
                (term, json.dumps(rows, separators=(",", ":"))),
            )
            connection.commit()
        for row in rows:
            key = (
                term,
                normalize_code(row.get("subject")),
                normalize_code(row.get("courseNumber")),
                normalize_section(row.get("sequenceNumber")),
            )
            section_index[key] = row
        print(f"Indexed Banner sections for {term}", flush=True)
    return section_index


def worker_session(term: str) -> requests.Session:
    sessions = getattr(_thread_local, "sessions", None)
    if sessions is None:
        sessions = {}
        _thread_local.sessions = sessions
    if term not in sessions:
        sessions[term] = establish_session(term)
    return sessions[term]


def fetch_faculty(term_crn: tuple[str, str]) -> tuple[str, str, list[dict[str, Any]]]:
    term, crn = term_crn
    session = worker_session(term)
    for attempt in range(4):
        try:
            response = session.get(
                f"{BANNER_BASE}/searchResults/getFacultyMeetingTimes",
                params={"term": term, "courseReferenceNumber": crn},
                timeout=45,
            )
            response.raise_for_status()
            faculty: dict[str, dict[str, Any]] = {}
            for meeting in response.json().get("fmt", []):
                for member in meeting.get("faculty", []):
                    identity = (
                        normalize_code(member.get("bannerId"))
                        or str(member.get("emailAddress", "")).strip().lower()
                        or str(member.get("displayName", "")).strip().lower()
                    )
                    if identity:
                        faculty[identity] = {
                            "banner_id": normalize_code(member.get("bannerId")),
                            "email": str(member.get("emailAddress", "")).strip().lower(),
                            "name": str(member.get("displayName", "")).strip(),
                            "primary": bool(member.get("primaryIndicator")),
                        }
            return term, crn, list(faculty.values())
        except (requests.RequestException, ValueError):
            if attempt == 3:
                raise
            time.sleep(0.5 * (2**attempt))
            _thread_local.sessions.pop(term, None)
            session = worker_session(term)
    raise RuntimeError("unreachable")


def cached_faculty(
    connection: sqlite3.Connection,
    matched_rows: list[tuple[pd.Series, dict[str, Any]]],
    workers: int,
) -> dict[tuple[str, str], list[dict[str, Any]]]:
    needed = sorted(
        {
            (str(section["TERM"]), str(banner.get("courseReferenceNumber", "")))
            for section, banner in matched_rows
            if banner.get("courseReferenceNumber")
        }
    )
    result: dict[tuple[str, str], list[dict[str, Any]]] = {}
    missing: list[tuple[str, str]] = []
    for term, crn in needed:
        cached = connection.execute(
            "SELECT payload FROM faculty WHERE term=? AND crn=?", (term, crn)
        ).fetchone()
        if cached:
            result[(term, crn)] = json.loads(cached[0])
        else:
            missing.append((term, crn))

    if missing:
        print(f"Fetching faculty for {len(missing):,} sections with {workers} workers", flush=True)
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {executor.submit(fetch_faculty, item): item for item in missing}
            completed = 0
            for future in concurrent.futures.as_completed(futures):
                term, crn, faculty = future.result()
                result[(term, crn)] = faculty
                connection.execute(
                    "INSERT OR REPLACE INTO faculty VALUES (?, ?, ?)",
                    (term, crn, json.dumps(faculty, separators=(",", ":"))),
                )
                completed += 1
                if completed % 1000 == 0:
                    connection.commit()
                    print(f"Faculty matches {completed:,}/{len(missing):,}", flush=True)
        connection.commit()
    return result


def public_instructor_id(member: dict[str, Any]) -> str:
    source = member.get("banner_id") or member.get("email") or member.get("name", "unknown")
    return "prof_" + hashlib.sha256(f"uofsc-scheduler:{source.lower()}".encode()).hexdigest()[:16]


def grade_counts(section: pd.Series) -> dict[str, int]:
    return {grade: int(section.get(grade, 0)) for grade in GRADE_POINTS}


def combine_counts(target: dict[str, int], source: dict[str, int]) -> None:
    for grade, count in source.items():
        target[grade] = target.get(grade, 0) + count


def summarize_counts(counts: dict[str, int]) -> tuple[int, float | None]:
    denominator = sum(counts.values())
    if not denominator:
        return 0, None
    points = sum(GRADE_POINTS[grade] * count for grade, count in counts.items())
    return denominator, round(points / denominator, 3)


@dataclass
class Aggregate:
    sections: set[str]
    counts: dict[str, int]
    team_sections: set[str]

    @classmethod
    def create(cls) -> Aggregate:
        return cls(set(), {}, set())

    def add(self, section_id: str, counts: dict[str, int], team_taught: bool) -> None:
        self.sections.add(section_id)
        combine_counts(self.counts, counts)
        if team_taught:
            self.team_sections.add(section_id)

    def export(self) -> dict[str, Any]:
        students, gpa = summarize_counts(self.counts)
        return {
            "sections": len(self.sections),
            "graded_students": students,
            "average_gpa": gpa,
            "grade_counts": self.counts,
            "team_taught_sections": len(self.team_sections),
        }


def build_analytics(
    sections: pd.DataFrame,
    section_index: dict[tuple[str, str, str, str], dict[str, Any]],
    faculty_index: dict[tuple[str, str], list[dict[str, Any]]],
    quality: dict[str, Any],
) -> dict[str, Any]:
    course_totals: defaultdict[str, Aggregate] = defaultdict(Aggregate.create)
    course_years: defaultdict[tuple[str, int], Aggregate] = defaultdict(Aggregate.create)
    course_instructors: defaultdict[tuple[str, str], Aggregate] = defaultdict(Aggregate.create)
    professor_totals: defaultdict[str, Aggregate] = defaultdict(Aggregate.create)
    professor_courses: defaultdict[tuple[str, str], Aggregate] = defaultdict(Aggregate.create)
    professor_years: defaultdict[tuple[str, int], Aggregate] = defaultdict(Aggregate.create)
    professor_year_courses: defaultdict[tuple[str, int], set[str]] = defaultdict(set)
    professor_names: dict[str, str] = {}
    professor_terms: defaultdict[str, set[str]] = defaultdict(set)
    matched = 0
    with_faculty = 0
    team_taught = 0
    unmatched_examples: list[str] = []
    term_quality: defaultdict[str, dict[str, int]] = defaultdict(
        lambda: {"sections": 0, "banner_matches": 0, "faculty_matches": 0}
    )

    for _, section in sections.iterrows():
        key = (
            str(section["TERM"]),
            str(section["SUBJECT"]),
            str(section["COURSE_NUMBER"]),
            str(section["COURSE_SECTION_NUMBER"]),
        )
        term = key[0]
        term_quality[term]["sections"] += 1
        course = f"{key[1]} {key[2]}"
        year = academic_year(term)
        section_id = ":".join(key)
        counts = grade_counts(section)
        course_totals[course].add(section_id, counts, False)
        course_years[(course, year)].add(section_id, counts, False)
        banner = section_index.get(key)
        if banner is None:
            if len(unmatched_examples) < 25:
                unmatched_examples.append(" ".join(key))
            continue
        matched += 1
        term_quality[term]["banner_matches"] += 1
        crn = str(banner.get("courseReferenceNumber", ""))
        members = faculty_index.get((term, crn), [])
        is_team = len(members) > 1
        if is_team:
            course_totals[course].team_sections.add(section_id)
            course_years[(course, year)].team_sections.add(section_id)
        if not members:
            continue
        with_faculty += 1
        term_quality[term]["faculty_matches"] += 1
        if is_team:
            team_taught += 1
        for member in members:
            professor_id = public_instructor_id(member)
            professor_names[professor_id] = html.unescape(
                member.get("name") or "Unknown instructor"
            )
            professor_terms[professor_id].add(term)
            professor_totals[professor_id].add(section_id, counts, is_team)
            professor_courses[(professor_id, course)].add(section_id, counts, is_team)
            professor_years[(professor_id, year)].add(section_id, counts, is_team)
            professor_year_courses[(professor_id, year)].add(course)
            course_instructors[(course, professor_id)].add(section_id, counts, is_team)

    earliest_term = str(sections["TERM"].min())
    latest_term = str(sections["TERM"].max())
    available_terms = sorted(str(term) for term in sections["TERM"].unique())
    term_positions = {term: index for index, term in enumerate(available_terms)}
    earliest_year = academic_year(earliest_term)
    latest_year = academic_year(latest_term)
    courses: dict[str, Any] = {}
    for course, aggregate in sorted(course_totals.items()):
        data = aggregate.export()
        data["years"] = [
            {"academic_year": year, **course_years[(course, year)].export()}
            for year in range(earliest_year, latest_year + 1)
            if (course, year) in course_years
        ]
        data["instructors"] = [
            {
                "id": professor_id,
                "name": professor_names[professor_id],
                **course_instructors[(course, professor_id)].export(),
            }
            for professor_id in sorted(
                (pid for c, pid in course_instructors if c == course),
                key=lambda pid: (
                    -len(course_instructors[(course, pid)].sections),
                    professor_names[pid],
                ),
            )
        ]
        courses[course] = data

    professors: dict[str, Any] = {}
    for professor_id, aggregate in sorted(professor_totals.items()):
        terms = sorted(professor_terms[professor_id])
        first_term = terms[0]
        last_term = terms[-1]
        first_year = academic_year(first_term)
        last_year = academic_year(last_term)
        annual_sections = [
            len(professor_years[(professor_id, year)].sections)
            for year in range(first_year, last_year + 1)
            if (professor_id, year) in professor_years
        ]
        annual_courses = [
            len(professor_year_courses[(professor_id, year)])
            for year in range(first_year, last_year + 1)
            if (professor_id, year) in professor_years
        ]
        observed_span = term_positions[last_term] - term_positions[first_term] + 1
        history_limited = first_term == earliest_term
        semester_word = "semester" if observed_span == 1 else "semesters"
        experience_label = (
            f">= {observed_span} {semester_word}"
            if history_limited
            else f"{observed_span} {semester_word}"
        )
        data = {
            "name": professor_names[professor_id],
            **aggregate.export(),
            "first_observed_term": first_term,
            "last_observed_term": last_term,
            "observed_teaching_semesters": len(terms),
            "experience_semesters": observed_span,
            "experience_label": experience_label,
            "history_limited": history_limited,
            "typical_sections_per_year": (
                round(float(statistics.median(annual_sections)), 1) if annual_sections else 0
            ),
            "typical_courses_per_year": (
                round(float(statistics.median(annual_courses)), 1) if annual_courses else 0
            ),
            "average_sections_per_active_year": (
                round(statistics.mean(annual_sections), 1) if annual_sections else 0
            ),
        }
        data["courses"] = [
            {"code": course, **professor_courses[(professor_id, course)].export()}
            for course in sorted(
                (course for pid, course in professor_courses if pid == professor_id),
                key=lambda code: (-len(professor_courses[(professor_id, code)].sections), code),
            )
        ]
        data["years"] = [
            {
                "academic_year": year,
                "distinct_courses": len(professor_year_courses[(professor_id, year)]),
                **professor_years[(professor_id, year)].export(),
            }
            for year in range(first_year, last_year + 1)
            if (professor_id, year) in professor_years
        ]
        professors[professor_id] = data

    quality.update(
        {
            "banner_section_matches": matched,
            "sections_with_identified_faculty": with_faculty,
            "unmatched_sections": len(sections) - matched,
            "team_taught_sections": team_taught,
            "banner_section_match_rate": round(matched / len(sections), 4),
            "identified_faculty_rate": round(with_faculty / len(sections), 4),
            "term_coverage": [
                {"term": term, **counts} for term, counts in sorted(term_quality.items())
            ],
        }
    )
    return {
        "meta": {
            "generated_at": datetime.now(UTC).isoformat(),
            "campus": "COL",
            "earliest_term": earliest_term,
            "latest_term": latest_term,
            "academic_years_available": latest_year - earliest_year + 1,
            "semesters_available": len(available_terms),
            "gpa_scale": GRADE_POINTS,
            "gpa_excludes": [
                "withdrawals, audits, incompletes, pass/fail outcomes, transfers, and missing grades"
            ],
            "professor_identity": "privacy-safe hash of Banner identity; display name is not a join key",
            "experience_definition": (
                "available-semester span from first to last observed section; earliest-bound records use >="
            ),
            "typical_load_definition": "median section assignments across active academic years",
            "quality": quality,
            "unmatched_examples": unmatched_examples,
        },
        "courses": courses,
        "professors": professors,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--grade-dir", type=Path, default=DEFAULT_GRADE_DIR)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--campus", default="COL")
    parser.add_argument("--workers", type=int, default=16)
    args = parser.parse_args()

    sections, quality = load_grade_sections(args.grade_dir, args.campus)
    print(f"Loaded {len(sections):,} normalized {args.campus} sections", flush=True)
    connection = initialize_cache(args.cache)
    try:
        section_index = cached_subjects(connection, sections)
        matched_rows = []
        for _, section in sections.iterrows():
            key = (
                str(section["TERM"]),
                str(section["SUBJECT"]),
                str(section["COURSE_NUMBER"]),
                str(section["COURSE_SECTION_NUMBER"]),
            )
            if key in section_index:
                matched_rows.append((section, section_index[key]))
        print(f"Matched {len(matched_rows):,}/{len(sections):,} sections to Banner", flush=True)
        faculty_index = cached_faculty(connection, matched_rows, max(1, args.workers))
        analytics = build_analytics(sections, section_index, faculty_index, quality)
    finally:
        connection.close()

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(analytics, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {args.output} ({args.output.stat().st_size / 1_000_000:.1f} MB)", flush=True)
    print(json.dumps(analytics["meta"]["quality"], indent=2), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

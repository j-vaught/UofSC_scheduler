#!/usr/bin/env python3
"""Build privacy-safe offering history from explicitly completed term records."""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tools.static_release import SCHEMA_VERSION, comma_values, utc_now


TERM_RE = re.compile(r"^\d{4}(01|05|08)$")
COVERAGE_SEMANTICS = (
    "A missing course means not offered only for terms listed in complete_terms. "
    "Incomplete, failed, and absent term sources remain unknown and are excluded from denominators."
)


@dataclass(frozen=True)
class TermRecord:
    """One campus-wide term snapshot with an explicit completeness decision."""

    term: str
    complete: bool
    sections: list[dict[str, Any]]
    source: str
    campus: str = "COL"
    error: str | None = None

    def __post_init__(self) -> None:
        if not TERM_RE.fullmatch(self.term):
            raise ValueError(f"Invalid academic term code: {self.term!r}")
        if self.complete and self.error:
            raise ValueError(f"Term {self.term} cannot be both complete and failed")


def normalize_code(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip().upper())


def _number(value: Any) -> int | None:
    if isinstance(value, bool) or value in (None, ""):
        return None
    try:
        return int(float(str(value).replace(",", "").strip()))
    except (TypeError, ValueError):
        return None


def _section_value(section: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in section:
            return section[key]
    return None


def load_term_file(path: Path) -> TermRecord:
    """Load a declared term envelope; plain arrays require a sidecar declaration."""
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, list):
        raise ValueError(
            f"{path} is an undeclared section list. Wrap it with term, complete, campus, and sections."
        )
    if not isinstance(payload, dict):
        raise ValueError(f"{path} must contain a JSON object")
    term = str(payload.get("term") or "")
    if "complete" not in payload:
        raise ValueError(f"{path} must explicitly declare complete as true or false")
    sections = payload.get("sections", payload.get("data", []))
    if not isinstance(sections, list):
        raise ValueError(f"{path} sections must be a list")
    return TermRecord(
        term=term,
        complete=bool(payload["complete"]),
        sections=sections,
        source=path.name,
        campus=normalize_code(payload.get("campus", "COL")),
        error=str(payload["error"]) if payload.get("error") else None,
    )


def load_term_directory(path: Path) -> list[TermRecord]:
    return [load_term_file(file) for file in sorted(path.glob("*.json"))]


def load_sqlite_terms(
    path: Path,
    complete_terms: list[str],
    *,
    campus: str = "COL",
) -> list[TermRecord]:
    """Read cached whole-term Banner payloads with caller-declared completion."""
    if not complete_terms:
        raise ValueError("SQLite inputs require at least one explicitly complete term")
    requested = set(complete_terms)
    connection = sqlite3.connect(path)
    try:
        rows = connection.execute(
            "SELECT term, payload FROM subject_search WHERE subject='*' ORDER BY term"
        ).fetchall()
    finally:
        connection.close()
    found: set[str] = set()
    records: list[TermRecord] = []
    for term_value, payload in rows:
        term = str(term_value)
        if term not in requested:
            continue
        sections = json.loads(payload)
        if not isinstance(sections, list):
            raise ValueError(f"Cached term {term} is not a complete section list")
        records.append(
            TermRecord(
                term=term,
                complete=True,
                sections=sections,
                source=f"{path.name}:subject_search:{term}:*",
                campus=campus,
            )
        )
        found.add(term)
    missing = sorted(requested - found)
    if missing:
        raise ValueError(f"No whole-term cache records for: {', '.join(missing)}")
    return records


def validate_term_records(records: list[TermRecord], *, campus: str) -> None:
    if not records:
        raise ValueError("At least one term record is required")
    seen: set[str] = set()
    for record in records:
        if record.term in seen:
            raise ValueError(f"Duplicate term source: {record.term}")
        seen.add(record.term)
        if record.campus != campus:
            raise ValueError(f"Term {record.term} is for campus {record.campus}, expected {campus}")


def build_history_shards(
    records: list[TermRecord],
    *,
    subjects: list[str] | None = None,
    campus: str = "COL",
    generated_at: str | None = None,
) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    """Create per-subject histories where false offerings require complete coverage."""
    validate_term_records(records, campus=campus)
    selected = set(subjects or [])
    complete = sorted(
        (record for record in records if record.complete and not record.error),
        key=lambda record: record.term,
    )
    incomplete = sorted(
        (record for record in records if not record.complete or record.error),
        key=lambda record: record.term,
    )
    if not complete:
        raise ValueError("No explicitly complete term records were supplied")

    term_courses: dict[str, dict[str, dict[str, dict[str, Any]]]] = defaultdict(
        lambda: defaultdict(dict)
    )
    observed_subjects: set[str] = set()
    per_term_coverage: list[dict[str, Any]] = []
    for record in complete:
        kept_sections = 0
        enrollment_fields = 0
        capacity_fields = 0
        aggregates: dict[tuple[str, str], dict[str, Any]] = {}
        for section in record.sections:
            subject = normalize_code(_section_value(section, "subject", "SUBJECT"))
            number = normalize_code(
                _section_value(section, "courseNumber", "course_number", "COURSE_NUMBER")
            )
            if not subject or not number or (selected and subject not in selected):
                continue
            kept_sections += 1
            observed_subjects.add(subject)
            key = (subject, number)
            aggregate = aggregates.setdefault(
                key,
                {
                    "sections": 0,
                    "enrollment": 0,
                    "capacity": 0,
                    "enrollment_sections": 0,
                    "capacity_sections": 0,
                    "title": "",
                },
            )
            aggregate["sections"] += 1
            title = str(_section_value(section, "courseTitle", "title", "TITLE") or "").strip()
            if title and not aggregate["title"]:
                aggregate["title"] = title
            enrollment = _number(
                _section_value(section, "enrollment", "actualEnrollment", "ENROLLMENT")
            )
            capacity = _number(
                _section_value(
                    section,
                    "maximumEnrollment",
                    "capacity",
                    "maxEnrollment",
                    "CAPACITY",
                )
            )
            if enrollment is not None:
                aggregate["enrollment"] += enrollment
                aggregate["enrollment_sections"] += 1
                enrollment_fields += 1
            if capacity is not None:
                aggregate["capacity"] += capacity
                aggregate["capacity_sections"] += 1
                capacity_fields += 1
        for (subject, number), aggregate in aggregates.items():
            term_courses[subject][record.term][number] = aggregate
        per_term_coverage.append(
            {
                "term": record.term,
                "complete": True,
                "source_sections": len(record.sections),
                "selected_sections": kept_sections,
                "sections_with_enrollment": enrollment_fields,
                "sections_with_capacity": capacity_fields,
            }
        )

    complete_terms = [record.term for record in complete]
    timestamp = generated_at or utc_now()
    shards: dict[str, dict[str, Any]] = {}
    for subject in sorted(selected or observed_subjects):
        course_numbers = sorted(
            {number for courses in term_courses.get(subject, {}).values() for number in courses}
        )
        courses: dict[str, Any] = {}
        for number in course_numbers:
            title = next(
                (
                    term_courses[subject][term][number]["title"]
                    for term in reversed(complete_terms)
                    if number in term_courses.get(subject, {}).get(term, {})
                    and term_courses[subject][term][number]["title"]
                ),
                "",
            )
            observations = []
            for term in complete_terms:
                aggregate = term_courses.get(subject, {}).get(term, {}).get(number)
                if not aggregate:
                    observations.append({"term": term, "offered": False, "sections": 0})
                    continue
                observation: dict[str, Any] = {
                    "term": term,
                    "offered": True,
                    "sections": aggregate["sections"],
                }
                if aggregate["enrollment_sections"]:
                    observation["enrollment"] = aggregate["enrollment"]
                    observation["enrollment_sections"] = aggregate["enrollment_sections"]
                if aggregate["capacity_sections"]:
                    observation["capacity"] = aggregate["capacity"]
                    observation["capacity_sections"] = aggregate["capacity_sections"]
                observations.append(observation)
            courses[f"{subject} {number}"] = {"title": title, "terms": observations}
        shards[subject] = {
            "schema_version": SCHEMA_VERSION,
            "kind": "offering_history",
            "generated_at": timestamp,
            "campus": campus,
            "subject": subject,
            "coverage": {
                "complete_terms": complete_terms,
                "incomplete_terms": [
                    {
                        "term": record.term,
                        "reason": record.error or "source declared incomplete",
                    }
                    for record in incomplete
                ],
                "semantics": COVERAGE_SEMANTICS,
            },
            "courses": courses,
        }

    coverage = {
        "campus": campus,
        "complete_terms": complete_terms,
        "incomplete_terms": [record.term for record in incomplete],
        "first_complete_term": complete_terms[0],
        "last_complete_term": complete_terms[-1],
        "term_count": len(complete_terms),
        "subjects": sorted(shards),
        "term_sources": per_term_coverage,
        "semantics": COVERAGE_SEMANTICS,
    }
    return shards, coverage


def _write_plain_shards(output_dir: Path, shards: dict[str, dict[str, Any]]) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    for subject, payload in shards.items():
        destination = output_dir / f"offerings-{subject}.json"
        destination.write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True),
            encoding="utf-8",
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--input-dir", type=Path)
    source.add_argument("--sqlite-cache", type=Path)
    parser.add_argument("--complete-terms", action="append", default=[])
    parser.add_argument("--subjects", action="append", default=[])
    parser.add_argument("--campus", default="COL")
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()

    subjects = comma_values(args.subjects)
    complete_terms = comma_values(args.complete_terms)
    if args.sqlite_cache:
        records = load_sqlite_terms(
            args.sqlite_cache, complete_terms, campus=normalize_code(args.campus)
        )
    else:
        records = load_term_directory(args.input_dir)
    shards, coverage = build_history_shards(
        records,
        subjects=subjects,
        campus=normalize_code(args.campus),
    )
    _write_plain_shards(args.output_dir, shards)
    (args.output_dir / "coverage.json").write_text(
        json.dumps(coverage, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(
        f"Wrote {len(shards)} history shards covering {coverage['term_count']} complete terms",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

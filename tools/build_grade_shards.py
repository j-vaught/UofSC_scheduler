#!/usr/bin/env python3
"""Shard aggregate grade analytics for privacy-safe browser downloads."""

from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, cast

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tools.static_release import SCHEMA_VERSION, assert_privacy_safe, comma_values, utc_now


PROFESSOR_ID_RE = re.compile(r"^prof_[0-9a-f]{16}$")
PROFESSOR_PREFIX_LENGTH = 1
MIN_PUBLIC_GRADED_STUDENTS = 10


def _subject(code: str) -> str:
    return str(code).partition(" ")[0].strip().upper()


def _graded_students(record: dict[str, Any]) -> int:
    try:
        return int(record.get("graded_students", 0))
    except (TypeError, ValueError):
        return 0


def _public_course_record(
    course: dict[str, Any],
    suppressed: Counter[str],
) -> dict[str, Any] | None:
    """Remove grade aggregates that represent fewer than ten students."""
    if _graded_students(course) < MIN_PUBLIC_GRADED_STUDENTS:
        suppressed["courses"] += 1
        return None
    public = copy.deepcopy(course)
    instructors = []
    for instructor in public.get("instructors", []):
        if _graded_students(instructor) < MIN_PUBLIC_GRADED_STUDENTS:
            suppressed["course_instructor_records"] += 1
            continue
        instructors.append(instructor)
    public["instructors"] = instructors
    return public


def _public_professor_record(
    professor: dict[str, Any],
    suppressed: Counter[str],
) -> dict[str, Any] | None:
    """Publish professor summaries only when their aggregate is large enough."""
    if _graded_students(professor) < MIN_PUBLIC_GRADED_STUDENTS:
        suppressed["professors"] += 1
        return None
    public = copy.deepcopy(professor)
    for field, counter_key in (
        ("courses", "professor_course_records"),
        ("years", "professor_year_records"),
    ):
        retained = []
        for record in public.get(field, []):
            if _graded_students(record) < MIN_PUBLIC_GRADED_STUDENTS:
                suppressed[counter_key] += 1
                continue
            retained.append(record)
        public[field] = retained
    return public


def build_grade_shards(
    analytics: dict[str, Any],
    *,
    subjects: list[str] | None = None,
    generated_at: str | None = None,
) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]], dict[str, Any]]:
    """Split course aggregates by subject and professor aggregates by ID prefix."""
    if not isinstance(analytics.get("courses"), dict) or not isinstance(
        analytics.get("professors"), dict
    ):
        raise ValueError("Grade analytics must contain courses and professors objects")
    requested = set(subjects or [])
    courses_by_subject: dict[str, dict[str, Any]] = defaultdict(dict)
    selected_professors: set[str] = set()
    suppressed: Counter[str] = Counter()
    for code, course in analytics["courses"].items():
        subject = _subject(code)
        if requested and subject not in requested:
            continue
        public_course = _public_course_record(course, suppressed)
        if public_course is None:
            continue
        courses_by_subject[subject][code] = public_course
        for instructor in public_course.get("instructors", []):
            professor_id = str(instructor.get("id", ""))
            if not PROFESSOR_ID_RE.fullmatch(professor_id):
                raise ValueError(f"Course {code} contains a non-public professor identifier")
            selected_professors.add(professor_id)

    missing_subjects = requested - set(courses_by_subject)
    if missing_subjects:
        raise ValueError(f"No grade aggregates for subjects: {', '.join(sorted(missing_subjects))}")

    timestamp = generated_at or utc_now()
    source_meta = analytics.get("meta", {})
    coverage = {
        "earliest_term": source_meta.get("earliest_term"),
        "latest_term": source_meta.get("latest_term"),
        "semesters_available": source_meta.get("semesters_available"),
        "academic_years_available": source_meta.get("academic_years_available"),
        "gpa_scale": source_meta.get("gpa_scale", {}),
        "gpa_excludes": source_meta.get("gpa_excludes", []),
        "subjects": sorted(courses_by_subject),
        "privacy_suppression": {
            "minimum_graded_students": MIN_PUBLIC_GRADED_STUDENTS,
            "rule": (
                "Course, professor, professor-course, professor-year, and "
                "course-instructor grade aggregates with fewer than ten graded "
                "students are omitted from public artifacts."
            ),
            "suppressed": dict(sorted(suppressed.items())),
        },
    }
    course_shards = {
        subject: {
            "schema_version": SCHEMA_VERSION,
            "kind": "course_grade_aggregates",
            "generated_at": timestamp,
            "subject": subject,
            "coverage": coverage,
            "courses": dict(sorted(courses.items())),
        }
        for subject, courses in sorted(courses_by_subject.items())
    }

    professors_by_prefix: dict[str, dict[str, Any]] = defaultdict(dict)
    for professor_id in sorted(selected_professors):
        professor = analytics["professors"].get(professor_id)
        if professor is None:
            raise ValueError(f"Missing professor aggregate for {professor_id}")
        professor = _public_professor_record(professor, suppressed)
        if professor is None:
            continue
        prefix = professor_id.removeprefix("prof_")[:PROFESSOR_PREFIX_LENGTH]
        professors_by_prefix[prefix][professor_id] = professor
    professor_shards = {
        prefix: {
            "schema_version": SCHEMA_VERSION,
            "kind": "professor_grade_aggregates",
            "generated_at": timestamp,
            "prefix": prefix,
            "coverage": coverage,
            "professors": dict(sorted(professors.items())),
        }
        for prefix, professors in sorted(professors_by_prefix.items())
    }

    for shard in [*course_shards.values(), *professor_shards.values()]:
        assert_privacy_safe(shard)
    privacy_policy = cast(dict[str, Any], coverage["privacy_suppression"])
    privacy_policy["suppressed"] = dict(sorted(suppressed.items()))
    summary = {
        **coverage,
        "course_count": sum(len(courses) for courses in courses_by_subject.values()),
        "professor_count": sum(len(professors) for professors in professors_by_prefix.values()),
        "course_shards": len(course_shards),
        "professor_shards": len(professor_shards),
    }
    return course_shards, professor_shards, summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--subjects", action="append", default=[])
    args = parser.parse_args()

    analytics = json.loads(args.input.read_text(encoding="utf-8"))
    course_shards, professor_shards, summary = build_grade_shards(
        analytics,
        subjects=comma_values(args.subjects),
    )
    course_dir = args.output_dir / "courses"
    professor_dir = args.output_dir / "professors"
    course_dir.mkdir(parents=True, exist_ok=True)
    professor_dir.mkdir(parents=True, exist_ok=True)
    for subject, payload in course_shards.items():
        (course_dir / f"courses-{subject}.json").write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True),
            encoding="utf-8",
        )
    for prefix, payload in professor_shards.items():
        (professor_dir / f"professors-{prefix}.json").write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True),
            encoding="utf-8",
        )
    (args.output_dir / "coverage.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(
        f"Wrote {summary['course_shards']} course shards and "
        f"{summary['professor_shards']} professor shards",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

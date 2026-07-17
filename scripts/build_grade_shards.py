#!/usr/bin/env python3
"""Shard aggregate grade analytics for privacy-safe browser downloads."""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.static_release import SCHEMA_VERSION, assert_privacy_safe, comma_values, utc_now


PROFESSOR_ID_RE = re.compile(r"^prof_[0-9a-f]{16}$")
PROFESSOR_PREFIX_LENGTH = 1


def _subject(code: str) -> str:
    return str(code).partition(" ")[0].strip().upper()


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
    for code, course in analytics["courses"].items():
        subject = _subject(code)
        if requested and subject not in requested:
            continue
        courses_by_subject[subject][code] = course
        for instructor in course.get("instructors", []):
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
    summary = {
        **coverage,
        "course_count": sum(len(courses) for courses in courses_by_subject.values()),
        "professor_count": len(selected_professors),
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

#!/usr/bin/env python3
"""Build browser-readable catalog and curriculum artifacts."""

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


COURSE_CODE_RE = re.compile(r"^([A-Z]{2,8})\s+([A-Z0-9]{3,5})$")
MAP_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")


def normalize_course(record: dict[str, Any]) -> dict[str, Any]:
    code = " ".join(str(record.get("code", "")).upper().split())
    match = COURSE_CODE_RE.fullmatch(code)
    if not match:
        raise ValueError(f"Invalid catalog course code: {code!r}")
    subject = match.group(1)
    return {
        "code": code,
        "subject": subject,
        "title": str(record.get("title", "")).strip(),
        "description": str(record.get("description", "")).strip(),
        "key": str(record.get("key", "")).strip(),
        "prerequisite_text": str(record.get("prereq", "")).strip(),
        "hours": str(record.get("hours", "")).strip(),
    }


def build_catalog_shards(
    records: list[dict[str, Any]],
    *,
    subjects: list[str] | None = None,
    generated_at: str | None = None,
) -> tuple[dict[str, dict[str, Any]], dict[str, Any], dict[str, Any]]:
    """Split the stable bulletin catalog by subject and build its subject index."""
    requested = set(subjects or [])
    courses_by_subject: dict[str, dict[str, Any]] = defaultdict(dict)
    for raw in records:
        if not isinstance(raw, dict):
            raise ValueError("Catalog records must be objects")
        course = normalize_course(raw)
        subject = course["subject"]
        if requested and subject not in requested:
            continue
        courses_by_subject[subject][course["code"]] = course
    missing = requested - set(courses_by_subject)
    if missing:
        raise ValueError(f"No catalog records for subjects: {', '.join(sorted(missing))}")

    timestamp = generated_at or utc_now()
    coverage = {
        "subjects": sorted(courses_by_subject),
        "subject_count": len(courses_by_subject),
        "course_count": sum(len(courses) for courses in courses_by_subject.values()),
    }
    shards = {
        subject: {
            "schema_version": SCHEMA_VERSION,
            "kind": "course_catalog",
            "generated_at": timestamp,
            "subject": subject,
            "courses": dict(sorted(courses.items())),
        }
        for subject, courses in sorted(courses_by_subject.items())
    }
    index = {
        "schema_version": SCHEMA_VERSION,
        "kind": "subject_index",
        "generated_at": timestamp,
        "subjects": [
            {"code": subject, "courses": len(courses_by_subject[subject])}
            for subject in sorted(courses_by_subject)
        ],
    }
    for payload in [*shards.values(), index]:
        assert_privacy_safe(payload)
    return shards, index, coverage


def load_major_maps(
    maps_dir: Path,
    *,
    generated_at: str | None = None,
) -> tuple[dict[str, dict[str, Any]], dict[str, Any], dict[str, Any]]:
    """Load locally reviewed major maps and create a compact discovery index."""
    timestamp = generated_at or utc_now()
    maps: dict[str, dict[str, Any]] = {}
    entries = []
    for path in sorted(maps_dir.glob("*.json")):
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise ValueError(f"Major map {path} must contain an object")
        map_id = str(payload.get("id") or path.stem).strip().lower()
        if not MAP_ID_RE.fullmatch(map_id):
            raise ValueError(f"Invalid major map identifier: {map_id!r}")
        public = {
            "schema_version": SCHEMA_VERSION,
            "kind": "major_map",
            "generated_at": timestamp,
            **payload,
            "id": map_id,
        }
        assert_privacy_safe(public)
        maps[map_id] = public
        entries.append(
            {
                "id": map_id,
                "major": str(payload.get("major", "")),
                "program": str(payload.get("program", "")),
                "college": str(payload.get("college", "")),
                "catalog_year": str(payload.get("catalog_year", "")),
                "total_credits": int(payload.get("total_credits_required", 120)),
            }
        )
    if not maps:
        raise ValueError(f"No major maps found in {maps_dir}")
    index = {
        "schema_version": SCHEMA_VERSION,
        "kind": "major_map_index",
        "generated_at": timestamp,
        "maps": entries,
    }
    coverage = {"map_count": len(entries), "map_ids": sorted(maps)}
    return maps, index, coverage


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--maps-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--subjects", action="append", default=[])
    args = parser.parse_args()

    records = json.loads(args.catalog.read_text(encoding="utf-8"))
    if not isinstance(records, list):
        raise ValueError("Catalog input must contain a list")
    shards, subject_index, _ = build_catalog_shards(
        records,
        subjects=comma_values(args.subjects),
    )
    maps, map_index, _ = load_major_maps(args.maps_dir)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "subjects.json").write_text(
        json.dumps(subject_index, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    for subject, payload in shards.items():
        (args.output_dir / f"courses-{subject}.json").write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True),
            encoding="utf-8",
        )
    (args.output_dir / "major-maps.json").write_text(
        json.dumps(map_index, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    for map_id, payload in maps.items():
        (args.output_dir / f"major-map-{map_id}.json").write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True),
            encoding="utf-8",
        )
    print(
        f"Wrote {len(shards)} catalog shards and {len(maps)} major maps",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

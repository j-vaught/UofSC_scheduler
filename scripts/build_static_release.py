#!/usr/bin/env python3
"""Build an immutable static-data release and publish its manifest last."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.build_catalog_shards import (
    build_catalog_shards,
    load_major_maps,
    major_map_runtime_projection,
)
from scripts.build_grade_shards import build_grade_shards
from scripts.build_offering_history import (
    build_history_shards,
    load_sqlite_terms,
    load_term_directory,
    normalize_code,
)
from scripts.static_release import (
    build_manifest,
    comma_values,
    publish_release_directory,
    utc_now,
    verify_artifact,
    write_immutable_json,
    write_manifest_atomic,
)


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_GRADES = ROOT / "data" / "generated" / "grade_analytics.json"
DEFAULT_HISTORY_CACHE = ROOT / "data" / "grade_matching_cache.sqlite"
DEFAULT_CATALOG = ROOT / "data" / "generated" / "course_data.json"
DEFAULT_MAPS_DIR = ROOT / "data" / "curated" / "major_maps"
DEFAULT_OUTPUT_ROOT = ROOT / "static" / "data"


def completed_grade_terms(analytics: dict[str, Any]) -> list[str]:
    """Use workbook-backed term coverage as the completion declaration."""
    rows = analytics.get("meta", {}).get("quality", {}).get("term_coverage", [])
    return sorted(
        {str(row.get("term", "")) for row in rows if isinstance(row, dict) and row.get("term")}
    )


def validate_full_history_metrics(coverage: dict[str, Any]) -> None:
    """Reject a full release when an entire populated term loses enrollment."""
    missing = [
        str(source.get("term", ""))
        for source in coverage.get("term_sources", [])
        if source.get("selected_sections", 0) > 0 and source.get("sections_with_enrollment", 0) == 0
    ]
    if missing:
        raise ValueError(
            "Full offering-history terms have no enrollment fields: " + ", ".join(missing)
        )


def build_release(
    *,
    grade_analytics_path: Path,
    output_root: Path,
    release_id: str,
    subjects: list[str] | None = None,
    history_cache: Path | None = None,
    term_directory: Path | None = None,
    complete_terms: list[str] | None = None,
    campus: str = "COL",
    generated_at: str | None = None,
    scope_kind: str = "full",
    catalog_path: Path | None = None,
    maps_dir: Path | None = None,
) -> tuple[Path, Path, dict[str, Any]]:
    """Build, validate, publish, and activate one immutable release."""
    if bool(history_cache) == bool(term_directory):
        raise ValueError("Supply exactly one history_cache or term_directory")
    analytics = json.loads(grade_analytics_path.read_text(encoding="utf-8"))
    timestamp = generated_at or utc_now()
    selected_subjects = sorted(set(subjects or []))
    course_shards, professor_shards, grade_coverage = build_grade_shards(
        analytics,
        subjects=selected_subjects,
        generated_at=timestamp,
    )
    catalog_shards: dict[str, dict[str, Any]] = {}
    subject_index: dict[str, Any] | None = None
    catalog_coverage: dict[str, Any] | None = None
    if catalog_path is not None:
        catalog_records = json.loads(catalog_path.read_text(encoding="utf-8"))
        if not isinstance(catalog_records, list):
            raise ValueError("Catalog input must contain a list")
        catalog_shards, subject_index, catalog_coverage = build_catalog_shards(
            catalog_records,
            subjects=selected_subjects,
            generated_at=timestamp,
        )
    major_maps: dict[str, dict[str, Any]] = {}
    major_map_index: dict[str, Any] | None = None
    curriculum_coverage: dict[str, Any] | None = None
    if maps_dir is not None:
        major_maps, major_map_index, curriculum_coverage = load_major_maps(
            maps_dir,
            generated_at=timestamp,
        )

    if history_cache:
        declared_complete_terms = sorted(set(complete_terms or completed_grade_terms(analytics)))
        if not declared_complete_terms:
            raise ValueError(
                "No complete terms supplied and grade analytics has no workbook-backed coverage"
            )
        term_records = load_sqlite_terms(
            history_cache,
            declared_complete_terms,
            campus=campus,
        )
    else:
        assert term_directory is not None
        term_records = load_term_directory(term_directory)
    history_shards, history_coverage = build_history_shards(
        term_records,
        subjects=selected_subjects,
        campus=campus,
        generated_at=timestamp,
    )
    if scope_kind == "full":
        validate_full_history_metrics(history_coverage)

    releases_root = output_root / "releases"
    releases_root.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{release_id}.tmp-", dir=releases_root))
    destination = releases_root / release_id
    artifacts: dict[str, dict[str, Any]] = {}
    lazy_major_map_artifacts: dict[str, dict[str, Any]] = {}
    try:
        for subject, payload in course_shards.items():
            name = f"grades/courses/{subject}"
            artifacts[name] = write_immutable_json(
                staging, f"grades/courses/courses-{subject}.json", payload
            )
        for prefix, payload in professor_shards.items():
            name = f"grades/professors/{prefix}"
            artifacts[name] = write_immutable_json(
                staging, f"grades/professors/professors-{prefix}.json", payload
            )
        for subject, payload in history_shards.items():
            name = f"history/{subject}"
            artifacts[name] = write_immutable_json(
                staging, f"history/offerings-{subject}.json", payload
            )
        for subject, payload in catalog_shards.items():
            name = f"catalog/courses/{subject}"
            artifacts[name] = write_immutable_json(
                staging, f"catalog/courses/courses-{subject}.json", payload
            )
        if subject_index is not None:
            artifacts["catalog/subjects"] = write_immutable_json(
                staging,
                "catalog/subjects.json",
                subject_index,
            )
        maps_by_year: dict[str, dict[str, dict[str, Any]]] = {}
        for map_id, payload in major_maps.items():
            year = str(payload.get("catalog_year") or "unknown")
            maps_by_year.setdefault(year, {})[map_id] = major_map_runtime_projection(payload)
        for year, year_maps in sorted(maps_by_year.items()):
            lazy_major_map_artifacts[year] = write_immutable_json(
                staging,
                f"major-maps/major-maps-{year}.json",
                {
                    "schema_version": 1,
                    "kind": "major_map_bundle",
                    "catalog_year": year,
                    "maps": year_maps,
                },
            )
        if major_map_index is not None:
            index_entries = {entry["id"]: entry for entry in major_map_index["maps"]}
            for map_id, payload in major_maps.items():
                year = str(payload.get("catalog_year") or "unknown")
                descriptor = lazy_major_map_artifacts[year]
                index_entries[map_id]["artifact"] = {
                    "url": f"releases/{release_id}/{descriptor['path']}",
                    "bytes": descriptor["bytes"],
                    "sha256": descriptor["sha256"],
                    "media_type": descriptor["media_type"],
                    "schema_version": descriptor["schema_version"],
                    "bundle_key": f"major-maps/catalog-year/{year}",
                    "entry_key": map_id,
                }
            artifacts["major-maps/index"] = write_immutable_json(
                staging,
                "major-maps/index.json",
                major_map_index,
            )

        indexes = {
            "schema_version": 1,
            "kind": "static_release_index",
            "generated_at": timestamp,
            "grade_subjects": sorted(course_shards),
            "history_subjects": sorted(history_shards),
            "catalog_subjects": sorted(catalog_shards),
            "professor_prefixes": sorted(professor_shards),
            "major_map_count": len(major_maps),
        }
        artifacts["index"] = write_immutable_json(staging, "index.json", indexes)
        for artifact in [*artifacts.values(), *lazy_major_map_artifacts.values()]:
            verify_artifact(staging, artifact)
        publish_release_directory(staging, destination)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise

    scope = {
        "kind": scope_kind,
        "campus": campus,
        "subjects": sorted(catalog_shards or history_shards or course_shards),
    }
    coverage = {
        "grades": grade_coverage,
        "offering_history": history_coverage,
    }
    if catalog_coverage is not None:
        coverage["catalog"] = catalog_coverage
    if curriculum_coverage is not None:
        coverage["curriculum"] = curriculum_coverage
    manifest = build_manifest(
        release_id=release_id,
        generated_at=timestamp,
        scope=scope,
        coverage=coverage,
        artifacts=artifacts,
        base_url=f"releases/{release_id}",
    )
    manifest_path = output_root / "manifest.json"
    write_manifest_atomic(manifest_path, manifest)
    return destination, manifest_path, manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--grade-analytics", type=Path, default=DEFAULT_GRADES)
    parser.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--maps-dir", type=Path, default=DEFAULT_MAPS_DIR)
    history = parser.add_mutually_exclusive_group()
    history.add_argument("--history-cache", type=Path, default=DEFAULT_HISTORY_CACHE)
    history.add_argument("--term-dir", type=Path)
    parser.add_argument("--complete-terms", action="append", default=[])
    parser.add_argument("--subjects", action="append", default=[])
    parser.add_argument("--campus", default="COL")
    parser.add_argument("--output-root", type=Path, default=DEFAULT_OUTPUT_ROOT)
    parser.add_argument("--release-id", required=True)
    parser.add_argument("--generated-at")
    parser.add_argument("--scope-kind", choices=("full", "representative"), default="full")
    args = parser.parse_args()

    history_cache = args.history_cache if args.term_dir is None else None
    destination, manifest_path, manifest = build_release(
        grade_analytics_path=args.grade_analytics,
        output_root=args.output_root,
        release_id=args.release_id,
        subjects=comma_values(args.subjects),
        history_cache=history_cache,
        term_directory=args.term_dir,
        complete_terms=comma_values(args.complete_terms),
        campus=normalize_code(args.campus),
        generated_at=args.generated_at,
        scope_kind=args.scope_kind,
        catalog_path=args.catalog,
        maps_dir=args.maps_dir,
    )
    total_bytes = sum(int(artifact["bytes"]) for artifact in manifest["artifacts"].values())
    print(
        f"Published {len(manifest['artifacts'])} artifacts ({total_bytes:,} bytes) "
        f"to {destination}",
        flush=True,
    )
    print(f"Activated {manifest_path}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

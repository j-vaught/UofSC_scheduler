"""Static release generation, coverage, privacy, and publication tests."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from tools.build_catalog_shards import build_catalog_shards, load_major_maps
from tools.build_grade_shards import MIN_PUBLIC_GRADED_STUDENTS, build_grade_shards
from tools.build_offering_history import TermRecord, build_history_shards
from tools.build_static_release import build_release, validate_full_history_metrics
from tools.static_release import assert_privacy_safe, write_manifest_atomic


PROFESSOR_ID = "prof_0123456789abcdef"


def sample_analytics() -> dict:
    return {
        "meta": {
            "earliest_term": "202401",
            "latest_term": "202408",
            "semesters_available": 2,
            "academic_years_available": 1,
            "gpa_scale": {"A": 4.0, "B": 3.0},
            "gpa_excludes": ["non-GPA outcomes"],
            "quality": {"term_coverage": [{"term": "202401"}, {"term": "202408"}]},
        },
        "courses": {
            "CSCE 145": {
                "sections": 2,
                "graded_students": 40,
                "average_gpa": 3.2,
                "grade_counts": {"A": 20, "B": 20},
                "instructors": [
                    {
                        "id": PROFESSOR_ID,
                        "name": "Example, Faculty",
                        "sections": 2,
                        "graded_students": 40,
                        "average_gpa": 3.2,
                        "grade_counts": {"A": 20, "B": 20},
                    }
                ],
            }
        },
        "professors": {
            PROFESSOR_ID: {
                "name": "Example, Faculty",
                "sections": 2,
                "graded_students": 40,
                "average_gpa": 3.2,
                "grade_counts": {"A": 20, "B": 20},
                "courses": [{"code": "CSCE 145", "sections": 2}],
                "years": [],
            }
        },
    }


def test_offering_absence_requires_complete_term() -> None:
    records = [
        TermRecord(
            term="202401",
            complete=True,
            source="spring.json",
            sections=[
                {
                    "subject": "CSCE",
                    "courseNumber": "145",
                    "courseTitle": "Algorithmic Design I",
                    "courseReferenceNumber": "10001",
                    "enrollment": 20,
                    "maximumEnrollment": 25,
                }
            ],
        ),
        TermRecord(
            term="202408",
            complete=True,
            source="fall.json",
            sections=[{"subject": "CSCE", "courseNumber": "146"}],
        ),
        TermRecord(
            term="202501",
            complete=False,
            source="failed.json",
            sections=[],
            error="upstream timeout",
        ),
    ]

    shards, coverage = build_history_shards(records, subjects=["CSCE"])

    terms = shards["CSCE"]["courses"]["CSCE 145"]["terms"]
    assert terms == [
        {
            "term": "202401",
            "offered": True,
            "sections": 1,
            "enrollment": 20,
            "enrollment_sections": 1,
            "capacity": 25,
            "capacity_sections": 1,
        },
        {"term": "202408", "offered": False, "sections": 0},
    ]
    assert coverage["complete_terms"] == ["202401", "202408"]
    assert coverage["incomplete_terms"] == ["202501"]
    assert "excluded from denominators" in coverage["semantics"]
    serialized = json.dumps(shards)
    assert "10001" not in serialized
    assert "courseReferenceNumber" not in serialized


def test_grade_shards_reject_private_identity_fields() -> None:
    analytics = sample_analytics()
    analytics["professors"][PROFESSOR_ID]["email"] = "private@example.edu"

    with pytest.raises(ValueError, match="Private field"):
        build_grade_shards(analytics, subjects=["CSCE"])

    with pytest.raises(ValueError, match="Private field"):
        assert_privacy_safe({"nested": {"crn": "12345"}})


def test_grade_shards_suppress_small_public_aggregates() -> None:
    analytics = sample_analytics()
    small_professor_id = "prof_fedcba9876543210"
    analytics["courses"]["CSCE 145"]["instructors"].append(
        {
            "id": small_professor_id,
            "name": "Small, Aggregate",
            "sections": 1,
            "graded_students": MIN_PUBLIC_GRADED_STUDENTS - 1,
            "average_gpa": 4.0,
            "grade_counts": {"A": MIN_PUBLIC_GRADED_STUDENTS - 1},
        }
    )
    analytics["professors"][small_professor_id] = {
        "name": "Small, Aggregate",
        "sections": 1,
        "graded_students": MIN_PUBLIC_GRADED_STUDENTS - 1,
        "average_gpa": 4.0,
        "grade_counts": {"A": MIN_PUBLIC_GRADED_STUDENTS - 1},
        "courses": [],
        "years": [],
    }
    analytics["professors"][PROFESSOR_ID]["courses"] = [
        {
            "code": "CSCE 145",
            "graded_students": MIN_PUBLIC_GRADED_STUDENTS - 1,
            "grade_counts": {"A": MIN_PUBLIC_GRADED_STUDENTS - 1},
        }
    ]

    course_shards, professor_shards, coverage = build_grade_shards(
        analytics,
        subjects=["CSCE"],
    )

    instructors = course_shards["CSCE"]["courses"]["CSCE 145"]["instructors"]
    assert [record["id"] for record in instructors] == [PROFESSOR_ID]
    assert small_professor_id not in json.dumps(professor_shards)
    assert professor_shards["0"]["professors"][PROFESSOR_ID]["courses"] == []
    policy = coverage["privacy_suppression"]
    assert policy["minimum_graded_students"] == 10
    assert policy["suppressed"] == {
        "course_instructor_records": 1,
        "professor_course_records": 1,
    }


def test_catalog_and_major_maps_are_browser_readable(tmp_path: Path) -> None:
    catalog, subject_index, coverage = build_catalog_shards(
        [
            {
                "code": "csce 145",
                "title": "Algorithmic Design I",
                "description": "Problem solving and algorithms.",
                "subject": "CSCE",
                "key": 145,
                "prereq": "Prerequisites: MATH 111.",
                "hours": "4 Credits",
            },
            {"code": "MATH 111", "title": "Basic College Mathematics"},
        ]
    )
    assert coverage == {
        "subjects": ["CSCE", "MATH"],
        "subject_count": 2,
        "course_count": 2,
    }
    assert subject_index["subjects"] == [
        {"code": "CSCE", "courses": 1},
        {"code": "MATH", "courses": 1},
    ]
    assert catalog["CSCE"]["courses"]["CSCE 145"]["hours"] == "4 Credits"

    maps_dir = tmp_path / "maps"
    maps_dir.mkdir()
    (maps_dir / "cs.json").write_text(
        json.dumps(
            {
                "id": "cs_bscs_2026",
                "major": "Computer Science",
                "program": "B.S.C.S.",
                "college": "Engineering and Computing",
                "catalog_year": "2026-2027",
                "total_credits_required": 120,
                "required_courses": [],
            }
        ),
        encoding="utf-8",
    )
    maps, map_index, map_coverage = load_major_maps(maps_dir)
    assert maps["cs_bscs_2026"]["kind"] == "major_map"
    assert "generated_at" not in maps["cs_bscs_2026"]
    assert map_index["maps"][0]["total_credits"] == 120
    assert map_coverage == {
        "map_count": 1,
        "catalog_years": ["2026-2027"],
        "program_count": 1,
    }


def test_major_map_discovery_is_recursive_and_rejects_duplicate_ids(tmp_path: Path) -> None:
    maps_dir = tmp_path / "maps"
    first_year = maps_dir / "2025-2026"
    second_year = maps_dir / "2026-2027"
    first_year.mkdir(parents=True)
    second_year.mkdir(parents=True)
    base = {
        "major": "Computer Science",
        "program": "Bachelor of Science in Computer Science",
        "college": "Engineering and Computing",
        "total_credits_required": 120,
        "required_courses": [],
    }
    (first_year / "cs.json").write_text(
        json.dumps({**base, "id": "cs_bscs_2025", "catalog_year": "2025-2026"}),
        encoding="utf-8",
    )
    (second_year / "import.json").write_text(
        json.dumps(
            {
                "maps": [
                    {
                        "id": "cs_bscs_2026",
                        "program": {
                            "name": "Computer Science",
                            "degree": "Bachelor of Science in Computer Science",
                            "college": "Engineering and Computing",
                            "bulletin_year": "2026-2027",
                            "minimum_total_hours": 121,
                        },
                        "semesters": [],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    maps, index, coverage = load_major_maps(maps_dir)

    assert list(maps) == ["cs_bscs_2025", "cs_bscs_2026"]
    assert [entry["id"] for entry in index["maps"]] == [
        "cs_bscs_2025",
        "cs_bscs_2026",
    ]
    assert coverage["catalog_years"] == ["2025-2026", "2026-2027"]
    assert coverage["program_count"] == 1
    imported_entry = index["maps"][1]
    assert imported_entry["program"] == "Bachelor of Science in Computer Science"
    assert imported_entry["total_credits"] == 121

    (second_year / "duplicate.json").write_text(
        json.dumps({**base, "id": "cs_bscs_2025", "catalog_year": "2026-2027"}),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="Duplicate major map identifier"):
        load_major_maps(maps_dir)


def test_major_map_release_excludes_offline_normalization_audit_data(
    tmp_path: Path,
) -> None:
    maps_dir = tmp_path / "maps"
    maps_dir.mkdir()
    (maps_dir / "cs.json").write_text(
        json.dumps(
            {
                "id": "cs_bscs_2026",
                "major": "Computer Science",
                "program": "B.S.C.S.",
                "college": "Engineering and Computing",
                "catalog_year": "2026-2027",
                "total_credits_required": 120,
                "required_courses": [],
                "normalization": {"findings": [{"code": "title.cleaned"}]},
                "materialization": {"source_file": "private/source.json"},
            }
        ),
        encoding="utf-8",
    )

    maps, _, _ = load_major_maps(maps_dir)

    assert "normalization" not in maps["cs_bscs_2026"]
    assert "materialization" not in maps["cs_bscs_2026"]


def test_major_map_index_stays_compact_for_hundreds_of_maps(tmp_path: Path) -> None:
    maps_dir = tmp_path / "maps"
    maps_dir.mkdir()
    maps_payload = [
        {
            "id": f"map_program_{number:03d}",
            "major": f"Program {number:03d}",
            "program": "B.S.",
            "college": "Example College",
            "catalog_year": f"{2021 + number % 6}-{2022 + number % 6}",
            "total_credits_required": 120,
            "required_courses": [
                {
                    "code": f"TEST {course:03d}",
                    "title": "A deliberately descriptive course title",
                    "credits": 3,
                }
                for course in range(40)
            ],
        }
        for number in range(240)
    ]
    (maps_dir / "all-years.json").write_text(
        json.dumps({"maps": maps_payload}),
        encoding="utf-8",
    )

    maps, index, coverage = load_major_maps(maps_dir)

    assert coverage["map_count"] == 240
    assert len(index["maps"]) == 240
    assert "required_courses" not in index["maps"][0]
    assert len(json.dumps(index)) < len(json.dumps(maps)) // 10


def test_release_manifest_schema_hashes_and_paths(tmp_path: Path) -> None:
    analytics_path = tmp_path / "grades.json"
    analytics_path.write_text(json.dumps(sample_analytics()), encoding="utf-8")
    terms = tmp_path / "terms"
    terms.mkdir()
    (terms / "202401.json").write_text(
        json.dumps(
            {
                "term": "202401",
                "complete": True,
                "campus": "COL",
                "sections": [
                    {
                        "subject": "CSCE",
                        "courseNumber": "145",
                        "courseReferenceNumber": "10001",
                        "enrollment": 20,
                        "maximumEnrollment": 25,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    (terms / "202408.json").write_text(
        json.dumps(
            {
                "term": "202408",
                "complete": True,
                "campus": "COL",
                "sections": [{"subject": "MATH", "courseNumber": "141"}],
            }
        ),
        encoding="utf-8",
    )
    maps_dir = tmp_path / "maps" / "2026-2027"
    maps_dir.mkdir(parents=True)
    (maps_dir / "cs.json").write_text(
        json.dumps(
            {
                "id": "cs_bscs_2026",
                "major": "Computer Science",
                "program": "B.S.C.S.",
                "college": "Engineering and Computing",
                "catalog_year": "2026-2027",
                "total_credits_required": 120,
                "required_courses": [],
            }
        ),
        encoding="utf-8",
    )

    output = tmp_path / "public-data"
    release_dir, manifest_path, manifest = build_release(
        grade_analytics_path=analytics_path,
        output_root=output,
        release_id="test-release",
        subjects=["CSCE"],
        term_directory=terms,
        generated_at="2026-07-17T12:00:00+00:00",
        scope_kind="representative",
        maps_dir=tmp_path / "maps",
    )

    assert release_dir == output / "releases" / "test-release"
    assert manifest_path == output / "manifest.json"
    assert json.loads(manifest_path.read_text()) == manifest
    assert manifest["schema_version"] == 1
    assert manifest["scope"] == {
        "kind": "representative",
        "campus": "COL",
        "subjects": ["CSCE"],
    }
    assert manifest["coverage"]["offering_history"]["complete_terms"] == [
        "202401",
        "202408",
    ]
    assert set(manifest["artifacts"]) == {
        "grades/courses/CSCE",
        "grades/professors/0",
        "history/CSCE",
        "major-maps/index",
        "index",
    }
    for artifact in manifest["artifacts"].values():
        path = output / artifact["url"]
        content = path.read_bytes()
        payload = json.loads(content)
        assert len(content) == artifact["bytes"]
        assert hashlib.sha256(content).hexdigest() == artifact["sha256"]
        assert artifact["sha256"][:16] in path.name
        assert payload["schema_version"] == manifest["schema_version"]
        assert "courseReferenceNumber" not in content.decode("utf-8")
        assert '"crn"' not in content.decode("utf-8").lower()

    map_index_descriptor = manifest["artifacts"]["major-maps/index"]
    map_index = json.loads((output / map_index_descriptor["url"]).read_text())
    lazy_descriptor = map_index["maps"][0]["artifact"]
    assert "major-maps/cs_bscs_2026" not in manifest["artifacts"]
    lazy_path = output / lazy_descriptor["url"]
    lazy_content = lazy_path.read_bytes()
    assert len(lazy_content) == lazy_descriptor["bytes"]
    assert hashlib.sha256(lazy_content).hexdigest() == lazy_descriptor["sha256"]
    assert lazy_descriptor["sha256"][:16] in lazy_path.name
    lazy_bundle = json.loads(lazy_content)
    assert lazy_bundle["kind"] == "major_map_bundle"
    assert lazy_bundle["maps"][lazy_descriptor["entry_key"]]["id"] == "cs_bscs_2026"
    assert lazy_descriptor["bundle_key"] == "major-maps/catalog-year/2026-2027"

    release_index = json.loads((output / manifest["artifacts"]["index"]["url"]).read_text())
    assert release_index["major_map_count"] == 1
    assert "major_maps" not in release_index


def test_full_release_rejects_a_term_without_enrollment_fields() -> None:
    with pytest.raises(ValueError, match="202501"):
        validate_full_history_metrics(
            {
                "term_sources": [
                    {
                        "term": "202408",
                        "selected_sections": 10,
                        "sections_with_enrollment": 10,
                    },
                    {
                        "term": "202501",
                        "selected_sections": 12,
                        "sections_with_enrollment": 0,
                    },
                ]
            }
        )


def test_manifest_publication_failure_preserves_active_release(tmp_path: Path) -> None:
    output = tmp_path / "manifest.json"
    output.write_text('{"release_id":"previous"}', encoding="utf-8")
    manifest = {
        "schema_version": 1,
        "release_id": "next",
        "generated_at": "2026-07-17T12:00:00+00:00",
        "scope": {},
        "coverage": {},
        "artifacts": {
            "index": {
                "url": "releases/next/index.abc.json",
                "bytes": 2,
                "sha256": "a" * 64,
                "media_type": "application/json",
                "schema_version": 1,
            }
        },
    }

    def fail_replace(_source: Path, _destination: Path) -> None:
        raise OSError("simulated publication failure")

    with pytest.raises(OSError, match="simulated publication failure"):
        write_manifest_atomic(output, manifest, replace=fail_replace)

    assert output.read_text(encoding="utf-8") == '{"release_id":"previous"}'
    assert list(tmp_path.glob(".manifest.json.*.tmp")) == []

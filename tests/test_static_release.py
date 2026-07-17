"""Static release generation, coverage, privacy, and publication tests."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from scripts.build_catalog_shards import build_catalog_shards, load_major_maps
from scripts.build_grade_shards import MIN_PUBLIC_GRADED_STUDENTS, build_grade_shards
from scripts.build_offering_history import TermRecord, build_history_shards
from scripts.build_static_release import build_release
from scripts.static_release import assert_privacy_safe, write_manifest_atomic


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
    assert map_index["maps"][0]["total_credits"] == 120
    assert map_coverage == {"map_count": 1, "map_ids": ["cs_bscs_2026"]}


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

    output = tmp_path / "public-data"
    release_dir, manifest_path, manifest = build_release(
        grade_analytics_path=analytics_path,
        output_root=output,
        release_id="test-release",
        subjects=["CSCE"],
        term_directory=terms,
        generated_at="2026-07-17T12:00:00+00:00",
        scope_kind="representative",
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

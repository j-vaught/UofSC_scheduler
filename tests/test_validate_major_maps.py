from __future__ import annotations

import json
from pathlib import Path

import pytest

from tools.validate_major_maps import (
    MapAudit,
    load_current_catalog,
    main,
    summary_text,
    validate_directory,
    validate_map,
)


def valid_map(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "id": "test_bs_2025",
        "program": "B.S.",
        "major": "Testing",
        "college": "Example College",
        "catalog_year": "2025-2026",
        "total_credits_required": 120,
        "source": {
            "url": "https://example.edu/map.pdf",
            "sha256": "a" * 64,
            "page_count": 4,
            "retrieved_at": "2026-07-18T12:00:00Z",
        },
        "confidence": 0.98,
        "warnings": [],
        "required_courses": [
            {
                "code": "TEST 101",
                "title": "Introduction",
                "credits": 3,
                "typical_year": 1,
                "typical_semester": "Fall",
                "prerequisites": [],
                "corequisites": [],
            },
            {
                "code": "TEST 201",
                "title": "Intermediate",
                "credits": 3,
                "typical_year": 2,
                "typical_semester": "Fall",
                "prerequisites": ["TEST 101"],
                "corequisites": [],
            },
        ],
        "elective_groups": [
            {
                "id": "electives",
                "label": "Electives",
                "credits_required": 6,
                "options": ["TEST 301"],
            }
        ],
        "semester_sequence": [
            {"year": 1, "term": "Fall", "courses": [{"code": "TEST 101", "credits": 3}]},
            {"year": 1, "term": "Spring", "courses": [{"code": "TEST 102", "credits": 3}]},
        ],
    }
    payload.update(overrides)
    return payload


def write_map(directory: Path, name: str, payload: object) -> Path:
    path = directory / f"{name}.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def finding_codes(audit: MapAudit) -> set[str]:
    return {finding.code for finding in audit.findings}


def test_valid_map_cross_checks_current_catalog(tmp_path: Path) -> None:
    path = write_map(tmp_path, "test_bs_2025", valid_map())
    audit = validate_map(path, {"TEST 101", "TEST 102", "TEST 201", "TEST 301"})

    assert audit.count("error") == 0
    assert audit.catalog_matches == 4
    assert audit.catalog_missing == 0
    assert audit.course_codes_checked == 4


def test_validator_reports_required_identity_credit_and_course_errors(tmp_path: Path) -> None:
    payload = valid_map(
        id="Not Valid",
        program="",
        catalog_year="2025-2027",
        total_credits_required=5,
        source={"url": "http://example.edu/map.pdf", "sha256": "nope", "page_count": 0},
        confidence=2,
        required_courses=[
            {"code": "test101", "credits": 0},
            {"code": "TEST 101", "credits": 6},
            {"code": "TEST 101", "credits": 6},
        ],
        elective_groups=[{"credits_required": 2, "options": ["NOPE"]}],
    )
    path = write_map(tmp_path, "wrong_filename", payload)
    audit = validate_map(path, {"TEST 101"})
    codes = finding_codes(audit)

    assert {
        "field.missing",
        "id.invalid",
        "id.filename_mismatch",
        "catalog_year.invalid",
        "credits.unusual_total",
        "credits.invalid_course",
        "credits.requirements_exceed_total",
        "row.duplicate_required_course",
        "source.invalid_url",
        "source.invalid_sha256",
        "source.invalid_page_count",
        "confidence.out_of_range",
        "course.invalid_code",
    } <= codes


def test_semester_sequence_and_duplicate_rows_are_validated(tmp_path: Path) -> None:
    duplicate = {"code": "TEST 101", "credits": 3}
    payload = valid_map(
        semester_sequence=[
            {"year": 1, "term": "Fall", "courses": [duplicate, duplicate]},
            {"year": 1, "term": "Fall", "courses": []},
            {"year": 0, "term": "Autumn", "courses": []},
        ]
    )
    audit = validate_map(write_map(tmp_path, "test_bs_2025", payload))

    assert {
        "semester.out_of_sequence",
        "semester.invalid_year",
        "semester.invalid_season",
        "row.duplicate_semester_row",
    } <= finding_codes(audit)


def test_low_confidence_requires_review_warning(tmp_path: Path) -> None:
    payload = valid_map(
        confidence="low",
        warnings=[],
        semester_plan=[
            {
                "number": 1,
                "label": "Semester One",
                "planned_credit_hours": 15,
                "requirements": [
                    {
                        "title": "Choose a course",
                        "course_codes": ["TEST 101", "TEST 102"],
                        "credit_hours": 3,
                        "confidence": "low",
                        "warnings": [],
                    }
                ],
            },
            {
                "number": 2,
                "label": "Semester Two",
                "planned_credit_hours": [15, 18],
                "requirements": [],
            },
        ],
        semester_sequence=None,
    )
    audit = validate_map(write_map(tmp_path, "test_bs_2025", payload))

    assert "confidence.low_without_warning" in finding_codes(audit)


def test_imported_source_ambiguities_remain_review_warnings(tmp_path: Path) -> None:
    payload = valid_map(
        total_credits_required=None,
        import_metadata={"method": "layout_preserving_pdf_text", "requires_review": True},
        required_courses=[
            {
                "code": "TEST 101",
                "title": "Zero-credit milestone",
                "credits": 0,
                "typical_year": 1,
                "typical_semester": "Fall",
                "prerequisites": [],
                "corequisites": [],
            }
        ],
    )
    audit = validate_map(write_map(tmp_path, "test_bs_2025", payload))

    assert audit.count("error") == 0
    assert {"field.missing", "credits.invalid_total"} <= {
        finding.code for finding in audit.findings if finding.severity == "warning"
    }
    assert "semester.invalid_season" not in finding_codes(audit)
    assert "semester.invalid_year" not in finding_codes(audit)


def test_directory_detects_duplicate_ids_and_emits_summary(tmp_path: Path) -> None:
    write_map(tmp_path, "first", valid_map(id="same_id"))
    write_map(tmp_path, "second", valid_map(id="same_id"))
    report = validate_directory(tmp_path)

    assert report["summary"]["maps"] == 2
    assert report["summary"]["invalid"] == 2
    assert all(
        any(item["code"] == "id.duplicate" for item in result["findings"])
        for result in report["maps"]
    )
    assert "2 checked" in summary_text(report)


def test_manifest_catalog_loader_uses_selected_release(tmp_path: Path) -> None:
    shard = tmp_path / "releases/current/catalog/courses/courses-TEST.json"
    shard.parent.mkdir(parents=True)
    shard.write_text(json.dumps({"courses": {"TEST 101": {"code": "TEST 101"}}}))
    (tmp_path / "manifest.json").write_text(
        json.dumps(
            {
                "release_id": "current",
                "artifacts": {"catalog/courses/TEST": {"url": str(shard.relative_to(tmp_path))}},
            }
        )
    )

    codes, release = load_current_catalog(tmp_path)

    assert codes == {"TEST 101"}
    assert release == "current"


def test_empty_directory_is_a_blocking_validation_error(tmp_path: Path) -> None:
    report = validate_directory(tmp_path)

    assert report["summary"]["errors"] == 1
    assert report["findings"][0]["code"] == "directory.no_maps"


def test_cli_writes_machine_readable_report_and_fails_on_errors(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    maps_dir = tmp_path / "maps"
    maps_dir.mkdir()
    write_map(maps_dir, "broken", {"id": "broken"})
    output = tmp_path / "report.json"

    result = main(
        [
            "--maps-dir",
            str(maps_dir),
            "--static-data-dir",
            str(tmp_path / "missing"),
            "--json-output",
            str(output),
        ]
    )

    report = json.loads(output.read_text())
    assert result == 1
    assert report["schema_version"] == 1
    assert report["summary"]["errors"] > 0
    assert "Major maps: 1 checked" in capsys.readouterr().out


def test_gate_quarantines_official_total_and_program_metadata_conflicts(
    tmp_path: Path,
) -> None:
    payload = valid_map(
        parsed_metadata={
            "name": "Different Major",
            "degree": "B.S.",
            "college": "Example College",
            "bulletin_year": "2025-2026",
            "minimum_total_hours": 126,
        }
    )
    audit = validate_map(write_map(tmp_path, "test_bs_2025", payload))
    result = audit.as_dict()

    assert {
        "program.metadata_mismatch",
        "credits.official_total_mismatch",
    } <= finding_codes(audit)
    assert result["gate"]["decision"] == "quarantine"
    assert result["gate"]["quarantined"] is True


def test_alternative_groups_are_structurally_validated(tmp_path: Path) -> None:
    payload = valid_map(
        elective_groups=[
            {
                "id": "broken-choice",
                "label": "Choose one course",
                "credits_required": 3,
                "options": ["TEST 301", "TEST 301"],
                "pick": 2,
            },
            {
                "id": "lost-choice",
                "label": "TEST 401 or TEST 402",
                "credits_required": 3,
                "options": [],
                "pick": 1,
            },
        ]
    )
    audit = validate_map(write_map(tmp_path, "test_bs_2025", payload))

    assert {
        "alternative.duplicate_options",
        "alternative.pick_exceeds_options",
        "alternative.unresolved_label",
    } <= finding_codes(audit)


def test_pdf_footnote_artifacts_require_review(tmp_path: Path) -> None:
    payload = valid_map(
        elective_groups=[
            {
                "id": "core",
                "label": "Carolina Core Requirement5",
                "credits_required": 3,
                "options": [],
                "pick": 1,
                "informational": True,
                "requires_review": True,
            }
        ]
    )
    audit = validate_map(write_map(tmp_path, "test_bs_2025", payload))

    assert "extraction.footnote_artifact" in finding_codes(audit)
    assert audit.as_dict()["gate"]["decision"] == "review"


def test_course_credits_must_agree_across_map_and_catalog(tmp_path: Path) -> None:
    payload = valid_map(
        semester_sequence=[
            {"year": 1, "term": "Fall", "courses": [{"code": "TEST 101", "credits": 4}]},
            {"year": 1, "term": "Spring", "courses": [{"code": "TEST 102", "credits": 3}]},
        ]
    )
    audit = validate_map(
        write_map(tmp_path, "test_bs_2025", payload),
        {"TEST 101", "TEST 102", "TEST 201", "TEST 301"},
        {
            "TEST 101": {"hours": "3 Credits"},
            "TEST 102": {"hours": "3 Credits"},
            "TEST 201": {"hours": "3 Credits"},
            "TEST 301": {"hours": "3 Credits"},
        },
    )

    assert "credits.course_conflict" in finding_codes(audit)
    assert "credits.catalog_mismatch" in finding_codes(audit)


def test_imported_maps_require_reproducible_source_provenance(tmp_path: Path) -> None:
    payload = valid_map(
        source={"url": "https://example.edu/map.pdf"},
        import_metadata={"method": "layout_preserving_pdf_text"},
    )
    audit = validate_map(write_map(tmp_path, "test_bs_2025", payload))

    assert "source.import_provenance_missing" in finding_codes(audit)
    assert audit.as_dict()["gate"]["decision"] == "quarantine"


def test_missing_retrieval_timestamp_requires_review_but_not_quarantine(
    tmp_path: Path,
) -> None:
    payload = valid_map(
        source={
            "url": "https://example.edu/map.pdf",
            "sha256": "a" * 64,
            "page_count": 4,
            "retrieved_at": None,
        },
        import_metadata={"method": "layout_preserving_pdf_text"},
    )
    audit = validate_map(write_map(tmp_path, "test_bs_2025", payload))

    assert "source.import_metadata_incomplete" in finding_codes(audit)
    assert "source.import_provenance_missing" not in finding_codes(audit)
    assert audit.count("error") == 0
    assert audit.as_dict()["gate"]["decision"] == "review"


def test_directory_report_lists_publish_review_and_quarantine_ids(tmp_path: Path) -> None:
    write_map(tmp_path, "publish", valid_map(id="publish", elective_groups=[]))
    write_map(
        tmp_path,
        "review",
        valid_map(
            id="review",
            elective_groups=[
                {
                    "id": "core",
                    "label": "Carolina Core Requirement5",
                    "credits_required": 3,
                    "options": [],
                    "pick": 1,
                    "informational": True,
                    "requires_review": True,
                }
            ],
        ),
    )
    write_map(tmp_path, "quarantine", valid_map(id="quarantine", program=""))

    report = validate_directory(tmp_path)

    assert report["gate"] == {
        "publish_ids": ["publish"],
        "review_ids": ["review"],
        "quarantine_ids": ["quarantine"],
    }
    assert report["summary"]["publish"] == 1
    assert report["summary"]["review"] == 1
    assert report["summary"]["quarantine"] == 1


def test_normalization_audit_metadata_is_not_treated_as_course_data(
    tmp_path: Path,
) -> None:
    payload = valid_map(
        normalization={
            "findings": [
                {
                    "code": "title.footnote_suffix_removed",
                    "severity": "change",
                }
            ],
            "warnings": 1,
        },
        materialization={"changes": 1, "warnings": 1, "errors": 0},
    )

    audit = validate_map(write_map(tmp_path, "test_bs_2025", payload))

    assert "course.invalid_code" not in finding_codes(audit)
    assert "warnings.invalid_type" not in finding_codes(audit)

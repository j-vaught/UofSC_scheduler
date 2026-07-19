import json
from pathlib import Path

from scripts.normalize_major_maps import (
    audit_directory,
    materialize_directory,
    normalize_document,
)


def _document(requirements, *, major="Journalism – Bachelor of Arts (B.A.)"):
    return {
        "major": major,
        "program": "Bachelor of Arts (B.A.)",
        "parsed_metadata": {
            "name": major,
            "degree": "Bachelor of Arts (B.A.)",
        },
        "semester_plan": [{"number": 1, "requirements": requirements}],
    }


def _requirement(title, credits=3, *, codes=None, relation="requirement"):
    return {
        "id": f"req-{title}",
        "title": title,
        "source_text": f"{title}  {credits}",
        "credit_hours": credits,
        "course_codes": codes or [],
        "relation": relation,
        "confidence": "high",
        "warnings": [],
    }


def test_normalizer_removes_safe_footnotes_and_duplicate_program_suffix() -> None:
    payload = _document([_requirement("Carolina Core Requirement4")])

    normalized, findings = normalize_document(payload)

    assert normalized["major"] == "Journalism – Bachelor of Arts (B.A.)"
    assert normalized["parsed_metadata"]["name"] == "Journalism"
    row = normalized["semester_plan"][0]["requirements"][0]
    assert row["title"] == "Carolina Core Requirement"
    assert row["source_text"] == "Carolina Core Requirement4  3"
    assert row["provenance"] == {
        "original_title": "Carolina Core Requirement4",
        "footnote_marker": 4,
    }
    assert {finding.code for finding in findings} == {
        "program.duplicate_degree_suffix_removed",
        "title.footnote_suffix_removed",
    }


def test_normalizer_removes_embedded_generic_footnotes_from_choices() -> None:
    payload = _document(
        [
            _requirement("Foreign Language3 or other Carolina Core Req.4", [3, 4]),
            _requirement("Carolina Core Requirement4 or Elective"),
            _requirement("English Major Course6"),
            _requirement("Minor Course6 or Elective"),
            _requirement("Elective7 (only if needed to meet hours to graduate)", [1, 3]),
        ],
        major="English",
    )

    normalized, findings = normalize_document(payload)

    rows = normalized["semester_plan"][0]["requirements"]
    assert [row["title"] for row in rows] == [
        "Foreign Language or other Carolina Core Req.",
        "Carolina Core Requirement or Elective",
        "English Major Course",
        "Minor Course or Elective",
        "Elective (only if needed to meet hours to graduate)",
    ]
    assert rows[0]["provenance"]["footnote_markers"] == [3, 4]
    assert sum(finding.code == "title.footnote_suffix_removed" for finding in findings) == 5


def test_normalizer_merges_only_explicit_leading_or_continuations() -> None:
    payload = _document(
        [
            _requirement("CSCE 145", codes=["CSCE 145"], relation="required"),
            _requirement("or CSCE 106", codes=["CSCE 106"], relation="required"),
        ],
        major="Computer Science",
    )

    normalized, findings = normalize_document(payload)

    rows = normalized["semester_plan"][0]["requirements"]
    assert len(rows) == 1
    assert rows[0]["title"] == "CSCE 145 or CSCE 106"
    assert rows[0]["course_codes"] == ["CSCE 145", "CSCE 106"]
    assert rows[0]["relation"] == "choose_one"
    assert rows[0]["provenance"]["merged_requirement_ids"] == [
        "req-CSCE 145",
        "req-or CSCE 106",
    ]
    assert any(finding.code == "alternative.leading_or_merged" for finding in findings)


def test_normalizer_preserves_ambiguous_duplicates_and_credit_ranges() -> None:
    payload = _document(
        [
            _requirement("Approved Elective8", [0, 6]),
            _requirement("Approved Elective8", [0, 6]),
        ],
        major="Journalism",
    )

    normalized, findings = normalize_document(payload)

    rows = normalized["semester_plan"][0]["requirements"]
    assert len(rows) == 2
    assert all(row["title"] == "Approved Elective" for row in rows)
    assert all(row["credit_hours"] == [0, 6] for row in rows)
    assert all("possible_duplicate_generic_requirement" in row["warnings"] for row in rows)
    assert all("unusual_credit_range_requires_review" in row["warnings"] for row in rows)
    codes = [finding.code for finding in findings]
    assert codes.count("requirement.possible_duplicate_generic") == 2
    assert codes.count("credits.unusual_range") == 2


def test_inline_course_alternative_is_normalized_but_cross_listing_is_not() -> None:
    payload = _document(
        [
            _requirement("ARTS 103 or ARTS 104", codes=["ARTS 103", "ARTS 104"]),
            _requirement(
                "SPAN 515 (cross-listed LING 504) or consent",
                codes=["SPAN 515", "LING 504"],
                relation="required",
            ),
        ],
        major="Art",
    )

    normalized, _ = normalize_document(payload)

    rows = normalized["semester_plan"][0]["requirements"]
    assert rows[0]["relation"] == "choose_one"
    assert rows[1]["relation"] == "required"


def test_directory_audit_is_dry_run_and_reports_counts(tmp_path: Path) -> None:
    source = tmp_path / "maps" / "2026-2027"
    source.mkdir(parents=True)
    path = source / "map.json"
    payload = _document([_requirement("Career Plan Elective5")], major="Journalism")
    path.write_text(json.dumps(payload), encoding="utf-8")

    report = audit_directory(tmp_path / "maps")

    assert report["mode"] == "dry_run"
    assert report["files_scanned"] == 1
    assert report["finding_counts"]["title.footnote_suffix_removed"] == 1
    assert json.loads(path.read_text(encoding="utf-8")) == payload


def test_materializer_writes_audited_copy_without_changing_source(tmp_path: Path) -> None:
    source_root = tmp_path / "source"
    source = source_root / "2026-2027" / "map.json"
    source.parent.mkdir(parents=True)
    payload = _document([_requirement("Career Plan Elective5")], major="Journalism")
    source.write_text(json.dumps(payload), encoding="utf-8")
    original = source.read_bytes()
    output_root = tmp_path / "normalized"

    report = materialize_directory(
        source_root,
        output_root,
        runtime_builder=lambda metadata, semesters: {"major": metadata["name"]},
    )

    assert report["files_written"] == 1
    assert report["files_failed"] == 0
    assert source.read_bytes() == original
    written = json.loads((output_root / "2026-2027" / "map.json").read_text())
    assert written["major"] == "Journalism"
    assert written["semester_plan"][0]["requirements"][0]["title"] == "Career Plan Elective"
    assert written["materialization"]["source_file"] == "2026-2027/map.json"
    assert len(written["materialization"]["source_sha256"]) == 64
    assert written["normalization"]["findings"][0]["before"] == "Career Plan Elective5"


def test_materializer_rejects_source_or_nested_output_directories(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()

    for output in (source, source / "normalized", tmp_path):
        try:
            materialize_directory(source, output)
        except ValueError as error:
            assert "separate, non-nested" in str(error)
        else:
            raise AssertionError("Expected unsafe output directory to be rejected")


def test_materializer_does_not_overwrite_existing_output_by_default(tmp_path: Path) -> None:
    source_root = tmp_path / "source"
    source = source_root / "map.json"
    source_root.mkdir()
    source.write_text(json.dumps(_document([])), encoding="utf-8")
    output_root = tmp_path / "output"
    output_root.mkdir()
    destination = output_root / "map.json"
    destination.write_text("keep me", encoding="utf-8")

    report = materialize_directory(
        source_root,
        output_root,
        runtime_builder=lambda metadata, semesters: {},
    )

    assert report["files_written"] == 0
    assert report["files_failed"] == 1
    assert destination.read_text(encoding="utf-8") == "keep me"
    assert report["records"][0]["findings"][0]["code"] == "document.materialization_failed"

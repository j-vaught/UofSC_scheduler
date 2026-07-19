import json
from pathlib import Path

import pytest

from scripts.import_major_maps import (
    RepositoryEntry,
    extract_pdf_bbox,
    extract_pdf_text,
    import_inventory,
    load_inventory,
    parse_major_map_text,
    parse_major_map_bbox,
    parse_repository_html,
    validate_map,
    write_import,
)


FIXTURES = Path(__file__).parent / "fixtures" / "major_maps"
REPOSITORY_URL = "https://example.edu/advising/major-maps"


def _entry() -> RepositoryEntry:
    return RepositoryEntry(
        bulletin_year="2025-2026",
        college="Engineering & Computing",
        department="Mechanical Engineering",
        degree="B.S.E.",
        major="Mechanical Engineering",
        pdf_url="https://example.edu/maps/mechanical.pdf",
        faculty_approver="Travis Knight",
        keywords="",
        repository_url=REPOSITORY_URL,
    )


def test_repository_parser_preserves_metadata_and_source_urls() -> None:
    entries = parse_repository_html(
        (FIXTURES / "repository.html").read_text(encoding="utf-8"), REPOSITORY_URL
    )

    assert len(entries) == 2
    mechanical = entries[0]
    assert mechanical.bulletin_year == "2025-2026"
    assert mechanical.college == "Engineering & Computing"
    assert mechanical.pdf_url == "https://example.edu/maps/mechanical.pdf"
    assert mechanical.repository_url == REPOSITORY_URL
    assert mechanical.warnings == []
    assert entries[1].warnings == ["missing_pdf_url"]


def test_repository_ids_are_deterministic_and_not_url_dependent() -> None:
    first = _entry()
    second = _entry()
    second.pdf_url = "https://cdn.example.edu/new-location.pdf"

    assert first.id == second.id
    assert first.id.startswith("map_")


def test_major_map_parser_extracts_eight_semesters_and_explicit_choices() -> None:
    document = parse_major_map_text(
        (FIXTURES / "mechanical.txt").read_text(encoding="utf-8"), _entry()
    )

    assert document["major"] == "Mechanical Engineering"
    assert document["program"] == "Bachelor of Science in Engineering (B.S.E.)"
    assert document["catalog_year"] == "2025-2026"
    assert document["total_credits_required"] == 125
    assert len(document["semester_plan"]) == 8
    assert document["semester_plan"][0]["planned_credit_hours"] == 17
    assert document["semester_plan"][2]["planned_credit_hours"] == [15, 18]
    intro = next(
        item
        for item in document["semester_plan"][0]["requirements"]
        if "EMCH 101" in item["course_codes"]
    )
    assert intro["course_codes"] == ["EMCH 101", "ENCP 101"]
    assert intro["relation"] == "choose_one"
    semester_three = document["semester_plan"][2]["requirements"]
    statics = next(
        item for item in semester_three if item["course_codes"] == ["EMCH 200", "ENCP 200"]
    )
    assert statics["relation"] == "choose_one"
    semester_six = document["semester_plan"][5]["requirements"]
    machine_design = next(item for item in semester_six if "EMCH 327" in item["course_codes"])
    assert machine_design["course_codes"] == ["EMCH 327", "EMCH 394"]
    assert machine_design["relation"] == "choose_one"
    assert "EMCH 290" not in machine_design["course_codes"]
    assert document["sources"]["pdf_url"] == _entry().pdf_url
    assert {course["code"] for course in document["required_courses"]} >= {
        "MATH 141",
        "CHEM 111",
        "EMCH 428",
    }
    assert "UNIV 101" not in {course["code"] for course in document["required_courses"]}
    assert document["category_labels"]["major_courses"] == "Major Courses"
    assert document["concentrations"] == {}
    assert validate_map(document) == []


def test_non_specific_requirements_are_flagged_instead_of_guessed() -> None:
    document = parse_major_map_text(
        (FIXTURES / "mechanical.txt").read_text(encoding="utf-8"), _entry()
    )
    electives = [
        item
        for semester in document["semester_plan"]
        for item in semester["requirements"]
        if not item["course_codes"]
    ]

    assert electives
    assert all(item["relation"] == "requirement" for item in electives)
    assert all(item["confidence"] == "low" for item in electives)
    assert all(
        "non_specific_requirement_requires_validation" in item["warnings"] for item in electives
    )


def test_incomplete_sequence_is_retained_for_manual_review() -> None:
    document = parse_major_map_text("Major Map: Test\nBulletin Year: 2025-2026", _entry())

    assert validate_map(document) == []
    assert "expected_exactly_eight_ordered_semesters" in document["warnings"]
    assert "semester_plan_requires_manual_review" in document["warnings"]
    assert "minimum_total_degree_hours_not_found" in document["warnings"]


def test_pdf_extractor_rejects_non_pdf() -> None:
    with pytest.raises(ValueError, match="not a PDF"):
        extract_pdf_text(b"not a pdf")
    with pytest.raises(ValueError, match="not a PDF"):
        extract_pdf_bbox(b"not a pdf")


def test_geography_bbox_groups_choose_one_options_without_prerequisite_codes() -> None:
    entry = _entry()
    entry.major = "Geography"
    entry.degree = "B.S."
    document = parse_major_map_bbox(
        (FIXTURES / "geography_bbox.html").read_text(encoding="utf-8"), entry
    )

    choice = document["semester_plan"][0]["requirements"][0]
    assert choice["title"].startswith("Choose 1 of the following: GEOG 103")
    assert choice["course_codes"] == ["GEOG 103", "GEOG 121"]
    assert choice["relation"] == "choose_one"
    assert "MATH 141" not in choice["title"]
    assert "MATH 141" not in choice["course_codes"]
    assert "MATH 141" in choice["source_text"]
    assert choice["source_page"] == 1
    assert choice["source_bbox"] == [64.0, 132.0, 443.0, 161.0]
    assert choice["provenance"] == {
        "page": 1,
        "bbox": [64.0, 132.0, 443.0, 161.0],
        "source_text": choice["source_text"],
        "ambiguity_flags": [],
    }


def test_art_studio_bbox_keeps_prerequisites_out_of_course_identity() -> None:
    entry = _entry()
    entry.major = "Art Studio"
    entry.degree = "B.A."
    document = parse_major_map_bbox(
        (FIXTURES / "art_studio_bbox.html").read_text(encoding="utf-8"), entry
    )

    painting = document["semester_plan"][0]["requirements"][0]
    assert painting["title"] == "ARTS 345 Painting"
    assert painting["course_codes"] == ["ARTS 345"]
    assert painting["relation"] == "required"
    assert painting["minimum_grade"] == "C"
    assert painting["requirement_codes"] == ["MR"]
    assert "ARTS 103 or ARTS 104" in painting["source_text"]
    assert "See Bulletin" in painting["source_text"]
    assert painting["provenance"]["page"] == 1
    assert painting["provenance"]["ambiguity_flags"] == []

    generic = document["semester_plan"][0]["requirements"][2]
    assert generic["title"] == "ARTS Major Course"
    assert generic["course_codes"] == []
    assert generic["confidence"] == "low"
    assert generic["provenance"]["ambiguity_flags"] == [
        "non_specific_requirement_requires_validation"
    ]


@pytest.mark.parametrize("envelope", ["maps", "items", "records"])
def test_offline_inventory_aliases_and_per_map_output(tmp_path: Path, envelope: str) -> None:
    text_path = tmp_path / "downloaded" / "mechanical.txt"
    text_path.parent.mkdir()
    text_path.write_text((FIXTURES / "mechanical.txt").read_text(encoding="utf-8"))
    inventory = tmp_path / "inventory.json"
    inventory.write_text(
        json.dumps(
            {
                "source_url": REPOSITORY_URL,
                envelope: [
                    {
                        "catalog_year": "2025-2026",
                        "school": "Engineering & Computing",
                        "dept": "Mechanical Engineering",
                        "program": "B.S.E.",
                        "name": "Mechanical Engineering",
                        "source_pdf_url": "https://example.edu/maps/mechanical.pdf",
                        "local_text_path": "downloaded/mechanical.txt",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    entries = load_inventory(inventory)
    assert entries[0][0].major == "Mechanical Engineering"
    documents, failures = import_inventory(inventory)
    assert failures == []
    output = tmp_path / "output"
    write_import(documents, failures, output)
    map_path = output / "2025-2026" / f"{documents[0]['id']}.json"
    assert map_path.exists()
    written = json.loads(map_path.read_text(encoding="utf-8"))
    assert written["program"].startswith("Bachelor of Science")
    report = json.loads((tmp_path / "output-review-report.json").read_text(encoding="utf-8"))
    assert report["imported"] == 1

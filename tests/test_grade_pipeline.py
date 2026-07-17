from __future__ import annotations

import pandas as pd

from grade_pipeline import GRADE_POINTS, build_analytics, public_instructor_id


def section(term: str, course: str, sequence: str, a: int, b: int, f: int) -> dict:
    row = {
        "TERM": term,
        "CAMPUS": "COL",
        "SUBJECT": "CSCE",
        "COURSE_NUMBER": course,
        "COURSE_SECTION_NUMBER": sequence,
        "TITLE": "Test Course",
    }
    row.update({grade: 0 for grade in GRADE_POINTS})
    row.update({"A": a, "B": b, "F": f})
    return row


def test_professor_identity_does_not_use_display_name() -> None:
    first = {"banner_id": "A1", "email": "same1@example.edu", "name": "Smith, Alex"}
    second = {"banner_id": "A2", "email": "same2@example.edu", "name": "Smith, Alex"}
    assert public_instructor_id(first) != public_instructor_id(second)


def test_professor_identity_uses_email_when_no_faculty_id_is_available() -> None:
    before_name_change = {"banner_id": "", "email": "person@example.edu", "name": "Smith, Alex"}
    after_name_change = {
        "banner_id": "",
        "email": "PERSON@example.edu",
        "name": "Smith-Jones, Alex",
    }

    assert public_instructor_id(before_name_change) == public_instructor_id(after_name_change)


def test_analytics_include_load_experience_and_breakdowns() -> None:
    sections = pd.DataFrame(
        [
            section("201705", "101", "001", 2, 1, 1),
            section("201808", "102", "001", 4, 0, 0),
        ]
    )
    banner = {
        ("201705", "CSCE", "101", "001"): {"courseReferenceNumber": "1"},
        ("201808", "CSCE", "102", "001"): {"courseReferenceNumber": "2"},
    }
    faculty = {
        ("201705", "1"): [{"banner_id": "A1", "email": "alex@example.edu", "name": "Smith, Alex"}],
        ("201808", "2"): [{"banner_id": "A1", "email": "alex@example.edu", "name": "Smith, Alex"}],
    }
    result = build_analytics(sections, banner, faculty, {})
    professor = next(iter(result["professors"].values()))
    assert professor["experience_label"].startswith(">=")
    assert professor["experience_label"] == ">= 2 semesters"
    assert professor["experience_semesters"] == 2
    assert professor["observed_teaching_semesters"] == 2
    assert professor["typical_sections_per_year"] == 1.0
    assert professor["typical_courses_per_year"] == 1.0
    assert len(professor["courses"]) == 2
    assert len(professor["years"]) == 2
    assert all(year["distinct_courses"] == 1 for year in professor["years"])
    assert result["courses"]["CSCE 101"]["average_gpa"] == 2.75

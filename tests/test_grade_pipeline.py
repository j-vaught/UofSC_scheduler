from __future__ import annotations

import pandas as pd

import grade_pipeline
from grade_pipeline import (
    GRADE_POINTS,
    build_analytics,
    cached_subjects,
    fetch_term,
    initialize_cache,
    public_instructor_id,
    term_cache_has_enrollment_fields,
)


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


def test_fetch_term_preserves_history_enrollment_fields() -> None:
    class Response:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {
                "totalCount": 1,
                "data": [
                    {
                        "subject": "CSCE",
                        "courseNumber": "190",
                        "courseTitle": "Computing in the Modern World",
                        "campus": "COL",
                        "sequenceNumber": "001",
                        "courseReferenceNumber": "11331",
                        "enrollment": 65,
                        "maximumEnrollment": 70,
                    }
                ],
            }

    class Session:
        def get(self, *_args, **_kwargs) -> Response:
            return Response()

    rows = fetch_term(Session(), "202508")  # type: ignore[arg-type]

    assert rows == [
        {
            "subject": "CSCE",
            "courseNumber": "190",
            "courseTitle": "Computing in the Modern World",
            "campus": "COL",
            "sequenceNumber": "001",
            "courseReferenceNumber": "11331",
            "enrollment": 65,
            "maximumEnrollment": 70,
        }
    ]
    assert term_cache_has_enrollment_fields(rows)
    assert not term_cache_has_enrollment_fields([{"subject": "CSCE", "courseNumber": "190"}])


def test_cached_subjects_refreshes_legacy_whole_term_rows(monkeypatch, tmp_path) -> None:
    connection = initialize_cache(tmp_path / "legacy.sqlite")
    connection.execute(
        "INSERT INTO subject_search VALUES (?, '*', ?)",
        (
            "202508",
            '[{"subject":"CSCE","courseNumber":"190",'
            '"sequenceNumber":"001","courseReferenceNumber":"11331"}]',
        ),
    )
    connection.commit()
    refreshed = [
        {
            "subject": "CSCE",
            "courseNumber": "190",
            "courseTitle": "Computing in the Modern World",
            "campus": "COL",
            "sequenceNumber": "001",
            "courseReferenceNumber": "11331",
            "enrollment": 65,
            "maximumEnrollment": 70,
        }
    ]

    class Session:
        def close(self) -> None:
            return None

    monkeypatch.setattr(grade_pipeline, "establish_session", lambda _term: Session())
    monkeypatch.setattr(grade_pipeline, "fetch_term", lambda _session, _term, _campus: refreshed)
    sections = pd.DataFrame([{"TERM": "202508", "SUBJECT": "CSCE"}])

    try:
        index = cached_subjects(connection, sections)
        cached = connection.execute(
            "SELECT payload FROM subject_search WHERE term='202508' AND subject='*'"
        ).fetchone()
    finally:
        connection.close()

    assert index[("202508", "CSCE", "190", "001")]["enrollment"] == 65
    assert cached is not None and '"maximumEnrollment":70' in cached[0]


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

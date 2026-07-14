from __future__ import annotations

import json

import grade_analytics


def test_lookup_uses_normalized_course_code(tmp_path, monkeypatch) -> None:
    path = tmp_path / "grade_analytics.json"
    path.write_text(
        json.dumps(
            {
                "meta": {"latest_term": "202601"},
                "courses": {"CSCE 145": {"average_gpa": 3.1}},
                "professors": {"prof_1": {"name": "Example, Person"}},
            }
        )
    )
    monkeypatch.setattr(grade_analytics, "DATA_PATH", path)
    monkeypatch.setattr(grade_analytics, "_cache", None)
    monkeypatch.setattr(grade_analytics, "_cache_mtime", None)
    course = grade_analytics.course("  csce   145 ")
    professor = grade_analytics.professor("prof_1")
    assert course is not None and course["average_gpa"] == 3.1
    assert professor is not None and professor["name"] == "Example, Person"
    assert grade_analytics.metadata()["available"] is True

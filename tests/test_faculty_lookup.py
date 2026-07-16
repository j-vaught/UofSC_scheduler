import json

import app
import grade_pipeline


def test_faculty_lookup_rejects_invalid_term_or_crn():
    result = json.loads(app.handle_faculty(b'{"term":"Fall 2026","crns":["10868"]}'))

    assert result == {"error": "invalid term or CRN", "faculty": []}


def test_faculty_lookup_returns_the_grade_pipeline_professor_id(monkeypatch):
    member = {
        "name": "Johnson, Rhonda",
        "email": "rhonda@sc.edu",
        "banner_id": "B00123456",
        "primary": True,
    }
    monkeypatch.setattr(app.cache, "get", lambda _key: None)
    monkeypatch.setattr(app.cache, "put", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        grade_pipeline,
        "fetch_faculty",
        lambda item: (item[0], item[1], [member]),
    )

    result = json.loads(app.handle_faculty(b'{"term":"202608","crns":["10868"]}'))

    assert result["faculty"] == [
        {
            "crn": "10868",
            "name": "Johnson, Rhonda",
            "email": "rhonda@sc.edu",
            "primary": True,
            "professor_id": grade_pipeline.public_instructor_id(member),
        }
    ]

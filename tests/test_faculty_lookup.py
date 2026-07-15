import json

import app


def test_faculty_lookup_rejects_invalid_term_or_crn():
    result = json.loads(app.handle_faculty(b'{"term":"Fall 2026","crns":["10868"]}'))

    assert result == {"error": "invalid term or CRN", "faculty": []}

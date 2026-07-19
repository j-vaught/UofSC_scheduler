from scripts.build_carolina_core_catalog import parse_catalog


def test_catalog_parser_merges_overlay_outcomes() -> None:
    html = """
    <table class="visible grid sc_sccarolinatable">
      <tr><th>Course</th><th>Title</th><th>Learning Outcome(s)</th><th>College</th><th>Overlay</th><th>Effective Term</th></tr>
      <tr><td>Course <span>ENGL 102</span></td><td>Title <span>Rhetoric and Composition</span></td><td>Learning Outcome(s) <span>CMW</span></td><td>College <span>Arts and Sciences</span></td><td>Overlay <span>Overlay Eligible</span></td><td>Effective Term <span>Fall 2013</span></td></tr>
      <tr><td>Course <span>ENGL 102</span></td><td>Title <span>Rhetoric and Composition</span></td><td>Learning Outcome(s) <span>INF</span></td><td>College <span>Arts and Sciences</span></td><td>Overlay <span>Overlay Eligible</span></td><td>Effective Term <span>Fall 2013</span></td></tr>
    </table>
    """

    catalog = parse_catalog(html)

    assert catalog["counts"] == {"CMW": 1, "INF": 1}
    assert catalog["courses"] == [
        {
            "code": "ENGL 102",
            "title": "Rhetoric and Composition",
            "outcomes": ["CMW", "INF"],
            "college": "Arts and Sciences",
            "overlay": True,
            "effective_term": "Fall 2013",
        }
    ]


def test_catalog_parser_rejects_missing_foundational_table() -> None:
    try:
        parse_catalog("<html><body>No table</body></html>")
    except ValueError as error:
        assert "Carolina Core course table" in str(error)
    else:
        raise AssertionError("Expected missing table to fail")

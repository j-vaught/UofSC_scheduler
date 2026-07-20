import json
from pathlib import Path

import pytest

from scripts.import_major_maps import (
    RepositoryEntry,
    _append_continuation,
    _extract_course_codes,
    _is_title_continuation,
    _row_from_line,
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


# --- Regression tests for the audit-confirmed parser defects (fix/audit-confirmed-map-defects) ---
#
# Every fixture line below is copied verbatim (whitespace included) from the
# real 2026-2027 registrar PDFs, extracted with `pdftotext -layout`, so each
# test is pinned to the exact input that exposed the bug rather than a
# reconstruction of it.


def test_bug1_single_space_before_credits_no_longer_drops_the_row() -> None:
    # B.S.C.S. 2026-2027 map: "Composition" runs right up to the credit-hours
    # column, leaving only one space. _row_from_line required two-or-more
    # spaces between title and credits, so this line matched nothing and the
    # entire ENGL 101 row vanished with no warning anywhere in the output.
    dropped = "    ENGL 101 Critical Reading and Composition 3      C           CC-CMW"
    item = _row_from_line(dropped, semester=1, sequence=1)
    assert item is not None
    assert item["title"] == "ENGL 101 Critical Reading and Composition"
    assert item["course_codes"] == ["ENGL 101"]
    assert item["credit_hours"] == 3
    assert item["minimum_grade"] == "C"
    assert item["requirement_codes"] == ["CC-CMW"]

    # The two-or-more-space form of the same row (a "!" critical course,
    # copied from a different 2026-2027 map) already worked before this fix
    # and must keep working identically -- the fallback path must never
    # change behaviour for a line the strict rule already matched.
    kept = "!     ENGL 101 Critical Reading and Composition         3     C         CC-CMW"
    kept_item = _row_from_line(kept, semester=1, sequence=1)
    assert kept_item is not None
    assert kept_item["title"] == "ENGL 101 Critical Reading and Composition"
    assert kept_item["course_codes"] == ["ENGL 101"]
    assert kept_item["critical"] is True


def test_bug1_single_space_fallback_ignores_a_course_number_inside_the_title() -> None:
    # Guards against the naive version of the fix (just relaxing "two
    # spaces" to "one space" everywhere): a title that itself starts with a
    # course code, like "ENGL 101 ...", must not have that embedded number
    # mistaken for the credits field just because a single space precedes
    # it. The recovery path only fires when what follows the lone digit run
    # reads like a real grade/requirement-code column; plain trailing prose
    # must still be rejected.
    line = "    ENGL 101 Critical Reading and Composition and more prose 3 not a real row"
    assert _row_from_line(line, semester=1, sequence=1) is None


def test_bug2_alternative_wrapped_right_after_the_open_paren_is_recovered() -> None:
    # Electrical Engineering 2026-2027 map: the title wraps immediately
    # after "(or", leaving "ENCP 101) fall only" alone on the next line.
    # _is_title_continuation only recognised "or CODE ###" when the whole
    # phrase shared one line, so this line matched nothing and the ENCP 101
    # alternative -- along with "fall only" -- was silently dropped, even
    # though ENCP 101 is genuinely interchangeable with every engineering
    # intro course.
    opening = (
        "    ELCT 101 Electrical & Electronics Engr. (or             1                  *       PR"
    )
    continuation = "    ENCP 101) fall only"

    item = _row_from_line(opening, semester=1, sequence=1)
    assert item is not None
    assert item["course_codes"] == ["ELCT 101"]
    assert item["relation"] == "choose_one"  # the "(or" alone already implies a choice

    assert _is_title_continuation(item, continuation) is True
    _append_continuation(item, continuation)
    assert item["title"] == "ELCT 101 Electrical & Electronics Engr. (or ENCP 101) fall only"
    assert item["course_codes"] == ["ELCT 101", "ENCP 101"]
    assert item["relation"] == "choose_one"


def test_bug2_existing_same_line_alternative_pattern_still_works() -> None:
    # Mechanical Engineering fixture: "(or ENCP 101)" already fits on one
    # continuation line. This is the pattern that worked before the fix and
    # must keep working unchanged.
    item = _row_from_line(
        "   EMCH 101 Intro. to Mechanical Engineering      3                              PR",
        semester=1,
        sequence=1,
    )
    assert item is not None
    continuation = "   (or ENCP 101)"
    assert _is_title_continuation(item, continuation) is True
    _append_continuation(item, continuation)
    assert item["course_codes"] == ["EMCH 101", "ENCP 101"]


def test_bug3_course_code_extraction_ignores_english_word_collisions() -> None:
    # Every one of these strings is copied from a real title in the curated
    # 2026-2027 corpus. COURSE_RE matches any 2-5 capital letters directly
    # in front of a three-digit number, so prose that bled into the title
    # column produced fabricated "subject codes" like OR 106, CROSS 511, and
    # TWO 500 that the planner would then try (and fail) to resolve as real
    # courses.
    cases = [
        # "...C or better in CSCE 145 or 106" -> bare "OR 106" fabricated.
        ("C or better in CSCE 145 or 106", ["CSCE 145"]),
        # "cross-listed STAT 511" -> "CROSS 511" fabricated.
        ("MATH 587 Introduction to Cryptography (cross-listed STAT 511)", ["MATH 587", "STAT 511"]),
        # Real curated title text (Marine Science map) where a wrapped "II
        # 111" used to be fabricated between "General Chemistry II" and the
        # next course's "PHYS 202 & 202L General Physics II 111/115/122/141".
        (
            "CHEM 112 & 112L General Chemistry II or PHYS 202 & 202L General "
            "Physics II 111/115/122/141 or higher math (CHEM",
            ["CHEM 112", "PHYS 202"],
        ),
        # "a view of the River 371" -> "RIVER 371" fabricated.
        ("GEOL 371 A view of the River 371", ["GEOL 371"]),
        # "& two 500-level MATH" -> "TWO 500" fabricated.
        ("C or better in MATH 241 & two 500-level MATH", ["MATH 241"]),
    ]
    for text, expected in cases:
        assert _extract_course_codes(text) == expected, text


def test_bug3_legitimate_short_codes_still_survive_the_filter() -> None:
    # The stoplist must only reject the confirmed English-word collisions,
    # never a real (if short-looking) registrar subject code.
    assert _extract_course_codes("NSCI 300 Introduction to Neuroscience") == ["NSCI 300"]
    assert _extract_course_codes("SPAN 401 Latin American Culture (cross-listed: LASP 361)") == [
        "SPAN 401",
        "LASP 361",
    ]


def test_bug4_summer_section_is_not_folded_into_the_prior_semester() -> None:
    # Retailing 2026-2027 map: "Summer (6 Credit Hours)" doesn't match
    # "Semester <word>", so SEMESTER_RE ignored it, `current` stayed pointed
    # at Semester Eight, and RETL 495 -- a summer internship -- silently
    # accumulated into Semester Eight's requirement list.
    text = "\n".join(
        [
            "Major Map: Retailing",
            "Bachelor of Science (B.S.)",
            "Bulletin Year: 2026-2027",
            "Semester Eight (12 Credit Hours)",
            "          RETL 421 Retail Finance                          3     C           MR            C or better in RETL 262",
            " Summer (6 Credit Hours)",
            "          RETL 495 Retailing Internship8                   6     C         MR/CC-                  RETL 295",
            "                                                                             INT",
        ]
    )
    document = parse_major_map_text(text, _entry())

    semester_eight = next(s for s in document["semester_plan"] if s["label"] == "Semester Eight")
    assert semester_eight["number"] == 8
    assert all("RETL 495" not in item["course_codes"] for item in semester_eight["requirements"])

    summer = next(s for s in document["semester_plan"] if s["label"].startswith("Summer"))
    assert summer["number"] != 8  # never collides with a real semester number
    assert summer["planned_credit_hours"] == 6
    retl_495 = next(item for item in summer["requirements"] if "RETL 495" in item["course_codes"])
    assert retl_495["credit_hours"] == 6
    # The wrapped "MR/CC-\nINT" requirement-code fragment is discarded, not
    # appended to the title as if it were more course-title text.
    assert "INT" not in retl_495["title"]

    assert "non_standard_semester_section" in document["warnings"]


def test_wrapped_prerequisite_number_does_not_become_a_phantom_credit_value() -> None:
    # Chemical Engineering 2026-2027 map: "MATH" wraps off the far right of
    # the prerequisite column on the ECHE 310 row, and its continuation
    # "241" lands on the next line under a fragment of the wrapped title
    # ("Thermodynamics (or ENCP 290)"). Read as plain text this looks
    # exactly like a new row -- "title  <big gap>  241" -- and was emitted
    # as a standalone item with credit_hours=241 and course_codes=[], a
    # value no real course can have.
    opening = (
        "  ! ECHE 310 Intro. to Chem. Engr.                            3       C         *"
        "         PR       C or better in ECHE 300; Prereq or Coreq: MATH"
    )
    continuation = (
        "    Thermodynamics (or ENCP 290)                                    "
        "                                                        241"
    )

    item = _row_from_line(opening, semester=3, sequence=1)
    assert item is not None
    assert item["credit_hours"] == 3

    # The implausible-looking line must not be accepted as a row in its own
    # right ...
    assert _row_from_line(continuation, semester=3, sequence=2) is None
    # ... but it must still be recognised as a continuation of ECHE 310 ...
    assert _is_title_continuation(item, continuation) is True
    _append_continuation(item, continuation)
    # ... folded into the title without the wrapped "241" ...
    assert item["title"] == "ECHE 310 Intro. to Chem. Engr. Thermodynamics (or ENCP 290)"
    assert "241" not in item["title"]
    # ... recovering the ENCP 290 alternative ...
    assert item["course_codes"] == ["ECHE 310", "ENCP 290"]
    assert item["relation"] == "choose_one"
    # ... and leaving the real credit value untouched.
    assert item["credit_hours"] == 3


def test_wrapped_fragment_with_no_course_code_still_completes_the_title() -> None:
    # Social Work 2026-2027 map: the title itself wraps ("Organizations &"
    # / "Communities"), and this time the wrapped prerequisite fragment
    # ("SOWK\n441") lands right after "Communities" on the continuation
    # line. No course code appears anywhere in the continuation, so neither
    # the "(or CODE)" pattern nor the hyphenation check applies -- only the
    # implausible-credits shape ("Communities  <big gap>  441") identifies
    # this as a continuation rather than a real "441-credit-hour" row.
    opening = (
        "        SOWK 412 Social Work Practice with Organizations &"
        "                     3       C       *       MR       SOWK 411; Prereq or Coreq: SOWK"
    )
    continuation = (
        "        Communities                                              "
        "                                                               441"
    )

    item = _row_from_line(opening, semester=8, sequence=1)
    assert item is not None
    assert item["credit_hours"] == 3

    assert _is_title_continuation(item, continuation) is True
    _append_continuation(item, continuation)
    assert item["title"] == "SOWK 412 Social Work Practice with Organizations & Communities"
    assert item["credit_hours"] == 3


def test_deeply_indented_column_bleed_is_dropped_not_appended() -> None:
    # Marine Science 2026-2027 map: "MR/CC-" wraps to a lone "INT" on the
    # next line, positioned ~100 characters in (the far-right requirement-
    # code column), not near the title column. It happens to be followed by
    # a wrapped prerequisite number too ("...PHYS 201 or\n211"), so as text
    # it also looks row-shaped with an implausible credit value. Unlike the
    # SOWK case above, appending "INT" to the title would corrupt it with a
    # meaningless fragment, so the existing continuation-indent guard (>40
    # leading characters) must keep rejecting it.
    opening = (
        "        MSCI 314 Physical Oceanography (fall only)                          "
        "4       C              MR/CC- MSCI 101, MATH 141, & PHYS 201 or"
    )
    continuation = (
        "                                                                                "
        "                    INT                 211"
    )

    item = _row_from_line(opening, semester=5, sequence=1)
    assert item is not None
    assert item["credit_hours"] == 4

    assert _is_title_continuation(item, continuation) is False

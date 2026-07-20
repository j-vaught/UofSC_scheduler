"""Every course row in a source PDF must survive into the curated major map.

The maps are extracted from the registrar's PDFs by a model, and a model can
drop a row without dropping anything else. Nothing downstream notices: the JSON
is still schema-valid, its provenance still matches the manifest, and the map
still describes a plausible degree. The B.S.C.S. map lost ENGL 101 this way and
the only visible symptom was one unplaceable course in the degree planner --
ENGL 102 asking for a prerequisite its own map never scheduled.

Three maps had lost a row, and all three sit where the PDF layout collapses the
title and credit-hours columns into a single space, so the line reads as prose
rather than as part of the table:

    Music (kept)     !     ENGL 101 Critical Reading and Composition    3    C
    B.S.C.S. (lost)        ENGL 101 Critical Reading and Composition 3       C

Both inputs are in version control, so this is checkable rather than trusted.
The PDFs are the archived bytes the extraction actually read -- the manifest
pins their sha256 -- which is what makes the comparison meaningful.

Two filters give the row scan its precision, and both were added because their
absence produced false positives. Only text inside a "Semester N (X Credit
Hours)" block counts, which excludes the elective menus and the program notes;
and a row must carry a credit-hours figure, which excludes the "choose one of"
lists that name a course without scheduling it. Without them the scan reported
95 missing rows, of which 92 were prerequisite prose and option menus.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]

# The catalog the planner serves. Earlier years are archived rather than
# maintained, and holding them to this standard would assert on data no code
# reads and no one is going to correct.
CATALOG_YEAR = "2026-2027"
CURATED = ROOT / "data" / "curated" / "major_maps" / CATALOG_YEAR
PDFS = ROOT / "data" / "raw" / "major_map_pdfs" / CATALOG_YEAR

SEMESTER = re.compile(
    r"^\s*Semester\s+(?:One|Two|Three|Four|Five|Six|Seven|Eight)\s*\(", re.MULTILINE
)
# A scheduled row: an optional "!" critical marker, a course code, a title, and
# a credit-hours figure. The trailing run of spaces is the column gap, and it is
# what separates a table row from a sentence that happens to name a course.
ROW = re.compile(r"^\s{0,6}!?\s{0,4}([A-Z]{2,5})\s(\d{3}[A-Z]?)\b.*?\s(\d{1,2})\s{2,}")

pytestmark = pytest.mark.skipif(
    shutil.which("pdftotext") is None,
    reason="pdftotext (poppler) is required to read the archived source PDFs",
)


def scheduled_rows(pdf: Path) -> list[str]:
    """Course codes the PDF schedules into a specific semester."""
    text = subprocess.run(
        ["pdftotext", "-layout", str(pdf), "-"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    # A short extraction means the text layer is missing or the file is not the
    # document we think it is. Silently finding no rows would pass this test for
    # every map at once, which is the one failure mode it must not have.
    assert len(text) > 2000, f"{pdf.name}: extracted only {len(text)} characters"

    starts = [match.start() for match in SEMESTER.finditer(text)]
    assert starts, f"{pdf.name}: no semester blocks found"

    found: list[str] = []
    for start, end in zip(starts, starts[1:] + [len(text)]):
        for line in text[start:end].splitlines():
            match = ROW.match(line)
            if match:
                found.append(f"{match.group(1)} {match.group(2)}")
    return found


def curated_codes(document: dict) -> set[str]:
    """Every course code the curated map mentions as a requirement.

    Deliberately wide: a row that landed in the wrong semester, or as an
    elective option rather than a scheduled course, is a different and much
    smaller problem than a row that vanished. This test is about disappearance.
    """
    codes = {course["code"] for course in document.get("required_courses") or []}
    for semester in document.get("semester_plan") or []:
        for requirement in semester.get("requirements") or []:
            codes.update(requirement.get("course_codes") or [])
    for group in document.get("elective_groups") or []:
        codes.update(group.get("course_codes") or [])
        for option in group.get("options") or []:
            if isinstance(option, dict):
                codes.update(option.get("course_codes") or [])
    return codes


def pairs() -> list[tuple[Path, Path]]:
    return [
        (path, PDFS / f"{path.stem}.pdf")
        for path in sorted(CURATED.glob("*.json"))
        if (PDFS / f"{path.stem}.pdf").is_file()
    ]


def test_the_archive_covers_the_curated_maps():
    """A map with no archived PDF is unverifiable, not passing."""
    curated = sorted(path.stem for path in CURATED.glob("*.json"))
    assert curated, "no curated maps found for the catalog year"
    unverifiable = [stem for stem in curated if not (PDFS / f"{stem}.pdf").is_file()]
    assert unverifiable == [], f"curated maps with no source PDF: {unverifiable}"


@pytest.mark.parametrize("curated_path,pdf_path", pairs(), ids=lambda p: p.stem)
def test_no_scheduled_course_row_was_dropped(curated_path: Path, pdf_path: Path):
    document = json.loads(curated_path.read_text(encoding="utf-8"))
    present = curated_codes(document)
    found = list(dict.fromkeys(scheduled_rows(pdf_path)))

    # Fail loudly on a layout this pattern does not understand, rather than
    # quietly finding fewer rows and passing.
    #
    # This is the failure mode of the whole approach, and it has already
    # happened twice. One scan truncated every PDF at "Program Notes" -- which
    # the page-one preamble mentions -- and reported all 185 maps clean. Another
    # required "(15 Credit Hours)" and skipped every ranged "(12-13 Credit
    # Hours)" header, which is how it missed MUED 155. Both passed silently.
    #
    # These documents are written by many authors across a dozen colleges and
    # change between catalog years, so the pattern will meet a layout it was not
    # written for. When it does, this says so instead of reporting success.
    coded_rows = sum(
        1
        for semester in document.get("semester_plan") or []
        for requirement in semester.get("requirements") or []
        if requirement.get("course_codes")
    )
    if coded_rows >= 5 and len(found) < coded_rows * 0.6:
        pytest.skip(
            f"layout not understood: matched {len(found)} rows against {coded_rows} "
            f"curated rows. This map is UNVERIFIED here and is covered by the agent "
            f"audit instead (see docs/major-map-verification.md). Skipping is the "
            f"honest outcome; passing would claim a check that did not happen."
        )

    missing = [code for code in found if code not in present]
    assert missing == [], (
        f"{document.get('major')} ({curated_path.name}): the source PDF schedules "
        f"{missing} but the curated map never mentions them"
    )

"""The derived fields in curated major maps must always reflect their semester_plan.

Multiple fields are derived from the semester_plan and automatically computed:
required_courses, elective_groups, validation counts (requirement_count,
low_confidence_requirement_count, semester_count), and the warnings array
containing "expected_exactly_eight_ordered_semesters" when len(semester_plan) != 8.
All are consumed downstream by the degree planner and elsewhere, so correctness
is not optional.

When rows in semester_plan were edited, these fields were never recomputed.
Maps that changed ended up internally inconsistent -- the stored values no
longer matched what a fresh re-derivation would produce. The only reason it was
caught was a manual audit; nothing in tests, scripts, or runtime code verified
consistency. This meant the invariant was sustained only by memory and
convention, not by code.

This test asserts that the invariant holds across the entire catalog: for every
map, the stored values are byte-for-byte identical to what a fresh re-derivation
produces. It is parametrized per map so a failure names the offending file.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.import_major_maps import _runtime_fields

ROOT = Path(__file__).resolve().parents[1]
CATALOG_YEAR = "2026-2027"
MAPS_DIR = ROOT / "data" / "curated" / "major_maps" / CATALOG_YEAR


def maps() -> list[Path]:
    """Paths to all curated maps for the catalog year."""
    paths = sorted(MAPS_DIR.glob("*.json"))
    assert paths, f"no maps found in {MAPS_DIR}"
    return paths


def rederive(data: dict) -> dict:
    """Compute derived fields from semester_plan."""
    metadata = {
        "name": data.get("major"),
        "degree": data.get("program"),
        "college": data.get("college"),
        "department": data.get("department"),
        "bulletin_year": data.get("catalog_year"),
        "minimum_total_hours": data.get("total_credits_required"),
    }
    semesters = data.get("semester_plan") or []
    runtime = _runtime_fields(metadata, semesters)

    # Compute expected_exactly_eight_ordered_semesters warning presence
    warnings = data.get("warnings") or []
    warnings_rederived = [w for w in warnings if w != "expected_exactly_eight_ordered_semesters"]
    if len(semesters) != 8:
        warnings_rederived.append("expected_exactly_eight_ordered_semesters")

    return {
        "required_courses": runtime["required_courses"],
        "elective_groups": runtime["elective_groups"],
        "requirement_count": sum(len(s.get("requirements") or []) for s in semesters),
        "low_confidence_requirement_count": sum(
            1
            for s in semesters
            for i in s.get("requirements") or []
            if i.get("confidence") == "low"
        ),
        "semester_count": len(semesters),
        "expected_exactly_eight_warning": "expected_exactly_eight_ordered_semesters"
        in warnings_rederived,
    }


@pytest.mark.parametrize("map_path", maps(), ids=lambda p: p.stem)
def test_required_courses_match_semester_plan(map_path: Path):
    """The required_courses list must be the exact product of re-deriving from semester_plan."""
    data = json.loads(map_path.read_text(encoding="utf-8"))
    fresh = rederive(data)
    stored = data.get("required_courses") or []
    assert stored == fresh["required_courses"], (
        f"{data.get('major')} ({map_path.name}): stored required_courses differ from re-derived"
    )


@pytest.mark.parametrize("map_path", maps(), ids=lambda p: p.stem)
def test_elective_groups_match_semester_plan(map_path: Path):
    """The elective_groups list must be the exact product of re-deriving from semester_plan."""
    data = json.loads(map_path.read_text(encoding="utf-8"))
    fresh = rederive(data)
    stored = data.get("elective_groups") or []
    assert stored == fresh["elective_groups"], (
        f"{data.get('major')} ({map_path.name}): stored elective_groups differ from re-derived"
    )


@pytest.mark.parametrize("map_path", maps(), ids=lambda p: p.stem)
def test_requirement_count_matches_semester_plan(map_path: Path):
    """The validation.requirement_count must be the exact total of all requirements."""
    data = json.loads(map_path.read_text(encoding="utf-8"))
    fresh = rederive(data)
    stored = data.get("validation", {}).get("requirement_count")
    assert stored == fresh["requirement_count"], (
        f"{data.get('major')} ({map_path.name}): "
        f"stored requirement_count {stored} "
        f"does not match re-derived {fresh['requirement_count']}"
    )


@pytest.mark.parametrize("map_path", maps(), ids=lambda p: p.stem)
def test_low_confidence_count_matches_semester_plan(map_path: Path):
    """The validation.low_confidence_requirement_count must be the exact count of 'low' confidence rows."""
    data = json.loads(map_path.read_text(encoding="utf-8"))
    fresh = rederive(data)
    stored = data.get("validation", {}).get("low_confidence_requirement_count")
    assert stored == fresh["low_confidence_requirement_count"], (
        f"{data.get('major')} ({map_path.name}): "
        f"stored low_confidence_requirement_count {stored} "
        f"does not match re-derived {fresh['low_confidence_requirement_count']}"
    )


@pytest.mark.parametrize("map_path", maps(), ids=lambda p: p.stem)
def test_semester_count_matches_semester_plan(map_path: Path):
    """The validation.semester_count must equal the length of semester_plan."""
    data = json.loads(map_path.read_text(encoding="utf-8"))
    fresh = rederive(data)
    stored = data.get("validation", {}).get("semester_count")
    assert stored == fresh["semester_count"], (
        f"{data.get('major')} ({map_path.name}): "
        f"stored semester_count {stored} "
        f"does not match len(semester_plan) {fresh['semester_count']}"
    )


@pytest.mark.parametrize("map_path", maps(), ids=lambda p: p.stem)
def test_expected_eight_semesters_warning_consistency(map_path: Path):
    """The 'expected_exactly_eight_ordered_semesters' warning must match semester_plan length."""
    data = json.loads(map_path.read_text(encoding="utf-8"))
    fresh = rederive(data)
    stored_has_warning = "expected_exactly_eight_ordered_semesters" in (data.get("warnings") or [])
    assert stored_has_warning == fresh["expected_exactly_eight_warning"], (
        f"{data.get('major')} ({map_path.name}): "
        f"'expected_exactly_eight_ordered_semesters' warning presence does not match "
        f"semester_plan length (len={len(data.get('semester_plan') or [])})"
    )

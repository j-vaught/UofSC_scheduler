import json
import re
from pathlib import Path


CATALOG_PATH = Path("static/data/campus_buildings.json")


def load_catalog() -> dict:
    return json.loads(CATALOG_PATH.read_text())


def normalized_aliases(building: dict) -> set[str]:
    return {" ".join(alias.lower().replace(".", "").split()) for alias in building["aliases"]}


def resolve_catalog_code(raw_location: str) -> str | None:
    normalized = re.sub(r"[^a-z0-9]+", " ", raw_location.lower()).strip()
    candidates = []
    for building in load_catalog()["buildings"]:
        for alias in [building["code"], building["name"], *building["aliases"]]:
            candidates.append((alias, building["code"]))
    candidates.sort(key=lambda candidate: len(candidate[0]), reverse=True)
    for alias, code in candidates:
        normalized_alias = re.sub(r"[^a-z0-9]+", " ", alias.lower()).strip()
        if normalized == normalized_alias or normalized.startswith(f"{normalized_alias} "):
            return code
    return None


def test_academic_building_catalog_is_complete_and_well_formed() -> None:
    catalog = load_catalog()
    buildings = catalog["buildings"]
    codes = [building["code"] for building in buildings]
    official_ids = [building["official_id"] for building in buildings]

    assert len(buildings) >= 80
    assert len(codes) == len(set(codes))
    assert len(official_ids) == len(set(official_ids))
    assert all(building["aliases"] for building in buildings)
    assert all(-90 <= building["lat"] <= 90 for building in buildings)
    assert all(-180 <= building["lon"] <= 180 for building in buildings)


def test_storey_engineering_aliases_match_banner_names() -> None:
    buildings = load_catalog()["buildings"]
    storey = next(building for building in buildings if building["code"] == "INNOVA")
    aliases = normalized_aliases(storey)

    assert storey["name"] == "M. Bert Storey Engineering & Innovation Center"
    assert "storey engineering center" in aliases
    assert "storey eng & innovation ctr" in aliases
    assert "m bert storey innovation center" in aliases


def test_science_and_technology_aliases_match_banner_names() -> None:
    buildings = load_catalog()["buildings"]
    science_and_technology = next(
        building for building in buildings if building["code"] == "1112GR"
    )
    aliases = normalized_aliases(science_and_technology)

    assert science_and_technology["name"] == "Science and Technology Building"
    assert "science and technology" in aliases
    assert "science and technology bldg" in aliases
    assert "science & technology bldg" in aliases


def test_callcott_aliases_match_banner_names() -> None:
    buildings = load_catalog()["buildings"]
    callcott = next(building for building in buildings if building["code"] == "CLLCTT")
    aliases = normalized_aliases(callcott)

    assert callcott["name"] == "Callcott Social Sciences Center"
    assert "callcot soc sci ctr" in aliases
    assert "callcott soc sci ctr" in aliases
    assert "callcot soc sci center" in aliases


def test_journalism_aliases_match_banner_names() -> None:
    buildings = load_catalog()["buildings"]
    journalism = next(building for building in buildings if building["code"] == "SJMC")
    aliases = normalized_aliases(journalism)

    assert journalism["name"] == "School of Journalism and Mass Communications"
    assert "sch of journalism & mass comm" in aliases
    assert "sch of journalism and mass comm" in aliases


def test_registrar_short_codes_resolve_to_existing_official_map_records() -> None:
    buildings = {building["code"]: building for building in load_catalog()["buildings"]}
    expected = {
        "BANDDF": (229055, "Band Dance"),
        "HZNPG": (223318, "Horizon"),
        "PHRC": (223334, "Public Hlth Res"),
        "WMBB": (223345, "WMBB Nursing"),
    }

    for code, (official_id, banner_alias) in expected.items():
        building = buildings[code]
        assert building["official_id"] == official_id
        assert banner_alias.lower() in {alias.lower() for alias in building["aliases"]}


def test_reported_and_shortened_banner_locations_resolve_with_room_numbers() -> None:
    expected_locations = {
        "Sch of Journalism & Mass Comm 310": "SJMC",
        "Storey Eng & Innovation Ctr 1400": "INNOVA",
        "Science and Technology Bldg 352": "1112GR",
        "Callcot Soc Sci Ctr 011": "CLLCTT",
        "HZNPG 101": "HZNPG",
        "Public Hlth Res 200": "PHRC",
        "Band Dance 101": "BANDDF",
        "WMBB Nursing 231": "WMBB",
    }

    for raw_location, expected_code in expected_locations.items():
        assert resolve_catalog_code(raw_location) == expected_code


def test_supplemental_classroom_buildings_are_retained() -> None:
    codes = {building["code"] for building in load_catalog()["buildings"]}

    assert {"BLATT", "COLH"} <= codes


def test_existing_banner_building_codes_are_retained() -> None:
    codes = {building["code"] for building in load_catalog()["buildings"]}

    assert {
        "300MN",
        "BANDDF",
        "BYRNES",
        "DMSB",
        "FLINN",
        "HZNPG",
        "PHRC",
        "SWGN",
    } <= codes

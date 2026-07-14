import json
from pathlib import Path


CATALOG_PATH = Path("static/data/campus_buildings.json")


def load_catalog() -> dict:
    return json.loads(CATALOG_PATH.read_text())


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
    normalized_aliases = {
        " ".join(alias.lower().replace(".", "").split()) for alias in storey["aliases"]
    }

    assert storey["name"] == "M. Bert Storey Engineering & Innovation Center"
    assert "storey engineering center" in normalized_aliases
    assert "storey eng & innovation ctr" in normalized_aliases
    assert "m bert storey innovation center" in normalized_aliases


def test_science_and_technology_aliases_match_banner_names() -> None:
    buildings = load_catalog()["buildings"]
    science_and_technology = next(
        building for building in buildings if building["code"] == "1112GR"
    )
    normalized_aliases = {
        " ".join(alias.lower().replace(".", "").split())
        for alias in science_and_technology["aliases"]
    }

    assert science_and_technology["name"] == "Science and Technology Building"
    assert "science and technology bldg" in normalized_aliases
    assert "science & technology bldg" in normalized_aliases


def test_callcott_aliases_match_banner_names() -> None:
    buildings = load_catalog()["buildings"]
    callcott = next(building for building in buildings if building["code"] == "CLLCTT")
    normalized_aliases = {
        " ".join(alias.lower().replace(".", "").split()) for alias in callcott["aliases"]
    }

    assert callcott["name"] == "Callcott Social Sciences Center"
    assert "callcot soc sci ctr" in normalized_aliases
    assert "callcott soc sci ctr" in normalized_aliases


def test_supplemental_classroom_buildings_are_retained() -> None:
    codes = {building["code"] for building in load_catalog()["buildings"]}

    assert {"BLATT", "COLH"} <= codes


def test_existing_banner_building_codes_are_retained() -> None:
    codes = {building["code"] for building in load_catalog()["buildings"]}

    assert {"300MN", "BYRNES", "DMSB", "FLINN", "SWGN"} <= codes

"""Sync academic building names, abbreviations, and coordinates from the UofSC map."""

from __future__ import annotations

import html
import json
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import requests

MAP_ID = 744
ACADEMIC_BUILDINGS_CATEGORY = 9492
PUBLIC_MAP_KEY = "0001085cc708b9cef47080f064612ca5"
API_BASE = "https://api.concept3d.com"
OFFICIAL_MAP_URL = "https://www.sc.edu/visit/map/index.php"
OUTPUT = Path(__file__).resolve().parents[1] / "static/data/campus_buildings.json"

MANUAL_ALIASES = {
    "BANDDF": [
        "Band Dance",
        "Copenhaver Band Hall",
        "Copenhaver Band Hall Dance Facility",
    ],
    "CLLCTT": [
        "Callcot Soc Sci Ctr",
        "Callcott Soc Sci Ctr",
        "Callcot Soc Sci Center",
        "Callcott Soc Sci Center",
        "Callcot Social Sciences Center",
        "Callcott",
        "Callcot",
    ],
    "HZNPG": [
        "Horizon",
        "Horizon I",
    ],
    "PHRC": [
        "Public Health Research",
        "Public Hlth Res",
        "Public Health Research Ctr",
    ],
    "SJMC": [
        "Sch of Jour",
        "Sch of Journalism & Mass Comm",
        "Sch of Journalism and Mass Comm",
        "School of Journalism & Mass Comm",
    ],
    "1112GR": [
        "Science and Technology",
        "Science and Technology Bldg",
        "Science & Technology Building",
        "Science & Technology Bldg",
        "Science and Tech Building",
        "Science and Tech Bldg",
    ],
    "INNOVA": [
        "Storey Engineering Center",
        "Storey Engineering Centre",
        "Storey Eng & Innovation Ctr",
        "Storey Eng and Innovation Ctr",
        "Storey Eng & Innovation Center",
        "Storey Eng and Innovation Center",
        "Storey Innovation Center",
        "M. Bert Storey Innovation Center",
        "M Bert Storey Innovation Center",
        "M. Bert Storey Engineering and Innovation Center",
        "M Bert Storey Engineering and Innovation Center",
        "M.Bert Storey Eng/Innov Center",
        "M.Bert Storey Eng/Innov Ctr",
    ],
    "WMBB": [
        "WMBB Nursing",
        "Nursing Building",
        "Williams-Brice Nursing Building",
    ],
}

# Banner location codes for official records whose map descriptions omit a
# usable building abbreviation.
PREFERRED_CODES = {
    223286: "300MN",
    223307: "DMSB",
    223313: "FLINN",
    223318: "HZNPG",
    223322: "BYRNES",
    223334: "PHRC",
    223342: "SWGN",
    229055: "BANDDF",
}

# Classroom locations used by the scheduler but classified outside the campus
# map's Academic Buildings category.
SUPPLEMENTAL_BUILDINGS = [
    {
        "code": "BLATT",
        "name": "Solomon Blatt Physical Education Center",
        "lat": 33.9922612,
        "lon": -81.0255729,
        "aliases": [
            "Blatt PE Center",
            "Blatt Physical Education Center",
            "Solomon Blatt Physical Education Center",
            "BLATT",
        ],
        "official_id": "supplemental-BLATT",
    },
    {
        "code": "COLH",
        "name": "Columbia Hall",
        "lat": 34.0011534,
        "lon": -81.0221496,
        "aliases": ["Columbia Hall", "COLH"],
        "official_id": "supplemental-COLH",
    },
]


def api_get(path: str) -> dict[str, Any]:
    response = requests.get(
        f"{API_BASE}/{path}",
        params={"map": MAP_ID, "key": PUBLIC_MAP_KEY},
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def normalize(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def text_from_html(value: str) -> str:
    return re.sub(r"<[^>]+>", " ", html.unescape(value)).replace("\xa0", " ").strip()


def building_abbreviation(description: str, location_id: int) -> str:
    plain = text_from_html(description)
    plain_match = re.search(
        r"(?i:Building Abbreviation):\s*([A-Z0-9-]{2,})\b",
        plain,
    )
    if plain_match:
        return plain_match.group(1).upper()

    match = re.search(
        r"Building Abbreviation[^<]*</strong>\s*([^<]+)",
        description,
        flags=re.IGNORECASE,
    )
    if not match:
        return f"C3D-{location_id}"
    parts = text_from_html(match.group(1)).split()
    if not parts:
        return f"C3D-{location_id}"
    abbreviation = parts[0].strip(":").upper()
    if not re.fullmatch(r"[A-Z0-9-]{2,}", abbreviation):
        return f"C3D-{location_id}"
    return abbreviation


def unique_aliases(values: list[str]) -> list[str]:
    seen: set[str] = set()
    aliases: list[str] = []
    for value in values:
        cleaned = " ".join(str(value).split()).strip()
        key = normalize(cleaned)
        if not cleaned or not key or key in seen:
            continue
        seen.add(key)
        aliases.append(cleaned)
    return aliases


def name_variants(name: str) -> list[str]:
    variants = [name, name.replace("&", "and")]
    without_parenthetical = re.sub(r"\s*\([^)]*\)\s*$", "", name).strip()
    if without_parenthetical != name:
        variants.extend([without_parenthetical, without_parenthetical.replace("&", "and")])
    variants.append(name.replace("Buildings", "Building"))
    return variants


def legacy_aliases(catalog: dict[str, Any], code: str, name: str) -> list[str]:
    official_keys = {normalize(value) for value in name_variants(name)}
    for building in catalog.get("buildings", []):
        aliases = [building.get("name", ""), *(building.get("aliases") or [])]
        alias_keys = {normalize(value) for value in aliases if value}
        if building.get("code") == code or official_keys & alias_keys:
            return aliases
    return []


def build_catalog() -> dict[str, Any]:
    old_catalog = json.loads(OUTPUT.read_text()) if OUTPUT.exists() else {"buildings": []}
    category = api_get(f"categories/{ACADEMIC_BUILDINGS_CATEGORY}?batch&children")
    locations = category.get("children", {}).get("locations", [])

    with ThreadPoolExecutor(max_workers=12) as pool:
        details = list(pool.map(lambda item: api_get(f"locations/{item['id']}"), locations))

    buildings: list[dict[str, Any]] = []
    for detail in details:
        location_id = int(detail["id"])
        code = PREFERRED_CODES.get(
            location_id,
            building_abbreviation(detail.get("description", ""), location_id),
        )
        name = str(detail["name"]).strip()
        aliases = unique_aliases(
            [
                *name_variants(name),
                code,
                *legacy_aliases(old_catalog, code, name),
                *MANUAL_ALIASES.get(code, []),
            ]
        )
        buildings.append(
            {
                "code": code,
                "name": name,
                "lat": float(detail["lat"]),
                "lon": float(detail["lng"]),
                "aliases": aliases,
                "official_id": location_id,
            }
        )

    merged_buildings: dict[str, dict[str, Any]] = {}
    for building in buildings:
        existing = merged_buildings.get(building["code"])
        if existing is None:
            merged_buildings[building["code"]] = building
            continue
        colocated = (
            abs(existing["lat"] - building["lat"]) < 0.001
            and abs(existing["lon"] - building["lon"]) < 0.001
        )
        if colocated:
            existing["aliases"] = unique_aliases(
                [*existing["aliases"], building["name"], *building["aliases"]]
            )
            continue
        building["code"] = f"C3D-{building['official_id']}"
        building["aliases"] = unique_aliases([*building["aliases"], building["code"]])
        merged_buildings[building["code"]] = building

    buildings = list(merged_buildings.values())
    official_building_count = len(buildings)
    known_codes = {building["code"] for building in buildings}
    for supplemental in SUPPLEMENTAL_BUILDINGS:
        if supplemental["code"] not in known_codes:
            buildings.append(supplemental.copy())

    buildings.sort(key=lambda building: (building["name"].casefold(), building["code"]))
    return {
        "center": old_catalog.get("center", [33.9971, -81.0278]),
        "source": {
            "name": "University of South Carolina Campus Map",
            "url": OFFICIAL_MAP_URL,
            "map_id": MAP_ID,
            "category_id": ACADEMIC_BUILDINGS_CATEGORY,
            "official_location_count": len(details),
            "official_building_count": official_building_count,
            "supplemental_building_count": len(buildings) - official_building_count,
        },
        "buildings": buildings,
    }


def main() -> None:
    catalog = build_catalog()
    OUTPUT.write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n")
    print(f"Synced {len(catalog['buildings'])} classroom buildings to {OUTPUT}")


if __name__ == "__main__":
    main()

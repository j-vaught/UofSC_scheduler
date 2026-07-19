"""Read the wire contract so Python agrees with the relay and the browser.

The term grammar was written out three times: a regex in the relay, another in
``build_offering_history.py``, and prose in the reference notes. Nothing tied
them together, so the notes had already drifted -- they claimed ``06`` and ``07``
were summer terms, which both implementations reject.

Loading the shared document instead means an upstream change is one edit to
``contracts/wire/fose-v1.json`` and mechanical updates in the consumers, and
``tests/test_wire_contract.js`` fails if any consumer stops agreeing.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTRACT_PATH = ROOT / "contracts" / "wire" / "fose-v1.json"


@lru_cache(maxsize=1)
def load_contract() -> dict:
    """Return the parsed contract, failing loudly if it is missing."""
    if not CONTRACT_PATH.is_file():
        raise FileNotFoundError(f"Wire contract is missing: {CONTRACT_PATH}")
    return json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))


@lru_cache(maxsize=None)
def pattern_for(type_name: str) -> re.Pattern[str]:
    """Compile a named type's pattern from the contract."""
    types = load_contract()["types"]
    if type_name not in types:
        raise KeyError(f"Unknown wire type: {type_name}")
    return re.compile(types[type_name]["pattern"])


def is_valid_term(value: object) -> bool:
    """True when the value is a term the relay would accept.

    YYYYMM with 01, 05 or 08. No other suffix is a term anywhere in this system.
    """
    return bool(pattern_for("term").fullmatch(str(value or "")))


def is_valid_crn(value: object) -> bool:
    """True when the value is a five-digit CRN."""
    return bool(pattern_for("crn").fullmatch(str(value or "")))


def limit(name: str) -> int:
    """Return a named limit, so callers do not restate the relay's numbers."""
    limits = load_contract()["limits"]
    if name not in limits:
        raise KeyError(f"Unknown wire limit: {name}")
    return int(limits[name])


def allowed_search_fields() -> frozenset[str]:
    """Search criteria fields the relay will forward."""
    criteria = load_contract()["routes"]["/api/search"]["request"]["criteria"]
    return frozenset(criteria["allowed_fields"])

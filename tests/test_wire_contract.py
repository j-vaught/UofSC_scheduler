"""Python must agree with the relay and the browser about the wire grammar.

The term rule was written out three times with nothing tying them together, and
the prose copy had already drifted -- it claimed 06 and 07 were summer terms,
which both implementations reject. These pin Python to the shared document.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from scripts.wire_contract import (
    CONTRACT_PATH,
    allowed_search_fields,
    is_valid_crn,
    is_valid_term,
    limit,
    load_contract,
)

ROOT = Path(__file__).resolve().parents[1]


def test_contract_examples_agree_with_python() -> None:
    """The contract's own examples decide, so drift cannot hide here."""
    types = load_contract()["types"]
    for value in types["term"]["valid"]:
        assert is_valid_term(value), f"{value} is contract-valid but Python rejected it"
    for value in types["term"]["invalid"]:
        assert not is_valid_term(value), f"{value} is contract-invalid but Python accepted it"
    for value in types["crn"]["valid"]:
        assert is_valid_crn(value)
    for value in types["crn"]["invalid"]:
        assert not is_valid_crn(value)


def test_offering_history_term_rule_matches_the_contract() -> None:
    """The standalone regex must accept exactly what the contract does."""
    source = (ROOT / "scripts" / "build_offering_history.py").read_text(encoding="utf-8")
    match = re.search(r'TERM_RE = re\.compile\(r"([^"]+)"\)', source)
    assert match, "build_offering_history.py should still declare TERM_RE"
    standalone = re.compile(match.group(1))
    types = load_contract()["types"]["term"]
    for value in types["valid"]:
        assert standalone.fullmatch(value), f"{value} rejected by TERM_RE but valid per contract"
    for value in types["invalid"]:
        assert not standalone.fullmatch(value), (
            f"{value} accepted by TERM_RE but invalid per contract"
        )


def test_limits_are_read_not_restated() -> None:
    assert limit("max_body_bytes") == 16384
    assert limit("max_faculty_crns") == 12


def test_search_fields_come_from_the_contract() -> None:
    fields = allowed_search_fields()
    assert "crn" in fields, "the browser uses crn; dropping it would break search"
    assert "instructor" not in fields, "instructor is not forwarded by the relay"


def test_contract_is_valid_json_and_present() -> None:
    assert CONTRACT_PATH.is_file()
    json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))

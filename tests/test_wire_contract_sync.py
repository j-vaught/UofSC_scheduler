"""The wire contract's constants must match the code that enforces them.

contracts/wire/fose-v1.json calls itself the single source of truth for the
relay's validators, the browser's encoder, and the Python pipeline. It was not
quite: the field allowlist and the request limits were typed out again in two
consumers, so adding a search field was three edits kept consistent by care.

scripts/sync_wire_contract.py writes them from the contract. This fails when a
consumer drifts, which is what turns "remember to update the other two" into a
red test naming the file that is stale.

Adding course_attr as a search criterion is the change that motivated this: it
touched the contract, the relay and the encoder, and nothing but a reviewer's
attention connected them.
"""

from __future__ import annotations

import json
from pathlib import Path

from scripts.sync_wire_contract import CONTRACT, ENCODER, RELAY, sync

ROOT = Path(__file__).resolve().parents[1]


def test_consumers_are_in_sync_with_the_contract():
    assert sync(check=True) == 0, (
        "a consumer has drifted from contracts/wire/fose-v1.json; "
        "run: uv run python scripts/sync_wire_contract.py"
    )


def test_the_allowlist_really_reaches_both_consumers():
    """Not just 'the script is happy' -- the values are actually present."""
    contract = json.loads(CONTRACT.read_text(encoding="utf-8"))
    allowed = contract["routes"]["/api/search"]["request"]["criteria"]["allowed_fields"]
    assert "course_attr" in allowed, "the Carolina Core filter needs this field"

    relay = RELAY.read_text(encoding="utf-8")
    encoder = ENCODER.read_text(encoding="utf-8")
    for field in allowed:
        assert f"'{field}'" in relay, f"the relay would reject {field}"
        assert f"'{field}'" in encoder, f"the encoder would refuse to send {field}"


def test_limits_reach_the_relay():
    contract = json.loads(CONTRACT.read_text(encoding="utf-8"))
    limits = contract["limits"]
    relay = RELAY.read_text(encoding="utf-8")
    assert f"const MAX_FACULTY_CRNS = {limits['max_faculty_crns']};" in relay
    assert f"const MAX_RELAY_BODY_BYTES = {limits['max_body_bytes']};" in relay


def test_sync_is_idempotent():
    """Running it twice changes nothing the second time."""
    assert sync(check=False) == 0
    assert sync(check=True) == 0

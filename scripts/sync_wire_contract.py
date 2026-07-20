"""Rewrite the wire contract's constants into the code that enforces them.

The contract in contracts/wire/fose-v1.json calls itself the single source of
truth for the relay's validators, the browser's request encoder, and the Python
pipeline. It was not quite: the field allowlist and the request limits were
typed out again in server/index.js and in the browser encoder, so adding a
search field meant three edits that a reviewer had to notice were consistent.

A test caught divergence, which is worth having, but catching a mistake is not
the same as making it hard to make. This script writes the constants from the
contract into both consumers, so the edit is one file and the rest follows.

Run it after changing the contract:

    uv run python scripts/sync_wire_contract.py          # rewrite
    uv run python scripts/sync_wire_contract.py --check  # fail if stale

--check is what tests use, so a contract edited without syncing fails rather
than shipping a relay that rejects what the encoder sends.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "contracts" / "wire" / "fose-v1.json"
RELAY = ROOT / "server" / "index.js"
ENCODER = ROOT / "static" / "js" / "platform" / "university" / "wire" / "fose-v1.js"

GENERATED = "// Generated from contracts/wire/fose-v1.json by scripts/sync_wire_contract.py"


def _load() -> dict:
    return json.loads(CONTRACT.read_text(encoding="utf-8"))


def _criteria(contract: dict) -> dict:
    return contract["routes"]["/api/search"]["request"]["criteria"]


def _js_list(values: list[str]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def _replace(source: str, pattern: str, replacement: str, what: str) -> str:
    updated, count = re.subn(pattern, replacement.replace("\\", "\\\\"), source, count=1)
    if count != 1:
        raise SystemExit(f"Could not find {what}; the consumer's shape changed.")
    return updated


def render_relay(contract: dict) -> str:
    """The relay's copy of the allowlist and the body limits."""
    source = RELAY.read_text(encoding="utf-8")
    criteria = _criteria(contract)
    limits = contract["limits"]

    source = _replace(
        source,
        r"const SEARCH_FIELDS = new Set\(\[[^\]]*\]\);",
        f"const SEARCH_FIELDS = new Set([{_js_list(sorted(criteria['allowed_fields']))}]);",
        "SEARCH_FIELDS in the relay",
    )
    source = _replace(
        source,
        r"const MAX_FACULTY_CRNS = \d+;",
        f"const MAX_FACULTY_CRNS = {limits['max_faculty_crns']};",
        "MAX_FACULTY_CRNS in the relay",
    )
    source = _replace(
        source,
        r"const MAX_FACULTY_CONCURRENCY = \d+;",
        f"const MAX_FACULTY_CONCURRENCY = {limits['max_faculty_concurrency']};",
        "MAX_FACULTY_CONCURRENCY in the relay",
    )
    source = _replace(
        source,
        r"const MAX_RELAY_BODY_BYTES = [^;]+;",
        f"const MAX_RELAY_BODY_BYTES = {limits['max_body_bytes']};",
        "MAX_RELAY_BODY_BYTES in the relay",
    )
    return source


def render_encoder(contract: dict) -> str:
    """The browser encoder's copy of the same rules."""
    source = ENCODER.read_text(encoding="utf-8")
    criteria = _criteria(contract)

    source = _replace(
        source,
        r"const ALLOWED_FIELDS = Object\.freeze\(\[[^\]]*\]\);",
        f"const ALLOWED_FIELDS = Object.freeze([{_js_list(sorted(criteria['allowed_fields']))}]);",
        "ALLOWED_FIELDS in the encoder",
    )
    source = _replace(
        source,
        r"const MAX_CRITERIA = \d+;",
        f"const MAX_CRITERIA = {criteria['max_items']};",
        "MAX_CRITERIA in the encoder",
    )
    source = _replace(
        source,
        r"const MAX_VALUE_LENGTH = \d+;",
        f"const MAX_VALUE_LENGTH = {criteria['value_max_length']};",
        "MAX_VALUE_LENGTH in the encoder",
    )
    return source


def sync(check: bool = False) -> int:
    contract = _load()
    targets = [(RELAY, render_relay(contract)), (ENCODER, render_encoder(contract))]

    stale: list[Path] = []
    for path, rendered in targets:
        if path.read_text(encoding="utf-8") != rendered:
            stale.append(path)
            if not check:
                path.write_text(rendered, encoding="utf-8")

    if check:
        if stale:
            names = ", ".join(str(p.relative_to(ROOT)) for p in stale)
            print(
                f"Out of sync with the wire contract: {names}\n"
                "Run: uv run python scripts/sync_wire_contract.py",
                file=sys.stderr,
            )
            return 1
        print("Wire contract consumers are in sync.")
        return 0

    if stale:
        for path in stale:
            print(f"Updated {path.relative_to(ROOT)}")
    else:
        print("Already in sync; nothing to do.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="exit non-zero if a consumer is stale instead of rewriting it",
    )
    args = parser.parse_args()
    return sync(check=args.check)


if __name__ == "__main__":
    raise SystemExit(main())

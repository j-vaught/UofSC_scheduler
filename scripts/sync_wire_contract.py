"""Rewrite the wire contract into the code that enforces it.

The contract in contracts/wire/fose-v1.json calls itself the single source of
truth for the relay's validators, the browser's request encoder, and the Python
pipeline. It was not quite: the field allowlist, the request limits, the term
and CRN grammars, the per-route upstreams and the response caps were all typed
out again in server/index.js, so an upstream change was a search across the tree
rather than one edit.

This script now embeds the whole contract into server/index.js as a single
frozen object between generated markers, so the relay validates against the
document itself rather than a hand-copied subset of it. The browser encoder
still takes only the three scalars it needs, because it is a small module that
has no reason to carry the entire grammar.

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

# The relay carries the contract inside these markers. Everything between them
# is regenerated wholesale, so a hand edit there is overwritten on the next sync
# and --check fails in the meantime, which is the point.
RELAY_BEGIN = (
    "// >>> BEGIN generated from contracts/wire/fose-v1.json by scripts/sync_wire_contract.py"
)
RELAY_END = "// <<< END generated"


def _load() -> dict:
    return json.loads(CONTRACT.read_text(encoding="utf-8"))


def _criteria(contract: dict) -> dict:
    return contract["routes"]["/api/search"]["request"]["criteria"]


def _js_list(values: list[str]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def _js_string(value: str) -> str:
    """A single-quoted JavaScript string literal for an arbitrary contract value.

    Single quotes keep the embedded allowlist reading the way the rest of the
    relay is written, and keep tests that look for a field as 'name' finding it.
    """
    escaped = (
        value.replace("\\", "\\\\")
        .replace("'", "\\'")
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t")
    )
    return f"'{escaped}'"


def _js_literal(value: object, indent: int) -> str:
    """Serialize a parsed-JSON value as a single-quoted JavaScript literal.

    Only the shapes the contract actually uses are handled, on purpose: an
    unexpected type should fail the sync loudly rather than emit code that looks
    plausible and is wrong.
    """
    pad = "    " * indent
    child_pad = "    " * (indent + 1)
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, dict):
        if not value:
            return "{}"
        lines = [
            f"{child_pad}{_js_string(str(key))}: {_js_literal(item, indent + 1)}"
            for key, item in value.items()
        ]
        return "{\n" + ",\n".join(lines) + f",\n{pad}}}"
    if isinstance(value, list):
        if not value:
            return "[]"
        # Short scalar lists (allowlists, term vocabularies) read better inline;
        # anything holding an object or a nested list gets one entry per line.
        if all(not isinstance(item, (dict, list)) for item in value):
            return "[" + ", ".join(_js_literal(item, indent + 1) for item in value) + "]"
        lines = [f"{child_pad}{_js_literal(item, indent + 1)}" for item in value]
        return "[\n" + ",\n".join(lines) + f",\n{pad}]"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, str):
        return _js_string(value)
    if value is None:
        return "null"
    raise SystemExit(f"Unsupported contract value while rendering the relay: {value!r}")


def _relay_block(contract: dict) -> str:
    """The generated region of server/index.js: the contract plus named limits."""
    limits = contract["limits"]
    return "\n".join(
        [
            RELAY_BEGIN,
            "// The whole wire contract is embedded so the relay validates against the",
            "// document itself rather than a hand-copied subset of it. The deployed",
            "// worker stays a single dependency-free file because the contract is here",
            "// at sync time, not fetched at runtime. Regenerate with",
            "// scripts/sync_wire_contract.py; never edit below by hand.",
            "const CONTRACT = Object.freeze(/* generated */ " + _js_literal(contract, 0) + ");",
            "// Named limits mirror CONTRACT.limits so a timeout or a byte cap reads",
            "// clearly at its call site while the contract stays their only source.",
            f"const MAX_RELAY_BODY_BYTES = {limits['max_body_bytes']};",
            f"const UPSTREAM_TIMEOUT_MS = {limits['upstream_timeout_ms']};",
            f"const MAX_FACULTY_CRNS = {limits['max_faculty_crns']};",
            f"const MAX_FACULTY_CONCURRENCY = {limits['max_faculty_concurrency']};",
            RELAY_END,
        ]
    )


def render_relay(contract: dict) -> str:
    """Replace the generated block in server/index.js with the current contract."""
    source = RELAY.read_text(encoding="utf-8")
    block = _relay_block(contract)
    pattern = re.compile(re.escape(RELAY_BEGIN) + r".*?" + re.escape(RELAY_END), re.DOTALL)
    # A function replacement is used rather than a string one so backslashes in
    # the embedded regex patterns are not read as replacement escapes.
    updated, count = pattern.subn(lambda _match: block, source, count=1)
    if count != 1:
        raise SystemExit(
            "Could not find the generated wire-contract block in server/index.js; "
            "the BEGIN/END markers may have been removed or edited."
        )
    return updated


def _replace(source: str, pattern: str, replacement: str, what: str) -> str:
    updated, count = re.subn(pattern, replacement.replace("\\", "\\\\"), source, count=1)
    if count != 1:
        raise SystemExit(f"Could not find {what}; the consumer's shape changed.")
    return updated


def render_encoder(contract: dict) -> str:
    """The browser encoder's copy of the three rules it needs."""
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

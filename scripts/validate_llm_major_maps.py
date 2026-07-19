#!/usr/bin/env python3
"""Validate model-extracted major maps against the schema and source archive."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator


DEFAULT_INPUT_DIR = Path("data/interim/major_maps_llm")
DEFAULT_SCHEMA = Path("schemas/major_map_llm_v1.schema.json")
DEFAULT_MANIFEST = Path("data/raw/major_map_pdfs/manifest.json")


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def validate_outputs(
    input_dir: Path,
    schema_path: Path,
    manifest_path: Path,
    *,
    require_complete: bool = False,
) -> list[str]:
    schema = _load_json(schema_path)
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema)
    manifest = _load_json(manifest_path)
    source_by_id = {entry["map_id"]: entry for entry in manifest.get("maps", [])}
    errors: list[str] = []
    seen_ids: set[str] = set()

    for path in sorted(input_dir.glob("*/*.json")):
        try:
            payload = _load_json(path)
        except (OSError, json.JSONDecodeError) as error:
            errors.append(f"{path}: invalid JSON: {error}")
            continue
        for error in sorted(validator.iter_errors(payload), key=lambda item: list(item.path)):
            location = ".".join(str(part) for part in error.absolute_path) or "$"
            errors.append(f"{path}:{location}: {error.message}")
        map_id = payload.get("map_id")
        if not isinstance(map_id, str):
            continue
        if map_id in seen_ids:
            errors.append(f"{path}: duplicate map_id {map_id}")
        seen_ids.add(map_id)
        source = source_by_id.get(map_id)
        if source is None:
            errors.append(f"{path}: map_id {map_id} is not in the source manifest")
            continue
        expected_path = input_dir / source["catalog_year"] / f"{map_id}.json"
        if path != expected_path:
            errors.append(f"{path}: expected output path {expected_path}")
        extracted_source = payload.get("source") or {}
        comparisons = {
            "catalog_year": source["catalog_year"],
            "pdf_path": source["local_path"],
            "pdf_url": source["source_url"],
            "sha256": source["sha256"],
            "page_count": source["page_count"],
        }
        for field, expected in comparisons.items():
            if extracted_source.get(field) != expected:
                errors.append(f"{path}: source.{field} must equal manifest value {expected!r}")

    if require_complete:
        missing = sorted(set(source_by_id) - seen_ids)
        extra = sorted(seen_ids - set(source_by_id))
        if missing:
            errors.append(f"missing {len(missing)} map outputs; first missing: {missing[:10]}")
        if extra:
            errors.append(f"found {len(extra)} unexpected map outputs: {extra[:10]}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", type=Path, default=DEFAULT_INPUT_DIR)
    parser.add_argument("--schema", type=Path, default=DEFAULT_SCHEMA)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--require-complete", action="store_true")
    args = parser.parse_args()
    errors = validate_outputs(
        args.input_dir,
        args.schema,
        args.manifest,
        require_complete=args.require_complete,
    )
    if errors:
        print("\n".join(errors))
        return 1
    count = len(list(args.input_dir.glob("*/*.json")))
    print(f"Validated {count} LLM major-map outputs.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

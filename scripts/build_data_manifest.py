#!/usr/bin/env python3
"""Create and atomically publish a manifest for an immutable release tree."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.static_release import (
    SCHEMA_VERSION,
    build_manifest,
    validate_manifest,
    write_manifest_atomic,
)


def scan_release(release_dir: Path) -> dict[str, dict[str, Any]]:
    """Hash every release JSON file and use its relative path as the logical key."""
    artifacts: dict[str, dict[str, Any]] = {}
    for path in sorted(release_dir.rglob("*.json")):
        relative = path.relative_to(release_dir).as_posix()
        content = path.read_bytes()
        logical_name = relative.rsplit(".", 2)[0] if relative.count(".") >= 2 else relative
        artifacts[logical_name] = {
            "path": relative,
            "bytes": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
            "media_type": "application/json",
            "schema_version": SCHEMA_VERSION,
        }
    if not artifacts:
        raise ValueError(f"No JSON artifacts found in {release_dir}")
    return artifacts


def load_object(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release-dir", type=Path, required=True)
    parser.add_argument("--release-id", required=True)
    parser.add_argument("--generated-at", required=True)
    parser.add_argument("--scope", type=Path)
    parser.add_argument("--coverage", type=Path)
    parser.add_argument("--base-url")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    artifacts = scan_release(args.release_dir)
    base_url = args.base_url or f"releases/{args.release_id}"
    manifest = build_manifest(
        release_id=args.release_id,
        generated_at=args.generated_at,
        scope=load_object(args.scope),
        coverage=load_object(args.coverage),
        artifacts=artifacts,
        base_url=base_url,
    )
    validate_manifest(manifest)
    write_manifest_atomic(args.output, manifest)
    print(f"Published {args.output} with {len(artifacts)} artifacts", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

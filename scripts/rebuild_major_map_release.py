#!/usr/bin/env python3
"""Publish a static-data release that changes only the major-map artifacts."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
from collections.abc import Callable, Mapping
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import unquote, urlsplit

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.build_catalog_shards import load_major_maps, major_map_runtime_projection
from scripts.static_release import (
    build_manifest,
    publish_release_directory,
    utc_now,
    validate_manifest,
    verify_artifact,
    write_immutable_json,
    write_manifest_atomic,
)


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "static" / "data" / "manifest.json"
DEFAULT_MAPS_DIR = ROOT / "data" / "maps"


def _release_relative_path(
    artifact: Mapping[str, Any],
    *,
    source_release_id: str,
) -> Path:
    """Return an artifact path relative to its immutable release directory."""
    raw_url = str(artifact.get("url", "")).strip()
    parsed = urlsplit(raw_url)
    if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
        raise ValueError(f"Artifact URL must be a local static path: {raw_url!r}")
    url_path = PurePosixPath(unquote(parsed.path))
    expected_prefix = ("releases", source_release_id)
    parts = tuple(part for part in url_path.parts if part not in ("", "/"))
    if parts[:2] != expected_prefix or len(parts) < 3:
        raise ValueError(f"Artifact URL is outside release {source_release_id!r}: {raw_url!r}")
    relative = Path(*parts[2:])
    if any(part in ("", ".", "..") for part in relative.parts):
        raise ValueError(f"Artifact URL has an unsafe path: {raw_url!r}")
    return relative


def _copy_existing_artifact(
    *,
    source_root: Path,
    staging: Path,
    source_release_id: str,
    artifact: Mapping[str, Any],
) -> dict[str, Any]:
    """Verify and copy one immutable artifact while preserving its descriptor."""
    relative = _release_relative_path(artifact, source_release_id=source_release_id)
    source = source_root / "releases" / source_release_id / relative
    descriptor = {**artifact, "path": str(relative)}
    descriptor.pop("url", None)
    verify_artifact(source_root / "releases" / source_release_id, descriptor)
    if not source.is_file() or source.is_symlink():
        raise ValueError(f"Artifact is not a regular immutable file: {source}")
    destination = staging / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    verify_artifact(staging, descriptor)
    return descriptor


def _read_json_artifact(
    source_root: Path,
    source_release_id: str,
    artifact: Mapping[str, Any],
) -> dict[str, Any]:
    """Read a verified JSON artifact from the selected release."""
    relative = _release_relative_path(artifact, source_release_id=source_release_id)
    descriptor = {**artifact, "path": str(relative)}
    descriptor.pop("url", None)
    release_root = source_root / "releases" / source_release_id
    verify_artifact(release_root, descriptor)
    payload = json.loads((release_root / relative).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Artifact {artifact.get('url')!r} must contain an object")
    return payload


def rebuild_major_map_release(
    *,
    active_manifest_path: Path,
    maps_dir: Path,
    output_root: Path,
    release_id: str,
    generated_at: str | None = None,
    manifest_replace: Callable[[Path, Path], None] = os.replace,
) -> tuple[Path, Path, dict[str, Any]]:
    """Reuse an active release and atomically activate rebuilt major-map data."""
    active_manifest = json.loads(active_manifest_path.read_text(encoding="utf-8"))
    if not isinstance(active_manifest, dict):
        raise ValueError("Active manifest must contain an object")
    validate_manifest(active_manifest)
    source_release_id = str(active_manifest["release_id"])
    if release_id == source_release_id:
        raise ValueError("The incremental release must use a new release identifier")

    timestamp = generated_at or utc_now()
    major_maps, major_map_index, curriculum_coverage = load_major_maps(
        maps_dir,
        generated_at=timestamp,
    )
    source_root = active_manifest_path.parent
    releases_root = output_root / "releases"
    releases_root.mkdir(parents=True, exist_ok=True)
    destination = releases_root / release_id
    if destination.exists():
        raise FileExistsError(f"Immutable release already exists: {destination}")
    staging = Path(tempfile.mkdtemp(prefix=f".{release_id}.tmp-", dir=releases_root))

    artifacts: dict[str, dict[str, Any]] = {}
    lazy_major_map_artifacts: dict[str, dict[str, Any]] = {}
    try:
        for logical_name, artifact in active_manifest["artifacts"].items():
            if logical_name == "index" or logical_name.startswith("major-maps/"):
                continue
            artifacts[logical_name] = _copy_existing_artifact(
                source_root=source_root,
                staging=staging,
                source_release_id=source_release_id,
                artifact=artifact,
            )

        maps_by_year: dict[str, dict[str, dict[str, Any]]] = {}
        for map_id, payload in major_maps.items():
            year = str(payload.get("catalog_year") or "unknown")
            maps_by_year.setdefault(year, {})[map_id] = major_map_runtime_projection(payload)
        for year, year_maps in sorted(maps_by_year.items()):
            lazy_major_map_artifacts[year] = write_immutable_json(
                staging,
                f"major-maps/major-maps-{year}.json",
                {
                    "schema_version": 1,
                    "kind": "major_map_bundle",
                    "catalog_year": year,
                    "maps": year_maps,
                },
            )
        index_entries = {entry["id"]: entry for entry in major_map_index["maps"]}
        for map_id, payload in major_maps.items():
            year = str(payload.get("catalog_year") or "unknown")
            descriptor = lazy_major_map_artifacts[year]
            index_entries[map_id]["artifact"] = {
                "url": f"releases/{release_id}/{descriptor['path']}",
                "bytes": descriptor["bytes"],
                "sha256": descriptor["sha256"],
                "media_type": descriptor["media_type"],
                "schema_version": descriptor["schema_version"],
                "bundle_key": f"major-maps/catalog-year/{year}",
                "entry_key": map_id,
            }
        artifacts["major-maps/index"] = write_immutable_json(
            staging,
            "major-maps/index.json",
            major_map_index,
        )

        old_index_descriptor = active_manifest["artifacts"].get("index")
        if not isinstance(old_index_descriptor, Mapping):
            raise ValueError("Active manifest has no release index artifact")
        release_index = _read_json_artifact(
            source_root,
            source_release_id,
            old_index_descriptor,
        )
        release_index["generated_at"] = timestamp
        release_index["major_map_count"] = len(major_maps)
        release_index.pop("major_maps", None)
        artifacts["index"] = write_immutable_json(staging, "index.json", release_index)

        for artifact in [*artifacts.values(), *lazy_major_map_artifacts.values()]:
            verify_artifact(staging, artifact)
        publish_release_directory(staging, destination)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise

    coverage = json.loads(json.dumps(active_manifest.get("coverage", {})))
    coverage["curriculum"] = curriculum_coverage
    manifest = build_manifest(
        release_id=release_id,
        generated_at=timestamp,
        scope=active_manifest.get("scope", {}),
        coverage=coverage,
        artifacts=artifacts,
        base_url=f"releases/{release_id}",
    )
    manifest_path = output_root / "manifest.json"
    write_manifest_atomic(manifest_path, manifest, replace=manifest_replace)
    return destination, manifest_path, manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--active-manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--maps-dir", type=Path, default=DEFAULT_MAPS_DIR)
    parser.add_argument("--output-root", type=Path)
    parser.add_argument("--release-id", required=True)
    parser.add_argument("--generated-at")
    args = parser.parse_args()
    output_root = args.output_root or args.active_manifest.parent
    destination, manifest_path, manifest = rebuild_major_map_release(
        active_manifest_path=args.active_manifest,
        maps_dir=args.maps_dir,
        output_root=output_root,
        release_id=args.release_id,
        generated_at=args.generated_at,
    )
    total_bytes = sum(int(artifact["bytes"]) for artifact in manifest["artifacts"].values())
    print(
        f"Published {len(manifest['artifacts'])} artifacts ({total_bytes:,} bytes) "
        f"to {destination}",
        flush=True,
    )
    print(f"Activated {manifest_path}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

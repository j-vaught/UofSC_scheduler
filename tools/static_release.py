"""Shared helpers for immutable, browser-readable static data releases."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
from collections.abc import Callable, Iterable, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


SCHEMA_VERSION = 1
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
FORBIDDEN_PUBLIC_KEYS = {
    "banner_id",
    "bannerid",
    "course_reference_number",
    "coursereferencenumber",
    "crn",
    "email",
    "email_address",
    "emailaddress",
    "source_file",
}


def utc_now() -> str:
    """Return a release timestamp with an explicit UTC offset."""
    return datetime.now(UTC).replace(microsecond=0).isoformat()


def canonical_json_bytes(payload: Any) -> bytes:
    """Serialize JSON deterministically so hashes are reproducible."""
    return json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def assert_privacy_safe(payload: Any, path: str = "$") -> None:
    """Reject fields that must never enter a public static artifact."""
    if isinstance(payload, Mapping):
        for key, value in payload.items():
            normalized = re.sub(r"[^a-z0-9_]", "", str(key).lower())
            if normalized in FORBIDDEN_PUBLIC_KEYS:
                raise ValueError(f"Private field {key!r} found at {path}")
            assert_privacy_safe(value, f"{path}.{key}")
    elif isinstance(payload, list):
        for index, value in enumerate(payload):
            assert_privacy_safe(value, f"{path}[{index}]")


def artifact_filename(logical_name: str, digest: str) -> str:
    """Insert a shortened content hash before a file extension."""
    path = Path(logical_name)
    suffix = path.suffix or ".json"
    stem = path.stem if path.suffix else path.name
    return str(path.with_name(f"{stem}.{digest[:16]}{suffix}"))


def write_immutable_json(
    release_dir: Path,
    logical_name: str,
    payload: Any,
    *,
    public: bool = True,
) -> dict[str, Any]:
    """Write a content-hashed JSON artifact and return manifest metadata."""
    if public:
        assert_privacy_safe(payload)
    content = canonical_json_bytes(payload)
    digest = sha256_bytes(content)
    relative_path = artifact_filename(logical_name, digest)
    destination = release_dir / relative_path
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(content)
    return {
        "path": relative_path,
        "bytes": len(content),
        "sha256": digest,
        "media_type": "application/json",
        "schema_version": SCHEMA_VERSION,
    }


def verify_artifact(root: Path, artifact: Mapping[str, Any]) -> None:
    """Verify an artifact's length and digest against manifest metadata."""
    path = root / str(artifact["path"])
    content = path.read_bytes()
    expected_bytes = int(artifact["bytes"])
    expected_hash = str(artifact["sha256"])
    if len(content) != expected_bytes:
        raise ValueError(f"Byte-size mismatch for {path}")
    if not SHA256_RE.fullmatch(expected_hash) or sha256_bytes(content) != expected_hash:
        raise ValueError(f"SHA-256 mismatch for {path}")


def build_manifest(
    *,
    release_id: str,
    generated_at: str,
    scope: Mapping[str, Any],
    coverage: Mapping[str, Any],
    artifacts: Mapping[str, Mapping[str, Any]],
    base_url: str,
) -> dict[str, Any]:
    """Construct the stable manifest consumed by the browser data store."""
    normalized_base = base_url.rstrip("/")
    manifest_artifacts: dict[str, dict[str, Any]] = {}
    for name, artifact in sorted(artifacts.items()):
        record = dict(artifact)
        record["url"] = f"{normalized_base}/{record.pop('path')}"
        manifest_artifacts[name] = record
    return {
        "schema_version": SCHEMA_VERSION,
        "release_id": release_id,
        "generated_at": generated_at,
        "scope": dict(scope),
        "coverage": dict(coverage),
        "artifacts": manifest_artifacts,
    }


def validate_manifest(manifest: Mapping[str, Any]) -> None:
    """Validate the public manifest's minimum cross-version contract."""
    if manifest.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("Unsupported manifest schema version")
    if not str(manifest.get("release_id", "")).strip():
        raise ValueError("Manifest release_id is required")
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, Mapping) or not artifacts:
        raise ValueError("Manifest must contain at least one artifact")
    for name, artifact in artifacts.items():
        if not isinstance(artifact, Mapping):
            raise ValueError(f"Artifact {name!r} must be an object")
        if int(artifact.get("bytes", -1)) < 0:
            raise ValueError(f"Artifact {name!r} has an invalid byte size")
        if not SHA256_RE.fullmatch(str(artifact.get("sha256", ""))):
            raise ValueError(f"Artifact {name!r} has an invalid SHA-256 digest")
        if not str(artifact.get("url", "")).strip():
            raise ValueError(f"Artifact {name!r} has no URL")


def write_manifest_atomic(
    output: Path,
    manifest: Mapping[str, Any],
    *,
    replace: Callable[[Path, Path], None] = os.replace,
) -> None:
    """Publish a manifest last, without exposing a partially written file."""
    validate_manifest(manifest)
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{output.name}.", suffix=".tmp", dir=output.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(canonical_json_bytes(manifest))
            handle.flush()
            os.fsync(handle.fileno())
        replace(temporary, output)
        directory_descriptor = os.open(output.parent, os.O_RDONLY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    finally:
        temporary.unlink(missing_ok=True)


def publish_release_directory(staging: Path, destination: Path) -> None:
    """Move a completed staging tree into its immutable release location."""
    if destination.exists():
        raise FileExistsError(f"Immutable release already exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    os.replace(staging, destination)


def remove_staging_directories(parent: Path, prefix: str) -> None:
    """Remove only temporary release directories created by this pipeline."""
    for path in parent.glob(f".{prefix}.tmp-*"):
        if path.is_dir():
            shutil.rmtree(path)


def comma_values(values: Iterable[str] | None) -> list[str]:
    """Normalize repeated or comma/space-separated command-line values."""
    output: list[str] = []
    for value in values or []:
        output.extend(part.upper() for part in re.split(r"[,;\s]+", value) if part)
    return sorted(set(output))

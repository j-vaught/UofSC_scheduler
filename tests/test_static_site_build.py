"""Process-free static site build tests."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from scripts.build_static_site import build_site


def write_source(root: Path) -> Path:
    source = root / "static"
    (source / "css").mkdir(parents=True)
    (source / "js").mkdir()
    release = source / "data" / "releases" / "release-1"
    release.mkdir(parents=True)
    artifact = release / "index.1234.json"
    artifact.write_text('{"schema_version":1}', encoding="utf-8")
    digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
    (source / "data" / "manifest.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "release_id": "release-1",
                "scope": {"kind": "full"},
                "artifacts": {
                    "index": {
                        "url": "releases/release-1/index.1234.json",
                        "bytes": artifact.stat().st_size,
                        "sha256": digest,
                    }
                },
            }
        ),
        encoding="utf-8",
    )
    (source / "index.html").write_text(
        '<link href="/static/css/style.css"><script src="/static/js/app.js"></script>',
        encoding="utf-8",
    )
    (source / "css" / "style.css").write_text("body {}", encoding="utf-8")
    (source / "js" / "app.js").write_text("'use strict';", encoding="utf-8")
    (source / "service-worker.js").write_text(
        "const BUILD_ID = '__STATIC_BUILD_ID__'; self.addEventListener('fetch',()=>{});",
        encoding="utf-8",
    )
    (source / "private.db").write_text("not public", encoding="utf-8")
    return source


def test_build_emits_process_free_static_root(tmp_path: Path) -> None:
    source = write_source(tmp_path)
    output = tmp_path / "dist"
    result = build_site(source, output)

    assert result == output
    assert (output / "index.html").is_file()
    assert (output / "404.html").is_file()
    assert (output / "service-worker.js").is_file()
    assert (output / "static" / "index.html").is_file()
    assert (output / "static" / "data" / "manifest.json").is_file()
    assert not (output / "static" / "private.db").exists()
    assert "immutable" in (output / "_headers").read_text(encoding="utf-8")

    (output / "stale.txt").write_text("remove on rebuild", encoding="utf-8")
    build_site(source, output)
    assert not (output / "stale.txt").exists()


def test_build_rejects_missing_manifest_artifact(tmp_path: Path) -> None:
    source = write_source(tmp_path)
    next((source / "data" / "releases").rglob("*.json")).unlink()

    with pytest.raises(FileNotFoundError, match="Manifest artifact"):
        build_site(source, tmp_path / "dist")


def test_build_rejects_missing_index_asset(tmp_path: Path) -> None:
    source = write_source(tmp_path)
    (source / "js" / "app.js").unlink()

    with pytest.raises(FileNotFoundError, match="Index references"):
        build_site(source, tmp_path / "dist")


def test_build_rejects_manifest_hash_mismatch(tmp_path: Path) -> None:
    source = write_source(tmp_path)
    artifact = next((source / "data" / "releases").rglob("*.json"))
    artifact.write_text('{"schema_version":2}', encoding="utf-8")

    with pytest.raises(ValueError, match="SHA-256"):
        build_site(source, tmp_path / "dist")


def test_representative_release_requires_explicit_opt_in(tmp_path: Path) -> None:
    source = write_source(tmp_path)
    manifest_path = source / "data" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["scope"] = {"kind": "representative"}
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(ValueError, match="not full coverage"):
        build_site(source, tmp_path / "dist")
    assert build_site(
        source,
        tmp_path / "dist",
        allow_representative=True,
    ).is_dir()

"""Process-free static site build tests."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from tools.build_static_site import build_site

ROOT = Path(__file__).resolve().parents[1]


def load_contract() -> dict:
    return json.loads(
        (ROOT / "tools" / "contracts" / "wire" / "fose-v1.json").read_text(encoding="utf-8")
    )


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
        '<link href="/static/css/style.css"><script src="/static/js/app.js?v=2"></script>',
        encoding="utf-8",
    )
    (source / "css" / "style.css").write_text("body {}", encoding="utf-8")
    (source / "js" / "app.js").write_text("'use strict';", encoding="utf-8")
    (source / "service-worker.js").write_text(
        "const BUILD_ID = '__STATIC_BUILD_ID__';\n"
        # The shell list is injected from index.html at build time, so a worker
        # without this placeholder is a worker the build cannot complete.
        "const SHELL_ASSETS = __SHELL_ASSETS__;\n"
        "self.addEventListener('fetch',()=>{});",
        encoding="utf-8",
    )
    (source / "private.db").write_text("not public", encoding="utf-8")
    return source


def test_build_emits_process_free_static_root(tmp_path: Path) -> None:
    source = write_source(tmp_path)
    output = tmp_path / "dist"
    result = build_site(source, output)

    assert result == output
    client = output / "client"
    assert (client / "index.html").is_file()
    assert (client / "404.html").is_file()
    assert (client / "service-worker.js").is_file()
    assert (client / "static" / "index.html").is_file()
    assert (client / "static" / "data" / "manifest.json").is_file()
    assert not (client / "static" / "private.db").exists()
    assert (output / "server" / "index.js").is_file()
    assert (output / "server" / "package.json").is_file()
    wrangler = json.loads((output / "server" / "wrangler.json").read_text(encoding="utf-8"))
    assert wrangler["assets"]["directory"] == "../client"
    assert wrangler["assets"]["run_worker_first"] is True
    assert wrangler["main"] == "index.js"
    worker = (output / "server" / "index.js").read_text(encoding="utf-8")
    assert "env.ASSETS.fetch" in worker
    assert "export default worker" in worker
    assert "Method not allowed" in worker
    assert "'/api/search'" in worker
    assert "'/api/details'" in worker
    assert "'/api/faculty'" in worker
    # The upstreams come from the contract the worker embeds, so the check reads
    # them rather than restating a URL that a contract edit would leave stale.
    contract = load_contract()
    assert contract["routes"]["/api/search"]["upstream"] in worker
    assert contract["routes"]["/api/details"]["upstream"] in worker
    assert "getFacultyMeetingTimes" in worker
    assert "endpoint.searchParams.set('mepCode', 'COL')" in worker
    assert "MAX_FACULTY_CONCURRENCY = 4" in worker
    assert "X-Scheduler-Relay" in worker
    assert "Live relay upstream failure" in worker
    assert worker.index("if (relayRoute)") < worker.index("if (!['GET', 'HEAD'].includes")
    headers = (client / "_headers").read_text(encoding="utf-8")
    assert "immutable" in headers
    assert "Content-Security-Policy" in headers
    assert "frame-ancestors 'none'" in headers
    assert "Permissions-Policy" in headers
    assert "Cross-Origin-Resource-Policy" in headers

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


def test_asset_urls_are_stamped_with_content_digests(tmp_path: Path) -> None:
    """Every script and stylesheet URL gets a digest derived from its bytes.

    The hand-maintained query strings drifted -- some tags carried a date, the
    runtime modules carried nothing -- and the worker caches everything under
    /static/ for an hour, so a rebuilt file kept serving stale.
    """
    from tools.build_static_site import stamp_asset_urls

    source = tmp_path / "static"
    (source / "js").mkdir(parents=True)
    (source / "css").mkdir()
    (source / "js" / "app.js").write_text("console.log(1);", encoding="utf-8")
    (source / "css" / "app.css").write_text("body{}", encoding="utf-8")

    html = (
        '<link rel="stylesheet" href="/static/css/app.css">'
        '<script src="/static/js/app.js"></script>'
        '<script src="/static/js/app.js?v=hand-written"></script>'
    )
    stamped, count = stamp_asset_urls(html, source)

    assert count == 3, "every asset URL should be stamped"
    assert "?v=hand-written" not in stamped, "a stale hand-written marker must be replaced"
    digest = hashlib.sha256(b"console.log(1);").hexdigest()[:12]
    assert f"/static/js/app.js?v={digest}" in stamped

    # The digest must follow the bytes, or it cannot prevent a stale cache.
    (source / "js" / "app.js").write_text("console.log(2);", encoding="utf-8")
    restamped, _ = stamp_asset_urls(html, source)
    assert restamped != stamped, "changing a file must change its digest"


def test_stamping_leaves_unknown_assets_alone(tmp_path: Path) -> None:
    """A missing asset keeps its URL rather than gaining a wrong digest.

    validate_source reports a genuinely missing file; inventing a marker here
    would hide that and cache a 404 under a plausible-looking version.
    """
    from tools.build_static_site import stamp_asset_urls

    source = tmp_path / "static"
    source.mkdir()
    html = '<script src="/static/js/missing.js"></script>'
    stamped, count = stamp_asset_urls(html, source)
    assert count == 0
    assert stamped == html


def test_single_quoted_tags_are_stamped_and_precached(tmp_path: Path) -> None:
    """A single-quoted src is stamped and precached, not silently skipped.

    INDEX_ASSET_RE already read both quote styles, but ASSET_URL_RE and the
    shell_assets regex read only double quotes, so a single-quoted tag slipped
    past stamping (serving stale for the cache hour) and past precaching (broken
    offline) with nothing to reveal it.
    """
    from tools.build_static_site import shell_assets, stamp_asset_urls

    source = tmp_path / "static"
    (source / "js").mkdir(parents=True)
    (source / "js" / "app.js").write_text("console.log(1);", encoding="utf-8")

    html = "<script src='/static/js/app.js'></script>"
    stamped, count = stamp_asset_urls(html, source)
    assert count == 1, "a single-quoted tag must be stamped"
    digest = hashlib.sha256(b"console.log(1);").hexdigest()[:12]
    # Stamped, and with its original quote style preserved rather than rewritten.
    assert f"src='/static/js/app.js?v={digest}'" in stamped

    assert "/static/js/app.js" in shell_assets(html), "a single-quoted tag must be precached"

#!/usr/bin/env python3
"""Build a process-free static site while preserving absolute /static paths."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "static"
DEFAULT_OUTPUT = ROOT / "dist"
INDEX_ASSET_RE = re.compile(r"(?:href|src)=[\"'](/static/[^\"']+)[\"']")
FORBIDDEN_SUFFIXES = {".db", ".py", ".pyc", ".sqlite", ".sqlite3"}
# The relay worker is real JavaScript in server/index.js so it can be linted,
# highlighted, and diffed normally. It is copied verbatim into dist/server/.
SITES_WORKER_SOURCE = ROOT / "server" / "index.js"


def load_sites_worker() -> str:
    """Read the relay worker source, failing loudly if it has gone missing."""
    if not SITES_WORKER_SOURCE.is_file():
        raise FileNotFoundError(f"Relay worker source is missing: {SITES_WORKER_SOURCE}")
    return SITES_WORKER_SOURCE.read_text(encoding="utf-8")


def load_manifest(source: Path) -> dict[str, Any]:
    manifest_path = source / "data" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or not isinstance(manifest.get("artifacts"), dict):
        raise ValueError(f"Invalid static data manifest: {manifest_path}")
    return manifest


def validate_source(source: Path, *, allow_representative: bool = False) -> None:
    index_path = source / "index.html"
    if not index_path.is_file():
        raise FileNotFoundError(f"Missing static application entry point: {index_path}")
    index = index_path.read_text(encoding="utf-8")
    for absolute_path in INDEX_ASSET_RE.findall(index):
        asset_path = absolute_path.split("?", 1)[0].split("#", 1)[0]
        relative = asset_path.removeprefix("/static/")
        if not (source / relative).is_file():
            raise FileNotFoundError(f"Index references a missing asset: {absolute_path}")

    manifest = load_manifest(source)
    scope_kind = str(manifest.get("scope", {}).get("kind", "full"))
    if scope_kind != "full" and not allow_representative:
        raise ValueError(
            "The active static data release is not full coverage. "
            "Use --allow-representative only for local validation."
        )
    manifest_root = source / "data"
    for name, descriptor in manifest["artifacts"].items():
        if not isinstance(descriptor, dict) or not descriptor.get("url"):
            raise ValueError(f"Manifest artifact {name!r} has no URL")
        artifact = manifest_root / str(descriptor["url"])
        if not artifact.is_file():
            raise FileNotFoundError(f"Manifest artifact {name!r} is missing: {artifact}")
        expected_bytes = int(descriptor.get("bytes", -1))
        if expected_bytes != artifact.stat().st_size:
            raise ValueError(f"Manifest artifact {name!r} has an invalid byte length")
        expected_hash = str(descriptor.get("sha256", "")).lower()
        actual_hash = hashlib.sha256(artifact.read_bytes()).hexdigest()
        if expected_hash != actual_hash:
            raise ValueError(f"Manifest artifact {name!r} has an invalid SHA-256 digest")


def should_copy(path: Path) -> bool:
    if path.name in {".DS_Store"} or path.name.startswith("._"):
        return False
    return path.suffix.lower() not in FORBIDDEN_SUFFIXES


def write_headers(output: Path) -> None:
    (output / "_headers").write_text(
        """/service-worker.js
  Cache-Control: no-cache, max-age=0, must-revalidate

/static/data/manifest.json
  Cache-Control: no-cache, max-age=0, must-revalidate

/static/data/releases/*
  Cache-Control: public, max-age=31536000, immutable

/static/*
  Cache-Control: public, max-age=3600

/*
  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data: https://*.tile.openstreetmap.org; connect-src 'self' https://academicbulletins.sc.edu https://cdn.jsdelivr.net https://unpkg.com https://huggingface.co https://*.huggingface.co https://*.hf.co https://*.openstreetmap.de https://*.tile.openstreetmap.org; worker-src 'self' blob:; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  X-Content-Type-Options: nosniff
  Cross-Origin-Resource-Policy: same-origin
  Referrer-Policy: strict-origin-when-cross-origin
""",
        encoding="utf-8",
    )


def static_build_id(source: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(item for item in source.rglob("*") if item.is_file()):
        if not should_copy(path):
            continue
        digest.update(path.relative_to(source).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()[:16]


def build_site(
    source: Path = DEFAULT_SOURCE,
    output: Path = DEFAULT_OUTPUT,
    *,
    allow_representative: bool = False,
) -> Path:
    source = source.resolve()
    output = output.resolve()
    validate_source(source, allow_representative=allow_representative)
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.tmp-", dir=output.parent))
    try:
        client = staging / "client"
        server = staging / "server"
        client.mkdir(parents=True)
        server.mkdir(parents=True)
        shutil.copy2(source / "index.html", client / "index.html")
        shutil.copy2(source / "index.html", client / "404.html")
        shutil.copytree(
            source,
            client / "static",
            copy_function=shutil.copy2,
            ignore=lambda directory, names: [
                name for name in names if not should_copy(Path(directory) / name)
            ],
        )
        service_worker = source / "service-worker.js"
        if not service_worker.is_file():
            raise FileNotFoundError(f"Missing service worker: {service_worker}")
        worker_source = service_worker.read_text(encoding="utf-8")
        placeholder = "__STATIC_BUILD_ID__"
        if placeholder not in worker_source:
            raise ValueError("Service worker has no static build identifier placeholder")
        rendered_worker = worker_source.replace(placeholder, static_build_id(source))
        (client / "service-worker.js").write_text(rendered_worker, encoding="utf-8")
        (client / "static" / "service-worker.js").write_text(
            rendered_worker,
            encoding="utf-8",
        )
        write_headers(client)
        (server / "index.js").write_text(load_sites_worker(), encoding="utf-8")
        (server / "package.json").write_text('{"type":"module"}\n', encoding="utf-8")
        (server / "wrangler.json").write_text(
            json.dumps(
                {
                    "name": "course-scheduler",
                    "compatibility_date": "2026-05-15",
                    "main": "index.js",
                    "no_bundle": True,
                    "rules": [
                        {
                            "type": "ESModule",
                            "globs": ["**/*.js", "**/*.mjs"],
                        }
                    ],
                    "assets": {
                        "directory": "../client",
                        "run_worker_first": True,
                    },
                    "observability": {"enabled": True},
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

        forbidden = [
            path
            for path in staging.rglob("*")
            if path.is_file() and path.suffix.lower() in FORBIDDEN_SUFFIXES
        ]
        if forbidden:
            raise ValueError(f"Process-backed files entered static output: {forbidden[0]}")

        previous = output.with_name(f".{output.name}.previous")
        if previous.exists():
            shutil.rmtree(previous)
        if output.exists():
            os.replace(output, previous)
        try:
            os.replace(staging, output)
        except Exception:
            if previous.exists() and not output.exists():
                os.replace(previous, output)
            raise
        shutil.rmtree(previous, ignore_errors=True)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return output


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--allow-representative",
        action="store_true",
        help="Permit a partial data release for local validation only",
    )
    args = parser.parse_args()
    output = build_site(
        args.source,
        args.output,
        allow_representative=args.allow_representative,
    )
    files = sum(1 for path in output.rglob("*") if path.is_file())
    size = sum(path.stat().st_size for path in output.rglob("*") if path.is_file())
    print(f"Built {files} static files ({size:,} bytes) in {output}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

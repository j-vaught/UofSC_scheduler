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
SITES_WORKER = """const SECURITY_HEADERS = Object.freeze({
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data: https://*.tile.openstreetmap.org; connect-src 'self' https://academicbulletins.sc.edu https://cdn.jsdelivr.net https://unpkg.com https://huggingface.co https://*.huggingface.co https://*.openstreetmap.de https://*.tile.openstreetmap.org; worker-src 'self' blob:; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
});

const RELAY_ROUTES = Object.freeze({
    '/api/search': Object.freeze({
        upstream: 'https://classes.sc.edu/api/?page=fose&route=search',
        kind: 'search',
    }),
    '/api/details': Object.freeze({
        upstream: 'https://classes.sc.edu/api/?page=fose&route=details',
        kind: 'details',
    }),
    '/api/faculty': Object.freeze({
        kind: 'faculty',
    }),
});

const SEARCH_FIELDS = new Set(['alias', 'crn', 'keyword', 'stat', 'subject']);
const BANNER_BASE = 'https://banner.onecarolina.sc.edu/StudentRegistrationSsb/ssb';
const MAX_FACULTY_CRNS = 12;
const MAX_FACULTY_CONCURRENCY = 4;
const MAX_RELAY_BODY_BYTES = 16 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;

function cachePolicy(pathname) {
    if (pathname === '/service-worker.js' || pathname === '/static/data/manifest.json') {
        return 'no-cache, max-age=0, must-revalidate';
    }
    if (pathname.startsWith('/static/data/releases/')) {
        return 'public, max-age=31536000, immutable';
    }
    if (pathname.startsWith('/static/')) return 'public, max-age=3600';
    return 'no-cache, max-age=0, must-revalidate';
}

function withHeaders(response, pathname) {
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
    headers.set('Cache-Control', cachePolicy(pathname));
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

function jsonResponse(payload, status, pathname, extraHeaders = {}) {
    return withHeaders(new Response(JSON.stringify(payload), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            ...extraHeaders,
        },
    }), pathname);
}

function validTerm(value) {
    return /^\\d{4}(?:01|05|08)$/.test(String(value || ''));
}

function validateSearchPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    if (Object.keys(payload).some(key => !['other', 'criteria'].includes(key))) return false;
    if (!payload.other || typeof payload.other !== 'object' || Array.isArray(payload.other)) {
        return false;
    }
    if (Object.keys(payload.other).some(key => key !== 'srcdb')) return false;
    if (!validTerm(payload.other.srcdb)) return false;
    if (!Array.isArray(payload.criteria)
        || payload.criteria.length < 1
        || payload.criteria.length > 6) return false;
    const fields = new Set();
    for (const criterion of payload.criteria) {
        if (!criterion || typeof criterion !== 'object' || Array.isArray(criterion)) return false;
        if (Object.keys(criterion).some(key => !['field', 'value'].includes(key))) return false;
        const field = String(criterion.field || '');
        if (!SEARCH_FIELDS.has(field) || fields.has(field)) return false;
        if (typeof criterion.value !== 'string'
            || criterion.value.length < 1
            || criterion.value.length > 120) return false;
        fields.add(field);
    }
    return payload.criteria.some(criterion => criterion.field !== 'stat');
}

function validateDetailsPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    if (Object.keys(payload).some(key => !['group', 'srcdb'].includes(key))) return false;
    if (!validTerm(payload.srcdb)) return false;
    const group = String(payload.group || '');
    return /^crn:\\d{5}$/.test(group);
}

function validateFacultyPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    if (Object.keys(payload).some(key => !['term', 'crns'].includes(key))) return false;
    if (!validTerm(payload.term)) return false;
    if (!Array.isArray(payload.crns)
        || payload.crns.length < 1
        || payload.crns.length > MAX_FACULTY_CRNS) return false;
    const values = payload.crns.map(value => String(value || ''));
    return values.every(value => /^\\d{5}$/.test(value))
        && new Set(values).size === values.length;
}

async function parseRelayBody(request, route, pathname) {
    const contentType = String(request.headers.get('content-type') || '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
        return { error: jsonResponse({ error: 'Expected a JSON request body' }, 415, pathname) };
    }
    const declaredLength = Number(request.headers.get('content-length') || 0);
    if (declaredLength > MAX_RELAY_BODY_BYTES) {
        return { error: jsonResponse({ error: 'Request body is too large' }, 413, pathname) };
    }
    let text;
    try {
        text = await request.text();
    } catch (error) {
        return { error: jsonResponse({ error: 'Could not read request body' }, 400, pathname) };
    }
    if (new TextEncoder().encode(text).byteLength > MAX_RELAY_BODY_BYTES) {
        return { error: jsonResponse({ error: 'Request body is too large' }, 413, pathname) };
    }
    let payload;
    try {
        payload = JSON.parse(text);
    } catch (error) {
        return { error: jsonResponse({ error: 'Request body is not valid JSON' }, 400, pathname) };
    }
    const valid = route.kind === 'search'
        ? validateSearchPayload(payload)
        : route.kind === 'details'
            ? validateDetailsPayload(payload)
            : validateFacultyPayload(payload);
    if (!valid) {
        return { error: jsonResponse({ error: 'Request body is invalid for this operation' }, 400, pathname) };
    }
    return { payload, text };
}

async function readJsonResponse(response, maxBytes) {
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
        const error = new Error('Upstream response was not JSON');
        error.code = 'INVALID_UPSTREAM_CONTENT_TYPE';
        throw error;
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > maxBytes) {
        const error = new Error('Upstream response was too large');
        error.code = 'UPSTREAM_RESPONSE_TOO_LARGE';
        throw error;
    }
    const text = new TextDecoder().decode(bytes);
    try {
        return text ? JSON.parse(text) : {};
    } catch (cause) {
        const error = new Error('Upstream response was not valid JSON', { cause });
        error.code = 'INVALID_UPSTREAM_RESPONSE';
        throw error;
    }
}

async function fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function publicInstructorId(value) {
    const bytes = new TextEncoder().encode(`uofsc-scheduler:${String(value).toLowerCase()}`);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return `prof_${[...new Uint8Array(digest)]
        .map(part => part.toString(16).padStart(2, '0')).join('').slice(0, 16)}`;
}

function facultyPrimary(value) {
    if (typeof value === 'boolean') return value;
    return ['true', 'yes', 'y', '1'].includes(String(value || '').trim().toLowerCase());
}

function facultyEmail(value) {
    const email = String(value || '').trim().toLowerCase();
    return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email) ? email : '';
}

async function relayFaculty(payload, pathname) {
    const responses = [];
    for (let start = 0; start < payload.crns.length; start += MAX_FACULTY_CONCURRENCY) {
        const batch = payload.crns.slice(start, start + MAX_FACULTY_CONCURRENCY);
        responses.push(...await Promise.all(batch.map(async crn => {
            const endpoint = new URL(`${BANNER_BASE}/searchResults/getFacultyMeetingTimes`);
            endpoint.searchParams.set('term', payload.term);
            endpoint.searchParams.set('courseReferenceNumber', crn);
            endpoint.searchParams.set('mepCode', 'COL');
            const response = await fetchWithTimeout(endpoint.href, {
                method: 'GET',
                headers: { Accept: 'application/json' },
            });
            if (!response.ok) {
                const error = new Error(`Faculty provider returned status ${response.status}`);
                error.code = 'FACULTY_UPSTREAM_HTTP_ERROR';
                throw error;
            }
            const data = await readJsonResponse(response, 256 * 1024);
            if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.fmt)) {
                const error = new Error('Faculty provider returned an unexpected response');
                error.code = 'INVALID_FACULTY_RESPONSE';
                throw error;
            }
            return { crn, data };
        })));
    }
    const faculty = [];
    const seen = new Set();
    for (const { crn, data } of responses) {
        for (const meeting of data.fmt) {
            for (const member of meeting?.faculty || []) {
                const name = String(member?.displayName || member?.name || '').trim();
                const email = facultyEmail(member?.emailAddress || member?.email);
                const bannerId = String(member?.bannerId || '').trim().toUpperCase().replace(/\\.0$/, '');
                const identity = bannerId || email || name.toLowerCase();
                const key = `${crn}:${identity}`;
                if (!name || !identity || seen.has(key)) continue;
                seen.add(key);
                faculty.push({
                    crn,
                    name,
                    email,
                    primary: facultyPrimary(member?.primaryIndicator ?? member?.primary),
                    professor_id: bannerId ? await publicInstructorId(bannerId) : '',
                    identity_source: bannerId ? 'faculty_id' : '',
                });
            }
        }
    }
    return jsonResponse({ faculty }, 200, pathname, {
        'Cache-Control': 'no-store, max-age=0',
        'X-Scheduler-Relay': 'sites-worker',
    });
}

async function relayRequest(request, url, route) {
    if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405, url.pathname, {
            Allow: 'POST',
        });
    }
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) {
        return jsonResponse({ error: 'Cross-origin relay requests are not allowed' }, 403, url.pathname);
    }
    if (request.headers.get('sec-fetch-site') === 'cross-site') {
        return jsonResponse({ error: 'Cross-origin relay requests are not allowed' }, 403, url.pathname);
    }
    const parsed = await parseRelayBody(request, route, url.pathname);
    if (parsed.error) return parsed.error;
    try {
        if (route.kind === 'faculty') {
            return await relayFaculty(parsed.payload, url.pathname);
        }
        const response = await fetchWithTimeout(route.upstream, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: parsed.text,
        });
        if (!response.ok) {
            return jsonResponse({
                error: 'Live data provider returned an error',
                upstream_status: response.status,
            }, response.status === 429 ? 429 : 502, url.pathname);
        }
        const maxBytes = route.kind === 'search' ? 1024 * 1024 : 256 * 1024;
        const data = await readJsonResponse(response, maxBytes);
        if (data && typeof data === 'object' && data.error) {
            return jsonResponse({ error: String(data.error) }, 502, url.pathname);
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)
            || (route.kind === 'search' && !Array.isArray(data.results))) {
            return jsonResponse({ error: 'Live data provider returned an unexpected response' }, 502, url.pathname);
        }
        return jsonResponse(data, 200, url.pathname, {
            'Cache-Control': 'no-store, max-age=0',
            'X-Scheduler-Relay': 'sites-worker',
        });
    } catch (error) {
        console.error('Live relay upstream failure', {
            route: url.pathname,
            name: String(error?.name || 'Error'),
            message: String(error?.message || 'Unknown error').slice(0, 300),
        });
        const timedOut = error?.name === 'AbortError';
        return jsonResponse({
            error: timedOut ? 'Live data request timed out' : 'Live data request failed',
            code: timedOut ? 'UPSTREAM_TIMEOUT' : String(error?.code || 'UPSTREAM_FAILED'),
        }, timedOut ? 504 : 502, url.pathname);
    }
}

const worker = {
    async fetch(request, env) {
        const url = new URL(request.url);
        const relayRoute = RELAY_ROUTES[url.pathname];
        if (relayRoute) return relayRequest(request, url, relayRoute);
        if (!['GET', 'HEAD'].includes(request.method)) {
            return withHeaders(new Response('Method not allowed', {
                status: 405,
                headers: { Allow: 'GET, HEAD' },
            }), url.pathname);
        }
        let response = await env.ASSETS.fetch(request);
        const acceptsHtml = request.headers.get('accept')?.includes('text/html');
        const isApplicationPath = !url.pathname.startsWith('/static/')
            && url.pathname !== '/service-worker.js'
            && !url.pathname.split('/').pop()?.includes('.');
        if (response.status === 404 && request.method === 'GET' && acceptsHtml && isApplicationPath) {
            response = await env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
        }
        return withHeaders(response, url.pathname);
    },
};

export default worker;
"""


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
        relative = absolute_path.removeprefix("/static/")
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
  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data: https://*.tile.openstreetmap.org; connect-src 'self' https://academicbulletins.sc.edu https://banner.onecarolina.sc.edu https://cdn.jsdelivr.net https://unpkg.com https://huggingface.co https://*.huggingface.co https://*.openstreetmap.de https://*.tile.openstreetmap.org; worker-src 'self' blob:; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
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
        (server / "index.js").write_text(SITES_WORKER, encoding="utf-8")
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

"""The offline shell asset list, derived from index.html at build time.

This used to be a hand-maintained array in service-worker.js. Adding a file to
the page and adding it to that array were two separate edits with nothing tying
them together, so forgetting the second produced a page that worked online and
was quietly broken offline. No test failed and no ordinary load revealed it,
because the network simply served the file that was missing from the cache.

What these check is the property that replaced the discipline: everything the
page loads is precached because it is on the page, and the handful of files no
markup mentions are named explicitly rather than remembered.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from scripts.build_static_site import SHELL_EXTRA, shell_assets

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "static" / "index.html"
WORKER = ROOT / "static" / "service-worker.js"


@pytest.fixture(scope="module")
def index_html() -> str:
    return INDEX.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def assets(index_html: str) -> list[str]:
    return shell_assets(index_html)


def test_every_script_and_stylesheet_on_the_page_is_precached(index_html, assets):
    referenced = re.findall(r'<(?:script[^>]+src|link[^>]+href)="(/static/[^"?]+)', index_html)
    assert referenced, "index.html should reference static assets"
    missing = [ref for ref in referenced if ref not in assets]
    assert missing == [], f"page loads these but the shell would not cache them: {missing}"


def test_the_navigation_entry_points_are_precached(assets):
    # Without these the application shell cannot start offline at all.
    assert assets[0] == "/"
    assert "/static/index.html" in assets


def test_assets_fetched_by_script_are_named_explicitly(assets):
    """Workers and data shards are loaded by code, so no markup mentions them.

    Deriving from index.html alone silently dropped these when the derivation
    was first written; the omission was caught by diffing against the list it
    replaced rather than by any assertion, which is why this one exists.
    """
    for extra in SHELL_EXTRA:
        assert extra in assets, f"{extra} is fetched by script and must be listed"
        assert (ROOT / extra.lstrip("/")).is_file(), f"{extra} does not exist"


def test_no_duplicates(assets):
    assert len(assets) == len(set(assets)), "a duplicated entry wastes cache and hides intent"


def test_every_precached_file_exists(assets):
    absent = [
        asset for asset in assets if asset not in {"/"} and not (ROOT / asset.lstrip("/")).is_file()
    ]
    assert absent == [], f"the shell would try to cache files that do not exist: {absent}"


def test_workers_built_in_code_are_named_in_the_shell_list():
    """Every worker script the code constructs must be in SHELL_EXTRA.

    The other tests check the list forward: its entries exist and the page's
    script tags are covered. They do not check this direction. A worker is loaded
    with ``new Worker(...)``, so no markup mentions it and the derivation from
    index.html cannot see it; if its path is not in SHELL_EXTRA it works online
    and is silently missing offline, exactly the drift the explicit list exists
    to prevent. Both forms in the code are covered here -- a literal passed
    straight to the constructor (api.js:505) and the entries of a URL map the
    constructor indexes into (api.js:537-539).
    """
    referenced: set[str] = set()
    for source in (ROOT / "static" / "js").rglob("*.js"):
        for path in re.findall(
            r"""['"](/static/js/[^'"?]+\.js)""", source.read_text(encoding="utf-8")
        ):
            if "worker" in path:
                referenced.add(path)
    assert referenced, "expected at least one worker script under static/js"
    missing = sorted(path for path in referenced if path not in SHELL_EXTRA)
    assert missing == [], f"workers built in code but not precached offline: {missing}"


def test_the_worker_defers_to_the_build(assets):
    """service-worker.js must carry the placeholder, not a literal list.

    If someone pastes a real array back in, the drift this removed returns
    silently -- the build would substitute nothing and the stale list would
    ship. Checked here rather than trusted.
    """
    source = WORKER.read_text(encoding="utf-8")
    assert "__SHELL_ASSETS__" in source
    assert "'/static/js/api.js'" not in source, "a literal asset list has crept back in"


def test_the_built_worker_contains_the_derived_list(tmp_path, assets):
    """End to end: the placeholder is really replaced by valid JSON."""
    from scripts.build_static_site import build_site

    built = build_site(output=tmp_path / "dist", allow_representative=True)
    worker = (built / "client" / "service-worker.js").read_text(encoding="utf-8")
    assert "__SHELL_ASSETS__" not in worker, "the placeholder was not substituted"

    start = worker.index("const SHELL_ASSETS = ") + len("const SHELL_ASSETS = ")
    end = worker.index("];", start) + 1
    assert json.loads(worker[start:end]) == assets

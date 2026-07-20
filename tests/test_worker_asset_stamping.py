"""Content digests on the URLs that reach Web Workers.

index.html has been stamped for a while, so the main thread always picks up new
code after a deploy. Workers never pass through index.html. They are loaded by
URL from JavaScript and pull their dependencies in with importScripts(), and
both were plain unversioned paths, while the site serves /static/* with
max-age=3600.

The result was an hour after every deploy in which the main thread ran the new
build and every worker ran the previous one. Nothing throws -- each half is
internally consistent and they simply compute different answers. It shipped as
``evaluateRequirementGroups`` returning ``eligible: true`` on the main thread and
``eligible: false`` inside the worker for the same input, surfacing as a degree
plan with twelve unplaceable courses through the UI and one through the
identical main-thread path.

These read the real dist, not a fixture, because the property that matters is
about what is deployed. The second one is the property itself: change a byte of
a runtime module and the URL that loads it must change.
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path

import pytest

from scripts.build_static_site import (
    IMPORT_SCRIPTS_CALL_RE,
    JS_URL_LITERAL_RE,
    WORKER_URL_LITERAL_RE,
    build_site,
    content_digest,
    resolve_reference,
)

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def built() -> Path:
    """One real build, shared: it copies the whole data release and is slow."""
    return build_site(output=ROOT / "dist", allow_representative=True)


@pytest.fixture(scope="module")
def static_root(built: Path) -> Path:
    return built / "client" / "static"


def stamped_references(static_root: Path) -> list[tuple[Path, str, str]]:
    """Every worker-bound URL in the built tree, as (script, url, query)."""
    found: list[tuple[Path, str, str]] = []
    for script in sorted(static_root.rglob("*.js")):
        text = script.read_text(encoding="utf-8")
        segments = [match.group("args") for match in IMPORT_SCRIPTS_CALL_RE.finditer(text)]
        for segment in segments:
            for match in JS_URL_LITERAL_RE.finditer(segment):
                found.append((script, match.group("url"), match.group(0)))
        for match in WORKER_URL_LITERAL_RE.finditer(text):
            found.append((script, match.group("url"), match.group(0)))
    return found


def test_every_worker_bound_url_is_stamped(static_root: Path) -> None:
    """No importScripts target and no worker URL may ship without a digest."""
    references = stamped_references(static_root)
    assert references, "expected the built tree to contain worker references"

    bare = [
        f"{script.relative_to(static_root)} -> {url}"
        for script, url, literal in references
        if "?v=" not in literal
    ]
    assert bare == [], f"these load without a cache-busting digest: {bare}"


def test_each_digest_identifies_the_file_it_points_at(static_root: Path) -> None:
    """A digest of the wrong bytes is worse than none -- it looks correct.

    Checked against the file as built rather than as authored, because the
    workers are themselves rewritten during the build; digesting the source
    would pass here and still ship a marker for content that does not exist.
    """
    mismatched: list[str] = []
    for script, url, literal in stamped_references(static_root):
        target = resolve_reference(url, script, static_root)
        assert target is not None, f"{script.name} names {url}, which was not built"
        expected = f"?v={content_digest(target)}"
        if expected not in literal:
            mismatched.append(f"{script.relative_to(static_root)} -> {literal}")
    assert mismatched == [], f"these carry a digest of different bytes: {mismatched}"


def test_the_solver_worker_and_its_core_are_covered(static_root: Path) -> None:
    """Named explicitly because the solver is the one worker with no runtime/ import.

    A fix to solver-core.js reached the main thread and not the worker for the
    same reason as the degree planner, and a rule written only around
    static/js/runtime/ would leave it out.
    """
    worker = (static_root / "js" / "solver-worker.js").read_text(encoding="utf-8")
    core = content_digest(static_root / "js" / "solver-core.js")
    assert f"'/static/js/solver-core.js?v={core}'" in worker

    api = (static_root / "js" / "api.js").read_text(encoding="utf-8")
    stamp = content_digest(static_root / "js" / "solver-worker.js")
    assert f"'/static/js/solver-worker.js?v={stamp}'" in api


def test_index_html_stamps_api_js_as_built(built: Path, static_root: Path) -> None:
    """The ordering check: index.html is stamped after api.js is rewritten.

    api.js's bytes change during the build, because its worker URLs are stamped.
    Stamping index.html from the source tree -- which is what the build used to
    do -- gives the main thread a digest of a file that was never deployed, so
    the marker changes on a deploy that did not change api.js and stays put on
    one that did.
    """
    index = (built / "client" / "index.html").read_text(encoding="utf-8")
    digest = content_digest(static_root / "js" / "api.js")
    assert f'src="/static/js/api.js?v={digest}"' in index

    source_digest = content_digest(ROOT / "static" / "js" / "api.js")
    assert source_digest != digest, (
        "api.js should differ between source and dist now that its worker URLs "
        "are rewritten; if it does not, this test has stopped proving the order"
    )


def test_a_changed_runtime_file_changes_the_url_that_loads_it(tmp_path: Path) -> None:
    """The actual property: a changed file must produce a changed URL.

    Everything else here checks the digests are internally consistent, which a
    build that stamped a constant would also satisfy. This is the one that fails
    if the stamping stops following the bytes -- which is the only reason it
    exists.
    """
    source = tmp_path / "static"
    shutil.copytree(ROOT / "static", source, symlinks=True)

    def planner_import(output: Path) -> str:
        worker = output / "client" / "static" / "js" / "workers" / "degree-planner-worker.js"
        match = re.search(
            r"\.\./runtime/degree-planner\.js\?v=([a-f0-9]+)",
            worker.read_text(encoding="utf-8"),
        )
        assert match, "the degree planner worker should import a stamped runtime"
        return match.group(1)

    before = planner_import(build_site(source, tmp_path / "before", allow_representative=True))

    runtime = source / "js" / "runtime" / "degree-planner.js"
    runtime.write_text(runtime.read_text(encoding="utf-8") + "\n", encoding="utf-8")

    after = planner_import(build_site(source, tmp_path / "after", allow_representative=True))
    assert before != after, (
        "degree-planner.js changed but the worker would request the same URL, so "
        "the browser serves the previous build's copy for the full cache hour"
    )


# Anything that is not twelve lowercase hex digits was typed by a person. The
# build's markers are exactly that, so this catches a hand-written date coming
# back without banning the mechanism that replaced it.
HAND_WRITTEN_MARKER_RE = re.compile(r"""\?v=(?!\$\{)(?!v=)([^'"`\s&]*)""")


def test_no_hand_written_version_markers_survive(static_root: Path) -> None:
    """Only build-generated digests may ship.

    Two hand-written ``?v=20260718`` markers used to sit in transcript-worker.js
    and api.js. Nobody bumped them, which is the whole problem with writing them
    by hand -- and leaving one in place invites the next person to bump it
    instead of trusting the build. Template interpolations are excluded: the
    embedding fetches version themselves from the data manifest at runtime.
    """
    offenders: list[str] = []
    for script in sorted(static_root.rglob("*.js")):
        for match in HAND_WRITTEN_MARKER_RE.finditer(script.read_text(encoding="utf-8")):
            marker = match.group(1)
            if not re.fullmatch(r"[a-f0-9]{12}", marker):
                offenders.append(f"{script.relative_to(static_root)}: ?v={marker}")
    assert offenders == [], f"hand-written version markers shipped: {offenders}"


def test_source_carries_no_hand_written_markers() -> None:
    """Caught in the source too, so review sees it before a build does."""
    offenders: list[str] = []
    for script in sorted((ROOT / "static" / "js").rglob("*.js")):
        for match in HAND_WRITTEN_MARKER_RE.finditer(script.read_text(encoding="utf-8")):
            offenders.append(f"{script.relative_to(ROOT)}: ?v={match.group(1)}")
    assert offenders == [], (
        f"the build supplies version markers; do not write them by hand: {offenders}"
    )

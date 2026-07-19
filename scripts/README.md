# Build scripts

Offline tooling that turns raw University sources into a published static release.
None of it ships — `build_static_site.py` refuses to copy `.py`, `.pyc`, `.db`, or
`.sqlite` into `dist/` at all.

Run everything through `uv` from the repository root, so relative default paths resolve:

```bash
uv run python scripts/<name>.py --help
```

> The directory name is load-bearing. `from scripts.X import Y` appears in eight
> modules and in the tests, resolved through `scripts/__init__.py`. Renaming the
> directory breaks all of them.

For the full architecture, the schema contract, and Banner field notes, see
[`docs/manual.html`](../docs/manual.html).

## Pipeline order

Stages 1-13 are independent and can be re-run in isolation. Stage 14 consumes their
output, and stage 15 packages it.

| # | Script | Reads | Writes |
|---|--------|-------|--------|
| 1 | `../src/scrape_courses.py` | Bulletin API | `data/generated/course_data.json` |
| 2 | `../src/build_embeddings.py` | `course_data.json` | `static/data/{phrase,course}_embeddings.json`, `pca_params.json` |
| 3 | `build_carolina_core_catalog.py` | Bulletin page or `--input-html` | `static/data/carolina_core_courses.json` |
| 4 | `sync_campus_buildings.py` | Concept3D API | `static/data/campus_buildings.json` |
| 5 | `../src/grade_pipeline.py` | `data/raw/registrar_grades/`, Banner | `data/generated/grade_analytics.json`, and populates `data/grade_matching_cache.sqlite` |
| 6 | `pull_banner_term_sections.py` | Banner | `<--output-dir>/<term>.json` |
| 7 | `import_major_maps.py` | USC major-map repository | `data/curated/major_maps/` |
| 8 | `download_major_map_pdfs.py` | `data/curated/major_maps` | `data/raw/major_map_pdfs/` + `manifest.json` |
| 9 | `materialize_llm_major_maps.py` | schema, PDF manifest, curated rows | `data/interim/major_maps_llm/` |
| 10 | `normalize_llm_major_maps.py` | `data/interim/major_maps_llm/` | rewrites in place |
| 11 | `validate_llm_major_maps.py` | interim tier, schema, manifest | stdout; exit 1 on error |
| 12 | `normalize_major_maps.py` | `data/curated/major_maps` | `--report` |
| 13 | `validate_major_maps.py` | maps dir + active manifest | `--json-output` |
| 14 | `build_static_release.py` | everything above | `static/data/releases/<id>/` + `manifest.json` |
| 15 | `build_static_site.py` | `static/` | `dist/client/` + `dist/server/` |

\* Stages 9-11 build a second extraction tier in `data/interim/`. That tier was never
converted into `data/curated/` and its committed data has been removed, so these stages
are currently dormant. The scripts are kept because they can regenerate it. See
[TODO.md](../TODO.md).

## Libraries, not entry points

`static_release.py` has no `__main__`. It holds the integrity primitives every release
path shares: `canonical_json_bytes()` for reproducible digests, `sha256_bytes()`,
`write_immutable_json()` which content-addresses the filename, `verify_artifact()`,
and `write_manifest_atomic()`. Seven scripts and two test modules import it.

`build_catalog_shards.py`, `build_grade_shards.py`, and `build_offering_history.py` are
dual-purpose. Each runs standalone, but stage 14 *imports* them and calls them directly
in-process rather than shelling out.

## Things that will surprise you

**Stage 14 is one in-process step.** `build_static_release.py` imports the shard builders
as functions. There is no subprocess orchestration, so a traceback from inside a shard
builder surfaces as a release-build failure.

**`--history-cache` and `--term-dir` are mutually exclusive, and one is required.** Stage 14
needs section history from exactly one of them.

**`data/grade_matching_cache.sqlite` is gitignored but is the default stage-14 input.** A
fresh clone cannot reproduce a full release. Either re-run stage 5, which rebuilds the
cache as a side effect, or bypass it with stage 6 and `--term-dir`. Both need network
access. This is the project's one real reproducibility gap.

**`load_major_maps` globs recursively.** Point `--maps-dir` at `data/curated/major_maps`,
never at a parent that also contains `data/interim/major_maps_llm` — both tiers carry the
same map ids and the loader raises on duplicates. The defaults are correct; this only bites
when overriding them.

**`build_data_manifest.py` is not part of stage 14.** The manifest is written inline by the
release scripts. This is a standalone recovery path that rescans an existing release tree,
and it is the one script here nothing else calls.

**The relay worker is ordinary JavaScript.** It lives in `server/index.js` and
`build_static_site.py` copies it verbatim into `dist/server/`, alongside a generated
`package.json` and `wrangler.json`. Edit it directly. `node server/dev-server.js` hosts it
on plain Node for local testing, and `tests/test_sites_relay_worker.js` builds and imports
the emitted copy.

**External binaries.** `import_major_maps.py` and `materialize_llm_major_maps.py` need
`pdftotext`; `download_major_map_pdfs.py` needs `pdfinfo`. Both come from Poppler.

**Banner rate limits are real.** The pullers use 2 threads per term, 8 concurrent page
fetches within a term, and exponential backoff. `pull_banner_term_sections.py` treats the
response envelope as a trust boundary and refuses to write a term unless every count
reconciles, because Banner returns short pages rather than errors.

## Validation gates

Nothing reaches a release unvalidated. `materialize_llm_major_maps.py` raises on PDF
SHA-256 mismatch, so a record cannot drift from the document it describes.
`validate_llm_major_maps.py --require-complete` checks every file against both the schema
and the source manifest. `validate_major_maps.py` cross-checks course codes against the
active catalog. `build_static_site.py` independently re-verifies every manifest artifact's
byte count and digest before building, and re-scans the staging tree for forbidden file
types before the atomic swap.

Public grade aggregates below ten counted grades are suppressed in `build_grade_shards.py`.

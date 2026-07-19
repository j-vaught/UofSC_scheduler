# TODO

Working notes. Long-form architecture and known issues live in
[docs/manual.html](docs/manual.html); this file is for what to do next.

## Major maps — needs rework

**The current implementation is not correct.** Details to be filled in.

<!-- Describe the problem here. -->

Context that may be relevant when picking this up:

- The shipped major maps come from `data/curated/major_maps/` (1,295 records). That
  is the only tier the release build reads.
- A second extraction tier existed at `data/interim/major_maps_llm/` and has been
  removed. All 1,295 of its records carried a `footnotes` field; none of the curated
  records do. The two tiers use **incompatible schemas**, and no script ever converted
  one into the other, so that work never reached the site.
- The active release is still named `major-maps-20260718-footnotes`, which describes
  that unlanded work rather than what actually shipped. Rename it on the next release.
- The toolchain that produced the interim tier is intact and can regenerate it:
  `scripts/materialize_llm_major_maps.py`, `normalize_llm_major_maps.py`,
  `validate_llm_major_maps.py`, validating against
  `schemas/major_map_llm_v1.schema.json`. Regenerating costs a full model pass over
  1,295 PDFs.
- `data/generated/major_maps_manifest.json` reports 1,292 of 1,295 maps as
  `needs_review`. That is deliberate: unresolved choice wording and footnote
  dependencies are not presented as authoritative degree-audit logic.
- `planner.py` had a local map loader that did a flat `os.listdir` over a directory
  that has been catalog-year nested for some time, so it silently found nothing. That
  module is gone now, but the same assumption may exist elsewhere.

## Interface

- **Site name.** "Course Scheduler" is a placeholder. Pick something with an identity.
- Term dropdown offers nine terms, but Banner only has schedules through Fall 2026.
  The six future terms return zero live sections and render as "live availability
  unavailable", which is indistinguishable from an outage. Either filter the list to
  terms Banner knows about, label them as not yet published, or use a distinct message.
- Section status dots, the plan navigator with a typeable index, and the compact
  My Courses strip are all specified in the manual's roadmap but unbuilt.

## Deployment

- The live site currently returns **no `Content-Security-Policy`** and no
  `x-scheduler-relay` header on the HTML, so the document is not passing through the
  worker. The relay's `/api/*` routes do work. Two CSP bugs were fixed on the strength
  of local testing; the next deploy is the first time those headers actually apply, so
  watch the first load.
- `data/grade_matching_cache.sqlite` is gitignored but is the default history input to
  the release build, so a fresh clone cannot reproduce a full release. Either commit it
  or document the rebuild path.

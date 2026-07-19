# TODO

Working notes. Long-form architecture and known issues live in
[docs/manual.html](docs/manual.html); this file is for what to do next.

## Major maps — needs rework

**The current implementation is not correct.** Root cause diagnosed 2026-07-19 by
walking Electrical Engineering 2026-2027 through the wizard in a browser.

**Symptom.** Generating that plan reports *"Could not place 10 course(s): CHEM 111,
ELCT 221, ELCT 222, ELCT 363, ELCT 321, ELCT 331, ELCT 371, ELCT 302, ELCT 403,
ELCT 404"* and yields 96 of 126 credits. Roughly a quarter of the degree silently
vanishes, including most of the major core.

**Cause.** Two deliberate behaviours combine badly, and each is protected by its own
test, so neither is a bug on its own.

1. `Prereqs.enrichMajorMap` (`static/js/prereqs.js`) replaces the curated map's
   prerequisites with ones scraped from bulletin prose. Bulletin text describes a
   course for *every* student who might take it, so it names courses this degree
   never includes: `CHEM 111` gains `MATH 111 or MATH 115`, `ELCT 221` gains
   `ELCT 220`. Asserted by `tests/test_degree_wizard.js:49`.
2. The planner treats an unmet prerequisite as a hard block and refuses to place the
   course, which is correct — inventing satisfied prerequisites would produce
   schedules a student cannot register for. Asserted by
   `tests/test_browser_runtime_parity.js:83`, *"planner does not silently discard
   prerequisites outside the remaining degree map"*.

Together: enrichment injects a prerequisite that cannot be satisfied inside the
degree, the planner correctly refuses, and everything downstream of that course
cascades. `ELCT 220` alone takes out most of the ELCT chain.

Verified directly: the **raw** curated map plans to a clean 126 credits with zero
unplaced courses under every strategy and every catalog year tested. Only the
**enriched** map fails. The curated data is fine; the enrichment step is what breaks
it.

**Why it is not yet fixed.** Two fixes were attempted and both were reverted because
each violated one of the invariants above. Making the planner ignore out-of-degree
prerequisites broke the parity test and would let it emit unregistrable plans. Making
enrichment drop out-of-degree groups broke the wizard test. The resolution is a
product decision, not a patch:

- Distinguish a *placement alternative* (MATH 112/115/116 before MATH 141 — the
  student placed past it) from a *genuine missing requirement* (ELCT 220). These are
  structurally identical today. `Prereqs.trailingRequirementAlternatives` already
  detects "or placement exam" prose, which is a possible seam.
- Or let a student mark a prerequisite as satisfied by placement or transfer, which
  turns a dead end into a question.
- Or treat the curated map as authoritative for planning and surface bulletin
  prerequisites as advisory notes rather than blockers.

Whichever is chosen, the planner should keep refusing to invent satisfied
prerequisites. The failure mode to fix is that the student is given no way forward,
not that the planner is too strict.

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

## Known noise

- **Transformers.js triggers four `script-src: eval` CSP violations per model load.**
  Surfaced by the `securitypolicyviolation` handler added with boot supervision. They
  fire between "Loading Transformers.js model" and "Model loaded", so the ONNX runtime
  probes an `eval` path, is refused, and falls back to something permitted. Semantic
  search works, so this is non-fatal. It is worth resolving anyway: four violations on
  every load is exactly the noise that hides a real one, which is how the two genuine
  CSP faults went unnoticed. Either narrow the policy to admit what the runtime
  actually needs, or filter these specific violations from the handler so a real block
  still stands out. Do not add `'unsafe-eval'`; that would defeat the policy.

## Deployment

- The live site currently returns **no `Content-Security-Policy`** and no
  `x-scheduler-relay` header on the HTML, so the document is not passing through the
  worker. The relay's `/api/*` routes do work. Two CSP bugs were fixed on the strength
  of local testing; the next deploy is the first time those headers actually apply, so
  watch the first load.
- `data/grade_matching_cache.sqlite` is gitignored but is the default history input to
  the release build, so a fresh clone cannot reproduce a full release. Either commit it
  or document the rebuild path.

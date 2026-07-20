# TODO

Working notes. Long-form architecture and known issues live in
[docs/manual.html](docs/manual.html); this file is for what to do next.

## Major maps — mostly fixed, one cause left

Rediagnosed 2026-07-20 against the live bulletin (`srcdb 2026`). **The earlier
entry here was wrong** and has been deleted. It blamed "bulletin prose names
courses outside your degree" and cited `ELCT 220` as a genuine missing
requirement that the planner was right to refuse. `ELCT 220` is not a
requirement of anything. It is an *alternative*, and the parser was misreading
the sentence. There was no product decision to make; there were parser bugs.

**Measured on Electrical Engineering 2026-2027**, enriched from the live
bulletin and planned with `strategy: major_map`:

| | unplaced | planned credits |
|---|---|---|
| before | 16 | 80 of 126 |
| after | 3 | 117 of 126 |

(The older note recorded 10 unplaced / 96 credits for what is presumably a
warmer or partially-enriched cache. Either way both causes below were real and
both are now fixed.)

**Cause 1 — a repeated grade qualifier broke every OR chain.** ELCT 221 reads,
verbatim:

> Prerequisites: C or better in MATH 142; C or better in either ELCT 102 or
> AESP 265 or D or better in ELCT 220.

`parsePrereqGroups` tested for a repeated grade phrase *before* it tested for an
explicit `or`, so the "D or better" riding on that last `or` won, and ELCT 220
became a third mandatory group instead of a third alternative. ELCT 221 was then
blocked despite ELCT 102 being in the degree, and 222/321/331/363/371/302/403/404
cascaded behind it. Fixed by correcting the precedence: an explicit connector in
the grade-stripped text decides, and a repeated grade only means "and" when
nothing else connects the two codes ("D or better in ENCP 200 D or better in
PHYS 211"), which is the case that test was written for and still passes.

**Cause 2 — "or higher" was silently dropped.** "C or better in MATH 111 or
higher" parsed to a literal `MATH 111`, so a student holding MATH 141 was judged
ineligible. Groups now carry a course-number floor,
`{ courses, type: 'at-least', subject, minNumber }`, satisfied by any completed
course in the same subject at or above the floor. No cross-subject equivalence is
inferred, because the phrasing does not claim any. This also closes the separate
"or higher" entry that used to live further down this file: CSCE 146 with CSCE 145
and MATH 141 now evaluates eligible, and the "I can take" search filter reads the
same evaluator, so it stops hiding courses too.

**Also added:** a course placed on a condition nobody verified (the "or placement
exam" prose) now produces a `warning` naming it. That placement was already
correct behaviour — refusing would strand a student who really did place past the
prerequisite — but nothing told the student they had a placement test to pass.

**What remains — one cause, 3 courses.** The last unplaced courses on EE are
`CSCE 106`, `CSCE 212`, `CSCE 313`, and it is a *different* bug, not a residue of
the two above. `enrichMajorMap` flattens both corequisite groups and
prerequisite-or-corequisite groups into one `corequisites` array, but only writes
`corequisite_groups` when there was genuine corequisite text. When a course has
only *prerequisite-or-corequisite* prose, `corequisite_groups` stays unset, so
`corequisiteGroupsForCourse` falls through to its flat-array compatibility path
and re-adds the same requirement as one mandatory AND group per course — on top of
the correctly-parsed either-group. CSCE 106 reads "C or better in MATH 111 or
higher (or by Math Placement Test score into MATH 115 or higher math)" and comes
out demanding MATH 111 *and* MATH 115, neither of which is in an EE map. CSCE 212
needs CSCE 145 or CSCE 106 and EE has neither once 106 is blocked; CSCE 313 needs
CSCE 212.

Confirmed by neutralising only that fallback in a probe: EE then plans a clean
**126 of 126 with zero unplaced**. Left unfixed deliberately — it is a change to
corequisite handling with its own blast radius and deserves its own commit and
test, not a rider on a prerequisite fix. The fix is probably for enrichment to
write `corequisite_groups: []` explicitly when it has parsed the prose and found
no corequisite groups, so the compatibility path is not entered for a course that
has already been normalized.

Still true and worth keeping: the planner should keep refusing to invent satisfied
prerequisites, and the **raw** curated map plans to a clean 126 credits. The
curated data is fine.

Also worth knowing: `groupIsMet` and the group evaluator are **duplicated**
between `static/js/features/prereqs/index.js` and
`static/js/runtime/degree-planner.js`, because neither can import the other.
`tests/test_browser_runtime_parity.js` now feeds every group type the parser can
emit to both and compares, so a type added to one side and not the other fails
there. Unifying them is a separate change.

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

## Search result cards can hang on "Loading course summary"

Reproduced on a cold load: searching `CSCE 145` renders the card with live
section counts, but the historical-GPA line stays on "Loading course summary"
indefinitely. The relay log shows the catalog shard fetched and **no grades shard
requested at all**, so the lookup never starts rather than failing. Present on
`main` before the error-taxonomy work, so it is not a regression from it.

It resolves once the course detail has been opened at least once, which suggests
the card summary depends on a prefetch or cache warm that does not fire from a
plain search. Worth fixing because the stuck state is indistinguishable from slow
loading, and because the taxonomy added in `static/js/errors.js` cannot help a
request that is never made.

Amended after a later observation: on a warm cache it is slow rather than stuck.
Searching `MATH 142` sat on the placeholder for roughly ten seconds and then
filled in normally (`2.79 historical GPA / 7,370 grades`). So there are probably
two behaviours filed here as one, and "indefinitely" is only established for the
cold path. Whoever picks this up should time the cold case before assuming it
never completes -- the fix for a ten-second wait is a different fix.

## Prerequisite "or higher" — fixed 2026-07-20

Resolved by the `at-least` group type described under *Major maps* above. The
option chosen was satisfied-if-any-course-in-subject-at-or-above-N; the two
alternatives considered were a curated per-subject ordering and treating the
phrase as merely `uncertain`. The wrong answer this choice can still give is a
subject that renumbers its curriculum without renumbering upward, so if a
subject is ever found where a higher number is not a later course, that is the
case to revisit. Cross-subject equivalence is deliberately not inferred.

## Custom major maps are shared across device-local accounts

Plans route their storage key through `Keyspace`, so two students on one machine
keep separate schedules and coursework. Custom major maps do not: they use a bare
`uosc-custom-major-maps-v1` key, so every account on the device sees and can
delete the same ones. Surfaced by fencing the feature, which made the storage
access explicit instead of an ambient `localStorage` call.

Not fixed with the fence, deliberately. Routing the key through `Keyspace` orphans
every map already saved on a real device -- the data stays in storage under the
old key and simply stops being found, which looks like deletion to the student.
It needs a migration that reads the bare key once, writes it into the active
account, and leaves the original in place until it is known to be safe.

The seam is now local: `readMaps`/`writeMaps` in `static/js/custom-major-map.js`
are the only two places that touch storage. `tests/test_feature_custom_major_map.js`
asserts the current device-wide behaviour, so whoever changes it has to update
that test on purpose rather than discover it.

Worth checking whether anything else writes a bare key. As of this note the only
`Keyspace` caller in `static/js` is `state.js`.

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

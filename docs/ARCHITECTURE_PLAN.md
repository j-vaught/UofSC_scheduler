# Static Kernel + Fenced Slices

*A rewrite of the merged plan, after reading the repository.*

---

## 0. What changed from the draft, and why

**Corrected facts.** I verified every file:line claim. Most held. These did not:

| Draft claim | Verified reality |
|---|---|
| "31 classic scripts" | **28** `<script>` tags in `static/index.html` |
| "237 JS assertions" | README and `docs/manual.html` both say **230 pass** |
| "~640 `assert.match`, ~228 on source text" | **547** `assert.match`, **273** on source text |
| "reads `search.js` at 20 sites, `scheduler.js` at 12" | **56** and **43**. Also `map.js` 20, `grades.js` 11, `api.js` 11 |
| relay route `/api/relay/search` | Routes are **`/api/search`, `/api/details`, `/api/faculty`** (`server/index.js:11,15,19`) |
| "7 of api.js's 10 route strings have no relay route" | **13 distinct** route strings in `api.js`; **10** have no relay route |
| `State._restore()` at `state.js:559` | **`state.js:558`** |
| `exportToJSON` omits "`avoidedTimeBlocks`, three `*Required` booleans, and all three solver weights" | Omits exactly **four** fields: `avoidedTimeBlocks`, `timePreferencesRequired`, `walkingBufferRequired`, `avoidedDaysRequired`. There are no solver weights in `savePlan` either |
| "`transcript-upload-dialog.js:592-594` dispatches eight `CustomEvent`s with zero subscribers" | Two different mechanisms. `this.emit()` fires **8** events (`:opened :closed :file-selected :progress :review :error :applied :undone`) with genuinely zero subscribers. But `:selected` (line 327) and `:confirmed` (line 403) are `cancelable: true` and the code branches on the return of `dispatchEvent` — that is a deliberate optional-listener protocol, not an orphan |

**The draft's phase 1 breaks the test suite.** This is the most important finding. The draft says phase 1 lifts `AppModal` out of `boot.js` into `modal.js` with "existing suite untouched." It cannot. `tests/test_scheduler_frontend.js:903-912` asserts six regexes against `html + bootSource()`, where `bootSource()` reads *only* `static/js/boot.js` — including `/window\.AppModal = \{/` and `/modalOverlay\.addEventListener\('click'/`. Move the code, those six fail. `tests/test_csp_inline_scripts.js:60-66` additionally pins `boot.js` structure and pins `<script src="/static/js/boot.js"></script>` verbatim in `index.html`. Phase 1 is now specified with the exact test edits it requires, rather than claiming it needs none.

**I cut roughly half the framework.** The draft proposes, for a solo maintainer on a 15.5k-line no-dependency static site: a JSON-Schema validator, a capability projection, three bus primitives including slots, ten feature folders each with a manifest plus a checked-in contract JSON, topological sort with cycle detection, per-slice snapshot migrations dispatched over the bus, a tree-copying deletion test, HTTP contract-version negotiation with 409 responses, a headless-Chrome smoke runner, and a twelve-phase migration estimated at 6–12 months. That will not be finished. A half-built framework over a half-migrated tree is strictly worse than today. Cut: `schema.js`, `capabilities.js`, slots, per-feature contract JSON, the topological sort, `check_slice_deletion.py`, `X-Wire-Contract` negotiation, `modulepreload` emission, headless Chrome. Kept: everything that pays for itself in the first month.

**Constraint drift I found and fixed.** The draft's 409 → *"This page is out of date — reload to continue"* notice is **new user-facing functionality**, which constraint 3 forbids. So is its `bus.send('search.retry')` Retry button. Both are removed. The draft was right to delete CSP `report-to` under constraint 1; I kept that.

**The test tax is restructured, not paid up front.** The draft's phase 3 is "3–6 weeks, unglamorous, produces nothing a user can see" — and correctly identifies it as the phase a solo maintainer abandons. It does not need to be one phase. Build the harness once (two days), then migrate assertions **per file, in the phase that touches that file**. Of the 11 test sites reading `grades.js`, only 3 are source-text reads; 8 already go through `loadObject` and are nearly behavioural. The cliff was an artifact of batching.

---

## 1. The shape in one page

**A platform layer, a small kernel, and feature modules that boot from one array.**

Three ideas, down from the draft's three-plus-a-framework.

**One: upstream vocabulary stops at `platform/university/`.** Domain types (`Section`, `Course`, `Term`, `CatalogQuery`) in, versioned wire codecs out. `tools/contracts/wire/fose-v1.json` is read by the browser codec, by the relay's body validator, and by the Python pipeline. One edit, three consumers, one test asserting agreement. This is constraint 6 and it is the highest-value item in the plan.

**Two: features are factories in one array, not a framework.** A feature is `createX(ctx) -> {start, stop}`. `boot.js` holds one array of them and starts each in its own try/catch. Features talk through a bus with exactly two primitives — `publish/subscribe` and `handle/send`. Declarations are a plain object literal exported from the module. No manifest files, no per-feature contract JSON, no slots, no schema validator, no topological sort. One runtime wiring test walks the started registry and asserts every `send` target has a handler.

**Three: native ESM, relative specifiers only.** No bundler, no import map. An import map must be inline; inline scripts are what the CSP blocked this session. Node imports the same files unchanged, which is what makes the agentic seam nearly free.

Accounts are a key-prefix decorator over storage plus feature restart. No server records, no vault, no sign-in UI.

Errors get one frozen code table and one rule: only codes in the `NOT_FOUND` family may render as "this does not exist."

---

## 2. Module map

Each line: what it OWNS / what it may NEVER touch.

```
static/js/
  boot.js                  OWNS: the feature array, per-feature try/catch, top-level error
                           handlers, the explicit State._restore() call. NEVER: feature
                           internals. The ONLY <script type="module"> in index.html.
  modal.js                 OWNS: the single modal path (lifted from boot.js:99-180).

  platform/kernel/
    bus.js                 OWNS: publish/subscribe, handle/send, per-subscriber try/catch,
                           unsubscribe fns, declared(). NEVER: DOM, storage, fetch.
    errors.js              OWNS: AppError, the frozen CODES table incl. NOT_FOUND_CODES,
                           toUserMessage(). NEVER: DOM, transport.
    logger.js              OWNS: structured owner-tagged diagnostics. NEVER: rendering.

  platform/store/
    keyspace.js            OWNS: key prefixing (`acct:<id>:` | `device:`), quota and
                           private-mode guards in ONE place. NEVER: what a key means.
    snapshot.js            OWNS: assembling per-slice subtrees into one export document.
                           NEVER: owning any slice's shape.

  platform/university/     THE FIREWALL. Returns and accepts domain types only.
    university.js          OWNS: facade methods, codec selection, live->catalog fallback,
                           provenance stamping. NEVER: DOM, storage keys, feature names.
    domain/term.js         OWNS: the Term value type. The ONLY place a term string literal
                           appears. NEVER: transport.
    domain/section.js      OWNS: Section + createSection (sole constructor; provenance
                           required). NEVER: raw upstream field names.
    domain/course.js       OWNS: Course, requirement and prereq structures.
    domain/grades.js       OWNS: GradeDistribution.
    domain/query.js        OWNS: CatalogQuery, the request-side domain type.
    wire/fose-v1.js        OWNS: encode(CatalogQuery)->body, decode(raw)->domain, probe().
    wire/bulletin-v1.js    OWNS: the bulletin codec.
    wire/catalog-v1.js     OWNS: static-release artifacts -> the SAME domain types.
    transport/relay-client.js     OWNS: same-origin POST, retry, timeout, AbortSignal.
    transport/bulletin-client.js  OWNS: the one cross-origin fetch.
    transport/artifact-store.js   OWNS: content-addressed artifacts, IndexedDB,
                           CacheStorage, SHA-256. (today's data-store.js, moved intact)

  platform/compute/        Pure. No DOM, no storage, no bus. Node-importable as-is.
    solver.js  offering.js  transcript.js  degree-planner.js  carolina-core.js
    worker-host.js         OWNS: the single RPC envelope for all workers + inline fallback.
    workers/*.js           OWNS: thin adapters. Relative imports only.

  platform/ui/
    notices.js             OWNS: the aria-live region at index.html:41.
    dom.js                 OWNS: scoped queries bound to a feature's root element.

  features/<id>/           Eight, not ten: search, schedule, degree-plan, grades,
                           transcript, profile, history, map.
    index.js               OWNS: `export const declares = {...}` and
                           `export function create(ctx) -> {start, stop}`.
    model.js               OWNS: state + logic. NEVER: document, localStorage, fetch.
    view.js                OWNS: DOM inside its root. NEVER: querying outside it.
    store.js               OWNS: this slice's key names, scope decision, snapshot version.

server/index.js            OWNS: the 3 read-only relay routes (/api/search, /api/details,
                           /api/faculty), body validation GENERATED from
                           tools/contracts/wire/fose-v1.json, same-origin only.
                           NEVER: sessions, users, credentials, auth headers.
contracts/wire/*.json      OWNS: the machine-readable upstream contract. Three consumers.
tools/build_static_site.py  OWNS: release stamping, retention, digest verification,
                           CSP emission + self-test.
```

**What is deliberately absent:** `schema.js`, `capabilities.js`, `slots.js`, `registry.js`, `contracts/features/*.json`, `platform/store/account.js` before phase 7. Each was in the draft; each costs more to maintain than it returns at this scale.

**Eight features, not ten.** The draft's `export` (211 lines) and `prereqs` (484 lines) are not peers of `search` (4,073). `export` folds into `schedule`; `prereqs` folds into `search`, which is its only consumer. `custom-major-map` folds into `profile` — `custom-major-map.js:392-393` mutates `Profile.majorMaps` in place and then calls `Profile.populateProgramSelect()` to repair the DOM, so they are one module that has been split by filename only.

---

## 3. Interfaces

### Bus — two primitives

```js
// platform/kernel/bus.js
export function createBus({ logger });

/**
 * subscribe(topic, handler, {owner}) -> unsubscribe: () => void
 *   Handler throws are caught, logged {topic, owner}, and never abort remaining
 *   subscribers. Direct fix for state.js:65's bare
 *   `(this._listeners[event] || []).forEach(fn => fn(data))`.
 *
 * publish(topic, payload) -> void       Never throws.
 * handle(command, handler, {owner}) -> unregister    Throws DUPLICATE_HANDLER.
 * send(command, input, {signal}) -> Promise<unknown>
 *   Rejects AppError(CODES.NO_HANDLER, {command}) when unregistered.
 * declared() -> {topics: [{name, owner}], commands: [{name, owner}]}
 */
```

**On topic payload schemas.** The critics were right that undeclared payloads are undeclared coupling. They were wrong that a JSON-Schema subset is the answer here. A hand-rolled validator is ~140 lines of code a solo maintainer must debug, running on every publish, to catch a class of bug that a JSDoc typedef plus one round-trip test catches at a fraction of the cost. The rule instead: **every topic's payload is a named typedef in the publishing feature's `index.js`, referenced from `declares.topics`, and asserted by one test per topic that publishes a fixture and checks what the subscriber receives.** That is a real declared interface. It is checkable. It does not require shipping a validator.

### Feature module

```js
// features/grades/index.js
import { createModel } from './model.js';

export const declares = {
  sends:      ['search.showDetail'],
  handles:    ['grades.forCourse', 'grades.forProfessor'],
  publishes:  ['grades:loaded'],   // @typedef {{code: string, source: 'live'|'catalog'}}
  subscribes: ['term:changed'],
};

export function create(ctx) {          // NEW instance per call. No module state.
  const offs = [];
  return {
    async start() {
      const model = createModel(ctx);
      offs.push(ctx.bus.handle('grades.forCourse', q => model.forCourse(q), {owner: 'grades'}));
      offs.push(ctx.bus.handle('grades.forProfessor', q => model.forProfessor(q), {owner: 'grades'}));
      if (ctx.root) {
        const { createView } = await import('./view.js');   // dynamic: never loads in Node
        offs.push(createView(ctx, model, ctx.root));
      }
    },
    async stop() { while (offs.length) offs.pop()(); },
  };
}
```

`offs` is per-instance closure state, so two interleaved lifecycles cannot share it — the defect the critics found in the draft's `this._off` singleton. `view.js` is a dynamic import guarded on `ctx.root`, so `index.js` and `model.js` are genuinely importable in bare Node.

### Boot — the whole registry

```js
// boot.js
import * as search   from './features/search/index.js';
import * as schedule from './features/schedule/index.js';
/* ...six more... */

const FEATURES = [
  { id: 'search',   mod: search,   root: '#semester-search' },
  { id: 'schedule', mod: schedule, root: '#schedule-panel' },
  /* ... */
];

const started = [], failed = [];
for (const {id, mod, root} of FEATURES) {
  try {
    const el = root ? document.querySelector(root) : null;
    if (root && !el) throw new AppError(CODES.MOUNT_MISSING, {id, root});
    const inst = mod.create(ctxFor(id, el));
    await inst.start();
    started.push({id, inst});
  } catch (error) {
    failed.push({id, error});
    logger.error('feature.start', {id, error});
  }
}
if (failed.length) notices.warn(`${failed.map(f => f.id).join(', ')} failed to load. Everything else is working.`);
```

That is the registry. Thirty lines, no topological sort, no cycle detection, no generation tokens until accounts exist. Start order is array order, and array order is reviewable. A cycle in `declares` is caught by a test, not by runtime machinery.

`ctxFor(id, el)` builds a narrowed context — a feature receives `university` only if its `declares` mentions a command that needs it.

```js
/** FeatureContext
 * { bus, logger, errors, signal, storage, deviceStorage,
 *   university?, root?: Element|null, dom?: ScopedDom }
 */
```

### University facade

```js
// platform/university/university.js
export function createUniversity({ relay, bulletin, artifacts, codecs, logger, now });

/** Every term is a Term object, never a string.
 * searchSections(query: CatalogQuery, {signal}) -> Promise<SectionPage>
 * getSectionDetail({term: Term, crn}, {signal}) -> Promise<Section>
 * getCatalogCourse({code, catalogYear})         -> Promise<Course>
 * getCourseGrades({code})                       -> Promise<GradeDistribution>
 * getProfessorGrades({name})                    -> Promise<GradeDistribution>
 * getOfferingHistory({code})                    -> Promise<OfferingHistory>
 * getFaculty({term: Term, crns})                -> Promise<Instructor[]>
 *
 * SectionPage = {sections: Section[], provenance: Provenance, warnings: DecodeWarning[]}
 */
```

```js
// platform/university/domain/term.js
export function parseTerm(raw);       // from wire OR storage OR URL
export function formatTerm(t);        // for display
export function termStorageKey(t);    // "t_2026_fall" — derived from {year, season}
export function termUrlToken(t);
export function compareTerms(a, b);
/** @typedef {{id: string, year: number, season: 'fall'|'spring'|'summer', label: string}} Term */
```

The registrar shipping `202608` → `2026-FA` edits `parseTerm` only. `termStorageKey` is derived from `{year, season}`, so storage keys, URL tokens and saved plans are untouched. This is the single most likely upstream change and the draft's parent proposals did not contain it.

```js
// platform/university/domain/section.js
/** @typedef {{
 *   crn, courseCode, title, term: Term,
 *   status: 'open'|'closed'|'waitlist'|'unknown',
 *   seats: {available: number|null, capacity: number|null},
 *   meetings: Array<{days: Day[], startMinute, endMinute, building, room}>,
 *   instructors: Array<{name, isStaff}>, notes: string, provenance: Provenance
 * }} Section
 * @typedef {{source: 'live'|'catalog'|'mixed', fetchedAt,
 *            degraded: null | {code, retriable, upstreamStatus}}} Provenance */
export function createSection(fields);   // sole constructor; provenance is REQUIRED
```

### The shared wire contract

```jsonc
// tools/contracts/wire/fose-v1.json — one source of truth, three consumers
{
  "version": "fose-1",
  "routes": {
    "search":  { "path": "/api/search",
                 "requestCriteria": ["subject", "crse", "keyword", "crn", "srcdb"],
                 "maxValueLength": 120,
                 "responseGuard": {"results": "array"} },
    "details": { "path": "/api/details", "requestKeys": ["crn", "srcdb"] },
    "faculty": { "path": "/api/faculty", "requestKeys": ["term", "crns"] }
  },
  "fields": { "stat": {"open": ["A"]}, "seats": {"kind": "html-fragment"} }
}
```

Paths and the 120-character limit are transcribed from the real relay (`server/index.js:11-19,67-112`), not invented. Consumed by `wire/fose-v1.js`, by `server/index.js` (`validateSearchPayload` generated from `requestCriteria` + `maxValueLength`), and by `tools/lib/wire_contract.py`.

**No contract-version negotiation.** The draft's `X-Wire-Contract` header with 409 responses and a "reload to continue" banner is cut: the banner is new user-facing functionality (constraint 3), and the skew it defends against is cheaply handled instead by having the relay's generated validator accept the **union** of every contract JSON present in `contracts/wire/`. Old cached clients keep working until their contract file is deleted, which is a deliberate act with a retention policy attached. Zero protocol, zero UI, same outcome.

### Storage

```js
// platform/store/keyspace.js
export function createKeyspace({ storage });
// -> { rebind(scope), namespace(featureId) -> {get, set, remove, keys, clear} }

// platform/store/snapshot.js
export function serialize(slices) -> {format: 2, slices: {[id]: {v, data}}};
export function restore(slices, doc) -> {applied: string[], warnings: []};
```

Versions are **per slice** (`{v, data}` per subtree, migrations owned by each `features/<id>/store.js`), not one global `SCHEMA_VERSION`. Deleting a feature folder leaves an orphan subtree that `restore` skips with a warning.

---

## 4. Errors — as specific as the module map

### The code table

`platform/kernel/errors.js` exports one frozen table. Every code carries a family, a retriable flag, and a message template. Nothing constructs an ad-hoc `Error` at a boundary.

| Code | Family | Retriable | Rendered as |
|---|---|---|---|
| `STATIC_GRADES_NOT_FOUND` | NOT_FOUND | no | "No Columbia grade history is available for this course." |
| `STATIC_PROFESSOR_NOT_FOUND` | NOT_FOUND | no | "No grade history is on file for this instructor." |
| `CATALOG_COURSE_NOT_FOUND` | NOT_FOUND | no | "This course is not in the {year} catalog." |
| `MANIFEST_UNAVAILABLE` | TRANSPORT | yes | "Course data could not be loaded. Check your connection." |
| `ARTIFACT_FETCH_FAILED` | TRANSPORT | yes | "Course data could not be loaded ({status})." |
| `ARTIFACT_INTEGRITY` | INTEGRITY | yes | "Course data failed its integrity check and is being re-fetched." |
| `ARTIFACT_UNLISTED` | DATA | no | "This course is missing from the current data release." |
| `UPSTREAM_HTTP` | TRANSPORT | yes | "The university service returned an error ({status})." |
| `UPSTREAM_TIMEOUT` | TRANSPORT | yes | "The university service did not respond in time." |
| `UPSTREAM_MALFORMED` | DECODE | no | "The university service returned an unreadable response." |
| `CSP_BLOCKED` | TRANSPORT | no | "A browser security policy blocked this request." |
| `NETWORK_UNAVAILABLE` | TRANSPORT | yes | "You appear to be offline." |
| `TERM_UNPUBLISHED` | DATA | no | "{term} has not been published by the registrar yet." |
| `NO_HANDLER` | INTERNAL | no | "Something went wrong. Reload the page." |
| `DUPLICATE_HANDLER` | INTERNAL | no | (boot-time throw; never rendered) |
| `MOUNT_MISSING` | INTERNAL | no | (boot-time; feature reported in the failed list) |

```js
export const NOT_FOUND_CODES = Object.freeze(new Set([
  'STATIC_GRADES_NOT_FOUND', 'STATIC_PROFESSOR_NOT_FOUND', 'CATALOG_COURSE_NOT_FOUND',
]));
export function toUserMessage(err) {
  // May assert ABSENCE only for codes in NOT_FOUND_CODES.
  // Everything else renders the TRANSPORT/DECODE/DATA/INTEGRITY message above.
}
```

### The live bug this fixes

`static/js/grades.js:82-84`, verified:

```js
} catch (error) {
    if (loadId !== this._courseLoadId) return;
    container.innerHTML = '<p class="hint">No Columbia grade history is available for this course.</p>';
}
```

Five distinct conditions — genuine absence, manifest unavailable, artifact fetch failed, integrity mismatch, artifact unlisted — all render a confident claim that no data exists. A student may drop a course on that sentence. The same file discriminates **correctly** 278 lines later at `grades.js:360`, which tests `error?.code === 'STATIC_PROFESSOR_NOT_FOUND'` before asserting absence. The fix is to make line 82 look like line 360, mechanically, everywhere, via `toUserMessage`.

### Six conditions that become distinguishable

Today all six render identically. After: `CSP_BLOCKED`, `NETWORK_UNAVAILABLE`, `UPSTREAM_HTTP` (with status), `UPSTREAM_TIMEOUT`, `UPSTREAM_MALFORMED`, `TERM_UNPUBLISHED`.

### End to end, concretely

Relay returns 502 → `relay-client.js` raises `AppError(UPSTREAM_HTTP, {retriable: true, upstreamStatus: 502})` → `university.js` catches at its single fallback chokepoint, falls back to the static catalog, returns a `SectionPage` whose `provenance.degraded` carries the code → `features/search/view.js` renders `toUserMessage(provenance.degraded)`:

> **Live seat counts are unavailable — the university service returned an error (502). The section list below is from the most recent data release.**

The diagnostic that `api.js:218` computes and discards today survives because `provenance` is a **required** argument to `createSection` and cannot be silently dropped again. No Retry button — that would be new functionality.

### Four more swallowed failures, each becoming a declared degraded state

- `degree-plan.js:504-507` — verified. The comment is literally *"If bulletin fails, accept all from this subject (don't block the user)"*, and it flips requirement validation from allowlist to accept-everything. Becomes "Requirements could not be checked against the bulletin."
- `map.js:484-490` / `:592` — verified. The fallback route is constructed with `kind: 'estimated'` at line 487, and the label at line 592 ignores `kind` entirely, printing `${transition.walkMinutes} min route` identically for a real route and a haversine straight line times 1.2. The data is already there; the renderer discards it. Becomes "est. 7 min (straight line)".
- `scheduler.js:626-631` — verified. `credits = null` on a details lookup failure, silently under-counting the credit total.
- `data-store.js` — SHA-256 and byte-length mismatches delete and re-fetch silently. The re-fetch is correct and stays; the event now reaches the logger with a count.

### Top-level handlers

`window.onerror`, `unhandledrejection`, `securitypolicyviolation`. There are currently **zero** of any. **No `report-to`, no reporting endpoint** — that requires either a new server component (constraint 1) or a third-party collector shipping telemetry off-device, from a design whose account story is "never leaves the device." The `securitypolicyviolation` listener renders a local notice; the build-time CSP self-test (§6) is what actually catches the class.

---

## 5. Tests — as specific as the module map

### The obstacle, measured

`tests/test_scheduler_frontend.js` is **4,306 lines**, **547** `assert.match` calls, **273** of them against raw source text, **101** `readFileSync` calls and **116** `loadObject` calls. `loadObject` (lines 12-17) `vm`-executes a source file and grabs the global by name:

```js
const source = `${fs.readFileSync(path, 'utf8')}\nglobalThis.__result = ${name};`;
```

Source reads by file: `search.js` **56**, `scheduler.js` **43**, `map.js` **20**, `grades.js` **11**, `api.js` **11**, then single digits. These tests pass while the app is broken and fail on every rename.

### The fix, and why it is not one phase

Build `tests/support/harness.mjs` once — jsdom, loads the **current** `static/index.html` and the **current** 28 scripts in the current order, exposes the resulting globals. Two days. Then **migrate assertions per file, in the phase that touches that file.** The draft made this one 3–6 week phase producing nothing visible, and then correctly identified it as the phase a solo maintainer abandons. The batching was the problem, not the work.

The distribution supports this. Of the 11 `grades.js` sites, only 3 (lines 3059, 3072, 3421) are source-text reads; the other 8 already go through `loadObject` with injected dependencies and are close to behavioural already. The expensive files, `search.js` (56) and `scheduler.js` (43), are also the ones touched last.

### Five kinds of test, after

1. **Wiring** — `tests/wiring.test.mjs`. Imports every `features/*/index.js` in bare Node, starts them against a fake bus, and asserts: every name in a `sends` array has exactly one `handles` declaring it; no command is handled twice; every `subscribes` name is `publishes`ed by someone; the `sends` graph is acyclic. This catches the failure mode already live in the repo — the **8** orphan `CustomEvent`s from `transcript-upload-dialog.js`'s `emit()` helper (`:opened :closed :file-selected :progress :review :error :applied :undone`, lines 229-444) with zero subscribers anywhere. Note it must *not* flag `:selected` and `:confirmed` (lines 327, 403), which are `cancelable: true` and deliberately optional.

2. **Headless** — `tests/features/<id>/headless.test.mjs`. Imports `index.js` and `model.js` into bare Node with **no jsdom shim**. A stray `document` fails the day it is written. This is what keeps constraint 7 honest at zero cost.

3. **Topic payloads** — one test per topic. Publish a fixture, assert the subscriber's received shape field by field. This is the substitute for the draft's runtime schema validator, and it catches the same bugs at build time instead of on every publish.

4. **Codec golden files** — `tests/fixtures/wire/*.json` hold captured payloads. Assertions are field-by-field on the resulting domain objects, and `catalog-v1` must produce the *same* domain type as `fose-v1`, so the fallback path cannot diverge. Plus `tests/test_wire_contract.py`, asserting the browser codec, the relay validator and the Python pipeline all agree with `contracts/wire/*.json`.

5. **DOM ownership** — `tests/test_dom_ownership.mjs`. Static scan: no `features/*/view.js` calls `document.querySelector` or `getElementById`; all queries go through `ctx.dom`, bound to the feature's root. This replaces `test_export_wiring.js`'s id-vs-`index.html` regex, which was a bad implementation of a correct check — the check survives, the implementation does not.

### Two properties that cannot be asserted today

**Snapshot round-trip.** `state.js:373` (`savePlan`) and `state.js:477` (`exportToJSON`) are two hand-maintained serializers with **verified** field drift: `exportToJSON` omits `avoidedTimeBlocks`, `timePreferencesRequired`, `walkingBufferRequired` and `avoidedDaysRequired`, all four of which `savePlan` persists. `importFromJSON` therefore silently drops a user's advanced time blocks on every export/import round trip. No test asserts agreement. After: one test, one serializer.

**Migrations.** Every registered migration exercised against a stored fixture of the prior version.

### Survives unchanged

`test_sites_relay_worker.js` (the cleanest boundary in the repo), `test_data_store.js` with its `MemoryCache` double, `test_solver_core.js`, `test_static_api.js`, `test_browser_runtime_parity.js`, and `test_csp_inline_scripts.js` — the one case where source-text assertion is correct, because the thing under test *is* the text.

Local only: `uv run pytest` and `node --test tests/*.js`. No push-triggered runners, no gates.

---

## 6. Deployment

**ESM yes. Bundler no. Import map no.**

Relative specifiers only; `tests/test_no_bare_specifiers.mjs` enforces it. This is not stylistic. An import map must be inline, inline scripts are exactly what the CSP blocked this session, Node ignores import maps, and they do not apply inside worker realms. Forbidding bare specifiers makes one resolution scheme work in all three.

```
dist/client/
  index.html                   ← served no-cache (stated header contract)
  app/<release-id>/            ← immutable, max-age=31536000
    boot.js  platform/  features/  workers/
  contracts/wire/*.json
  data/<509 content-addressed artifacts>   ← unchanged, SHA-256 verified in-browser
dist/server/                   ← relay, unchanged in role
```

`build_static_site.py` keeps its current responsibilities (refuses `.py`/`.db`/`.sqlite`, verifies every artifact digest) and gains three:

1. **Release id** = first 12 hex of SHA-256 over the sorted per-file digest list. The script already computes those digests.
2. **Retention, K = 3.** This is the answer to the critics' strongest deployment objection: an immutable release directory 404s every module for anyone holding a cached `index.html` if the previous release is deleted. Deploy is `rsync` **without** `--delete` under `app/`, with `--delete` everywhere else. `tools/prune_releases.py` enforces K. Retention is a stated policy with a number.
3. **CSP emitted from one source and self-tested.** `tools/check_csp.py` parses the emitted policy and asserts every host the built tree actually contacts is in `connect-src`, and that no inline script exists. Both of this session's CSP outages were structurally undetectable in local development, where no CSP header exists at all. This makes them build failures. `tests/test_csp_inline_scripts.js:78-90` already encodes the required host list (`'self'`, `academicbulletins.sc.edu`, `cdn.jsdelivr.net`, `huggingface.co`, `*.hf.co`) — `check_csp.py` reads it rather than duplicating it.

**Cut from the draft:** `modulepreload` emission (premature; measure first) and `smoke_release.py` in headless Chrome (a new binary dependency for a repo that has zero frontend dependencies). The boot check runs in the jsdom harness that phase 2 builds anyway: boot `dist/client`, assert zero failed features, assert every declared root selector exists in `index.html`.

**Two load-order hazards retired.** `runtime/degree-planner.js` — verified — invokes its factory at parse time (`const api = factory(offering);`, line 4) and throws at line 10 if `OfferingAnalyzerRuntime` is absent. It works today only because `index.html` happens to load `offering-analyzer.js` before `degree-planner.js`. Swap those tags and `DegreePlannerRuntime` is undefined for every call site in `degree-plan.js`. Under ESM with an injected analyzer this cannot be got wrong. And `State._restore()` at `state.js:558` runs at parse time, making a `localStorage` read's timing a function of script-tag position; it becomes an explicit call from `boot.js`.

**Honest cost:** ~55 modules over a deeper graph than 28 flat script tags. Measured in phase 4, when the change is mechanical and cheap to revert.

---

## 7. Migration

Seven phases, down from twelve. Every phase ends shippable. Three ordering constraints are load-bearing: **the harness exists before any file moves**; **snapshot versioning precedes normalization**; **state-ownership bugs are fixed before accounts exist**.

Every extraction follows a three-commit rule:

> **A** — new module added, old global kept as a thin delegating facade (`window.Search = facadeOver(instance)`). **B** — callers migrated, one caller file per commit. **C** — facade deleted once the wiring test shows zero remaining references.

---

### Phase 1 — Boot supervision. One week.

**Scope.** Wrap each of the 13 `init()` calls at `boot.js:15-27` in try/catch reporting through a new `platform/kernel/logger.js`. Add `window.onerror`, `unhandledrejection` and `securitypolicyviolation` handlers. Null-guard `boot.js:35`, where an unguarded `document.getElementById('term-select').addEventListener` throws **before** `window.AppModal` is assigned at `boot.js:127` — verified, and it permanently degrades every modal-using feature for the session. Add per-subscriber try/catch to `state.js:65`. Lift `AppModal` from `boot.js:99-180` into `static/js/modal.js`, loaded as a classic script before `boot.js`.

**Required test edits — this is what the draft got wrong.** Phase 1 does *not* leave the suite untouched. Exactly these changes are needed and no others:

- `tests/test_scheduler_frontend.js:8-10` — `bootSource()` becomes `bootSource() { return readFileSync('static/js/boot.js') + readFileSync('static/js/modal.js'); }`. This single edit keeps all six modal assertions at lines 903-912 passing, plus lines 221 and 3043, with no assertion rewritten.
- `tests/test_csp_inline_scripts.js:55-57` — `modal.js` must be added to the service worker's `SHELL_ASSETS`, or the "scripts absent from SHELL_ASSETS fail a cold offline start" assertion fails. This is a real requirement, not a test workaround.
- `tests/test_csp_inline_scripts.js:60-66` — unchanged. It pins `function boot()`, `readyState === 'loading'`, the `DOMContentLoaded` listener and the `boot.js` script tag, all of which survive.

**Green:** yes, with the two edits above. **New:** `tests/test_boot_supervision.js` asserts a throwing init does not prevent later inits, and that the term-select handler is guarded.

**Verify:** temporarily throw in the 4th init; the other twelve still run and a notice names the failure.

**Why first:** it closes this session's outage class before anything riskier starts, and it is worth shipping even if nothing else in this document ever happens.

---

### Phase 2 — The harness. Two to three days.

**Scope.** Build `tests/support/harness.mjs`: jsdom, current `index.html`, current 28 scripts in current order, exposes globals. **Migrate nothing yet.** Rewrite only the two `vm`-plus-global-name executions in `test_carolina_core_picker.js` and `test_major_map_selection.js` as proof the harness works on real cases.

**Green:** by construction — the harness runs today's app. **Value if you stop here:** modest but real; the next person can write a behavioural test cheaply.

---

### Phase 3 — Error taxonomy. Two weeks.

**Scope.** Add `platform/kernel/errors.js` with the full table from §4. Adopt it at the existing classification sites. Fix `grades.js:82-84`. Surface the four swallowed failures (`degree-plan.js:504`, `map.js:592`, `scheduler.js:629`, `data-store.js`). Unify the two worker envelopes (`{requestId, ok, error}` vs `{id, error}`) behind `worker-host.js` — one synchronised change across the workers plus the inline fallback.

**Test cost, measured:** 3 source-text sites read `grades.js` (3059, 3072, 3421); those migrate to the harness now. The other 8 use `loadObject` and need only an injected `errors` module.

**Verify:** force a relay 502 and confirm "502" appears in the rendered string.

**Value if you stop here:** the single highest user-visible return in the document. Students stop being told data does not exist when the network failed.

---

### Phase 4 — REMOVED. Cache-busting only.

**The ESM cutover is cancelled**, by the repository owner's decision on 2026-07-19,
and this section records why so it is not proposed again.

It was contested from the start: the two review passes that produced this plan
disagreed on whether to do it at all, and one deleted it outright as unjustifiable
cost. It carried the largest risk in the document — one atomic commit converting
28 files, a rewrite of every `vm`-plus-global test call site, a new total-404
failure class the current query strings do not have, and reintroduction of the
inline-script construct that had just caused a full outage.

Its two claimed wins were load-order safety and automated cache-busting.
**Load-order safety was already delivered by phase 1**, which supervises each
feature's startup so a throw stops one feature rather than the nine after it.
That leaves cache-busting, which does not need a module system.

**What replaces it.** `tools/build_static_site.py` stamps `?v=<digest>` onto
every script and stylesheet URL in `index.html` at build time, computed from the
file hashes the build already calculates for the service-worker build id. The
hand-maintained query strings on some tags — and their absence on `runtime/*.js`
— are what let a rebuilt file keep serving stale from the worker's
`max-age=3600`, which cost real debugging time during the QA pass.

**Not done, deliberately:** module scope. Modules still communicate through
globals. That is a genuine shortcoming, and the honest trade is that it costs
less than the cutover would.

### Phase 5 — Snapshot versioning + state ownership bugs. Three weeks.

Two things that must both land before accounts, in this order.

**5a. Per-slice snapshot versioning.** `state.js:466` writes `uosc-scheduler-plans` with **no version field** — verified. Add defensive migration-on-read from unversioned documents; this input is arbitrarily old and must be right on first ship, because a static site cannot re-derive a user's plans. Reconcile the verified `savePlan`/`exportToJSON` drift (four fields). **Must precede any normalization** — a normalizer shipped first is handed old-shape objects from real users' `localStorage` with no version field to detect them.

**5b. State ownership bug fixes**, each shipping alone with a user-visible symptom fixed:

- `degree-plan.js:513-520` pushes directly to `State.completedCourses` and `State.completedDetails`. `profile.js:281,296,327` already uses `State.addManualCompletedRecords` / `removeCompletedCourse` (`state.js:282,307`) correctly. Make degree-plan match.
- `preferences.js:102-108` and `scheduler.js:583-590` read the DOM as the store (`document.querySelectorAll('#block-calendar .block-cell.blocked')`). Give both a model.
- `transcript-import.js:46-48` — `persist() { State.savePlan(); }`, and `savePlan()` (`state.js:373`) writes to `this.savedPlans[this.currentPlan]`. Importing a transcript overwrites the user's currently-named saved plan. This is data loss.

Either 5a or 5b left undone makes account switching **destructive** rather than merely broken.

---

> **Status 2026-07-19: the contract spine has landed.** `tools/contracts/wire/fose-v1.json`
> exists and is enforced by `tests/test_wire_contract.js`, which builds the relay and
> runs it against the contract's own examples, and by `tests/test_wire_contract.py`,
> which pins the Python side. Verified to catch drift by altering the contract and
> observing failure. Constraint 6 is met for the request grammar: a term-format change
> is now one edit plus mechanical follower updates.
>
> **The firewall has landed too.** `static/js/platform/university/` holds the `Term`
> and `Section` domain types, the `fose-v1` codec in both directions, and the facade.
> Verified against the live relay: 192 sections cross it with no upstream field name
> surviving, seat counts converted from decimal strings, and provenance required so a
> catalog section reads as unknown availability rather than zero seats. A simulated
> upstream field rename surfaces at the codec instead of as a wrong number three files
> downstream.
>
> **The encode sites are migrated.** `api.js` and `live-university-client.js` build
> their search and details bodies through `encodeSearch` and `encodeDetails` rather
> than by hand, verified in a live browser by instrumenting the codec and confirming
> the real call path invokes it. A side effect worth having: an invalid term is now
> refused at the boundary before any network call, instead of coming back as a relay
> 400 the student has to interpret.
>
> **Decode is normalised on ingest.** `api.js` runs search responses through
> `decodeSearchCompat`, so every section arrives carrying the domain shape --
> `seatsOpen` as a number, `availabilityKnown`, `source` -- alongside its original
> upstream fields. Verified live: 192 sections carry both, `seatsOpen: 9` next to
> `total: "9"`. The seat-size filter in `search.js` is migrated to the domain field
> and confirmed working in a browser, 44 results narrowing to 10.
>
> Keeping both shapes is the plan's own sequencing rather than a compromise: a hard
> swap would mean editing 44 read sites in one commit, which is precisely the atomic
> change the critics flagged. Readers move independently now, and the upstream names
> disappear from the UI when the last one moves.
>
> **Still outstanding:** the remaining 43 reads of `instr` and `inst_mthd` in
> `search.js` and `scheduler.js`. Each is now a one-line change with the suite green,
> rather than a coordinated rewrite.

### Phase 6 — The wire contract and the firewall. Six to eight weeks. Constraint 6 lands here.

**Scope.** Create `tools/contracts/wire/fose-v1.json` from the verified relay routes. Generate `validateSearchPayload` and the response guard from it; point `tools/lib/wire_contract.py` at it. Create `platform/university/` with `domain/term.js`, `domain/query.js`, `domain/section.js`, the three codecs and golden fixtures.

> **Correction, verified 2026-07-19.** The premise below is overstated. `getMode()`
> does *not* always return `'static'`. It returns `'legacy'` whenever
> `CourseDataStore` or `LiveUniversityClient` is absent, which is what happens when
> those scripts fail to load — precisely the CSP scenario that took the site down
> earlier that day. Confirmed by running `api.js` in two sandboxes: with both
> globals present it returns `static`; with the data store missing it returns
> `legacy`.
>
> So the `!isStaticMode()` branches are a fallback for a broken static path, not
> unreachable code. They are still worth removing — the ten routes they target have
> no relay route, so the fallback cannot succeed either — but the change is
> *"replace a fallback that fails confusingly with one that fails legibly"*, not
> *"delete unreachable code"*. It needs the error taxonomy from phase 3 to land
> well, and it is not the free win this section claims.

**Delete dead code first.** Verified: `CourseSchedulerConfig` is referenced at `api.js:37,69,276` and **declared nowhere in production** — only `tests/test_static_api.js` sets it, and always to `'static'`. So `getMode()` always returns `'static'` and roughly half of `api.js` is unreachable code that reads as load-bearing. Delete the `!isStaticMode()` branches and the **10** route strings with no relay route (`/api/history`, `/api/history-stream`, `/api/parse-transcript`, `/api/major-map`, `/api/major-maps`, `/api/degree-plan`, `/api/offering-analysis`, `/api/course-grades`, `/api/professor-grades`, `/api/subjects`). This is the cheapest large win in the plan and it shrinks everything after it.

**Then replace leak sites file by file**, each file's tests green as it goes. This is possible because `State.selectedCourses` holds the same objects everywhere: introduce `createSection` first, have `state.js` normalize on ingest, and every reader migrates independently afterwards. That one sequencing decision converts the atomic ten-file commit the critics identified into ten commits.

The synthetic constructors matter disproportionately — grepping field *reads* misses them, because the UI is also a *producer* of the wire shape.

**Verify:** `tests/test_wire_contract.py` proves browser, relay and Python agree. A term-format change edits `parseTerm` and nothing else.

**Value if you stop here:** upstream churn is isolated, dead code is gone, errors are legible, tests are behavioural for every file touched. This is a complete, coherent stopping point.

---

> **Status 2026-07-19: accounts have landed; feature extraction has not.**
> `static/js/keyspace.js` implements device-local accounts as a storage-key prefix
> plus a reload, which is the simplification this plan identified and it kept the
> work to one small module. Separation is verified in a real browser: two accounts
> cannot see each other's plans, and a device with no account keeps the unprefixed
> keys so existing data is untouched. Constraint 2 is met.
>
> Constraint 7 needs no work: `static/js/runtime/*.js` already carry a dual export
> and `require()` cleanly with no DOM, which `tests/test_harness.js` asserts. An MCP
> or CLI surface can reuse the solver, planner, and transcript parser today.
>
> **7a has started.** `history` is fenced in `static/js/features/history/`, chosen
> because it had one inbound caller and the fewest outbound dependencies. It names
> its four dependencies and reaches no ambient global, asserted by a test rather
> than claimed. `static/js/history.js` is now the composition point that supplies
> the real ones, and it exposes the instance rather than wrapping it because the
> suites override internals to control time.
>
> Extraction immediately surfaced hidden coupling, which is the argument for doing
> it: `_escape` reached for `document.createElement` to escape text, a DOM
> dependency inside a function that reads as pure. It is now declared.
>
> **`map` is fenced** (`static/js/features/map/`), 839 lines with fourteen
> inbound methods. The coupling was narrower than the size implied: one API
> method, three State properties, a route cache, and `fetch`. Extraction found
> three undeclared dependencies, and one of them is a general lesson.
>
> Guards of the form `typeof API === 'undefined' || !API.getDetails` read as
> defensive, but inside a fenced module the global is *always* undefined, so
> every guarded path returned early and the feature silently did nothing. A seam
> substitution that rewrites calls does not catch them, because they test
> existence rather than call. Check for them explicitly in every remaining
> extraction. `fetch` was the second: invisible until a test injected its own and
> saw zero calls.
>
> DOM and Leaflet stay ambient there, deliberately. A campus map needs a document
> and a mapping library; injecting them is ceremony that does not make the module
> replaceable. The fence that earns its keep is around the application's own
> state and data access.
>
> **`transcript` is fenced** (`static/js/features/transcript/`), and it was the
> cheapest of the three because its boundary was already mostly drawn:
> `transcript-pdf.js` and `transcript-upload-dialog.js` reach for nothing but
> `pdfjsLib` and their own dialog. All the coupling lived in the 80-line seam
> file, which is what moved.
>
> The `map` lesson paid off immediately. `refreshViews()` called Profile and
> DegreePlan behind `typeof` guards — exactly the pattern that would have failed
> silently inside a fence. It is now an `onApplied()` dependency, and the guards
> live at the composition point where a missing global is genuinely possible.
>
> Extraction also caught a test that had stopped testing anything: a guard
> asserting transcript import uses the narrow writer sliced source from a
> `persist()` literal, and when that literal moved, `indexOf` returned −1, the
> slice came back empty, and `doesNotMatch` passed against nothing. It now
> asserts its own anchor first. Worth checking for elsewhere — source-text
> assertions fail open by default.
>
> **`profile` and `custom-major-map` are fenced**, and they are one item
> because they were one cycle: the builder called six Profile methods and
> Profile called two builder methods. Neither edge was broken by fencing the
> cycle whole. Each edge became a dependency, so neither module knows the other
> exists and the composition points decide the wiring.
>
> Between them they removed five existence-guarded ternaries, the pattern that
> has now appeared in every single extraction. Their failure modes were all
> quiet and all different: a saved map that never becomes active, a student's
> own maps vanishing from the program list, and a saved custom map being
> refetched from the network as though it were official.
>
> Fencing the builder's storage also exposed a real bug nobody was looking for.
> Plans route their key through `Keyspace`; custom maps use a bare key, so every
> device-local account on a shared machine sees and can delete the same ones.
> Not fixed with the fence -- routing the key orphans maps already saved, so it
> needs a migration. Recorded in TODO.md with a test pinning current behaviour.
>
> **`degree-plan` is fenced**, the widest extraction: twenty-four dependencies.
> The count is honest rather than a sign the fence is wrong -- this tab is where
> everything else meets.
>
> Its edges into Search and Scheduler are the ones that matter for what is left.
> None is a data dependency; all are "take the student somewhere". As callbacks
> they cost nothing and they remove inbound edges from the cycle that has to be
> untangled last, which is why this tab could be fenced before those modules.
>
> The extraction also nearly lost a module. `degree-plan.js` held two top-level
> objects, `DegreePlan` and `ScheduleSidebar`, and a boundary taken to the last
> `};` swallowed the second into the factory, where it stopped being a global.
> **The suite caught this**, which is worth recording precisely because so much
> else in this phase was caught only in a browser. Nine tests failed immediately.
> `ScheduleSidebar` stays in the composition point until the schedule tab is
> fenced; moving it now would hide a second extraction inside this one.
>
> Two more source-text assertions were found failing open, both slicing with
> `indexOf` and silently checking an empty string once the code moved. That is
> four such defects across this phase. They are now anchored, and the remaining
> ones in the suite should be treated as suspect until checked.
>
> The test loaders now load every feature module rather than a named one, so the
> next extraction needs no changes there.
>
> **`grades` is fenced**, and it mattered for how it was coupled rather than
> how much. Grade history read four of Search's private fields -- `_detailToken`,
> `_detailGroup`, `_detailTerm`, `_browseState` -- to answer two questions: what
> is on screen, and is this async result still about it. Reaching into another
> module's underscore state is the tightest coupling in the tree, and it pointed
> straight at the module that gets untangled last.
>
> It is one `viewContext()` shape now: `{token, mode, group, term, section,
> faculty}`. Search can restructure its internals without silently breaking
> grade history, which matters immediately because Search is next and is the
> largest module here. The token is the part worth protecting: a student
> clicking faster than the relay answers has several requests in flight, and
> each result must be able to ask whether the page still shows what it was
> fetched for.
>
> Five more existence-guarded ternaries came out. Two guarded the
> instructor-summary calls, so inside a fence the grade table would have fallen
> back to historical instructors and stopped marking who is teaching now.
>
> **`export`, `prereqs`, `scheduler` and `search` are fenced. Phase 7a is
> complete: ten of ten.**
>
> **The plan was wrong about this group, and the measurement says so.** It
> predicted an irreducible cycle where the facade rule would not be optional.
> Measured, the cycle is seven methods wide: the scheduler reaches search
> through three, search reaches the scheduler through four, across 6,300 lines.
> Both directions are injected and no facade was needed. That is the same
> lesson the map extraction taught -- coupling is narrower than size suggests --
> and it has now held three times. Measure before designing around an estimate.
>
> These two use a **coarser seam** than the other eight, deliberately.
> Collaborators arrive as objects (`deps.state`, `deps.api`) rather than as
> individually named functions. Flattening thirty-five dependencies each would
> have meant a mechanical edit across thousands of lines that had to get
> property-versus-method right every time -- the exact shape of edit that
> produces a bug looking like a refactor. The architectural property is
> unchanged; narrowing the seam later is a local change.
>
> Thirty-one existence guards came out of the pair, the largest concentration in
> the repository. Across all ten features the count is over fifty, and **every
> single extraction contained at least one**.
>
> Two findings worth carrying forward:
>
> The application's `History` module collides with the DOM's `History`
> interface. A composition point that resolved collaborators eagerly captured
> the built-in constructor instead of the module -- a wrong value that an
> existence check accepts, because it is very much defined. Classic scripts
> declare globals with `const`, which is a lexical binding that does not exist
> until that script runs, so composition points for the pair supply **getters**
> rather than values. The browser reported the failure as "Search is not
> defined", because the composition point threw and left the const in its
> temporal dead zone. Boot supervision from phase 1 is what surfaced it.
>
> Six source-text assertions were found failing open across this phase, all
> slicing with `indexOf` and silently checking an empty string once the code
> moved. They are anchored now. Any remaining source-text assertion should be
> assumed suspect until it has been shown to fail when it should. Each is the same
> three-step shape, and the pattern plus test vocabulary is now established
> across an easy case, a hard one, and a pre-drawn one.
>
> **A caveat that belongs with the status, not buried in it:** two user-facing
> bugs this session were caught only by clicking through a browser on a fully
> green suite — a decode regression that broke schedule generation entirely, and
> a calendar that rendered blank over restored state. Neither suite noticed.
> Fencing work should keep ending in a browser, not in a test summary.

### Phase 7 — Optional: fenced features and accounts. Three to five months.

Everything above improves the *current* architecture. This phase changes it, and it is the one that can be paused indefinitely.

**7a. Extract features**, three commits each, in this order: `history` → `map` → `transcript` → `profile`+`custom-major-map` → `degree-plan` → `grades` → `schedule`+`export` → `search`+`prereqs`. The first three have a single dependency direction and no inbound edges but `boot.js`. `search` and `schedule` land last and together: they are in the same irreducible cycle and are ~40% of `static/js` by line count (`search.js` 4,073 + `scheduler.js` 2,203 of 15,539). For those two the facade rule is not optional.

**7b. Dissolve State.** As each feature takes ownership its share of `State` empties; `state.js` becomes a facade, then is deleted. `term` moves to one owner, ending the three-writers-no-event problem (`boot.js:36`, `search.js:1397`, `state.js:404`).

**7c. Accounts.** `platform/store/keyspace.js` rebinding plus feature restart:

```js
async function switchTo(id) {
  await stopAll();                 // aborts ctx.signal for every feature
  keyspace.rebind(`acct:${id}`);
  await startAll();
  bus.publish('account:changed', {id});
}
```

`localStorage['accounts:v1'] = [{id, label, createdAt}]`. No passwords, no hashes. `acct:<id>:<feature>:<key>` for plans, transcript, degree plan, profile, preferences; `device:<feature>:<key>` for sidebar geometry and notice dismissals. IndexedDB stays shared and unscoped — it holds content-addressed release bytes verified by SHA-256, identical for every account.

Safe here and not earlier because phase 5 removed the two conditions that make switching silently destructive, and phase 7a removed the module-level state that would leak between instances.

**University credentials: seam only.** `ctx.credentials` is an interface (`put/get/clear`) with an in-memory default and **no writer**. The relay is not given header forwarding and does not learn accounts exist.

**No sign-in UI.** Shipping a menu that performs account switching is new user-facing capability under constraint 3. The mechanism lands; the surface is the owner's separate decision.

---

### Honest estimate, solo, part-time

Phases 1–2: **1.5 weeks**. Phase 3: **2 weeks**. Phase 4: **2 weeks**. Phase 5: **3 weeks**. Phase 6: **6–8 weeks**. Total to the stopping point: **roughly four months of evenings**. Phase 7: 3–5 months more.

The draft's estimate was 6–12 months to a comparable point. The difference is the framework I cut and the test tax I un-batched, not optimism.

### Stopping points

Every phase is independently valuable, which is the property the brief asked to verify:

- After **1**: the outage class is closed. A throw in one module no longer silently kills the rest of boot.
- After **2**: the next test written is behavioural instead of a regex.
- After **3**: students stop being told data does not exist when the network failed. Highest user-visible return in the plan.
- After **4**: load order stops being a correctness property; deployment is immutable with real retention; CSP failures are build failures.
- After **5**: transcript import stops overwriting saved plans; export/import stops dropping four fields.
- After **6**: upstream churn is isolated to one directory and one JSON file; ~half of `api.js` is deleted.

There is no phase whose value depends on a later phase completing, and no phase with a big-bang commit.

---

## 8. What this is worse at, and what was accepted rather than fixed

### Worse

**Indirection replaces call graphs.** `Search.addToSchedule()` becomes `bus.send('schedule.addCourse', …)`. Shallower stack traces, no jump-to-definition, no rename refactor. Command names are hardcoded cross-feature references dressed as strings — late binding, not the absence of a dependency. Real daily cost paid for folder-level replaceability, and if nobody ever replaces a folder it was a bad trade. This is the main reason phase 7 is optional.

**Cold load is slower.** ~55 modules over a deeper graph than 28 flat tags. A bundler would win it back and is deliberately declined. Measured in phase 4, not asserted.

**Siloing produces duplication.** Two features formatting meeting times. `platform/` is the escape valve and every use of it is a judgement call. Neither the design nor the tests can adjudicate this.

**Domain normalization loses fields.** Any upstream field the codec does not map is invisible app-wide. `DecodeWarning{reason:'unmapped'}` makes the loss visible, not free. There is deliberately **no** `section.raw` escape hatch — it would reopen the leak within a release.

**Fencing does not shrink `search.js`.** 4,073 lines get a folder and a model/view split. `features/search/` stays an order of magnitude larger than `features/history/`, and treating them as peers creates a false impression of uniformity.

**Device-local accounts promise less than "log in" implies.** No sync, no recovery, no cross-device continuity. Clearing site data destroys everything silently. UI copy is a weak defence against a strong convention.

### Accepted, not fixed

**You cannot delete `features/search/` and lose exactly one feature.** `search` owns the course-detail host, so deleting it dims grades, prereqs and history too. The response is to stop claiming otherwise. Feature independence is a property of leaves; the `declares` block says which is which. I dropped the draft's `check_slice_deletion.py` — a test that copies the tree and deletes a folder is expensive to maintain and proves something the `declares` graph already states.

**The bus is a singleton reachable from every feature.** `ctxFor` narrows the rest of the context, but `bus` and `logger` go to everyone. Injected rather than ambient, so testable and replaceable — not absent. Claiming "nothing connected" would be false.

**Two anti-corruption layers still exist in two languages.** `contracts/wire/*.json` gives the browser codec, the relay validator and the Python generators one source of truth, and a test asserts agreement. But the Python pipeline still has its own implementation reading that contract. One contract, three implementations, mechanically checked — materially better than hand-synchronisation, and not literally "one place."

**Topic payloads are typedefs and tests, not runtime-validated schemas.** A wrong payload fails a test, not a publish. I judge a hand-rolled validator running on every publish to be worse than the bug it prevents, at this scale. If the app grows a second maintainer, revisit.

**Credential passthrough is cut, not designed in.** Constraint 2 asks that an account concept be *possible* without a backend, not that a vault ship. Forwarding credentials would change the relay from proxy to auth proxy and would bypass its body validation, since headers are not the body. On a static site whose CSP has been contradicted twice this session, in-memory-only with no writer is the right default.

**The sign-in menu is not shipped**, and neither is the draft's "reload to continue" staleness banner. Both are new user-facing capability under constraint 3.

**CSP `report-to` is deleted outright.** It requires a reporting endpoint — a new server component (constraint 1) or a third-party collector shipping telemetry off-device. Replaced by the build-time self-test plus an in-page `securitypolicyviolation` listener rendering a local notice. Both of this session's CSP failures would have been caught by the build-time check.

**The phase 7a extraction order is a hypothesis.** I read the repository and the line counts and cycle membership are verified, but the exact order depends on DOM-id overlap at each step. Re-derive it from a global-reference dump before starting 7a — and note that this costs an afternoon, which is why I folded the draft's standalone "phase 2: re-derive the graph" into the phase that actually needs it rather than blocking the whole plan on it.
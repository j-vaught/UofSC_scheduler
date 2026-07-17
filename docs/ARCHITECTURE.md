# Browser-First Architecture

The UofSC Course Scheduler has a browser-first production build. The browser owns interactive state and computation. Hosting supplies the application shell, search assets, a release manifest, immutable historical-data shards, and a fixed read-only relay for current course search and section details. Python remains an offline data-generation tool and an optional comparison runtime.

![Browser-first static architecture](diagrams/browser_first_architecture.png)

## Runtime Design

The application shell renders before large data artifacts are needed. The browser immediately begins warming the semantic-search model and its generated embedding bundles. `data-store.js` loads the small release manifest and then fetches catalog, grade, professor, offering-history, and major-map shards by logical name. Every immutable artifact is checked against the byte length and SHA-256 digest recorded in the manifest before use.

The interface stays responsive because schedule generation, transcript parsing, degree planning, and offering analysis run through browser workers. The static API adapter can also execute the same cores without workers for test environments and older browsers. JavaScript parity fixtures protect the solver's conflicts, asynchronous sections, credit handling, preference ranking, and worst-route penalty behavior.

Current-term information is an overlay rather than a generated snapshot. `live-university-client.js` sends course search and section-detail requests to same-origin managed routes with bounded concurrency, duplicate-request coalescing, cancellation, timeouts, and short in-memory freshness windows. The routes accept only validated University term, search-criteria, and Course Reference Number payloads and forward them to fixed upstream addresses. A failed live request never turns into a false “not offered” claim. The interface reports that live availability is unavailable while retaining verified static catalog, grade, prerequisite, and offering information.

## Current File Layout

```text
static/
├── index.html
├── service-worker.js
├── css/
│   ├── style.css
│   ├── grades.css
│   └── map.css
├── js/
│   ├── api.js
│   ├── live-university-client.js
│   ├── data-store.js
│   ├── state.js
│   ├── search.js
│   ├── scheduler.js
│   ├── solver-core.js
│   ├── solver-worker.js
│   ├── grades.js
│   ├── history.js
│   ├── prereqs.js
│   ├── map.js
│   ├── runtime/
│   │   ├── transcript-parser.js
│   │   ├── degree-planner.js
│   │   └── offering-analyzer.js
│   └── workers/
│       ├── transcript-worker.js
│       ├── degree-planner-worker.js
│       └── offering-analysis-worker.js
└── data/
    ├── manifest.json
    ├── releases/
    │   ├── full-20260717/
    │   │   ├── catalog/courses/
    │   │   ├── grades/courses/
    │   │   ├── grades/professors/
    │   │   ├── history/
    │   │   └── major-maps/
    │   └── representative-20260717/
    ├── course_embeddings.json
    ├── phrase_embeddings.json
    ├── pca_params.json
    ├── campus_buildings.json
    └── site_notices.json

scripts/
├── build_catalog_shards.py
├── build_grade_shards.py
├── build_offering_history.py
├── build_data_manifest.py
├── build_static_release.py
├── build_static_site.py
└── sync_campus_buildings.py

dist/                               Generated static deployment.
app.py                              Optional legacy comparison runtime.
grade_pipeline.py                   Offline grade and section matching.
build_embeddings.py                 Offline semantic-search generation.
scrape_courses.py                   Offline bulletin catalog generation.
```

## Execution Boundary

The browser executes search parsing and ranking, schedule generation, prerequisite evaluation, transcript parsing, degree planning, offering summaries, grade rendering, maps, routing orchestration, export generation, and user-state persistence. Managed hosting returns files and performs two bounded live-data requests. The generated `dist/` tree contains no Python or database files.

Offline generation executes source pulls, registrar matching, privacy suppression, catalog normalization, embedding generation, offering-history aggregation, release sharding, manifest construction, integrity validation, and the final static build. These tasks run once per data release rather than once per visitor.

The optional `app.py` runtime remains in the repository for parity comparison and local live-data testing. It is not copied into `dist/`. Managed deployment uses `dist/server/index.js` to serve assets and handle `POST /api/search` and `POST /api/details`. Every other application operation remains in `dist/client/` and the visitor's browser.

## Startup and Caching

The first render requests the HTML, CSS, JavaScript modules, small support files, and the release manifest. Semantic-search embeddings and model initialization begin in the background. Exact structured searches infer the requested subject and load only that subject's catalog and grade shards. Broad semantic search uses the precomputed local index before considering bounded live enrichment.

The service worker caches the shell and workers. Immutable release files use content-hashed URLs and a cache-first policy. The manifest uses network-first revalidation with cached fallback. Cache Storage holds verified response bodies. IndexedDB retains release metadata and records when Cache Storage is unavailable. Local storage contains only user-owned plans and interface preferences.

An explicit page refresh revalidates the manifest and live requests. Search state, course code, selected section, and active detail panel are encoded in the URL, so refresh and browser back or forward navigation restore the same workspace. Historical artifacts remain cached until their content-hashed URL changes.

## Completed One-Time Migration

The migration froze Python parity fixtures before runtime ports began. The semester solver moved into `solver-core.js` and `solver-worker.js`. Transcript parsing, offering analysis, and degree planning moved into browser-safe cores and correlated workers. The interface now routes process-backed calls through a single static-aware API boundary.

The data layer now publishes a full manifest, immutable subject and professor shards, privacy metadata, byte lengths, and content hashes. The service worker, Cache Storage integration, IndexedDB fallback, static builder, deployment headers, desktop gate, URL restoration, and offline reload path are implemented.

The course-search API returns data to non-browser clients and to its own University page, but its preflight response does not authorize an independently hosted browser origin. The managed relay moves that request to a server-side hosting boundary and returns the result through the scheduler's own origin. This removes the browser Cross-Origin Resource Sharing dependency for course search and section details while retaining static fallback behavior when the relay or upstream service is unavailable.

![One-time migration and periodic release workflow](diagrams/data_generation_workflow.png)

## Periodic Data Generation

A completed-term release starts when an official grade workbook or finalized section term becomes available. The pipeline pulls each completed term once, retains failed coverage as unknown, and reuses the section records for grade matching, professor summaries, offering frequency, enrollment, capacity, and fill-rate calculations. Grade and offering outputs update together but remain distinct manifest artifacts.

A catalog release runs only when bulletin content or the semantic model changes. It rebuilds normalized subject shards, phrase embeddings, course embeddings, and projection parameters. Campus building aliases, curriculum maps, and site notices update independently.

Every release validates schemas, coverage, duplicates, impossible values, privacy suppression, byte sizes, and content hashes. Immutable artifacts publish first. `manifest.json` publishes last and activates the new release atomically. A browser can continue using the previous complete release if a new file fails integrity validation.

The active full release contains 555 manifest artifacts totaling 41,193,162 bytes. It covers 168 catalog subjects, 9,732 catalog courses, 26 completed terms from 201705 through 202601, 213 offering-history subject shards, 4,605 publishable course-grade records, 6,442 professor aggregates, 16 professor-prefix shards, and one major map.

Public grade artifacts suppress aggregates below ten counted grades. The current build suppresses 1,085 course-instructor records, 1,327 course aggregates, 3,312 professor-course records, 673 professor-year records, and all matching source identifiers.

## Static Build and Deployment

`scripts/build_static_release.py` creates content-hashed data and the manifest. `scripts/build_static_site.py` verifies the active release, copies the application into `dist/client/`, renders a build-specific service worker, emits root fallback files, adds cache and security headers, writes the managed-host asset and relay entry point, and atomically replaces `dist/`.

The current distribution contains 621 files and about 52.5 MB. `dist/client/` must be served from a domain root because the interface uses absolute `/static/` paths and a root-scoped service worker. The generated headers define immutable caching for release artifacts, revalidation for the manifest and worker, Content Security Policy restrictions, frame protection, permissions restrictions, referrer handling, and transport security.

Authenticated University resources remain first-party navigation. The scheduler opens the syllabus archive and registration systems in University-controlled tabs. It cannot embed or inspect the student's cross-origin authentication session.

The interface intentionally gates viewports at or below 720 pixels. Desktop-only delivery reduces layout scope, but it does not change cross-origin policy, authentication rules, storage quotas, or browser security boundaries.

## Verification Results

The current release passes 72 Python tests and 170 JavaScript tests. Static build validation checks every artifact size and digest, rejects incomplete representative data by default, and confirms that no Python or database files enter the distribution.

Local desktop browser measurements on the generated static origin recorded a 77 ms cold shell navigation, a 334 ms uncached exact-course result, a 122 ms warm same-subject result, a 775 ms warmed semantic search, a 770 ms browser degree-plan generation, a 535 ms course-and-panel reload restoration, and a 349 ms offline service-worker reload. These observations are development-machine checks rather than performance guarantees.

The offline test stopped the local file server after the first visit and successfully restored `CSCE 145`, its description, and historical grade context from the service worker and immutable data cache.

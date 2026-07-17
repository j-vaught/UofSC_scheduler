# Browser-First Architecture

This document describes the target architecture for the UofSC Course Scheduler. It is a migration design, not a claim that the current Python runtime has already been removed. The current application continues to use `app.py` for local hosting, upstream requests, schedule generation, and selected analysis endpoints while the browser-first path is developed and verified.

The target keeps process hosting out of the production deployment. Static application files and generated data bundles are hosted as ordinary files. Current-term course information comes directly from University systems in the student's browser. Search ranking, schedule generation, prerequisite evaluation, grade summaries, offering analysis, and degree-planning calculations run locally in browser workers.

![Target browser-first architecture](diagrams/browser_first_architecture.png)

## Runtime Design

The application shell renders before large datasets are available. A small release manifest then identifies the current data release, its schema version, its coverage, and every immutable artifact. The background loader prioritizes data for the student's active subject or course and continues warming other datasets during idle time.

Current-term searches remain live. They request sections, seats, Course Reference Numbers, meeting patterns, instructors, locations, and registration restrictions from University systems. Static historical data supplements those live results but never replaces them. A current-term failure is shown as unavailable data rather than silently falling back to stale sections.

Browser workers keep computational work away from the interface thread. The search worker performs semantic ranking over locally cached embeddings. The solver worker generates and ranks conflict-free schedules. Additional workers can parse transcripts, evaluate degree plans, and calculate offering summaries. The prerequisite evaluator retains the catalog expression structure so that `AND`, `OR`, placement, and co-requisite relationships are not flattened into an incorrect list.

Cache Storage holds immutable downloaded files. IndexedDB holds parsed indexes and normalized records that would otherwise be rebuilt on each visit. Local storage holds small user-owned settings such as selected courses, pane sizes, collapsed panels, and schedule preferences. A manual browser refresh revalidates the manifest and current-term requests while preserving the selected course URL and locally saved plan.

## Target File Layout

The following tree shows the intended production layout. Files labeled as planned do not yet exist.

```text
static/
├── index.html
├── service-worker.js                       planned
├── css/
│   ├── style.css
│   ├── grades.css
│   └── map.css
├── js/
│   ├── api.js                              direct current-term requests
│   ├── state.js                            local user state
│   ├── search.js                           search interface
│   ├── scheduler.js                        schedule interface
│   ├── grades.js                           historical grade interface
│   ├── history.js                          offering-history interface
│   ├── prereqs.js                          structured prerequisite logic
│   ├── map.js                              campus maps and routes
│   ├── data-store.js                       planned manifest and shard loader
│   ├── solver-core.js                      planned browser solver core
│   └── workers/
│       ├── search-worker.js                planned semantic ranking
│       ├── solver-worker.js                planned schedule generation
│       ├── transcript-worker.js            planned transcript parsing
│       └── degree-worker.js                planned degree evaluation
└── data/
    ├── manifest.json                       planned stable release entry point
    ├── catalog/
    │   ├── subjects.json                   planned
    │   └── courses-<subject>.json          planned immutable shards
    ├── grades/
    │   ├── courses-<subject>.json          planned course aggregates
    │   └── professors-<prefix>.json        planned professor aggregates
    ├── history/
    │   └── offerings-<subject>.json        planned completed-term coverage
    ├── search/
    │   ├── course-embeddings.json          planned release location
    │   ├── phrase-embeddings.json          planned release location
    │   └── pca-params.json                 planned release location
    ├── campus_buildings.json
    └── site_notices.json

scripts/
├── build_static_release.py                 planned orchestration entry point
├── build_offering_history.py               planned completed-term builder
├── build_data_manifest.py                  planned release manifest
└── sync_campus_buildings.py
```

## Current-to-Target Module Map

| Current module | Target responsibility | Migration rule |
| --- | --- | --- |
| `app.py` | Static hosting only during development | Remove from production only after direct browser access is verified from the final origin. |
| `scheduler.py` | `solver-core.js` and `solver-worker.js` | Preserve solver fixtures and ranking parity before cutover. |
| `offering_analyzer.py` | Browser offering analyzer | Read complete generated term records rather than making repeated section requests. |
| `transcript.py` | `transcript-worker.js` | Parse locally and retain student records only in the browser. |
| `planner.py` | `degree-worker.js` | Keep degree planning separate from the semester-first interface. |
| `grade_analytics.py` | Static grade shards plus browser lookup | Publish only privacy-safe aggregates. |
| `grade_pipeline.py` | Offline release tool | Keep raw grade workbooks unchanged and outside the runtime bundle. |
| `scrape_courses.py` | Offline catalog builder | Regenerate catalog data only when bulletin content changes. |
| `build_embeddings.py` | Offline search-data builder | Rebuild embeddings only for changed catalog text and model versions. |

## Startup and Background Loading

The first paint uses only the application shell and small configuration files. The browser then fetches `manifest.json`, compares the release identifier with the locally stored identifier, and queues missing artifacts. Current course, subject, and selected schedule data receive the highest priority. Search embeddings load in the background from the first page visit so semantic search is ready before it is requested whenever bandwidth permits.

Grade, professor, and offering-history shards are loaded by subject rather than as one blocking download. The browser may continue warming remaining shards when the connection is idle. Parsed indexes are stored in IndexedDB, while the original content-hashed files remain in Cache Storage. A new manifest swaps the active release only after every required file has been fetched and validated.

## One-Time Migration

The one-time work begins by freezing representative fixtures for schedule generation, prerequisite expressions, transcript parsing, degree evaluation, and offering analysis. These fixtures define parity with the current application before any runtime code is replaced.

The computational modules are then ported into browser-safe cores and workers. A release manifest, immutable data shards, a service worker, Cache Storage, and IndexedDB indexes are introduced without changing the existing interface. Direct current-term requests are tested from the final static deployment origin because browser cross-origin policy depends on that origin, not on whether the site is desktop-only.

The final cutover follows parity tests, accessibility checks, request-count measurements, data-coverage validation, bundle-size checks, and a desktop screenshot pass. The Python runtime path is removed from production only after those checks pass. Python remains appropriate for offline generation because those scripts run during data releases rather than for individual visitors.

![Build and data-generation workflow](diagrams/data_generation_workflow.png)

## Periodic Data Generation

Each periodic release begins by detecting which source changed. A completed term is pulled once and reused for grade matching, professor summaries, enrollment statistics, capacity, and offering history. Failed or incomplete term coverage remains explicitly unknown. It must not be interpreted as a course not being offered.

Offering history includes every completed-term section available from the official section source. It is not derived only from grade workbooks because grade publications may omit sections with suppressed or ineligible outcomes. Grade aggregates and offering records are released together when a completed term is finalized, but they remain separate data products with separate coverage metadata.

Catalog records and search embeddings regenerate only when bulletin text or the embedding model changes. Campus building aliases, major maps, and site notices follow independent release schedules. Every changed artifact is validated, privacy checked, sharded, compressed when appropriate, and content hashed. Immutable artifacts are uploaded first. The small mutable `manifest.json` is published last, which makes the release visible atomically.

| Release class | Trigger | Main outputs |
| --- | --- | --- |
| Completed-term release | Official grade workbook or finalized section term | Course grades, professor aggregates, offering history, enrollment, and capacity. |
| Catalog release | Material Academic Bulletin change | Course records, phrase embeddings, course embeddings, and dimensionality-reduction parameters. |
| Campus release | Building alias or coordinate correction | Campus building lookup and map metadata. |
| Curriculum release | Approved major-map change | Degree requirements and recommended semester maps. |
| Notice release | Maintenance or student-action message | `site_notices.json` only. |

## Release Manifest

The manifest is the only stable mutable data URL. Each release records a schema version, a release identifier, source coverage, generation timestamps, artifact URLs, byte sizes, content hashes, and optional superseded release information. A browser may continue using the previous complete release if a new artifact fails its size or hash check.

Long-lived historical artifacts can remain cached for months because their URLs change when their content changes. Current-term API responses use a short freshness window and revalidate on an explicit page refresh. User schedules and preferences are versioned separately from shared data so a release never discards a student's local plan.

## Deployment Dependencies

The production site can be process-free, but it is not independent of upstream browser policy. University endpoints must permit requests from the deployed origin through Cross-Origin Resource Sharing, or the site must be served from an origin already allowed by those endpoints. If that access is unavailable, a request relay remains necessary for affected calls.

Authenticated University pages such as the syllabus archive should open as first-party tabs. The scheduler cannot safely embed or inspect the student's cross-origin login session. The interface can first open the archive login page and then provide the course-specific archive link, but the student completes authentication and navigation in University-controlled tabs.

This architecture intentionally targets desktop browsers first. A desktop gate reduces interface scope, but it does not change cross-origin access, authentication, storage quotas, or browser security rules.

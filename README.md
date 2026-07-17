# UofSC Course Scheduler

The UofSC Course Scheduler is a desktop-first semester planning tool for University of South Carolina students. The production build is browser-first. Search ranking, schedule generation, transcript parsing, prerequisite evaluation, historical-grade lookup, offering analysis, and degree-plan calculations run in the student's browser. Managed hosting adds a narrowly scoped relay for current course search, section details, and current faculty identities.

The primary workflow remains planning one semester effectively. Degree planning is available as a secondary browser-local tool.

![A generated semester schedule with the weekly calendar, campus routes, and ranked schedule options](docs/screenshots/05-schedule-and-routes.png)

## Feature Tour

Course discovery supports subject codes, exact courses, ranges, Course Reference Numbers, descriptive phrases, and scoped natural-language searches. The semantic model begins warming in the background on the first visit. Structured searches remain available without semantic ranking.

![Browser-local semantic search over the static course catalog](docs/screenshots/08-static-smart-search.png)

Selecting a course opens a persistent detail workspace. The live overlay supplies sections, seats, instructors, meeting details, and registration restrictions when the deployed origin is allowed to read the University endpoints. Catalog, prerequisite, historical-grade, and offering-history data remain available from immutable static releases when live access is unavailable.

![Static course workspace with historical grade summaries](docs/screenshots/09-static-course-grades.png)

Completed-term history shows observed offering frequency, seasons, section counts, enrollment, and fill rates. Course and professor grade summaries suppress small aggregates and expose no source identifiers.

![Static completed-term offering history](docs/screenshots/10-static-offering-history.png)

The semester solver generates and ranks conflict-free schedules in a browser worker. Applied schedules drive the calendar, campus route view, and registration checklist. The registration handoff includes section-specific checks, individual Course Reference Number copy actions, and a link to the official shopping cart.

<details>
<summary>Schedule, routes, and registration</summary>

![Schedule calendar, route map, and ranked options](docs/screenshots/05-schedule-and-routes.png)

![Registration checklist for an applied schedule](docs/screenshots/06-registration-info.png)

</details>

The degree planner also runs in a browser worker and stores student-entered progress locally.

![Browser-local degree plan](docs/screenshots/07-static-degree-plan.png)

The screenshots show a Fall 2026 desktop session. Live sections, seats, instructors, and restrictions can change after capture.

## Static Build

Install [uv](https://docs.astral.sh/uv/), clone the repository, and build the static distribution.

```bash
git clone https://github.com/j-vaught/UofSC_scheduler.git
cd UofSC_scheduler
uv sync
uv run python scripts/build_static_site.py
```

The generated `dist/client/` directory contains the browser application. Any ordinary static host can serve that directory from the domain root, but live course search, section details, and current faculty identities require the generated managed-host entry point in `dist/server/index.js`. That entry point serves assets and exposes only three fixed read-only relay operations. A local file server remains sufficient for testing browser-local features and static data.

```bash
uv run python -m http.server 8766 --directory dist/client
```

Open `http://127.0.0.1:8766` in a desktop browser. The Python process in this command only serves files during local testing. It is not part of the deployed application.

The older comparison runtime remains available with `uv run python app.py`. It is useful for parity checks and local live-data testing, but it is not required by the static application shell, workers, solver, historical data, or degree planner.

## Live University Data

The University APIs work inside University-owned pages because those pages share an origin with the APIs. A separately hosted scheduler is a cross-origin caller. Managed deployment therefore uses same-origin `POST /api/search`, `POST /api/details`, and `POST /api/faculty` routes. The hosting runtime forwards only validated course-search, Course Reference Number detail, and bounded faculty requests to fixed upstream addresses. It returns fresh JSON without forwarding visitor cookies or upstream response headers.

The live client coalesces duplicate requests, limits concurrency, applies short freshness windows, and supports cancellation. Current faculty records use a privacy-safe hash of the University's stable faculty identifier. Email is normalized and displayed as corroborating contact information, while a unique token-bounded name match remains the conservative fallback when no stable identifier is available. If the relay or upstream service is unavailable, the interface labels live availability as unavailable and continues with verified static catalog, grade, and offering data. It never reports an unverified course as closed or not offered.

## Browser Data and Caching

The active release is described by `static/data/manifest.json`. It currently covers 168 catalog subjects, 9,732 courses, 26 completed terms, 213 offering-history subject shards, 4,605 publishable course-grade records, and 6,442 professor aggregates. The immutable release artifacts total about 40 MB, but the browser loads subject and feature shards on demand.

The service worker caches the application shell and content-hashed artifacts. Cache Storage retains immutable files. IndexedDB stores release metadata and fallback records. Local storage retains user-owned plans, pane sizes, collapsed panels, and preferences. A page refresh revalidates the manifest and current live requests while preserving the selected search, course, section, and detail tab in the URL.

The official registrar workbooks remain unchanged in `ANALYSIS_and TODO__UofSC Course Scheduler/uofsc_grade_data`. Generated public artifacts suppress aggregates with fewer than ten counted grades. Banner identifiers, source email addresses, and the private matching database are excluded from the static release.

Historical grade point average uses A, B+, B, C+, C, D+, D, F, and FN outcomes. Withdrawals, audits, incompletes, pass or fail outcomes, transfers, and missing grades are excluded. Team-taught sections remain labeled because section-level outcomes cannot be attributed to one instructor independently.

## Release Generation

The one-time migration and periodic release flow are shown below. Python remains an offline build tool for pulling source data, matching registrar records, generating embeddings, validating privacy, and publishing content-hashed releases. No visitor executes that Python code.

![One-time browser migration and periodic static-data generation](docs/diagrams/data_generation_workflow.png)

Completed-term section data is pulled once and reused for grade matching, professor summaries, enrollment statistics, capacity, and offering history. Catalog records and embeddings regenerate only when bulletin text or the model changes. Campus aliases, curriculum maps, and notices update independently. Immutable artifacts publish before the small mutable manifest so browsers never activate a partial release.

The complete architecture, current file tree, cache policy, deployment dependency, and release cadence are documented in [Browser-First Architecture](docs/ARCHITECTURE.md).

![Current browser-first static architecture](docs/diagrams/browser_first_architecture.png)

## Quality Checks

Run the full formatting, linting, type, Python, JavaScript, static-build, and integrity checks locally.

```bash
uv sync
uv run ruff format .
uv run ruff check . --fix
uv run ty check .
uv run pytest -q
node --test tests/*.js
uv run python scripts/build_static_site.py
```

The current release passes 73 Python tests and 183 JavaScript tests. The builder validates every manifest byte count and SHA-256 digest, rejects representative data by default, excludes application processes and databases from `dist/`, and emits deployment security and cache headers. Production relay verification returned all 19 matching sections for `CSCE 145`, loaded Section 001 details by CRN, and rejected cross-origin and unsupported-method requests.

## Application Structure

```text
static/
├── index.html                     Browser application shell.
├── service-worker.js              Offline shell and immutable-data cache.
├── css/                           Search, schedule, grade, map, and modal styles.
├── js/
│   ├── api.js                     Static data boundary and legacy comparison switch.
│   ├── live-university-client.js  Bounded direct current-term client.
│   ├── data-store.js              Manifest, integrity, Cache Storage, and IndexedDB.
│   ├── solver-core.js             Browser-safe semester solver.
│   ├── solver-worker.js           Schedule-generation worker.
│   ├── runtime/                    Transcript, degree, and offering-analysis cores.
│   └── workers/                    Transcript, degree, and offering-analysis workers.
└── data/
    ├── manifest.json              Mutable active-release pointer.
    ├── releases/                  Immutable catalog, grade, history, and major-map shards.
    ├── course_embeddings.json     Browser semantic-search data.
    ├── phrase_embeddings.json     Generated search phrases.
    ├── pca_params.json            Search projection parameters.
    ├── campus_buildings.json      Campus aliases and coordinates.
    └── site_notices.json          Static maintenance and action banners.

scripts/                           Offline release and static-site builders.
tests/                             Python and JavaScript parity and regression checks.
dist/client/                       Generated static deployment directory.
dist/server/index.js               Managed asset server and fixed live-data relay.
app.py                             Optional legacy comparison runtime.
grade_pipeline.py                  Offline registrar and section matching pipeline.
```

## Site Notices

Maintenance, help, and student-action banners are configured in `static/data/site_notices.json`. Each notice can have an active window and revision. Dismissals are stored by notice identifier and revision, so an updated notice can appear again without an application endpoint.

## Data Sources and License

The application reads course information from `classes.sc.edu`, catalog and prerequisite information from `academicbulletins.sc.edu`, section and instructor information from Banner, official grade-spread workbooks from the University Registrar, and map data from OpenStreetMap services.

The project is maintained by J.C. Vaught and distributed under the MIT license.

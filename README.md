# UofSC Course Scheduler

The UofSC Course Scheduler is a local-first semester planning tool for University of South Carolina students. It searches live course offerings, checks prerequisites, builds conflict-free schedules, compares historical course and professor grade outcomes, summarizes offering and enrollment history, and estimates travel transitions between consecutive classes.

The application focuses on planning one semester effectively. The degree-planning code remains available for later work, but it is not the primary workflow.

![A generated semester schedule with the weekly calendar, campus routes, and ranked schedule options](docs/screenshots/05-schedule-and-routes.png)

## Feature Tour

Course discovery combines direct subject, number, range, and Course Reference Number searches with optional semantic ranking. Results show current availability, concise descriptions, historical grade context, and generated related searches without expanding sections inline.

![Course search results for machine learning](docs/screenshots/01-course-search.png)

Selecting a course opens its full workspace. Students can compare open and full sections, meeting patterns, instructors, locations, seats, Course Reference Numbers, registration restrictions, prerequisites, historical grades, offering history, and official resources before adding a course or exact section.

![Detailed CSCE 145 course and section view](docs/screenshots/02-course-details.png)

<details>
<summary>Professor and historical grade context</summary>

Professor profiles summarize the available teaching span in semesters, typical annual section load, courses taught, and year-by-year grade point average without exposing source identifiers.

![Professor profile with courses taught and grade point average by year](docs/screenshots/03-grades-and-professors.png)

</details>

<details>
<summary>Offering and enrollment history</summary>

Completed-term history shows recent offering frequency, observed seasons, section counts, enrollment, and fill rates with explicit coverage progress.

![Completed-term offering and enrollment history for CSCE 145](docs/screenshots/04-offering-history.png)

</details>

<details>
<summary>Registration handoff</summary>

An applied schedule unlocks a registration checklist with section-specific seat status, course dates, highlighted registration checks, individual Course Reference Number copy actions, and a direct handoff to the official shopping cart.

![Registration checklist for an applied five-course schedule](docs/screenshots/06-registration-info.png)

</details>

The screenshots show a Fall 2026 local session at a desktop viewport. Live sections, seats, instructors, and restrictions can change after capture.

## Local Setup

Install [uv](https://docs.astral.sh/uv/), clone the repository, and prepare the development environment.

```bash
git clone https://github.com/j-vaught/UofSC_scheduler.git
cd UofSC_scheduler
uv sync
```

Start the local server with the following command.

```bash
uv run python app.py
```

Open `http://127.0.0.1:8765` in a browser. Live search, seat checks, offering history, and campus routes require an internet connection. Saved plans stay in the browser through local storage.

## Semester Planning

Search by subject, course number, range, or descriptive phrase. Filters can restrict results to open sections, sections with a specified number of remaining seats, or courses whose known prerequisites appear in the completed-course profile. Selected courses remain available to the solver across successive searches.

The schedule solver applies hard constraints for meeting conflicts, blocked times, and maximum credits. It ranks valid schedules using time-window, instructor, gap, compactness, and consecutive-class preferences. Asynchronous sections remain eligible, while physical sections with unknown meeting times are rejected because their conflicts cannot be verified. Previewing a candidate changes only the calendar until the student explicitly applies it.

The schedule view also evaluates transitions between consecutive classes. It reports available time, route distance, estimated travel time, and remaining buffer. Known campus buildings use pedestrian routing when available and a straight-line estimate as a fallback. Online, same-building, unknown-location, and overlapping transitions receive explicit statuses.

## Historical Data

Official registrar grade workbooks remain unchanged in `ANALYSIS_and TODO__UofSC Course Scheduler/uofsc_grade_data`. The generated `data/grade_analytics.json` file contains only the normalized course and professor summaries required by the application. It does not expose Banner IDs or email addresses.

Professor matching uses the instructor identity attached to each Banner section. A privacy-safe derived identifier separates professors who share the same display name. Grade outcomes are section-level, so team-taught classes are labeled and cannot be attributed to one instructor independently.

Historical grade point average uses A, B+, B, C+, C, D+, D, F, and FN outcomes. Withdrawals, audits, incompletes, pass or fail outcomes, transfers, and missing grades are excluded from the grade point average denominator. The professor experience label measures the available-semester span between the first and last observed section. A label beginning with `>=` means the professor appears in the earliest available semester and may have taught longer. Typical annual teaching load is the median number of section assignments across active academic years.

Rebuild the generated analytics file after adding an official registrar workbook.

```bash
uv run python grade_pipeline.py
```

The pipeline is resumable. It keeps the raw Banner matching cache in `data/grade_matching_cache.sqlite`, which is excluded from version control because it contains source identifiers used only during processing.

## Quality Checks

Run the complete formatting, linting, type, Python test, and browser-module checks locally.

```bash
uv run ruff format .
uv run ruff check . --fix
uv run ty check .
uv run pytest
node tests/test_scheduler_frontend.js
```

## Application Structure

```text
app.py                    Local HTTP server and upstream API proxy.
grade_pipeline.py         Registrar and Banner matching pipeline.
grade_analytics.py        Read-only historical analytics repository.
offering_analyzer.py      Offering and enrollment history analysis.
scheduler.py              Constraint-based semester schedule solver.
data/grade_analytics.json Generated privacy-safe analytics dataset.
static/                    Browser application, styles, and campus data.
docs/                      Architecture diagrams and feature screenshots.
tests/                     Python and JavaScript regression tests.
```

The local web runtime uses the Python standard library. The data preparation workflow uses pandas, openpyxl, and requests through uv. The browser interface is vanilla HTML, CSS, and JavaScript.

## Target Architecture

The documented target moves production computation into the student's desktop browser while retaining Python as an offline data-generation tool. Static hosting provides the application shell, a small release manifest, and immutable historical-data shards. University systems remain the live source for current sections, seats, meeting patterns, and registration details.

![Target browser-first architecture](docs/diagrams/browser_first_architecture.png)

The target file layout, browser cache design, current-to-target module map, deployment dependencies, and migration gates are documented in [Browser-First Architecture](docs/ARCHITECTURE.md). This is a design direction. The current application still uses the local Python runtime described above.

## Data Generation

Completed-term section data is pulled once and reused to build privacy-safe course grades, professor summaries, enrollment statistics, capacity, and offering history. Offering history retains complete section coverage and is not inferred only from published grade workbooks. Catalog embeddings, campus buildings, curriculum maps, and notices update on their own schedules.

![One-time migration and periodic data-generation workflow](docs/diagrams/data_generation_workflow.png)

Immutable, content-hashed files publish before the release manifest. Publishing the manifest last prevents browsers from activating a partial release. The detailed cadence and validation rules are included in [Browser-First Architecture](docs/ARCHITECTURE.md#periodic-data-generation).

## Site Notices

Maintenance, help, and student-action banners are configured in `static/data/site_notices.json`. Set a notice to active and optionally provide ISO-formatted start and end times. Dismissals are stored by notice identifier and revision, so increasing the revision shows an updated notice again. This configuration remains a static file and does not require an application endpoint.

## Data Sources and License

The application reads public course information from `classes.sc.edu`, catalog and prerequisite information from `academicbulletins.sc.edu`, section and instructor information from Banner, official grade-spread workbooks from the University Registrar, and map data from OpenStreetMap services.

The project is maintained by J.C. Vaught and distributed under the MIT license.

# UofSC Course Scheduler

The UofSC Course Scheduler is a local-first semester planning tool for University of South Carolina students. It searches live course offerings, checks prerequisites, builds conflict-free schedules, compares historical course and professor grade outcomes, summarizes offering and enrollment history, and estimates walking transitions between consecutive classes.

The application focuses on planning one semester effectively. The degree-planning code remains available for later work, but it is not the primary workflow.

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

Open `http://127.0.0.1:8765` in a browser. Live search, seat checks, offering history, and walking routes require an internet connection. Saved plans stay in the browser through local storage.

## Semester Planning

Search by subject, course number, range, or descriptive phrase. Filters can restrict results to open sections, sections with a specified number of remaining seats, or courses whose known prerequisites appear in the completed-course profile. Selected courses remain available to the solver across successive searches.

The schedule solver applies hard constraints for meeting conflicts, blocked times, and maximum credits. It ranks valid schedules using time-window, instructor, gap, compactness, and consecutive-class preferences. Asynchronous sections remain eligible, while physical sections with unknown meeting times are rejected because their conflicts cannot be verified. Previewing a candidate changes only the calendar until the student explicitly applies it.

The schedule view also evaluates transitions between consecutive classes. It reports available time, walking distance, estimated walking time, and remaining buffer. Known campus buildings use pedestrian routing when available and a straight-line estimate as a fallback. Online, same-building, unknown-location, and overlapping transitions receive explicit statuses.

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
tests/                     Python and JavaScript regression tests.
```

The local web runtime uses the Python standard library. The data preparation workflow uses pandas, openpyxl, and requests through uv. The browser interface is vanilla HTML, CSS, and JavaScript.

## Data Sources and License

The application reads public course information from `classes.sc.edu`, catalog and prerequisite information from `academicbulletins.sc.edu`, section and instructor information from Banner, official grade-spread workbooks from the University Registrar, and map data from OpenStreetMap services.

The project is maintained by J.C. Vaught and distributed under the MIT license.

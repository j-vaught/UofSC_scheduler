# Gus’ Course Scheduler (for USC)

A desktop-first semester planning tool for University of South Carolina students. Add courses without
committing to sections, optionally lock exact sections, and generate ranked conflict-free schedules. Applying
an option updates the weekly calendar, campus pins, walking-route estimates, and a registration handoff.

Everything interactive runs in the browser. Search ranking, schedule generation, prerequisite evaluation,
offering analysis, and schedule generation are client-side. Hosting serves files and forwards
exactly three validated read-only requests to the University. Plans and transcript-derived progress never
leave the device.

[**Open the live scheduler**](https://scheduler.j-vaught.chatgpt.site/) ·
[**Technical manual**](docs/manual.html)

---

## Interface layout

Two tabs, **SEARCH** and **SCHEDULE**. The term selector sits at the top right and
scopes everything below it.

### SEARCH — a two-panel workspace

Results list on the left, a persistent course detail panel on the right, separated by a divider you can drag
or resize from the keyboard. Selecting a result opens it on the right without losing your place in the list.

![Spring 2027 catalog search for Machine Learning with live availability and historical GPA](docs/screenshots/11-live-search.jpg)

The search box accepts subject codes, exact courses, ranges (`CSCE 140-199`), level shorthand (`CSCE 500+`,
`CSCE 5xx`), CRNs, and descriptive natural-language phrases. The semantic model warms in the background on
first visit. The **Search sources** dropdown expands to show which phrases were generated and how many
results each contributed, so a surprising result set is explainable rather than opaque.

The detail panel keeps a sticky header — course code, title, live section status, credits — above four tabs:
**Overview**, **Grades**, **History**, and **Resources**.

![ELCT 101 course detail showing its Spring 2027 availability and catalog information](docs/screenshots/12-live-course-overview.jpg)

Historical grades show the distribution, counted grades, available historical sections, and the current
instructor's matched record.

![ELCT 101 historical grades with GPA, counted grades, and grade distribution](docs/screenshots/13-live-course-grades.jpg)

Selecting an instructor opens a teaching profile: contact details, courses taught, semesters on record,
typical annual load, GPA by year, and an external review search.

![Professor history with contact information, courses taught, teaching experience, and GPA by year](docs/screenshots/14-professor-profile.jpg)

Offering history uses a year-by-season matrix. Color separates offered, not offered, and unavailable terms,
and each offered term expands to section, enrollment, and fill-rate detail.

![Offering history with recent-term frequency, most recent offering, and a year-by-season matrix](docs/screenshots/15-live-offering-history.jpg)

The Resources tab connects the selected course and section to official class details, bookstore materials,
the academic bulletin, the two-step syllabus archive flow, the faculty directory, and independent course and
professor review searches.

![Course resources with class, bookstore, bulletin, syllabus, and faculty links](docs/screenshots/16-course-resources.jpg)

### SCHEDULE — sidebar, options, calendar, routes

Find and add courses in Search, then use the selected-course sidebar and schedule options in Schedule.
The Generate button uses the calendar-with-repeat icon. Applying a schedule opens its weekly preview and
campus routes in the main right pane. Your Courses collapses, and Schedule Options becomes the left
sidebar. Drag the divider, or use its arrow keys, to resize the two panes. Minimize details to restore
Your Courses and the full option list. Select an option card to reopen details. Export and Registration are inside the viewer, with a credit summary, a credit-weighted estimated GPA using instructor history then course-wide history, an issues-only native browser hint for missing history, full instructor names and email links, and Course Schedule and Course Locations tabs that fill the viewer when scrolled into place. Each full schedule option places its calendar thumbnail, summary, and compact course/section list side by side. Summaries show historical GPA, weekly between-class walking distance, campus days, and online classes when present. Native browser hover hints explain each metric and missing data, with programmatic descriptions for screen readers. Calendar thumbnails retain their larger hover previews. In the narrowed sidebar only Option headings and calendar thumbnails appear. Counts are exact when the search completes and lower bounds when the search limit is reached. The [solver research plan](docs/SCHEDULER_SCALING_RESEARCH.md) describes improving search without limiting selected courses.

![Selected schedule with weekly preview and campus routes](docs/screenshots/17-schedule-inspector.jpg)

![Full schedule option list after minimizing the inspector](docs/screenshots/18-schedule-options.jpg)

![Tuesday campus route for EMCH 514 and CSCE 145](docs/screenshots/19-course-routes.jpg)

All toolbar icons have hover descriptions. The Search icon includes a sparkle when assisted matching is
enabled and a plain magnifying glass when it is disabled. Degree Planner is no longer part of the website;
its earlier implementation remains in the source history and legacy modules.

Registration is a handoff, never an action taken on your behalf. The checklist surfaces per-section warnings,
prerequisites, seat status, and individual CRN copy buttons for pasting into OneCarolina.

![Registration checklist with per-section warnings, seat status, and CRN copy actions](docs/screenshots/06-registration-info.jpg)

### Degrading without lying

When the live relay or the upstream University service is unavailable, the interface labels availability as
unknown and continues from verified static catalog, grade, and offering data. It never reports an unverified
course as closed or not offered.

![Search results labelled live availability unavailable, still showing catalog data and historical GPA](docs/screenshots/08-static-smart-search.jpg)

![Course grades served from static release data while live sections are unavailable](docs/screenshots/09-static-course-grades.jpg)

![Offering history served from static release data while live sections are unavailable](docs/screenshots/10-static-offering-history.jpg)

<details>
<summary><strong>More course examples</strong></summary>

The original search and CSCE 145 examples now use the current interface and Spring 2027.
The instructor example shows Jeremiah Shepherd, the current CSCE 145 instructor.

![Machine Learning catalog search in the current interface](docs/screenshots/01-course-search.jpg)

![CSCE 145 course details and section selection](docs/screenshots/02-course-details.jpg)

![CSCE 145 instructor profile and historical grades](docs/screenshots/03-grades-and-professors.jpg)

![CSCE 145 offering history](docs/screenshots/04-offering-history.jpg)

</details>

> Screenshots use Spring 2027 and a 1024 × 768 CSS-pixel laptop viewport. They retain the original
> course examples and queries. Catalog search includes courses not offered this term, including ELCT 101
> and CSCE 585. Live sections, seats, and instructor assignments change after capture.
> The fallback captures use the current build with the live relay unavailable. Retired degree-planner
> and ELCT 101 schedule images remain in Git history. See the [capture index](docs/screenshots/README.md).

---

## Repository layout

Four data directories encode one distinction: **what can be rebuilt**.

```
tools/                Build + pipeline scripts, and tools/README.md.
                      Name is load-bearing: `from tools.X import Y`.
  src/                Offline data generation — three entry points, run by hand:
                      scrape_courses.py, build_embeddings.py, grade_pipeline.py
  contracts/wire/     The FOSE wire contract — single source of truth for the
                      relay, shared by the build, the JS runtime codec, and tests.

data/
  raw/         249M   Originals with no regeneration path — irreplaceable
  curated/      49M   Machine-extracted, then human-reviewed. Source of truth.
  generated/    26M   Fully rebuildable from raw/ + tools/

static/         66M   THE DEPLOYED SITE. Name is load-bearing — every asset URL
                      is absolute `/static/...` and the release manifest bakes
                      that prefix into all 509 artifacts.

docs/           1.8M  manual.html + screenshots/
tests/                12 Python + 17 JavaScript suites
```

**`raw/` is what you cannot get back.** The 26 registrar workbooks have no regeneration path anywhere, and
the 1,295 official major-map PDFs are hash-verified against a manifest. **`generated/` is what a script
rebuilds** from those. `curated/` sits between them: machine-extracted, then human-reviewed, and the only
tier the release build reads.

A `.gitattributes` marks the generated trees `-diff -merge linguist-generated=true`, so regenerated artifacts
stay out of pull-request diffs and a conflict fails loudly rather than splicing two builds together.

### What ships and what does not

The deployed site is `static/` — one HTML entry point, 31 JavaScript modules, three stylesheets, a service
worker, and a content-addressed release payload of 509 artifacts totalling 39.5 MB, each verified by SHA-256
in the browser before use. No Python ever reaches it; the build refuses to copy `.py`, `.db`, or `.sqlite`
into the output at all.

The only server-side component is a three-route relay — `/api/search`, `/api/details`, `/api/faculty` —
which lives in [`server/index.js`](server/index.js) and is copied verbatim into `dist/server/` at build time.
It validates every request body against an exact shape, caps size and timeout, enforces same-origin, and
forwards no credentials in either direction.

Run it locally against a build:

```bash
uv run python tools/build_static_site.py --allow-representative
node server/dev-server.js
```

---

## Quick start

```bash
git clone https://github.com/j-vaught/UofSC_scheduler.git
cd UofSC_scheduler
uv sync
uv run python tools/build_static_site.py
uv run python -m http.server 8766 --directory dist/client
```

Open `http://127.0.0.1:8766`. It must be served from a **domain root** on **localhost** rather than
`file://` — asset paths are absolute, the service worker registers at scope `/`, and `crypto.subtle` is
unavailable on insecure origins, which the data store treats as a hard failure rather than degrading to
unverified data.

```bash
uv run ruff format . && uv run ruff check . --fix
uv run pytest -q          # 83 passed
node --test tests/*.js    # 237 passed
```

The JavaScript suite runs on the Node built-in test runner. There is no external framework and no
`npm install` step.

---

## Documentation

[**docs/manual.html**](docs/manual.html) is the single technical source — runtime architecture, the relay
contract, Banner field notes, the fifteen-stage build pipeline, the major-map schema and extraction prompt,
the feature roadmap, and known issues. [**tools/README.md**](tools/README.md) covers the build pipeline
specifically.

## Site notices

Maintenance, help, and student-action banners are configured in `static/data/site_notices.json`. Each notice
can carry an active window and a revision. Dismissals are stored by notice identifier and revision, so an
updated notice can reappear without an application endpoint.

## Data sources and license

Course information from `classes.sc.edu`, catalog and prerequisite information from
`academicbulletins.sc.edu`, section and instructor information from Banner, official grade-spread workbooks
from the University Registrar, and map data from OpenStreetMap services.

Maintained by J.C. Vaught and distributed under the MIT license.

The option calendar sits on the left of an equal-height scrollable course list. Search and Schedule navigation use matching search and calendar icons. New visits select the current main semester; once that semester is one-third complete, a remembered prompt offers the next Spring or Fall semester. Explicit term links and saved plans retain their term. Dates use the registrar's first and last class days in Eastern time, with verified calendars through Fall 2029.

Campus route cards use one font size, compact course codes, 24-hour transition times, green departure and red destination building names, and miles alongside walking minutes. The route sidebar stays between 190 and 220 pixels wide on desktop. Single-letter day filters and an All Days calendar icon keep space for the map. Hover, focus, and click highlighting remain available; only travel-time shortages receive a summary.

Current Banner faculty identifiers are session-specific and must not join directly to the historical grade snapshot. Faculty records are deduplicated by email, then matched to a unique full name within the selected course, rejecting conflicting historical email addresses and ambiguous names. The historical record ID drives both GPA estimates and instructor profiles. IDs from other identity sources retain their existing strict matching behavior. Jeremiah Shepherd's CSCE 145 record contains 2,617 grades and a 3.017 historical GPA.

The map extends underneath the transition panel. Short lists end at their last card; longer lists scroll within the available map height. Route framing leaves room for the panel so building pins remain visible.

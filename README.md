# UofSC Course Scheduler

A local-first course scheduling tool for University of South Carolina students. Searches live course data, checks prerequisites, and auto-generates optimal conflict-free schedules.

![Python](https://img.shields.io/badge/python-3.9+-blue) ![Zero Dependencies](https://img.shields.io/badge/dependencies-zero-green) ![License](https://img.shields.io/badge/license-MIT-yellow)

## Features

- **Live course search** — queries UofSC's public course API in real time
- **Prerequisite checking** — input courses you've taken, see which courses you're eligible for (CAN TAKE / PREREQS NEEDED badges)
- **Auto-schedule generation** — CSP solver with backtracking generates top-K conflict-free schedules ranked by your preferences
- **Visual weekly calendar** — color-coded course blocks with conflict detection
- **Time blocking** — click/drag to block out times you're unavailable
- **Professor preferences** — prefer or avoid specific instructors (weighted in schedule scoring)
- **Offering history** — see how often a course has been offered across 10+ terms
- **Prerequisite visualization** — SVG dependency graph showing met/unmet prereqs
- **Multiple plans** — save Plan A / B / C to localStorage for registration day
- **Calendar export** — download .ICS file for Google Calendar, Apple Calendar, Outlook
- **Seat availability** — real-time open/full status from the registrar

## Quick Start

```bash
git clone https://github.com/j-vaught/uosc-scheduler.git
cd uosc-scheduler
python3 app.py
```

Open `http://127.0.0.1:8765` in your browser. That's it — no pip install, no build step, no dependencies.

## How to Use

1. **Enter courses you've already taken** (Step 1) — type course codes like `MATH 242` and press Enter, or paste a comma-separated list
2. **Search for courses** (Step 2) — pick a subject, optionally filter by "I can take (prereqs met)"
3. **Pick sections** (Step 3) — click sections to add them to your calendar. Courses with met prereqs show a green CAN TAKE badge
4. **Generate schedules** — click GENERATE SCHEDULES to auto-find the best conflict-free combinations
5. **Adjust preferences** — use the Preferences tab to block times, set professor preferences, and tune scoring weights
6. **Export** — click EXPORT .ICS to download your schedule for your calendar app

## Architecture

```
uosc-scheduler/
  app.py          # HTTP server + CORS proxy to UofSC APIs (stdlib only)
  cache.py        # SQLite response cache (5min live, 24hr historical)
  scheduler.py    # CSP solver with backtracking + weighted scoring
  prereqs.py      # Bulletin API prerequisite fetcher
  static/
    index.html    # Single-page app
    css/style.css # UofSC garnet/black branding
    js/           # Vanilla JS modules (9 files)
```

**Zero external dependencies.** The backend uses only Python standard library (`http.server`, `sqlite3`, `urllib`, `json`). The frontend is vanilla HTML/CSS/JS with no frameworks or build tools.

## APIs Used

This tool queries two public, unauthenticated UofSC APIs:

- **classes.sc.edu** — live course sections, meeting times, instructors, seat availability
- **academicbulletins.sc.edu** — course catalog, prerequisites, corequisites

A local Python server proxies these requests to handle CORS restrictions. All data is cached in SQLite to minimize API calls.

## Solver

The schedule solver uses a **Constraint Satisfaction Problem (CSP)** approach:

- **Hard constraints**: no time conflicts, no blocked-time violations, credit limits
- **Soft constraints** (weighted scoring): instructor preferences, time window preferences, gap minimization, day compactness, back-to-back avoidance
- **Algorithm**: backtracking search with Most Constrained Variable (MCV) heuristic
- Generates up to 30 candidate schedules and returns the top 10 ranked by score
- 5-second timeout with partial results fallback

## Requirements

- Python 3.9+
- Internet connection (to reach UofSC APIs)
- A web browser

## License

MIT

# UofSC Course Scheduler — UI Design Specification

## Table of Contents

1. [Design Philosophy](#design-philosophy)
2. [Overall Architecture](#overall-architecture)
3. [Layout Structure](#layout-structure)
4. [The User Flow Pipeline](#the-user-flow-pipeline)
5. [Left Panel — Search and Results](#left-panel--search-and-results)
6. [Right Panel — Multi-State Display](#right-panel--multi-state-display)
7. [Right Panel State 1: Schedule Grid](#right-panel-state-1-schedule-grid)
8. [Right Panel State 2: Course Details](#right-panel-state-2-course-details)
9. [Right Panel State 3: Advanced Search](#right-panel-state-3-advanced-search)
10. [Course Cards in Results List](#course-cards-in-results-list)
11. [Section Status Dot System](#section-status-dot-system)
12. [Plan Navigator and Schedule Cycling](#plan-navigator-and-schedule-cycling)
13. [Section Pinning / Fixing](#section-pinning--fixing)
14. [Grid Block Interaction — Mini Popup](#grid-block-interaction--mini-popup)
15. [My Courses Strip](#my-courses-strip)
16. [Color System](#color-system)
17. [Top Navigation](#top-navigation)
18. [Feature Set Summary](#feature-set-summary)
19. [Remaining Design Work](#remaining-design-work)

---

## Design Philosophy

The core principle driving this redesign is: **type something vague, get the right thing, tap once, done.**

The existing UofSC university tools are fragmented across multiple disconnected applications with duplicated features, missing functionality, and poor UI prioritization (e.g., showing CRN and campus prominently when students don't care about those during course selection). USC also removed their auto-scheduler feature. This tool reunifies everything into one coherent experience.

The "drunk test" is the UX benchmark: if someone who is inebriated can find their class and build a schedule, the UI has succeeded. This means:

- Every decision the user has to make is a chance to get confused — minimize decisions.
- Recognition over recall — show options, don't make users memorize codes.
- Smart defaults — filter aggressively so the user sees only what's relevant.
- No mode switching — the interface adapts, the user doesn't navigate to separate pages.
- One primary action is always obvious at every stage.
- Error prevention over error handling — don't let users make mistakes rather than telling them about mistakes after the fact.

---

## Overall Architecture

The application is a **single-page workspace** with a persistent two-panel layout. The user never navigates to separate pages for the core workflow. The left panel handles input (search, filters, results), and the right panel shows output (schedule grid, course details, or advanced search).

The user's journey follows a natural pipeline:

```
DEGREE PLAN → COURSE DISCOVERY → COURSE LIST → SCHEDULE OPTIMIZATION → EXPORT
"what do I     "what courses      "these are     "find me the          "put it in
 still need?"   satisfy that?"     my 5"          best arrangement"     my calendar"
```

Each step feeds into the next without context switching.

---

## Layout Structure

The application uses a **two-panel layout** at all times during the main workflow:

```
┌────────────────────────────────────────────────────────┐
│  APP HEADER (garnet)              TERM: [Fall 2026 ▾]  │
│  HOME | DEGREE PLAN | BROWSE | SCHEDULE | PROFILE | EXPORT │
├──────────────────────┬─────────────────────────────────┤
│                      │                                 │
│   LEFT PANEL         │   RIGHT PANEL                   │
│   (search, filters,  │   (swaps between 3 states)      │
│    results)          │                                 │
│                      │                                 │
│                      │                                 │
│                      │                                 │
│                      │                                 │
│                      │                                 │
└──────────────────────┴─────────────────────────────────┘
```

The left panel is narrower. The right panel takes the majority of the screen width. The only exception is Advanced Search mode, which replaces the entire workspace with a three-panel layout.

---

## The User Flow Pipeline

### Phase 1: "I Know What I Need" (Fast Entry)

The student arrives knowing specific courses (e.g., "EMCH 508", "CSCE 350", "MATH 544"). They type directly into the search box, see results immediately, and add courses by clicking [+] on specific sections. The schedule grid on the right builds up in real time.

The interaction loop is:
1. Type course name/number in search box
2. Results appear in left panel with sections visible
3. Click [+] on desired section
4. Course appears on schedule grid
5. Search box clears, ready for next course
6. Repeat

Target: 3 known courses added in under 60 seconds.

### Phase 2: "I Need to Explore" (Discovery)

After adding known courses, the student's mindset shifts to exploration. They're looking for electives, minor requirements, or concentration courses. They type vaguer queries ("turbulent", "wine", "emch 700+") or use filters.

The same left panel handles this — the search box accepts anything, and results populate. The student clicks course names to investigate (opening the details panel on the right), then clicks [+] on a section to add it (closing details, returning to the schedule grid).

The critical design decision: the student does NOT need to change modes, navigate to a different page, or adjust the interface. The same workspace handles both fast entry and exploratory browsing.

### Transition Between Phases

There is no explicit transition. The interface supports both behaviors simultaneously. A student might add 2 known courses, explore for a third, add another known course, then explore again. The left panel always shows search + results, and the right panel responds to their actions.

---

## Left Panel — Search and Results

### Search Box

The search box is the primary input for the entire application. It is a single text field that accepts any of the following:

- **Subject code**: "emch" → shows all EMCH courses
- **Subject + number**: "EMCH 508" or "emch 508" → shows that specific course
- **Course number only**: "508" → shows all courses numbered 508 across departments
- **Course name/keyword**: "finite element" or "turbulent" → searches course titles and descriptions
- **Instructor name**: "Deng" → shows sections taught by that instructor
- **CRN**: "10883" → shows that specific section
- **Level shorthand**: "EMCH 500+" → shows EMCH courses 500-level and above

The search box has autocomplete/typeahead that shows matching results as the user types. Results show both the course code and full name so recognition replaces recall (e.g., the student typing "mech" sees "EMCH - Mechanical Engineering" appear).

### Filters

Filters are deliberately minimal in the main view. Only one filter is exposed:

- **Delivery Method**: dropdown with options All / Face-to-Face / Online / Hybrid

This is the only filter most students need during normal browsing. Everything else (seat availability, time conflicts, prerequisite status) is communicated through the per-section dot system on course cards.

### Advanced Search Button

Below the delivery method filter, a small button labeled **"Advanced Search"** is available. Clicking this replaces the entire workspace with the three-panel advanced search layout (see Right Panel State 3). This is the escape hatch for power users who need the full filter suite.

### Results List

Results appear below the search box and filters as a scrollable list of course cards. The results list header shows the count: "24 courses (167 total sections)".

When no search has been performed, the results area shows a prompt: "Search a subject above to see available courses."

---

## Right Panel — Multi-State Display

The right panel swaps between three states based on user action. Only one state is visible at a time.

| State | Trigger | Content | How to Exit |
|-------|---------|---------|-------------|
| **Schedule Grid** | Default state; returns after adding a course | Weekly calendar + My Courses strip + plan navigator | N/A (home state) |
| **Course Details** | Click a course name in results list | Full course information panel | Click X, click [+] on a section, or click a different course |
| **Advanced Search** | Click "Advanced Search" button | Three-panel full search workspace | Click "Back" button |

### State Transition Rules

- **Adding a course** ([+] button): Always returns to Schedule Grid state, with the new course visible on the calendar.
- **Clicking a course name**: Always opens Course Details, regardless of current state.
- **Clicking X on details panel**: Returns to Schedule Grid.
- **Clicking "Advanced Search"**: Replaces entire workspace with advanced search layout.
- **Clicking "Back" from advanced search**: Returns to the two-panel layout with Schedule Grid visible.
- **Searching for a new course while in details view**: Details panel stays open but swaps to show the new course if the user clicks a result. If the user just types and looks at results without clicking, the details panel remains showing the previous course.

---

## Right Panel State 1: Schedule Grid

The schedule grid is the default and primary state of the right panel. It consists of three components stacked vertically:

1. My Courses strip (top)
2. Plan Navigator (middle)
3. Weekly calendar grid (main area)

### Weekly Calendar Grid

The grid is a standard weekly calendar view:

- **X-axis**: Days of the week. Default is Monday through Friday (5-day view). If any added course has a section meeting on Saturday or Sunday, the grid automatically expands to a 7-day view.
- **Y-axis**: Time of day, starting from the earliest course and ending at the latest. Time labels appear on the left edge.
- **Course blocks**: Colored rectangles positioned on the grid according to their meeting times. Each block shows the course number (e.g., "508") and instructor last name (e.g., "Deng").
- **Course colors**: Each course is assigned a unique color from the brand accent palette (see Color System section). Colors are consistent across the grid and the My Courses strip.

```
┌──────────────────────────────────────┐
│  MY COURSES (5)         15 credits   │
│  EMCH 508 ✕  CSCE 350 ✕  MATH 544 ✕ │
│  EMCH 741 ✕  HRTM 367 ✕             │
├──────────────────────────────────────┤
│  SCHEDULE  ◄ [1] of 23 ►  [APPLY]   │
├──────┬──────┬──────┬──────┬──────────┤
│      │ MON  │ TUE  │ WED  │ THU  FRI │
│ 8:00 │      │      │      │          │
│      │      │      │      │          │
│ 9:00 │      │      │      │          │
│      │ ▓▓▓▓ │      │ ▓▓▓▓ │          │
│10:00 │ 350  │      │ 350  │     350  │
│      │ Kim  │      │ Kim  │     Kim  │
│10:50 │      │      │      │          │
│11:00 │      │      │      │          │
│      │ ▓▓▓▓ │      │ ▓▓▓▓ │          │
│12:00 │ 544  │      │ 544  │          │
│      │ Park │      │ Park │          │
│      │      │      │      │          │
│ 1:15 │      │ ▓▓▓▓ │      │ ▓▓▓▓    │
│      │      │ 508  │      │ 508     │
│      │      │ Deng │      │ Deng    │
│ 2:30 │      │      │      │          │
└──────┴──────┴──────┴──────┴──────────┘
```

### Empty State

When no courses have been added, the schedule grid area shows a centered message: "Add courses to build your schedule" or similar. The grid lines/headers are still visible but the content area is empty, giving the student a preview of what the filled schedule will look like.

---

## Right Panel State 2: Course Details

When a student clicks a course name in the results list, the right panel switches from the schedule grid to a full course details panel. This panel has an X button in the top-right corner to close it and return to the schedule grid.

### Details Panel Layout and Content Hierarchy

The information is ordered by decision-relevance. The most actionable information appears first; reference information that's only needed for registration appears last.

```
┌─────────────────────────────────────────────┐
│                                          ✕  │
│  EMCH 741 — Viscous and Turbulent Flow      │
│  3 credits | Online                         │
│                                             │
│  ─────────────────────────────────────────  │
│  SECTIONS                                   │
│  ● 001  Ling  TTh 1:15-2:30  22 seats  [+] │
│  ● J60  Ling  TTh 1:15-2:30  18 seats  [+] │
│                                             │
│  ─────────────────────────────────────────  │
│  PREREQUISITES                    ✓ ALL MET │
│  ┌────────────────────────────────────────┐ │
│  │         (prerequisite tree)            │ │
│  │                                        │ │
│  │  Green nodes = completed               │ │
│  │  Red nodes = not completed             │ │
│  └────────────────────────────────────────┘ │
│                                             │
│  ─────────────────────────────────────────  │
│  ⚠ OFFERING HISTORY                        │
│  Typically: Fall only | 3 of 16 terms (19%) │
│  Last: Fall 2025 — Ling, TTh 1:15          │
│  ▸ Show full history                        │
│                                             │
│  ─────────────────────────────────────────  │
│  DESCRIPTION                           ▸    │
│  Viscosity. The Navier-Stokes equation,     │
│  its formulation and its properties.        │
│  Exact solutions of the flow at low         │
│  Reynolds number...                         │
│                                             │
│  ─────────────────────────────────────────  │
│  MORE INFO                             ▸    │
│  Location: SWGN 2A11                        │
│  CRN: 23799                                 │
│  Method: Face-to-Face Instruction           │
│  Notes: Open to Engineering and Computing...│
│                                             │
└─────────────────────────────────────────────┘
```

### Section 1: Title Bar

- **Course code and full name** in large text (e.g., "EMCH 741 — Viscous and Turbulent Flow")
- **Credits** displayed small and inline (e.g., "3 credits"). Most courses are 3 credits, so this is informational but not prominent. Students generally assume 3 credits, so this only needs to be visible, not emphasized.
- **Delivery method** displayed only if it is NOT face-to-face. Face-to-face is the assumed default. Online or Hybrid courses show their method here as a flag. This addresses the student concern about wanting to know if a course is online.

### Section 2: Sections (Immediately Actionable)

This appears directly below the title so the student can add the course without scrolling past anything.

Each section row shows:
- Status dot (colored indicator — see Section Status Dot System)
- Section number (e.g., "001", "J60")
- Instructor last name
- Meeting times (days + time range)
- Seat count (e.g., "22 seats")
- [+] add button

The [+] button is always clickable, even if the dot is red. Students may intentionally add a conflicting or full section because:
- They plan to use the plan navigator/shuffle to resolve conflicts by changing sections of other courses.
- They want to waitlist.
- They're planning optimistically.

When a student clicks [+]:
1. The course and selected section are added to the My Courses strip.
2. The course block appears on the schedule grid.
3. The details panel closes.
4. The right panel returns to the Schedule Grid state.

### Section 3: Prerequisites (Killer Feature)

This is the application's most distinctive and most praised feature. It appears prominently after sections.

- **Header**: "PREREQUISITES" with an inline status badge:
  - "✓ ALL MET" in green if all prerequisites are satisfied
  - "✕ MISSING" in red if any prerequisites are not met
- **Prerequisite Tree**: A visual 2-layer tree diagram.
  - **Top layer**: Prerequisites (courses that must be completed before this course).
  - **Same layer as current course**: Corequisites (courses that must be taken simultaneously or before).
  - **Node coloring**: Green border/fill for completed prerequisites. Red border/fill for incomplete prerequisites.
  - The tree can contain up to approximately 10 nodes. On most screens this fits without issue and does not need to be collapsed or scrolled.
- If the student does not have a profile set up, the tree still displays but without completion coloring. A note indicates "Set up your profile to see prerequisite status."
- If the course has no prerequisites, display "No prerequisites" with no tree.

### Section 4: Offering History (Condensed with Expandable Detail)

Offering history helps students make decisions about rare courses. Instead of presenting a raw table (which tested as "meh" with users), the information is condensed into an actionable summary.

- **Summary line**: "Typically: [semester pattern] | [X] of [Y] terms ([percentage]%)"
  - Example: "Typically: Fall only | 3 of 16 terms (19%)"
- **Last offered line**: "Last: [semester] — [instructor], [time]"
  - Example: "Last: Fall 2025 — Ling, TTh 1:15"
- **Warning flag**: If the course is offered less than 50% of the time (or some threshold), display a warning icon (⚠) next to the "OFFERING HISTORY" header. The intent is to communicate "Rare — take it when you can" without the student having to interpret a data table.
- **Expandable full history**: A "Show full history" link expands to reveal the complete semester-by-semester table (term, offered yes/no, sections, instructor, times) for students who want the full picture. This table matches the existing implementation, with offered semesters highlighted and non-offered semesters grayed out.

### Section 5: Description (Collapsible)

- The course description text from the catalog.
- Collapsed by default with a ▸ chevron to expand. Most students who searched for a course by name already know what it is. Students browsing by keyword may want to read the description to decide.

### Section 6: More Info (Collapsible)

- Contains: Location (building + room), CRN, full method description, notes/restrictions.
- Collapsed by default with a ▸ chevron to expand.
- This information is needed for registration day but not for the decision of whether to take the course.

### Details Panel Dismissal

The details panel closes and returns to the Schedule Grid in any of these cases:
- Student clicks the ✕ button in the top-right corner.
- Student clicks [+] on a section (course is added, panel closes).
- Student clicks a different course name in the results list (panel swaps to show the new course).

---

## Right Panel State 3: Advanced Search

Advanced Search is a power-user mode that provides access to every filter the university's system offers, but in a better layout. It replaces the entire two-panel workspace with a three-panel layout.

### Trigger

Clicking the "Advanced Search" button in the left panel.

### Three-Panel Layout

```
┌───────────────┬──────────────┬──────────────────────┐
│ SEARCH +      │ RESULTS      │ DETAILS              │
│ ALL FILTERS   │              │                      │
│               │              │                      │
│ (Panel 1)     │ (Panel 2)    │ (Panel 3)            │
│ Wide          │ Thin-ish     │ Wide                  │
│               │              │                      │
│               │              │                      │
│               │              │                      │
│ [BACK]        │              │                      │
└───────────────┴──────────────┴──────────────────────┘
```

**Panel 1 — Search + All Filters (left, wide):**

Contains the search box at the top, followed by every available filter stacked vertically:

- Campus
- Subject
- Course number
- Course level (dropdown)
- Start time / End time
- Days of week (M T W Th F Sa Su checkboxes)
- Seats available
- Class size
- Instructor
- Part of term (full term, first half, second half, etc.)
- Delivery method (face-to-face, online, hybrid)
- Honors (checkbox)
- Any other filters from the university's system

This is where all the features cut from the main view live. The philosophy: the main search is simple for 95% of use cases; advanced search serves the 5% who need granular control.

**Panel 2 — Results (middle, thinner):**

A scrollable list of matching courses. Same course card format as the main results list, including section status dots and [+] buttons.

**Panel 3 — Details (right, wide):**

The same course details panel as described in Right Panel State 2. Clicking a course name in the results list populates this panel. The [+] buttons on sections still add courses to the student's schedule (even though the schedule grid is not currently visible).

### My Courses Strip Visibility

The My Courses strip is NOT visible in Advanced Search mode. The student is in research mode. Their course list and schedule grid will be there when they click "Back."

### Adding Courses from Advanced Search

When a student clicks [+] on a section in Advanced Search, the course is added to their schedule (same as in the main view), but the student stays in Advanced Search. They are not kicked back to the main view. This allows them to add multiple courses during an advanced search session.

### Returning to Main View

A "Back" button in the bottom-left of Panel 1 exits Advanced Search and returns to the standard two-panel layout with the Schedule Grid showing (including any courses added during the advanced search session).

---

## Course Cards in Results List

Course cards appear in the left panel results list (main view) and the middle panel results list (advanced search). Each card represents one course and shows all its available sections.

### Card Layout

```
┌─────────────────────────────────────┐
│ EMCH 508  Finite Element Analysis ✓ │
│  ● 001  Deng   TTh 1:15-2:30   [+] │
│  ● J60  Deng   TTh 1:15-2:30   [╳] │
└─────────────────────────────────────┘
```

### Card Components

- **Course code**: Bold, prominent (e.g., "EMCH 508"). Clickable — opens the Course Details panel.
- **Course name**: Regular weight, next to the code (e.g., "Finite Element Analysis"). Also clickable for details.
- **Prerequisite badge**: A small ✓ (green) or ✕ (red) after the course name indicating overall prerequisite status. Only shown if the student has a profile set up. If no profile, no badge.
- **Section rows**: Each available section listed below the course header with:
  - Status dot (colored — see Section Status Dot System)
  - Section number
  - Instructor last name
  - Days + time range (compact format)
  - [+] button to add that specific section

### Interaction

- **Clicking the course name/code**: Opens Course Details in the right panel.
- **Clicking [+] on a section**: Adds the course with that section to the schedule. In the main view, closes any open details panel and shows the schedule grid. In advanced search, stays in advanced search.
- **[+] vs [╳]**: The [+] button is always displayed and always clickable. Even sections with red dots (conflicts, full, prereqs not met) can be added. The student may have valid reasons to add them (e.g., planning to shuffle/pin other sections to resolve conflicts). The [╳] symbol is not used — all sections show [+].

**Correction from earlier discussion**: During the design conversation, [╳] was shown on conflicting sections. The final decision is that all sections should remain clickable with [+], since the student may intentionally add conflicting sections and resolve them via the plan navigator. The dot color communicates the issue; the button remains actionable.

---

## Section Status Dot System

Each section row (in course cards and in the details panel) has a colored dot indicating its status. This replaces the need for most filters — the student can see at a glance what's available and what's problematic.

### Dot Colors

| Color | Meaning |
|-------|---------|
| **Green** | Good to go — seats available, no time conflicts with current schedule, prerequisites met |
| **Yellow** | Warning — low seats remaining, or a minor issue worth noting |
| **Red** | Blocked — section is full, has a time conflict with a course already on the schedule, or prerequisites are not met |
| **Gray** | Unknown — student has no profile set up, so prerequisite status cannot be determined (seats and conflicts can still be checked) |

### Dot Behavior

- **Single issue**: On hover (desktop) or tap (mobile), the dot expands to show a brief explanation:
  - "Section full (0 seats)"
  - "Conflicts with CSCE 350 (MWF 10:00-10:50)"
  - "Missing prereq: EMCH 201"
  - "3 seats remaining" (yellow)

- **Multiple issues**: If a section has more than one issue (e.g., full AND conflicts with another course), the dot shows the worst color (red) and on hover/tap displays: **"Multiple issues"**. The student must click through to the details panel to see the full breakdown of issues. This prevents overwhelming hover tooltips.

### Dot Updates

Dots are dynamic. When a student adds or removes a course from their schedule, the conflict status of all visible sections should update. For example, if the student removes CSCE 350 from their schedule, a section that was red due to a conflict with CSCE 350 should turn green (assuming no other issues).

---

## Plan Navigator and Schedule Cycling

The plan navigator sits between the My Courses strip and the weekly calendar grid. It allows students to browse alternative schedule arrangements using the same courses but different sections.

### Layout

```
SCHEDULE  ◄ [1] of 23 ►  [APPLY]
```

- **◄ ►**: Arrow buttons to cycle through plans one at a time.
- **[1]**: An editable number field. The student can click and type a plan number to jump directly to it (useful when there are hundreds of plans).
- **of 23**: Total number of valid schedule combinations.
- **[APPLY]**: Button to make the currently previewed plan the active/current plan.

### How It Works

- **Plan 1** is always the schedule the student manually built by choosing specific sections. This is the default/current plan.
- **Plans 2 through N** are all other valid combinations of sections for the same set of courses. A "valid" combination means all courses are present with one section each. It does NOT filter out time conflicts — the student may want to see conflicting plans and resolve them by pinning or swapping.
- **No cap** on the number of plans. If there are 500 valid combinations, all 500 are browsable.
- **No preference-based ranking**. Plans are not sorted by morning preference, compactness, or any other heuristic. They are simply all the possible combinations. (Preference-based ranking was considered and explicitly removed from scope during design.)

### Preview vs. Applied

This distinction is critical:

- The **current/applied plan** is what the student has committed to. It's Plan 1 initially (their manual picks), or whichever plan they last clicked "Apply" on.
- **Browsing other plans** is a preview. The calendar grid updates to show the previewed plan, but it is NOT the student's schedule yet.
- If the student **navigates away** (starts searching, opens course details, etc.) while previewing a non-applied plan, the view **snaps back to the current applied plan**. The preview is discarded.
- If the student **adds a new course** from the search results while previewing a plan, the new course is added to the **current applied plan**, not the previewed plan. The preview is discarded and the grid shows the updated applied plan.
- Clicking **[APPLY]** makes the previewed plan the new current plan. Plan 1 is updated. The student can continue from there.

### Visual Distinction for Preview Mode

When viewing a plan other than the current applied plan, the grid or the plan navigator should have a subtle visual indicator that the student is in preview mode. This could be:
- A different background tint on the schedule grid
- A banner: "Previewing Plan 3 — click Apply to use this schedule"
- The [APPLY] button becoming highlighted/prominent

The specific treatment is left to implementation, but the student must be able to tell whether they're looking at their actual schedule or a preview.

---

## Section Pinning / Fixing

When browsing plans, the student may want to say "I definitely want Dr. Ling's TTh section — show me plans that keep that section and only vary the others." This is handled by pinning/fixing sections.

### How to Pin

1. Click on a course block in the weekly calendar grid.
2. The mini popup appears (see Grid Block Interaction section).
3. Select "Fix Section" (shown with a lock icon).
4. The section is now pinned.

### Pinned Section Behavior

- **Visual indicator**: A small lock icon (🔒) appears on the course block in the calendar grid, indicating it is fixed.
- **Plan generation**: When a section is pinned, the plan navigator recalculates. Only plans that include the pinned section are shown. This typically reduces the total plan count significantly (e.g., from 200 plans to 30).
- **Multiple pins**: The student can pin multiple sections. Each additional pin further constrains the plan options.
- **Unpinning**: Click the pinned course block, and the popup shows "Unfix Section" instead of "Fix Section." Clicking it removes the pin and recalculates plans.

### Visual Distinction on Grid

Pinned course blocks should look visually distinct from unpinned ones on the calendar grid. The lock icon is the primary indicator. Optionally, pinned blocks could have a slightly different visual treatment (e.g., solid fill vs. lighter fill for unpinned, or a thicker border) to make it immediately clear which courses are fixed and which may move when cycling plans.

---

## Grid Block Interaction — Mini Popup

Clicking on a course block in the weekly calendar grid opens a small contextual popup anchored to that block. This popup provides quick actions without opening the full details panel.

### Popup Layout

```
┌─────────────────────┐
│ EMCH 508 - Sec 001  │
│ Deng | TTh 1:15     │
│                     │
│ 🔒 Fix Section     │
│ 📄 View Details    │
│ ✕  Remove          │
└─────────────────────┘
```

### Popup Actions

- **Fix Section / Unfix Section**: Toggles the pin state for this section (see Section Pinning). Shows "Fix Section" with a lock icon if unpinned, "Unfix Section" with an unlock icon if pinned.
- **View Details**: Opens the Course Details panel in the right panel (replacing the schedule grid temporarily). Same as clicking the course name in the results list.
- **Remove**: Removes the course entirely from the schedule. The course disappears from the My Courses strip, the block disappears from the grid, and the plan count recalculates.

### Popup Dismissal

The popup closes when:
- The student clicks any action in the popup.
- The student clicks elsewhere on the grid or page.

---

## My Courses Strip

The My Courses strip is a compact horizontal bar that sits above the plan navigator and schedule grid. It shows all courses currently on the student's schedule.

### Layout

```
┌──────────────────────────────────────┐
│  MY COURSES (5)         15 credits   │
│  EMCH 508 ✕  CSCE 350 ✕  MATH 544 ✕ │
│  EMCH 741 ✕  HRTM 367 ✕             │
└──────────────────────────────────────┘
```

### Components

- **Header**: "MY COURSES" with the count in parentheses and total credits on the right.
- **Course tags**: Each course is shown as a compact tag with just the course code (e.g., "EMCH 508") and a small ✕ to remove it. No section numbers, times, or instructor names — that information is on the grid below.
- **Course tag colors**: Each tag is colored to match the course's color on the schedule grid, maintaining visual consistency.

### Interaction

- **Clicking ✕ on a tag**: Removes the course from the schedule. The block disappears from the grid, the plan count recalculates.
- **Clicking the course code**: Could optionally open the details panel, but this is lower priority. The grid block popup and the results list already provide paths to details.

### Visibility

- **Visible**: In the main two-panel layout when the Schedule Grid is the active right panel state.
- **Hidden**: When Course Details panel is open (the details panel takes the full right panel).
- **Hidden**: When in Advanced Search mode.

---

## Color System

### App Chrome

The app header and navigation use the UofSC brand primary colors:

- **Header background**: Garnet (#73000A)
- **Header text**: White (#FFFFFF)
- **Active nav tab**: White background with dark text
- **Inactive nav tabs**: White text on garnet background

Garnet is reserved for app chrome and is NOT used for course block colors, to avoid visual confusion.

### Course Block Colors

Each course added to the schedule is assigned a unique color from the brand accent palette, in this order:

| Assignment Order | Color Name | Hex Code |
|-----------------|------------|----------|
| 1st course | Atlantic (blue) | #466A9F |
| 2nd course | Congaree (teal) | #1F414D |
| 3rd course | Horseshoe (olive) | #65780B |
| 4th course | Rose (red) | #CC2E40 |
| 5th course | Honeycomb (gold) | #A49137 |
| 6th+ courses | Warm Grey | #676156 |

These colors are used for:
- Course blocks on the schedule grid
- Course tags in the My Courses strip
- Any other UI element that needs to identify a specific course visually

### Section Status Dots

| Color | Hex (suggested) | Meaning |
|-------|-----------------|---------|
| Green | #65780B (Horseshoe) or a standard green | Good to go |
| Yellow | #A49137 (Honeycomb) or a standard amber | Warning |
| Red | #CC2E40 (Rose) or a standard red | Blocked |
| Gray | #A2A2A2 (50% Black) | Unknown |

Note: The exact hex values for status dots may need to differ from the course block colors to avoid confusion. A standard traffic-light green/yellow/red may be clearer than reusing brand accent colors for status. This is an implementation decision.

### General UI

- **Backgrounds**: White (#FFFFFF) for content areas. Light gray (#ECECEC or similar) for the left panel background.
- **Text**: Black (#000000) or 90% Black (#363636) for body text. 70% Black (#5C5C5C) for secondary text.
- **Borders and dividers**: 30% Black (#C7C7C7) or 10% Black (#ECECEC).
- **No rounded edges** on any UI elements — buttons, cards, panels, inputs, grid blocks. All corners are sharp/square.
- **High contrast** color schemes throughout.

---

## Top Navigation

The existing top navigation tabs are:

**HOME | DEGREE PLAN | BROWSE | SCHEDULE | PROFILE | EXPORT**

The redesign consolidates Browse and Schedule into the single main workspace. The navigation may need to be reconsidered:

- **HOME**: Landing page / dashboard. Design TBD.
- **DEGREE PLAN**: Separate page for entering and managing degree requirements. This is a setup/configuration step, managed separately since advisors provide this information. However, it should feed into the main workspace — if a student has set up their degree plan, the course browser can offer filters or suggestions based on unfulfilled requirements.
- **BROWSE / SCHEDULE**: These are now the same page — the main workspace described in this document. They could be collapsed into a single tab (e.g., "SCHEDULE BUILDER" or just "SCHEDULE") or the Browse tab could be removed since search is built into the schedule view.
- **PROFILE**: Where the student enters completed courses, major, minor, concentration. This data powers the prerequisite checker and could power degree plan integration.
- **EXPORT**: ICS calendar file export. Could be a button within the schedule grid rather than a separate page.

### Recommended Navigation Simplification

Consider reducing to:

**HOME | DEGREE PLAN | SCHEDULE | PROFILE**

Where "SCHEDULE" is the main workspace (search + browse + build + optimize), and export is a button within it.

This is a recommendation, not a final decision. The navigation structure is listed under "Remaining Design Work."

---

## Feature Set Summary

All features are built (degree plan needs some work). Here is the complete list and how each fits into the redesigned UI:

| Feature | Where It Lives |
|---------|---------------|
| Course search (smart, accepts anything) | Left panel search box |
| Course details (sections, description, notes) | Right panel — Course Details state |
| Prerequisite checker with visual tree | Course Details panel, Section 3 |
| Offering history with frequency analysis | Course Details panel, Section 4 |
| Section status indicators (seats, conflicts, prereqs) | Dot system on course cards and detail sections |
| Schedule builder (weekly grid) | Right panel — Schedule Grid state |
| Plan navigator (browse section combinations) | Plan navigator bar above grid |
| Section pinning | Grid block popup → Fix Section |
| Delivery method filter | Left panel, below search box |
| Advanced search (full university filter set) | Right panel — Advanced Search state (3-panel) |
| Degree plan / requirement tracking | Separate page, feeds into main workspace |
| Student profile (completed courses, major) | Separate page, powers prereq checker |
| ICS calendar export | Button within schedule grid |

---

## Remaining Design Work

The following areas were identified during design but not fully specified:

1. **Top navigation**: How Home, Degree Plan, Browse, Schedule, Profile, Export tabs work together. Recommendation to consolidate exists but is not final.
2. **Degree Plan page**: Layout and interaction for entering/managing degree requirements. How it connects to the main workspace (e.g., "show courses for my unfulfilled requirements" filter or suggestions).
3. **Export flow**: Button placement and interaction for ICS export within the schedule grid.
4. **Empty states**: What the student sees on first visit with no profile, no courses added, no search performed. Onboarding flow if needed.
5. **Mobile / tablet layout**: Whether and how the two-panel layout adapts to smaller screens.
6. **Home page**: What the landing/dashboard page shows. Could include recently viewed courses, current schedule summary, degree progress, etc.
7. **Profile page**: Layout for entering completed courses, major, minor, concentration.
8. **Error states**: What happens when search returns no results, when the API is down, when course data is stale.
9. **Accessibility**: Keyboard navigation, screen reader support, color-blind-friendly alternatives to the dot color system.

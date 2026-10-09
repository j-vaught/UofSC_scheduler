# Schedule sorting and comparison plan

## Purpose

Students balance different needs. Keep Best match as the default because it respects their existing preferences. Offer clear ways to compare schedules without requiring students to understand a numerical preference score. The initial implementation should add one Sort button beside Generate and Preferences. Its icon and text can collapse with the existing toolbar rules. Use a labelled native selection control in its popover so keyboard navigation and the selected value remain clear.

## Recommended choices

| Choice | Order and interpretation |
| --- | --- |
| Best match | Existing preference score, highest first. |
| Fewest campus days | Number of distinct days with campus meetings, lowest first. |
| Least walking | Total distance between campus classes in a recurring week, lowest first. |
| Fewest gaps | Total idle time between classes over the recurring week, lowest first. Show the longest gap separately in details. |
| Later starts | Earliest scheduled class during the week, latest first. Untimed schedules have their own category. |
| Historical GPA estimate | Credit-weighted grade history, highest first, with complete estimates before partial estimates. Missing estimates remain last. |
| More online classes | Online section count, highest first. This remains an optional choice rather than the default. |

Start with Best match, Fewest campus days, Least walking, and Fewest gaps visible. Put the remaining choices under More sort options if the menu becomes crowded. Retain Best match as the tie-breaker, followed by a stable schedule identifier. Remember the chosen sort for the current planning term. Keep explicit section locks and required preferences in force for every ordering.

## Schedule information

| Information | Display and calculation |
| --- | --- |
| Historical GPA estimate | For example, 3.24 estimated GPA. Reuse the selected instructor identity matching, instructor history, course-wide fallback, and credit weighting already used in the viewer. The warning lists missing data and fallbacks. This describes past grades, not a prediction of an individual student's performance. |
| Online classes | For example, 2 online. Count unique selected courses whose section number begins with J, as requested, and reconcile that signal with instructional method data. Treat contradictory method and section signals as a data issue. Distinguish scheduled online meetings from asynchronous courses in details. Hide the card metric when the count is zero. |
| Weekly walking | For example, 4.6 mi/week and 95 min/week. Sum the routes between successive campus locations across the complete recurring week. Exclude home-to-campus commuting. Count same-building routes as zero. Unknown routes remain missing, never zero. Label fallback distance estimates and incomplete totals. |
| Campus days | For example, 3 campus days. Count distinct days with an in-person campus meeting. Online-only days do not count. |
| Daily time range | For example, First class 09:30 and Last class 16:45. Details show each day's actual start and end times. |
| Gaps and travel feasibility | Show weekly idle time, the longest gap, and any transition that lacks enough travel time. Keep idle time distinct from walking time. |
| Credits and meeting hours | Display total credits and scheduled meeting hours per week in the viewer. Credits normally stay constant across options for the same course set, so they do not need a sort choice. |

Begin with GPA, online count when applicable, and weekly walking in a compact summary row on the full option cards. Preserve equal card heights and the existing calendar/course-list arrangement. When the options sidebar is narrow, put the full summary in the enlarged hover/focus preview and selected schedule header. Campus days, gaps, daily ranges, and meeting hours can live in a Schedule summary section in the viewer. Missing or loading information uses descriptive text rather than a zero.

## Data and calculation design

Introduce one shared schedule-summary module used by option cards and the selected viewer. Each metric returns its value, loading state, completeness, and any issues. This prevents the option list and viewer from displaying different GPA estimates or route totals for the same schedule.

Cache grades by course and historical instructor identity, faculty by term and section, and routes by the ordered building pair. Hydrate unique sections and building pairs once, with bounded request concurrency. Cancel or ignore stale work after a new generation or term change. Keep cards usable while their summaries load. A data-dependent sort becomes available once its metric has resolved; background updates must not move a focused or hovered card unexpectedly.

Calculate walking from the entire week's campus meeting sequence, independently of the currently selected map day. Online meetings have no physical destination. For a campus class, an online class, and another campus class, the campus-to-campus move still needs to be counted; available travel time must account for the online meeting. Reuse the existing route cache and routing fallback, but do not sum the current transition list blindly. Missing building locations and unusual meeting-date patterns require an incomplete-total warning.

Give each option a stable identifier based on its selected course and section references. Sorting changes order while retaining the selected schedule, its original Option identifier, and its detail view. This avoids changing which schedule a student believes they applied. Announce the chosen ordering and the number of options reordered without moving keyboard focus.

## Solver limitation and staged implementation

The current solver stops after collecting approximately three times the requested result count, or after its time limit. It ranks that collected set by the existing preference score and returns only the requested number. A browser-only sort therefore cannot recover schedules discarded before the response or discover alternatives the solver never visited.

The first stage should explicitly sort the displayed options. Use wording such as Sort these 10 options. Show more should preserve the chosen ordering and recalculate summaries for the enlarged result set. This is the smallest useful implementation, but it does not establish a global minimum walking distance or maximum historical GPA.

The second stage should pass the chosen objective into generation. Replace the first-solution collection cutoff with a bounded collection of the best candidates encountered for that objective. Retain hard constraints and deterministic tie-breaking. Preload inexpensive grade, location, and travel summaries before the worker search; do not make network requests inside backtracking. Refine routed distance for the retained candidates afterward. If the search times out, describe the result as the best found within the search, and keep the incomplete-search indication. Claim a global optimum only when the full feasible space was searched or the search algorithm proves it.

## Delivery sequence

Implement shared summary calculations first, then the compact card/viewer information, then sorting of displayed options. Change solver objectives only after these calculations agree across both views. Keep mobile access blocked throughout this work.

A verification pass should cover missing grade history, fallback grades, mixed online/campus days, duplicate building pairs, unknown locations, weekend meetings, equal sort values, applied-option preservation, and keyboard use of the Sort control. No sorting or summary calculation changes are part of the current rename and location-time update.

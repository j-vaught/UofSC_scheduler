# Schedule generation research

J.C. Vaught. October 9, 2026.

## Objective

Analyze every selected course and every eligible section without introducing a course-count cap. Every selected course remains mandatory. A large candidate catalog is a separate future feature because choosing a subset of courses changes the problem and requires credit, requirement, and preference rules.

## Current behavior

Two independent research agents inspected the solver and reviewed each other's findings. They agreed on the following constraints. No solver changes were made during this investigation.

| Finding | Source | Consequence |
| --- | --- | --- |
| No explicit course-count or section-count cap. | `static/js/solver-core.js`, `solve`. | Every selected course contributes one section to each complete assignment. |
| Search stops after five seconds. | `static/js/solver-core.js`, `DEFAULT_TIMEOUT_MS`. | A feasible schedule can exist beyond the explored branches. |
| Search also stops after finding three times the requested result count. | `static/js/solver-core.js`, `target` and `backtrack`. | Results are ranked within the collected prefix, not necessarily across all feasible schedules. |
| Course order is fixed by initial section count. | `static/js/solver-core.js`, `sortedCourses`. | The order does not respond to sections ruled out later. |
| Compatibility is checked against previously assigned sections. | `static/js/solver-core.js`, `isConsistent`. | Unassigned courses are not pruned immediately after each choice. |
| Show More reruns generation with a larger requested count. | `static/js/features/scheduler/solve.js`. | Earlier work is repeated instead of resumed. |
| The worker performs synchronous search and sends a final response. | `static/js/solver-worker.js`. | Progress and cooperative cancellation need a different execution loop. |

With section counts $m_1,\ldots,m_n$, the unfiltered search contains up to $\prod_i m_i$ combinations. Therefore removing the course-count cap alone cannot guarantee exhaustive search within a fixed browser time budget. The product requirement should be unlimited input with bounded working memory, responsive controls, and honest incomplete-result reporting.

## Recommended sequence

The first change should separate schedules found, schedules displayed, completion state, and stop reason. Preserve exact counts only when enumeration finishes. When interrupted, report the feasible schedules found so far and explain whether time or cancellation stopped the search. A preference score is an ordering within the explored results unless optimality has been proved.

Next, precompute section compatibility and use forward checking to remove sections incompatible with each assignment. Choose the next course dynamically by its remaining eligible sections, with conflict degree as a tie breaker. This detects impossible branches earlier without removing any selected course. These are standard constraint-satisfaction techniques described in the [Carnegie Mellon course notes](https://www.cs.cmu.edu/~15281-f23/coursenotes/constraints/index.html).

Once pruning is in place, replace the three-times-result early stop with an anytime search. Score each feasible assignment as it is found, retain the best requested results in a bounded structure, and keep exploring until the search completes or the user stops it. The results improve during the run, but they remain provisional until completion or a valid optimality bound. GPA and routing data should be prepared before the search or used to rerank candidates; network requests must not occur inside the combinatorial loop.

The worker should then emit progress and yield between bounded batches of search steps. Add cancellation, a job identifier, and stale-response rejection. Posting a cancellation message cannot interrupt the current synchronous loop. Immediate cancellation can terminate and recreate the worker, as specified by [Worker.terminate](https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate); resumable cancellation instead requires retaining the search stack and yielding cooperatively.

Because Show More currently repeats work, store a continuation session containing the search stack, remaining domains, retained candidates, and input revision. Resume only when courses and preferences still match. Invalidate the session when any input changes.

After those changes, investigate admissible score bounds for branch-and-bound and independent components. A time-conflict graph alone does not prove independence. Credit rules, preferences, and travel scoring can couple components. An external constraint solver should be considered only if profiling shows that the improved browser solver remains inadequate.

## Evaluation plan

Compare small instances against exhaustive enumeration to establish feasibility and ranking correctness. Then measure time to first feasible result, best score over time, visited nodes, peak memory, cancellation latency, and continuation reuse across real course lists and deliberately difficult section combinations. Include online sections, variable credits, blocked periods, walking constraints, and instances with no feasible schedule. The desired outcome is faster useful results without silently dropping courses or claiming an exact total before completion. This evaluation is proposed work and has not been run.

## Decision

Implement compatibility pruning and dynamic course ordering first, followed by bounded best-result retention, progress, cancellation, and continuation. Keep course-count limits out of the interface. Larger input should increase search effort while the interface continues to explain what has and has not been explored.

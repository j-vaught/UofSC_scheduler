# Resumable schedule generation

J.C. Vaught. October 9, 2026.

## Implemented design

Every selected course remains mandatory, and every eligible section remains in the search. Iterative backtracking uses forward checking and chooses the next course by its remaining choices, conflict degree, and course code. Compatibility caching stops growing at 32 MiB; uncached comparisons remain eligible. Required walking rules are evaluated on complete schedules because future meetings can change adjacent transitions.

The first-result collection cutoff has been removed. Search executes in yielding slices of up to 50 milliseconds and pauses after 30 seconds of active computation. Stop requests are checked between slices. Continue reuses the serialized search stack, including interrupted forward checking. The same runner supports workers and the yielding fallback.

## Durability and browsing

Results contain stable section references rather than copies of the catalog. IndexedDB commits each result batch together with its continuation checkpoint before the worker receives acknowledgement. A refresh resumes from the latest committed batch. Session matching includes the term, courses and eligible sections, locks, preferences, catalog revision, and solver version. Changed inputs replace the session for that term without replacing an applied schedule.

Immutable indexed ranking snapshots provide ten-result pages. New results and resolved summaries remain staged until Update results or a new Sort selection. Discovery ordinals remain stable across sorting and pagination. A completed search reports the exact number of feasible schedules; unfinished searches report only how many have been found.

When IndexedDB is unavailable, temporary result storage is limited to 32 MiB and refresh recovery is explicitly unavailable. Storage failures pause the search at its last durable checkpoint. Results are never silently discarded to obtain a better ranking.

## Sorting and metrics

All seven orderings use shared summary calculations. Best match retains the existing preference score. Other orderings compare campus days, weekly walking, total gaps, earliest weekly start, credit-weighted historical GPA, or online course count. Data completeness precedes data-dependent comparisons; preference score and stable identity break ties. Metric values retain full precision for sorting and are rounded only for display.

Grade and credit records are reused by section, routes by ordered building pair, and scheduler data requests share a four-request ceiling. Network requests do not run inside backtracking. Missing data remains missing, and grade fallbacks and travel estimates retain their warnings.

## Acceptance evidence

The engine and store tests compare small searches against independent exhaustive enumeration and exercise incomplete checkpoints, no solutions, required preferences, section locks, missing credits, online and weekend meetings, storage exhaustion, stale messages, worker failure, stable snapshots, and every ordering.

Native browser acceptance completed a 512-result synthetic search, reached the final cursor page, restored the saved checkpoint and snapshot, rejected stale writes, and confirmed every sort retained every result. A difficult 12-course by 20-section search paused in approximately 2 milliseconds. The local Spring 2027 five-course example completed with 528 schedules, preserved the applied detail viewer while sorting, and restored its results after refresh.

These checks describe tested examples rather than a universal completion-time guarantee. A very large combination space can require repeated Continue runs or reach browser storage capacity. No course-count cap or remote solver was introduced. Mobile access remains unsupported.

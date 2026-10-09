# Schedule sorting and comparison

J.C. Vaught. October 9, 2026.

## Implemented interface

Sort sits beside Generate and Preferences as a labelled native selection control. Its seven choices are Best match, Fewest campus days, Least walking, Fewest gaps, Later starts, Historical GPA estimate, and More online classes. The choice is remembered for the planning term.

Every valid schedule found is retained in local session storage. Sorting publishes an immutable snapshot of those results and returns to its first page. Each page contains ten schedules. New discoveries and resolved metrics produce an Update results notice rather than moving cards while a student inspects them. Existing applied schedules and their detail viewer survive sorting and pagination. Option numbers refer to discovery order.

## Comparison rules

Best match uses the existing preference score, descending. Campus days, weekly interclass walking distance, and total gaps sort ascending. Earliest weekly start, historical GPA, and online course count sort descending. Untimed schedules follow schedules with known start times.

Complete observations precede partial observations, which precede unavailable observations. GPA completeness means credit coverage; course-wide grade fallbacks remain usable and keep their warning. Other comparisons use the preference score and stable schedule identity as deterministic tie breakers.

## Shared information

The cards and detail viewer share credit-weighted grade history, instructor matching, course-wide fallback, online detection, recurring campus days, and weekly interclass routes. Missing routes are not interpreted as zero. Walking excludes commuting and retains the campus-to-campus move around an intervening online meeting. Estimated routes and unusual class date patterns remain identified.

Metric loading and search completion are separate. A completed search establishes the exact feasible-schedule count, while unresolved metric data remains identified in the status and ordering. Update results publishes improved summaries when ready. No global ranking claim is made for an unfinished enumeration.

## Continuation

Generation pauses after thirty seconds of active search. Stop and Continue retain committed work. IndexedDB stores the checkpoint and results so a matching plan can recover after refresh. Browser storage denial uses a bounded temporary session with an explicit recovery limitation. Input changes invalidate the corresponding term's search, while a different sort does not.

For algorithm and verification details, see [Resumable schedule generation](SCHEDULER_SCALING_RESEARCH.md).

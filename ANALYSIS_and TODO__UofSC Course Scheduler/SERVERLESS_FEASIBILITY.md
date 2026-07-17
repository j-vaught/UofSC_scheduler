# Serverless Feasibility

## Target architecture

A truly static deployment can serve HTML, CSS, JavaScript, maps, embeddings, catalog records, grade analytics, and periodically generated course snapshots from object storage or a content delivery network. The browser can perform deterministic course filtering, conflict detection, schedule ranking, prerequisite visualization, degree planning, transcript parsing, and semantic search. Browser storage can retain preferences and schedules, while a service worker and IndexedDB can cache larger versioned datasets.

The existing Python request proxy is not only a computation layer. It also provides same-origin access, shared caching, request coalescing, rate control, and isolation from upstream failures. Removing it therefore requires more than translating algorithms into JavaScript.

## Python work that would need a browser port

The schedule solver in `scheduler.py`, degree planner in `planner.py`, prerequisite evaluation in `prereqs.py`, transcript parsing in `transcript.py`, and the derived calculations in `offering_analyzer.py` can be ported to JavaScript. Each port should use shared JSON fixtures and parity tests so that the Python and browser implementations return the same schedules and rankings during the migration. `app.py` and `cache.py` would eventually disappear only after every browser feature has a static or direct-network data source.

The grade ingestion pipeline should remain an offline build task. Its privacy-safe aggregate output can be published as static JSON; spreadsheet parsing and faculty matching do not need to run in a student's browser. The same approach works for major maps, building aliases, course embeddings, offering history, and maintenance or petition banners.

## Browser and upstream limits

Pure browser requests depend on the University's servers allowing Cross-Origin Resource Sharing. The current proxy cannot simply be deleted if course, bulletin, or routing endpoints reject cross-origin requests. Banner session cookies are also likely to be `HttpOnly` or restricted by `SameSite` policy, so a static page on another origin cannot safely reuse them. A browser-only site cannot guarantee current seat counts if the official endpoint is inaccessible from that origin.

Static clients also lack a shared cache. Ten students requesting the same uncached data create ten University requests, whereas the current SQLite cache creates one. Service-worker caching reduces repeated requests for one browser but does not reduce first requests across users. Shipping versioned snapshots is the strongest serverless protection for University systems, with live data limited to explicit refreshes where cross-origin access is permitted.

Secrets cannot be placed in client JavaScript. Any future integration that requires a private key, privileged account, protected write, or server-verified identity still needs a managed function or another trusted process. A maintenance banner can remain serverless by publishing a small signed or versioned JSON configuration alongside the site.

## Incremental migration

The first stage should formalize API response schemas, add request-count instrumentation, and extract solver fixtures. The second stage should port deterministic Python modules one at a time while retaining the Python endpoints as a comparison path. The third stage should publish immutable, versioned catalog, history, grade, building, and major-map bundles and load them through a service worker with IndexedDB persistence. The fourth stage should replace automatic live lookups with snapshot-first reads and an explicit freshness indicator.

Only after direct browser network tests succeed should the request proxy be removed. If the University endpoints do not permit cross-origin use, the fully static product must accept snapshot-based availability, link users to official registration for live verification, or retain a very small managed proxy. An externally scheduled data-build workflow can refresh static snapshots without operating an application server, but it is still a process that must run somewhere and should respect University rate limits.

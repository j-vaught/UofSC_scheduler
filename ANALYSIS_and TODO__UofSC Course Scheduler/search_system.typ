#set page(margin: 1in)
#set text(font: "New Computer Modern", size: 11pt)
#set par(justify: true, leading: 0.65em)
#set heading(numbering: "1.1")

= UofSC Course Scheduler: Search System Architecture

_J.C. Vaught_ \
_April 2026_

== Overview

The search system serves as the primary interface for course discovery. It accepts free-form text input and routes it through one of several specialized pipelines depending on the input pattern. The system combines traditional API-driven search with a client-side semantic search engine powered by pre-computed sentence embeddings and a browser-based transformer model.

All search logic resides in `static/js/search.js`. The entry point is the `doSearch()` method, which parses the user's input and dispatches to the appropriate pipeline.

== Input Classification

When the user submits a query, the system evaluates it against a cascade of regular expressions, tested in priority order. The first match determines the search pipeline.

=== Subject Code (3--4 letters)

Pattern: `^[A-Za-z]{3,4}$` (e.g., `CSCE`, `MATH`).

The input is uppercased and validated against the known subjects list (168 four-letter codes loaded from `/api/subjects` on page init). If the code is not an exact match, Levenshtein edit distance is computed against all known subjects. A single match at distance 1 triggers auto-correction (e.g., `CECS` becomes `CSCE`). Multiple matches at distance 1--2 present clickable "Did you mean?" suggestions. Distances above 2 produce an error.

On match, a subject-level query is sent to the USC API: `{ field: 'subject', value: 'CSCE' }`.

=== Range and Wildcard Patterns

Pattern: `^[A-Za-z]{3,4}\s*[\dxX*#_?%]{1,3}\+?[A-Za-z]?$` with at least one `+` or wildcard character.

This handles inputs like `CSCE 500+`, `CSCE 5xx`, `EMCH 3xxL`, or `CSCE x77`. The subject portion goes through the same Levenshtein validation described above. The numeric portion is parsed into a client-side filter function.

The plus suffix (`500+`) creates a floor filter: courses with number $>=$ the specified value. Wildcard characters (`x`, `X`, `*`, `#`, `_`, `?`, `%`) are all treated as single-digit wildcards. The wildcard portion is converted to a regex (e.g., `5xx` becomes `^5\d\d$`). An optional trailing letter (e.g., `L` in `3xxL`) restricts to lab sections.

The API receives a subject-level query, and the range filter is applied client-side to the returned results.

=== Partial Course Number

Pattern: `^[A-Za-z]{3,4}\s*\d{1,2}$` (e.g., `CSCE 5`, `MATH 55`).

Treated as an implicit wildcard. `CSCE 5` becomes `CSCE 5xx` (500--599). `CSCE 55` becomes `CSCE 55x` (550--559). The subject is validated and a subject-level API query is sent with client-side prefix filtering.

=== Full Course Code

Pattern: `^[A-Za-z]{3,4}\s*\d{3}[A-Za-z]?$` (e.g., `CSCE 145`, `CSCE145`, `emch 327L`).

The subject is validated via Levenshtein. The input is normalized to `SUBJECT NUM` format (e.g., `csce145` becomes `CSCE 145`). An alias query is sent: `{ field: 'alias', value: 'CSCE 145' }`.

=== CRN Lookup

Pattern: `^\d{5}$` (e.g., `12345`).

A direct CRN query is sent to the classes API.

=== Invalid Patterns

Four-digit numbers, bare three-digit numbers without a subject prefix, and one- or two-digit numbers are rejected with specific error messages guiding the user toward valid input.

=== Keyword Search (5+ characters, semantic pipeline)

Any input that does not match the patterns above and is at least 5 characters long enters the semantic search pipeline. This is the most complex path and is described in detail in the following sections.

== Semantic Search Pipeline

The semantic search system combines three data sources to produce ranked results.

1. A browser-side sentence embedding model (Transformers.js with `all-MiniLM-L6-v2`).
2. Pre-computed phrase embeddings extracted from course descriptions (6,313 academic bigrams and trigrams).
3. Pre-computed course embeddings for all 9,732 courses in the catalog (title + description).
4. The live USC bulletin and classes APIs.

=== Step 1: Model and Data Loading

On the first keyword search, the system lazily loads three resources in parallel.

The Transformers.js library and the `Xenova/all-MiniLM-L6-v2` ONNX model are fetched from a CDN. This is approximately 23 MB on first load and is cached by the browser indefinitely. The phrase embeddings file (`phrase_embeddings.json`, 2.4 MB) contains 6,313 academic phrases with their 128-dimensional PCA-reduced int8 vectors. The course embeddings file (`course_embeddings.json`, 4.4 MB) contains all 9,732 courses with their 128-dimensional vectors derived from title + description text. The PCA parameters file (`pca_params.json`, 1 MB) contains the mean vector (384 floats) and the principal components matrix (128 $times$ 384 floats) needed to project new 384-dimensional model outputs into the shared 128-dimensional space.

All files are cached after first load. Subsequent searches skip this step entirely.

=== Step 2: Query Embedding

The user's raw query text (e.g., "car engineering", "brain science", "transfer of heat") is passed directly to the sentence embedding model. The model produces a 384-dimensional normalized vector that captures the semantic meaning of the query. Because this is a general-purpose language model trained on a large English corpus, it understands colloquial terms, misspellings, and non-academic phrasing.

The 384-dimensional vector is then projected into the shared 128-dimensional PCA space by subtracting the precomputed mean and multiplying by the components matrix. The result is L2-normalized to unit length.

=== Step 3: Phrase Expansion

The query vector is compared against all 6,313 pre-computed phrase vectors using cosine similarity. Phrases are academic bigrams and trigrams extracted from course descriptions during a one-time build step (e.g., "deep learning", "heat transfer", "financial markets", "cognitive neuroscience").

Phrases scoring above 0.25 similarity are selected, excluding any phrase that is an exact string match of the original query. The top 8 phrases become expanded search terms. Together with the original query, this produces up to 9 search queries.

For example, "machine learning" expands to: "deep learning", "data mining", "neural networks", "artificial intelligence", "deep neural networks", "statistical programming", "artificial intelligence ai", "supervised training".

=== Step 4: Live API Search

All 9 search queries are fired concurrently to the USC bulletin API (catalog mode) or the USC classes API (current-term mode). Each query is a keyword search against the full course catalog. Concurrent execution means total latency equals the slowest single API call (typically 200--400 ms), not the sum.

Results are deduplicated by course code. A course returned by multiple queries appears only once.

=== Step 5: Local Course Database Search

Simultaneously, the query vector is compared against all 9,732 pre-computed course vectors. These vectors encode the full title + description text of every course in the catalog, so they capture semantic relationships that keyword matching cannot (e.g., a course whose description mentions "machine learning" but whose title does not).

Courses scoring above 0.30 cosine similarity are selected (a higher threshold than phrases because course embeddings are richer). The top 30 local matches are merged into the result set. Any course already found via the API search is skipped to avoid duplicates.

This step ensures that courses are discoverable even when the API's keyword search does not match them.

=== Step 6: Result Scoring and Filtering

Every candidate course (from both the API and local database) is scored by embedding its title through the Transformers.js model. All titles are batch-embedded in a single model call for performance. Each title embedding is PCA-projected and compared against the query vector via cosine similarity.

Courses scoring below 0.15 are discarded as noise. The remaining courses are sorted by descending similarity score and the top 50 are retained.

This step eliminates false positives from the keyword expansion. For example, searching "deep learning" via the API might return an English literature course about "deep reading and learning"; the cosine similarity between "deep reading and learning" and the original query "machine learning" would be low, and the course would be filtered out.

=== Step 7: Availability Cross-Reference

For all courses in the final result set, the system fetches live section data from the classes API for the selected term. This is done by extracting the unique subject codes from the results and firing concurrent subject-level queries.

If "current term only" is checked, courses not offered in the selected term are removed entirely. If "open sections only" is checked, courses with no open sections are also removed.

For catalog mode (current term unchecked), each course receives an availability badge: the term label if sections are open, "FULL" if all sections are closed, or "N/A" if not offered this term.

=== Step 8: Rendering

Results are grouped by course code and displayed with relevance scores driving the sort order. An "Also searched" banner shows the expanded phrases so the user understands how the system interpreted their query. Each course group can be expanded to view individual sections, prerequisites, and offering history.

== Build Process

The search system depends on three pre-computed data files generated by `build_embeddings.py`.

The script loads all 9,732 course records from `course_data.json` (scraped from the USC bulletin API by `scrape_courses.py`). It extracts academic bigrams and trigrams from course titles and descriptions, filtering to phrases that occur in at least 5 courses and at most 5% of courses. Duplicate words within a phrase are excluded.

The `all-MiniLM-L6-v2` sentence transformer model embeds all phrases and all course texts (title + description). PCA is fitted on the combined embedding matrix to reduce from 384 to 128 dimensions, retaining approximately 80% of variance. All vectors are L2-normalized and quantized to int8 (values in $[-128, 127]$) for compact JSON storage.

The outputs are `phrase_embeddings.json` (phrase text to int8 vector), `course_embeddings.json` (course metadata + int8 vector), and `pca_params.json` (mean vector + components matrix). These files are placed in `static/data/` and served as static assets.

The build process needs to be re-run when the course catalog changes significantly (typically once per semester). The phrase vocabulary is derived from course descriptions and is stable across semesters since academic terminology does not change rapidly.

== Fuzzy Subject Matching

All search paths that involve a subject code (subject-only, range, partial, full course code) pass through `_resolveSubject()`. This method computes the Levenshtein edit distance between the user's input and all 168 known subject codes.

The algorithm uses a standard dynamic programming matrix of size $(m+1) times (n+1)$ where $m$ and $n$ are the string lengths. For 4-character subject codes, this is a $5 times 5$ matrix computed 168 times, which is negligible in cost.

The decision logic is as follows. If the input exactly matches a known subject, it is used directly. If there is exactly one match at edit distance 1, the subject is auto-corrected and the search proceeds. If there are multiple matches at distance 1--2, clickable suggestions are displayed. If no match is found within distance 2, an error is shown.

== Data Flow Summary

The system uses two external APIs (USC classes and USC bulletin) and three local data files (phrase embeddings, course embeddings, PCA parameters). The Transformers.js model is loaded from a CDN. All search logic executes in the browser. The local Python server acts only as a caching proxy for the USC APIs and serves static files. No search computation occurs server-side.

/*
 * Subject resolution, semantic matching, and query parsing.
 *
 * One of five parts of the search feature, which was a single 4,248-line
 * module. Each part is a factory returning plain methods; index.js merges them
 * onto one object, so `this` still reaches every method regardless of which
 * file it lives in and no call site changed.
 *
 * The split is at member boundaries only, so concatenating the parts in order
 * reproduces the original object body exactly -- asserted before anything was
 * written. Sorting or regrouping methods would not have that property.
 */
(function initQueryPart(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root.SearchParts) root.SearchParts = {};
    root.SearchParts.createQueryPart = api.createQueryPart;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';

    function createQueryPart(deps) {
        return {
        loadSubjects() {
            if (this._subjects.length) return Promise.resolve(this._subjects);
            if (this._subjectsPromise) return this._subjectsPromise;
            if (!deps.api || typeof deps.api.getSubjects !== 'function') {
                return Promise.resolve(this._subjects);
            }
            this._subjectsPromise = deps.api.getSubjects()
                .then(list => {
                    this._subjects = Array.isArray(list)
                        ? [...new Set(list.map(subject => String(subject).toUpperCase()))]
                        : [];
                    return this._subjects;
                })
                .catch(error => {
                    console.warn('[Search] Subject list unavailable:', error);
                    return this._subjects;
                });
            return this._subjectsPromise;
        },

        // Lazy-load Transformers.js embedding model
        async _loadExtractor() {
            if (this._extractor) return this._extractor;
            if (this._extractorLoading) return this._extractorLoading;
            console.log('[Semantic] Loading Transformers.js model (first time only, ~23MB)...');
            this._extractorLoading = import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2')
                .then(({ pipeline, env }) => {
                    env.allowLocalModels = false;
                    return pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
                        quantized: true,
                    });
                })
                .then(ext => { this._extractor = ext; console.log('[Semantic] Model loaded.'); return ext; })
                .catch(error => {
                    this._extractorLoading = null;
                    throw error;
                });
            return this._extractorLoading;
        },

        // Lazy-load phrase embeddings, course embeddings, and PCA params
        async _loadPhraseData() {
            if (this._phraseData) return;
            const version = encodeURIComponent(this._modelDataVersion);
            const [phraseResp, courseResp, pcaResp] = await Promise.all([
                fetch(`/static/data/phrase_embeddings.json?v=${version}`).then(r => r.json()),
                fetch(`/static/data/course_embeddings.json?v=${version}`).then(r => r.json()),
                fetch(`/static/data/pca_params.json?v=${version}`).then(r => r.json()),
            ]);
            this._phraseData = phraseResp;
            this._courseEmbeddings = courseResp;
            this._pcaParams = pcaResp;
            const dims = phraseResp.dims;

            // Pre-build normalized float32 phrase vectors
            const phrases = Object.keys(phraseResp.phrases);
            this._phraseList = phrases;
            this._phraseVecs = phrases.map(p => {
                const raw = phraseResp.phrases[p];
                const fv = new Float32Array(dims);
                let norm = 0;
                for (let i = 0; i < dims; i++) { fv[i] = raw[i]; norm += raw[i] * raw[i]; }
                norm = Math.sqrt(norm) || 1;
                for (let i = 0; i < dims; i++) fv[i] /= norm;
                return fv;
            });

            // Pre-build normalized float32 course vectors
            this._courseVecs = courseResp.courses.map(c => {
                const fv = new Float32Array(dims);
                let norm = 0;
                for (let i = 0; i < dims; i++) { fv[i] = c.vec[i]; norm += c.vec[i] * c.vec[i]; }
                norm = Math.sqrt(norm) || 1;
                for (let i = 0; i < fv.length; i++) fv[i] /= norm;
                return fv;
            });

            console.log(`[Semantic] Loaded ${phrases.length} phrases + ${courseResp.courses.length} courses + PCA params.`);
        },

        // Embed text using Transformers.js, then apply PCA to match phrase embedding space
        async _embedQuery(text) {
            const extractor = await this._loadExtractor();
            const output = await extractor(text, { pooling: 'mean', normalize: true });
            const raw384 = Array.from(output.data);
            // Apply PCA: (vec - mean) @ components.T
            const mean = this._pcaParams.mean;
            const components = this._pcaParams.components; // shape: [128][384]
            const dims = this._pcaParams.dims;
            const pca = new Float32Array(dims);
            for (let i = 0; i < dims; i++) {
                let sum = 0;
                for (let j = 0; j < raw384.length; j++) {
                    sum += (raw384[j] - mean[j]) * components[i][j];
                }
                pca[i] = sum;
            }
            // Normalize
            let norm = 0;
            for (let i = 0; i < dims; i++) norm += pca[i] * pca[i];
            norm = Math.sqrt(norm) || 1;
            for (let i = 0; i < dims; i++) pca[i] /= norm;
            return pca;
        },

        // Cosine similarity between two float32 vectors
        _cosineSim(a, b) {
            let dot = 0, normA = 0, normB = 0;
            for (let i = 0; i < a.length; i++) {
                dot += a[i] * b[i];
                normA += a[i] * a[i];
                normB += b[i] * b[i];
            }
            return dot / ((Math.sqrt(normA) * Math.sqrt(normB)) || 1);
        },

        // Find nearest pre-computed phrases to a query vector
        _findNearestPhrases(queryVec, topN, excludeQuery) {
            const queryLower = excludeQuery.toLowerCase().trim();
            const scored = [];
            for (let i = 0; i < this._phraseList.length; i++) {
                const p = this._phraseList[i];
                if (p.toLowerCase().trim() === queryLower) continue;
                let dot = 0;
                const pv = this._phraseVecs[i];
                for (let j = 0; j < queryVec.length; j++) dot += queryVec[j] * pv[j];
                if (dot > 0.25) scored.push({ phrase: p, sim: dot });
            }
            scored.sort((a, b) => b.sim - a.sim);
            return scored.slice(0, topN);
        },

        _semanticRequestBudget(scope) {
            const scoped = Boolean(scope?.active);
            return {
                totalLimit: scoped ? 10 : 6,
                keywordLimit: scoped ? 6 : 4,
                subjectLimit: scoped ? 4 : 2,
                batchSize: 2,
                candidateTarget: scoped ? 24 : 18,
            };
        },

        _localSemanticMatches(queryVec, scope, limit = 30) {
            const threshold = 0.30;
            const courses = this._courseEmbeddings?.courses || [];
            const matches = [];
            for (let index = 0; index < courses.length; index += 1) {
                const course = courses[index];
                if (scope?.active && !scope.matches(course.code)) continue;
                const vector = this._courseVecs[index];
                if (!vector) continue;
                let similarity = 0;
                for (let dimension = 0; dimension < queryVec.length; dimension += 1) {
                    similarity += queryVec[dimension] * vector[dimension];
                }
                if (similarity >= threshold) matches.push({ idx: index, sim: similarity });
            }
            matches.sort((left, right) => right.sim - left.sim);
            return matches.slice(0, limit);
        },

        _semanticSubjectPlan(results, scope) {
            const scores = new Map();
            (results || []).forEach((course, index) => {
                const subject = String(course.code || '').trim().split(/\s+/)[0].toUpperCase();
                if (!subject) return;
                const current = scores.get(subject) || {
                    subject,
                    score: Number.NEGATIVE_INFINITY,
                    count: 0,
                    first: index,
                };
                current.score = Math.max(current.score, Number(course._relevanceScore) || 0);
                current.count += 1;
                scores.set(subject, current);
            });
            const ranked = [...scores.values()]
                .sort((left, right) => (
                    right.score - left.score
                    || right.count - left.count
                    || left.first - right.first
                    || left.subject.localeCompare(right.subject)
                ))
                .map(entry => entry.subject);
            if (!scope?.subjects?.length) return ranked;
            const explicit = scope.subjects.map(subject => String(subject).toUpperCase());
            return [
                ...ranked.filter(subject => explicit.includes(subject)),
                ...explicit.filter(subject => !ranked.includes(subject)),
            ];
        },

        async _fetchSemanticLiveSubjects(subjects, searchId, requestBudget) {
            const budget = requestBudget || this._semanticRequestBudget(null);
            const remaining = Math.max(0, budget.totalLimit - (budget.keywordUsed || 0));
            const subjectLimit = Math.min(budget.subjectLimit, remaining);
            const planned = [...new Set((subjects || []).filter(Boolean))].slice(0, subjectLimit);
            const results = [];
            const usedSubjects = [];
            let hadRequestFailure = false;

            for (let offset = 0; offset < planned.length; offset += budget.batchSize) {
                if (searchId !== this._searchId) {
                    return { results: [], subjects: usedSubjects, hadRequestFailure, stale: true };
                }
                const batch = planned.slice(offset, offset + budget.batchSize);
                const responses = await Promise.all(batch.map(async subject => {
                    try {
                        const data = await deps.api.searchCourses(
                            deps.state.term,
                            [{ field: 'subject', value: subject }],
                        );
                        return { results: data.results || [], failed: false };
                    } catch (error) {
                        console.warn(`[Semantic] Live subject search failed for ${subject}:`, error);
                        return { results: [], failed: true };
                    }
                }));
                if (searchId !== this._searchId) {
                    return { results: [], subjects: usedSubjects, hadRequestFailure, stale: true };
                }
                responses.forEach((response, index) => {
                    results.push(...response.results);
                    usedSubjects.push(batch[index]);
                    hadRequestFailure ||= response.failed;
                });
            }
            return { results, subjects: usedSubjects, hadRequestFailure, stale: false };
        },

        // Full semantic search pipeline:
        // 1. Embed query with Transformers.js (understands any colloquial input)
        // 2. Shortlist the local catalog and nearest academic phrases
        // 3. Search a bounded set of live keywords in cancellable batches
        // 4. Score results by embedding similarity to query
        // 5. Filter noise, sort by relevance
        async _doSemanticSearch(
            query,
            currentTermOnly,
            openOnly,
            searchId,
            scope = null,
            onProgress = null,
        ) {
            // Load model + phrase data concurrently
            await Promise.all([this._loadExtractor(), this._loadPhraseData()]);
            if (searchId !== this._searchId) return null;

            // Step 1: Embed query
            const queryVec = await this._embedQuery(query);
            if (searchId !== this._searchId) return null;

            // Step 2: Find local catalog matches before making live requests. The
            // local shortlist helps decide when the live search has enough breadth.
            const topLocal = this._localSemanticMatches(queryVec, scope);
            if (searchId !== this._searchId) return null;

            // Step 3: Find nearest academic phrases and keep a bounded shortlist.
            const budget = this._semanticRequestBudget(scope);
            const nearestPhrases = this._findNearestPhrases(queryVec, 19, query);
            const expandedTerms = nearestPhrases.map(nearest => nearest.phrase);
            if (searchId !== this._searchId) return null;

            const seenTerms = new Set();
            const searches = [query, ...expandedTerms].filter(term => {
                const normalized = String(term || '').trim().toLowerCase();
                if (!normalized || seenTerms.has(normalized)) return false;
                seenTerms.add(normalized);
                return true;
            }).slice(0, budget.keywordLimit);
            console.log(`[Semantic] "${query}" → up to ${searches.length} live keyword calls:`, searches);
            onProgress?.({ phase: 'planned', completed: 0, total: searches.length, candidates: 0 });

            // Step 4: Search in small batches, stopping after enough local or live
            // candidates. A newer search prevents every later batch from starting.
            const allResults = [];
            const usedSearches = [];
            const usedSearchFailures = [];
            const seenCodes = new Set();
            let hadRequestFailure = false;
            for (let offset = 0; offset < searches.length; offset += budget.batchSize) {
                if (searchId !== this._searchId) return null;
                const batchTerms = searches.slice(offset, offset + budget.batchSize);
                const responses = await Promise.all(batchTerms.map(async term => {
                    try {
                        if (currentTermOnly) {
                            const criteria = [{ field: 'keyword', value: term }];
                            if (openOnly) criteria.push({ field: 'stat', value: 'A' });
                            const data = await deps.api.searchCourses(deps.state.term, criteria);
                            return { results: data.results || [], failed: false };
                        }
                        const data = await deps.api.post('/api/bulletin/search', {
                            other: { srcdb: '2026' },
                            criteria: [{ field: 'keyword', value: term }],
                        });
                        return { results: data.results || [], failed: false };
                    } catch (error) {
                        console.warn(`[Semantic] Search failed for “${term}”:`, error);
                        return { results: [], failed: true };
                    }
                }));
                if (searchId !== this._searchId) return null;

                let newCodes = 0;
                responses.forEach((response, index) => {
                    const scopedResults = this.filterByCourseScope(response.results, scope);
                    allResults.push(scopedResults);
                    usedSearches.push(batchTerms[index]);
                    usedSearchFailures.push(response.failed);
                    hadRequestFailure ||= response.failed;
                    scopedResults.forEach(result => {
                        if (result.code && !seenCodes.has(result.code)) {
                            seenCodes.add(result.code);
                            newCodes += 1;
                        }
                    });
                });
                onProgress?.({
                    phase: 'running',
                    completed: usedSearches.length,
                    total: searches.length,
                    candidates: seenCodes.size,
                });
                const enoughCandidates = Math.max(seenCodes.size, topLocal.length)
                    >= budget.candidateTarget;
                const exhaustedUsefulTerms = newCodes === 0
                    && usedSearches.length >= budget.batchSize
                    && seenCodes.size > 0
                    && !responses.some(response => response.failed);
                if (enoughCandidates || exhaustedUsefulTerms) break;
            }
            if (searchId !== this._searchId) return null;

            // Step 5: Merge API results + the local catalog shortlist.
            const coursesData = this._courseEmbeddings.courses;
            console.log(`[Semantic] Local search produced ${topLocal.length} shortlisted courses.`);
            const seen = {};
            const deduped = [];
            // API results first
            for (const batch of allResults) {
                for (const r of batch) {
                    const code = r.code || '';
                    if (!seen[code]) {
                        seen[code] = true;
                        deduped.push(r);
                    }
                }
            }
            // Add local results that weren't already found via API
            let localAdded = 0;
            for (const { idx, sim } of topLocal) {
                const c = coursesData[idx];
                if (!seen[c.code]) {
                    seen[c.code] = true;
                    deduped.push({
                        code: c.code,
                        title: c.title,
                        key: c.key,
                        _fromLocal: true,
                    });
                    localAdded++;
                }
            }
            console.log(`[Semantic] ${deduped.length} total unique (${localAdded} added from local database)`);

            const titledResults = deduped.filter(result => result.title || result.name);
            if (!titledResults.length) {
                const searchMetrics = usedSearches.map((term, index) => ({
                    term,
                    count: new Set((allResults[index] || []).map(result => result.code).filter(Boolean)).size,
                    failed: usedSearchFailures[index],
                }));
                return {
                    results: [],
                    expandedTerms: usedSearches.slice(1),
                    searches: searchMetrics,
                    searchResults: allResults,
                    searchCodes: allResults.map(batch => [...new Set(batch.map(result => result.code).filter(Boolean))]),
                    localResultCodes: [],
                    hadRequestFailure,
                    requestBudget: { ...budget, keywordUsed: usedSearches.length },
                };
            }

            // Step 7: Score each result title by embedding similarity to query
            // Batch-embed all titles at once for performance
            onProgress?.({
                phase: 'combining',
                completed: usedSearches.length,
                total: usedSearches.length,
                candidates: deduped.length,
            });
            const extractor = await this._loadExtractor();
            const titles = titledResults.map(r => r.title || r.name || '');
            const titleOutputs = await extractor(titles, { pooling: 'mean', normalize: true });

            const mean = this._pcaParams.mean;
            const components = this._pcaParams.components;
            const dims = this._pcaParams.dims;
            const embDim = mean.length; // 384

            const SIM_THRESHOLD = 0.15;
            const scored = [];
            for (let i = 0; i < titledResults.length; i++) {
                const title = titledResults[i].title || titledResults[i].name || '';
                // Extract this title's 384-dim vector from batch output
                const offset = i * embDim;
                const raw384 = titleOutputs.data.slice(offset, offset + embDim);
                // Apply PCA
                const pca = new Float32Array(dims);
                for (let d = 0; d < dims; d++) {
                    let sum = 0;
                    for (let j = 0; j < embDim; j++) sum += (raw384[j] - mean[j]) * components[d][j];
                    pca[d] = sum;
                }
                let norm = 0;
                for (let d = 0; d < dims; d++) norm += pca[d] * pca[d];
                norm = Math.sqrt(norm) || 1;
                for (let d = 0; d < dims; d++) pca[d] /= norm;

                const sim = this._cosineSim(queryVec, pca);
                if (sim >= SIM_THRESHOLD) {
                    scored.push({ ...titledResults[i], _relevanceScore: sim });
                }
            }

            // Sort by similarity, take top 50
            scored.sort((a, b) => b._relevanceScore - a._relevanceScore);
            const top = scored.slice(0, 50);

            console.log(`[Semantic] ${deduped.length} candidates → ${scored.length} above threshold → top ${top.length}`);
            const searchMetrics = usedSearches.map((term, index) => ({
                term,
                count: new Set(allResults[index].map(result => result.code).filter(Boolean)).size,
                failed: usedSearchFailures[index],
            }));
            const localResultCodes = [...new Set(top
                .filter(result => result._fromLocal)
                .map(result => result.code)
                .filter(Boolean))];
            return {
                results: top,
                expandedTerms: usedSearches.slice(1),
                searches: searchMetrics,
                searchResults: allResults,
                searchCodes: allResults.map(batch => [...new Set(batch.map(result => result.code).filter(Boolean))]),
                localResultCodes,
                hadRequestFailure,
                requestBudget: { ...budget, keywordUsed: usedSearches.length },
            };
        },

        buildSemanticSearchInfo(semantic, relatedBatches, visibleResults, eligibleOnly, prereqData) {
            const isVisible = code => (
                code
                && (!eligibleOnly || this.checkEligibility(code, prereqData).eligible)
            );
            const visibleCodes = new Set((visibleResults || [])
                .map(result => result.code)
                .filter(isVisible));
            const generatedSearches = (semantic.searches || []).map((search, index) => {
                const matchingCodes = [...new Set((relatedBatches[index] || [])
                    .map(result => result.code)
                    .filter(code => visibleCodes.has(code)))];
                return {
                    ...search,
                    kind: 'generated',
                    count: matchingCodes.length,
                    codes: matchingCodes,
                };
            });

            const catalogCodes = new Set(semantic.localResultCodes || []);
            const visibleCatalogCodes = [...visibleCodes]
                .filter(code => catalogCodes.has(code));
            if (visibleCatalogCodes.length) {
                generatedSearches.push({
                    term: 'Meaning-based catalog matches',
                    kind: 'semantic-catalog',
                    count: visibleCatalogCodes.length,
                    codes: visibleCatalogCodes,
                });
            }
            return generatedSearches.length ? generatedSearches : null;
        },

        // Levenshtein edit distance between two strings
        _editDistance(a, b) {
            const m = a.length, n = b.length;
            const dp = Array.from({ length: m + 1 }, () => new Array(n + 1));
            for (let i = 0; i <= m; i++) dp[i][0] = i;
            for (let j = 0; j <= n; j++) dp[0][j] = j;
            for (let i = 1; i <= m; i++) {
                for (let j = 1; j <= n; j++) {
                    dp[i][j] = a[i - 1] === b[j - 1]
                        ? dp[i - 1][j - 1]
                        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
                }
            }
            return dp[m][n];
        },

        // Find closest subject codes by edit distance. Returns [] if input is an exact match.
        _fuzzyMatchSubject(input) {
            const upper = input.toUpperCase();
            if (this._subjects.includes(upper)) return [];  // exact match, no fuzzy needed
            const scored = this._subjects
                .map(s => ({ code: s, dist: this._editDistance(upper, s) }))
                .filter(s => s.dist <= 2)
                .sort((a, b) => a.dist - b.dist);
            return scored.slice(0, 3);
        },

        // Validate/correct a subject code. Returns corrected code, or null if unresolvable (hint shown).
        _resolveSubject(raw) {
            const upper = raw.toUpperCase();
            if (!this._subjects.length || this._subjects.includes(upper)) return upper;
            const matches = this._fuzzyMatchSubject(upper);
            if (matches.length === 1 && matches[0].dist === 1) {
                // Auto-correct single close match
                return matches[0].code;
            }
            if (matches.length > 0) {
                const links = matches.map(m =>
                    `<a href="#" class="fuzzy-suggestion" data-code="${m.code}">${m.code}</a>`
                ).join(', ');
                this.showHint(`Unknown subject "${upper}". Did you mean: ${links}?`);
                document.querySelectorAll('.fuzzy-suggestion').forEach(el => {
                    el.addEventListener('click', (e) => {
                        e.preventDefault();
                        const input = this.activeSearchInput();
                        input.value = input.value.replace(/^[A-Za-z]{3,4}/i, e.target.dataset.code);
                        this.doSearch();
                    });
                });
            } else {
                this.showHint(`Unknown subject "${upper}". Check the code and try again.`);
            }
            return null;
        },

        _resolveSubjectForLiveSearch(raw) {
            const upper = String(raw || '').toUpperCase();
            if (!this._subjects.length || this._subjects.includes(upper)) return upper;
            const matches = this._fuzzyMatchSubject(upper);
            if (matches.length === 1 && matches[0].dist === 1) return matches[0].code;
            if (matches.length > 0) {
                throw new Error(`Unknown subject "${upper}". Try ${matches.map(match => match.code).join(', ')}.`);
            }
            throw new Error(`Unknown subject "${upper}". Check the code and try again.`);
        },

        liveCourseRangeFilter(numberPattern) {
            const pattern = String(numberPattern || '').toUpperCase();
            if (/^\d{1,3}\+$/.test(pattern)) {
                const floor = parseInt(pattern.slice(0, -1));
                return code => {
                    const match = String(code || '').match(/^[A-Z]+\s*(\d{3})/i);
                    return Boolean(match && parseInt(match[1]) >= floor);
                };
            }
            const wildcard = pattern.match(/^([\dX*#_?%]{1,3})([A-Z]?)$/);
            if (wildcard && /[X*#_?%]/.test(wildcard[1])) {
                const digits = (wildcard[1] + 'XX').slice(0, 3);
                const number = new RegExp(`^${digits.replace(/[X*#_?%]/g, '\\d')}$`);
                const suffix = wildcard[2];
                return code => {
                    const match = String(code || '').match(/^[A-Z]+\s*(\d{3})([A-Z]?)$/i);
                    return Boolean(match
                        && number.test(match[1])
                        && (!suffix || match[2].toUpperCase() === suffix));
                };
            }
            return null;
        },

        courseNumberRangeFilter(subject, firstNumber, lastNumber) {
            const lower = Number(firstNumber);
            const upper = Number(lastNumber);
            if (!Number.isInteger(lower) || !Number.isInteger(upper) || lower > upper) {
                throw new Error('The first course number in a range must be lower than the last.');
            }
            const normalizedSubject = String(subject || '').toUpperCase();
            return code => {
                const match = String(code || '').match(/^([A-Z]+)\s*(\d{3})[A-Z]?$/i);
                if (!match || match[1].toUpperCase() !== normalizedSubject) return false;
                const number = Number(match[2]);
                return number >= lower && number <= upper;
            };
        },

        parseCourseCodeParts(value) {
            const match = String(value || '').trim().toUpperCase()
                .match(/^([A-Z]{2,5})\s+([A-Z]?)(\d{3})([A-Z]?)$/);
            if (!match) return null;
            return {
                subject: match[1],
                prefix: match[2],
                number: Number(match[3]),
                digits: match[3],
                suffix: match[4],
            };
        },

        parseSubjectScope(rawValue) {
            const raw = String(rawValue || '').trim();
            if (!raw) return { subjects: [], normalized: '' };
            const tokens = raw
                .split(/[\s,;|\/&]+/)
                .map(token => token.trim().toUpperCase())
                .filter(Boolean);
            const invalid = tokens.find(token => !/^[A-Z]{2,5}$/.test(token));
            if (invalid) {
                throw new Error('Subject codes use only 2–5 letters. Separate multiple subjects with spaces or semicolons.');
            }
            const subjects = [...new Set(tokens)];
            const unknown = this._subjects.length
                ? subjects.find(subject => !this._subjects.includes(subject))
                : null;
            if (unknown) {
                const suggestions = this._fuzzyMatchSubject(unknown).map(match => match.code);
                const guidance = suggestions.length
                    ? ` Try ${suggestions.join(', ')}.`
                    : ' Check the code and try again.';
                throw new Error(`Unknown subject "${unknown}".${guidance}`);
            }
            if (subjects.length > 12) {
                throw new Error('Use 12 or fewer subjects in one search.');
            }
            return { subjects, normalized: subjects.join('; ') };
        },

        parseNumberScope(rawValue) {
            const raw = String(rawValue || '')
                .trim()
                .replace(/[–—]/g, '-')
                .replace(/\s+/g, ' ')
                .toUpperCase();
            if (!raw) return { kind: 'any', normalized: '', matches: () => true };

            const range = raw.match(/^(\d{3})\s*(?:-|TO)\s*(\d{3})$/);
            if (range) {
                const lower = Number(range[1]);
                const upper = Number(range[2]);
                if (lower > upper) {
                    throw new Error('The first course number must be lower than the last.');
                }
                return {
                    kind: 'range',
                    normalized: `${range[1]}-${range[2]}`,
                    matches: parts => parts.number >= lower && parts.number <= upper,
                };
            }

            if (/^\d{1,3}\+$/.test(raw)) {
                const lower = Number(raw.slice(0, -1));
                return {
                    kind: 'minimum',
                    normalized: `${lower}+`,
                    matches: parts => parts.number >= lower,
                };
            }

            const wildcard = raw.match(/^([\dX*#_?%]{1,3})([A-Z]?)$/);
            if (wildcard && /[X*#_?%]/.test(wildcard[1])) {
                const pattern = (wildcard[1] + 'XXX').slice(0, 3);
                const numberPattern = new RegExp(`^${pattern.replace(/[X*#_?%]/g, '\\d')}$`);
                const suffix = wildcard[2];
                return {
                    kind: 'wildcard',
                    normalized: `${pattern.replace(/[X*#_?%]/g, 'x')}${suffix}`,
                    matches: parts => numberPattern.test(parts.digits)
                        && (!suffix || parts.suffix === suffix),
                };
            }

            const exact = raw.match(/^(\d{3})([A-Z]?)$/);
            if (exact) {
                const suffix = exact[2];
                return {
                    kind: 'exact',
                    normalized: `${exact[1]}${suffix}`,
                    matches: parts => parts.digits === exact[1]
                        && (!suffix || parts.suffix === suffix),
                };
            }

            throw new Error('Use a course number such as 585, 500+, 5xx, or 100-500.');
        },

        parseCompactScopedQuery(rawValue) {
            const raw = String(rawValue || '').trim();
            if (!raw.includes('::')) return null;
            if ((raw.match(/::/g) || []).length !== 1) {
                throw new Error('Use one “::” between the course scope and topic.');
            }
            const delimiterIndex = raw.indexOf('::');
            const scopeText = raw.slice(0, delimiterIndex).trim();
            const topic = raw.slice(delimiterIndex + 2).trim();
            if (!scopeText) throw new Error('Add subjects or course numbers before “::”.');
            if (!topic) throw new Error('Add what you want to learn after “::”.');

            const normalizedScope = scopeText.replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
            const numberMatch = normalizedScope.match(
                /(\d{3}\s*(?:-|to)\s*\d{3}|[\dXx*#_?%]{1,3}\+?[A-Za-z]?)$/i,
            );
            const numberText = numberMatch ? numberMatch[1] : '';
            const subjectText = numberMatch
                ? normalizedScope.slice(0, numberMatch.index).trim().replace(/[;,|\/&\s]+$/, '')
                : normalizedScope;
            const subjectScope = this.parseSubjectScope(subjectText);
            const numberScope = this.parseNumberScope(numberText);
            if (!subjectScope.subjects.length && numberScope.kind === 'any') {
                throw new Error('Add at least one subject or course-number limit before “::”.');
            }
            return {
                compact: true,
                topic,
                subjects: subjectScope.subjects,
                subjectText: subjectScope.normalized,
                numberText: numberScope.normalized,
            };
        },

        parseStandaloneCourseScope(rawValue) {
            const raw = String(rawValue || '').trim();
            if (!raw || raw.includes('::')) return null;
            const subjectTokens = raw
                .replace(/(\d{3}\s*(?:-|–|—|to)\s*\d{3}|[\dXx*#_?%]{1,3}\+?[A-Za-z]?)$/i, '')
                .trim()
                .split(/[\s,;|\/&]+/)
                .filter(Boolean);
            const validSubjectShape = subjectTokens.length > 1
                && subjectTokens.every(token => /^[A-Za-z]{2,5}$/.test(token));
            const uppercaseSubjects = subjectTokens.length > 1
                && subjectTokens.every(token => /^[A-Z]{2,5}$/.test(token));
            const knownSubjects = this._subjects.length > 0
                && subjectTokens.length > 1
                && subjectTokens.every(token => this._subjects.includes(token.toUpperCase()));
            const hasNumberLimit = /(\d{3}\s*(?:-|–|—|to)\s*\d{3}|[\dXx*#_?%]{1,3}\+?[A-Za-z]?)$/i
                .test(raw);
            const deliberateSubjectList = this._subjects.length
                ? knownSubjects
                : uppercaseSubjects && hasNumberLimit;
            if (!validSubjectShape || !deliberateSubjectList) {
                return null;
            }

            const parsed = this.parseCompactScopedQuery(`${raw} :: scope`);
            if (parsed.subjects.length === 1) return null;
            return {
                subjects: parsed.subjects,
                subjectText: parsed.subjectText,
                numberText: parsed.numberText,
            };
        },

        buildCourseScope(subjectValue = '', numberValue = '') {
            const subjectScope = this.parseSubjectScope(subjectValue);
            const numberScope = this.parseNumberScope(numberValue);
            const subjectSet = new Set(subjectScope.subjects);
            return {
                subjects: subjectScope.subjects,
                subjectText: subjectScope.normalized,
                numberText: numberScope.normalized,
                numberKind: numberScope.kind,
                active: subjectScope.subjects.length > 0 || numberScope.kind !== 'any',
                matches: code => {
                    const parts = this.parseCourseCodeParts(code);
                    if (!parts) return false;
                    if (subjectSet.size && !subjectSet.has(parts.subject)) return false;
                    return numberScope.matches(parts);
                },
            };
        },

        filterByCourseScope(results, scope) {
            if (!scope?.active) return results;
            return (results || []).filter(result => scope.matches(result.code));
        },

        scopedSubjectsForQuery(querySubject, scope) {
            const normalizedSubject = String(querySubject || '').toUpperCase();
            if (!normalizedSubject) return [...(scope?.subjects || [])];
            if (!scope?.subjects?.length) return [normalizedSubject];
            return scope.subjects.includes(normalizedSubject) ? [normalizedSubject] : [];
        },

        async searchLiveCourses(rawInput) {
            const query = String(rawInput || '').trim();
            if (!query) throw new Error('Enter a subject code, course number, CRN, range, or keyword.');
            const searchId = ++this._searchId;
            await this.loadSubjects();
            if (searchId !== this._searchId) return { results: [], semantic: false, stale: true };

            const compactQuery = this.parseCompactScopedQuery(query);
            const standaloneScope = compactQuery ? null : this.parseStandaloneCourseScope(query);
            const scopedSearch = Boolean(compactQuery || standaloneScope);
            const directQuery = compactQuery?.topic || (standaloneScope ? '' : query);
            const courseScope = this.buildCourseScope(
                compactQuery?.subjectText || standaloneScope?.subjectText || '',
                compactQuery?.numberText || standaloneScope?.numberText || '',
            );
            const wildcardPattern = /[xX*#_?%]/;
            const criteria = [];
            let resultFilter = null;

            if (scopedSearch) {
                if (directQuery) criteria.push({ field: 'keyword', value: directQuery });
            } else if (/^[A-Za-z]{3,4}$/.test(directQuery)) {
                const subject = this._resolveSubjectForLiveSearch(directQuery);
                criteria.push({ field: 'subject', value: subject });
            } else if (/^[A-Za-z]{3,4}\s*\d{3}\s*(?:-|–|—|to)\s*\d{3}$/i.test(directQuery)) {
                const match = directQuery.match(/^([A-Za-z]{3,4})\s*(\d{3})\s*(?:-|–|—|to)\s*(\d{3})$/i);
                const subject = this._resolveSubjectForLiveSearch(match[1]);
                resultFilter = this.courseNumberRangeFilter(subject, match[2], match[3]);
                criteria.push({ field: 'subject', value: subject });
            } else if (/^[A-Za-z]{3,4}\s*[\dxX*#_?%]{1,3}\+?[A-Za-z]?$/.test(directQuery)
                && (directQuery.includes('+') || wildcardPattern.test(directQuery))) {
                const match = directQuery.match(/^([A-Za-z]{3,4})\s*([\dxX*#_?%]{1,3}\+?[A-Za-z]?)$/);
                const subject = this._resolveSubjectForLiveSearch(match[1]);
                resultFilter = this.liveCourseRangeFilter(match[2]);
                if (!resultFilter) throw new Error('Invalid range pattern. Try CSCE 500+, CSCE 5xx, or CSCE 5xxL.');
                criteria.push({ field: 'subject', value: subject });
            } else if (/^[A-Za-z]{3,4}\s*\d{1,2}$/.test(directQuery)) {
                const match = directQuery.match(/^([A-Za-z]{3,4})\s*(\d{1,2})$/);
                const subject = this._resolveSubjectForLiveSearch(match[1]);
                const prefix = match[2];
                resultFilter = code => {
                    const number = String(code || '').match(/^[A-Z]+\s*(\d{3})/i);
                    return Boolean(number && number[1].startsWith(prefix));
                };
                criteria.push({ field: 'subject', value: subject });
            } else if (/^[A-Za-z]{3,4}\s*\d{3}[A-Za-z]?$/.test(directQuery)) {
                const match = directQuery.match(/^([A-Za-z]{3,4})\s*(\d{3}[A-Za-z]?)$/);
                const subject = this._resolveSubjectForLiveSearch(match[1]);
                criteria.push({ field: 'alias', value: `${subject} ${match[2].toUpperCase()}` });
            } else if (/^\d{5}$/.test(directQuery)) {
                criteria.push({ field: 'crn', value: directQuery });
            } else if (/^\d{4}$/.test(directQuery)) {
                throw new Error('A CRN has 5 digits. For a course, include its subject, such as CSCE 145.');
            } else if (/^\d{3}\s?[A-Za-z]?$/.test(directQuery)) {
                throw new Error('Include the subject code, such as CSCE 145.');
            } else if (/^\d{1,2}$/.test(directQuery)) {
                throw new Error('Enter a subject code or full course number, such as CSCE 145.');
            } else if (directQuery.length < 5) {
                throw new Error('Keywords must be at least 5 characters.');
            } else {
                criteria.push({ field: 'keyword', value: directQuery });
            }

            const batches = courseScope.subjects.length
                ? await Promise.all(courseScope.subjects.map(subject => deps.api.searchCourses(
                    deps.state.term,
                    [...criteria, { field: 'subject', value: subject }],
                )))
                : [await deps.api.searchCourses(deps.state.term, criteria)];
            if (searchId !== this._searchId) return { results: [], semantic: false, stale: true };
            let results = batches.flatMap(data => data.results || []);
            if (resultFilter) {
                results = results.filter(result => resultFilter(result.code || ''));
            }
            results = this.filterByCourseScope(results, courseScope);
            return {
                results,
                semantic: false,
                queryType: /^\d{5}$/.test(directQuery)
                    ? 'crn'
                    : scopedSearch
                        ? 'scoped'
                        : criteria.some(item => item.field === 'keyword') ? 'keyword' : 'structured',
                crn: /^\d{5}$/.test(directQuery) ? directQuery : null,
            };
        },

        };
    }

    return { createQueryPart };
}));

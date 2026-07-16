/* Course search UI */
const Search = {
    _prereqCache: {},
    _searchId: 0,
    _subjects: [],
    _subjectsPromise: null,
    _extractor: null,       // Transformers.js pipeline (lazy-loaded)
    _extractorLoading: null,
    _phraseData: null,       // pre-computed phrase embeddings
    _phraseVecs: null,       // normalized float32 phrase vectors
    _pcaParams: null,        // PCA mean + components
    _courseEmbeddings: null,  // pre-computed course embeddings (title+desc)
    _courseVecs: null,        // normalized float32 course vectors
    _bulletinCourseCache: {},
    _bulletinDetailsCache: {},
    _carolinaCoreCache: {},
    _sectionDetailCache: {},
    _resultSummaryCache: {},
    _resultSummaryObserver: null,
    _smartModelPromise: null,
    _browseState: 'empty',
    _detailGroup: null,
    _detailSectionCrn: '',
    _detailTab: 'overview',
    _detailLoads: {},
    _lastDetailTrigger: null,
    _facultyCache: {},
    _directSearchOnce: false,
    _topicSearchMode: false,
    _semanticFallbackOnce: false,
    _semanticFallbackNotice: '',
    _mainSearchQuery: '',
    _relatedSearchOrigin: '',
    _restoringHistory: false,
    _restoreId: 0,
    _detailMap: null,
    _detailLocationMarkers: [],
    _filterPreviousFocus: null,
    _detailTimeLocationPreferenceKey: 'uofsc-course-time-location-expanded-v1',
    // Intentionally memory-only so a browser reload forces fresh search data.
    _searchViewCache: new Map(),
    _searchCacheTtlMs: 60 * 60 * 1000,
    _searchCacheMaxEntries: 30,

    loadSubjects() {
        if (this._subjects.length) return Promise.resolve(this._subjects);
        if (this._subjectsPromise) return this._subjectsPromise;
        if (typeof fetch !== 'function') return Promise.resolve(this._subjects);
        this._subjectsPromise = fetch('/api/subjects')
            .then(response => {
                if (response.ok === false) throw new Error('Subject list unavailable.');
                return response.json();
            })
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
            .then(({ pipeline }) => pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true }))
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
        const [phraseResp, courseResp, pcaResp] = await Promise.all([
            fetch('/static/data/phrase_embeddings.json').then(r => r.json()),
            fetch('/static/data/course_embeddings.json').then(r => r.json()),
            fetch('/static/data/pca_params.json').then(r => r.json()),
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

    // Full semantic search pipeline:
    // 1. Embed query with Transformers.js (understands any colloquial input)
    // 2. Find nearest academic phrases from pre-computed embeddings
    // 3. Search live API with those phrases (concurrent)
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

        // Step 2: Find nearest academic phrases
        const nearestPhrases = this._findNearestPhrases(queryVec, 19, query);
        const expandedTerms = nearestPhrases.map(n => n.phrase);
        if (searchId !== this._searchId) return null;

        // Step 3: Build search list — original query + expanded phrases
        const searches = [query, ...expandedTerms];
        console.log(`[Semantic] "${query}" → up to ${searches.length} API calls:`, searches);
        onProgress?.({ phase: 'planned', completed: 0, total: searches.length, candidates: 0 });

        // Step 4: Search in small concurrent batches. Once at least ten searches
        // have run, stop early when a batch produces no new scoped courses.
        const allResults = [];
        const usedSearches = [];
        const usedSearchFailures = [];
        const seenCodes = new Set();
        let hadRequestFailure = false;
        const batchSize = 5;
        for (let offset = 0; offset < searches.length; offset += batchSize) {
            const batchTerms = searches.slice(offset, offset + batchSize);
            const responses = await Promise.all(batchTerms.map(async term => {
                try {
                    if (currentTermOnly) {
                        const criteria = [{ field: 'keyword', value: term }];
                        if (openOnly) criteria.push({ field: 'stat', value: 'A' });
                        const data = await API.searchCourses(State.term, criteria);
                        return { results: data.results || [], failed: false };
                    }
                    const data = await API.post('/api/bulletin/search', {
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
            const batchFailed = responses.some(response => response.failed);
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
            if (usedSearches.length >= 10
                && seenCodes.size > 0
                && newCodes === 0
                && !batchFailed) break;
        }
        if (searchId !== this._searchId) return null;

        // Step 5: Local course search — find top matches from pre-computed
        // course embeddings (title+description). These catch courses the API
        // keyword search might miss.
        const LOCAL_SIM_THRESHOLD = 0.30;
        const localMatches = [];
        const coursesData = this._courseEmbeddings.courses;
        for (let i = 0; i < coursesData.length; i++) {
            let dot = 0;
            const cv = this._courseVecs[i];
            for (let j = 0; j < queryVec.length; j++) dot += queryVec[j] * cv[j];
            if (dot >= LOCAL_SIM_THRESHOLD
                && (!scope?.active || scope.matches(coursesData[i].code))) {
                localMatches.push({ idx: i, sim: dot });
            }
        }
        localMatches.sort((a, b) => b.sim - a.sim);
        const topLocal = localMatches.slice(0, 30);
        console.log(`[Semantic] Local search: ${localMatches.length} above ${LOCAL_SIM_THRESHOLD}, using top ${topLocal.length}`);

        // Step 6: Merge API results + local results, dedupe by course code
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
                hadRequestFailure,
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
        return {
            results: top,
            expandedTerms: usedSearches.slice(1),
            searches: searchMetrics,
            searchResults: allResults,
            searchCodes: allResults.map(batch => [...new Set(batch.map(result => result.code).filter(Boolean))]),
            hadRequestFailure,
        };
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
                normalized: `${range[1]}–${range[2]}`,
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

        throw new Error('Use a course number such as 585, 500+, 5xx, or 100–500.');
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

        const wildcardPattern = /[xX*#_?%]/;
        const criteria = [];
        let resultFilter = null;

        if (/^[A-Za-z]{3,4}$/.test(query)) {
            const subject = this._resolveSubjectForLiveSearch(query);
            criteria.push({ field: 'subject', value: subject });
        } else if (/^[A-Za-z]{3,4}\s*\d{3}\s*(?:-|–|—|to)\s*\d{3}$/i.test(query)) {
            const match = query.match(/^([A-Za-z]{3,4})\s*(\d{3})\s*(?:-|–|—|to)\s*(\d{3})$/i);
            const subject = this._resolveSubjectForLiveSearch(match[1]);
            resultFilter = this.courseNumberRangeFilter(subject, match[2], match[3]);
            criteria.push({ field: 'subject', value: subject });
        } else if (/^[A-Za-z]{3,4}\s*[\dxX*#_?%]{1,3}\+?[A-Za-z]?$/.test(query)
            && (query.includes('+') || wildcardPattern.test(query))) {
            const match = query.match(/^([A-Za-z]{3,4})\s*([\dxX*#_?%]{1,3}\+?[A-Za-z]?)$/);
            const subject = this._resolveSubjectForLiveSearch(match[1]);
            resultFilter = this.liveCourseRangeFilter(match[2]);
            if (!resultFilter) throw new Error('Invalid range pattern. Try CSCE 500+, CSCE 5xx, or CSCE 5xxL.');
            criteria.push({ field: 'subject', value: subject });
        } else if (/^[A-Za-z]{3,4}\s*\d{1,2}$/.test(query)) {
            const match = query.match(/^([A-Za-z]{3,4})\s*(\d{1,2})$/);
            const subject = this._resolveSubjectForLiveSearch(match[1]);
            const prefix = match[2];
            resultFilter = code => {
                const number = String(code || '').match(/^[A-Z]+\s*(\d{3})/i);
                return Boolean(number && number[1].startsWith(prefix));
            };
            criteria.push({ field: 'subject', value: subject });
        } else if (/^[A-Za-z]{3,4}\s*\d{3}[A-Za-z]?$/.test(query)) {
            const match = query.match(/^([A-Za-z]{3,4})\s*(\d{3}[A-Za-z]?)$/);
            const subject = this._resolveSubjectForLiveSearch(match[1]);
            criteria.push({ field: 'alias', value: `${subject} ${match[2].toUpperCase()}` });
        } else if (/^\d{5}$/.test(query)) {
            criteria.push({ field: 'crn', value: query });
        } else if (/^\d{4}$/.test(query)) {
            throw new Error('A CRN has 5 digits. For a course, include its subject, such as CSCE 145.');
        } else if (/^\d{3}\s?[A-Za-z]?$/.test(query)) {
            throw new Error('Include the subject code, such as CSCE 145.');
        } else if (/^\d{1,2}$/.test(query)) {
            throw new Error('Enter a subject code or full course number, such as CSCE 145.');
        } else if (query.length < 5) {
            throw new Error('Keywords must be at least 5 characters.');
        } else {
            const semantic = await this._doSemanticSearch(query, true, false, searchId);
            if (!semantic || searchId !== this._searchId) return { results: [], semantic: true };
            const subjects = [...new Set(semantic.results
                .map(result => String(result.code || '').split(' ')[0])
                .filter(Boolean))];
            const liveBatches = await Promise.all(subjects.map(subject => API.searchCourses(
                State.term,
                [{ field: 'subject', value: subject }],
            ).then(data => data.results || []).catch(() => [])));
            if (searchId !== this._searchId) return { results: [], semantic: true };
            const liveByCode = this.buildLiveCourseIndex(liveBatches.flat());
            const liveResults = this.mergeCatalogWithLiveSections(semantic.results, liveByCode)
                .filter(result => !result._isCatalog);
            return { results: liveResults, semantic: true };
        }

        const data = await API.searchCourses(State.term, criteria);
        if (searchId !== this._searchId) return { results: [], semantic: false, stale: true };
        const results = resultFilter
            ? (data.results || []).filter(result => resultFilter(result.code || ''))
            : (data.results || []);
        return {
            results,
            semantic: false,
            queryType: /^\d{5}$/.test(query) ? 'crn' : 'structured',
            crn: /^\d{5}$/.test(query) ? query : null,
        };
    },

    init() {
        // Load subject list for fuzzy matching
        this.loadSubjects();

        document.getElementById('btn-search').addEventListener('click', () => this.submitSearch());
        const keywordInput = document.getElementById('keyword-input');
        keywordInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.submitSearch();
        });
        keywordInput.addEventListener('input', () => { this._topicSearchMode = false; });

        // Clear button
        const clearBtn = document.getElementById('search-clear');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                this.resetToCleanSearch({ historyMode: 'push' });
            });
        }

        // Filter toggle
        const filterToggle = document.getElementById('filter-toggle');
        const filterPanel = document.getElementById('filter-panel');
        const filterBackdrop = document.getElementById('filter-backdrop');
        const filterArrow = document.getElementById('filter-arrow');
        if (filterPanel && filterBackdrop && filterPanel.parentElement !== document.body) {
            document.body.append(filterBackdrop, filterPanel);
        }
        if (filterToggle && filterPanel) {
            filterToggle.addEventListener('click', event => {
                event.stopPropagation();
                const shouldOpen = filterPanel.classList.contains('hidden');
                if (shouldOpen) {
                    this.openFilters();
                } else {
                    this.closeFilters();
                }
            });
            filterPanel.addEventListener('click', event => event.stopPropagation());
            document.addEventListener('click', () => this.closeFilters());
            document.addEventListener('keydown', event => {
                if (filterPanel.classList.contains('hidden')) return;
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    this.closeFilters();
                    return;
                }
                if (event.key !== 'Tab') return;
                const focusable = [...filterPanel.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')]
                    .filter(element => !element.hidden && element.offsetParent !== null);
                if (!focusable.length) return;
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                }
            });
        }

        filterBackdrop?.addEventListener('click', () => this.closeFilters());
        document.getElementById('btn-close-filters')?.addEventListener('click', () => this.closeFilters());
        document.getElementById('browse-close-details')?.addEventListener('click', () => this.closeCourseDetail());
        document.querySelectorAll('[data-course-tab]').forEach(button => {
            button.addEventListener('click', () => this.setCourseDetailTab(button.dataset.courseTab, true));
            button.addEventListener('keydown', event => this.handleCourseTabKeydown(event));
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && this._browseState === 'detail'
                && document.getElementById('modal-overlay')?.classList.contains('hidden')
                && document.getElementById('filter-panel')?.classList.contains('hidden')) {
                this.closeCourseDetail();
            }
        });

        document.querySelectorAll('[data-search-example]').forEach(button => {
            button.addEventListener('click', () => {
                const input = this.activeSearchInput();
                input.value = button.dataset.searchExample || '';
                this.submitSearch();
            });
        });
        document.getElementById('search-syntax-open')?.addEventListener('click', event => {
            event.stopPropagation();
            const guide = document.getElementById('search-syntax-guide');
            if (guide) guide.open = true;
            this.openFilters({ focusId: 'search-syntax-guide' });
        });

        document.addEventListener('search-tab-reset-requested', () => {
            this.resetToCleanSearch({ historyMode: 'push' });
        });
        window.addEventListener('popstate', () => this.restoreFromLocation());

        const additionalToggle = document.getElementById('additional-filter-toggle');
        const additionalPanel = document.getElementById('additional-filter-panel');
        const additionalArrow = document.getElementById('additional-filter-arrow');
        if (additionalToggle && additionalPanel) {
            additionalToggle.addEventListener('click', () => {
                const willExpand = additionalPanel.classList.contains('hidden');
                additionalPanel.classList.toggle('hidden', !willExpand);
                additionalArrow.classList.toggle('open', willExpand);
                additionalToggle.setAttribute('aria-expanded', String(willExpand));
            });
        }

        document.getElementById('btn-apply-filters')?.addEventListener('click', () => {
            this.updateActiveFilterChips();
            if (this.activeSearchInput()?.value.trim() || this.hasCourseScopeInput()) this.doSearch();
            else this.closeFilters();
        });
        document.getElementById('btn-clear-filters')?.addEventListener('click', () => this.clearFilters());
        this.setBrowseState('empty');
        this.updateActiveFilterChips();
        const preload = () => {
            if (document.getElementById('filter-ai-search')?.checked) {
                this.prepareSmartSearch({ background: true }).catch(() => {});
            }
        };
        if (typeof requestIdleCallback === 'function') requestIdleCallback(preload, { timeout: 3500 });
        else setTimeout(preload, 1500);
        requestAnimationFrame(() => this.restoreFromLocation({ initial: true }));
    },

    activeSearchInput() {
        return document.getElementById('keyword-input');
    },

    hasCourseScopeInput() {
        return Boolean(
            document.getElementById('filter-scope-subjects')?.value.trim()
            || document.getElementById('filter-scope-numbers')?.value.trim(),
        );
    },

    setBrowseState(state) {
        const workspace = document.getElementById('browse-workspace');
        if (!workspace) return;
        this._browseState = state;
        workspace.classList.remove('browse-empty', 'browse-results', 'browse-detail');
        workspace.classList.add(`browse-${state}`);
    },

    submitSearch() {
        this.cancelLocationRestore();
        if (this._browseState === 'detail') this.leaveCourseDetail({ focus: false });
        this._mainSearchQuery = '';
        this._relatedSearchOrigin = '';
        this._topicSearchMode = false;
        return this.doSearch();
    },

    resetToCleanSearch({ historyMode = 'push' } = {}) {
        if (historyMode !== 'none') this.cancelLocationRestore();
        this._searchId += 1;
        this._detailToken = (this._detailToken || 0) + 1;
        if (this._browseState === 'detail') this.leaveCourseDetail({ focus: false });
        this._mainSearchQuery = '';
        this._relatedSearchOrigin = '';
        this._directSearchOnce = false;
        this._topicSearchMode = false;
        const input = this.activeSearchInput();
        if (input) input.value = '';
        this.clearSearchErrors();
        document.getElementById('search-results').innerHTML = '<p class="hint">Search a subject above to see available courses.</p>';
        this.setBrowseState('empty');
        if (historyMode !== 'none') this.writeSearchHistory('', { mode: historyMode });
        requestAnimationFrame(() => input?.focus());
    },

    searchUrl({
        query = '',
        direct = false,
        origin = '',
        scopeOnly = false,
        topic = false,
    } = {}) {
        const url = new URL(window.location.href);
        url.search = '';
        url.hash = '';
        url.searchParams.set('tab', 'search');
        url.searchParams.set('term', State.term);
        if (query) url.searchParams.set('q', query);
        if (direct) url.searchParams.set('direct', '1');
        if (origin) url.searchParams.set('from', origin);
        if (scopeOnly) url.searchParams.set('scopeSearch', '1');
        if (topic) url.searchParams.set('topic', '1');

        const checkboxParams = [
            ['filter-show-all', 'all'],
            ['filter-open', 'open'],
            ['filter-eligible', 'eligible'],
        ];
        checkboxParams.forEach(([id, parameter]) => {
            if (document.getElementById(id)?.checked) url.searchParams.set(parameter, '1');
        });
        const selectParams = [
            ['filter-method', 'method'],
            ['filter-carolina-core', 'core'],
            ['filter-part-of-term', 'part'],
            ['filter-course-attribute', 'attribute'],
            ['filter-honors', 'honors'],
            ['filter-meeting-pattern', 'meetings'],
            ['filter-size-mode', 'sizeMode'],
            ['filter-size-value', 'size'],
            ['filter-avail-mode', 'seatMode'],
            ['filter-avail-value', 'seats'],
        ];
        selectParams.forEach(([id, parameter]) => {
            const value = document.getElementById(id)?.value;
            if (value) url.searchParams.set(parameter, value);
        });
        const textParams = [
            ['filter-scope-subjects', 'subjects'],
            ['filter-scope-numbers', 'numbers'],
        ];
        textParams.forEach(([id, parameter]) => {
            const value = document.getElementById(id)?.value.trim();
            if (value) url.searchParams.set(parameter, value);
        });
        return url;
    },

    canonicalSearchQuery(query) {
        const normalized = String(query || '')
            .trim()
            .replace(/[–—]/g, '-')
            .replace(/\s+/g, ' ');
        const subjectQuery = normalized.match(/^([A-Za-z]{3,4})\s*(.*)$/);
        if (subjectQuery) {
            const subject = subjectQuery[1].toUpperCase();
            const rest = subjectQuery[2].trim();
            if (!rest) return subject;
            if (/[\dXx*#_?%]/.test(rest)) {
                return `${subject} ${rest.toUpperCase().replace(/\s*-\s*/g, '-')}`;
            }
        }
        return normalized.toLowerCase();
    },

    searchCacheKey({ query = '', direct = false, origin = '' } = {}) {
        const url = this.searchUrl({
            query: this.canonicalSearchQuery(query),
            direct,
            origin,
            topic: this._topicSearchMode,
        });
        const completedCourses = document.getElementById('filter-eligible')?.checked
            ? [...(State.completedCourses || [])].map(code => String(code).toUpperCase()).sort()
            : [];
        const eligibilityState = completedCourses.length
            ? `|completed=${completedCourses.join(',')}`
            : '';
        return `${url.pathname}${url.search}${eligibilityState}`;
    },

    renderAndCacheSearch(cacheKey, results, count, prereqData, eligibleOnly, searchTerms = null) {
        const view = {
            results,
            count,
            prereqData,
            eligibleOnly,
            searchTerms,
            fallbackNotice: this._semanticFallbackNotice,
            mainSearchQuery: this._mainSearchQuery,
            relatedSearchOrigin: this._relatedSearchOrigin,
            storedAt: Date.now(),
        };
        if (cacheKey) {
            this._searchViewCache.delete(cacheKey);
            this._searchViewCache.set(cacheKey, view);
            while (this._searchViewCache.size > this._searchCacheMaxEntries) {
                this._searchViewCache.delete(this._searchViewCache.keys().next().value);
            }
        }
        this.renderResults(results, count, prereqData, eligibleOnly, searchTerms);
    },

    restoreCachedSearch(cacheKey) {
        const view = this._searchViewCache.get(cacheKey);
        if (!view) return false;
        if (Date.now() - view.storedAt > this._searchCacheTtlMs) {
            this._searchViewCache.delete(cacheKey);
            return false;
        }
        this._searchViewCache.delete(cacheKey);
        this._searchViewCache.set(cacheKey, view);
        this._searchId += 1;
        this._mainSearchQuery = view.mainSearchQuery;
        this._relatedSearchOrigin = view.relatedSearchOrigin;
        this._semanticFallbackNotice = view.fallbackNotice || '';
        this.renderResults(
            view.results,
            view.count,
            view.prereqData,
            view.eligibleOnly,
            view.searchTerms,
        );
        return true;
    },

    writeSearchHistory(query, {
        mode = 'push',
        direct = false,
        origin = '',
        scopeOnly = false,
        topic = this._topicSearchMode,
    } = {}) {
        if (this._restoringHistory || mode === 'none') return;
        const url = this.searchUrl({ query, direct, origin, scopeOnly, topic });
        const next = `${url.pathname}${url.search}`;
        const current = `${window.location.pathname}${window.location.search}`;
        const state = { search: true, relatedSearch: Boolean(origin), query, origin, topic };
        if (mode === 'replace' || next === current) history.replaceState(state, '', next);
        else history.pushState(state, '', next);
    },

    normalizeCourseCode(value) {
        const match = String(value || '').trim().toUpperCase()
            .match(/^([A-Z]{3,4})\s*(\d{3}[A-Z]?)$/);
        return match ? `${match[1]} ${match[2]}` : '';
    },

    writeCourseDetailHistory({
        mode = 'replace',
        course = this._detailGroup?.code || '',
        crn = this._detailSectionCrn,
        panel = this._detailTab,
    } = {}) {
        if (this._restoringHistory || mode === 'none') return;
        const url = new URL(window.location.href);
        const normalizedCourse = this.normalizeCourseCode(course);
        const state = { ...(history.state || {}), search: true };
        if (normalizedCourse) {
            url.searchParams.set('tab', 'search');
            url.searchParams.set('term', State.term);
            url.searchParams.set('course', normalizedCourse);
            if (crn) url.searchParams.set('crn', String(crn));
            else url.searchParams.delete('crn');
            if (panel && panel !== 'overview') url.searchParams.set('panel', panel);
            else url.searchParams.delete('panel');
            state.courseDetail = true;
            state.course = normalizedCourse;
            if (mode === 'push') {
                state.detailFromRelatedSearch = Boolean(state.relatedSearch);
                delete state.relatedSearch;
                const parent = new URL(url.href);
                parent.searchParams.delete('course');
                parent.searchParams.delete('crn');
                parent.searchParams.delete('panel');
                state.detailParent = `${parent.pathname}${parent.search}`;
            }
        } else {
            url.searchParams.delete('course');
            url.searchParams.delete('crn');
            url.searchParams.delete('panel');
            delete state.courseDetail;
            delete state.course;
            delete state.detailParent;
            delete state.detailFromRelatedSearch;
        }
        const next = `${url.pathname}${url.search}`;
        const current = `${window.location.pathname}${window.location.search}`;
        if (mode === 'push' && next !== current) history.pushState(state, '', next);
        else history.replaceState(state, '', next);
    },

    async courseDetailGroup(courseCode, requestedCrn = '') {
        const normalized = this.normalizeCourseCode(courseCode);
        if (!normalized) return null;
        const existing = (State.courseGroups || []).find(group => group.code === normalized);
        if (existing && (!requestedCrn || existing.sections.some(section => (
            String(section.crn) === String(requestedCrn)
        )))) return existing;

        const subject = normalized.split(' ')[0];
        const [liveResult, bulletinResult] = await Promise.allSettled([
            API.searchCourses(State.term, [{ field: 'subject', value: subject }]),
            API.bulletinSearch(subject),
        ]);
        const sections = liveResult.status === 'fulfilled'
            ? (liveResult.value.results || []).filter(section => section.code === normalized)
            : [];
        const catalog = bulletinResult.status === 'fulfilled'
            ? (bulletinResult.value.results || []).find(course => course.code === normalized)
            : null;
        if (!sections.length && !catalog) return existing || null;
        return {
            code: normalized,
            title: sections[0]?.title || catalog?.title || normalized,
            sections: sections.length ? sections : [{
                code: normalized,
                title: catalog?.title || normalized,
                key: catalog?.key,
                _isCatalog: true,
            }],
        };
    },

    async restoreCourseDetail(params, restoreId) {
        const course = this.normalizeCourseCode(params.get('course'));
        if (!course) return false;
        const crn = String(params.get('crn') || '');
        const panel = params.get('panel') || 'overview';
        const group = await this.courseDetailGroup(course, crn);
        if (restoreId !== this._restoreId || !group) return false;
        this.showCourseDetail(group, {
            sectionCrn: crn,
            panel,
            historyMode: 'none',
        });
        return true;
    },

    cancelLocationRestore() {
        this._restoreId += 1;
        this._restoringHistory = false;
        API.setForceRefreshLive?.(false);
    },

    applyFiltersFromLocation(params) {
        const checked = [
            ['filter-show-all', 'all'],
            ['filter-open', 'open'],
            ['filter-eligible', 'eligible'],
        ];
        checked.forEach(([id, parameter]) => {
            const element = document.getElementById(id);
            if (element) element.checked = params.get(parameter) === '1';
        });
        const values = [
            ['filter-method', 'method'],
            ['filter-carolina-core', 'core'],
            ['filter-part-of-term', 'part'],
            ['filter-course-attribute', 'attribute'],
            ['filter-honors', 'honors'],
            ['filter-meeting-pattern', 'meetings'],
            ['filter-size-mode', 'sizeMode'],
            ['filter-size-value', 'size'],
            ['filter-avail-mode', 'seatMode'],
            ['filter-avail-value', 'seats'],
        ];
        values.forEach(([id, parameter]) => {
            const element = document.getElementById(id);
            if (element) element.value = params.get(parameter) || '';
        });
        const textValues = [
            ['filter-scope-subjects', 'subjects'],
            ['filter-scope-numbers', 'numbers'],
        ];
        textValues.forEach(([id, parameter]) => {
            const element = document.getElementById(id);
            if (element) element.value = params.get(parameter) || '';
        });
        const aiToggle = document.getElementById('filter-ai-search');
        if (aiToggle) aiToggle.checked = !(params.get('direct') === '1' && !params.get('from'));
        this.updateActiveFilterChips();
    },

    async restoreFromLocation({ initial = false } = {}) {
        const params = new URL(window.location.href).searchParams;
        if (params.get('tab') !== 'search' && !params.has('q') && !params.has('course')) return;
        const restoreId = ++this._restoreId;
        const refreshLiveData = initial && API.shouldRefreshAfterReload?.();
        if (refreshLiveData) API.setForceRefreshLive(true);
        const requestedCourse = this.normalizeCourseCode(params.get('course'));
        const query = params.get('q') || requestedCourse;
        const hasScopeQuery = params.get('scopeSearch') === '1'
            && Boolean(params.get('subjects') || params.get('numbers'));
        this._restoringHistory = true;
        const term = params.get('term');
        const termSelect = document.getElementById('term-select');
        if (term && termSelect?.querySelector(`option[value="${term}"]`)) {
            State.term = term;
            termSelect.value = term;
        }
        this.applyFiltersFromLocation(params);
        this._mainSearchQuery = '';
        this._relatedSearchOrigin = params.get('from') || '';
        this._topicSearchMode = params.get('topic') === '1';
        this._directSearchOnce = params.get('direct') === '1'
            || (!params.has('q') && Boolean(requestedCourse));
        const input = this.activeSearchInput();
        if (input) input.value = query;
        if (typeof Tabs !== 'undefined') Tabs.switchTo('semester');
        if (!query && !hasScopeQuery) {
            this.resetToCleanSearch({ historyMode: 'none' });
            if (refreshLiveData) API.setForceRefreshLive(false);
            if (restoreId === this._restoreId) this._restoringHistory = false;
            return;
        }
        try {
            if (!requestedCourse && this._browseState === 'detail') {
                this.closeCourseDetail({ historyMode: 'none' });
            }
            await this.doSearch({ historyMode: 'none' });
            if (restoreId !== this._restoreId) return;
            if (requestedCourse) await this.restoreCourseDetail(params, restoreId);
        } finally {
            if (refreshLiveData) API.setForceRefreshLive(false);
            if (restoreId === this._restoreId) this._restoringHistory = false;
        }
    },


    openRegularSearch(term) {
        const regularInput = document.getElementById('keyword-input');
        if (!regularInput) return;
        const origin = this._mainSearchQuery || regularInput.value.trim();
        this._searchId += 1;
        regularInput.value = term;
        this._relatedSearchOrigin = origin;
        this._directSearchOnce = true;
        this._topicSearchMode = false;
        regularInput.focus();
        this.doSearch();
    },

    returnToMainSearch() {
        if (history.state?.detailFromRelatedSearch) {
            history.go(-2);
            return;
        }
        if (history.state?.relatedSearch) {
            history.back();
            return;
        }
        const origin = this._relatedSearchOrigin;
        if (!origin) return;
        this._relatedSearchOrigin = '';
        this._mainSearchQuery = '';
        const input = this.activeSearchInput();
        if (input) input.value = origin;
        this.doSearch({ historyMode: 'replace' });
    },

    async openCourseFromExternal(group, sectionCrn = '') {
        if (!group?.code) return;
        const input = this.activeSearchInput();
        if (input) input.value = group.code;
        this._mainSearchQuery = '';
        this._relatedSearchOrigin = '';
        this._directSearchOnce = true;
        await this.doSearch({ historyMode: 'push' });
        const freshGroup = (State.courseGroups || []).find(item => item.code === group.code) || group;
        this.showCourseDetail(freshGroup, { sectionCrn, historyMode: 'push' });
    },

    setSmartModelLoading(active, stage = '') {
        const input = document.getElementById('keyword-input');
        const loading = document.getElementById('smart-model-loading');
        const label = document.getElementById('smart-model-loading-stage');
        const submit = document.getElementById('btn-search');
        const workspace = document.getElementById('browse-workspace');
        workspace?.classList.toggle('smart-search-busy', active);
        if (label && stage) label.textContent = stage;
        loading?.classList.toggle('hidden', !active);
        if (input) {
            input.disabled = active;
            input.setAttribute('aria-busy', String(active));
        }
        if (submit) submit.disabled = active;
        if (!active) {
            input?.focus();
        }
    },

    async prepareSmartSearch({ background = false } = {}) {
        if (this._extractor && this._phraseData) return true;
        if (this._smartModelPromise) return this._smartModelPromise;
        this._smartModelPromise = (async () => {
            if (!background) this.setSmartModelLoading(true, 'Preparing meaning-based search');
            await Promise.all([this._loadExtractor(), this._loadPhraseData()]);
            await this._embedQuery('course search');
            if (!background) this.setSmartModelLoading(false);
            return true;
        })().catch(error => {
            this._smartModelPromise = null;
            if (!background) this.setSmartModelLoading(false);
            throw error;
        });
        return this._smartModelPromise;
    },

    openFilters({ focusId = 'btn-close-filters' } = {}) {
        const panel = document.getElementById('filter-panel');
        const backdrop = document.getElementById('filter-backdrop');
        const toggle = document.getElementById('filter-toggle');
        const arrow = document.getElementById('filter-arrow');
        if (!panel) return;
        this._filterPreviousFocus = document.activeElement;
        panel.classList.remove('hidden');
        backdrop?.classList.remove('hidden');
        document.body?.classList.add('filter-modal-open');
        arrow?.classList.add('open');
        toggle?.setAttribute('aria-expanded', 'true');
        const target = document.getElementById(focusId);
        requestAnimationFrame(() => {
            if (target?.tagName === 'DETAILS') target.querySelector('summary')?.focus();
            else target?.focus();
        });
    },

    closeFilters() {
        const panel = document.getElementById('filter-panel');
        const backdrop = document.getElementById('filter-backdrop');
        const toggle = document.getElementById('filter-toggle');
        const arrow = document.getElementById('filter-arrow');
        const wasOpen = Boolean(panel && !panel.classList.contains('hidden'));
        panel?.classList.add('hidden');
        backdrop?.classList.add('hidden');
        document.body?.classList.remove('filter-modal-open');
        arrow?.classList.remove('open');
        toggle?.setAttribute('aria-expanded', 'false');
        if (wasOpen) {
            const restore = this._filterPreviousFocus;
            this._filterPreviousFocus = null;
            requestAnimationFrame(() => {
                if (restore?.isConnected) restore.focus();
                else toggle?.focus();
            });
        }
    },

    activeFilterEntries() {
        const entries = [];
        const checked = (id, label) => {
            if (document.getElementById(id)?.checked) entries.push({ ids: [id], label });
        };
        const selected = (id, prefix) => {
            const element = document.getElementById(id);
            if (!element?.value) return;
            const text = element.options?.[element.selectedIndex]?.text || element.value;
            entries.push({ ids: [id], label: `${prefix}: ${text}` });
        };
        checked('filter-show-all', 'All catalog courses');
        checked('filter-open', 'Open sections');
        checked('filter-eligible', 'Prerequisites met');
        if (document.getElementById('filter-ai-search')?.checked === false) {
            entries.push({ ids: ['filter-ai-search'], label: 'Direct search only', restore: true });
        }
        const subjectScope = document.getElementById('filter-scope-subjects')?.value.trim();
        const numberScope = document.getElementById('filter-scope-numbers')?.value.trim();
        if (subjectScope) {
            entries.push({ ids: ['filter-scope-subjects'], label: `Subjects: ${subjectScope}` });
        }
        if (numberScope) {
            entries.push({ ids: ['filter-scope-numbers'], label: `Course numbers: ${numberScope}` });
        }
        selected('filter-method', 'Method');
        selected('filter-carolina-core', 'Core');
        selected('filter-part-of-term', 'Term');
        selected('filter-course-attribute', 'Attribute');
        selected('filter-honors', 'Honors');
        selected('filter-meeting-pattern', 'Meetings');
        const sizeMode = document.getElementById('filter-size-mode');
        const sizeValue = document.getElementById('filter-size-value');
        if (sizeMode?.value && sizeValue?.value) {
            entries.push({ ids: ['filter-size-mode', 'filter-size-value'], label: `Class size: ${sizeMode.value} ${sizeValue.value}` });
        }
        const availabilityMode = document.getElementById('filter-avail-mode');
        const availabilityValue = document.getElementById('filter-avail-value');
        if (availabilityMode?.value && availabilityValue?.value !== '') {
            entries.push({ ids: ['filter-avail-mode', 'filter-avail-value'], label: `Seats: ${availabilityMode.value} ${availabilityValue.value}` });
        }
        return entries;
    },

    updateActiveFilterChips() {
        const container = document.getElementById('active-filter-chips');
        if (!container) return;
        const entries = this.activeFilterEntries();
        const filterToggle = document.getElementById('filter-toggle');
        filterToggle?.classList.toggle('has-active-filters', entries.length > 0);
        filterToggle?.setAttribute(
            'aria-label',
            entries.length ? `Filters, ${entries.length} active` : 'Filters',
        );
        container.innerHTML = '';
        entries.forEach(entry => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'active-filter-chip';
            button.appendChild(document.createTextNode(entry.label));
            const remove = document.createElement('span');
            remove.setAttribute('aria-hidden', 'true');
            remove.textContent = '×';
            button.appendChild(remove);
            button.setAttribute('aria-label', `Remove filter ${entry.label}`);
            button.addEventListener('click', () => {
                entry.ids.forEach(id => {
                    const element = document.getElementById(id);
                    if (!element) return;
                    if (element.type === 'checkbox') element.checked = Boolean(entry.restore);
                    else element.value = '';
                });
                this.updateActiveFilterChips();
                if (this.activeSearchInput()?.value.trim() || this.hasCourseScopeInput()) this.doSearch();
                else this.resetToCleanSearch({ historyMode: 'push' });
            });
            container.appendChild(button);
        });
    },

    clearFilters() {
        document.querySelectorAll('#filter-panel input[type="checkbox"]').forEach(input => {
            input.checked = false;
        });
        const aiToggle = document.getElementById('filter-ai-search');
        if (aiToggle) aiToggle.checked = true;
        document.querySelectorAll('#filter-panel select').forEach(select => {
            select.selectedIndex = 0;
        });
        document.querySelectorAll('#filter-panel input[type="number"]').forEach(input => {
            input.value = '';
        });
        document.querySelectorAll('#filter-panel input[type="text"]').forEach(input => {
            input.value = '';
        });
        this.updateActiveFilterChips();
        this.closeFilters();
        if (this.activeSearchInput()?.value.trim()) this.doSearch();
        else this.resetToCleanSearch({ historyMode: 'push' });
    },

    async doSearch({ historyMode = 'push', bypassCache = false } = {}) {
        if (historyMode !== 'none') this.cancelLocationRestore();
        const initialSearchId = ++this._searchId;
        await this.loadSubjects();
        if (initialSearchId !== this._searchId) return;
        if (this._browseState === 'detail') this.leaveCourseDetail({ focus: false });
        this.clearSearchErrors();
        const searchInput = this.activeSearchInput();
        const rawInput = searchInput.value.trim();
        const openOnly = document.getElementById('filter-open').checked;
        const eligibleOnly = document.getElementById('filter-eligible').checked;
        const currentTermOnly = !document.getElementById('filter-show-all').checked;
        const instructionalMethod = document.getElementById('filter-method').value;
        const carolinaCore = document.getElementById('filter-carolina-core').value;
        const partOfTerm = document.getElementById('filter-part-of-term').value;
        const courseAttribute = document.getElementById('filter-course-attribute').value;
        const honors = document.getElementById('filter-honors').value;
        const meetingPattern = document.getElementById('filter-meeting-pattern').value;
        let aiAssisted = document.getElementById('filter-ai-search')?.checked !== false;

        // Level filter — removed from UI; range/wildcard search (e.g. CSCE 500+) replaces it
        const levelMode = '';
        const levelValue = 0;

        // Size filter
        const sizeMode = document.getElementById('filter-size-mode').value;
        const sizeValue = parseInt(document.getElementById('filter-size-value').value) || 0;

        // Availability filter
        const availMode = document.getElementById('filter-avail-mode').value;
        const availRaw = document.getElementById('filter-avail-value').value.trim();
        const availValue = availRaw === '' ? null : Number(availRaw);

        let compactQuery = null;
        let searchQuery = rawInput;
        let courseScope;
        try {
            compactQuery = this.parseCompactScopedQuery(rawInput);
            if (compactQuery) {
                this._topicSearchMode = true;
                const subjectInput = document.getElementById('filter-scope-subjects');
                const numberInput = document.getElementById('filter-scope-numbers');
                if (subjectInput) subjectInput.value = compactQuery.subjectText;
                if (numberInput) numberInput.value = compactQuery.numberText;
                const aiToggle = document.getElementById('filter-ai-search');
                if (aiToggle) aiToggle.checked = true;
                aiAssisted = true;
                searchQuery = compactQuery.topic;
                searchInput.value = searchQuery;
            } else {
                const standaloneScope = this.parseStandaloneCourseScope(rawInput);
                if (standaloneScope) {
                    this._topicSearchMode = false;
                    const subjectInput = document.getElementById('filter-scope-subjects');
                    const numberInput = document.getElementById('filter-scope-numbers');
                    if (subjectInput) subjectInput.value = standaloneScope.subjectText;
                    if (numberInput) numberInput.value = standaloneScope.numberText;
                    searchQuery = '';
                    searchInput.value = '';
                }
            }
            courseScope = this.buildCourseScope(
                document.getElementById('filter-scope-subjects')?.value,
                document.getElementById('filter-scope-numbers')?.value,
            );
            const subjectInput = document.getElementById('filter-scope-subjects');
            const numberInput = document.getElementById('filter-scope-numbers');
            if (subjectInput) subjectInput.value = courseScope.subjectText;
            if (numberInput) numberInput.value = courseScope.numberText;
        } catch (error) {
            const scopePanelOpen = !document.getElementById('filter-panel')?.classList.contains('hidden');
            this.showSearchError(error.message, { scope: scopePanelOpen });
            return;
        }

        const useDirectSearch = !aiAssisted
            || Boolean(this._relatedSearchOrigin)
            || this._directSearchOnce
            || this._semanticFallbackOnce
            || !searchQuery;
        const historyDirect = !aiAssisted || Boolean(this._relatedSearchOrigin);
        this._directSearchOnce = false;

        if (!searchQuery && !courseScope.active) {
            this.showHint('Enter a subject code (CSCE), course number (CSCE 145), range (CSCE 140–199), or keyword.');
            return;
        }

        this.writeSearchHistory(searchQuery, {
            mode: historyMode,
            direct: historyDirect,
            origin: this._relatedSearchOrigin,
            scopeOnly: !searchQuery && courseScope.active,
            topic: this._topicSearchMode,
        });

        this.setBrowseState('results');
        this.updateActiveFilterChips();
        this.closeFilters();
        const searchCacheKey = this.searchCacheKey({
            query: searchQuery,
            direct: historyDirect,
            origin: this._relatedSearchOrigin,
        });
        if (!bypassCache && !this._semanticFallbackOnce
            && this.restoreCachedSearch(searchCacheKey)) return;

        const kw = searchQuery.trim();
        const normalizedShortTopic = kw.toUpperCase();
        const scopedShortTopic = courseScope.active
            && /^[A-Za-z]{2,4}$/i.test(kw)
            && !this._subjects.includes(normalizedShortTopic)
            && !courseScope.subjects.includes(normalizedShortTopic);
        const treatAsTopic = this._topicSearchMode || scopedShortTopic;
        const criteria = [];
        let subject = '';
        let courseNumberFilter = null;   // exact match (e.g. "145" or "145L")
        let courseRangeFilter = null;     // function(code) → boolean for +, wildcards, partial

        // Wildcard characters that stand for "any digit"
        const WILDCARD = /[xX*#_?%]/;
        const hasWildcard = (s) => WILDCARD.test(s);

        // Build a filter function from a number pattern with wildcards/+/partial
        const buildRangeFilter = (numPart) => {
            // Plus suffix: CSCE 500+ → >= 500, optional letter suffix on courses
            if (/^\d{1,3}\+$/.test(numPart)) {
                const floor = parseInt(numPart.slice(0, -1));
                return (code) => {
                    const m = code.match(/^[A-Z]+\s*(\d{3})/i);
                    return m && parseInt(m[1]) >= floor;
                };
            }
            // Wildcard pattern: digits + wildcards + optional trailing letter
            // e.g. "5xx", "55x", "x77", "5x7", "3xxL"
            const wcMatch = numPart.match(/^([\dxX*#_?%]{1,3})([A-Za-z]?)$/);
            if (wcMatch && hasWildcard(wcMatch[1])) {
                const digits = wcMatch[1];
                const suffix = wcMatch[2].toUpperCase();
                // Pad to 3 chars by appending wildcards (so "5" + wildcard = "5xx")
                const padded = (digits + 'xx').slice(0, 3);
                const reStr = padded.replace(/[xX*#_?%]/g, '\\d');
                const numRe = new RegExp('^' + reStr + '$');
                return (code) => {
                    const m = code.match(/^[A-Z]+\s*(\d{3})([A-Za-z]?)$/i);
                    if (!m) return false;
                    if (!numRe.test(m[1])) return false;
                    if (suffix && m[2].toUpperCase() !== suffix) return false;
                    return true;
                };
            }
            return null;
        };

        // Parse the input to determine what the user wants

        // A scope without a topic lists all courses inside the selected bounds.
        if (!kw && courseScope.active) {
            // Scope is applied to API results below.

        // 3-4 letter subject code only (e.g. "CSCE", "MATH")
        } else if (!treatAsTopic && /^[A-Za-z]{3,4}$/i.test(kw)) {
            subject = this._resolveSubject(kw);
            if (!subject) return;
            searchInput.value = subject;
            criteria.push({ field: 'subject', value: subject });

        // Inclusive numeric range: "CSCE 140-150", "CSCE 140–150", or "CSCE 140 to 150"
        } else if (!treatAsTopic && /^[A-Za-z]{3,4}\s*\d{3}\s*(?:-|–|—|to)\s*\d{3}$/i.test(kw)) {
            const m = kw.match(/^([A-Za-z]{3,4})\s*(\d{3})\s*(?:-|–|—|to)\s*(\d{3})$/i);
            subject = this._resolveSubject(m[1]);
            if (!subject) return;
            try {
                courseRangeFilter = this.courseNumberRangeFilter(subject, m[2], m[3]);
            } catch (error) {
                this.showHint(error.message);
                return;
            }
            criteria.push({ field: 'subject', value: subject });

        // Range/wildcard course code: "CSCE 500+", "CSCE 5xx", "CSCE 5xxL", "CSCE x77"
        } else if (!treatAsTopic && /^[A-Za-z]{3,4}\s*[\dxX*#_?%]{1,3}\+?[A-Za-z]?$/i.test(kw) &&
                   (kw.includes('+') || hasWildcard(kw))) {
            const m = kw.match(/^([A-Za-z]{3,4})\s*([\dxX*#_?%]{1,3}\+?[A-Za-z]?)$/i);
            subject = this._resolveSubject(m[1]);
            if (!subject) return;
            const numPart = m[2].toUpperCase();
            courseRangeFilter = buildRangeFilter(numPart);
            if (!courseRangeFilter) {
                this.showHint('Invalid range pattern. Try CSCE 500+, CSCE 5xx, or CSCE 5xxL.');
                return;
            }
            criteria.push({ field: 'subject', value: subject });

        // Partial course number: "CSCE 5" or "CSCE 55" → prefix match (implicit wildcards)
        } else if (!treatAsTopic && /^[A-Za-z]{3,4}\s*\d{1,2}$/i.test(kw)) {
            const m = kw.match(/^([A-Za-z]{3,4})\s*(\d{1,2})$/i);
            subject = this._resolveSubject(m[1]);
            if (!subject) return;
            const partial = m[2];
            const padded = (partial + 'xx').slice(0, 3);
            const reStr = padded.replace(/x/g, '\\d');
            const numRe = new RegExp('^' + reStr + '$');
            courseRangeFilter = (code) => {
                const cm = code.match(/^[A-Z]+\s*(\d{3})/i);
                return cm && numRe.test(cm[1]);
            };
            criteria.push({ field: 'subject', value: subject });

        // Full course code: "CSCE 145" or "CSCE145" or "csce 145"
        } else if (!treatAsTopic && /^[A-Za-z]{3,4}\s*\d{3}[A-Za-z]?$/i.test(kw)) {
            const m = kw.match(/^([A-Za-z]{3,4})\s*(\d{3}[A-Za-z]?)$/i);
            subject = this._resolveSubject(m[1]);
            if (!subject) return;
            const num = m[2].toUpperCase();
            const normalized = subject + ' ' + num;
            searchInput.value = normalized;
            criteria.push({ field: 'alias', value: normalized });

        // 5-digit CRN
        } else if (!treatAsTopic && /^\d{5}$/.test(kw)) {
            criteria.push({ field: 'crn', value: kw });

        // 4 digits — invalid
        } else if (!treatAsTopic && /^\d{4}$/.test(kw)) {
            this.showHint('4-digit numbers are not valid. Enter a 3-digit course number (e.g. CSCE 101) or a 5-digit CRN.');
            return;

        // 3 digits + optional letter — need subject prefix
        } else if (!treatAsTopic && /^\d{3}\s?[A-Za-z]?$/.test(kw)) {
            this.showHint('Include the subject code (e.g. CSCE 101, not just 101).');
            return;

        // 1-2 digits
        } else if (!treatAsTopic && /^\d{1,2}$/.test(kw)) {
            this.showHint('Enter a subject code (e.g. CSCE) or full course number (e.g. CSCE 101).');
            return;

        // Text keyword — require 5+ characters
        } else if (kw.length < 5 && !courseScope.active) {
            this.showHint('Keywords must be at least 5 characters. For courses, enter a subject code (e.g. CSCE) or course number (e.g. CSCE 145).');
            return;

        // Direct keyword search when meaning-based matching is disabled or bypassed once
        } else if (useDirectSearch) {
            criteria.push({ field: 'keyword', value: kw });

        // Meaning-based search via Transformers.js
        } else {
            this.showLoading('Preparing search plan');
            const searchId = ++this._searchId;
            try {
                await this.prepareSmartSearch();
                if (searchId !== this._searchId) return;
                const semantic = await this._doSemanticSearch(
                    kw,
                    currentTermOnly,
                    openOnly,
                    searchId,
                    courseScope,
                    progress => this.showSearchProgress(progress),
                );
                if (!semantic || searchId !== this._searchId) return;

                this.showSearchProgress({
                    phase: 'filtering',
                    completed: semantic.searches?.length || 0,
                    total: semantic.searches?.length || 0,
                    candidates: semantic.results.length,
                });

                if (semantic.results.length === 0) {
                    this._mainSearchQuery = kw;
                    this._relatedSearchOrigin = '';
                    this.renderAndCacheSearch(
                        semantic.hadRequestFailure ? null : searchCacheKey,
                        [],
                        0,
                        {},
                        eligibleOnly,
                        semantic.searches,
                    );
                    return;
                }

                let results = semantic.results;

                // Cross-reference ALL results with live term data
                const relatedResults = currentTermOnly ? [] : (semantic.searchResults || []).flat();
                const subjects = courseScope.subjects.length
                    ? courseScope.subjects
                    : [...new Set([...results, ...relatedResults]
                        .map(r => (r.code || '').split(' ')[0]).filter(Boolean))];
                const livePromises = subjects.map(async subjectCode => {
                    try {
                        const data = await API.searchCourses(
                            State.term,
                            [{ field: 'subject', value: subjectCode }],
                        );
                        return { results: data.results || [], failed: false };
                    } catch (error) {
                        return { results: [], failed: true };
                    }
                });
                const liveResponses = await Promise.all(livePromises);
                const liveAll = liveResponses.map(response => response.results);
                const incompleteSearch = semantic.hadRequestFailure
                    || liveResponses.some(response => response.failed);
                if (searchId !== this._searchId) return;
                const liveByCode = this.buildLiveCourseIndex(liveAll.flat());

                if (currentTermOnly) {
                    // Only show courses offered this term
                    results = results.filter(c => liveByCode[c.code]);
                }

                results = this.filterByCourseScope(
                    this.mergeCatalogWithLiveSections(results, liveByCode),
                    courseScope,
                );
                const semanticFilters = {
                    openOnly,
                    instructionalMethod,
                    carolinaCore,
                    partOfTerm,
                    courseAttribute,
                    honors,
                    meetingPattern,
                    sizeMode,
                    sizeValue,
                    availMode,
                    availValue,
                };
                results = await this.applySectionFilters(results, semanticFilters);
                results = this.filterByCourseScope(results, courseScope);

                if (searchId !== this._searchId) return;
                const eligibleOnly2 = eligibleOnly;
                const relatedBatches = await Promise.all((semantic.searchResults || []).map(batch => {
                    const candidates = currentTermOnly
                        ? batch
                        : this.mergeCatalogWithLiveSections(batch, liveByCode);
                    return this.applySectionFilters(
                        this.filterByCourseScope(candidates, courseScope),
                        semanticFilters,
                    );
                }));
                if (searchId !== this._searchId) return;
                const prereqData = eligibleOnly2
                    ? await this.loadPrereqsForResults([...results, ...relatedBatches.flat()])
                    : {};
                if (searchId !== this._searchId) return;
                const searchInfo = semantic.searches?.length
                    ? semantic.searches.map((search, index) => {
                        const matchingCodes = (relatedBatches[index] || [])
                            .map(result => result.code)
                            .filter(code => code && (!eligibleOnly2 || this.checkEligibility(code, prereqData).eligible));
                        return { ...search, count: new Set(matchingCodes).size };
                    })
                    : null;
                this._mainSearchQuery = searchQuery;
                this._relatedSearchOrigin = '';
                this.renderAndCacheSearch(
                    incompleteSearch ? null : searchCacheKey,
                    results,
                    results.length,
                    prereqData,
                    eligibleOnly2,
                    searchInfo,
                );
            } catch (err) {
                if (searchId !== this._searchId) return;
                if (this.activeSearchInput()?.value.trim() !== kw) return;
                console.error('[Semantic] Error:', err);
                this._extractorLoading = null;
                this._smartModelPromise = null;
                this.setSmartModelLoading(false);
                this._semanticFallbackNotice = 'Meaning-based matching is unavailable. Showing direct matches.';
                this._semanticFallbackOnce = true;
                await this.doSearch({ bypassCache: true });
                this._semanticFallbackOnce = false;
            }
            return;
        }

        if (openOnly) criteria.push({ field: 'stat', value: 'A' });

        this.showLoading();
        const searchId = ++this._searchId;

        try {
            let results = [];
            let totalCount = 0;
            const scopedRequestSubjects = this.scopedSubjectsForQuery(subject, courseScope);
            const subjectScopeConflict = Boolean(
                subject
                && courseScope.subjects.length
                && !scopedRequestSubjects.length,
            );

            if (subjectScopeConflict) {
                results = [];
                totalCount = 0;
            } else if (currentTermOnly) {
                // Search live class offerings for the selected term
                if (courseScope.subjects.length) {
                    const batches = await Promise.all(scopedRequestSubjects.map(scopeSubject => (
                        API.searchCourses(State.term, [
                            ...criteria.filter(item => item.field !== 'subject'),
                            { field: 'subject', value: scopeSubject },
                        ])
                    )));
                    results = batches.flatMap(data => data.results || []);
                    totalCount = results.length;
                } else {
                    const data = await API.searchCourses(State.term, criteria);
                    results = data.results || [];
                    totalCount = data.count || 0;
                }
            } else {
                // Search the bulletin catalog (all courses, not term-specific)
                let bulletinCourses;
                if (subject) {
                    const bulletinData = await API.bulletinSearch(subject);
                    bulletinCourses = bulletinData.results || [];
                } else if (courseScope.subjects.length) {
                    const batches = await Promise.all(courseScope.subjects.map(async scopeSubject => {
                        if (!criteria.length) {
                            const data = await API.bulletinSearch(scopeSubject);
                            return data.results || [];
                        }
                        const data = await API.post('/api/bulletin/search', {
                            other: { srcdb: '2026' },
                            criteria: [
                                ...criteria.filter(item => item.field !== 'subject'),
                                { field: 'subject', value: scopeSubject },
                            ],
                        });
                        return data.results || [];
                    }));
                    bulletinCourses = batches.flat();
                } else {
                    const bulletinData = await API.post('/api/bulletin/search', {
                        other: { srcdb: '2026' },
                        criteria,
                    });
                    bulletinCourses = bulletinData.results || [];
                }
                bulletinCourses = this.filterByCourseScope(bulletinCourses, courseScope);

                // Also fetch live term data to cross-reference availability
                const liveSubjects = subjectScopeConflict
                    ? []
                    : subject
                        ? scopedRequestSubjects
                    : courseScope.subjects.length
                        ? courseScope.subjects
                        : [...new Set(bulletinCourses
                            .map(course => String(course.code || '').split(' ')[0])
                            .filter(Boolean))];
                const liveResults = courseScope.active && !courseScope.subjects.length
                    ? (await API.searchCourses(State.term, [])).results || []
                    : (await Promise.all(liveSubjects.map(code => API.searchCourses(
                        State.term,
                        [{ field: 'subject', value: code }],
                    ).then(data => data.results || [])))).flat();

                // Build a set of course codes offered this term + their open status
                const liveByCode = this.buildLiveCourseIndex(liveResults);

                // Convert bulletin results, merging live availability info
                results = this.mergeCatalogWithLiveSections(bulletinCourses, liveByCode);
                totalCount = results.length;

                // Apply keyword course number filter to catalog results
                if (courseNumberFilter) {
                    results = results.filter(r => {
                        const codeNum = (r.code || '').replace(/^[A-Z]+\s*/i, '').toUpperCase();
                        return codeNum === courseNumberFilter;
                    });
                    courseNumberFilter = null; // already applied
                }
            }

            // Client-side filters

            // Range/wildcard filter (from patterns like "500+", "5xx", "55x", "x77", "3xxL")
            if (courseRangeFilter) {
                results = results.filter(r => courseRangeFilter(r.code || ''));
            }

            // Course number filter (from 3-digit input like "101" or "101L")
            if (courseNumberFilter) {
                results = results.filter(r => {
                    const codeNum = (r.code || '').replace(/^[A-Z]+\s*/i, '').toUpperCase();
                    return codeNum === courseNumberFilter;
                });
            }

            results = this.filterByCourseScope(results, courseScope);

            // Level filter
            if (levelMode && levelValue) {
                results = results.filter(r => {
                    const num = parseInt((r.code || '').replace(/[A-Z\s]+/g, ''));
                    if (!num) return true;
                    const level = Math.floor(num / 100) * 100;
                    if (levelMode === 'exact') return level === levelValue;
                    if (levelMode === 'above') return num >= levelValue;
                    if (levelMode === 'below') return num < levelValue;
                    return true;
                });
            }

            results = await this.applySectionFilters(results, {
                openOnly,
                instructionalMethod,
                carolinaCore,
                partOfTerm,
                courseAttribute,
                honors,
                meetingPattern,
                sizeMode,
                sizeValue,
                availMode,
                availValue,
            });
            results = this.filterByCourseScope(results, courseScope);
            if (courseScope.active) totalCount = results.length;

            // If a newer search was started, discard these results
            if (searchId !== this._searchId) return;

            const prereqData = eligibleOnly
                ? await this.loadPrereqsForResults(results)
                : (this._prereqCache[subject] || {});

            if (searchId !== this._searchId) return;
            this.renderAndCacheSearch(
                this._semanticFallbackOnce ? null : searchCacheKey,
                results,
                totalCount || results.length,
                prereqData,
                eligibleOnly,
            );
        } catch (err) {
            if (searchId !== this._searchId) return;
            this.showHint('Search failed. Try again.');
        }
    },

    buildLiveCourseIndex(sections) {
        const index = {};
        sections.forEach(section => {
            if (!index[section.code]) index[section.code] = { hasOpen: false, records: [] };
            index[section.code].records.push(section);
            if (section.stat === 'A') index[section.code].hasOpen = true;
        });
        return index;
    },

    mergeCatalogWithLiveSections(courses, liveByCode) {
        return courses.flatMap(course => {
            const live = liveByCode[course.code];
            if (live) {
                return live.records.map(section => ({
                    ...section,
                    _offeredThisTerm: true,
                    _hasOpen: live.hasOpen,
                    _relevanceScore: course._relevanceScore || 0,
                }));
            }
            return [{
                code: course.code,
                title: course.title || course.name || '',
                crn: '',
                section: 'CAT',
                stat: '',
                instr: '',
                meets: 'Not offered this term',
                meetingTimes: null,
                total: '',
                key: course.key,
                _isCatalog: true,
                _offeredThisTerm: false,
                _hasOpen: false,
                _relevanceScore: course._relevanceScore || 0,
            }];
        });
    },

    matchesInstructionalMethod(section, selectedMethod) {
        if (!selectedMethod) return true;
        const method = String(
            section.inst_mthd || section.instructionalMethod || section.instructional_method || '',
        ).toLowerCase();
        if (selectedMethod === 'online') return /online|web|distance|remote/.test(method);
        if (selectedMethod === 'hybrid') return /hybrid|blended/.test(method);
        if (selectedMethod === 'face-to-face') {
            return /face-to-face|face to face|in-person|in person|traditional/.test(method);
        }
        return true;
    },

    meetingCount(section) {
        if (!section.meetingTimes) return 0;
        try {
            const meetings = typeof section.meetingTimes === 'string'
                ? JSON.parse(section.meetingTimes)
                : section.meetingTimes;
            return Array.isArray(meetings) ? meetings.length : 0;
        } catch (error) {
            return 0;
        }
    },

    matchesMeetingPattern(section, selectedPattern) {
        if (!selectedPattern) return true;
        if (section._isCatalog) return false;
        const count = this.meetingCount(section);
        if (selectedPattern === 'scheduled') return count > 0;
        if (selectedPattern === 'unscheduled') return count === 0;
        if (selectedPattern === 'once') return count === 1;
        if (selectedPattern === 'twice') return count === 2;
        if (selectedPattern === 'three-plus') return count >= 3;
        return true;
    },

    async fetchBulletinDetailsForCourse(courseCode) {
        if (this._bulletinDetailsCache[courseCode]) {
            return this._bulletinDetailsCache[courseCode];
        }
        const subject = courseCode.split(' ')[0];
        if (!this._bulletinCourseCache[subject]) {
            this._bulletinCourseCache[subject] = API.bulletinSearch(subject)
                .then(data => data.results || [])
                .catch(error => {
                    delete this._bulletinCourseCache[subject];
                    throw error;
                });
        }
        this._bulletinDetailsCache[courseCode] = this._bulletinCourseCache[subject]
            .then(courses => {
                const target = courses.find(course => course.code === courseCode);
                return target ? API.bulletinDetails(target.key) : {};
            })
            .catch(error => {
                delete this._bulletinDetailsCache[courseCode];
                throw error;
            });
        return this._bulletinDetailsCache[courseCode];
    },

    async fetchSectionFilterDetails(section) {
        if (!section.crn) return null;
        const key = `${State.term}:${section.crn}`;
        if (!this._sectionDetailCache[key]) {
            this._sectionDetailCache[key] = API.getDetails(section.crn, State.term)
                .catch(error => {
                    delete this._sectionDetailCache[key];
                    throw error;
                });
        }
        return this._sectionDetailCache[key];
    },

    matchesPartOfTerm(value, selectedPart) {
        if (!selectedPart) return true;
        const part = String(value || '').toLowerCase();
        if (selectedPart === 'full') return /full term/.test(part);
        if (selectedPart === 'first') return /first half|1st half/.test(part);
        if (selectedPart === 'second') return /second half|2nd half/.test(part);
        if (selectedPart === 'other') {
            return Boolean(part) && !/full term|first half|1st half|second half|2nd half/.test(part);
        }
        return true;
    },

    async filterByPartOfTerm(results, selectedPart) {
        if (!selectedPart) return results;
        const checked = await Promise.all(results.map(async section => {
            const details = await this.fetchSectionFilterDetails(section);
            return details && this.matchesPartOfTerm(details.part_of_term, selectedPart)
                ? section
                : null;
        }));
        return checked.filter(Boolean);
    },

    isHonorsSection(section, details = {}) {
        const text = [
            section.code,
            section.title,
            section.section,
            details.title,
            details.section,
            details.course_attr,
            details.clssnotes,
            details.registration_restrictions,
        ].filter(Boolean).join(' ');
        return /^SCHC\b/i.test(String(section.code || ''))
            || /^H\d/i.test(String(section.section || ''))
            || /\bHNRS\b|\bhonors?\b/i.test(text);
    },

    async filterByHonors(results, selectedHonors) {
        if (!selectedHonors) return results;
        const checked = await Promise.all(results.map(async section => {
            const details = await this.fetchSectionFilterDetails(section) || {};
            const honors = this.isHonorsSection(section, details);
            const keep = selectedHonors === 'only' ? honors : !honors;
            return keep ? section : null;
        }));
        return checked.filter(Boolean);
    },

    matchesCourseAttribute(details, selectedAttribute) {
        if (!selectedAttribute) return true;
        const experiential = String(details.experiential || '').replace(/<[^>]+>/g, ' ').toLowerCase();
        const founding = String(details.founding_documents || '').replace(/<[^>]+>/g, ' ').toLowerCase();
        const graduation = String(details.graduation || '').replace(/<[^>]+>/g, ' ').toLowerCase();
        if (selectedAttribute === 'elo') return /experiential learning opportunity/.test(experiential);
        if (selectedAttribute === 'founding') return /founding documents/.test(founding);
        if (selectedAttribute === 'gld-community') return /community engagement|social advocacy/.test(graduation);
        if (selectedAttribute === 'gld-global') return /global learning/.test(graduation);
        if (selectedAttribute === 'gld-professional') return /professional engagement/.test(graduation);
        if (selectedAttribute === 'gld-research') return /research/.test(graduation);
        return true;
    },

    async filterByCourseAttribute(results, selectedAttribute) {
        if (!selectedAttribute) return results;
        const courseCodes = [...new Set(results.map(result => result.code).filter(Boolean))];
        const matches = await Promise.all(courseCodes.map(async code => {
            const details = await this.fetchBulletinDetailsForCourse(code);
            return this.matchesCourseAttribute(details, selectedAttribute) ? code : null;
        }));
        const allowed = new Set(matches.filter(Boolean));
        return results.filter(result => allowed.has(result.code));
    },

    async fetchCarolinaCoreCodes(courseCode) {
        if (this._carolinaCoreCache[courseCode]) return this._carolinaCoreCache[courseCode];
        const details = await this.fetchBulletinDetailsForCourse(courseCode);
        const text = String(details.carolinacore || '').replace(/<[^>]+>/g, ' ');
        const codes = text.match(/\b(?:AIU|ARP|CMS|CMW|GFL|GHS|GSS|INF|SCI|VSR)\b/g) || [];
        this._carolinaCoreCache[courseCode] = [...new Set(codes)];
        return this._carolinaCoreCache[courseCode];
    },

    async filterByCarolinaCore(results, selectedCore) {
        if (!selectedCore) return results;
        const courseCodes = [...new Set(results.map(result => result.code).filter(Boolean))];
        const matches = await Promise.all(courseCodes.map(async code => {
            const coreCodes = await this.fetchCarolinaCoreCodes(code);
            return coreCodes.includes(selectedCore) ? code : null;
        }));
        const allowed = new Set(matches.filter(Boolean));
        return results.filter(result => allowed.has(result.code));
    },

    async applySectionFilters(results, filters) {
        let filtered = results;
        if (filters.openOnly) filtered = filtered.filter(section => section.stat === 'A');
        if (filters.instructionalMethod) {
            filtered = filtered.filter(section => this.matchesInstructionalMethod(
                section,
                filters.instructionalMethod,
            ));
        }
        if (filters.meetingPattern) {
            filtered = filtered.filter(section => this.matchesMeetingPattern(
                section,
                filters.meetingPattern,
            ));
        }
        if (filters.sizeMode && filters.sizeValue) {
            filtered = filtered.filter(section => {
                const total = parseInt(section.total);
                if (!Number.isFinite(total)) return false;
                return filters.sizeMode === 'above'
                    ? total >= filters.sizeValue
                    : total < filters.sizeValue;
            });
        }
        if (filters.availMode && filters.availValue !== null) {
            filtered = await this.filterByAvailableSeats(
                filtered,
                filters.availMode,
                filters.availValue,
            );
        }
        filtered = await this.filterByPartOfTerm(filtered, filters.partOfTerm);
        filtered = await this.filterByHonors(filtered, filters.honors);
        filtered = await this.filterByCourseAttribute(filtered, filters.courseAttribute);
        return this.filterByCarolinaCore(filtered, filters.carolinaCore);
    },

    async fetchPrereqForCourse(courseCode) {
        // Fetch prereq data for a single course (on-demand, cached)
        const subject = courseCode.split(' ')[0];
        if (!this._prereqCache[subject]) this._prereqCache[subject] = {};
        if (this._prereqCache[subject][courseCode]) return this._prereqCache[subject][courseCode];

        try {
            const search = await API.bulletinSearch(subject);
            const courses = search.results || [];
            const target = courses.find(c => c.code === courseCode);
            if (!target) return { prereqs: [], raw: '' };

            const details = await API.bulletinDetails(target.key);
            const prereqHtml = details.prereq || '';
            const codes = (prereqHtml.match(/[A-Z]{3,4}\s+\d{3}[A-Z]?/g) || []);
            const groups = typeof Prereqs !== 'undefined' && Prereqs.parsePrereqGroups
                ? Prereqs.parsePrereqGroups(prereqHtml)
                : [];
            const result = {
                prereqs: [...new Set(codes)],
                groups,
                raw: prereqHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
            };
            this._prereqCache[subject][courseCode] = result;
            return result;
        } catch (error) {
            throw error;
        }
    },

    checkEligibility(courseCode, prereqData) {
        const info = prereqData[courseCode];
        if (!info) return { eligible: true, missing: [], noData: true };
        const completed = new Set(State.completedCourses);
        if (info.groups?.length
            && typeof Prereqs !== 'undefined'
            && Prereqs.evaluateGroups) {
            const evaluation = Prereqs.evaluateGroups(info.groups, completed);
            return {
                eligible: evaluation.eligible,
                missing: evaluation.missing,
                noData: false,
                unknown: evaluation.uncertain,
            };
        }
        const prerequisites = info.prereqs || [];
        if (!prerequisites.length) return { eligible: true, missing: [], noData: false };
        const missing = prerequisites.filter(p => !completed.has(p));
        return { eligible: missing.length === 0, missing, noData: false };
    },

    async loadPrereqsForResults(results) {
        const codes = [...new Set(results.map(result => result.code).filter(Boolean))];
        const entries = await Promise.all(codes.map(async code => {
            const info = await this.fetchPrereqForCourse(code);
            return [code, info];
        }));
        return Object.fromEntries(entries);
    },

    async filterByAvailableSeats(results, mode, value) {
        if (!mode || value === null || value === undefined) return results;
        const checked = await Promise.all(results.map(async result => {
            if (!result.crn) return null;
            const details = await this.fetchSectionFilterDetails(result);
            if (!details) return null;
            const match = (details.seats || '').match(/seats_avail[^>]*>(\d+)/);
            if (!match) return null;
            return { result, available: Number(match[1]) };
        }));
        return checked
            .filter(item => item && (mode === 'above' ? item.available >= value : item.available < value))
            .map(item => item.result);
    },

    courseAvailability(group) {
        const liveSections = group.sections.filter(section => section.crn && !section._isCatalog);
        if (liveSections.length === 0) return { kind: 'unavailable', text: 'Not offered' };

        const openCount = liveSections.filter(section => section.stat === 'A').length;
        const sectionLabel = liveSections.length === 1 ? 'section' : 'sections';
        if (openCount > 0) {
            return {
                kind: 'open',
                text: `${openCount} of ${liveSections.length} ${sectionLabel} open`,
            };
        }
        return {
            kind: 'full',
            text: liveSections.length === 1 ? '1 section full' : `All ${liveSections.length} sections full`,
        };
    },

    updateCourseSelectionStyles(courseCode) {
        document.querySelectorAll('#search-results .course-group').forEach(course => {
            if (course.dataset.courseCode === courseCode) {
                course.classList.toggle('course-added', State.isCourseSelected(courseCode));
            }
        });
    },

    stripHtml(value) {
        return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    },

    detailLiveSections(group = this._detailGroup) {
        return (group?.sections || []).filter(section => section.crn && !section._isCatalog);
    },

    preferredDetailSection(group) {
        const sections = this.detailLiveSections(group);
        const locked = String(State.sectionLocks?.[group.code] || '');
        const applied = String(State.selectedSections?.[group.code]?.crn || '');
        return sections.find(section => String(section.crn) === locked)
            || sections.find(section => String(section.crn) === applied)
            || sections.find(section => section.stat === 'A')
            || sections[0]
            || null;
    },

    leaveCourseDetail({ focus = true } = {}) {
        this._detailToken = (this._detailToken || 0) + 1;
        this._sectionDetailToken = (this._sectionDetailToken || 0) + 1;
        this.destroyDetailMap();
        this.setBrowseState('results');
        document.querySelectorAll('#search-results .course-group').forEach(card => {
            card.classList.remove('active');
            card.removeAttribute('aria-current');
        });
        const trigger = this._lastDetailTrigger;
        if (!focus) return;
        requestAnimationFrame(() => {
            if (trigger?.isConnected) trigger.focus();
            else document.getElementById('keyword-input')?.focus();
        });
    },

    closeCourseDetail({ historyMode = 'auto' } = {}) {
        const url = new URL(window.location.href);
        url.searchParams.delete('course');
        url.searchParams.delete('crn');
        url.searchParams.delete('panel');
        const resultUrl = `${url.pathname}${url.search}`;
        const canReturnToParent = historyMode === 'auto'
            && history.state?.courseDetail
            && history.state?.detailParent === resultUrl;
        this.leaveCourseDetail();
        if (historyMode === 'none') return;
        if (canReturnToParent) {
            history.back();
            return;
        }
        this.writeCourseDetailHistory({
            mode: historyMode === 'auto' ? 'replace' : historyMode,
            course: '',
        });
    },

    handleCourseTabKeydown(event) {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const tabs = [...document.querySelectorAll('[data-course-tab]')];
        const index = tabs.indexOf(event.currentTarget);
        if (index < 0) return;
        event.preventDefault();
        const nextIndex = event.key === 'Home'
            ? 0
            : event.key === 'End'
                ? tabs.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        this.setCourseDetailTab(tabs[nextIndex].dataset.courseTab, true);
    },

    setCourseDetailTab(tab, focus = false, historyMode = 'replace') {
        const allowed = new Set(['overview', 'grades', 'history', 'resources']);
        const active = allowed.has(tab) ? tab : 'overview';
        const scrollContainer = document.getElementById('semester-content');
        const savedScrollTop = Number(scrollContainer?.scrollTop) || 0;
        const panelHost = document.querySelector?.('.course-detail-panels');
        if (scrollContainer && panelHost) {
            const viewportHeight = Math.max(0, Number(scrollContainer.clientHeight) || 0);
            const scrollRect = scrollContainer.getBoundingClientRect?.();
            const panelRect = panelHost.getBoundingClientRect?.();
            const panelTop = scrollRect && panelRect
                ? savedScrollTop + panelRect.top - scrollRect.top
                : Number(panelHost.offsetTop) || 0;
            const requiredHeight = Math.max(
                viewportHeight,
                savedScrollTop + viewportHeight - panelTop,
            );
            if (requiredHeight > 0) panelHost.style.minHeight = `${Math.ceil(requiredHeight)}px`;
        }
        this._detailTab = active;
        document.querySelectorAll('[data-course-tab]').forEach(button => {
            const selected = button.dataset.courseTab === active;
            button.setAttribute('aria-selected', String(selected));
            button.tabIndex = selected ? 0 : -1;
            if (selected && focus) button.focus({ preventScroll: true });
        });
        document.querySelectorAll('[data-course-panel]').forEach(panel => {
            panel.hidden = panel.dataset.coursePanel !== active;
        });
        this.loadCourseDetailTab(active);
        if (this._browseState === 'detail') {
            this.writeCourseDetailHistory({ mode: historyMode });
        }
        const restoreScroll = () => {
            if (!scrollContainer
                || scrollContainer.isConnected === false
                || this._detailTab !== active) return;
            scrollContainer.scrollTop = savedScrollTop;
        };
        restoreScroll();
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restoreScroll);
    },

    loadCourseDetailTab(tab) {
        const code = this._detailGroup?.code;
        if (!code) return;
        const loadKey = `${this._detailToken}:${tab}`;
        if (this._detailLoads[loadKey]) return;
        this._detailLoads[loadKey] = true;
        if (tab === 'grades' && typeof Grades !== 'undefined') Grades.loadForCourse(code);
        if (tab === 'history' && typeof History !== 'undefined') History.loadForCourse(code);
        if (tab === 'resources') this.renderCourseResources();
    },

    async hydrateFullDetailGroup(group, token, term) {
        const subject = String(group.code || '').split(' ')[0];
        if (!subject) return;
        try {
            const data = await API.searchCourses(term, [{ field: 'subject', value: subject }]);
            if (token !== this._detailToken || term !== this._detailTerm) return;
            const sections = (data.results || []).filter(section => section.code === group.code);
            if (!sections.length) return;
            const viewedCrn = this._detailSectionCrn;
            this._detailGroup = { ...group, sections };
            if (!sections.some(section => String(section.crn) === viewedCrn)) {
                this._detailSectionCrn = String(this.preferredDetailSection(this._detailGroup)?.crn || '');
            }
            if (this._detailTab === 'grades' && typeof Grades !== 'undefined') {
                Grades.refreshCourseFaculty(group.code);
            }
            this.renderCourseDetailHeader(this._detailDetails);
            this.renderDetailSections();
            this.selectDetailSection(this._detailSectionCrn, false, 'replace');
        } catch (error) {
            // The filtered result sections remain usable if full-course hydration fails.
        }
    },

    showCourseDetail(group, {
        sectionCrn = '',
        panel = 'overview',
        historyMode = 'push',
    } = {}) {
        const detailsTab = document.getElementById('tab-details');
        if (!detailsTab || !group) return;
        if (historyMode !== 'none') this.cancelLocationRestore();
        this._detailToken = (this._detailToken || 0) + 1;
        this.destroyDetailMap();
        const token = this._detailToken;
        this._detailTerm = State.term;
        this._detailGroup = group;
        this._detailDetails = null;
        this._detailFaculty = [];
        this._detailSectionData = {};
        this._detailLoads = {};
        const requestedSection = this.detailLiveSections(group).find(section => (
            String(section.crn) === String(sectionCrn)
        ));
        this._detailSectionCrn = String(
            requestedSection?.crn || this.preferredDetailSection(group)?.crn || '',
        );
        if (document.activeElement?.closest?.('.course-group')) {
            this._lastDetailTrigger = document.activeElement.closest('.course-group');
        }
        this.setBrowseState('detail');
        document.querySelectorAll('#search-results .course-group').forEach(card => {
            const selected = card.dataset.courseCode === group.code;
            card.classList.toggle('active', selected);
            if (selected) card.setAttribute('aria-current', 'true');
            else card.removeAttribute('aria-current');
        });

        this.renderCourseDetailHeader(null);
        this.renderDetailSections();
        this.selectDetailSection(this._detailSectionCrn, false, 'none');
        this.setCourseDetailTab(panel, false, 'none');
        const currentHasDetail = new URL(window.location.href).searchParams.has('course');
        this.writeCourseDetailHistory({
            mode: historyMode === 'push' && currentHasDetail ? 'replace' : historyMode,
        });
        if (typeof Prereqs !== 'undefined') Prereqs.loadForCourse(group.code);
        this.hydrateFullDetailGroup(group, token, this._detailTerm);
        this.fetchBulletinDetailsForCourse(group.code).then(details => {
            if (token !== this._detailToken) return;
            this._detailDetails = details || {};
            this.renderCourseDetailHeader(this._detailDetails);
            this.renderCourseOverview();
            this.renderCourseResources();
        }).catch(() => {
            if (token !== this._detailToken) return;
            this._detailDetails = {};
            this.renderCourseDetailHeader(this._detailDetails);
        });
    },

    renderCourseDetailHeader(details) {
        const header = document.getElementById('tab-details');
        const descriptionWrap = document.getElementById('course-detail-description-wrap');
        const group = this._detailGroup;
        if (!header || !group) return;
        const availability = this.courseAvailability(group);
        const selected = State.isCourseSelected(group.code);
        const unavailable = availability.kind === 'unavailable' && !selected;
        const credits = typeof Scheduler !== 'undefined'
            ? Scheduler.parseCreditHours(details?.hours_html || group.credits || this.detailLiveSections(group)[0]?.hours)
            : null;
        const description = this.stripHtml(details?.description);
        const descriptionMarkup = description
            ? `<p class="course-detail-description">${this.escapeText(description)}</p>`
            : details === null
                ? '<p class="course-detail-description loading">Loading course description</p>'
                : '<p class="course-detail-description unavailable">Course description is unavailable.</p>';
        const selectedSection = this.currentDetailSection();
        const sectionContext = selectedSection
            ? `Section ${selectedSection.section || '—'} · CRN ${selectedSection.crn}`
            : 'No section selected';
        header.innerHTML = `
            <div class="course-detail-header-topline">
                <div class="course-detail-kicker">Course details</div>
                <div class="course-detail-header-controls">
                    <div class="course-detail-primary-actions">
                        <button id="btn-course-toggle" type="button" class="${selected ? 'btn-danger' : unavailable ? 'btn-course-unavailable' : 'btn-green'}" title="${selected ? 'Remove this course from the semester scheduler' : unavailable ? 'This course has no sections in the selected term' : 'Add this course so the scheduler can choose a section'}"${unavailable ? ' disabled' : ''}>${selected ? 'REMOVE COURSE' : unavailable ? 'NOT OFFERED THIS TERM' : 'ADD COURSE'}</button>
                        <button id="btn-course-view-schedule" type="button" class="btn-header-secondary" title="Open the semester schedule builder">VIEW SCHEDULE</button>
                    </div>
                    <div class="course-detail-credit"><strong>${credits ?? '—'}</strong><span>${credits === 1 ? 'credit' : 'credits'}</span></div>
                </div>
            </div>
            <div class="course-detail-title-row">
                <div class="course-detail-title-copy">
                    <h1><span>${this.escapeText(group.code)}</span>${this.escapeText(details?.title || group.title || '')}</h1>
                    <div class="course-detail-header-meta">
                        <p class="course-detail-availability ${availability.kind}">${availability.text}</p>
                        <span>${this.escapeText(sectionContext)}</span>
                    </div>
                </div>
            </div>
        `;
        if (descriptionWrap) descriptionWrap.innerHTML = descriptionMarkup;
        header.querySelector('#btn-course-toggle')?.addEventListener('click', async () => {
            if (State.isCourseSelected(group.code)) State.removeCourse(group.code);
            else await Scheduler.addCourseGroup(this._detailGroup);
            this.updateCourseSelectionStyles(group.code);
            this.renderCourseDetailHeader(this._detailDetails);
            const cached = this._detailSectionData?.[this._detailSectionCrn];
            this.renderSectionSummary(this.currentDetailSection(), cached?.details, cached?.faculty || []);
        });
        header.querySelector('#btn-course-view-schedule')?.addEventListener('click', () => {
            Tabs.switchTo('schedule');
        });
    },

    renderCourseOverview() {
        const container = document.getElementById('course-overview-content');
        if (!container || !this._detailGroup) return;
        const details = this._detailDetails || {};
        const sectionDetails = this._detailSectionData?.[this._detailSectionCrn]?.details || {};
        const attributes = [details.attributes, details.carolina_core, details.course_attributes]
            .map(value => this.stripHtml(value)).filter(Boolean);
        const requirements = [
            ['Corequisites', details.corequisite || details.corequisites || sectionDetails.course_coreqs],
            ['Prerequisite or corequisite', details.prerequisite_or_corequisite],
            ['Registration restrictions', details.registration_restrictions || details.restrictions],
        ].map(([label, value]) => [label, this.stripHtml(value)]).filter(([, value]) => value);
        container.innerHTML = `
            ${attributes.length ? `<section class="course-detail-card">
                <div class="course-detail-card-heading"><h2>Course attributes</h2></div>
                <p>${this.escapeText(attributes.join(' · '))}</p>
            </section>` : ''}
            ${requirements.length ? `<section class="course-detail-card">
                <div class="course-detail-card-heading"><h2>Course requirements</h2></div>
                <div class="course-requirement-list">${requirements.map(([label, value]) => `<p><strong>${this.escapeText(label)}</strong><span>${this.escapeText(value)}</span></p>`).join('')}</div>
            </section>` : ''}
        `;
    },

    currentDetailSection() {
        return this.detailLiveSections().find(section => String(section.crn) === String(this._detailSectionCrn)) || null;
    },

    renderDetailSections() {
        const group = this._detailGroup;
        if (!group) return;
        const sections = this.detailLiveSections(group);
        const wrap = document.getElementById('course-section-picker-wrap');
        const picker = document.getElementById('course-section-picker');
        const count = document.getElementById('course-section-picker-count');
        if (!wrap || !picker) return;
        wrap.hidden = sections.length === 0;
        if (count) count.textContent = `${sections.length} this term`;
        if (!sections.length) {
            picker.innerHTML = '<div class="course-detail-empty-state"><strong>Not offered this term</strong><p>This course remains available in catalog search and offering history.</p></div>';
            return;
        }
        picker.innerHTML = sections.map(section => {
            const selected = String(section.crn) === this._detailSectionCrn;
            return `
            <button type="button" class="course-section-option ${section.stat === 'A' ? 'open' : 'full'}" data-detail-crn="${this.escapeText(section.crn)}" aria-pressed="${selected}" tabindex="${selected ? '0' : '-1'}" title="View Section ${this.escapeText(section.section || '—')} details">
                <span><i aria-hidden="true"></i>Section ${this.escapeText(section.section || '—')}<b>${section.stat === 'A' ? 'Open' : 'Full'}</b></span>
                <small>${this.escapeText(section.meets || 'Time TBA')}</small>
                <em>${this.escapeText(section.instr && section.instr !== 'Staff' ? section.instr : 'Instructor TBA')} · CRN ${this.escapeText(section.crn)}</em>
            </button>
        `;
        }).join('');
        picker.querySelectorAll('[data-detail-crn]').forEach(button => {
            button.addEventListener('click', () => this.selectDetailSection(button.dataset.detailCrn));
            button.addEventListener('keydown', event => this.handleSectionPickerKeydown(event));
        });
    },

    handleSectionPickerKeydown(event) {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const buttons = [...document.querySelectorAll('#course-section-picker [data-detail-crn]')];
        const index = buttons.indexOf(event.currentTarget);
        if (index < 0) return;
        event.preventDefault();
        const nextIndex = event.key === 'Home'
            ? 0
            : event.key === 'End'
                ? buttons.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
        this.selectDetailSection(buttons[nextIndex].dataset.detailCrn, true);
    },

    selectDetailSection(crn, focusPicker = true, historyMode = 'replace') {
        const section = this.detailLiveSections().find(item => String(item.crn) === String(crn))
            || this.preferredDetailSection(this._detailGroup);
        this._detailSectionCrn = String(section?.crn || '');
        this._detailFaculty = [];
        this.destroyDetailMap();
        if (this._browseState === 'detail') this.renderCourseDetailHeader(this._detailDetails);
        let selectedButton = null;
        document.querySelectorAll('[data-detail-crn]').forEach(button => {
            const selected = String(button.dataset.detailCrn) === this._detailSectionCrn;
            button.setAttribute('aria-pressed', String(selected));
            button.tabIndex = selected ? 0 : -1;
            button.classList.toggle('selected', selected);
            if (selected) selectedButton = button;
        });
        this.renderSectionSummary(section);
        this.renderCourseResources();
        this.refreshDetailGrades();
        if (this._browseState === 'detail') {
            this.writeCourseDetailHistory({ mode: historyMode });
        }
        requestAnimationFrame(() => {
            selectedButton?.scrollIntoView({ block: 'nearest', inline: 'center' });
            if (focusPicker) selectedButton?.focus();
        });
        if (!section) return;
        const request = (this._sectionDetailToken || 0) + 1;
        this._sectionDetailToken = request;
        const term = this._detailTerm;
        Promise.allSettled([
            API.getDetails(section.crn, term),
            this.loadSectionFaculty(section, term),
        ]).then(([detailsResult, facultyResult]) => {
            if (request !== this._sectionDetailToken || String(section.crn) !== this._detailSectionCrn) return;
            const details = detailsResult.status === 'fulfilled' ? detailsResult.value : null;
            const faculty = facultyResult.status === 'fulfilled' ? facultyResult.value : [];
            this._detailSectionData[this._detailSectionCrn] = { details, faculty };
            this._detailFaculty = faculty;
            this.renderSectionSummary(section, details, faculty);
            this.renderCourseOverview();
            this.renderCourseResources(section, faculty);
            this.refreshDetailGrades();
        });
    },

    refreshDetailGrades() {
        if (this._detailTab !== 'grades' || typeof Grades === 'undefined') return;
        const code = this._detailGroup?.code;
        const data = Grades._courseCache?.[code];
        const container = document.getElementById('grades-container');
        if (data && container) Grades.renderCourse(container, data);
    },

    async loadSectionFaculty(section, term) {
        const key = `${term}:${section.crn}`;
        if (!this._facultyCache[key]) {
            this._facultyCache[key] = API.getFaculty(term, [section.crn])
                .then(data => data.faculty || []).catch(() => []);
        }
        return this._facultyCache[key];
    },

    detailMeetingEvents(section, details = null) {
        const canUseWalkingMap = typeof WalkingMap !== 'undefined';
        const detailMeetings = details?.meeting_html && canUseWalkingMap && WalkingMap.parseMeetingDetails
            ? WalkingMap.parseMeetingDetails(details.meeting_html)
            : [];
        const listedEvents = canUseWalkingMap && WalkingMap.parseMeetingTimes
            ? WalkingMap.parseMeetingTimes(section?.meetingTimes || '')
            : [];
        const fallbackLocation = section?.location || section?.building || '';
        const resolveBuilding = rawLocation => (
            canUseWalkingMap && WalkingMap.resolveBuilding
                ? WalkingMap.resolveBuilding(rawLocation)
                : null
        );
        let events = listedEvents.map(event => {
            const exact = detailMeetings.find(meeting => (
                meeting.days?.includes(event.day)
                && Number.isFinite(meeting.start)
                && Math.abs(meeting.start - event.start) <= 5
            ));
            const sameDay = detailMeetings.find(meeting => meeting.days?.includes(event.day));
            const meeting = exact || sameDay || detailMeetings[0] || null;
            const rawLocation = meeting?.rawLocation || fallbackLocation;
            return {
                ...event,
                rawLocation,
                building: meeting?.building || resolveBuilding(rawLocation),
            };
        });
        if (!events.length) {
            events = detailMeetings.flatMap(meeting => (meeting.days || []).map(day => ({
                day,
                start: meeting.start,
                end: meeting.end,
                rawLocation: meeting.rawLocation || fallbackLocation,
                building: meeting.building || resolveBuilding(meeting.rawLocation || fallbackLocation),
            })));
        }
        return events.filter(event => Number.isFinite(event.day)
            && Number.isFinite(event.start)
            && Number.isFinite(event.end)
            && event.end > event.start);
    },

    sectionCalendarRange(events) {
        const earliestAllowed = 8 * 60;
        const latestAllowed = 21 * 60;
        const minimumSpan = 4 * 60;
        if (!events.length) return { start: earliestAllowed, end: earliestAllowed + minimumSpan };
        const earliest = Math.min(...events.map(event => event.start));
        const latest = Math.max(...events.map(event => event.end));
        let start = Math.max(earliestAllowed, earliest - 30);
        let end = Math.min(latestAllowed, latest + 30);
        if (end <= start) return { start: earliestAllowed, end: earliestAllowed + minimumSpan };
        if (end - start < minimumSpan) {
            end = start + minimumSpan;
            if (end > latestAllowed) {
                end = latestAllowed;
                start = Math.max(earliestAllowed, end - minimumSpan);
            }
        }
        return { start, end };
    },

    formatSectionTime(minutes) {
        if (typeof WalkingMap !== 'undefined' && WalkingMap.formatTime) {
            return WalkingMap.formatTime(minutes);
        }
        const hour24 = Math.floor(minutes / 60);
        const minute = minutes % 60;
        const hour12 = hour24 % 12 || 12;
        return `${hour12}:${String(minute).padStart(2, '0')} ${hour24 >= 12 ? 'PM' : 'AM'}`;
    },

    sectionLocationStyle(index) {
        const palette = [
            { color: '#73000A', foreground: '#FFFFFF' },
            { color: '#466A9F', foreground: '#FFFFFF' },
            { color: '#1F414D', foreground: '#FFFFFF' },
            { color: '#65780B', foreground: '#FFFFFF' },
            { color: '#CC2E40', foreground: '#FFFFFF' },
            { color: '#000000', foreground: '#FFFFFF' },
        ];
        return palette[index % palette.length];
    },

    sectionTimeLocationData(section, details = null) {
        const locations = [];
        const locationIndexes = new Map();
        const events = this.detailMeetingEvents(section, details).map((event, eventIndex) => {
            const rawLocation = String(
                event.rawLocation || section?.location || section?.building || '',
            ).trim();
            let building = event.building || null;
            if ((!building || building.kind === 'unknown')
                && rawLocation
                && typeof WalkingMap !== 'undefined'
                && WalkingMap.resolveBuilding) {
                building = WalkingMap.resolveBuilding(rawLocation);
            }
            const isOnline = building?.kind === 'online'
                || /\bonline\b|\bweb\b|\bremote\b|\bvirtual\b/i.test(rawLocation);
            let locationIndex = null;
            if (rawLocation && !isOnline) {
                const normalized = typeof WalkingMap !== 'undefined' && WalkingMap.normalizeLocation
                    ? WalkingMap.normalizeLocation(rawLocation)
                    : rawLocation.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
                const buildingKey = building?.kind === 'known'
                    ? building.code || building.id || `${building.lat}:${building.lon}`
                    : normalized;
                const key = `${building?.kind === 'known' ? 'building' : 'location'}:${buildingKey}`;
                if (!locationIndexes.has(key)) {
                    locationIndex = locations.length;
                    locationIndexes.set(key, locationIndex);
                    locations.push({
                        index: locationIndex,
                        number: locationIndex + 1,
                        label: rawLocation || building?.name || 'Campus location',
                        building,
                        ...this.sectionLocationStyle(locationIndex),
                    });
                } else {
                    locationIndex = locationIndexes.get(key);
                }
            }
            const style = Number.isInteger(locationIndex)
                ? this.sectionLocationStyle(locationIndex)
                : { color: '#5C5C5C', foreground: '#FFFFFF' };
            return {
                ...event,
                eventIndex,
                rawLocation,
                building,
                locationIndex,
                locationNumber: Number.isInteger(locationIndex) ? locationIndex + 1 : null,
                ...style,
            };
        });
        const range = this.sectionCalendarRange(events);
        const dayCount = events.some(event => event.day > 4) ? 7 : 5;
        return {
            events,
            locations,
            range,
            dayCount,
            rangeLabel: `${this.formatSectionTime(range.start)}–${this.formatSectionTime(range.end)}`,
        };
    },

    renderSectionLocationKey(timeLocation) {
        if (!timeLocation.locations.length) {
            return '<li class="section-location-key-empty">No campus location is listed.</li>';
        }
        return timeLocation.locations.map(location => {
            const unavailable = location.building?.kind !== 'known';
            return `<li style="--location-color:${location.color};--location-foreground:${location.foreground}"><b>${location.number}</b><span>${this.escapeText(location.label)}</span>${unavailable ? '<em>Map location unavailable</em>' : ''}</li>`;
        }).join('');
    },

    renderSectionCalendar(section, details = null, timeLocation = null) {
        const view = timeLocation || this.sectionTimeLocationData(section, details);
        const { events, range, dayCount } = view;
        if (!events.length) {
            return '<div class="section-visual-empty">No scheduled meeting pattern is listed.</div>';
        }
        const dayNames = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].slice(0, dayCount);
        const dayLabels = dayNames.map((day, index) => `<strong style="grid-column:${index + 2};grid-row:1">${day}</strong>`).join('');
        const rowCount = Math.max(1, Math.ceil((range.end - range.start) / 5));
        const dayTracks = dayNames.map((day, index) => `<i class="section-calendar-track" aria-hidden="true" style="grid-column:${index + 2};grid-row:2 / span ${rowCount}"></i>`).join('');
        const halfHourLines = [];
        for (let minute = Math.ceil(range.start / 30) * 30; minute < range.end; minute += 30) {
            const hourClass = minute % 60 === 0 ? ' hour' : '';
            const row = 2 + Math.floor((minute - range.start) / 5);
            halfHourLines.push(`<i class="section-calendar-half-hour${hourClass}" aria-hidden="true" style="grid-column:2 / -1;grid-row:${row}"></i>`);
        }
        const timeLabels = [];
        const labelMinutes = [range.start];
        for (let minute = Math.ceil(range.start / 60) * 60; minute < range.end; minute += 60) {
            if (minute > range.start) labelMinutes.push(minute);
        }
        labelMinutes.forEach(minute => {
            const rowOffset = Math.floor((minute - range.start) / 5);
            const row = 2 + rowOffset;
            const span = Math.max(1, Math.min(6, rowCount - rowOffset));
            timeLabels.push(`<span class="section-calendar-time" style="grid-column:1;grid-row:${row} / span ${span}">${this.escapeText(this.formatSectionTime(minute))}</span>`);
        });
        const blocks = events.map(event => {
            const start = Math.max(range.start, event.start);
            const end = Math.min(range.end, event.end);
            if (end <= start || event.day < 0 || event.day >= dayCount) return '';
            const row = 2 + Math.floor((start - range.start) / 5);
            const span = Math.max(1, Math.ceil((end - start) / 5));
            const location = event.rawLocation ? ` · ${event.rawLocation}` : '';
            const title = `${dayNames[event.day]} ${this.formatSectionTime(event.start)}–${this.formatSectionTime(event.end)}${location}`;
            const locationAttribute = Number.isInteger(event.locationIndex)
                ? ` data-location-index="${event.locationIndex}"`
                : '';
            const locationNumber = event.locationNumber
                ? `<b class="section-calendar-location-number" aria-hidden="true">${event.locationNumber}</b>`
                : '';
            const focusable = event.locationNumber ? ' tabindex="0"' : '';
            return `<span${focusable} class="section-calendar-event"${locationAttribute} title="${this.escapeText(title)}" aria-label="${this.escapeText(title)}" style="--event-color:${event.color};--event-foreground:${event.foreground};grid-column:${event.day + 2};grid-row:${row} / span ${span}">${locationNumber}<span>${this.escapeText(this.formatSectionTime(event.start).replace(' ', ''))}</span></span>`;
        }).join('');
        const label = `Weekly meeting calendar from ${this.formatSectionTime(range.start)} to ${this.formatSectionTime(range.end)}`;
        return `<div class="section-mini-calendar-grid" role="group" aria-label="${this.escapeText(label)}" style="grid-template-columns:48px repeat(${dayCount}, minmax(0, 1fr));grid-template-rows:28px repeat(${rowCount}, minmax(2px, 1fr))">${dayLabels}${timeLabels.join('')}${dayTracks}${halfHourLines.join('')}${blocks}</div>`;
    },

    bindSectionTimeLocationInteractions(root) {
        root?.querySelectorAll?.('.section-calendar-event[data-location-index]').forEach(block => {
            const locationIndex = Number(block.dataset.locationIndex);
            block.addEventListener('mouseenter', () => this.setSectionLocationInteractionState(block, locationIndex, 'hover', true));
            block.addEventListener('mouseleave', () => this.setSectionLocationInteractionState(block, locationIndex, 'hover', false));
            block.addEventListener('focus', () => this.setSectionLocationInteractionState(block, locationIndex, 'focus', true));
            block.addEventListener('blur', () => this.setSectionLocationInteractionState(block, locationIndex, 'focus', false));
        });
    },

    setSectionLocationInteractionState(element, locationIndex, state, active) {
        if (!element) return;
        const property = state === 'focus' ? 'locationFocus' : 'locationHover';
        if (active) element.dataset[property] = 'true';
        else delete element.dataset[property];
        this.syncSectionLocationHighlight(locationIndex);
    },

    syncSectionLocationHighlight(locationIndex) {
        const root = document.getElementById('course-section-summary');
        const blocks = [...(root?.querySelectorAll?.(`.section-calendar-event[data-location-index="${locationIndex}"]`) || [])];
        const markerElement = this._detailLocationMarkers?.[locationIndex]?.getElement?.();
        const sources = markerElement ? [...blocks, markerElement] : blocks;
        const active = sources.some(element => (
            element.dataset.locationHover === 'true'
            || element.dataset.locationFocus === 'true'
        ));
        this.setSectionLocationHighlight(locationIndex, active);
    },

    setSectionLocationHighlight(locationIndex, active) {
        const root = document.getElementById('course-section-summary');
        root?.querySelectorAll?.(`.section-calendar-event[data-location-index="${locationIndex}"]`)
            .forEach(block => block.classList.toggle('is-location-highlighted', active));
        const marker = this._detailLocationMarkers?.[locationIndex];
        const markerElement = marker?.getElement?.();
        markerElement?.classList.toggle('is-location-highlighted', active);
        marker?.setZIndexOffset?.(active ? 1000 : 0);
    },

    detailTimeLocationExpanded() {
        try {
            if (typeof localStorage === 'undefined') return true;
            return localStorage.getItem(this._detailTimeLocationPreferenceKey) !== 'false';
        } catch (error) {
            return true;
        }
    },

    setDetailTimeLocationExpanded(expanded) {
        try {
            if (typeof localStorage !== 'undefined') {
                localStorage.setItem(this._detailTimeLocationPreferenceKey, String(Boolean(expanded)));
            }
        } catch (error) {
            // A blocked preference store should not prevent the control from working.
        }
    },

    bindDetailTimeLocationPreference(root, { onExpand, onCollapse } = {}) {
        const disclosure = root?.querySelector?.('[data-time-location-toggle]');
        const content = root?.querySelector?.('[data-time-location-content]');
        const expanded = this.detailTimeLocationExpanded();
        if (!disclosure || !content) return expanded;
        const isDetails = String(disclosure.tagName || '').toUpperCase() === 'DETAILS';
        const control = isDetails ? disclosure.querySelector('summary') : disclosure;
        const reflect = value => {
            if (isDetails) disclosure.open = value;
            content.hidden = !value;
            control?.setAttribute('aria-expanded', String(value));
        };
        const changed = value => {
            content.hidden = !value;
            control?.setAttribute('aria-expanded', String(value));
            this.setDetailTimeLocationExpanded(value);
            if (value) onExpand?.();
            else onCollapse?.();
        };
        reflect(expanded);
        if (isDetails) {
            disclosure.addEventListener('toggle', () => changed(Boolean(disclosure.open)));
        } else {
            disclosure.addEventListener('click', () => {
                const next = control?.getAttribute('aria-expanded') !== 'true';
                reflect(next);
                changed(next);
            });
        }
        return expanded;
    },

    detailTimeLocationVisible(container) {
        const content = container?.closest?.('[data-time-location-content]');
        if (!content) return true;
        if (content.hidden) return false;
        const details = content.closest?.('details[data-time-location-toggle]');
        return !details || details.open;
    },

    sectionRegistrationNotes(details = null) {
        if (!details) return '';
        const clean = value => this.stripHtml(value);
        const restrictions = typeof Scheduler !== 'undefined'
            ? Scheduler.registrationRestrictionText(details.registration_restrictions)
            : clean(details.registration_restrictions);
        const rows = [
            ['Section corequisites', clean(details.section_coreqs)],
            ['Registration restrictions', restrictions],
            ['Class notes', clean(details.clssnotes)],
        ].filter(([, value]) => value && !/^none listed$/i.test(value));
        if (!rows.length) return '';
        return `<section class="course-section-registration"><div class="course-detail-card-heading"><h3>Registration notes for this section</h3></div><div>${rows.map(([label, value]) => {
            const attention = label === 'Class notes'
                || label === 'Section corequisites'
                || (label === 'Registration restrictions' && typeof Scheduler !== 'undefined' && Scheduler.registrationRestrictionNeedsAttention(value));
            return `<p class="${attention ? 'attention' : ''}"><strong>${this.escapeText(label)}</strong><span>${this.escapeText(value)}</span></p>`;
        }).join('')}</div></section>`;
    },

    destroyDetailMap() {
        this._detailLocationMarkers = [];
        if (!this._detailMap) return;
        try { this._detailMap.remove(); } catch (error) { /* Map cleanup is best effort. */ }
        this._detailMap = null;
    },

    async renderSectionMap(section, details = null) {
        const container = document.getElementById('course-section-map');
        if (!container || !section || typeof WalkingMap === 'undefined') return;
        if (!this.detailTimeLocationVisible(container)) return;
        const request = this._sectionDetailToken;
        const crn = String(section.crn || '');
        if (!WalkingMap.buildings?.length && WalkingMap.loadBuildings) {
            await WalkingMap.loadBuildings();
            if (request !== this._sectionDetailToken
                || crn !== this._detailSectionCrn
                || !this.detailTimeLocationVisible(container)) return;
        }
        const timeLocation = this.sectionTimeLocationData(section, details);
        const timeLocationRoot = container.closest?.('.course-time-location');
        const calendarHost = timeLocationRoot?.querySelector?.('[data-section-calendar]');
        if (calendarHost) {
            calendarHost.innerHTML = this.renderSectionCalendar(section, details, timeLocation);
            const rangeLabel = timeLocationRoot.querySelector?.('[data-calendar-range]');
            if (rangeLabel) rangeLabel.textContent = timeLocation.rangeLabel;
            this.bindSectionTimeLocationInteractions(timeLocationRoot);
        }
        const locationKey = timeLocationRoot?.querySelector?.('[data-location-key]');
        if (locationKey) locationKey.innerHTML = this.renderSectionLocationKey(timeLocation);
        const locations = timeLocation.locations.filter(location => (
            location.building?.kind === 'known'
            && Number.isFinite(Number(location.building.lat))
            && Number.isFinite(Number(location.building.lon))
        ));
        this._detailLocationMarkers = [];
        if (!locations.length) {
            container.innerHTML = '<div class="section-visual-empty">No campus map location is available for this section.</div>';
            return;
        }
        try {
            await WalkingMap.loadLeaflet();
            if (request !== this._sectionDetailToken
                || crn !== this._detailSectionCrn
                || !container.isConnected
                || !this.detailTimeLocationVisible(container)) return;
            this.destroyDetailMap();
            container.replaceChildren();
            this._detailMap = L.map(container, {
                attributionControl: true,
                dragging: true,
                scrollWheelZoom: false,
                zoomControl: true,
            });
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '&copy; OpenStreetMap contributors',
            }).addTo(this._detailMap);
            const bounds = L.latLngBounds([]);
            locations.forEach(location => {
                const { building } = location;
                bounds.extend([building.lat, building.lon]);
                const markerLabel = `Location ${location.number}: ${location.label || building.name}`;
                const meetingLabels = [...new Set(timeLocation.events
                    .filter(event => event.locationIndex === location.index)
                    .map(event => {
                        const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][event.day] || '';
                        return `${day} ${this.formatSectionTime(event.start)}–${this.formatSectionTime(event.end)}`;
                    }))];
                const marker = L.marker([building.lat, building.lon], {
                    alt: markerLabel,
                    title: markerLabel,
                    keyboard: true,
                    riseOnHover: true,
                    icon: L.divIcon({
                        className: '',
                        html: `<span class="course-section-map-pin" aria-hidden="true" style="--location-color:${location.color};--location-foreground:${location.foreground}">${location.number}</span>`,
                        iconSize: [30, 30],
                        iconAnchor: [15, 15],
                    }),
                }).bindPopup(`<strong>${this.escapeText(markerLabel)}</strong>${meetingLabels.length ? `<span>${this.escapeText(meetingLabels.join(' · '))}</span>` : ''}`).addTo(this._detailMap);
                this._detailLocationMarkers[location.index] = marker;
                const markerElement = marker.getElement?.();
                markerElement?.addEventListener('mouseenter', () => this.setSectionLocationInteractionState(markerElement, location.index, 'hover', true));
                markerElement?.addEventListener('mouseleave', () => this.setSectionLocationInteractionState(markerElement, location.index, 'hover', false));
                markerElement?.addEventListener('focus', () => this.setSectionLocationInteractionState(markerElement, location.index, 'focus', true));
                markerElement?.addEventListener('blur', () => this.setSectionLocationInteractionState(markerElement, location.index, 'focus', false));
            });
            if (locations.length === 1) {
                const building = locations[0].building;
                this._detailMap.setView([building.lat, building.lon], 17);
            }
            else this._detailMap.fitBounds(bounds, { maxZoom: 17, padding: [32, 32] });
            setTimeout(() => this._detailMap?.invalidateSize(), 0);
        } catch (error) {
            if (container.isConnected) container.innerHTML = '<div class="section-visual-empty">The campus map could not load.</div>';
        }
    },

    renderSectionSummary(section, details = null, faculty = []) {
        const container = document.getElementById('course-section-summary');
        const group = this._detailGroup;
        if (!container || !group || !section) {
            if (container) container.innerHTML = '';
            return;
        }
        this.destroyDetailMap();
        const meeting = this.parseMeetingHtml(details?.meeting_html || '');
        const times = meeting.times.length ? meeting.times.join('; ') : (section.meets || 'TBA');
        const locations = meeting.locations.length ? meeting.locations.join('; ') : 'TBA';
        const seatsAvailable = String(details?.seats || '').match(/seats_avail[^>]*>(\d+)/)?.[1];
        const seatsMax = String(details?.seats || '').match(/seats_max[^>]*>(\d+)/)?.[1];
        const primaryFaculty = faculty.find(person => person.primary) || faculty[0];
        const instructorRawName = primaryFaculty?.name
            || (section.instr && section.instr !== 'Staff' ? section.instr : 'Instructor TBA');
        const instructorName = instructorRawName === 'Instructor TBA'
            ? instructorRawName
            : (typeof Grades !== 'undefined' && Grades.displayProfessorName
                ? Grades.displayProfessorName(instructorRawName)
                : instructorRawName);
        const locked = String(State.sectionLocks?.[group.code] || '') === String(section.crn);
        const sectionLabel = this.escapeText(section.section || '—');
        const actionLabel = locked
            ? 'LET SCHEDULER CHOOSE'
            : 'ADD THIS SECTION TO SCHEDULE';
        const actionTitle = locked
            ? 'Allow the scheduler to choose any eligible section'
            : `Use Section ${sectionLabel} in every generated schedule`;
        const seatKind = seatsAvailable !== undefined
            ? (Number(seatsAvailable) > 0 ? 'open' : 'full')
            : (section.stat === 'A' ? 'open' : 'full');
        const seatPrimary = seatsAvailable !== undefined
            ? (Number(seatsAvailable) > 0 ? `${seatsAvailable} seats available` : 'No seats available')
            : (section.stat === 'A' ? 'Seats available' : 'Section full');
        const seatSecondary = seatsMax ? `${seatsAvailable || 0} of ${seatsMax} seats` : (section.stat === 'A' ? 'Listed as open' : 'Listed as full');
        const fullNotice = seatKind === 'open' ? '' : '<p class="course-section-full-note">You can still use this full section for planning.</p>';
        const timeLocation = this.sectionTimeLocationData(section, details);
        container.innerHTML = `
            <div class="course-section-summary-heading">
                <div><span>Viewing</span><strong>Section ${this.escapeText(section.section || '—')}</strong></div>
                <div class="course-section-seat-count ${seatKind}"><strong>${this.escapeText(seatPrimary)}</strong><span>${this.escapeText(seatSecondary)}</span></div>
            </div>
            <div class="course-section-facts">
                <div><span>Instructor</span>${instructorName === 'Instructor TBA'
                    ? `<strong>${instructorName}</strong>`
                    : `<button type="button" id="btn-section-professor" title="Open this instructor's profile">${this.escapeText(instructorName)}</button>${primaryFaculty?.email ? `<a href="mailto:${this.escapeText(primaryFaculty.email)}">${this.escapeText(primaryFaculty.email)}</a>` : ''}`}</div>
                <div><span>Meeting</span><strong>${this.escapeText(times)}</strong></div>
                <div><span>Location</span><strong>${this.escapeText(locations)}</strong></div>
                <div><span>CRN</span><strong>${this.escapeText(section.crn)}</strong></div>
                <div><span>Method</span><strong>${this.escapeText(details?.inst_mthd || section.inst_mthd || 'Not listed')}</strong></div>
                <div><span>Course dates</span><strong>${this.escapeText(section.start_date && section.end_date ? `${section.start_date}–${section.end_date}` : 'Full-term dates')}</strong></div>
            </div>
            ${fullNotice}
            <div class="course-section-actions">
                <button id="btn-use-detail-section" type="button" class="${locked ? 'btn-secondary' : 'btn-garnet'}" title="${actionTitle}">${actionLabel}</button>
            </div>
            ${this.sectionRegistrationNotes(details)}
            <details class="course-time-location" data-time-location-toggle open>
                <summary id="course-time-location-toggle" class="course-time-location-toggle" aria-expanded="true" aria-controls="course-time-location-content">
                    <span><strong>Time &amp; location</strong><small>Weekly meeting pattern and campus map</small></span>
                    <i aria-hidden="true"></i>
                </summary>
                <div id="course-time-location-content" class="course-time-location-content" data-time-location-content>
                    <div class="course-section-visuals">
                        <section class="course-section-visual-card"><div class="course-section-visual-heading"><strong>Weekly meeting pattern</strong><span data-calendar-range>${this.escapeText(timeLocation.rangeLabel)}</span></div><div data-section-calendar>${this.renderSectionCalendar(section, details, timeLocation)}</div></section>
                        <section class="course-section-visual-card"><div class="course-section-visual-heading"><strong>Campus locations</strong><span>${this.escapeText(locations)}</span></div><div id="course-section-map" class="course-section-map" role="region" aria-label="All listed section campus locations"></div><ol class="course-section-location-key" data-location-key aria-label="Meeting location key">${this.renderSectionLocationKey(timeLocation)}</ol></section>
                    </div>
                </div>
            </details>
        `;
        this.bindSectionTimeLocationInteractions(container);
        const initialTimeLocationExpanded = this.bindDetailTimeLocationPreference(container, {
            onExpand: () => requestAnimationFrame(() => this.renderSectionMap(section, details)),
            onCollapse: () => this.destroyDetailMap(),
        });
        if (initialTimeLocationExpanded) requestAnimationFrame(() => this.renderSectionMap(section, details));
        container.querySelector('#btn-use-detail-section')?.addEventListener('click', async () => {
            if (!State.isCourseSelected(group.code)) await Scheduler.addCourseGroup(this._detailGroup);
            State.setSectionLock(group.code, locked ? null : section.crn);
            this.updateCourseSelectionStyles(group.code);
            this.renderCourseDetailHeader(this._detailDetails);
            this.renderSectionSummary(section, details, faculty);
        });
        container.querySelector('#btn-section-professor')?.addEventListener('click', () => {
            if (typeof Grades === 'undefined') return;
            if (primaryFaculty?.professor_id) {
                Grades.showProfessor(primaryFaculty.professor_id, {
                    displayName: instructorName,
                    email: primaryFaculty.email || '',
                    currentCourse: group.code,
                    detailToken: this._detailToken,
                    detailCode: group.code,
                });
            } else {
                Grades.showProfessorForCourseName(group.code, instructorName, primaryFaculty?.email || '');
            }
        });
    },

    parseBookstoreOrder(html) {
        if (!html) return null;
        try {
            const documentNode = new DOMParser().parseFromString(html, 'text/html');
            const sourceForm = documentNode.querySelector('form');
            if (!sourceForm) return null;
            const action = new URL(sourceForm.getAttribute('action') || '', window.location.href);
            if (action.protocol !== 'https:'
                || action.hostname !== 'sc.bncollege.com'
                || action.port) return null;
            const allowed = ['catalogId', 'storeId', 'termMapping', 'courseXml'];
            const fields = {};
            allowed.forEach(name => {
                const input = sourceForm.querySelector(`input[name="${name}"]`);
                if (input?.value) fields[name] = input.value;
            });
            if (!fields.courseXml) return null;
            return { action: action.href, fields };
        } catch (error) {
            return null;
        }
    },

    submitBookstoreOrder(order) {
        if (!order?.action || !order.fields) return;
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = order.action;
        form.target = '_blank';
        form.rel = 'noopener noreferrer';
        Object.entries(order.fields).forEach(([name, value]) => {
            const input = document.createElement('input');
            input.type = 'hidden';
            input.name = name;
            input.value = value;
            form.appendChild(input);
        });
        document.body.appendChild(form);
        form.submit();
        form.remove();
    },

    bulletinResourceUrl(courseCode) {
        const url = new URL('https://academicbulletins.sc.edu/search/');
        url.searchParams.set('P', String(courseCode || '').trim());
        return url.href;
    },

    syllabusResourceUrl(courseCode) {
        const match = String(courseCode || '').trim().match(/^([A-Z]{2,4})\s*(\d{3}[A-Z]?)/i);
        if (!match) return 'https://www.sc.edu/syllabusarchive/';
        const url = new URL('https://www.sc.edu/syllabusarchive/studentcourselist.php');
        url.searchParams.set('designator', match[1].toUpperCase());
        url.searchParams.set('courseNumber', match[2].toUpperCase());
        url.searchParams.set('instructor', '');
        url.searchParams.set('term', 'all');
        return url.href;
    },

    renderCourseResources(section = this.currentDetailSection(), faculty = this._detailFaculty || []) {
        const container = document.getElementById('course-resource-links');
        const group = this._detailGroup;
        if (!container || !group) return;
        const primaryFaculty = faculty.find(person => person.primary) || faculty[0];
        const professorRaw = primaryFaculty?.name || (section?.instr && section.instr !== 'Staff' ? section.instr : '');
        const professor = typeof Grades !== 'undefined' && Grades.displayProfessorName
            ? Grades.displayProfessorName(professorRaw)
            : professorRaw;
        const query = encodeURIComponent(`${group.code} ${group.title || ''} University of South Carolina course review`);
        const professorQuery = encodeURIComponent(`${professor} University of South Carolina professor`);
        const sectionDetails = this._detailSectionData?.[String(section?.crn || '')]?.details || null;
        const bookstoreOrder = this.parseBookstoreOrder(sectionDetails?.bn_order_books_html);
        const hasSelectedSection = Boolean(section?.crn);
        const classDetailsUrl = section?.crn
            ? `https://classes.sc.edu/?details&srcdb=${encodeURIComponent(this._detailTerm || State.term)}&crn=${encodeURIComponent(section.crn)}`
            : `https://classes.sc.edu/?details&srcdb=${encodeURIComponent(this._detailTerm || State.term)}&code=${encodeURIComponent(group.code)}`;
        const bulletinUrl = this.bulletinResourceUrl(group.code);
        const syllabusUrl = this.syllabusResourceUrl(group.code);
        const bookstoreCard = bookstoreOrder
            ? '<button id="btn-resource-bookstore" type="button" class="course-resource-link" title="Open official materials for the selected section in a new tab"><span><strong>Bookstore materials</strong><small>Required and recommended materials for this section</small></span><b aria-hidden="true">↗</b></button>'
            : hasSelectedSection
                ? `<a class="course-resource-link" href="${classDetailsUrl}" target="_blank" rel="noopener noreferrer" title="Open official class details and use Order Books"><span><strong>Bookstore materials</strong><small>Open class details, then choose Order Books</small></span><b aria-hidden="true">↗</b></a>`
                : `<a class="course-resource-link" href="${classDetailsUrl}" target="_blank" rel="noopener noreferrer" title="Find a current section before opening its books"><span><strong>Bookstore materials</strong><small>Choose a current section, then use Order Books</small></span><b aria-hidden="true">↗</b></a>`;
        container.innerHTML = `
            <div class="course-resource-layout">
            <section class="course-resource-section official">
                <header><div><span>Official university</span><h2>Course resources</h2></div><small>${hasSelectedSection ? `Section ${this.escapeText(section.section || '—')}` : 'Course-wide'}</small></header>
                <div class="course-resource-list">
                    <a class="course-resource-link" href="${classDetailsUrl}" target="_blank" rel="noopener noreferrer" title="Open the official class-search record for this section"><span><strong>Class details</strong><small>Meeting, registration, deadlines, and final-exam information</small></span><b aria-hidden="true">↗</b></a>
                    ${bookstoreCard}
                    <a class="course-resource-link" href="${bulletinUrl}" target="_blank" rel="noopener noreferrer" title="Open exact Academic Bulletin results for ${this.escapeText(group.code)}"><span><strong>Academic Bulletin</strong><small>Official catalog entry for ${this.escapeText(group.code)}</small></span><b aria-hidden="true">↗</b></a>
                    <a class="course-resource-link" href="${syllabusUrl}" target="_blank" rel="noopener noreferrer" title="Open all archived syllabi for ${this.escapeText(group.code)}"><span><strong>Syllabus archive</strong><small>All available terms and instructors · Sign-in may be required</small></span><b aria-hidden="true">↗</b></a>
                    ${professor ? `<a class="course-resource-link" href="https://sc.edu/about/directory/" target="_blank" rel="noopener noreferrer" title="Open the official faculty and staff directory"><span><strong>Faculty directory</strong><small>Find ${this.escapeText(professor)} in the university directory</small></span><b aria-hidden="true">↗</b></a>` : ''}
                </div>
            </section>
            <section class="course-resource-section external">
                <header><div><span>Independent sites</span><h2>Reviews</h2></div></header>
                <div class="course-resource-list">
                    <a class="course-resource-link" href="https://www.google.com/search?q=${query}" target="_blank" rel="noopener noreferrer" title="Search the web for independent course feedback"><span><strong>Course reviews</strong><small>Search the web for feedback about ${this.escapeText(group.code)}</small></span><b aria-hidden="true">↗</b></a>
                    ${professor ? `<a class="course-resource-link" href="https://www.ratemyprofessors.com/search/professors?q=${professorQuery}" target="_blank" rel="noopener noreferrer" title="Search Rate My Professors for ${this.escapeText(professor)}"><span><strong>Professor reviews</strong><small>Search Rate My Professors for ${this.escapeText(professor)}</small></span><b aria-hidden="true">↗</b></a>` : ''}
                </div>
            </section>
            </div>
        `;
        container.querySelector('#btn-resource-bookstore')?.addEventListener('click', () => this.submitBookstoreOrder(bookstoreOrder));
    },

    escapeText(value) {
        const element = document.createElement('span');
        element.textContent = String(value ?? '');
        return element.innerHTML;
    },

    observeCourseResultSummary(element, group) {
        if (typeof IntersectionObserver === 'undefined') return;
        if (!this._resultSummaryObserver) {
            this._resultSummaryObserver = new IntersectionObserver(entries => {
                entries.forEach(entry => {
                    if (!entry.isIntersecting) return;
                    this._resultSummaryObserver.unobserve(entry.target);
                    const code = entry.target.dataset.courseCode;
                    const matchedGroup = (State.courseGroups || []).find(item => item.code === code);
                    if (matchedGroup) this.hydrateCourseResultSummary(entry.target, matchedGroup);
                });
            }, {
                root: document.getElementById('search-results'),
                rootMargin: '160px 0px',
            });
        }
        element.dataset.courseCode = group.code;
        this._resultSummaryObserver.observe(element);
    },

    async hydrateCourseResultSummary(element, group) {
        if (!this._resultSummaryCache[group.code]) {
            this._resultSummaryCache[group.code] = Promise.allSettled([
                this.fetchBulletinDetailsForCourse(group.code),
                API.getCourseGrades(group.code),
            ]).then(([detailsResult, gradesResult]) => ({
                details: detailsResult.status === 'fulfilled' ? detailsResult.value : {},
                grades: gradesResult.status === 'fulfilled' && !gradesResult.value?.error
                    ? gradesResult.value
                    : {},
            }));
        }
        const { details, grades } = await this._resultSummaryCache[group.code];
        if (!element.isConnected) return;
        const fullDescription = String(details?.description || '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const description = fullDescription
            ? `${fullDescription.slice(0, 185)}${fullDescription.length > 185 ? '…' : ''}`
            : 'Course description unavailable.';
        const averageGpa = Number(grades?.average_gpa);
        const gradedStudents = Number(grades?.graded_students || 0);
        element.innerHTML = `
            <p class="course-result-description">${this.escapeText(description)}</p>
            ${Number.isFinite(averageGpa) && averageGpa > 0
                ? `<p class="course-result-grade"><strong>${averageGpa.toFixed(2)} historical GPA</strong><span>${gradedStudents.toLocaleString()} grades</span></p>`
                : '<p class="course-result-grade unavailable">Historical grades unavailable</p>'}
        `;
    },

    generatedSearchesMarkup(searchTerms) {
        if (!searchTerms?.length) return '';
        const expandedTags = searchTerms.map((search, index) => {
            const term = typeof search === 'string' ? search : search.term;
            const failed = typeof search === 'object' && Boolean(search.failed);
            const resultCount = typeof search === 'string' ? null : Number(search.count);
            const countLabel = failed
                ? 'Search failed'
                : Number.isFinite(resultCount)
                    ? `${resultCount.toLocaleString()} ${resultCount === 1 ? 'course' : 'courses'}`
                    : '';
            const disabled = !failed && Number.isFinite(resultCount) && resultCount === 0
                ? ' disabled'
                : '';
            const failedClass = failed ? ' is-failed' : '';
            const dataCount = failed ? -1 : (resultCount || 0);
            return `<button type="button" class="semantic-search-term${failedClass}" data-regular-search-index="${index}" data-result-count="${dataCount}"${disabled}><span>${this.escapeText(term)}</span>${countLabel ? `<strong>${countLabel}</strong>` : ''}</button>`;
        }).join(' ');
        return `
            <div class="semantic-search-terms">
                <button type="button" class="semantic-search-terms-toggle" aria-expanded="false" aria-controls="semantic-search-term-list">
                    <span><b>${searchTerms.length} Generated searches</b></span><i aria-hidden="true">&#9660;</i>
                </button>
                <div id="semantic-search-term-list" class="semantic-search-term-list hidden">${expandedTags}</div>
            </div>`;
    },

    bindGeneratedSearches(container, searchTerms) {
        const searchTermsToggle = container.querySelector('.semantic-search-terms-toggle');
        const searchTermsList = container.querySelector('.semantic-search-term-list');
        searchTermsToggle?.addEventListener('click', () => {
            const willExpand = searchTermsList?.classList.contains('hidden');
            searchTermsList?.classList.toggle('hidden', !willExpand);
            searchTermsToggle.setAttribute('aria-expanded', String(willExpand));
        });
        container.querySelectorAll('[data-regular-search-index]').forEach(button => {
            button.addEventListener('click', () => {
                const search = searchTerms[Number(button.dataset.regularSearchIndex)];
                const term = typeof search === 'string' ? search : search?.term;
                if (term) this.openRegularSearch(term);
            });
        });
    },

    renderResults(results, count, prereqData, eligibleOnly, searchTerms) {
        const container = document.getElementById('search-results');
        this.setBrowseState('results');
        const fallbackNotice = this._semanticFallbackNotice;
        this._semanticFallbackNotice = '';

        if (results.length === 0) {
            State.courseGroups = [];
            container.innerHTML = `${fallbackNotice ? `<p class="search-fallback-notice">${this.escapeText(fallbackNotice)}</p>` : ''}<p class="hint">No results found.</p>${this.generatedSearchesMarkup(searchTerms)}`;
            this.bindGeneratedSearches(container, searchTerms || []);
            return;
        }

        // Group by course code, preserving relevance order
        const groups = {};
        const groupOrder = [];
        results.forEach(r => {
            const code = r.code;
            if (!groups[code]) {
                groups[code] = { code, title: r.title, sections: [], _relevanceScore: r._relevanceScore || 0 };
                groupOrder.push(code);
            }
            groups[code].sections.push(r);
            // Keep the highest relevance score for the group
            if ((r._relevanceScore || 0) > groups[code]._relevanceScore) {
                groups[code]._relevanceScore = r._relevanceScore;
            }
        });

        let groupList = groupOrder.map(code => groups[code]);

        // If semantic search, sort groups by relevance score
        if (searchTerms) {
            groupList.sort((a, b) => b._relevanceScore - a._relevanceScore);
        }

        // Filter by eligibility if requested
        if (eligibleOnly) {
            groupList = groupList.filter(g => {
                const elig = this.checkEligibility(g.code, prereqData);
                return elig.eligible;
            });
        }

        State.courseGroups = groupList;

        // Header with compact search information
        const courseLabel = groupList.length === 1 ? 'course' : 'courses';
        const sectionLabel = count === 1 ? 'section' : 'sections';
        let header = `<div class="browse-results-summary"><strong>${groupList.length} ${courseLabel}</strong><span>${count} total ${sectionLabel}</span></div>`;
        if (this._relatedSearchOrigin) {
            const origin = this.escapeText(this._relatedSearchOrigin);
            header = `<button type="button" class="related-search-back" aria-label="Back to search for ${origin}"><span class="related-search-back-icon" aria-hidden="true">&larr;</span><span class="related-search-back-copy"><small>Back to search</small><strong>${origin}</strong></span></button>${header}`;
        }
        if (fallbackNotice) {
            header += `<p class="search-fallback-notice">${this.escapeText(fallbackNotice)}</p>`;
        }
        header += this.generatedSearchesMarkup(searchTerms);
        container.innerHTML = header;
        this.bindGeneratedSearches(container, searchTerms || []);
        container.querySelector('.related-search-back')?.addEventListener('click', () => this.returnToMainSearch());

        groupList.forEach(group => {
            const div = document.createElement('div');
            div.className = 'course-group';
            div.dataset.courseCode = group.code;
            div.tabIndex = 0;
            div.setAttribute('role', 'button');
            div.setAttribute('aria-label', `View details for ${group.code} ${group.title || ''}`);
            const availability = this.courseAvailability(group);
            const liveSections = group.sections.filter(section => !section._isCatalog);
            const instructors = new Set(liveSections
                .map(section => section.instr)
                .filter(name => name && name !== 'Staff'));
            const sectionLabel = `${liveSections.length} ${liveSections.length === 1 ? 'section' : 'sections'}`;
            const instructorLabel = instructors.size
                ? `${instructors.size} ${instructors.size === 1 ? 'instructor' : 'instructors'}`
                : 'Instructor TBA';

            // Eligibility badge
            const elig = this.checkEligibility(group.code, prereqData);
            let eligBadge = '';
            if (State.completedCourses.length > 0 && !elig.noData) {
                if (elig.eligible) {
                    eligBadge = '<span class="badge badge-eligible" style="margin-left:4px">CAN TAKE</span>';
                } else {
                    eligBadge = `<span class="badge badge-prereq-missing" style="margin-left:4px" title="Missing: ${elig.missing.join(', ')}">PREREQS NEEDED</span>`;
                }
            }

            div.innerHTML = `
                <div class="course-header">
                    <div class="course-header-main"><span class="code">${group.code}</span><span class="title">${group.title}</span>${eligBadge}</div>
                    <div class="course-availability ${availability.kind}">${availability.text}</div>
                    <div class="course-result-meta">${sectionLabel} · ${instructorLabel}</div>
                </div>
                <div class="course-result-summary"><p class="course-result-description loading">Loading course summary</p></div>
            `;

            const summary = div.querySelector('.course-result-summary');
            div.classList.toggle('course-added', State.isCourseSelected(group.code));

            const openDetail = () => {
                this._lastDetailTrigger = div;
                this.showCourseDetail(group);
            };
            div.addEventListener('click', openDetail);
            div.addEventListener('keydown', event => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                openDetail();
            });

            container.appendChild(div);
            this.observeCourseResultSummary(summary, group);
        });
    },

    showSectionDetail(sec) {
        const group = (State.courseGroups || []).find(item => item.code === sec.code) || {
            code: sec.code,
            title: sec.title,
            sections: [sec],
        };
        if (this._detailGroup?.code !== sec.code) this.showCourseDetail(group);
        this.selectDetailSection(sec.crn);
        document.getElementById('course-section-picker-wrap')?.scrollIntoView({ block: 'start' });
    },

    parseMeetingHtml(meetingHtml) {
        // Parse meeting_html to extract separate times and locations
        // Format: <div class="meet">MW 10:50am-11:40am<span ...> in <a ...>Sumwalt College 305</a></span></div>
        if (!meetingHtml) return { times: [], locations: [] };

        const times = [];
        const locationSet = new Set();

        // Match each <div class="meet"> block
        const meetBlocks = meetingHtml.match(/<div class="meet">[^]*?<\/div>/gi) || [meetingHtml];

        meetBlocks.forEach(block => {
            // Extract time: text before the <span
            const timeMatch = block.match(/<div class="meet">\s*([^<]+)/i);
            if (timeMatch) {
                times.push(timeMatch[1].trim());
            }

            // Extract location from <a> tag
            const locMatch = block.match(/<a[^>]*>([^<]+)<\/a>/i);
            if (locMatch) {
                locationSet.add(this.abbreviateBuilding(locMatch[1].trim()));
            }
        });

        return {
            times: times,
            locations: [...locationSet],
        };
    },

    abbreviateBuilding(fullName) {
        // Official UofSC registrar building codes
        // Source: sc.edu/about/offices_and_divisions/registrar/toolbox/scheduling/classroom_capacities/
        // Keys match the actual strings returned by the classes.sc.edu API
        const abbrevs = {
            'Swearingen Engr Ctr': 'SWGN',
            'Swearingen': 'SWGN',
            'Sumwalt College': 'SMWALT',
            'Close-Hipp Building': 'CLHIPP',
            'Close-Hipp': 'CLHIPP',
            'Gambrell': 'GAMBRL',
            'Hamilton College': 'HAMLTN',
            'Humanities Classroom': 'HUMCB',
            'Jones Physical Sci Ctr': 'JONES',
            'Jones Physical Sci': 'JONES',
            'Leconte College': 'LCONTE',
            'LeConte College': 'LCONTE',
            'Coker Life Science': 'COKER',
            'Coker Life Sciences': 'COKER',
            'Callcot Soc Sci Ctr': 'CLLCTT',
            'Callcott': 'CLLCTT',
            'Byrnes': 'BYRNES',
            'Currell College': 'CRRELL',
            'Wardlaw College': 'WRDLAW',
            'Wardlaw Coll': 'WRDLAW',
            'Petigru College': 'PETIGR',
            'Sloan College': 'SLOAN',
            'McMaster College': 'MCMSTR',
            'Carolina Coliseum': 'COL',
            'Blatt PE Center': 'BLATT',
            'Darla Moore Sch of Bus': 'DMSB',
            'Darla Moore': 'DMSB',
            'Moore School of Bus': 'DMSB',
            'Davis College': 'DAVIS',
            'Flinn Hall': 'FLINN',
            'Flinn': 'FLINN',
            'Columbia Hall': 'COLH',
            'Science and Technology Bldg': '1112GR',
            'Science and Technology': '1112GR',
            'WMBB Nursing': 'WMBB',
            'Nursing Building': 'WMBB',
            'Horizon': 'HZNPG',
            'Public Health Research': 'PHRC',
            'Public Hlth Res': 'PHRC',
            'Booker T Washington': 'BTWASH',
            'Booker T. Washington': 'BTWASH',
            '300 Main': '300MN',
            'Band Dance': 'BANDDF',
            'ROTC': 'ROTC',
            'Sch of Jour': 'SJMC',
        };

        // Try to match known building names (API returns "Building Room")
        for (const [apiName, code] of Object.entries(abbrevs)) {
            if (fullName.startsWith(apiName)) {
                const room = fullName.slice(apiName.length).trim();
                return room ? `${code} ${room} (${apiName})` : `${code} (${apiName})`;
            }
        }

        // Fallback: just return what the API gave us (already fairly short)
        return fullName;
    },

    shortTermLabel(termCode) {
        const year = termCode.slice(2, 4);
        const sem = termCode.slice(4);
        const semLabel = { '01': 'Sp', '05': 'Su', '08': 'Fa' }[sem] || sem;
        return `${semLabel}${year}`;
    },

    showSearchProgress({ phase, completed = 0, total = 0, candidates = 0 }) {
        if (typeof document === 'undefined') return;
        const container = document.getElementById('search-results');
        if (!container) return;
        const safeTotal = Math.max(total, completed, 1);
        let title = `${completed} of up to ${total} searches complete`;
        let detail = candidates
            ? `${candidates.toLocaleString()} candidate ${candidates === 1 ? 'course' : 'courses'} found`
            : 'Finding relevant course matches';
        if (phase === 'planned') {
            title = `Preparing up to ${total} generated searches`;
            detail = 'Building search variations';
        } else if (phase === 'combining') {
            title = `${completed} searches complete`;
            detail = `Combining ${candidates.toLocaleString()} candidate courses`;
        } else if (phase === 'filtering') {
            title = `${completed} searches complete`;
            detail = `Applying filters to ${candidates.toLocaleString()} candidate courses`;
        }
        container.innerHTML = `
            <div class="search-progress" role="status" aria-live="polite">
                <div><strong>${title}</strong><span>${detail}</span></div>
                <progress value="${Math.min(completed, safeTotal)}" max="${safeTotal}">${completed} of ${safeTotal}</progress>
            </div>`;
    },

    showLoading(label = 'Searching courses') {
        document.getElementById('search-results').innerHTML = `<p class="loading">${label}</p>`;
    },

    clearSearchErrors() {
        ['search-input-error', 'filter-scope-error'].forEach(id => {
            const element = document.getElementById(id);
            if (!element) return;
            element.textContent = '';
            element.classList.add('hidden');
        });
        ['filter-scope-subjects', 'filter-scope-numbers'].forEach(id => {
            document.getElementById(id)?.removeAttribute('aria-invalid');
        });
        document.getElementById('keyword-input')?.removeAttribute('aria-invalid');
    },

    showSearchError(message, { scope = false } = {}) {
        const topError = document.getElementById('search-input-error');
        if (topError) {
            topError.textContent = message;
            topError.classList.remove('hidden');
        }
        if (!scope) document.getElementById('keyword-input')?.setAttribute('aria-invalid', 'true');
        if (!scope) return;
        const scopeError = document.getElementById('filter-scope-error');
        if (scopeError) {
            scopeError.textContent = message;
            scopeError.classList.remove('hidden');
        }
        const numberError = /course number|first course/i.test(message);
        const target = document.getElementById(
            numberError ? 'filter-scope-numbers' : 'filter-scope-subjects',
        );
        target?.setAttribute('aria-invalid', 'true');
        requestAnimationFrame(() => target?.focus());
    },

    showHint(msg) {
        this.setBrowseState('results');
        document.getElementById('search-results').innerHTML = `<p class="hint">${msg}</p>`;
    },
};

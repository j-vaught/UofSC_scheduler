/* Course search UI */
const Search = {
    _prereqCache: {},
    _searchId: 0,
    _subjects: [],
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
    _semanticFallbackOnce: false,
    _semanticFallbackNotice: '',
    _mainSearchQuery: '',
    _relatedSearchOrigin: '',
    _restoringHistory: false,

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
    async _doSemanticSearch(query, currentTermOnly, openOnly, searchId) {
        // Load model + phrase data concurrently
        await Promise.all([this._loadExtractor(), this._loadPhraseData()]);
        if (searchId !== this._searchId) return null;

        // Step 1: Embed query
        const queryVec = await this._embedQuery(query);
        if (searchId !== this._searchId) return null;

        // Step 2: Find nearest academic phrases
        const nearestPhrases = this._findNearestPhrases(queryVec, 8, query);
        const expandedTerms = nearestPhrases.map(n => n.phrase);
        if (searchId !== this._searchId) return null;

        // Step 3: Build search list — original query + expanded phrases
        const searches = [query, ...expandedTerms];
        console.log(`[Semantic] "${query}" → ${searches.length} API calls:`, searches);

        // Step 4: Fire all searches concurrently
        const promises = searches.map(async term => {
            let results = [];
            try {
                if (currentTermOnly) {
                    const criteria = [{ field: 'keyword', value: term }];
                    if (openOnly) criteria.push({ field: 'stat', value: 'A' });
                    const data = await API.searchCourses(State.term, criteria);
                    results = data.results || [];
                } else {
                    const data = await API.post('/api/bulletin/search', {
                    other: { srcdb: '2026' },
                    criteria: [{ field: 'keyword', value: term }],
                    });
                    results = data.results || [];
                }
            } catch (error) {
                console.warn(`[Semantic] Search failed for “${term}”:`, error);
            }
            return results;
        });
        const allResults = await Promise.all(promises);
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
            if (dot >= LOCAL_SIM_THRESHOLD) {
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

        // Step 7: Score each result title by embedding similarity to query
        // Batch-embed all titles at once for performance
        const extractor = await this._loadExtractor();
        const titles = deduped.map(r => r.title || r.name || '').filter(Boolean);
        const titleOutputs = await extractor(titles, { pooling: 'mean', normalize: true });

        const mean = this._pcaParams.mean;
        const components = this._pcaParams.components;
        const dims = this._pcaParams.dims;
        const embDim = mean.length; // 384

        const SIM_THRESHOLD = 0.15;
        const scored = [];
        for (let i = 0; i < deduped.length; i++) {
            const title = deduped[i].title || deduped[i].name || '';
            if (!title) continue;
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
                scored.push({ ...deduped[i], _relevanceScore: sim });
            }
        }

        // Sort by similarity, take top 50
        scored.sort((a, b) => b._relevanceScore - a._relevanceScore);
        const top = scored.slice(0, 50);

        console.log(`[Semantic] ${deduped.length} candidates → ${scored.length} above threshold → top ${top.length}`);
        const searchMetrics = searches.map((term, index) => ({
            term,
            count: new Set(allResults[index].map(result => result.code).filter(Boolean)).size,
        }));
        return {
            results: top,
            expandedTerms,
            searches: searchMetrics,
            searchResults: allResults,
            searchCodes: allResults.map(batch => [...new Set(batch.map(result => result.code).filter(Boolean))]),
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

    async searchLiveCourses(rawInput) {
        const query = String(rawInput || '').trim();
        if (!query) throw new Error('Enter a subject code, course number, CRN, range, or keyword.');

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
            const searchId = ++this._searchId;
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
        fetch('/api/subjects').then(r => r.json()).then(list => { this._subjects = list; });

        document.getElementById('btn-search').addEventListener('click', () => this.submitSearch());
        document.getElementById('keyword-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.submitSearch();
        });

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
        if (filterToggle && filterPanel) {
            filterToggle.addEventListener('click', event => {
                event.stopPropagation();
                const shouldOpen = filterPanel.classList.contains('hidden');
                if (shouldOpen) {
                    filterPanel.classList.remove('hidden');
                    filterBackdrop?.classList.remove('hidden');
                    document.body?.classList.add('filter-modal-open');
                    filterArrow?.classList.add('open');
                    filterToggle.setAttribute('aria-expanded', 'true');
                    document.getElementById('btn-close-filters')?.focus();
                } else {
                    this.closeFilters();
                }
            });
            filterPanel.addEventListener('click', event => event.stopPropagation());
            document.addEventListener('click', () => this.closeFilters());
            document.addEventListener('keydown', event => {
                if (event.key === 'Escape' && !filterPanel.classList.contains('hidden')) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    this.closeFilters();
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

        document.addEventListener('search-tab-reset-requested', () => {
            this.resetToCleanSearch({ historyMode: 'push' });
        });
        window.addEventListener('popstate', () => this.restoreFromLocation());

        const additionalToggle = document.getElementById('additional-filter-toggle');
        const additionalPanel = document.getElementById('additional-filter-panel');
        const additionalArrow = document.getElementById('additional-filter-arrow');
        if (additionalToggle && additionalPanel) {
            additionalToggle.addEventListener('click', () => {
                additionalPanel.classList.toggle('hidden');
                additionalArrow.classList.toggle('open');
            });
        }

        document.getElementById('btn-apply-filters')?.addEventListener('click', () => {
            this.updateActiveFilterChips();
            this.closeFilters();
            if (this.activeSearchInput()?.value.trim()) this.doSearch();
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

    setBrowseState(state) {
        const workspace = document.getElementById('browse-workspace');
        if (!workspace) return;
        this._browseState = state;
        workspace.classList.remove('browse-empty', 'browse-results', 'browse-detail');
        workspace.classList.add(`browse-${state}`);
    },

    submitSearch() {
        this._mainSearchQuery = '';
        this._relatedSearchOrigin = '';
        return this.doSearch();
    },

    resetToCleanSearch({ historyMode = 'push' } = {}) {
        this._searchId += 1;
        this._detailToken = (this._detailToken || 0) + 1;
        this._mainSearchQuery = '';
        this._relatedSearchOrigin = '';
        this._directSearchOnce = false;
        const input = this.activeSearchInput();
        if (input) input.value = '';
        document.getElementById('search-results').innerHTML = '<p class="hint">Search a subject above to see available courses.</p>';
        this.setBrowseState('empty');
        if (historyMode !== 'none') this.writeSearchHistory('', { mode: historyMode });
        requestAnimationFrame(() => input?.focus());
    },

    searchUrl({ query = '', direct = false, origin = '' } = {}) {
        const url = new URL(window.location.href);
        url.search = '';
        url.hash = '';
        url.searchParams.set('tab', 'search');
        url.searchParams.set('term', State.term);
        if (query) url.searchParams.set('q', query);
        if (direct) url.searchParams.set('direct', '1');
        if (origin) url.searchParams.set('from', origin);

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
        return url;
    },

    writeSearchHistory(query, { mode = 'push', direct = false, origin = '' } = {}) {
        if (this._restoringHistory || mode === 'none') return;
        const url = this.searchUrl({ query, direct, origin });
        const next = `${url.pathname}${url.search}`;
        const current = `${window.location.pathname}${window.location.search}`;
        const state = { search: true, relatedSearch: Boolean(origin), query, origin };
        if (mode === 'replace' || next === current) history.replaceState(state, '', next);
        else history.pushState(state, '', next);
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
        const aiToggle = document.getElementById('filter-ai-search');
        if (aiToggle) aiToggle.checked = !(params.get('direct') === '1' && !params.get('from'));
        this.updateActiveFilterChips();
    },

    async restoreFromLocation({ initial = false } = {}) {
        const params = new URL(window.location.href).searchParams;
        if (params.get('tab') !== 'search' && !params.has('q')) return;
        const query = params.get('q') || '';
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
        this._directSearchOnce = params.get('direct') === '1';
        const input = this.activeSearchInput();
        if (input) input.value = query;
        if (typeof Tabs !== 'undefined') Tabs.switchTo('semester');
        if (!query) {
            this.resetToCleanSearch({ historyMode: 'none' });
            this._restoringHistory = false;
            return;
        }
        try {
            await this.doSearch({ historyMode: 'none' });
        } finally {
            this._restoringHistory = false;
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
        regularInput.focus();
        this.doSearch();
    },

    returnToMainSearch() {
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
        if (wasOpen) requestAnimationFrame(() => toggle?.focus());
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
        document.getElementById('filter-toggle')?.classList.toggle('has-active-filters', entries.length > 0);
        container.innerHTML = '';
        entries.forEach(entry => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'active-filter-chip';
            button.innerHTML = `${entry.label}<span aria-hidden="true">&times;</span>`;
            button.setAttribute('aria-label', `Remove filter ${entry.label}`);
            button.addEventListener('click', () => {
                entry.ids.forEach(id => {
                    const element = document.getElementById(id);
                    if (!element) return;
                    if (element.type === 'checkbox') element.checked = Boolean(entry.restore);
                    else element.value = '';
                });
                this.updateActiveFilterChips();
                if (this.activeSearchInput()?.value.trim()) this.doSearch();
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
        this.updateActiveFilterChips();
        this.closeFilters();
        if (this.activeSearchInput()?.value.trim()) this.doSearch();
    },

    async doSearch({ historyMode = 'push' } = {}) {
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
        const aiAssisted = document.getElementById('filter-ai-search')?.checked !== false;
        const useDirectSearch = !aiAssisted || this._directSearchOnce || this._semanticFallbackOnce;
        this._directSearchOnce = false;

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

        if (!rawInput) {
            this.showHint('Enter a subject code (CSCE), course number (CSCE 145), range (CSCE 140–199), or keyword.');
            return;
        }

        this.writeSearchHistory(rawInput, {
            mode: historyMode,
            direct: !aiAssisted || Boolean(this._relatedSearchOrigin),
            origin: this._relatedSearchOrigin,
        });

        this.setBrowseState('results');
        this.updateActiveFilterChips();
        this.closeFilters();

        const kw = rawInput.trim();
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

        // 3-4 letter subject code only (e.g. "CSCE", "MATH")
        if (/^[A-Za-z]{3,4}$/i.test(kw)) {
            subject = this._resolveSubject(kw);
            if (!subject) return;
            searchInput.value = subject;
            criteria.push({ field: 'subject', value: subject });

        // Inclusive numeric range: "CSCE 140-150", "CSCE 140–150", or "CSCE 140 to 150"
        } else if (/^[A-Za-z]{3,4}\s*\d{3}\s*(?:-|–|—|to)\s*\d{3}$/i.test(kw)) {
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
        } else if (/^[A-Za-z]{3,4}\s*[\dxX*#_?%]{1,3}\+?[A-Za-z]?$/i.test(kw) &&
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
        } else if (/^[A-Za-z]{3,4}\s*\d{1,2}$/i.test(kw)) {
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
        } else if (/^[A-Za-z]{3,4}\s*\d{3}[A-Za-z]?$/i.test(kw)) {
            const m = kw.match(/^([A-Za-z]{3,4})\s*(\d{3}[A-Za-z]?)$/i);
            subject = this._resolveSubject(m[1]);
            if (!subject) return;
            const num = m[2].toUpperCase();
            const normalized = subject + ' ' + num;
            searchInput.value = normalized;
            criteria.push({ field: 'alias', value: normalized });

        // 5-digit CRN
        } else if (/^\d{5}$/.test(kw)) {
            criteria.push({ field: 'crn', value: kw });

        // 4 digits — invalid
        } else if (/^\d{4}$/.test(kw)) {
            this.showHint('4-digit numbers are not valid. Enter a 3-digit course number (e.g. CSCE 101) or a 5-digit CRN.');
            return;

        // 3 digits + optional letter — need subject prefix
        } else if (/^\d{3}\s?[A-Za-z]?$/.test(kw)) {
            this.showHint('Include the subject code (e.g. CSCE 101, not just 101).');
            return;

        // 1-2 digits
        } else if (/^\d{1,2}$/.test(kw)) {
            this.showHint('Enter a subject code (e.g. CSCE) or full course number (e.g. CSCE 101).');
            return;

        // Text keyword — require 5+ characters
        } else if (kw.length < 5) {
            this.showHint('Keywords must be at least 5 characters. For courses, enter a subject code (e.g. CSCE) or course number (e.g. CSCE 145).');
            return;

        // Direct keyword search when meaning-based matching is disabled or bypassed once
        } else if (useDirectSearch) {
            criteria.push({ field: 'keyword', value: kw });

        // Meaning-based search via Transformers.js
        } else {
            this.showLoading();
            const searchId = ++this._searchId;
            try {
                await this.prepareSmartSearch();
                if (searchId !== this._searchId) return;
                const semantic = await this._doSemanticSearch(kw, currentTermOnly, openOnly, searchId);
                if (!semantic || searchId !== this._searchId) return;

                if (semantic.results.length === 0) {
                    this.showHint(`No matching courses found for "${kw}".`);
                    return;
                }

                let results = semantic.results;

                // Cross-reference ALL results with live term data
                const relatedResults = currentTermOnly ? [] : (semantic.searchResults || []).flat();
                const subjects = [...new Set([...results, ...relatedResults]
                    .map(r => (r.code || '').split(' ')[0]).filter(Boolean))];
                const livePromises = subjects.map(s =>
                    API.searchCourses(State.term, [{ field: 'subject', value: s }])
                        .then(d => d.results || []).catch(() => [])
                );
                const liveAll = await Promise.all(livePromises);
                if (searchId !== this._searchId) return;
                const liveByCode = this.buildLiveCourseIndex(liveAll.flat());

                if (currentTermOnly) {
                    // Only show courses offered this term
                    results = results.filter(c => liveByCode[c.code]);
                }

                results = this.mergeCatalogWithLiveSections(results, liveByCode);
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

                if (searchId !== this._searchId) return;
                const eligibleOnly2 = eligibleOnly;
                const relatedBatches = await Promise.all((semantic.searchResults || []).map(batch => {
                    const candidates = currentTermOnly
                        ? batch
                        : this.mergeCatalogWithLiveSections(batch, liveByCode);
                    return this.applySectionFilters(candidates, semanticFilters);
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
                this._mainSearchQuery = kw;
                this._relatedSearchOrigin = '';
                this.renderResults(results, results.length, prereqData, eligibleOnly2, searchInfo);
            } catch (err) {
                if (searchId !== this._searchId) return;
                if (this.activeSearchInput()?.value.trim() !== kw) return;
                console.error('[Semantic] Error:', err);
                this._extractorLoading = null;
                this._smartModelPromise = null;
                this.setSmartModelLoading(false);
                this._semanticFallbackNotice = 'Meaning-based matching is unavailable. Showing direct matches.';
                this._semanticFallbackOnce = true;
                await this.doSearch();
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

            if (currentTermOnly) {
                // Search live class offerings for the selected term
                const data = await API.searchCourses(State.term, criteria);
                results = data.results || [];
                totalCount = data.count || 0;
            } else {
                // Search the bulletin catalog (all courses, not term-specific)
                const bulletinData = subject
                    ? await API.bulletinSearch(subject)
                    : await API.post('/api/bulletin/search', {
                        other: { srcdb: '2026' },
                        criteria,
                    });
                const bulletinCourses = bulletinData.results || [];

                // Also fetch live term data to cross-reference availability
                const subjects = subject
                    ? [subject]
                    : [...new Set(bulletinCourses
                        .map(course => String(course.code || '').split(' ')[0])
                        .filter(Boolean))];
                const liveResults = (await Promise.all(subjects.map(code => API.searchCourses(
                    State.term,
                    [{ field: 'subject', value: code }],
                ).then(data => data.results || []).catch(() => [])))).flat();

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

            // If a newer search was started, discard these results
            if (searchId !== this._searchId) return;

            const prereqData = eligibleOnly
                ? await this.loadPrereqsForResults(results)
                : (this._prereqCache[subject] || {});

            this.renderResults(results, totalCount || results.length, prereqData, eligibleOnly);
        } catch (err) {
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
                .catch(() => []);
        }
        this._bulletinDetailsCache[courseCode] = this._bulletinCourseCache[subject]
            .then(courses => {
                const target = courses.find(course => course.code === courseCode);
                return target ? API.bulletinDetails(target.key) : {};
            })
            .catch(() => ({}));
        return this._bulletinDetailsCache[courseCode];
    },

    async fetchSectionFilterDetails(section) {
        if (!section.crn) return null;
        const key = `${State.term}:${section.crn}`;
        if (!this._sectionDetailCache[key]) {
            this._sectionDetailCache[key] = API.getDetails(section.crn, State.term)
                .catch(() => null);
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
            const result = {
                prereqs: [...new Set(codes)],
                raw: prereqHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
            };
            this._prereqCache[subject][courseCode] = result;
            return result;
        } catch (e) {
            return { prereqs: [], raw: '' };
        }
    },

    checkEligibility(courseCode, prereqData) {
        const info = prereqData[courseCode];
        if (!info || info.prereqs.length === 0) return { eligible: true, missing: [], noData: !info };
        const completed = new Set(State.completedCourses);
        const missing = info.prereqs.filter(p => !completed.has(p));
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
            try {
                const details = await this.fetchSectionFilterDetails(result);
                if (!details) return null;
                const match = (details.seats || '').match(/seats_avail[^>]*>(\d+)/);
                if (!match) return null;
                return { result, available: Number(match[1]) };
            } catch (error) {
                return null;
            }
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

    closeCourseDetail() {
        this._detailToken = (this._detailToken || 0) + 1;
        this.setBrowseState('results');
        document.querySelectorAll('#search-results .course-group').forEach(card => {
            card.classList.remove('active');
            card.removeAttribute('aria-current');
        });
        const trigger = this._lastDetailTrigger;
        requestAnimationFrame(() => {
            if (trigger?.isConnected) trigger.focus();
            else document.getElementById('keyword-input')?.focus();
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

    setCourseDetailTab(tab, focus = false) {
        const allowed = new Set(['overview', 'sections', 'grades', 'history', 'resources']);
        const active = allowed.has(tab) ? tab : 'overview';
        this._detailTab = active;
        document.querySelectorAll('[data-course-tab]').forEach(button => {
            const selected = button.dataset.courseTab === active;
            button.setAttribute('aria-selected', String(selected));
            button.tabIndex = selected ? 0 : -1;
            if (selected && focus) button.focus();
        });
        document.querySelectorAll('[data-course-panel]').forEach(panel => {
            panel.hidden = panel.dataset.coursePanel !== active;
        });
        this.loadCourseDetailTab(active);
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
            this.renderCourseDetailHeader(this._detailDetails);
            this.renderDetailSections();
            this.selectDetailSection(this._detailSectionCrn, false);
        } catch (error) {
            // The filtered result sections remain usable if full-course hydration fails.
        }
    },

    showCourseDetail(group) {
        const detailsTab = document.getElementById('tab-details');
        if (!detailsTab || !group) return;
        this._detailToken = (this._detailToken || 0) + 1;
        const token = this._detailToken;
        this._detailTerm = State.term;
        this._detailGroup = group;
        this._detailDetails = null;
        this._detailFaculty = [];
        this._detailSectionData = {};
        this._detailLoads = {};
        this._detailSectionCrn = String(this.preferredDetailSection(group)?.crn || '');
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
        this.selectDetailSection(this._detailSectionCrn, false);
        this.setCourseDetailTab('overview');
        if (typeof Prereqs !== 'undefined') Prereqs.loadForCourse(group.code);
        this.hydrateFullDetailGroup(group, token, this._detailTerm);
        this.fetchBulletinDetailsForCourse(group.code).then(details => {
            if (token !== this._detailToken) return;
            this._detailDetails = details || {};
            this.renderCourseDetailHeader(this._detailDetails);
            this.renderCourseOverview();
            this.renderCourseResources();
        }).catch(() => {
            if (token === this._detailToken) this.renderCourseDetailHeader({});
        });
    },

    renderCourseDetailHeader(details) {
        const header = document.getElementById('tab-details');
        const group = this._detailGroup;
        if (!header || !group) return;
        const availability = this.courseAvailability(group);
        const selected = State.isCourseSelected(group.code);
        const unavailable = availability.kind === 'unavailable' && !selected;
        const credits = typeof Scheduler !== 'undefined'
            ? Scheduler.parseCreditHours(details?.hours_html || group.credits || this.detailLiveSections(group)[0]?.hours)
            : null;
        const description = this.stripHtml(details?.description);
        header.innerHTML = `
            <div class="course-detail-kicker">Course details</div>
            <div class="course-detail-title-row">
                <div>
                    <h1><span>${this.escapeText(group.code)}</span>${this.escapeText(details?.title || group.title || '')}</h1>
                    <p class="course-detail-availability ${availability.kind}">${availability.text}</p>
                </div>
                <div class="course-detail-credit"><strong>${credits ?? '—'}</strong><span>${credits === 1 ? 'credit' : 'credits'}</span></div>
            </div>
            ${description ? `<p class="course-detail-description">${this.escapeText(description)}</p>` : '<p class="course-detail-description loading">Loading course description</p>'}
            <div class="course-detail-primary-actions">
                <button id="btn-course-toggle" type="button" class="${selected ? 'btn-danger' : unavailable ? 'btn-course-unavailable' : 'btn-green'}"${unavailable ? ' disabled' : ''}>${selected ? 'REMOVE COURSE' : unavailable ? 'NOT OFFERED THIS TERM' : 'ADD COURSE'}</button>
            </div>
        `;
        header.querySelector('#btn-course-toggle')?.addEventListener('click', async () => {
            if (State.isCourseSelected(group.code)) State.removeCourse(group.code);
            else await Scheduler.addCourseGroup(this._detailGroup);
            this.updateCourseSelectionStyles(group.code);
            this.renderCourseDetailHeader(this._detailDetails || {});
            const cached = this._detailSectionData?.[this._detailSectionCrn];
            this.renderSectionSummary(this.currentDetailSection(), cached?.details, cached?.faculty || []);
        });
    },

    renderCourseOverview() {
        const container = document.getElementById('course-overview-content');
        if (!container || !this._detailGroup) return;
        const details = this._detailDetails || {};
        const attributes = [details.attributes, details.carolina_core, details.course_attributes]
            .map(value => this.stripHtml(value)).filter(Boolean);
        container.innerHTML = attributes.length ? `
            <section class="course-detail-card">
                <div class="course-detail-card-heading"><h2>Course attributes</h2></div>
                <p>${this.escapeText(attributes.join(' · '))}</p>
            </section>
        ` : '';
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
        const panel = document.getElementById('course-sections-panel');
        if (!wrap || !picker || !panel) return;
        wrap.hidden = sections.length === 0;
        if (count) count.textContent = `${sections.length} this term`;
        if (!sections.length) {
            panel.innerHTML = '<div class="course-detail-empty-state"><strong>Not offered this term</strong><p>This course remains available in catalog search and offering history.</p></div>';
            return;
        }
        picker.innerHTML = sections.map(section => `
            <button type="button" class="course-section-option ${section.stat === 'A' ? 'open' : 'full'}" data-detail-crn="${this.escapeText(section.crn)}" aria-pressed="${String(section.crn) === this._detailSectionCrn}">
                <span><i aria-hidden="true"></i>Section ${this.escapeText(section.section || '—')}</span>
                <small>${this.escapeText(section.meets || 'Time TBA')}</small>
            </button>
        `).join('');
        panel.innerHTML = `
            <div class="course-sections-comparison">
                ${sections.map(section => `
                    <button type="button" class="course-section-card ${section.stat === 'A' ? 'open' : 'full'}" data-detail-crn="${this.escapeText(section.crn)}" aria-pressed="${String(section.crn) === this._detailSectionCrn}">
                        <span class="course-section-card-title"><strong>Section ${this.escapeText(section.section || '—')}</strong><em>${section.stat === 'A' ? 'Open' : 'Full'}</em></span>
                        <span>${this.escapeText(section.instr && section.instr !== 'Staff' ? section.instr : 'Instructor TBA')}</span>
                        <span>${this.escapeText(section.meets || 'Time TBA')}</span>
                        <small>CRN ${this.escapeText(section.crn)}</small>
                    </button>
                `).join('')}
            </div>
        `;
        picker.querySelectorAll('[data-detail-crn]').forEach(button => {
            button.addEventListener('click', () => this.selectDetailSection(button.dataset.detailCrn));
        });
        panel.querySelectorAll('[data-detail-crn]').forEach(button => {
            button.addEventListener('click', () => this.selectDetailSection(button.dataset.detailCrn, false));
        });
    },

    selectDetailSection(crn, focusPicker = true) {
        const section = this.detailLiveSections().find(item => String(item.crn) === String(crn))
            || this.preferredDetailSection(this._detailGroup);
        this._detailSectionCrn = String(section?.crn || '');
        this._detailFaculty = [];
        document.querySelectorAll('[data-detail-crn]').forEach(button => {
            const selected = String(button.dataset.detailCrn) === this._detailSectionCrn;
            button.setAttribute('aria-pressed', String(selected));
            button.classList.toggle('selected', selected);
        });
        this.renderSectionSummary(section);
        this.renderCourseResources();
        this.refreshDetailGrades();
        if (focusPicker) document.querySelector(`#course-section-picker [data-detail-crn="${this._detailSectionCrn}"]`)?.focus();
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

    renderSectionSummary(section, details = null, faculty = []) {
        const container = document.getElementById('course-section-summary');
        const group = this._detailGroup;
        if (!container || !group || !section) {
            if (container) container.innerHTML = '';
            return;
        }
        const meeting = this.parseMeetingHtml(details?.meeting_html || '');
        const times = meeting.times.length ? meeting.times.join('; ') : (section.meets || 'TBA');
        const locations = meeting.locations.length ? meeting.locations.join('; ') : 'TBA';
        const seatsAvailable = String(details?.seats || '').match(/seats_avail[^>]*>(\d+)/)?.[1];
        const seatsMax = String(details?.seats || '').match(/seats_max[^>]*>(\d+)/)?.[1];
        const primaryFaculty = faculty.find(person => person.primary) || faculty[0];
        const instructorName = primaryFaculty?.name
            || (section.instr && section.instr !== 'Staff' ? section.instr : 'Instructor TBA');
        const locked = String(State.sectionLocks?.[group.code] || '') === String(section.crn);
        const courseSelected = State.isCourseSelected(group.code);
        const actionLabel = locked
            ? 'USE ANY OPEN SECTION'
            : courseSelected
                ? 'USE THIS SECTION'
                : 'ADD COURSE AND USE THIS SECTION';
        const fullNotice = section.stat === 'A' ? '' : '<p class="course-section-full-note">Full section. You can still use it for planning.</p>';
        container.innerHTML = `
            <div class="course-section-summary-heading">
                <div><span>Viewing</span><strong>Section ${this.escapeText(section.section || '—')}</strong></div>
                <span class="course-section-status ${section.stat === 'A' ? 'open' : 'full'}">${section.stat === 'A' ? 'Open' : 'Full'}</span>
            </div>
            <div class="course-section-facts">
                <div><span>Instructor</span>${instructorName === 'Instructor TBA'
                    ? `<strong>${instructorName}</strong>`
                    : `<button type="button" id="btn-section-professor">${this.escapeText(instructorName)}</button>${primaryFaculty?.email ? `<a href="mailto:${this.escapeText(primaryFaculty.email)}">${this.escapeText(primaryFaculty.email)}</a>` : ''}`}</div>
                <div><span>Meeting</span><strong>${this.escapeText(times)}</strong></div>
                <div><span>Location</span><strong>${this.escapeText(locations)}</strong></div>
                <div><span>Seats</span><strong>${seatsAvailable !== undefined ? `${seatsAvailable} of ${seatsMax || '—'} available` : (section.stat === 'A' ? 'Available' : 'Full')}</strong></div>
                <div><span>CRN</span><strong>${this.escapeText(section.crn)}</strong></div>
                <div><span>Method</span><strong>${this.escapeText(details?.inst_mthd || section.inst_mthd || 'Not listed')}</strong></div>
            </div>
            ${fullNotice}
            <div class="course-section-actions">
                <button id="btn-use-detail-section" type="button" class="${locked ? 'btn-secondary' : 'btn-garnet'}">${actionLabel}</button>
                <button id="btn-view-schedule" type="button" class="btn-secondary">VIEW SCHEDULE</button>
            </div>
        `;
        container.querySelector('#btn-use-detail-section')?.addEventListener('click', async () => {
            if (!State.isCourseSelected(group.code)) await Scheduler.addCourseGroup(this._detailGroup);
            State.setSectionLock(group.code, locked ? null : section.crn);
            this.updateCourseSelectionStyles(group.code);
            this.renderCourseDetailHeader(this._detailDetails || {});
            this.renderSectionSummary(section, details, faculty);
        });
        container.querySelector('#btn-view-schedule')?.addEventListener('click', () => Tabs.switchTo('schedule'));
        container.querySelector('#btn-section-professor')?.addEventListener('click', () => {
            if (typeof Grades !== 'undefined') Grades.showProfessorForCourseName(group.code, instructorName, primaryFaculty?.email || '');
        });
    },

    renderCourseResources(section = this.currentDetailSection(), faculty = this._detailFaculty || []) {
        const container = document.getElementById('course-resource-links');
        const group = this._detailGroup;
        if (!container || !group) return;
        const primaryFaculty = faculty.find(person => person.primary) || faculty[0];
        const professor = primaryFaculty?.name || (section?.instr && section.instr !== 'Staff' ? section.instr : '');
        const query = encodeURIComponent(`${group.code} ${group.title || ''} University of South Carolina`);
        const professorQuery = encodeURIComponent(`${professor} University of South Carolina`);
        container.innerHTML = `
            <div class="course-resource-intro"><h2>Course resources</h2><p>Official course information and useful searches open in a new tab.</p></div>
            <div class="course-resource-grid">
                <a href="https://academicbulletins.sc.edu/undergraduate/course-descriptions/" target="_blank" rel="noopener noreferrer"><strong>Academic bulletin</strong><span>Official description and requirements</span></a>
                <a href="https://www.uscbookstore.com/" target="_blank" rel="noopener noreferrer"><strong>USC Bookstore</strong><span>Find assigned course materials</span></a>
                <a href="https://www.google.com/search?q=${query}%20syllabus%20site%3Asc.edu" target="_blank" rel="noopener noreferrer"><strong>Find a syllabus</strong><span>Search university pages for this course</span></a>
                <a href="https://www.google.com/search?q=${query}%20course%20reviews" target="_blank" rel="noopener noreferrer"><strong>Course reviews</strong><span>Search independent course feedback</span></a>
                ${professor ? `<a href="https://www.ratemyprofessors.com/search/professors?q=${professorQuery}" target="_blank" rel="noopener noreferrer"><strong>Professor reviews</strong><span>Search for ${this.escapeText(professor)}</span></a>` : ''}
            </div>
        `;
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

    renderResults(results, count, prereqData, eligibleOnly, searchTerms) {
        const container = document.getElementById('search-results');
        this.setBrowseState('results');
        const fallbackNotice = this._semanticFallbackNotice;
        this._semanticFallbackNotice = '';

        if (results.length === 0) {
            container.innerHTML = `${fallbackNotice ? `<p class="search-fallback-notice">${this.escapeText(fallbackNotice)}</p>` : ''}<p class="hint">No results found.</p>`;
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
            header = `<button type="button" class="related-search-back">&larr; Back to ${this.escapeText(this._relatedSearchOrigin)}</button>${header}`;
        }
        if (fallbackNotice) {
            header += `<p class="search-fallback-notice">${this.escapeText(fallbackNotice)}</p>`;
        }
        if (searchTerms && searchTerms.length) {
            const expandedTags = searchTerms.map((search, index) => {
                const term = typeof search === 'string' ? search : search.term;
                const resultCount = typeof search === 'string' ? null : Number(search.count);
                const countLabel = Number.isFinite(resultCount)
                    ? `${resultCount.toLocaleString()} ${resultCount === 1 ? 'course' : 'courses'}`
                    : '';
                const disabled = Number.isFinite(resultCount) && resultCount === 0 ? ' disabled' : '';
                return `<button type="button" class="semantic-search-term" data-regular-search-index="${index}" data-result-count="${resultCount || 0}"${disabled}><span>${this.escapeText(term)}</span>${countLabel ? `<strong>${countLabel}</strong>` : ''}</button>`;
            }).join(' ');
            header += `
                <div class="semantic-search-terms">
                    <button type="button" class="semantic-search-terms-toggle" aria-expanded="false" aria-controls="semantic-search-term-list">
                        <span><b>${searchTerms.length} Related searches</b></span><i aria-hidden="true">&#9660;</i>
                    </button>
                    <div id="semantic-search-term-list" class="semantic-search-term-list hidden">${expandedTags}</div>
                </div>`;
        }
        container.innerHTML = header;
        const searchTermsToggle = container.querySelector('.semantic-search-terms-toggle');
        const searchTermsList = container.querySelector('.semantic-search-term-list');
        searchTermsToggle?.addEventListener('click', () => {
            const willExpand = searchTermsList?.classList.contains('hidden');
            searchTermsList?.classList.toggle('hidden', !willExpand);
            searchTermsToggle.setAttribute('aria-expanded', String(willExpand));
        });
        container.querySelector('.related-search-back')?.addEventListener('click', () => this.returnToMainSearch());
        container.querySelectorAll('[data-regular-search-index]').forEach(button => {
            button.addEventListener('click', () => {
                const search = searchTerms[Number(button.dataset.regularSearchIndex)];
                const term = typeof search === 'string' ? search : search?.term;
                if (term) this.openRegularSearch(term);
            });
        });

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
        this.setCourseDetailTab('sections');
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

    showLoading() {
        document.getElementById('search-results').innerHTML = '<p class="loading">Searching courses</p>';
    },

    showHint(msg) {
        document.getElementById('search-results').innerHTML = `<p class="hint">${msg}</p>`;
    },
};

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
    _placeholderTimer: null,
    _placeholderIndex: 0,
    _browseState: 'empty',

    // Lazy-load Transformers.js embedding model
    async _loadExtractor() {
        if (this._extractor) return this._extractor;
        if (this._extractorLoading) return this._extractorLoading;
        console.log('[Semantic] Loading Transformers.js model (first time only, ~23MB)...');
        this._extractorLoading = import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2')
            .then(({ pipeline }) => pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true }))
            .then(ext => { this._extractor = ext; console.log('[Semantic] Model loaded.'); return ext; });
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
        this.resetSmartSearchTrace();

        // Step 1: Embed query
        const understandingStartedAt = Date.now();
        this.setSmartSearchStatus(`Understanding “${query}”`, 'searching', 'Comparing the search with course language.');
        const queryVec = await this._embedQuery(query);
        await this.waitForSmartSearchPhase(understandingStartedAt, 650);
        if (searchId !== this._searchId) return null;

        // Step 2: Find nearest academic phrases
        const expandingStartedAt = Date.now();
        this.setSmartSearchStatus('Expanding academic concepts', 'searching', 'Finding related subjects and course terminology.');
        const nearestPhrases = this._findNearestPhrases(queryVec, 8, query);
        const expandedTerms = nearestPhrases.map(n => n.phrase);
        await this.waitForSmartSearchPhase(expandingStartedAt, 650);
        if (searchId !== this._searchId) return null;

        // Step 3: Build search list — original query + expanded phrases
        const searches = [query, ...expandedTerms];
        console.log(`[Semantic] "${query}" → ${searches.length} API calls:`, searches);

        // Step 4: Fire all searches concurrently
        this.setSmartSearchStatus('Checking course matches', 'searching', `Searching “${query}” and ${expandedTerms.length} related concepts.`);
        const queryPhaseStartedAt = Date.now();
        this.showSmartSearchQueries(searches);
        const promises = searches.map(async (term, index) => {
            let results = [];
            try {
                if (currentTermOnly) {
                    const data = await API.searchCourses(State.term, [{ field: 'keyword', value: term }]);
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
            this.updateSmartSearchQuery(index, results.length);
            return results;
        });
        const allResults = await Promise.all(promises);
        await this.waitForSmartSearchPhase(queryPhaseStartedAt, 1800);
        if (searchId !== this._searchId) return null;
        const rawMatchCount = allResults.reduce((total, batch) => total + batch.length, 0);
        const aggregationStartedAt = Date.now();
        this.showSmartSearchAggregation(
            'Combining search results',
            `${rawMatchCount.toLocaleString()} matches across ${searches.length} searches`,
        );

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
        this.showSmartSearchAggregation(
            'Ranking combined courses',
            `${deduped.length.toLocaleString()} unique courses after removing duplicates`,
        );

        // Step 7: Score each result title by embedding similarity to query
        // Batch-embed all titles at once for performance
        this.setSmartSearchStatus('Ranking the closest courses', 'searching', `Comparing ${deduped.length} possible matches by meaning.`);
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
        const aggregationDelay = 1500 - (Date.now() - aggregationStartedAt);
        if (aggregationDelay > 0) await new Promise(resolve => setTimeout(resolve, aggregationDelay));
        return { results: top, expandedTerms, searches };
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

        document.getElementById('btn-search').addEventListener('click', () => this.doSearch());
        document.getElementById('keyword-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.doSearch();
        });
        const smartInput = document.getElementById('smart-keyword-input');
        smartInput?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.isComposing) {
                event.preventDefault();
                this.doSearch();
            }
        });
        smartInput?.addEventListener('input', () => this.autoSizeSmartInput());
        document.getElementById('smart-search-submit')?.addEventListener('click', () => this.doSearch());

        // Clear button
        const clearBtn = document.getElementById('search-clear');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                const input = this.activeSearchInput();
                input.value = '';
                this.autoSizeSmartInput();
                input.focus();
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
                if (event.key === 'Escape' && !filterPanel.classList.contains('hidden')) this.closeFilters();
            });
        }

        filterBackdrop?.addEventListener('click', () => this.closeFilters());
        document.getElementById('btn-close-filters')?.addEventListener('click', () => this.closeFilters());
        document.getElementById('browse-close-details')?.addEventListener('click', () => this.setBrowseState('results'));

        const smartToggle = document.getElementById('smart-search-toggle');
        if (smartToggle) {
            smartToggle.checked = false;
            localStorage.removeItem('uofsc-smart-search');
            smartToggle.addEventListener('change', () => {
                const previousInput = smartToggle.checked
                    ? document.getElementById('keyword-input')
                    : document.getElementById('smart-keyword-input');
                const nextInput = smartToggle.checked
                    ? document.getElementById('smart-keyword-input')
                    : document.getElementById('keyword-input');
                if (nextInput && previousInput?.value && !nextInput.value) nextInput.value = previousInput.value;
                this.autoSizeSmartInput();
                this.setSmartSearchMode(smartToggle.checked);
                if (smartToggle.checked) this.prepareSmartSearch().catch(() => {});
            });
            this.setSmartSearchMode(smartToggle.checked);
        }

        document.querySelectorAll('[data-search-example]').forEach(button => {
            button.addEventListener('click', () => {
                const input = this.activeSearchInput();
                input.value = button.dataset.searchExample || '';
                this.autoSizeSmartInput();
                this.doSearch();
            });
        });

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
        this.startPlaceholderTyping();
    },

    activeSearchInput() {
        return document.getElementById('smart-search-toggle')?.checked
            ? document.getElementById('smart-keyword-input')
            : document.getElementById('keyword-input');
    },

    autoSizeSmartInput() {
        const input = document.getElementById('smart-keyword-input');
        if (!input) return;
        input.style.height = 'auto';
        input.style.height = `${Math.max(96, input.scrollHeight)}px`;
    },

    startPlaceholderTyping() {
        clearTimeout(this._placeholderTimer);
        this._placeholderIndex = 0;
        const regularExamples = [
            'CSCE 145',
            'CSCE 500+',
            'CSCE 140–199',
            'Nursing',
            'Studio Art',
            'Political Science',
            'Mechanical Engineering',
            'Computer Science',
            'Electrical Engineering',
        ];
        const smartExamples = [
            'Nursing courses about caring for children',
            'Art classes focused on digital illustration',
            'Political science courses about elections',
            'Mechanical engineering courses about robotics',
            'Computer science courses about machine learning',
            'Electrical engineering courses about renewable energy',
        ];
        const cycle = () => {
            const input = this.activeSearchInput();
            if (!input) return;
            const examples = document.getElementById('smart-search-toggle')?.checked
                ? smartExamples
                : regularExamples;
            const phrase = examples[this._placeholderIndex % examples.length];
            let length = 0;
            let deleting = false;
            const animate = () => {
                if (!input.value) input.placeholder = phrase.slice(0, length);
                if (!deleting && length < phrase.length) {
                    length += 1;
                    this._placeholderTimer = setTimeout(animate, 52);
                    return;
                }
                if (!deleting) {
                    deleting = true;
                    this._placeholderTimer = setTimeout(animate, 1250);
                    return;
                }
                if (length > 0) {
                    length -= 1;
                    this._placeholderTimer = setTimeout(animate, 24);
                    return;
                }
                this._placeholderIndex += 1;
                this._placeholderTimer = setTimeout(cycle, 250);
            };
            animate();
        };
        cycle();
    },

    setBrowseState(state) {
        const workspace = document.getElementById('browse-workspace');
        if (!workspace) return;
        this._browseState = state;
        workspace.classList.remove('browse-empty', 'browse-results', 'browse-detail');
        workspace.classList.add(`browse-${state}`);
    },

    setSmartSearchMode(enabled) {
        const workspace = document.getElementById('browse-workspace');
        const title = document.getElementById('browse-search-title');
        const description = document.getElementById('browse-search-description');
        const status = document.getElementById('smart-search-status');
        workspace?.classList.toggle('smart-search-active', enabled);
        if (title) title.textContent = enabled ? 'Search courses by meaning' : 'Find your next course';
        if (description) {
            description.textContent = enabled
                ? 'Describe what you want to learn in plain English.'
                : 'Search by course, subject, CRN, range, or description.';
        }
        if (status) status.hidden = true;
        if (!enabled) workspace?.classList.remove('smart-search-busy');
        if (enabled && typeof requestAnimationFrame !== 'undefined') {
            requestAnimationFrame(() => this.autoSizeSmartInput());
        } else if (enabled) {
            this.autoSizeSmartInput();
        }
        this.startPlaceholderTyping();
    },

    setSmartSearchStatus(message, mode = 'loading', activity = '') {
        if (!document.getElementById('smart-search-toggle')?.checked) return;
        const status = document.getElementById('smart-search-status');
        const text = document.getElementById('smart-search-status-text');
        const detail = document.getElementById('smart-search-activity');
        if (!status || !text || !detail) return;
        if (mode === 'ready') {
            this.hideSmartSearchStatus();
            return;
        }
        status.hidden = false;
        status.dataset.state = mode;
        if (mode === 'loading') {
            status.dataset.phase = 'model';
            const trace = document.getElementById('smart-search-trace');
            if (trace) trace.hidden = true;
        }
        document.getElementById('browse-workspace')?.classList.toggle(
            'smart-search-busy',
            mode === 'loading' || mode === 'searching',
        );
        text.textContent = message;
        detail.textContent = activity;
    },

    resetSmartSearchTrace() {
        const status = document.getElementById('smart-search-status');
        const trace = document.getElementById('smart-search-trace');
        const list = document.getElementById('smart-search-query-list');
        const aggregate = document.getElementById('smart-search-aggregate');
        if (status) status.dataset.phase = 'thinking';
        if (trace) trace.hidden = true;
        if (list) list.replaceChildren();
        if (aggregate) aggregate.hidden = true;
    },

    showSmartSearchQueries(searches) {
        const status = document.getElementById('smart-search-status');
        const trace = document.getElementById('smart-search-trace');
        const list = document.getElementById('smart-search-query-list');
        const phase = document.getElementById('smart-search-trace-phase');
        const summary = document.getElementById('smart-search-trace-summary');
        const aggregate = document.getElementById('smart-search-aggregate');
        if (!status || !trace || !list || !phase || !summary || !aggregate) return;
        status.dataset.phase = 'queries';
        trace.hidden = false;
        aggregate.hidden = true;
        phase.textContent = `${searches.length} searches generated`;
        summary.textContent = `0 of ${searches.length} complete`;
        list.replaceChildren();
        searches.forEach((term, index) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'smart-search-query-item';
            item.dataset.queryIndex = String(index);
            item.dataset.state = 'searching';
            item.disabled = true;
            item.style.setProperty('--query-delay', `${index * 55}ms`);
            const label = document.createElement('span');
            label.textContent = term;
            const count = document.createElement('strong');
            count.textContent = 'SEARCHING';
            item.append(label, count);
            item.addEventListener('click', () => this.openRegularSearch(term));
            list.append(item);
        });
    },

    updateSmartSearchQuery(index, resultCount) {
        const list = document.getElementById('smart-search-query-list');
        const summary = document.getElementById('smart-search-trace-summary');
        const item = list?.querySelector(`[data-query-index="${index}"]`);
        if (!list || !summary || !item) return;
        item.dataset.state = 'complete';
        item.disabled = false;
        item.setAttribute('aria-label', `Search regular results for ${item.querySelector('span')?.textContent || 'this term'}`);
        const count = item.querySelector('strong');
        if (count) count.textContent = `${resultCount.toLocaleString()} ${resultCount === 1 ? 'RESULT' : 'RESULTS'}`;
        const completed = list.querySelectorAll('[data-state="complete"]').length;
        const total = list.children.length;
        summary.textContent = `${completed} of ${total} complete`;
    },

    openRegularSearch(term) {
        const smartToggle = document.getElementById('smart-search-toggle');
        const regularInput = document.getElementById('keyword-input');
        if (!smartToggle || !regularInput) return;
        this._searchId += 1;
        smartToggle.checked = false;
        regularInput.value = term;
        this.setSmartSearchMode(false);
        regularInput.focus();
        this.doSearch();
    },

    showSmartSearchAggregation(title, detail) {
        const status = document.getElementById('smart-search-status');
        const trace = document.getElementById('smart-search-trace');
        const phase = document.getElementById('smart-search-trace-phase');
        const summary = document.getElementById('smart-search-trace-summary');
        const aggregate = document.getElementById('smart-search-aggregate');
        const aggregateTitle = document.getElementById('smart-search-aggregate-title');
        const aggregateDetail = document.getElementById('smart-search-aggregate-detail');
        if (!status || !trace || !phase || !summary || !aggregate || !aggregateTitle || !aggregateDetail) return;
        status.dataset.phase = 'aggregating';
        trace.hidden = false;
        phase.textContent = 'Searches complete';
        summary.textContent = 'Combining matches';
        aggregate.hidden = false;
        aggregateTitle.textContent = title;
        aggregateDetail.textContent = detail;
    },

    async waitForSmartSearchPhase(startedAt, minimumMs) {
        const remaining = minimumMs - (Date.now() - startedAt);
        if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
    },

    hideSmartSearchStatus() {
        const status = document.getElementById('smart-search-status');
        if (status) status.hidden = true;
        document.getElementById('browse-workspace')?.classList.remove('smart-search-busy');
    },

    smartDownloadMbps() {
        const entries = typeof performance !== 'undefined' && performance.getEntriesByType
            ? performance.getEntriesByType('resource').filter(entry => entry.transferSize > 0 && entry.duration > 0)
            : [];
        const recent = entries.slice(-12);
        const bytes = recent.reduce((sum, entry) => sum + entry.transferSize, 0);
        const milliseconds = recent.reduce((sum, entry) => sum + entry.duration, 0);
        const measuredMbps = milliseconds > 0 ? (bytes * 8) / (milliseconds * 1000) : 0;
        const reportedMbps = typeof navigator !== 'undefined' ? Number(navigator.connection?.downlink) : 0;
        return measuredMbps > 0 ? measuredMbps : (reportedMbps > 0 ? reportedMbps : 10);
    },

    estimatedSmartStageMs(bytes, minimumMs = 350, maximumMs = 1800) {
        const transferMs = (bytes * 8) / (this.smartDownloadMbps() * 1000);
        return Math.round(Math.min(maximumMs, Math.max(minimumMs, transferMs * 0.15)));
    },

    async waitForEstimatedSmartStage(startedAt, bytes, minimumMs, maximumMs) {
        const remaining = this.estimatedSmartStageMs(bytes, minimumMs, maximumMs) - (Date.now() - startedAt);
        if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
    },

    setSmartModelLoading(active, stage = '') {
        const input = document.getElementById('smart-keyword-input');
        const loading = document.getElementById('smart-model-loading');
        const label = document.getElementById('smart-model-loading-stage');
        const submit = document.getElementById('smart-search-submit');
        const workspace = document.getElementById('browse-workspace');
        workspace?.classList.toggle('smart-search-busy', active);
        if (label && stage) label.textContent = stage;
        loading?.classList.toggle('hidden', !active);
        if (input) {
            input.disabled = active;
            input.value = '';
            input.setAttribute('aria-busy', String(active));
        }
        if (submit) submit.disabled = active;
        document.querySelectorAll?.('.smart-search-examples button').forEach(button => { button.disabled = active; });
        if (!active) {
            this.autoSizeSmartInput();
            if (document.getElementById('smart-search-toggle')?.checked) input?.focus();
        }
    },

    async prepareSmartSearch() {
        if (this._extractor && this._phraseData) return true;
        if (this._smartModelPromise) return this._smartModelPromise;
        this.hideSmartSearchStatus();
        this._smartModelPromise = (async () => {
            this.setSmartModelLoading(true, 'Loading embedding model');
            const embeddingStartedAt = Date.now();
            await this._loadExtractor();
            await this.waitForEstimatedSmartStage(embeddingStartedAt, 23 * 1024 * 1024, 500, 1800);

            this.setSmartModelLoading(true, 'Loading search model');
            const searchStartedAt = Date.now();
            await this._loadPhraseData();
            await this.waitForEstimatedSmartStage(searchStartedAt, 8 * 1024 * 1024, 450, 1400);

            this.setSmartModelLoading(true, 'Loading semantic model');
            const semanticStartedAt = Date.now();
            await this._embedQuery('course search');
            await this.waitForEstimatedSmartStage(semanticStartedAt, 512 * 1024, 450, 900);
            this.setSmartModelLoading(false);
            return true;
        })().catch(error => {
            this._smartModelPromise = null;
            this.setSmartModelLoading(false);
            this.setSmartSearchStatus('Could not load Smart Search', 'error', 'Check your connection or use regular search.');
            throw error;
        });
        return this._smartModelPromise;
    },

    closeFilters() {
        const panel = document.getElementById('filter-panel');
        const backdrop = document.getElementById('filter-backdrop');
        const toggle = document.getElementById('filter-toggle');
        const arrow = document.getElementById('filter-arrow');
        panel?.classList.add('hidden');
        backdrop?.classList.add('hidden');
        document.body?.classList.remove('filter-modal-open');
        arrow?.classList.remove('open');
        toggle?.setAttribute('aria-expanded', 'false');
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
                    if (element.type === 'checkbox') element.checked = false;
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

    async doSearch() {
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

        // Plain keyword search unless Smart Search was explicitly enabled
        } else if (!document.getElementById('smart-search-toggle')?.checked) {
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
                    this.setSmartSearchStatus('No close matches found', 'ready', 'Try describing the topic another way.');
                    this.showHint(`No matching courses found for "${kw}".`);
                    return;
                }

                let results = semantic.results;

                // Cross-reference ALL results with live term data
                const subjects = [...new Set(results.map(r => (r.code || '').split(' ')[0]).filter(Boolean))];
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

                if (searchId !== this._searchId) return;
                const eligibleOnly2 = document.getElementById('filter-eligible').checked;
                const prereqData = eligibleOnly2 ? await this.loadPrereqsForResults(results) : {};
                const searchInfo = semantic.searches?.length ? semantic.searches : null;
                this.renderResults(results, results.length, prereqData, eligibleOnly2, searchInfo);
                this.setSmartSearchStatus(
                    `${new Set(results.map(result => result.code)).size} courses found`,
                    'ready',
                    'Results are ranked by how closely their meaning matches your search.',
                );
            } catch (err) {
                console.error('[Semantic] Error:', err);
                this.setSmartSearchStatus('Smart Search failed', 'error', 'Try again or turn off Smart Search.');
                this.showHint('Search failed. Try again.');
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
                if (!subject) {
                    this.showHint('Pick a subject to browse the full catalog.');
                    return;
                }
                const bulletinData = await API.bulletinSearch(subject);
                const bulletinCourses = bulletinData.results || [];

                // Also fetch live term data to cross-reference availability
                const liveCriteria = [{ field: 'subject', value: subject }];
                const liveData = await API.searchCourses(State.term, liveCriteria);
                const liveResults = liveData.results || [];

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

    showCourseDetail(group) {
        const detailsTab = document.getElementById('tab-details');
        if (!detailsTab) return;
        this.setBrowseState('detail');

        const firstSection = group.sections[0];
        const availability = this.courseAvailability(group);
        const unavailable = availability.kind === 'unavailable';
        const liveSections = group.sections.filter(section => section.crn && !section._isCatalog);

        const actionButton = () => {
            if (unavailable) {
                return '<button id="btn-course-toggle" class="btn-course-unavailable" disabled>NOT OFFERED THIS TERM</button>';
            }
            const selected = State.isCourseSelected(group.code);
            return `<button id="btn-course-toggle" class="${selected ? 'btn-danger' : 'btn-green'}">${selected ? 'REMOVE COURSE' : 'ADD COURSE TO SCHEDULE'}</button>`;
        };

        const bindAction = () => {
            document.getElementById('btn-course-toggle')?.addEventListener('click', async () => {
                if (State.isCourseSelected(group.code)) State.removeCourse(group.code);
                else await Scheduler.addCourseGroup(group);
                this.updateCourseSelectionStyles(group.code);
                this.showCourseDetail(group);
            });
        };

        const render = details => {
            const desc = (details?.description || '').replace(/<[^>]+>/g, ' ').trim();
            detailsTab.innerHTML = `
                <h3>${group.code} - ${details?.title || group.title}</h3>
                <p class="course-detail-availability ${availability.kind}">${availability.text}</p>
                ${details ? `<p><strong>Credits:</strong> ${details.hours_html || 'N/A'}</p>` : ''}
                <p><strong>Sections this term:</strong> ${liveSections.length}</p>
                ${desc ? `<p><strong>Description:</strong> ${desc.substring(0, 400)}${desc.length > 400 ? '...' : ''}</p>` : ''}
                <div class="section-actions">${actionButton()}</div>
                ${details === null ? '<p class="loading">Loading details</p>' : ''}
            `;
            bindAction();
        };

        render(null);
        if (!firstSection) return;
        this.fetchBulletinDetailsForCourse(group.code)
            .then(details => render(details || {}))
            .catch(() => detailsTab.querySelector('.loading')?.remove());
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

        if (results.length === 0) {
            container.innerHTML = '<p class="hint">No results found.</p>';
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

        // Header with search info
        let header = `<p style="font-size:0.75rem;color:#555;margin-bottom:6px;font-weight:600">${groupList.length} courses (${count} total sections)</p>`;
        if (searchTerms && searchTerms.length) {
            const expandedTags = searchTerms.map((term, index) =>
                `<button type="button" class="semantic-search-term" data-regular-search-index="${index}">${this.escapeText(term)}</button>`
            ).join(' ');
            header += `<div class="semantic-search-terms"><span>Generated searches</span>${expandedTags}</div>`;
        }
        container.innerHTML = header;
        container.querySelectorAll('[data-regular-search-index]').forEach(button => {
            button.addEventListener('click', () => {
                const term = searchTerms[Number(button.dataset.regularSearchIndex)];
                if (term) this.openRegularSearch(term);
            });
        });

        groupList.forEach(group => {
            const div = document.createElement('div');
            div.className = 'course-group';
            div.dataset.courseCode = group.code;
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
                <div class="course-sections"></div>
            `;

            const header = div.querySelector('.course-header');
            const summary = div.querySelector('.course-result-summary');
            const sectionsDiv = div.querySelector('.course-sections');
            div.classList.toggle('course-added', State.isCourseSelected(group.code));

            header.addEventListener('click', () => {
                // Collapse all other course sections and remove active highlight
                const isExpanding = !sectionsDiv.classList.contains('expanded');
                document.querySelectorAll('#search-results .course-group.active').forEach(g => g.classList.remove('active'));
                document.querySelectorAll('#search-results .course-sections.expanded').forEach(s => {
                    if (s !== sectionsDiv) s.classList.remove('expanded');
                });
                sectionsDiv.classList.toggle('expanded', isExpanding);
                div.classList.toggle('active', isExpanding);
                // Load course info using the first section's data
                const firstSec = group.sections[0];
                if (firstSec) {
                    if (typeof Prereqs !== 'undefined' && Prereqs.loadForCourse) {
                        Prereqs.loadForCourse(firstSec.code);
                    }
                    if (typeof History !== 'undefined' && History.loadForCourse) {
                        History.loadForCourse(firstSec.code);
                    }
                    if (typeof Grades !== 'undefined' && Grades.loadForCourse) {
                        Grades.loadForCourse(firstSec.code);
                    }
                    this.showCourseDetail(group);
                }
            });

            group.sections.forEach(sec => {
                const row = document.createElement('div');
                row.className = 'section-row';
                const statusDot = sec._isCatalog
                    ? '<span style="color:#5C5C5C;font-weight:700">&#9679;</span>'
                    : sec.stat === 'A'
                    ? '<span style="color:#2e7d32;font-weight:700">&#9679;</span>'
                    : '<span style="color:#c62828;font-weight:700">&#9679;</span>';
                row.innerHTML = `
                    <span class="sec-status">${statusDot}</span>
                    <span class="sec-id">${sec.section}</span>
                    <span class="sec-instr">${(sec.instr && sec.instr !== 'Staff' ? sec.instr : 'Undecided')}</span>
                    <span class="sec-time">${sec.meets || 'TBA'}</span>
                `;

                // Clicking the row shows details in the main content panel
                row.addEventListener('click', (e) => {
                    e.stopPropagation();
                    // Clear all viewing highlights across all course groups
                    document.querySelectorAll('#search-results .section-row.viewing').forEach(r => r.classList.remove('viewing'));
                    row.classList.add('viewing');
                    // Show section details while keeping schedule selection course-level
                    if (sec._isCatalog) Search.showCourseDetail(group);
                    else Search.showSectionDetail(sec);
                });
                row.dataset.crn = sec.crn;
                sectionsDiv.appendChild(row);
            });

            container.appendChild(div);
            this.observeCourseResultSummary(summary, group);
        });
    },

    showSectionDetail(sec) {
        const detailsTab = document.getElementById('tab-details');
        if (!detailsTab) return;
        this.setBrowseState('detail');

        const group = (State.courseGroups || []).find(item => item.code === sec.code) || {
            code: sec.code,
            title: sec.title,
            sections: [sec],
        };

        const bindActions = () => {
            document.getElementById('btn-course-toggle')?.addEventListener('click', async () => {
                const thisSectionIsSelected = State.isCourseSelected(sec.code)
                    && String(State.sectionLocks?.[sec.code] || '') === String(sec.crn);
                if (thisSectionIsSelected) {
                    State.removeCourse(sec.code);
                } else {
                    if (!State.isCourseSelected(sec.code)) await Scheduler.addCourseGroup(group);
                    State.setSectionLock(sec.code, sec.crn);
                }
                this.showSectionDetail(sec);
            });
            document.getElementById('btn-view-schedule')?.addEventListener('click', () => {
                if (typeof Tabs !== 'undefined') Tabs.switchTo('schedule');
            });
        };

        const courseButton = () => {
            const thisSectionIsSelected = State.isCourseSelected(sec.code)
                && String(State.sectionLocks?.[sec.code] || '') === String(sec.crn);
            return `<button id="btn-course-toggle" class="${thisSectionIsSelected ? 'btn-danger' : 'btn-green'}" style="margin-top:10px">${thisSectionIsSelected ? 'REMOVE SECTION FROM SCHEDULE' : 'ADD SECTION TO SCHEDULE'}</button>`;
        };

        detailsTab.innerHTML = `
            <h3>${sec.code} - ${sec.title}</h3>
            <p><strong>Section:</strong> ${sec.section} (CRN: ${sec.crn})</p>
            <p><strong>Instructor:</strong> ${(sec.instr && sec.instr !== 'Staff' ? sec.instr : 'Undecided')}</p>
            <p><strong>Meets:</strong> ${sec.meets || 'TBA'}</p>
            <p><strong>Method:</strong> ${sec.inst_mthd || 'N/A'}</p>
            <p><strong>Status:</strong> ${sec.stat === 'A' ? '<span style="color:#2e7d32;font-weight:700">Open</span>' : '<span style="color:#c62828;font-weight:700">Full</span>'}</p>
            <div class="section-actions">
                ${courseButton()}
                <button id="btn-view-schedule" class="btn-garnet" style="margin-top:10px">VIEW SCHEDULE</button>
            </div>
            <p class="hint">This section will be used in every generated schedule.</p>
            <p class="loading">Loading details</p>
        `;
        bindActions();

        // Fetch full details
        API.getDetails(sec.crn, State.term).then(data => {
            const seatsMatch = (data.seats || '').match(/seats_avail[^>]*>(\d+)/);
            const maxMatch = (data.seats || '').match(/seats_max[^>]*>(\d+)/);
            const seats = seatsMatch ? seatsMatch[1] : '?';
            const max = maxMatch ? maxMatch[1] : '?';
            const desc = (data.description || '').replace(/<[^>]+>/g, ' ').trim();
            const meeting = this.parseMeetingHtml(data.meeting_html);
            const timesStr = meeting.times.length > 0 ? meeting.times.join('; ') : (sec.meets || 'TBA');
            const locsStr = meeting.locations.length > 0 ? meeting.locations.join('; ') : 'TBA';
            const locLabel = meeting.locations.length > 1 ? 'Locations' : 'Location';

            detailsTab.innerHTML = `
                <h3>${sec.code} - ${sec.title}</h3>
                <p><strong>Section:</strong> ${sec.section} (CRN: ${sec.crn})</p>
                <p><strong>Instructor:</strong> ${(sec.instr && sec.instr !== 'Staff' ? sec.instr : 'Undecided')}</p>
                <p><strong>Class Times:</strong> ${timesStr}</p>
                <p><strong>${locLabel}:</strong> ${locsStr}</p>
                <p><strong>Credits:</strong> ${data.hours_html || 'N/A'}</p>
                <p><strong>Seats:</strong> <span class="seats-info">${seats} / ${max} available</span></p>
                <p><strong>Method:</strong> ${data.inst_mthd || sec.inst_mthd || 'N/A'}</p>
                ${desc ? `<p><strong>Description:</strong> ${desc.substring(0, 400)}${desc.length > 400 ? '...' : ''}</p>` : ''}
                ${data.clssnotes ? `<p><strong>Notes:</strong> ${data.clssnotes.replace(/<[^>]+>/g, ' ').trim()}</p>` : ''}
                <div class="section-actions">
                    ${courseButton()}
                    <button id="btn-view-schedule" class="btn-garnet" style="margin-top:10px">VIEW SCHEDULE</button>
                </div>
                <p class="hint">This section will be used in every generated schedule.</p>
            `;
            bindActions();
        }).catch(() => {
            detailsTab.querySelector('.loading')?.remove();
        });
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

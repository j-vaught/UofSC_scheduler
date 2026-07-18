/* Browser data boundary with an explicit legacy-relay comparison mode. */
const API = {
    _mode: null,
    _liveClient: null,
    _dataStore: null,
    _catalogByKey: new Map(),
    _forceRefreshLive: false,
    _inflight: new Map(),
    _responseCache: new Map(),
    _responseCacheMaxEntries: 200,
    _majorMapArtifacts: new Map(),
    _solverWorker: null,
    _solverWorkerSequence: 0,
    _solverWorkerRequests: new Map(),
    _runtimeWorkers: new Map(),
    _runtimeWorkerSequence: 0,
    _runtimeWorkerRequests: new Map(),

    configure(options = {}) {
        if (options.mode) this.setMode(options.mode);
        if (options.liveClient) this._liveClient = options.liveClient;
        if (options.dataStore) this._dataStore = options.dataStore;
        return this;
    },

    setMode(mode) {
        const normalized = String(mode || '').toLowerCase().trim();
        if (!['static', 'legacy'].includes(normalized)) {
            throw new Error(`Unknown API mode: ${mode}`);
        }
        this._mode = normalized;
        return normalized;
    },

    getMode() {
        if (this._mode) return this._mode;
        const configured = globalThis.CourseSchedulerConfig?.apiMode
            || globalThis.COURSE_SCHEDULER_API_MODE;
        if (configured) return this.setMode(configured);
        if (globalThis.CourseDataStore && globalThis.LiveUniversityClient) {
            return this.setMode('static');
        }
        return this.setMode('legacy');
    },

    isStaticMode() {
        return this.getMode() === 'static';
    },

    _getDataStore() {
        const store = this._dataStore || globalThis.CourseDataStore;
        if (!store) {
            const error = new Error('Static course data is not loaded');
            error.code = 'STATIC_DATA_UNAVAILABLE';
            throw error;
        }
        this._dataStore = store;
        return store;
    },

    _getLiveClient() {
        if (this._liveClient) return this._liveClient;
        if (typeof globalThis.LiveUniversityClient !== 'function') {
            const error = new Error('The direct University data client is not loaded');
            error.code = 'DIRECT_CLIENT_UNAVAILABLE';
            throw error;
        }
        this._liveClient = new globalThis.LiveUniversityClient(
            globalThis.CourseSchedulerConfig?.liveClient || {},
        );
        return this._liveClient;
    },

    _cacheKey(path, body) {
        const normalize = value => {
            if (Array.isArray(value)) return value.map(normalize);
            if (value && typeof value === 'object') {
                return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
            }
            return value;
        };
        return `${path}:${JSON.stringify(normalize(body))}`;
    },

    _cached(key) {
        const entry = this._responseCache.get(key);
        if (!entry) return null;
        if (Date.now() >= entry.expiresAt) {
            this._responseCache.delete(key);
            return null;
        }
        this._responseCache.delete(key);
        this._responseCache.set(key, entry);
        return entry.data;
    },

    _storeCached(key, data, cacheTtl) {
        this._responseCache.delete(key);
        this._responseCache.set(key, { data, expiresAt: Date.now() + cacheTtl });
        while (this._responseCache.size > this._responseCacheMaxEntries) {
            this._responseCache.delete(this._responseCache.keys().next().value);
        }
    },

    shouldRefreshAfterReload() {
        if (typeof performance === 'undefined' || !performance.getEntriesByType) return false;
        return performance.getEntriesByType('navigation')[0]?.type === 'reload';
    },

    setForceRefreshLive(active) {
        this._forceRefreshLive = Boolean(active);
    },

    async post(path, body, { cacheTtl = 0, signal = null, forceRefresh = null } = {}) {
        if (this.isStaticMode()) {
            return this._postStatic(path, body, { cacheTtl, signal, forceRefresh });
        }
        const key = this._cacheKey(path, body);
        const refresh = forceRefresh === null ? this._forceRefreshLive : Boolean(forceRefresh);
        const requestKey = `${key}:refresh=${refresh ? 1 : 0}`;
        if (!refresh && cacheTtl > 0) {
            const cached = this._cached(key);
            if (cached !== null) return cached;
        }
        if (this._inflight.has(requestKey)) return this._inflight.get(requestKey);

        const headers = { 'Content-Type': 'application/json' };
        if (refresh) headers['X-UofSC-Refresh-Live'] = '1';
        const request = (async () => {
            const resp = await fetch(path, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: signal || undefined,
            });
            const data = await resp.json();
            if (!resp.ok || (data && typeof data === 'object' && data.error)) {
                throw new Error(data?.error || `Request failed with status ${resp.status}`);
            }
            if (!refresh && cacheTtl > 0) {
                this._storeCached(key, data, cacheTtl);
            }
            return data;
        })();
        this._inflight.set(requestKey, request);
        try {
            return await request;
        } finally {
            if (this._inflight.get(requestKey) === request) this._inflight.delete(requestKey);
        }
    },

    async _postStatic(path, body, { cacheTtl = 0, signal = null, forceRefresh = null } = {}) {
        const live = () => this._getLiveClient().request(
            {
                '/api/search': 'courseSearch',
                '/api/details': 'courseDetails',
                '/api/bulletin/search': 'bulletinSearch',
                '/api/bulletin/details': 'bulletinDetails',
            }[path],
            body,
            {
                cacheTtl: cacheTtl || undefined,
                forceRefresh: forceRefresh === null
                    ? this._forceRefreshLive
                    : Boolean(forceRefresh),
                signal,
            },
        );
        if (path === '/api/search') return this._liveSearchWithFallback(body, live);
        if (path === '/api/details') return live();
        if (path === '/api/bulletin/search') {
            return this._bulletinRequestWithFallback(body, live);
        }
        if (path === '/api/bulletin/details') {
            const key = String(body?.group || '').replace(/^key:/, '');
            const cached = this._catalogByKey.get(key);
            if (cached) return cached;
            return live();
        }
        if (path === '/api/history') return this._getStaticHistory(body?.code);
        if (path === '/api/parse-transcript') {
            return Object.hasOwn(body || {}, 'csv')
                ? this.parseTranscriptCSV(body.csv)
                : this.parseTranscript(body?.text || '');
        }
        if (path === '/api/major-map') return this.getMajorMap(body?.id);
        if (path === '/api/degree-plan') return this.getDegreePlan(body || {});
        if (path === '/api/offering-analysis') {
            return this.getOfferingAnalysis(body?.code, body?.current_term);
        }
        if (path === '/api/course-grades') return this.getCourseGrades(body?.code);
        if (path === '/api/professor-grades') return this.getProfessorGrades(body?.id);
        if (path === '/api/faculty') return this.getFaculty(body?.term, body?.crns || []);
        const error = new Error(`Static runtime does not support ${path}`);
        error.code = 'STATIC_ROUTE_UNAVAILABLE';
        throw error;
    },

    async _liveSearchWithFallback(body, liveFactory) {
        try {
            return await liveFactory();
        } catch (liveError) {
            const criteria = Array.isArray(body?.criteria) ? body.criteria : [];
            if (criteria.some(item => item?.field === 'crn')) throw liveError;
            const searchable = criteria.some(item => (
                ['subject', 'alias', 'keyword'].includes(String(item?.field || ''))
                && String(item?.value || '').trim()
            ));
            if (!searchable) throw liveError;
            const fallback = await this._catalogSearch(body);
            fallback.results = (fallback.results || []).map(course => ({
                ...course,
                _isCatalog: true,
                availability_unknown: true,
            }));
            fallback.availability_unknown = true;
            fallback._live_error = {
                name: liveError?.name || 'Error',
                code: liveError?.code || 'LIVE_SEARCH_UNAVAILABLE',
                message: liveError?.message || String(liveError),
                cors_blocked: Boolean(liveError?.corsBlocked),
            };
            return fallback;
        }
    },

    async searchCourses(term, criteria, options = {}) {
        return this.post('/api/search', {
            other: { srcdb: term },
            criteria,
        }, { cacheTtl: 5 * 60 * 1000, ...options });
    },

    async getDetails(crn, term, options = {}) {
        return this.post('/api/details', {
            group: `crn:${crn}`,
            srcdb: term,
        }, { cacheTtl: 5 * 60 * 1000, ...options });
    },

    async bulletinSearch(subject, srcdb = '2026', options = {}) {
        return this.post('/api/bulletin/search', {
            other: { srcdb },
            criteria: [{ field: 'subject', value: subject }],
        }, { cacheTtl: 24 * 60 * 60 * 1000, ...options });
    },

    async bulletinDetails(key, srcdb = '2026', options = {}) {
        return this.post('/api/bulletin/details', {
            group: `key:${key}`,
            srcdb,
        }, { cacheTtl: 24 * 60 * 60 * 1000, ...options });
    },

    async getSubjects() {
        if (!this.isStaticMode()) {
            const response = await fetch('/api/subjects');
            if (!response.ok) throw new Error(`Subject lookup failed (${response.status})`);
            return response.json();
        }
        const artifact = await this._getDataStore().getArtifact('catalog/subjects');
        const subjects = Array.isArray(artifact) ? artifact : artifact?.subjects;
        if (!Array.isArray(subjects)) {
            const error = new Error('The static subject catalog is invalid');
            error.code = 'STATIC_DATA_INVALID';
            throw error;
        }
        return subjects.map(value => (
            typeof value === 'string' ? value : value?.code || value?.subject
        )).filter(Boolean);
    },

    async _bulletinRequestWithFallback(body, liveFactory) {
        const strategy = String(
            globalThis.CourseSchedulerConfig?.catalogMode || 'static-first',
        ).toLowerCase();
        if (strategy !== 'live-first') {
            try {
                return await this._catalogSearch(body);
            } catch (error) {
                if (strategy === 'static-only') throw error;
            }
            return liveFactory();
        }

        try {
            return await liveFactory();
        } catch (liveError) {
            const result = await this._catalogSearch(body);
            result._source = 'static-catalog';
            result._live_error = {
                name: liveError?.name || 'Error',
                code: liveError?.code || 'LIVE_CATALOG_UNAVAILABLE',
                message: liveError?.message || String(liveError),
                cors_blocked: Boolean(liveError?.corsBlocked),
            };
            return result;
        }
    },

    async _catalogSearch(body = {}) {
        const criteria = Array.isArray(body.criteria) ? body.criteria : [];
        const requestedSubjects = criteria
            .filter(item => item?.field === 'subject')
            .map(item => String(item.value || '').trim().toUpperCase())
            .filter(Boolean);
        const inferredSubjects = criteria
            .filter(item => ['alias', 'keyword'].includes(String(item?.field || '')))
            .map(item => String(item.value || '').trim().toUpperCase()
                .match(/^([A-Z]{2,8})\s*\d{3}[A-Z]?$/)?.[1] || '')
            .filter(Boolean);
        const subjects = requestedSubjects.length
            ? requestedSubjects
            : inferredSubjects.length
                ? [...new Set(inferredSubjects)]
                : await this.getSubjects();
        const store = this._getDataStore();
        const names = [...new Set(subjects.map(subject => `catalog/courses/${subject}`))];
        let artifacts = {};
        if (typeof store.prefetch === 'function' && names.length > 1) {
            artifacts = (await store.prefetch(names, { concurrency: 4 })).results;
        } else {
            const loaded = await Promise.all(names.map(async name => [name, await store.getArtifact(name)]));
            artifacts = Object.fromEntries(loaded);
        }
        const courses = names.flatMap(name => {
            const artifact = artifacts[name];
            const records = Array.isArray(artifact) ? artifact : artifact?.courses || [];
            return Array.isArray(records) ? records : Object.values(records);
        });
        const filtered = courses
            .filter(course => this._catalogCourseMatches(course, criteria))
            .map(course => this._normalizeCatalogCourse(course));
        this._rememberCatalogCourses(filtered);
        return {
            count: filtered.length,
            results: filtered,
            _source: 'static-catalog',
        };
    },

    _catalogCourseMatches(course, criteria) {
        const code = String(course?.code || '').toUpperCase();
        const subject = String(course?.subject || code.split(' ')[0] || '').toUpperCase();
        const haystack = [code, course?.title, course?.description]
            .map(value => String(value || '').toLowerCase())
            .join(' ');
        for (const criterion of criteria || []) {
            const field = String(criterion?.field || '');
            const value = String(criterion?.value || '').trim();
            if (!value || field === 'stat') continue;
            if (field === 'subject' && subject !== value.toUpperCase()) return false;
            if (field === 'alias' && code.replace(/\s+/g, ' ') !== value.toUpperCase().replace(/\s+/g, ' ')) {
                return false;
            }
            if (field === 'crn') return false;
            if (field === 'keyword') {
                const tokens = value.toLowerCase().split(/\s+/).filter(Boolean);
                if (!tokens.every(token => haystack.includes(token))) return false;
            }
        }
        return true;
    },

    _rememberCatalogCourses(courses) {
        for (const course of courses || []) {
            const key = String(course?.key ?? '');
            if (key) this._catalogByKey.set(key, course);
        }
    },

    _normalizeCatalogCourse(course) {
        return {
            ...course,
            prereq: course?.prereq ?? course?.prerequisite_text ?? '',
            prerequisite_text: course?.prerequisite_text ?? course?.prereq ?? '',
        };
    },

    async getHistory(courseCode, onProgress = null) {
        if (this.isStaticMode()) return this._getStaticHistory(courseCode, onProgress);
        if (typeof onProgress !== 'function') {
            return this.post('/api/history', { code: courseCode });
        }

        const resp = await fetch('/api/history-stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: courseCode }),
        });
        if (!resp.ok) {
            if (resp.status === 404) return this.post('/api/history', { code: courseCode });
            throw new Error(`Request failed with status ${resp.status}`);
        }

        let result = null;
        let malformed = false;
        const consumeLine = rawLine => {
            const line = String(rawLine || '').trim();
            if (!line) return;
            let event;
            try {
                event = JSON.parse(line);
            } catch (error) {
                malformed = true;
                return;
            }
            if (event.type === 'progress') onProgress(event);
            else if (event.type === 'result') result = event.data;
        };

        if (resp.body?.getReader) {
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            while (true) {
                let chunk;
                try {
                    chunk = await reader.read();
                } catch (error) {
                    return this.post('/api/history', { code: courseCode });
                }
                const { done, value } = chunk;
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                lines.forEach(consumeLine);
            }
            buffer += decoder.decode();
            consumeLine(buffer);
        } else {
            let payload;
            try {
                payload = await resp.text();
            } catch (error) {
                return this.post('/api/history', { code: courseCode });
            }
            payload.split('\n').forEach(consumeLine);
        }

        if (malformed || !result) return this.post('/api/history', { code: courseCode });
        if (typeof result !== 'object' || Array.isArray(result) || result.error) {
            throw new Error(result?.error || 'Offering history is unavailable');
        }
        return result;
    },

    async _getStaticHistory(courseCode, onProgress = null) {
        const progress = typeof onProgress === 'function' ? onProgress : () => {};
        progress({
            type: 'progress',
            phase: 'static-data',
            completed: 0,
            total: 1,
            label: 'Loading saved offering history',
        });
        const result = await this._getDataStore().getOfferingHistory(courseCode);
        if (!result) {
            const error = new Error(`Offering history is not in this data release: ${courseCode}`);
            error.code = 'STATIC_HISTORY_NOT_FOUND';
            throw error;
        }
        progress({
            type: 'progress',
            phase: 'static-data',
            completed: 1,
            total: 1,
            label: 'Offering history ready',
            cached: true,
        });
        return result;
    },

    async solve(courses, preferences, maxResults = 10) {
        const params = { courses, preferences, max_results: maxResults };
        if (typeof Worker === 'undefined') {
            if (typeof SolverCore === 'undefined') throw new Error('Schedule solver is unavailable');
            return SolverCore.solve(params);
        }

        if (!this._solverWorker) {
            try {
                this._solverWorker = new Worker('/static/js/solver-worker.js');
                this._solverWorker.addEventListener('message', event => {
                    const request = this._solverWorkerRequests.get(event.data?.id);
                    if (!request) return;
                    this._solverWorkerRequests.delete(event.data.id);
                    if (event.data.error) request.reject(new Error(event.data.error));
                    else request.resolve(event.data.result);
                });
                this._solverWorker.addEventListener('error', event => {
                    const error = new Error(event.message || 'Schedule solver worker failed');
                    for (const request of this._solverWorkerRequests.values()) request.reject(error);
                    this._solverWorkerRequests.clear();
                    this._solverWorker?.terminate();
                    this._solverWorker = null;
                });
            } catch (error) {
                this._solverWorker = null;
                if (typeof SolverCore === 'undefined') throw error;
                return SolverCore.solve(params);
            }
        }

        const id = ++this._solverWorkerSequence;
        return new Promise((resolve, reject) => {
            this._solverWorkerRequests.set(id, { resolve, reject });
            this._solverWorker.postMessage({ id, params });
        });
    },

    async _runRuntimeWorker(kind, operation, payload) {
        if (typeof Worker === 'undefined') return this._runRuntimeFallback(kind, operation, payload);
        const urls = {
            transcript: '/static/js/workers/transcript-worker.js?v=20260718',
            degree: '/static/js/workers/degree-planner-worker.js',
            offering: '/static/js/workers/offering-analysis-worker.js',
        };
        if (!urls[kind]) throw new Error(`Unknown browser runtime: ${kind}`);
        let worker = this._runtimeWorkers.get(kind);
        if (!worker) {
            try {
                worker = new Worker(urls[kind]);
                worker.addEventListener('message', event => {
                    const request = this._runtimeWorkerRequests.get(event.data?.requestId);
                    if (!request || request.kind !== kind) return;
                    this._runtimeWorkerRequests.delete(event.data.requestId);
                    if (event.data.ok === false) request.reject(new Error(event.data.error));
                    else request.resolve(event.data.result);
                });
                worker.addEventListener('error', event => {
                    const error = new Error(event.message || `${kind} worker failed`);
                    for (const [id, request] of this._runtimeWorkerRequests) {
                        if (request.kind !== kind) continue;
                        this._runtimeWorkerRequests.delete(id);
                        request.reject(error);
                    }
                    worker?.terminate();
                    this._runtimeWorkers.delete(kind);
                });
                this._runtimeWorkers.set(kind, worker);
            } catch (error) {
                return this._runRuntimeFallback(kind, operation, payload);
            }
        }
        const requestId = ++this._runtimeWorkerSequence;
        return new Promise((resolve, reject) => {
            this._runtimeWorkerRequests.set(requestId, { kind, resolve, reject });
            try {
                worker.postMessage({ requestId, operation, payload });
            } catch (error) {
                this._runtimeWorkerRequests.delete(requestId);
                reject(error);
            }
        });
    },

    _runRuntimeFallback(kind, operation, payload) {
        if (kind === 'transcript') {
            const runtime = globalThis.TranscriptParserRuntime;
            if (!runtime) throw new Error('Transcript parser is unavailable');
            if (operation === 'parse-text') return runtime.parseText(payload.text);
            if (operation === 'parse-csv') return runtime.parseCsv(payload.csv);
            if (operation === 'parse-advising-items') {
                return runtime.parseAdvisingTranscriptItems(payload.pages, payload.options);
            }
        }
        if (kind === 'degree') {
            const runtime = globalThis.DegreePlannerRuntime;
            if (!runtime) throw new Error('Degree planner is unavailable');
            if (operation === 'plan-degree') {
                return runtime.planDegree(payload.major_map, payload.completed, payload.options);
            }
        }
        if (kind === 'offering') {
            const runtime = globalThis.OfferingAnalyzerRuntime;
            if (!runtime) throw new Error('Offering analysis is unavailable');
            if (operation === 'summary') {
                return runtime.getOfferingSummary(payload.history_data, payload.current_term);
            }
        }
        throw new Error(`Unsupported browser operation: ${kind}/${operation}`);
    },

    async parseTranscript(text) {
        if (!this.isStaticMode()) return this.post('/api/parse-transcript', { text });
        const codes = await this._runRuntimeWorker('transcript', 'parse-text', { text });
        return {
            courses: (codes || []).map(code => ({
                code,
                grade: null,
                credits: null,
                semester: null,
            })),
        };
    },

    async parseTranscriptCSV(csvText) {
        if (!this.isStaticMode()) return this.post('/api/parse-transcript', { csv: csvText });
        const courses = await this._runRuntimeWorker('transcript', 'parse-csv', { csv: csvText });
        return { courses: courses || [] };
    },

    async parseAdvisingTranscriptItems(pages, options = {}) {
        return this._runRuntimeWorker('transcript', 'parse-advising-items', { pages, options });
    },

    async parseTranscriptPDF(file, options = {}) {
        const reader = globalThis.AdvisingTranscriptPdf;
        if (!reader?.extractTextItems) {
            const error = new Error('The PDF transcript reader is unavailable');
            error.code = 'PDF_READER_UNAVAILABLE';
            throw error;
        }
        const extracted = await reader.extractTextItems(file, options);
        return this.parseAdvisingTranscriptItems(extracted.pages, {
            pageCount: extracted.pageCount,
            level: options.level,
        });
    },

    async getMajorMaps() {
        if (!this.isStaticMode()) {
            const response = await fetch('/api/major-maps');
            if (!response.ok) throw new Error(`Major-map lookup failed (${response.status})`);
            return response.json();
        }
        const artifact = await this._getDataStore().getArtifact('major-maps/index');
        return Array.isArray(artifact) ? artifact : artifact?.maps || [];
    },

    async getMajorMap(id) {
        if (!this.isStaticMode()) return this.post('/api/major-map', { id });
        const mapId = String(id || '').trim();
        if (!mapId) {
            const error = new Error('A major-map identifier is required');
            error.code = 'MAJOR_MAP_REQUIRED';
            throw error;
        }
        const store = this._getDataStore();
        const logicalName = `major-maps/${mapId}`;
        let indexEntry = null;
        try {
            const index = await store.getArtifact('major-maps/index');
            const maps = Array.isArray(index) ? index : index?.maps || [];
            indexEntry = maps.find(entry => String(entry?.id || '') === mapId) || null;
        } catch (error) {
            // Older releases may expose only logical major-map artifacts.
        }

        const descriptor = indexEntry?.artifact;
        if (!descriptor) return store.getArtifact(logicalName);
        if (typeof descriptor === 'string') return store.getArtifact(descriptor);
        const descriptorLogicalName = String(
            descriptor.logical_name || descriptor.logicalName || '',
        ).trim();
        if (descriptorLogicalName) return store.getArtifact(descriptorLogicalName);

        if (typeof descriptor !== 'object' || Array.isArray(descriptor)
            || !String(descriptor.url || '').trim()) {
            const error = new Error(`Major-map ${mapId} has an invalid artifact descriptor`);
            error.code = 'MAJOR_MAP_ARTIFACT_INVALID';
            throw error;
        }
        if (typeof store.getArtifactByDescriptor === 'function') {
            return store.getArtifactByDescriptor(logicalName, descriptor);
        }
        if (typeof store._loadArtifact !== 'function' || typeof store.getManifest !== 'function') {
            const error = new Error('Static data store cannot load indexed major-map artifacts');
            error.code = 'MAJOR_MAP_ARTIFACT_UNSUPPORTED';
            throw error;
        }

        const manifest = await store.getManifest({ forceRefresh: false });
        const memoryKey = `${manifest.release_id}:${logicalName}`;
        if (this._majorMapArtifacts.has(memoryKey)) {
            return this._majorMapArtifacts.get(memoryKey);
        }
        const inflightKey = `major-map:${memoryKey}`;
        if (this._inflight.has(inflightKey)) return this._inflight.get(inflightKey);
        const request = store._loadArtifact({
            logicalName,
            descriptor,
            manifest,
            memoryKey,
            forceRefresh: false,
        }).then(payload => {
            this._majorMapArtifacts.set(memoryKey, payload);
            return payload;
        });
        this._inflight.set(inflightKey, request);
        try {
            return await request;
        } finally {
            if (this._inflight.get(inflightKey) === request) {
                this._inflight.delete(inflightKey);
            }
        }
    },

    async getDegreePlan(params) {
        if (!this.isStaticMode()) return this.post('/api/degree-plan', params);
        const majorMap = params.major_map || await this.getMajorMap(params.map_id);
        const { map_id: ignoredMapId, major_map: ignoredMap, completed = [], ...options } = params;
        void ignoredMapId;
        void ignoredMap;
        return this._runRuntimeWorker('degree', 'plan-degree', {
            major_map: majorMap,
            completed,
            options,
        });
    },

    async getOfferingAnalysis(code, currentTerm) {
        if (!this.isStaticMode()) {
            return this.post('/api/offering-analysis', { code, current_term: currentTerm });
        }
        const history = await this._getStaticHistory(code);
        return this._runRuntimeWorker('offering', 'summary', {
            history_data: history,
            current_term: currentTerm,
        });
    },

    async getCourseGrades(code) {
        if (!this.isStaticMode()) return this.post('/api/course-grades', { code });
        const result = await this._getDataStore().getCourseGrades(code);
        if (result) return result;
        const error = new Error(`Course grade history is not in this data release: ${code}`);
        error.code = 'STATIC_GRADES_NOT_FOUND';
        throw error;
    },

    async getProfessorGrades(id) {
        if (!this.isStaticMode()) return this.post('/api/professor-grades', { id });
        const result = await this._getDataStore().getProfessorGrades(id);
        if (result) return result;
        const error = new Error(`Professor grade history is not in this data release: ${id}`);
        error.code = 'STATIC_PROFESSOR_NOT_FOUND';
        throw error;
    },

    async getFaculty(term, crns) {
        const options = arguments[2] || {};
        if (!this.isStaticMode()) return this.post('/api/faculty', { term, crns }, options);
        const unique = [...new Set((crns || []).map(String).filter(Boolean))].slice(0, 12);
        if (!unique.length) return { faculty: [] };
        const response = await this._getLiveClient().faculty(term, unique, options);
        return {
            faculty: Array.isArray(response?.faculty) ? response.faculty : [],
        };
    },

    async prefetchCourseDetails(sections, term, { signal = null, paceMs = 350 } = {}) {
        const crns = [...new Set((sections || []).map(section => String(section?.crn || '')))]
            .filter(Boolean);
        const waitForIdle = () => new Promise(resolve => {
            const waitUntilIdle = () => {
                if (typeof requestIdleCallback === 'function') {
                    requestIdleCallback(() => resolve(), { timeout: 1500 });
                } else {
                    resolve();
                }
            };
            setTimeout(waitUntilIdle, Math.max(0, paceMs));
        });
        for (const crn of crns) {
            if (signal?.aborted) break;
            await waitForIdle();
            if (signal?.aborted) break;
            try {
                await this.getDetails(crn, term);
            } catch (error) {
                // Prefetch is opportunistic. The foreground action will surface failures.
            }
        }
    },
};

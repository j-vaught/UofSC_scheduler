/* API wrapper for backend proxy */
const API = {
    _forceRefreshLive: false,
    _inflight: new Map(),
    _responseCache: new Map(),
    _responseCacheMaxEntries: 200,

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

    async post(path, body, { cacheTtl = 0 } = {}) {
        const key = this._cacheKey(path, body);
        const forceRefresh = this._forceRefreshLive;
        const requestKey = `${key}:refresh=${forceRefresh ? 1 : 0}`;
        if (!forceRefresh && cacheTtl > 0) {
            const cached = this._cached(key);
            if (cached !== null) return cached;
        }
        if (this._inflight.has(requestKey)) return this._inflight.get(requestKey);

        const headers = { 'Content-Type': 'application/json' };
        if (forceRefresh) headers['X-UofSC-Refresh-Live'] = '1';
        const request = (async () => {
            const resp = await fetch(path, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
            });
            const data = await resp.json();
            if (!resp.ok || (data && typeof data === 'object' && data.error)) {
                throw new Error(data?.error || `Request failed with status ${resp.status}`);
            }
            if (!forceRefresh && cacheTtl > 0) {
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

    async searchCourses(term, criteria) {
        return this.post('/api/search', {
            other: { srcdb: term },
            criteria,
        }, { cacheTtl: 5 * 60 * 1000 });
    },

    async getDetails(crn, term) {
        return this.post('/api/details', {
            group: `crn:${crn}`,
            srcdb: term,
        }, { cacheTtl: 5 * 60 * 1000 });
    },

    async bulletinSearch(subject, srcdb = '2026') {
        return this.post('/api/bulletin/search', {
            other: { srcdb },
            criteria: [{ field: 'subject', value: subject }],
        }, { cacheTtl: 24 * 60 * 60 * 1000 });
    },

    async bulletinDetails(key, srcdb = '2026') {
        return this.post('/api/bulletin/details', {
            group: `key:${key}`,
            srcdb,
        }, { cacheTtl: 24 * 60 * 60 * 1000 });
    },

    async getHistory(courseCode, onProgress = null) {
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

    async solve(courses, preferences, maxResults = 10) {
        return this.post('/api/solve', { courses, preferences, max_results: maxResults });
    },

    async parseTranscript(text) {
        return this.post('/api/parse-transcript', { text });
    },

    async parseTranscriptCSV(csvText) {
        return this.post('/api/parse-transcript', { csv: csvText });
    },

    async getMajorMaps() {
        const resp = await fetch('/api/major-maps');
        return resp.json();
    },

    async getMajorMap(id) {
        return this.post('/api/major-map', { id });
    },

    async getDegreePlan(params) {
        return this.post('/api/degree-plan', params);
    },

    async getOfferingAnalysis(code, currentTerm) {
        return this.post('/api/offering-analysis', { code, current_term: currentTerm });
    },

    async getCourseGrades(code) {
        return this.post('/api/course-grades', { code });
    },

    async getFaculty(term, crns) {
        return this.post('/api/faculty', { term, crns });
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

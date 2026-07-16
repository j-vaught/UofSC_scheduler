/* API wrapper for backend proxy */
const API = {
    _forceRefreshLive: false,

    shouldRefreshAfterReload() {
        if (typeof performance === 'undefined' || !performance.getEntriesByType) return false;
        return performance.getEntriesByType('navigation')[0]?.type === 'reload';
    },

    setForceRefreshLive(active) {
        this._forceRefreshLive = Boolean(active);
    },

    async post(path, body) {
        const headers = { 'Content-Type': 'application/json' };
        if (this._forceRefreshLive) headers['X-UofSC-Refresh-Live'] = '1';
        const resp = await fetch(path, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });
        const data = await resp.json();
        if (!resp.ok || (data && typeof data === 'object' && data.error)) {
            throw new Error(data?.error || `Request failed with status ${resp.status}`);
        }
        return data;
    },

    async searchCourses(term, criteria) {
        return this.post('/api/search', {
            other: { srcdb: term },
            criteria,
        });
    },

    async getDetails(crn, term) {
        return this.post('/api/details', {
            group: `crn:${crn}`,
            srcdb: term,
        });
    },

    async bulletinSearch(subject, srcdb = '2026') {
        return this.post('/api/bulletin/search', {
            other: { srcdb },
            criteria: [{ field: 'subject', value: subject }],
        });
    },

    async bulletinDetails(key, srcdb = '2026') {
        return this.post('/api/bulletin/details', {
            group: `key:${key}`,
            srcdb,
        });
    },

    async getHistory(courseCode) {
        return this.post('/api/history', { code: courseCode });
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
};

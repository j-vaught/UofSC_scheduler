/* API wrapper for backend proxy */
const API = {
    async post(path, body) {
        const resp = await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return resp.json();
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
};

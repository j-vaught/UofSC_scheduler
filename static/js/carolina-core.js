/* Carolina Core catalog and planner-picker helpers. */
(function exposeCarolinaCore(global) {
    'use strict';

    const CORE_LABELS = {
        AIU: 'Aesthetic and Interpretive Understanding',
        ARP: 'Analytical Reasoning and Problem Solving',
        CMS: 'Spoken Communication',
        CMW: 'Written Communication',
        GFL: 'Foreign Language',
        GHS: 'Historical Thinking',
        GSS: 'Social Sciences',
        INF: 'Information Literacy',
        SCI: 'Scientific Literacy',
        VSR: 'Values, Ethics, and Social Responsibility',
    };

    const CarolinaCore = {
        catalogUrl: '/static/data/carolina_core_courses.json',
        _catalogPromise: null,

        labels: CORE_LABELS,

        async loadCatalog() {
            if (!this._catalogPromise) {
                this._catalogPromise = fetch(this.catalogUrl, {
                    cache: 'force-cache',
                    headers: { Accept: 'application/json' },
                }).then(response => {
                    if (!response.ok) throw new Error(`Carolina Core catalog failed (${response.status})`);
                    return response.json();
                }).then(payload => {
                    if (!Array.isArray(payload?.courses)) {
                        throw new Error('Carolina Core catalog is invalid');
                    }
                    return payload;
                }).catch(error => {
                    this._catalogPromise = null;
                    throw error;
                });
            }
            return this._catalogPromise;
        },

        filterCourses(courses, { outcome = '', query = '' } = {}) {
            const selected = String(outcome || '').trim().toUpperCase();
            const terms = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
            return (courses || []).filter(course => {
                if (selected && !(course.outcomes || []).includes(selected)) return false;
                if (!terms.length) return true;
                const haystack = [
                    course.code,
                    course.title,
                    course.college,
                    ...(course.outcomes || []),
                ].join(' ').toLowerCase();
                return terms.every(term => haystack.includes(term));
            });
        },

        label(code) {
            return CORE_LABELS[String(code || '').toUpperCase()] || 'Carolina Core';
        },
    };

    global.CarolinaCore = CarolinaCore;
    if (typeof module !== 'undefined' && module.exports) module.exports = CarolinaCore;
}(typeof globalThis !== 'undefined' ? globalThis : this));

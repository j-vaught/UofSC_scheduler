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

    /*
     * The exact upstream search value for each outcome.
     *
     * These are the strings classes.sc.edu matches on when course_attr is used
     * as a search criterion, and they are copied from live section data rather
     * than from the search page's own dropdown. That distinction is not
     * pedantry: the dropdown reads "GFL: Global Language" and the value that
     * actually matches is "GFL: Global/Language (3GFL)". Querying the dropdown
     * wording returns zero results and looks exactly like an outcome no section
     * carries.
     *
     * Both ways of getting this wrong are silent, and they fail in opposite
     * directions. An unrecognised criteria *field* makes upstream ignore the
     * criterion and answer with the entire term; an unrecognised *value* for a
     * recognised field answers with nothing. Neither is an error.
     *
     * tests/test_course_attr_vocabulary.js checks every string here against
     * live upstream and fails if any returns zero, which is the only way a
     * reworded label upstream becomes visible rather than becoming an empty
     * filter nobody notices.
     */
    const CORE_SEARCH_VALUES = Object.freeze({
        AIU: 'AIU: Aesthetic/Interpretive (3AIU)',
        ARP: 'ARP: Analytical Reasoning (3ARP)',
        CMS: 'CMS: Communication/Speech (3CMS)',
        CMW: 'CMW: Communication/Writing (3CMW)',
        GFL: 'GFL: Global/Language (3GFL)',
        GHS: 'GHS: Global/History (3GHS)',
        GSS: 'GSS: Global/Social Science (3GSS)',
        INF: 'INF: Information Literacy (3INF)',
        SCI: 'SCI: Scientific Literacy (3SCI)',
        VSR: 'VSR: Values/Ethics (3VSR)',
    });

    const CarolinaCore = {
        catalogUrl: '/static/data/carolina_core_courses.json',
        _catalogPromise: null,

        labels: CORE_LABELS,
        searchValues: CORE_SEARCH_VALUES,

        /* The upstream search value for an outcome, or '' if it is not one. */
        searchValue(outcome) {
            return CORE_SEARCH_VALUES[String(outcome || '').trim().toUpperCase()] || '';
        },

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

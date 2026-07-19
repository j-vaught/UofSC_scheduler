/*
 * Composition point for the fenced prerequisites feature.
 *
 * The logic moved to static/js/features/prereqs/index.js. This file is the only
 * place that knows prerequisite lookup is wired to API, State and Search.
 *
 * showCourseDetail is navigation, not data: it hands the student to the course
 * detail view. As a seam it removes the last edge from this module into Search,
 * which is the pair being cut last.
 */
const Prereqs = (() => {
    const factory = (typeof Features !== 'undefined' && Features.prereqs)
        || (typeof require === 'function' ? require('./features/prereqs/index.js') : null);
    if (!factory) throw new Error('prereqs feature is not loaded');

    return factory.createPrereqsFeature({
        bulletinSearch: (subject, catalogYear) => API.bulletinSearch(subject, catalogYear),
        bulletinDetails: (key, catalogYear) => API.bulletinDetails(key, catalogYear),
        searchCourses: (term, criteria) => API.searchCourses(term, criteria),

        completedCourses: () => State.completedCourses,
        currentTerm: () => State.term,

        showCourseDetail: group => Search.showCourseDetail(group),
    });
})();

if (typeof module === 'object' && module.exports) module.exports = Prereqs;
if (typeof globalThis === 'object') globalThis.Prereqs = Prereqs;

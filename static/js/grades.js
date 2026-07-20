/*
 * Composition point for the fenced grades feature.
 *
 * The logic moved to static/js/features/grades/index.js. This file is the only
 * place that knows grade history is wired to API, Search, Scheduler and the
 * error taxonomy, and it is deliberately the boring half.
 *
 * viewContext() is the interesting one. Grades used to read four of Search's
 * private fields directly -- _detailToken, _detailGroup, _detailTerm,
 * _browseState -- to know what is on screen and whether an in-flight result is
 * still about it. That is the tightest coupling in the tree, and it pointed at
 * the module that gets untangled last. Assembling the shape here means Search
 * can restructure its internals without silently breaking grade history, and
 * that only this function has to change when it does.
 */
const Grades = (() => {
    const factory = (typeof Features !== 'undefined' && Features.grades)
        || (typeof require === 'function' ? require('./features/grades/index.js') : null);
    if (!factory) throw new Error('grades feature is not loaded');

    const EMPTY_GROUP = { sections: [] };

    /*
     * What the course detail view is currently showing.
     *
     * Every field is defaulted, because this is read during async completions
     * that may land after the student has navigated away -- the case the token
     * exists to detect. Returning a well-formed context with a stale token is
     * what lets the feature notice; throwing or returning null would not.
     */
    function viewContext() {
        const search = typeof Search !== 'undefined' ? Search : null;
        return {
            token: search?._detailToken,
            mode: search?._browseState,
            group: search?._detailGroup || EMPTY_GROUP,
            term: search?._detailTerm || (typeof State !== 'undefined' ? State.term : '') || '',
            section: search?.currentDetailSection?.() || null,
            faculty: search?._detailFaculty || [],
        };
    }

    return factory.createGradesFeature({
        getCourseGrades: code => API.getCourseGrades(code),
        getProfessorGrades: id => API.getProfessorGrades(id),
        getFaculty: (term, crns) => API.getFaculty(term, crns),

        viewContext,

        instructorCrns: group => (
            typeof Scheduler !== 'undefined' ? Scheduler.currentInstructorCrns(group) : []
        ),

        /*
         * Optional: without the scheduler the feature shows historical
         * instructors instead of marking who is teaching now. A real
         * degradation, but a coherent one, and better than an empty table.
         */
        /*
         * A getter, because the ternary below has to run when the feature asks
         * for the collaborator rather than when this file is parsed.
         *
         * This was written as a plain property and was therefore always
         * undefined: index.html loads grades.js before scheduler.js, so
         * `typeof Scheduler` was 'undefined' at construction and the binding
         * froze that way forever. The feature then took its historical-only
         * fallback on every render -- for every course, permanently -- while
         * looking exactly like a course whose instructor has no grade record.
         *
         * WGST 432 is the case that exposed it: the section lists "Paczynski",
         * the grade data lists "Paczynski, James", and the scheduler's matcher
         * resolves that surname pair correctly. The card still read "No matched
         * grade history for this course" because the matcher was never reached.
         */
        get instructorSummaries() {
            return (typeof Scheduler !== 'undefined' && Scheduler.currentInstructorSummaries)
                ? (group, data, faculty) => Scheduler.currentInstructorSummaries(group, data, faculty)
                : undefined;
        },

        // Absence and failure used to render identically, so a relay 502 told
        // the student their course had no grade history and they stopped
        // looking. The taxonomy is what distinguishes them.
        toUserMessage: error => (
            typeof AppErrors !== 'undefined'
                ? AppErrors.toUserMessage(error)
                : 'Something went wrong loading grade history. Try again.'
        ),
    });
})();

if (typeof module === 'object' && module.exports) module.exports = Grades;
if (typeof globalThis === 'object') globalThis.Grades = Grades;

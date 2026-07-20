/*
 * Composition point for the fenced search feature.
 *
 * The logic moved to static/js/features/search/index.js. This file is the only
 * place that knows which concrete collaborators it runs against.
 *
 * The scheduler collaborator closes the cycle: four methods -- addCourseGroup,
 * registrationRestrictionText, registrationRestrictionNeedsAttention,
 * parseCreditHours. Neither module names the other now.
 *
 * Grade history reads this module's view state through the viewContext() shape
 * assembled in grades.js, which is why the private detail fields stay private
 * here and nothing outside reaches them directly.
 *
 * Collaborators are getters, not captured values, and that is load-bearing
 * rather than stylistic. These are classic scripts, and `const Foo = ...` at
 * the top level of one creates a global lexical binding that does not exist
 * until that script has run. Resolving eagerly here would capture whatever the
 * name meant at this moment in the markup.
 *
 * That is not hypothetical. Reading `History` eagerly resolved it to the DOM's
 * built-in History constructor, because history.js had not run yet -- a
 * function, not the module, and not undefined either, so an existence check
 * would have said everything was fine. The original code only ever touched
 * these inside methods, long after every script had run, and a getter is what
 * reproduces that exactly.
 */
const Search = (() => {
    const factory = (typeof Features !== 'undefined' && Features.search)
        || (typeof require === 'function' ? require('./features/search/index.js') : null);
    if (!factory) throw new Error('search feature is not loaded');

    return factory.createSearchFeature({
        get state() { return typeof State !== 'undefined' ? State : undefined; },
        get api() { return typeof API !== 'undefined' ? API : undefined; },
        // The Carolina Core catalogue shard, shared with the degree planner's
        // Core picker. The search filter used to scrape a bulletin field that
        // does not exist, so it matched nothing for every outcome.
        get carolinaCore() { return typeof CarolinaCore !== 'undefined' ? CarolinaCore : undefined; },
        get grades() { return typeof Grades !== 'undefined' ? Grades : undefined; },
        /*
         * `History` is also a DOM interface, so this name can resolve to the
         * built-in constructor rather than the application module -- and a
         * plain existence check would accept it, because it is very much
         * defined. The module is an object; the built-in is a function.
         */
        get history() { return typeof History === 'object' ? History : undefined; },
        get prereqs() { return typeof Prereqs !== 'undefined' ? Prereqs : undefined; },
        get scheduler() { return typeof Scheduler !== 'undefined' ? Scheduler : undefined; },
        get tabs() { return typeof Tabs !== 'undefined' ? Tabs : undefined; },
        get walkingMap() { return typeof WalkingMap !== 'undefined' ? WalkingMap : undefined; },
        // The shared course-code normaliser. normalizeCourseCode delegates to its
        // parse() so a 2-letter subject canonicalises instead of being rejected.
        get courseCode() { return typeof CourseCode !== 'undefined' ? CourseCode : undefined; },
    });
})();

if (typeof module === 'object' && module.exports) module.exports = Search;
if (typeof globalThis === 'object') globalThis.Search = Search;

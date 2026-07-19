/*
 * Composition point for the fenced scheduler feature.
 *
 * The logic moved to static/js/features/scheduler/index.js. This file is the only
 * place that knows which concrete collaborators it runs against.
 *
 * The search collaborator is one half of the cycle the plan called
 * irreducible. Measured, it is three methods wide -- fetchBulletinDetailsForCourse,
 * searchLiveCourses, openCourseFromExternal -- and injecting it here means this
 * module no longer names Search at all.
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
const Scheduler = (() => {
    const factory = (typeof Features !== 'undefined' && Features.scheduler)
        || (typeof require === 'function' ? require('./features/scheduler/index.js') : null);
    if (!factory) throw new Error('scheduler feature is not loaded');

    return factory.createSchedulerFeature({
        get state() { return typeof State !== 'undefined' ? State : undefined; },
        get api() { return typeof API !== 'undefined' ? API : undefined; },
        get calendar() { return typeof Calendar !== 'undefined' ? Calendar : undefined; },
        get grades() { return typeof Grades !== 'undefined' ? Grades : undefined; },
        get prereqs() { return typeof Prereqs !== 'undefined' ? Prereqs : undefined; },
        get search() { return typeof Search !== 'undefined' ? Search : undefined; },
        get tabs() { return typeof Tabs !== 'undefined' ? Tabs : undefined; },
        get walkingMap() { return typeof WalkingMap !== 'undefined' ? WalkingMap : undefined; },
    });
})();

if (typeof module === 'object' && module.exports) module.exports = Scheduler;
if (typeof globalThis === 'object') globalThis.Scheduler = Scheduler;

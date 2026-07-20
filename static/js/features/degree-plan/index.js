/*
 * The degree plan tab, fenced: the multi-semester course roadmap.
 *
 * The sixth extraction under phase 7a and the widest so far -- twenty-four
 * dependencies across state, the degree API, major-map presentation, and
 * navigation into two other tabs. The count is what it is because this tab is
 * where everything else meets: it reads the profile and the transcript, calls
 * the planner, and sends the student to search or to a course detail.
 *
 * The edges into Search and Scheduler are the interesting ones, and they are
 * why this could be fenced before those modules are. Neither is a data
 * dependency; both are "take the student somewhere" -- open this course, search
 * for this title. As callbacks they cost nothing here and remove inbound edges
 * from the cycle that has to be untangled last.
 *
 * One more existence-guarded ternary came out, making at least one in every
 * extraction so far. This one guarded prerequisite enrichment, so inside a
 * fence the plan would have been built from the unenriched major map: a
 * different plan, quietly, with nothing to indicate it.
 *
 * Note that enrichment is itself the subject of an open problem in TODO.md --
 * it injects bulletin prerequisites naming courses outside the degree, which
 * makes some courses unplaceable. Fencing does not change that behaviour, and
 * deliberately so, but it does make the dependency visible and swappable, which
 * is what that investigation will need.
 *
 * ScheduleSidebar stays in the composition file. It shared degree-plan.js
 * without sharing anything else, and it belongs with the schedule tab, which
 * the plan fences later. Moving it now would be a second extraction hidden
 * inside this one.
 *
 * The DOM stays ambient, as in the other view features.
 *
 * The body is the previous implementation verbatim apart from those seams.
 */
(function initDegreePlanFeature(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root.Features) root.Features = {};
    root.Features.degreePlan = api;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';

    /*
     * The DOM contract for a rendered course card and its semester drop zone,
     * shared by every part that touches one: render.js writes the markup,
     * coursework.js binds click handlers onto it, moves.js binds drag-and-drop
     * onto it. These class names and dataset keys used to be separate string
     * literals in each of those three files, so a typo in one did not error --
     * a selector or a dataset read that names a class the markup no longer has
     * just silently matches nothing, which is exactly the "one typo, one dead
     * binding" failure mode a fence is supposed to make loud.
     *
     * It lives here rather than in one of the part files because the parts are
     * separate factory functions (see split_feature.py's cut-at-member-
     * boundaries rule): a module-scope const declared inside one part's
     * factory is not visible inside another's. The object every part gets
     * merged onto by Object.assign below is visible to all of them, so the
     * constant rides on that instead and each part reaches it as
     * `this.CARD_DOM`.
     */
    const CARD_DOM = Object.freeze({
        CARD_CLASS: 'course-card',
        COMPLETED_CARD_CLASS: 'completed-card',
        ELECTIVE_SLOT_CLASS: 'elective-slot',
        REMOVE_BADGE_CLASS: 'card-remove-badge',
        INFO_BUTTON_CLASS: 'course-card-info',
        COURSES_CONTAINER_CLASS: 'semester-courses',
        DELETE_SEM_BUTTON_CLASS: 'sem-delete-btn',
        // Dataset keys: the HTML attribute is `data-${KEY}`, and the JS side
        // reads it as `el.dataset[KEY]` (bracket form, since the key is a
        // variable) rather than the usual `el.dataset.code` dot form.
        CODE_ATTR: 'code',
        SEMESTER_ATTR: 'semester',
        SECTION_ATTR: 'section',
        TERM_ATTR: 'term',
        // data-section values
        SECTION_PLANNED: 'planned',
        SECTION_COMPLETED: 'completed',
    });

    function createDegreePlanFeature(deps) {
        for (const name of ['getDegreePlan', 'bulletinSearch', 'getOfferingAnalysis',
            'plan', 'profile', 'completedCourses', 'completedDetails',
            'selectedSections', 'selectedCourses', 'sectionLocks', 'currentTerm',
            'setSectionLock', 'removeCourse', 'emitPlanUpdated',
            'findMajorMap', 'catalogYearLabel', 'sourceUrl', 'sourceLabel',
            'onCourseworkChanged', 'showCourse', 'searchFor',
            'onProfileChange', 'onTranscriptChange', 'onPlanChange']) {
            if (typeof deps?.[name] !== 'function') {
                throw new TypeError(`degree plan feature needs a ${name}() dependency`);
            }
        }
        // Optional on purpose: a deployment without the prerequisite layer
        // should still plan, from the unenriched map.
        if (deps.enrichMajorMap !== undefined && typeof deps.enrichMajorMap !== 'function') {
            throw new TypeError('degree plan feature needs enrichMajorMap() to be a function when supplied');
        }

        const feature = {        CARD_DOM,

        init() {
            this.bindGenerateButton();
            this.bindDragDrop();

            deps.onProfileChange(() => this.updateSidebar());
            deps.onTranscriptChange(() => {
                this.buildCompletedSemesters();
                this.updateSidebar();
                this.render();
            });
            deps.onPlanChange(() => {
                this.buildCompletedSemesters();
                this.render();
            });

            if (deps.plan().semesters.length > 0) {
                this.render();
            }
            this.updateSidebar();
        },

        };

        /*
         * The methods live in part files, merged onto the object above.
         *
         * Merging rather than delegating keeps `this` working: every method
         * still reaches every other one and the shared state, so splitting the
         * file changed no call site. Cuts are at member boundaries only, so the
         * parts concatenate back into the original body exactly.
         */
        const createPlanPart = (typeof DegreePlanParts !== 'undefined' && DegreePlanParts.createPlanPart)
            || (typeof require === 'function' ? require('./plan.js').createPlanPart : null);
        const createRenderPart = (typeof DegreePlanParts !== 'undefined' && DegreePlanParts.createRenderPart)
            || (typeof require === 'function' ? require('./render.js').createRenderPart : null);
        const createCourseworkPart = (typeof DegreePlanParts !== 'undefined' && DegreePlanParts.createCourseworkPart)
            || (typeof require === 'function' ? require('./coursework.js').createCourseworkPart : null);
        const createMovesPart = (typeof DegreePlanParts !== 'undefined' && DegreePlanParts.createMovesPart)
            || (typeof require === 'function' ? require('./moves.js').createMovesPart : null);

        if (!createPlanPart || !createRenderPart || !createCourseworkPart || !createMovesPart) {
            throw new Error('degree-plan feature parts are not loaded');
        }

        Object.assign(
            feature,
            createPlanPart(deps),
            createRenderPart(deps),
            createCourseworkPart(deps),
            createMovesPart(deps),
        );


        return feature;
    }

    return { createDegreePlanFeature };
}));


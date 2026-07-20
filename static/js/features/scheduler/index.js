/*
 * The scheduler, fenced: solver runs, section selection, and course quick view.
 *
 * The eighth extraction under phase 7a and the first half of the pair the plan
 * called an irreducible cycle. It is a cycle, but a narrow one: measured, this
 * module reaches Search through exactly three methods and Search reaches back
 * through four. Seven edges across 6,300 lines. The plan predicted the facade
 * rule would not be optional here; the measurement says otherwise, and the same
 * lesson has now appeared twice -- coupling is narrower than size suggests.
 *
 * A deliberately coarser seam than the other features.
 *
 * The earlier extractions named every dependency individually -- getDetails,
 * currentTerm, onStateChange. That works when a module needs five things. This
 * one needs roughly thirty-five, and flattening them would mean a mechanical
 * edit across thousands of lines that has to get the property-versus-method
 * distinction right every single time. That is precisely the kind of edit that
 * introduces a bug which reads as a refactor, and this session has already
 * shipped one of those.
 *
 * So collaborators arrive as objects: deps.state, deps.api, deps.walkingMap.
 * The body change is then a pure prefix rename, verifiable by asserting that no
 * bare global identifier survives. The architectural property is unchanged --
 * nothing ambient is reachable, every collaborator is chosen by the composition
 * point, and a test can pass fakes -- but the seam is at the module boundary
 * rather than the method. Narrowing it later is a local change; getting the
 * extraction wrong now is not.
 *
 * The existence guards are the reason this needed doing. There were thirty-one
 * across this pair, the largest concentration in the repository, every one of
 * the form `typeof X !== 'undefined'`. Inside a fenced module that global is
 * always undefined, so each guard would have silently taken its negative branch
 * and the feature would have done nothing while appearing to work.
 *
 * They are checks on injected collaborators now, which is what they were always
 * pretending to be. Where a call site was never guarded it still is not: an
 * absent collaborator throws there exactly as it did before, because changing
 * that would be a behaviour change hiding inside an extraction.
 */
(function initSchedulerFeature(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root.Features) root.Features = {};
    root.Features.scheduler = api;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';

    function createSchedulerFeature(deps) {
        /*
         * No collaborator inspection at construction, deliberately.
         *
         * The composition point supplies these as getters, because classic
         * scripts declare their globals with `const` and that binding does not
         * exist until the declaring script has run. Touching a collaborator
         * here would force it to resolve at exactly the moment it is least
         * likely to be ready -- and would resolve `History` to the DOM's
         * built-in constructor rather than the module, which is a wrong value
         * that no existence check would reject.
         *
         * The original referenced these lazily inside its methods, long after
         * every script had run. Reproducing that is the point.
         */

        const feature = {
        _lastSearchGroups: [],
        _searchPageSize: 30,
        _searchVisibleCount: 30,
        _courseSearchRequestId: 0,
        _preferredWorkspaceHeight: 620,
        _quickViewRequestId: 0,
        _locationPrefetchGeneration: 0,
        _locationPrefetchTimer: null,
        _locationPrefetchController: null,

        };

        /*
         * The methods live in part files, merged onto the object above.
         *
         * Merging rather than delegating keeps `this` working: every method
         * still reaches every other one and the shared state, so splitting the
         * file changed no call site. Cuts are at member boundaries only, so the
         * parts concatenate back into the original body exactly.
         */
        const createRegistrationPart = (typeof SchedulerParts !== 'undefined' && SchedulerParts.createRegistrationPart)
            || (typeof require === 'function' ? require('./registration.js').createRegistrationPart : null);
        const createPreferencesPart = (typeof SchedulerParts !== 'undefined' && SchedulerParts.createPreferencesPart)
            || (typeof require === 'function' ? require('./preferences.js').createPreferencesPart : null);
        const createCoursesPart = (typeof SchedulerParts !== 'undefined' && SchedulerParts.createCoursesPart)
            || (typeof require === 'function' ? require('./courses.js').createCoursesPart : null);
        const createLayoutPart = (typeof SchedulerParts !== 'undefined' && SchedulerParts.createLayoutPart)
            || (typeof require === 'function' ? require('./layout.js').createLayoutPart : null);
        const createSolvePart = (typeof SchedulerParts !== 'undefined' && SchedulerParts.createSolvePart)
            || (typeof require === 'function' ? require('./solve.js').createSolvePart : null);

        if (!createRegistrationPart || !createPreferencesPart || !createCoursesPart || !createLayoutPart || !createSolvePart) {
            throw new Error('scheduler feature parts are not loaded');
        }

        Object.assign(
            feature,
            createRegistrationPart(deps),
            createPreferencesPart(deps),
            createCoursesPart(deps),
            createLayoutPart(deps),
            createSolvePart(deps),
        );


        return feature;
    }

    return { createSchedulerFeature };
}));


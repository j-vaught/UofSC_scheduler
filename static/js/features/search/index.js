/*
 * Course search, fenced: live search, the bulletin catalog, and course detail.
 *
 * The ninth extraction under phase 7a and the largest module in the repository
 * at 4,079 lines. It closes the pair the plan called an irreducible cycle. The
 * cycle is real but narrow -- four edges out to the scheduler, three back --
 * and both directions are now injected, so neither module names the other.
 *
 * Grade history depends on this module's view state through the viewContext()
 * shape assembled in grades.js. That indirection was built for this moment: the
 * private fields it used to read are still here, still private, and now nothing
 * outside reaches them.
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
(function initSearchFeature(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root.Features) root.Features = {};
    root.Features.search = api;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';

    function createSearchFeature(deps) {
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
        _modelDataVersion: '2026-07-16',
        _prereqCache: {},
        _searchId: 0,
        _subjects: [],
        _subjectsPromise: null,
        _extractor: null,       // Transformers.js pipeline (lazy-loaded)
        _extractorLoading: null,
        _phraseData: null,       // pre-computed phrase embeddings
        _phraseVecs: null,       // normalized float32 phrase vectors
        _pcaParams: null,        // PCA mean + components
        _courseEmbeddings: null,  // pre-computed course embeddings (title+desc)
        _courseVecs: null,        // normalized float32 course vectors
        _bulletinCourseCache: {},
        _bulletinDetailsCache: {},
        _carolinaCoreCache: {},
        _sectionDetailCache: {},
        _resultSummaryCache: {},
        _resultSummaryObserver: null,
        _smartModelPromise: null,
        _browseState: 'empty',
        _detailGroup: null,
        _detailSectionCrn: '',
        _detailTab: 'overview',
        _detailLoads: {},
        _lastDetailTrigger: null,
        _facultyCache: {},
        _directSearchOnce: false,
        _topicSearchMode: false,
        _semanticFallbackOnce: false,
        _semanticFallbackNotice: '',
        _mainSearchQuery: '',
        _relatedSearchOrigin: '',
        _restoringHistory: false,
        _restoreId: 0,
        _detailMap: null,
        _detailLocationMarkers: [],
        _filterPreviousFocus: null,
        _detailTimeLocationPreferenceKey: 'uofsc-course-time-location-expanded-v1',
        // Intentionally memory-only so a browser reload forces fresh search data.
        _searchViewCache: new Map(),
        _searchCacheTtlMs: 60 * 60 * 1000,
        _searchCacheMaxEntries: 30,
        };

        /*
         * The methods live in five part files, merged onto the object above.
         *
         * This module was 4,248 lines, the largest in the repository. Fencing
         * it made it replaceable from outside without making it navigable from
         * inside. The parts are cut at member boundaries only, so concatenating
         * them reproduces the original object body exactly; that constraint is
         * why the split cannot have changed behaviour.
         *
         * Merging rather than delegating is what keeps `this` working. Every
         * method still reaches every other one and the shared state above, so
         * no call site changed.
         */
        const createQueryPart = (typeof SearchParts !== 'undefined' && SearchParts.createQueryPart)
            || (typeof require === 'function' ? require('./query.js').createQueryPart : null);
        const createShellPart = (typeof SearchParts !== 'undefined' && SearchParts.createShellPart)
            || (typeof require === 'function' ? require('./shell.js').createShellPart : null);
        const createFiltersPart = (typeof SearchParts !== 'undefined' && SearchParts.createFiltersPart)
            || (typeof require === 'function' ? require('./filters.js').createFiltersPart : null);
        const createDetailPart = (typeof SearchParts !== 'undefined' && SearchParts.createDetailPart)
            || (typeof require === 'function' ? require('./detail.js').createDetailPart : null);
        const createResultsPart = (typeof SearchParts !== 'undefined' && SearchParts.createResultsPart)
            || (typeof require === 'function' ? require('./results.js').createResultsPart : null);

        if (!createQueryPart || !createShellPart || !createFiltersPart || !createDetailPart || !createResultsPart) {
            throw new Error('search feature parts are not loaded');
        }

        Object.assign(
            feature,
            createQueryPart(deps),
            createShellPart(deps),
            createFiltersPart(deps),
            createDetailPart(deps),
            createResultsPart(deps),
        );


        return feature;
    }

    return { createSearchFeature };
}));


'use strict';

/*
 * The seams pulled out of doSearch and course detail.
 *
 * doSearch was 568 lines and built its filter criteria object twice, parsed the
 * query in a 140-line fall-through chain, and compared a raw _searchId in a
 * couple of dozen places. This suite pins the extracted seams -- classifyQuery,
 * buildFilterCriteria, _runCriteriaSearch, isStale, detailRouteState,
 * browseState and the COURSE_DETAIL_TABS registry -- so a later change cannot
 * quietly reintroduce the duplication or the drift.
 *
 * Every source-text assertion is anchored before it slices, because an
 * unanchored one silently checks an empty string once the code moves.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadObject, moduleSource } = require('./support/scheduler-harness.js');

const CourseCode = require('../static/js/course-code.js');

// An inactive scope, the shape classifyQuery reads (active + subjects only).
const NO_SCOPE = { active: false, subjects: [], matches: () => true };

// Feature methods build their return values in the vm realm, so a structural
// object comparison has to cross realms first; JSON round-tripping is how the
// rest of the suite normalises that.
const plain = value => JSON.parse(JSON.stringify(value));

function bareSearch(overrides = {}) {
    // A feature with just enough context for the DOM-free seams: getElementById
    // returns null so activeSearchInput() hands back null and the courtesy
    // value-write is skipped, exactly as it is in a headless run.
    const search = loadObject('static/js/search.js', 'Search', {
        document: { getElementById: () => null },
        ...overrides,
    });
    search._subjects = ['CSCE', 'MATH', 'ENGL'];
    return search;
}

/* ---- Job 1: classifyQuery ------------------------------------------------ */

test('classifyQuery places a bare subject as a subject criterion', () => {
    const { criteria, resultFilter, subject } = bareSearch()
        .classifyQuery('CSCE', { treatAsTopic: false, courseScope: NO_SCOPE });
    assert.deepEqual(plain(criteria), [{ field: 'subject', value: 'CSCE' }]);
    assert.equal(resultFilter, null);
    assert.equal(subject, 'CSCE');
});

test('classifyQuery places a full course code as an alias criterion', () => {
    const { criteria, subject } = bareSearch()
        .classifyQuery('csce 145', { treatAsTopic: false, courseScope: NO_SCOPE });
    assert.deepEqual(plain(criteria), [{ field: 'alias', value: 'CSCE 145' }]);
    assert.equal(subject, 'CSCE');
});

test('classifyQuery places a 5-digit number as a CRN criterion', () => {
    const { criteria } = bareSearch()
        .classifyQuery('12345', { treatAsTopic: false, courseScope: NO_SCOPE });
    assert.deepEqual(plain(criteria), [{ field: 'crn', value: '12345' }]);
});

test('classifyQuery returns a subject criterion plus a working range filter for 500+', () => {
    const { criteria, resultFilter, subject } = bareSearch()
        .classifyQuery('CSCE 500+', { treatAsTopic: false, courseScope: NO_SCOPE });
    assert.deepEqual(plain(criteria), [{ field: 'subject', value: 'CSCE' }]);
    assert.equal(subject, 'CSCE');
    assert.equal(typeof resultFilter, 'function');
    assert.equal(resultFilter('CSCE 550'), true);
    assert.equal(resultFilter('CSCE 101'), false);
});

test('classifyQuery throws the CRN guidance for a 4-digit number', () => {
    assert.throws(
        () => bareSearch().classifyQuery('1234', { treatAsTopic: false, courseScope: NO_SCOPE }),
        /4-digit numbers are not valid.*5-digit CRN/,
    );
});

test('classifyQuery throws the minimum-length hint for a short keyword', () => {
    // Two letters, so it is neither a 3-4 letter subject code nor long enough to
    // be a keyword: the case that must reject rather than search for nothing.
    assert.throws(
        () => bareSearch().classifyQuery('hi', { treatAsTopic: false, courseScope: NO_SCOPE }),
        /Keywords must be at least 5 characters/,
    );
});

test('classifyQuery places a plain sentence as a keyword criterion', () => {
    const { criteria, resultFilter, subject } = bareSearch()
        .classifyQuery('machine learning models', { treatAsTopic: false, courseScope: NO_SCOPE });
    assert.deepEqual(plain(criteria), [{ field: 'keyword', value: 'machine learning models' }]);
    assert.equal(resultFilter, null);
    assert.equal(subject, '');
});

test('classifyQuery treats a short subject as a keyword once treatAsTopic is set', () => {
    // The structured cases are all guarded by !treatAsTopic, so a topic search of
    // a subject-shaped word (>= 5 chars) falls through to keyword rather than
    // being read as a subject code.
    const { criteria } = bareSearch()
        .classifyQuery('robots', { treatAsTopic: true, courseScope: NO_SCOPE });
    assert.deepEqual(plain(criteria), [{ field: 'keyword', value: 'robots' }]);
});

/* ---- Job 3: buildFilterCriteria ------------------------------------------ */

// The eleven filter controls, wired so a test can set one and read the rest as
// their empty defaults.
function filterDocument(overrides = {}) {
    const values = {
        'filter-open': { checked: false },
        'filter-method': { value: '' },
        'filter-carolina-core': { value: '' },
        'filter-part-of-term': { value: '' },
        'filter-course-attribute': { value: '' },
        'filter-honors': { value: '' },
        'filter-meeting-pattern': { value: '' },
        'filter-size-mode': { value: '' },
        'filter-size-value': { value: '' },
        'filter-avail-mode': { value: '' },
        'filter-avail-value': { value: '' },
        ...overrides,
    };
    return { getElementById: id => values[id] || null };
}

test('the section-filter criteria object is assembled in exactly one place', () => {
    const source = moduleSource('search');
    // Anchor: without the builder, "appears once" would be satisfied by zero.
    assert.match(source, /buildFilterCriteria\(\)\s*\{/, 'buildFilterCriteria is gone; the object has no single home');
    // availValue: is the builder's last key and appears nowhere else; more than
    // one means the object is built in a second place a filter can skip.
    const literals = source.match(/availValue:/g) || [];
    assert.equal(literals.length, 1, `the filter-criteria object is built ${literals.length} times, not once`);
    // And the old duplicated shorthand literal must not come back.
    assert.doesNotMatch(
        source,
        /\{\s*openOnly,\s*instructionalMethod,/,
        'a shorthand filter literal is back; build it through buildFilterCriteria instead',
    );
});

test('buildFilterCriteria reads every filter control into the applySectionFilters shape', () => {
    const search = loadObject('static/js/search.js', 'Search', {
        document: filterDocument({
            'filter-open': { checked: true },
            'filter-method': { value: 'online' },
            'filter-size-value': { value: '25' },
            'filter-avail-value': { value: '3' },
        }),
    });
    assert.deepEqual(plain(search.buildFilterCriteria()), {
        openOnly: true,
        instructionalMethod: 'online',
        carolinaCore: '',
        partOfTerm: '',
        courseAttribute: '',
        honors: '',
        meetingPattern: '',
        sizeMode: '',
        sizeValue: 25,
        availMode: '',
        availValue: 3,
    });
});

test('a filter set in the DOM reaches the direct path applySectionFilters call', async () => {
    const search = loadObject('static/js/search.js', 'Search', {
        State: { term: '202608' },
        API: { async searchCourses() { return { results: [{ code: 'CSCE 101', crn: '1' }], count: 1 }; } },
        document: filterDocument({ 'filter-method': { value: 'online' } }),
    });
    let captured = null;
    search.showLoading = () => {};
    search.renderAndCacheSearch = () => {};
    search.applySectionFilters = async (results, filters) => { captured = filters; return results; };

    await search._runCriteriaSearch({
        criteria: [],
        subject: 'CSCE',
        courseScope: NO_SCOPE,
        courseRangeFilter: null,
        courseNumberFilter: null,
        currentTermOnly: true,
        eligibleOnly: false,
        searchCacheKey: 'k',
    });

    assert.ok(captured, 'the direct path never called applySectionFilters');
    assert.equal(captured.instructionalMethod, 'online',
        'the DOM filter did not flow through buildFilterCriteria into the direct fetch');
});

test('the semantic path passes the same builder result to applySectionFilters', () => {
    // The semantic branch needs the Transformers model, so pin its wiring by
    // source: it builds the filters once with buildFilterCriteria and hands that
    // same object to applySectionFilters, the way the direct path does.
    const source = moduleSource('search');
    const at = source.indexOf('const semanticFilters = this.buildFilterCriteria();');
    assert.notEqual(at, -1, 'the semantic branch no longer builds its filters through buildFilterCriteria');
    const body = source.slice(at, at + 400);
    assert.match(body, /applySectionFilters\(results, semanticFilters\)/,
        'the semantic branch does not pass the builder result to applySectionFilters');
});

/* ---- Job 4: isStale, detailRouteState, browseState ----------------------- */

test('isStale is true only once a newer search has bumped the id past it', () => {
    const search = bareSearch();
    search._searchId = 5;
    assert.equal(search.isStale(5), false);
    assert.equal(search.isStale(4), true);
    assert.equal(search.isStale(6), true);
});

test('detailRouteState reports the open course code, section, and tab', () => {
    const search = bareSearch();
    search._detailGroup = { code: 'CSCE 145' };
    search._detailSectionCrn = '10868';
    search._detailTab = 'grades';
    assert.deepEqual(plain(search.detailRouteState()), { code: 'CSCE 145', crn: '10868', tab: 'grades' });
});

test('detailRouteState reports a null code and empty crn when nothing is open', () => {
    const search = bareSearch();
    search._detailGroup = null;
    search._detailSectionCrn = '';
    search._detailTab = 'overview';
    assert.deepEqual(plain(search.detailRouteState()), { code: null, crn: '', tab: 'overview' });
});

test('browseState returns whatever setBrowseState last recorded', () => {
    const workspace = { classList: { add() {}, remove() {} } };
    const search = loadObject('static/js/search.js', 'Search', {
        document: { getElementById: id => (id === 'browse-workspace' ? workspace : null) },
    });
    search.setBrowseState('detail');
    assert.equal(search.browseState(), 'detail');
    search.setBrowseState('results');
    assert.equal(search.browseState(), 'results');
});

/* ---- Job 5a: COURSE_DETAIL_TABS registry --------------------------------- */

test('the sub-tab registry drives the allowed set in setCourseDetailTab', () => {
    const search = loadObject('static/js/search.js', 'Search', {
        document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    });
    // A hypothetical tab, added only to the registry.
    search.COURSE_DETAIL_TABS.push({ id: 'notes' });

    search.setCourseDetailTab('notes');
    assert.equal(search._detailTab, 'notes', 'a registry tab is not accepted as allowed');

    search.setCourseDetailTab('not-a-tab');
    assert.equal(search._detailTab, 'overview', 'an unregistered tab must fall back to overview');
});

test('the sub-tab registry drives the loader dispatch in loadCourseDetailTab', () => {
    let notesLoaded = null;
    let gradesLoaded = null;
    const search = loadObject('static/js/search.js', 'Search', {
        Grades: { loadForCourse(code) { gradesLoaded = code; } },
    });
    search._detailGroup = { code: 'CSCE 145' };
    search._detailToken = 1;
    search._detailLoads = {};
    search.COURSE_DETAIL_TABS.push({ id: 'notes', load(code) { notesLoaded = code; } });

    // The added tab dispatches without touching loadCourseDetailTab itself.
    search.loadCourseDetailTab('notes');
    assert.equal(notesLoaded, 'CSCE 145');

    // And the existing grades loader still fires through the same registry.
    search.loadCourseDetailTab('grades');
    assert.equal(gradesLoaded, 'CSCE 145');
});

/* ---- Job 5b: normalizeCourseCode delegates to the shared util ------------ */

test('normalizeCourseCode canonicalises a 2-letter subject when the util is present', () => {
    const search = loadObject('static/js/search.js', 'Search', { CourseCode });
    // The historical local regex rejected 2-letter subjects; delegation fixes it.
    assert.equal(search.normalizeCourseCode('EE 101'), 'EE 101');
    assert.equal(search.normalizeCourseCode('csce145'), 'CSCE 145');
    // A non-code still resolves to '' -- the strict reading the call sites need.
    assert.equal(search.normalizeCourseCode('machine learning'), '');
});

test('normalizeCourseCode keeps the stricter local fallback without the util', () => {
    const search = loadObject('static/js/search.js', 'Search', {});
    // No courseCode collaborator: the fallback regex still rejects 2 letters.
    assert.equal(search.normalizeCourseCode('EE 101'), '');
    assert.equal(search.normalizeCourseCode('CSCE 145'), 'CSCE 145');
});

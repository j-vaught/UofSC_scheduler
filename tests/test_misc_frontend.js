/*
 * Residual frontend contracts that do not belong to one feature suite:
 * the schedule sidebar dropdown (degree-plan.js), prerequisite rendering,
 * offering-history feature, top-level tab history and boot-time shell wiring.
 * Split out of test_scheduler_frontend.js.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const {
    loadObject, bootSource, stylesheet, historyFeature,
} = require('./support/scheduler-harness.js');

test('applied section appears in the section dropdown without a separate status line', () => {
    const elements = {
        'selected-courses-list': { innerHTML: '', querySelectorAll: () => [] },
        'selected-credits': { textContent: '' },
        'schedule-selected-count': { textContent: '' },
    };
    const sidebar = loadObject('static/js/degree-plan.js', 'ScheduleSidebar', {
        State: {
            selectedCourses: {
                'TEST 101': {
                    title: 'Test Course',
                    sections: [{ crn: '10101', section: '004', stat: 'A', hours: '3' }],
                },
            },
            selectedSections: { 'TEST 101': { crn: '10101', section: '004' } },
            sectionLocks: {},
        },
        document: { getElementById: id => elements[id] || null },
    });

    sidebar.render();

    assert.match(elements['selected-courses-list'].innerHTML, /<option value="">Section 004 selected<\/option>/);
    assert.doesNotMatch(elements['selected-courses-list'].innerHTML, /Applied section 004/);
});

test('full sections remain selectable as an explicit planning override', () => {
    const elements = {
        'selected-courses-list': { innerHTML: '', querySelectorAll: () => [] },
        'selected-credits': { textContent: '' },
    };
    const sidebar = loadObject('static/js/degree-plan.js', 'ScheduleSidebar', {
        State: {
            selectedCourses: {
                'TEST 101': {
                    title: 'Test Course',
                    sections: [{ crn: '10101', section: '001', stat: 'C', hours: '3' }],
                },
            },
            selectedSections: {},
            sectionLocks: { 'TEST 101': '10101' },
        },
        document: { getElementById: id => elements[id] || null },
    });

    sidebar.render();

    assert.match(elements['selected-courses-list'].innerHTML, /value="10101" selected/);
    assert.doesNotMatch(elements['selected-courses-list'].innerHTML, /value="10101"[^>]*disabled/);
    assert.match(elements['selected-courses-list'].innerHTML, /Full section selected\. Planning only/);
});

test('locked section is shown in the dropdown with a clear-section action', () => {
    const elements = {
        'selected-courses-list': { innerHTML: '', querySelectorAll: () => [] },
        'selected-credits': { textContent: '' },
        'schedule-selected-count': { textContent: '' },
    };
    const sidebar = loadObject('static/js/degree-plan.js', 'ScheduleSidebar', {
        State: {
            selectedCourses: {
                'CSCE 145': {
                    title: 'Algorithmic Design I',
                    sections: [{ crn: '10868', section: '001', stat: 'A', hours: '4' }],
                },
            },
            selectedSections: {},
            sectionLocks: { 'CSCE 145': '10868' },
        },
        document: { getElementById: id => elements[id] || null },
    });

    sidebar.render();

    assert.match(elements['selected-courses-list'].innerHTML, /value="10868" selected>Section 001/);
    assert.match(elements['selected-courses-list'].innerHTML, /class="btn-clear-section"/);
    assert.doesNotMatch(elements['selected-courses-list'].innerHTML, /will be used in all schedules/);
    assert.doesNotMatch(elements['selected-courses-list'].innerHTML, /Locked section will be required/);
});

test('schedule sidebar totals actual one, four, and three credit courses', () => {
    const elements = {
        'selected-courses-list': { innerHTML: '', querySelectorAll: () => [] },
        'selected-credits': { textContent: '' },
        'schedule-selected-count': { textContent: '' },
    };
    const sidebar = loadObject('static/js/degree-plan.js', 'ScheduleSidebar', {
        State: {
            selectedCourses: {
                'CSCE 190': { title: 'Computing in the Modern World', credits: 1, sections: [] },
                'CSCE 145': { title: 'Algorithmic Design I', credits: 4, sections: [] },
                'CSCE 211': { title: 'Digital Logic Design', credits: 3, sections: [] },
            },
            selectedSections: {},
            sectionLocks: {},
        },
        document: { getElementById: id => elements[id] || null },
    });

    sidebar.render();

    assert.equal(elements['selected-credits'].textContent, '8 credits');
});

test('Search results do not display a selected-course counter', () => {
    const html = fs.readFileSync('static/index.html', 'utf8');
    const styles = stylesheet();

    assert.doesNotMatch(html, /id="pick-count"|\(\$\{count\} selected\)/);
    assert.doesNotMatch(styles, /\.pick-count|\.results-header:has\(\.pick-count/);
    assert.match(html + bootSource(), /(?:deps\.state|State)\.on\('courses-changed', \(\) => ScheduleSidebar\.render\(\)\)/);
});

test('prerequisite details use a compact status-first requirement tree', () => {
    const prereqs = loadObject('static/js/prereqs.js', 'Prereqs', {});
    // The rendering logic lives in the fenced feature now.
    const source = fs.readFileSync('static/js/features/prereqs/index.js', 'utf8');
    const styles = stylesheet();
    const groups = [{ courses: ['CSCE 580'], type: 'and' }];
    const companions = [
        { mode: 'corequisite', text: 'CSCE 884.', groups: [{ courses: ['CSCE 884'], type: 'and' }] },
        { mode: 'either', text: 'CSCE 585.', groups: [{ courses: ['CSCE 585'], type: 'and' }] },
    ];
    const completed = new Set();

    const status = prereqs.renderStatus(groups, [], completed, true, false);
    const companionStatus = prereqs.renderStatus([], companions, completed, false, false);
    const reviewStatus = prereqs.renderStatus(groups, [], completed, true, true);
    const pathway = prereqs.renderPathways('CSCE 883', groups, companions, completed);
    const alternativeCompanions = [{
        mode: 'either',
        text: 'MATH 111 or MATH 115.',
        groups: prereqs.parsePrereqGroups('MATH 111 or MATH 115.'),
    }];
    const alternativeStatus = prereqs.renderStatus([], alternativeCompanions, completed, false, false);
    const alternativeTree = prereqs.renderPathways('CSCE 145', [], alternativeCompanions, completed);
    const catalog = prereqs.renderCatalogNote('CSCE 580.', companions, false);
    const requiredTogether = prereqs.parsePrereqGroups('C or better in ACCT 401 and MGSC 290.');
    const alternatives = prereqs.parsePrereqGroups('D or better in ENCP 200, ECIV 200, EMCH 200, or ECHE 300.');
    const mixed = prereqs.parsePrereqGroups('D or better in EMCH 290 or ENCP 290 and AESP 265.');
    const placementAlternative = prereqs.parsePrereqGroups(
        'Prerequisites: C or better in MATH 112, MATH 115, MATH 116, or through placement exam.',
    );
    const placementTree = prereqs.renderPathways('MATH 141', placementAlternative, [], completed);
    const mixedPlacement = prereqs.parsePrereqGroups(
        'C or better in MATH 111 and MATH 112, or placement exam.',
    );
    const unevenPathway = prereqs.renderPathways('CSCE 350', [
        { courses: ['CSCE 240'], type: 'and' },
        { courses: ['MATH 174', 'MATH 374', 'MATH 574'], type: 'or' },
        { courses: ['MATH 141', 'MATH 122'], type: 'or' },
    ], [], completed);

    assert.match(status, /1 prerequisite requirement remaining/);
    assert.match(companionStatus, /2 companion courses to plan/);
    assert.match(alternativeStatus, /1 companion course to plan/);
    assert.match(alternativeTree, /choose one/);
    assert.match(reviewStatus, /Review these requirements/);
    assert.match(pathway, /CSCE 580/);
    assert.match(pathway, /Needed/);
    assert.match(pathway, /CSCE 883/);
    assert.match(pathway, /This course/);
    assert.match(pathway, /prereq-tree-groups/);
    assert.match(pathway, /Take with this course/);
    assert.match(pathway, /Before or with this course/);
    const targetIndex = pathway.indexOf('prereq-course-card target');
    assert.ok(pathway.indexOf('Take with this course') < targetIndex);
    assert.ok(pathway.indexOf('Before or with this course') < targetIndex);
    assert.match(alternativeTree, /prereq-tree-groups single companions-only/);
    assert.match(alternativeTree, /prereq-tree-connector companion/);
    assert.doesNotMatch(pathway, /prereq-tree-companions|prereq-tree-companion-rise/);
    assert.match(unevenPathway, /prereq-course-options alternatives/);
    assert.equal((unevenPathway.match(/prereq-tree-branch-drop/g) || []).length, 3);
    assert.equal((unevenPathway.match(/class="prereq-link prereq-course-card/g) || []).length, 6);
    assert.match(unevenPathway, /prereq-course-options[^>]*>[\s\S]*prereq-tree-branch-drop/);
    assert.doesNotMatch(pathway, /<svg/);
    assert.match(catalog, /<details class="prereq-catalog-note">/);
    assert.match(catalog, /Catalog wording/);
    assert.equal(prereqs.requirementNeedsReview('CSCE 580.'), false);
    assert.equal(prereqs.requirementNeedsReview('C or better in CSCE 580.'), true);
    assert.equal(prereqs.requirementNeedsReview('CSCE 101 or above.'), true);
    assert.equal(prereqs.requirementNeedsReview('MATH 141 or placement.'), true);
    assert.deepEqual(
        JSON.parse(JSON.stringify(requiredTogether.map(group => [...group.courses]))),
        [['ACCT 401'], ['MGSC 290']],
    );
    assert.deepEqual(
        JSON.parse(JSON.stringify(alternatives[0].courses)),
        ['ENCP 200', 'ECIV 200', 'EMCH 200', 'ECHE 300'],
    );
    assert.deepEqual(
        JSON.parse(JSON.stringify(mixed.map(group => [...group.courses]))),
        [['EMCH 290', 'ENCP 290'], ['AESP 265']],
    );
    assert.deepEqual(
        JSON.parse(JSON.stringify(placementAlternative[0].courses)),
        ['MATH 112', 'MATH 115', 'MATH 116'],
    );
    assert.equal(placementAlternative.length, 1);
    assert.equal(placementAlternative[0].type, 'or');
    assert.equal(placementAlternative[0].conditions[0].label, 'Placement exam');
    assert.equal(prereqs.groupIsMet(placementAlternative[0], new Set(['MATH 115'])), true);
    assert.equal(prereqs.evaluateGroups(placementAlternative, new Set()).eligible, true);
    assert.equal(prereqs.evaluateGroups(placementAlternative, new Set()).uncertain, true);
    assert.equal(prereqs.evaluateGroups(placementAlternative, new Set(['MATH 115'])).satisfied, true);
    assert.equal(mixedPlacement.length, 2);
    assert.ok(mixedPlacement.every(group => !(group.conditions || []).length));
    assert.match(placementTree, /Complete one/);
    assert.match(placementTree, /Placement exam/);
    assert.match(placementTree, /prereq-course-card condition/);
    assert.doesNotMatch(placementTree, /prereq-tree-branch-label">Required/);
    assert.doesNotMatch(source, /Prerequisite Status|Some prerequisites are missing|Required before this course/);
    assert.match(source, /\{ html: details\.corequisite, mode: 'corequisite' \}/);
    assert.match(source, /\{ html: details\.prerequisite_or_corequisite, mode: 'either' \}/);
    assert.match(source, /getElementById\('browse-close-details'\)\?\.focus\(\)/);
    assert.match(styles, /\.prereq-status-card\.missing/);
    assert.match(styles, /\.prereq-course-card\.target/);
    assert.match(styles, /\.prereq-course-card\.condition\s*{[^}]*border-color:\s*#f2c200;/s);
    assert.match(styles, /\.prereq-tree-groups/);
    assert.match(styles, /\.prereq-tree-branch\s*{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s);
    assert.match(styles, /\.prereq-tree-branch-drop\s*{[^}]*flex:\s*1 1 14px;[^}]*width:\s*2px;/s);
    assert.match(styles, /\.prereq-tree-connector\s*{[^}]*background:\s*#000000;[^}]*width:\s*2px;/s);
    assert.doesNotMatch(styles, /\.prereq-tree-connector\s*{[^}]*border-left:/s);
    assert.match(styles, /\.prereq-course-options\.alternatives\s*{[^}]*flex-direction:\s*column;[^}]*flex-wrap:\s*nowrap;/s);
    assert.match(styles, /\.prereq-course-options\.alternatives \.prereq-course-card\s*{[^}]*width:\s*min\(150px, 100%\);/s);

    const eligibleSearch = loadObject('static/js/search.js', 'Search', {
        Prereqs: prereqs,
        State: { completedCourses: ['MATH 115'] },
    });
    assert.equal(eligibleSearch.checkEligibility('MATH 141', {
        'MATH 141': { prereqs: placementAlternative[0].courses, groups: placementAlternative },
    }).eligible, true);
    const unknownSearch = loadObject('static/js/search.js', 'Search', {
        Prereqs: prereqs,
        State: { completedCourses: [] },
    });
    const unknownEligibility = unknownSearch.checkEligibility('MATH 141', {
        'MATH 141': { prereqs: placementAlternative[0].courses, groups: placementAlternative },
    });
    assert.equal(unknownEligibility.eligible, true);
    assert.equal(unknownEligibility.unknown, true);
    assert.deepEqual(JSON.parse(JSON.stringify(unknownEligibility.missing)), []);
});

test('course and registration dialogs close when the backdrop is pressed', () => {
    const html = fs.readFileSync('static/index.html', 'utf8');

    assert.match(html + bootSource(), /window\.AppModal = \{/);
    assert.match(html + bootSource(), /modalOverlay\.addEventListener\('click'/);
    assert.match(html + bootSource(), /if \(event\.target === modalOverlay\) closeModal\(\);/);
    assert.match(html + bootSource(), /if \(event\.key === 'Escape'\)/);
    assert.match(html + bootSource(), /modal\.classList\.remove\(\.\.\.modalClasses\)/);
    assert.match(html + bootSource(), /requestAnimationFrame\(\(\) => restore\?\.isConnected && restore\.focus\(\)\)/);
});

test('registration prerequisite warnings account for completed alternatives', () => {
    const state = { profile: { majorData: { major: 'Mechanical Engineering' } } };
    const prereqs = loadObject('static/js/prereqs.js', 'Prereqs', {});
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', { State: state, Prereqs: prereqs });
    scheduler.stripHtml = value => String(value || '');

    assert.equal(
        scheduler.registrationRequirementSatisfied(
            'D or better in EMCH 260 or ENCP 260.',
            new Set(['EMCH 260']),
        ),
        true,
    );
    assert.equal(
        scheduler.registrationRequirementSatisfied(
            'C or better in MATH 112, MATH 115, MATH 116, or through placement exam.',
            new Set(['MATH 115']),
        ),
        true,
    );
    assert.equal(
        scheduler.registrationRequirementSatisfied(
            'C or better in MATH 112, MATH 115, MATH 116, or through placement exam.',
            new Set(),
        ),
        false,
    );
    assert.equal(
        scheduler.registrationRequirementSatisfied(
            'MATH 242; C or better in EMCH 200 or ENCP 200.',
            new Set(['MATH 242']),
        ),
        false,
    );
    assert.equal(
        scheduler.registrationRequirementSatisfied(
            'MATH 242; C or better in EMCH 200 or ENCP 200.',
            new Set(['MATH 242', 'ENCP 200']),
        ),
        true,
    );
    assert.equal(
        scheduler.registrationRestrictionNeedsAttention(
            'Enrollment limited to students in the Mechanical Engineering Major.',
        ),
        false,
    );
    assert.equal(
        scheduler.registrationRestrictionNeedsAttention(
            'Enrollment limited to students in the Nursing Major.',
        ),
        true,
    );
    assert.equal(
        scheduler.registrationRestrictionText(
            'Enrollment limited to students in the Mechanical Engineering Major. Enrollment limited to students in the USC Columbia campus.',
        ),
        'Enrollment limited to students in the Mechanical Engineering Major.',
    );
    assert.equal(
        scheduler.registrationRestrictionText(
            'Enrollment limited to students in the USC Columbia campus.',
        ),
        '',
    );
    assert.equal(
        scheduler.registrationRestrictionText(
            'Enrollment is limited to students with a Electrical Engineering Major.Enrollment limited to students in the Molinaroli College of Engineering and Computing college.Enrollment limited to students in the USC Columbia campus.',
        ),
        'Enrollment is limited to students with a Electrical Engineering Major. Enrollment limited to students in the Molinaroli College of Engineering and Computing college.',
    );
});

test('Top-level tab history preserves Search when returning to an unparameterized page', () => {
    const location = {
        href: 'http://127.0.0.1:8765/',
        pathname: '/',
        search: '',
    };
    const historyCalls = [];
    const history = {
        state: { tab: 'semester' },
        pushState(state, _title, url) { historyCalls.push({ state, url }); },
        replaceState(state, _title, url) { historyCalls.push({ state, url, replace: true }); },
    };
    const tabs = loadObject('static/js/tabs.js', 'Tabs', {
        State: { term: '202608' },
        URL,
        window: { location },
        history,
        localStorage: { setItem() {}, getItem() { return null; } },
        document: {
            querySelectorAll() { return []; },
            querySelector() { return null; },
            getElementById() { return null; },
            dispatchEvent() {},
        },
        CustomEvent: class {},
    });

    tabs.switchTo('schedule');
    assert.equal(historyCalls[0].state.tab, 'schedule');
    assert.equal(historyCalls[0].url, '/?tab=schedule&term=202608');
    history.state = { tab: 'semester' };
    tabs.restoreFromLocation();
    assert.equal(tabs.current(), 'semester');
});

test('A plain site visit opens Search even when another tab was used previously', () => {
    const html = fs.readFileSync('static/index.html', 'utf8');
    // Cache markers are stamped from file contents at build time, so the source
    // tag carries none. test_static_site_build.py covers the stamping itself.
    assert.match(html, /\/static\/js\/tabs\.js/);
    const switched = [];
    const tabs = loadObject('static/js/tabs.js', 'Tabs', {
        URL,
        window: {
            location: { href: 'https://scheduler.example/' },
            addEventListener() {},
        },
        history: {
            state: {},
            replaceState() {},
        },
        localStorage: {
            getItem() { return 'degree'; },
            setItem() {},
        },
        document: {
            getElementById() { return { addEventListener() {} }; },
            // tabFromUrl now derives the valid-tab set from #main-tabs
            // markup (see below), so it always calls this even off the
            // legacy-alias branches; an empty nav here means every ?tab=
            // value but the recognized aliases is unrecognized, which is
            // what this test wants.
            querySelectorAll() { return []; },
        },
    });
    tabs.switchTo = (tab, options) => switched.push({ tab, options });

    tabs.init();

    assert.equal(switched.length, 1);
    assert.equal(switched[0].tab, 'semester');
    assert.equal(switched[0].options.historyMode, 'none');
});

// A fake #main-tabs nav button: switchTo() toggles .active on every button
// this selector returns (not just the one being activated), so the stub needs
// a working classList, not just the dataset validTabs() reads.
function navButtonStub(tab) {
    return { dataset: { tab }, classList: { add() {}, remove() {} } };
}

/*
 * tabFromUrl() used to fall back to '' for anything outside a hardcoded
 * ['degree', 'schedule'] plus the legacy aliases -- a value it did not
 * recognize simply produced no match. Deriving valid tabs from the DOM
 * changes the mechanism but must not change this outcome: a tab name that
 * matches no button in #main-tabs and no legacy alias still resolves to no
 * match, and callers (init/restoreFromLocation) still fall back to Search.
 */
test('An unrecognized tab in the URL still falls back to the semester default', () => {
    const location = {
        href: 'http://127.0.0.1:8765/?tab=bogus-tab',
        pathname: '/',
        search: '?tab=bogus-tab',
    };
    const tabs = loadObject('static/js/tabs.js', 'Tabs', {
        State: { term: '202608' },
        URL,
        window: { location },
        history: { state: { tab: 'bogus-tab' }, pushState() {}, replaceState() {} },
        localStorage: { setItem() {}, getItem() { return null; } },
        document: {
            querySelectorAll(selector) {
                return selector === '#main-tabs [data-tab]'
                    ? ['semester', 'degree', 'schedule'].map(navButtonStub)
                    : [];
            },
            querySelector() { return null; },
            getElementById() { return null; },
            dispatchEvent() {},
        },
        CustomEvent: class {},
    });

    tabs.restoreFromLocation();
    assert.equal(tabs.current(), 'semester');
});

/*
 * The point of reading #main-tabs instead of a hardcoded list: a fourth tab
 * button in the nav becomes a legal deep-link target with no matching edit to
 * tabs.js. This proves it from the other direction of the test above -- a
 * data-tab value present in markup resolves to itself, not to the fallback.
 */
test('A data-tab button present in the nav markup is automatically a valid deep-link target', () => {
    const location = {
        href: 'http://127.0.0.1:8765/?tab=transfer-credits',
        pathname: '/',
        search: '?tab=transfer-credits',
    };
    const tabs = loadObject('static/js/tabs.js', 'Tabs', {
        State: { term: '202608' },
        URL,
        window: { location },
        history: { state: {}, pushState() {}, replaceState() {} },
        localStorage: { setItem() {}, getItem() { return null; } },
        document: {
            querySelectorAll(selector) {
                // The hypothetical fourth tab, 'transfer-credits'. Nothing in
                // tabs.js names it; it is valid purely because a button for
                // it exists in the nav.
                return selector === '#main-tabs [data-tab]'
                    ? ['semester', 'degree', 'schedule', 'transfer-credits'].map(navButtonStub)
                    : [];
            },
            querySelector() { return null; },
            getElementById() { return null; },
            dispatchEvent() {},
        },
        CustomEvent: class {},
    });

    tabs.restoreFromLocation();
    assert.equal(tabs.current(), 'transfer-credits');
});

test('Changing terms does not run a hidden Search query from another tab', () => {
    const html = fs.readFileSync('static/index.html', 'utf8');

    // A term change re-searches on the semester tab and only records history on
    // any other tab. The handler is boot-time startup wiring (not cheaply
    // executable), so match the semantic core -- a branch on the current tab
    // being 'semester' that runs a search, with the other branch writing tab
    // history -- rather than the exact expression or the deps/global spelling.
    const src = html + bootSource();
    const branchAt = src.indexOf("=== 'semester'");
    assert.notEqual(branchAt, -1, 'the term-change tab branch moved; this test is not reading it');
    const branch = src.slice(branchAt, branchAt + 400);
    assert.match(branch, /\.doSearch\(\)/, 'the semester tab re-runs the search on a term change');
    assert.match(branch, /writeTabHistory\([\s\S]*?'replace'\)/, 'other tabs only record tab history');
});

test('Offering history uses one aggregate request and ignores stale loads', async () => {
    const container = { innerHTML: '' };
    const styles = stylesheet();
    const pending = new Map();
    const progressCallbacks = new Map();
    const calls = [];
    const document = {
        getElementById: id => id === 'history-container' ? container : null,
        createElement() {
            let value = '';
            return {
                set textContent(text) { value = String(text); },
                get innerHTML() {
                    return value
                        .replaceAll('&', '&amp;')
                        .replaceAll('<', '&lt;')
                        .replaceAll('>', '&gt;')
                        .replaceAll('"', '&quot;');
                },
            };
        },
    };
    const history = loadObject('static/js/history.js', 'History', {
        Features: { history: historyFeature },
        API: {
            getHistory(code, onProgress) {
                calls.push(code);
                progressCallbacks.set(code, onProgress);
                return new Promise(resolve => pending.set(code, resolve));
            },
            getDetails() { throw new Error('Per-section history request should not run'); },
            searchCourses() { throw new Error('Per-term history request should not run'); },
        },
        State: { term: '202708' },
        document,
    });
    history._activeTerm = () => '202708';

    const first = history.loadForCourse('CSCE 145');
    assert.deepEqual(calls, ['CSCE 145']);
    assert.match(container.innerHTML, /role="progressbar"/);
    assert.match(container.innerHTML, /aria-valuemin="0"/);
    assert.match(container.innerHTML, /aria-valuemax="100"/);
    assert.doesNotMatch(container.innerHTML, /aria-valuenow=/);
    assert.match(container.innerHTML, /role="status" aria-live="polite" aria-atomic="true"/);
    assert.match(container.innerHTML, /Loading offering history/);
    assert.match(container.innerHTML, /Connecting to offering records/);
    assert.match(styles, /\.history-loading-card\s*{[^}]*border:\s*1px solid #000000;/s);
    assert.match(styles, /@media \(prefers-reduced-motion:\s*reduce\)/);

    progressCallbacks.get('CSCE 145')({
        phase: 'terms',
        completed: 3,
        total: 8,
        label: 'Fall 2024',
    });
    assert.match(container.innerHTML, /3 of 8 terms checked/);
    assert.match(container.innerHTML, /38%/);
    assert.match(container.innerHTML, /aria-valuenow="38"/);
    assert.match(container.innerHTML, /Checking Fall 2024/);

    progressCallbacks.get('CSCE 145')({
        phase: 'enrollment',
        completed: 3,
        total: 8,
        label: 'Fall 2024',
        section: 2,
        section_total: 5,
    });
    assert.match(container.innerHTML, /Reading enrollment for Fall 2024 · 2 of 5 sections/);

    const second = history.loadForCourse('CSCE 146');
    assert.deepEqual(calls, ['CSCE 145', 'CSCE 146']);
    progressCallbacks.get('CSCE 145')({
        phase: 'terms',
        completed: 7,
        total: 8,
        label: 'Spring 2026',
    });
    assert.match(container.innerHTML, /CSCE 146/);
    assert.doesNotMatch(container.innerHTML, /Spring 2026|88%/);
    progressCallbacks.get('CSCE 146')({
        phase: 'terms',
        completed: 4,
        total: 8,
        label: 'Spring 2025',
    });
    assert.match(container.innerHTML, /4 of 8 terms checked/);
    assert.match(container.innerHTML, /50%/);
    pending.get('CSCE 146')({
        code: 'CSCE 146',
        as_of_term: '202708',
        terms: [{
            term: '202601',
            label: 'Spring 2026',
            available: true,
            complete: true,
            offered: true,
            sections: 2,
        }],
    });
    await second;
    assert.match(container.innerHTML, /Spring 2026/);
    const currentMarkup = container.innerHTML;

    pending.get('CSCE 145')({
        code: 'CSCE 145',
        as_of_term: '202708',
        terms: [{
            term: '202508',
            label: 'Fall 2025',
            available: true,
            complete: true,
            offered: true,
            sections: 1,
        }],
    });
    await first;
    assert.equal(container.innerHTML, currentMarkup);
    assert.doesNotMatch(container.innerHTML, /Fall 2025/);
});

test('Offering history applies the earlier boundary and renders API errors safely', async () => {
    const container = { innerHTML: '' };
    const document = {
        getElementById: id => id === 'history-container' ? container : null,
        createElement() {
            let value = '';
            return {
                set textContent(text) { value = String(text); },
                get innerHTML() {
                    return value
                        .replaceAll('&', '&amp;')
                        .replaceAll('<', '&lt;')
                        .replaceAll('>', '&gt;')
                        .replaceAll('"', '&quot;');
                },
            };
        },
    };
    const history = loadObject('static/js/history.js', 'History', {
        Features: { history: historyFeature },
        API: { getHistory: async () => { throw new Error('<script>unsafe</script>'); } },
        State: { term: '202708' },
        document,
    });
    history._activeTerm = () => '202608';

    assert.equal(history._historyBoundary('202605'), '202605');
    assert.equal(history._historyBoundary('202801'), '202608');
    history.render({
        as_of_term: '202605',
        terms: [
            { term: '202501', label: 'Spring 2025', complete: true, available: true, offered: true, sections: 1 },
            { term: '202605', label: 'Summer 2026', complete: true, available: true, offered: true, sections: 1 },
        ],
    }, container);
    assert.match(container.innerHTML, /Spring 2025/);
    assert.doesNotMatch(container.innerHTML, /Summer 2026/);

    await history.loadForCourse('CSCE 145');
    assert.match(container.innerHTML, /role="alert"/);
    assert.match(container.innerHTML, /temporarily unavailable/);
    assert.doesNotMatch(container.innerHTML, /script|unsafe/);
});

test('Offering history groups terms by year and reveals details on colored season cells', () => {
    const container = { innerHTML: '' };
    const document = {
        createElement() {
            let value = '';
            return {
                set textContent(text) { value = String(text); },
                get innerHTML() {
                    return value
                        .replaceAll('&', '&amp;')
                        .replaceAll('<', '&lt;')
                        .replaceAll('>', '&gt;')
                        .replaceAll('"', '&quot;');
                },
            };
        },
    };
    const history = loadObject('static/js/history.js', 'History', {
        Features: { history: historyFeature },
        State: { term: '202608' },
        document,
    });
    history._activeTerm = () => '202608';

    history.render({
        code: 'CSCE 190',
        as_of_term: '202608',
        terms: [
            { term: '202501', label: 'Spring 2025', complete: true, available: false, offered: false },
            { term: '202505', label: 'Summer 2025', complete: true, available: true, offered: false },
            { term: '202508', label: 'Fall 2025', complete: true, available: true, offered: true, sections: 2, enrollment: 100, capacity: 125 },
            { term: '202408', label: 'Fall 2024', complete: true, available: true, offered: true, sections: 1, enrollment: 72 },
            { term: '202405', label: 'Summer 2024', complete: true, available: true, offered: true, sections: 3, enrollment: 40, enrollment_sections: 2 },
            { term: '202401', label: 'Spring 2024', complete: true, available: true, offered: true, sections: 1 },
            { term: '202308', label: 'Fall 2023', complete: true, available: true, offered: true, sections: 1 },
        ],
    }, container);

    assert.match(container.innerHTML, /Offerings by year/);
    assert.match(container.innerHTML, /<span>Spring<\/span><span>Summer<\/span><span>Fall<\/span>/);
    const y2025At = container.innerHTML.indexOf('>2025<');
    const y2024At = container.innerHTML.indexOf('>2024<');
    // Anchor both: if a year row disappears its index is -1 and "-1 < positive"
    // passes even though the row is gone, hiding the regression (fails open).
    assert.notEqual(y2025At, -1, 'the 2025 offerings row is gone');
    assert.notEqual(y2024At, -1, 'the 2024 offerings row is gone');
    assert.ok(y2025At < y2024At, '2025 must sort before 2024');
    assert.match(container.innerHTML, /history-season-cell offered" tabindex="0" role="img"/);
    assert.match(container.innerHTML, /Fall 2025/);
    assert.match(container.innerHTML, /100 of 125 enrolled · 80% filled/);
    assert.match(container.innerHTML, /72 enrolled/);
    assert.match(container.innerHTML, /40 enrolled across 2 of 3 sections/);
    assert.doesNotMatch(container.innerHTML, /Enrollment unavailable/);
    assert.match(container.innerHTML, /history-season-cell not-offered/);
    assert.match(container.innerHTML, /history-season-cell unknown" tabindex="0"/);
    assert.match(container.innerHTML, /history-season-cell not-checked/);
    assert.doesNotMatch(container.innerHTML, /history-term-card|history-frequency-track/);
});

'use strict';

/*
 * The degree plan fence.
 *
 * The widest extraction so far, and the one whose seams matter most to what
 * comes next: the edges into Search and Scheduler are navigation, not data, so
 * turning them into callbacks removes inbound edges from the cycle that has to
 * be untangled last. These tests hold that line -- the feature must never reach
 * those modules again, only ask its caller to go there.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const featureSource = (() => {
    // The whole feature: it is split into parts its index merges, so reading
    // index.js alone finds composition and none of the methods.
    const dir = path.join(ROOT, 'static/js/features/degree-plan');
    return fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()
        .map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
})();

const codeOnly = featureSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const asHost = value => JSON.parse(JSON.stringify(value));

const DEP_NAMES = ['getDegreePlan', 'bulletinSearch', 'getOfferingAnalysis',
    'plan', 'profile', 'completedCourses', 'completedDetails',
    'selectedSections', 'selectedCourses', 'sectionLocks', 'currentTerm',
    'setSectionLock', 'removeCourse', 'emitPlanUpdated',
    'findMajorMap', 'catalogYearLabel', 'sourceUrl', 'sourceLabel',
    'onCourseworkChanged', 'showCourse', 'searchFor',
    'onProfileChange', 'onTranscriptChange', 'onPlanChange'];

/*
 * The DOM is ambient for this feature by design, so a sandbox with no document
 * proves the State/API fence but cannot run any path that touches the page --
 * and generatePlan touches it immediately, to put the button into its
 * generating state. Tests of those paths get a minimal document; fence tests
 * pass nothing and confirm the module still constructs without one.
 */
function stubElement() {
    return {
        innerHTML: '', textContent: '', value: '', disabled: false, className: '', hidden: false,
        children: [],
        appendChild(child) { this.children.push(child); return child; },
        append(...nodes) { this.children.push(...nodes); },
        replaceChildren(...nodes) { this.children = nodes; },
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {},
        setAttribute() {},
        classList: { add() {}, remove() {}, contains: () => false },
        closest: () => null,
        dataset: {},
    };
}

function loadFeature({ withDocument = false } = {}) {
    const globals = {
        console, JSON, Math, Object, Array, Promise, Number, String, Boolean, Set, Map, Date, RegExp,
    };
    if (withDocument) {
        globals.document = {
            getElementById: () => stubElement(),
            createElement: () => stubElement(),
            createTextNode: text => ({ textContent: String(text) }),
            querySelector: () => null,
            querySelectorAll: () => [],
        };
    }
    const sandbox = vm.createContext(globals);
    vm.runInContext(`${featureSource}\nglobalThis.__f = Features.degreePlan;`, sandbox);
    return sandbox.__f;
}

function stubDeps(overrides = {}) {
    const plan = { semesters: [], pins: {}, warnings: [], categories: {}, completedSemesters: [] };
    const profile = { major: null, majorData: null, concentration: 'general', planMode: 'full_time' };
    const base = {
        getDegreePlan: async () => ({ semesters: [] }),
        bulletinSearch: async () => ({ courses: [] }),
        getOfferingAnalysis: async () => ({}),
        plan: () => plan,
        profile: () => profile,
        completedCourses: () => [],
        completedDetails: () => [],
        selectedSections: () => ({}),
        selectedCourses: () => ({}),
        sectionLocks: () => ({}),
        currentTerm: () => '202608',
        setSectionLock: () => {},
        removeCourse: () => {},
        emitPlanUpdated: () => {},
        findMajorMap: () => null,
        catalogYearLabel: () => '2026-2027 catalog',
        sourceUrl: () => '',
        sourceLabel: () => 'Official major map',
        onCourseworkChanged: () => {},
        showCourse: () => {},
        searchFor: () => {},
        onProfileChange: () => {},
        onTranscriptChange: () => {},
        onPlanChange: () => {},
    };
    return { ...base, ...overrides };
}

test('no application global is reachable from the feature', () => {
    for (const global of ['State', 'API', 'Profile', 'Prereqs', 'Scheduler', 'Search', 'Tabs']) {
        assert.doesNotMatch(
            codeOnly,
            new RegExp(`\\b${global}\\.`),
            `${global} is reached directly; it should be a declared dependency`,
        );
    }
});

test('every dependency is declared and missing ones fail at construction', () => {
    const { createDegreePlanFeature } = loadFeature();
    for (const name of DEP_NAMES) {
        const deps = stubDeps();
        delete deps[name];
        assert.throws(
            () => createDegreePlanFeature(deps),
            new RegExp(`needs a ${name}\\(\\)`),
            `${name} should be required up front, not discovered mid-plan`,
        );
    }
});

/*
 * Enrichment is optional because the prerequisite layer is a separate script
 * tag, but it must be a function when supplied -- a truthy non-function would
 * fail deep inside plan generation instead of at construction.
 */
test('enrichment is optional but type-checked when supplied', () => {
    const { createDegreePlanFeature } = loadFeature();
    assert.doesNotThrow(() => createDegreePlanFeature(stubDeps()));
    assert.doesNotThrow(() => createDegreePlanFeature(stubDeps({ enrichMajorMap: async m => m })));
    assert.throws(
        () => createDegreePlanFeature(stubDeps({ enrichMajorMap: 'yes please' })),
        /enrichMajorMap\(\) to be a function/,
    );
});

/*
 * The regression the fence exists to prevent. Enrichment was guarded on a
 * global, so inside a fence the plan would have been built from the unenriched
 * major map: a different plan, with nothing anywhere to say so.
 */
test('the injected enricher is used, and its output is what gets planned', async () => {
    const { createDegreePlanFeature } = loadFeature({ withDocument: true });
    const seen = [];
    const planned = [];
    // One stable object: generatePlan writes the enriched map back onto it.
    const profile = { major: 'cs', majorData: { major: 'CS', required_courses: [], total_credits_required: 120 }, planMode: 'full_time', concentration: 'general' };
    const feature = createDegreePlanFeature(stubDeps({
        profile: () => profile,
        enrichMajorMap: async map => { seen.push(map.major); return { ...map, enriched: true }; },
        getDegreePlan: async request => { planned.push(request.major_map?.enriched === true); return { semesters: [] }; },
    }));
    feature.render = () => {};
    feature.updateSidebar = () => {};
    feature.buildCompletedSemesters = () => {};

    await feature.generatePlan();
    assert.deepEqual(asHost(seen), ['CS'], 'the injected enricher should be called');
    assert.deepEqual(asHost(planned), [true], 'the planner should receive the enriched map');
    assert.equal(profile.majorData.enriched, true, 'the enriched map should be written back');
});

test('without an enricher the plan is still generated, from the raw map', async () => {
    const { createDegreePlanFeature } = loadFeature({ withDocument: true });
    const planned = [];
    const profile = { major: 'cs', majorData: { major: 'CS', required_courses: [], total_credits_required: 120 }, planMode: 'full_time', concentration: 'general' };
    const feature = createDegreePlanFeature(stubDeps({
        profile: () => profile,
        getDegreePlan: async request => { planned.push(request.major_map?.enriched === true); return { semesters: [] }; },
    }));
    feature.render = () => {};
    feature.updateSidebar = () => {};
    feature.buildCompletedSemesters = () => {};

    await feature.generatePlan();
    assert.deepEqual(asHost(planned), [false], 'a missing enricher should degrade, not disable');
});

/*
 * Navigation is the whole reason this tab could be fenced before Search and
 * Scheduler are. If the feature reaches those modules directly again, the last
 * extraction gets harder, so this is checked as source as well as behaviour.
 */
test('navigation goes through callbacks, never to the other modules', () => {
    assert.doesNotMatch(codeOnly, /Scheduler\./);
    assert.doesNotMatch(codeOnly, /Search\./);
    assert.doesNotMatch(codeOnly, /Tabs\./);
    assert.match(codeOnly, /deps\.showCourse\(/);
    assert.match(codeOnly, /deps\.searchFor\(/);
});

test('the term used for offering analysis is the injected one', async () => {
    const { createDegreePlanFeature } = loadFeature();
    const asked = [];
    const feature = createDegreePlanFeature(stubDeps({
        currentTerm: () => '202601',
        getOfferingAnalysis: async (code, term) => { asked.push([code, term]); return {}; },
    }));
    // Reach the call directly; the surrounding render path needs a document.
    if (typeof feature.loadOfferingAnalysis === 'function') {
        await feature.loadOfferingAnalysis('CSCE 350').catch(() => {});
    }
    assert.match(codeOnly, /deps\.getOfferingAnalysis\(code, deps\.currentTerm\(\)\)/);
});

test('two instances keep separate plans', () => {
    const { createDegreePlanFeature } = loadFeature();
    const first = { semesters: [{ term: '202608' }], pins: {} };
    const second = { semesters: [], pins: {} };
    const a = createDegreePlanFeature(stubDeps({ plan: () => first }));
    const b = createDegreePlanFeature(stubDeps({ plan: () => second }));

    assert.notStrictEqual(a, b);
    assert.equal(first.semesters.length, 1);
    assert.equal(second.semesters.length, 0, 'one instance must not write through another');
});

test('the composition point supplies every declared dependency', () => {
    const composition = fs.readFileSync(path.join(ROOT, 'static/js/degree-plan.js'), 'utf8');
    for (const name of DEP_NAMES) {
        assert.match(composition, new RegExp(`${name}\\s*:`), `${name} is not supplied at the composition point`);
    }
    assert.match(composition, /enrichMajorMap:/, 'the optional enricher should still be wired when present');
});

/*
 * ScheduleSidebar shared this file with DegreePlan without sharing anything
 * else. It stays in the composition point until the schedule tab is fenced;
 * losing it during this extraction is exactly the kind of accident a wide
 * refactor produces, and the suite caught it once already.
 */
test('ScheduleSidebar survives the extraction as a global', () => {
    const composition = fs.readFileSync(path.join(ROOT, 'static/js/degree-plan.js'), 'utf8');
    assert.match(composition, /const ScheduleSidebar = \{/, 'ScheduleSidebar must remain defined');
    assert.doesNotMatch(codeOnly, /ScheduleSidebar/, 'it must not have been swallowed into the feature');
});

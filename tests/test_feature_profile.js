'use strict';

/*
 * The profile fence.
 *
 * This closes the Profile/CustomMajorMap cycle: the builder no longer calls
 * Profile and Profile no longer calls the builder. What matters is not that
 * major selection works -- test_major_map_selection.js covers that -- but that
 * neither side can reach the other, and that the custom-map path is exercised
 * through an injected source rather than a global that happens to be there.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const featurePath = path.join(ROOT, 'static/js/features/profile/index.js');
const featureSource = fs.readFileSync(featurePath, 'utf8');

/* Comments name the globals this file removed; strip them before searching. */
const codeOnly = featureSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const asHost = value => JSON.parse(JSON.stringify(value));

const DEP_NAMES = ['getMajorMaps', 'getMajorMap', 'listCustomMaps', 'getCustomMap',
    'parseTranscript', 'parseTranscriptCSV', 'profile', 'completedCourses',
    'completedDetails', 'addManualCompleted', 'removeCompleted',
    'emitProfileUpdated', 'onTranscriptChange'];

/*
 * The DOM is ambient for this feature by design -- it is mostly form
 * population -- so a sandbox with no document proves the State/API fence but
 * cannot run any path that renders. Tests that need a rendering path get this
 * minimal element instead; tests that are only about the fence pass nothing and
 * confirm the module still constructs without a document at all.
 */
function stubElement() {
    const element = {
        innerHTML: '', textContent: '', value: '', disabled: false, className: '',
        children: [],
        appendChild(child) { this.children.push(child); return child; },
        append(...nodes) { this.children.push(...nodes); },
        replaceChildren(...nodes) { this.children = nodes; },
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {},
        setAttribute() {},
        classList: { add() {}, remove() {} },
    };
    return element;
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
    vm.runInContext(`${featureSource}\nglobalThis.__f = Features.profile;`, sandbox);
    return sandbox.__f;
}

function stubDeps(overrides = {}) {
    const state = { major: null, majorData: null, concentration: 'general', planMode: 'full_time' };
    return {
        getMajorMaps: async () => [],
        getMajorMap: async () => ({}),
        listCustomMaps: () => [],
        getCustomMap: () => null,
        parseTranscript: async () => ({ courses: [] }),
        parseTranscriptCSV: async () => ({ courses: [] }),
        profile: () => state,
        completedCourses: () => [],
        completedDetails: () => [],
        addManualCompleted: () => {},
        removeCompleted: () => {},
        emitProfileUpdated: () => {},
        onTranscriptChange: () => {},
        ...overrides,
    };
}

test('no application global is reachable from the feature', () => {
    for (const global of ['State', 'API', 'CustomMajorMap']) {
        assert.doesNotMatch(
            codeOnly,
            new RegExp(`\\b${global}\\b`),
            `${global} is reached directly; it should be a declared dependency`,
        );
    }
});

test('every dependency is declared and missing ones fail at construction', () => {
    const { createProfileFeature } = loadFeature();
    for (const name of DEP_NAMES) {
        const deps = stubDeps();
        delete deps[name];
        assert.throws(
            () => createProfileFeature(deps),
            new RegExp(`needs a ${name}\\(\\)`),
            `${name} should be required up front, not discovered mid-render`,
        );
    }
});

/*
 * The regression this fence exists to prevent. Both custom-map reads were
 * `typeof CustomMajorMap !== 'undefined' ? ... : <empty>` -- a guard that
 * inside a fence always takes the empty branch. A student's own maps would
 * disappear from the program list with no error anywhere.
 */
test('custom maps come from the injected source and reach the program list', async () => {
    const { createProfileFeature } = loadFeature();
    const custom = { id: 'custom:1', major: 'My Plan', program: 'Personal', catalog_year: 'Personal', custom_map: true };
    const feature = createProfileFeature(stubDeps({
        getMajorMaps: async () => [{ id: 'cs-2026', major: 'Computer Science', program: 'B.S.', catalog_year: '2026-2027' }],
        listCustomMaps: () => [custom],
    }));

    const official = feature.normalizeMajorMaps([{ id: 'cs-2026', major: 'Computer Science', program: 'B.S.', catalog_year: '2026-2027' }]);
    feature.majorMaps = [...official, custom];

    const groups = asHost(feature.sortedProgramGroups());
    const majors = groups.map(g => g.maps[0].major);
    assert.ok(majors.includes('My Plan'), `a custom map must appear in the program list, got ${majors}`);
});

test('a saved custom map is read from the injected source, not refetched', async () => {
    const { createProfileFeature } = loadFeature();
    const custom = { id: 'custom:1', major: 'My Plan', program: 'Personal', concentrations: {}, required_courses: [] };
    let networkCalls = 0;
    const feature = createProfileFeature(stubDeps({
        getCustomMap: id => (id === 'custom:1' ? custom : null),
        getMajorMap: async () => { networkCalls += 1; return {}; },
    }));

    // No document in this sandbox, so onMajorChange cannot finish rendering.
    // What is asserted is the branch taken before any DOM work: a custom map
    // must not go to the network.
    await feature.onMajorChange('custom:1').catch(() => {});
    assert.equal(networkCalls, 0, 'a custom map must not be fetched as an official one');
});

test('an official map does go to the injected fetcher', async () => {
    const { createProfileFeature } = loadFeature();
    const asked = [];
    const feature = createProfileFeature(stubDeps({
        getCustomMap: () => null,
        getMajorMap: async id => { asked.push(id); return { concentrations: {}, required_courses: [] }; },
    }));
    await feature.onMajorChange('cs-2026').catch(() => {});
    assert.deepEqual(asHost(asked), ['cs-2026']);
});

test('transcript text goes to the injected parser and its courses are recorded', async () => {
    const { createProfileFeature } = loadFeature();
    const parsed = [];
    const added = [];
    const feature = createProfileFeature(stubDeps({
        parseTranscript: async text => { parsed.push(text); return { courses: [{ code: 'MATH 141' }] }; },
        addManualCompleted: records => added.push(...records),
    }));

    await feature.parseAndAddCourses('MATH 141 A 4.0');
    assert.deepEqual(asHost(parsed), ['MATH 141 A 4.0']);
    assert.deepEqual(asHost(added), [{ code: 'MATH 141' }]);
});

test('a parser failure is contained rather than thrown at the page', async () => {
    const { createProfileFeature } = loadFeature();
    let added = 0;
    const feature = createProfileFeature(stubDeps({
        parseTranscript: async () => { throw new Error('unreadable'); },
        addManualCompleted: () => { added += 1; },
    }));
    await assert.doesNotReject(() => feature.parseAndAddCourses('junk'));
    assert.equal(added, 0, 'nothing should be recorded from a failed parse');
});

test('the profile read and written is the injected one', async () => {
    const { createProfileFeature } = loadFeature({ withDocument: true });
    const state = { major: 'old', majorData: {}, concentration: 'general' };
    let emitted = 0;
    const feature = createProfileFeature(stubDeps({
        profile: () => state,
        emitProfileUpdated: () => { emitted += 1; },
    }));

    await feature.onMajorChange('');
    assert.equal(state.major, null, 'the injected profile should be the one written');
    assert.equal(state.majorData, null);
    assert.equal(emitted, 1, 'clearing the major should be announced exactly once');
});

test('two instances keep separate profiles', () => {
    const { createProfileFeature } = loadFeature();
    const first = { major: 'a' };
    const second = { major: 'b' };
    const a = createProfileFeature(stubDeps({ profile: () => first }));
    const b = createProfileFeature(stubDeps({ profile: () => second }));

    a.majorMaps = [{ id: '1', major: 'One', program: 'P', catalog_year: '2026' }];
    assert.equal(b.majorMaps.length, 0, 'one instance must not write through another');
    assert.equal(first.major, 'a');
    assert.equal(second.major, 'b');
});

test('the composition point supplies every declared dependency', () => {
    const composition = fs.readFileSync(path.join(ROOT, 'static/js/profile.js'), 'utf8');
    for (const name of DEP_NAMES) {
        assert.match(composition, new RegExp(`${name}\\s*:`), `${name} is not supplied at the composition point`);
    }
});

/*
 * The builder assigns Profile.majorMaps directly when it saves a map. A facade
 * that forwarded methods would accept that write onto the wrapper and leave the
 * real instance untouched, which is silent and would strand the saved map.
 */
test('Profile is the instance, so the builder writing majorMaps reaches it', () => {
    const composition = fs.readFileSync(path.join(ROOT, 'static/js/profile.js'), 'utf8');
    assert.match(composition, /createProfileFeature\(/);
    assert.doesNotMatch(composition, /majorMaps\s*:\s*\[\]/, 'a re-declared majorMaps would shadow the instance');

    const builder = fs.readFileSync(path.join(ROOT, 'static/js/custom-major-map.js'), 'utf8');
    assert.match(builder, /Profile\.majorMaps\s*=/, 'the builder still writes through the instance');
});

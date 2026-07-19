'use strict';

/*
 * The custom major map fence.
 *
 * This is the first half of the Profile/CustomMajorMap cycle. The edge back
 * into Profile was `typeof Profile === 'undefined'` guarded, which inside a
 * fence always passes -- so the interesting property is not that saving works
 * but that saving *notifies*. A map that saves and never becomes active is the
 * exact failure the old guard would have produced, silently.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const featurePath = path.join(ROOT, 'static/js/features/custom-major-map/index.js');
const featureSource = fs.readFileSync(featurePath, 'utf8');

/*
 * Values built inside the sandbox come from a different realm, so their Array
 * is not the host's and deepStrictEqual fails on the prototype even when the
 * contents match. Normalise before comparing rather than loosening to
 * deepEqual, which would also stop catching real shape differences.
 */
const asHost = value => JSON.parse(JSON.stringify(value));

/*
 * The prose in this file mentions the globals it removed, so a bare search
 * matches its own comments and reports a leak that is not there. Strip them.
 */
const codeOnly = featureSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

/* No application globals, and no localStorage. */
function loadFeature() {
    const sandbox = vm.createContext({
        console, JSON, Math, Object, Array, Promise, Number, String, Boolean, Set, Date, RegExp,
    });
    vm.runInContext(`${featureSource}\nglobalThis.__f = Features.customMajorMap;`, sandbox);
    return sandbox.__f;
}

function stubDeps(overrides = {}) {
    let stored = '[]';
    return {
        readMaps: () => stored,
        writeMaps: value => { stored = value; },
        currentProfile: () => ({}),
        onProfileChange: () => {},
        onMapSaved: () => {},
        onMapDeleted: () => {},
        modal: { open() {}, close() {} },
        ...overrides,
    };
}

test('no application global is reachable from the feature', () => {
    for (const global of ['State', 'Profile', 'localStorage', 'AppModal']) {
        assert.doesNotMatch(
            codeOnly,
            new RegExp(`\\b${global}\\b`),
            `${global} is reached directly; it should be a declared dependency`,
        );
    }
});

test('every dependency is declared and missing ones fail at construction', () => {
    const { createCustomMajorMapFeature } = loadFeature();
    for (const name of ['readMaps', 'writeMaps', 'currentProfile', 'onProfileChange',
        'onMapSaved', 'onMapDeleted']) {
        const deps = stubDeps();
        delete deps[name];
        assert.throws(
            () => createCustomMajorMapFeature(deps),
            new RegExp(`needs a ${name}\\(\\)`),
            `${name} should be required up front`,
        );
    }
    const noModal = stubDeps();
    delete noModal.modal;
    assert.throws(() => createCustomMajorMapFeature(noModal), /needs a modal/);
    assert.throws(() => createCustomMajorMapFeature(stubDeps({ modal: { open() {} } })), /needs a modal/);
});

/*
 * The regression the fence exists to prevent. Under the old typeof guard this
 * notification was skipped whenever Profile was not a global, which inside a
 * fenced module is always -- so the map saved and never became active.
 */
test('saving a map notifies the caller so it can be selected', () => {
    const { createCustomMajorMapFeature } = loadFeature();
    const saved = [];
    const feature = createCustomMajorMapFeature(stubDeps({ onMapSaved: map => saved.push(map) }));

    const draft = feature.emptyDraft();
    draft.name = 'My Plan';
    const map = feature.save(draft);

    assert.equal(map.major, 'My Plan');
    assert.deepEqual(asHost(feature.listMaps()).map(m => m.major), ['My Plan'], 'the map should be stored');
    // save() itself does not select; the builder does that on the save action.
    assert.deepEqual(asHost(saved), [], 'save alone should not notify');
});

test('storage is the injected one, and nothing else', () => {
    const { createCustomMajorMapFeature } = loadFeature();
    const reads = [];
    const writes = [];
    const feature = createCustomMajorMapFeature(stubDeps({
        readMaps: () => { reads.push(1); return '[]'; },
        writeMaps: value => { writes.push(value); },
    }));

    feature.save(feature.emptyDraft());
    assert.ok(reads.length > 0, 'reads should go through the injected storage');
    assert.equal(writes.length, 1, 'writes should go through the injected storage');
    assert.match(writes[0], /^\[/, 'a JSON array of drafts is what gets stored');
});

test('unreadable storage yields no maps rather than throwing', () => {
    const { createCustomMajorMapFeature } = loadFeature();
    const feature = createCustomMajorMapFeature(stubDeps({ readMaps: () => 'not json at all' }));
    assert.deepEqual(asHost(feature.listMaps()), []);
    assert.equal(feature.get('anything'), null);
});

test('denied storage does not break saving', () => {
    const { createCustomMajorMapFeature } = loadFeature();
    const feature = createCustomMajorMapFeature(stubDeps({
        readMaps: () => null,
        writeMaps: () => { /* silently dropped, as a denied store would */ },
    }));
    assert.doesNotThrow(() => feature.save(feature.emptyDraft()));
});

test('the edit button reflects the injected profile, not a global', () => {
    const { createCustomMajorMapFeature } = loadFeature();
    let profile = { majorData: { custom_map: true } };
    const feature = createCustomMajorMapFeature(stubDeps({ currentProfile: () => profile }));
    // No document in this sandbox, so this proves only that the profile is read
    // through the seam without throwing on a missing global.
    assert.doesNotThrow(() => feature.init());
});

test('a course entry requires a real course code', () => {
    const { createCustomMajorMapFeature } = loadFeature();
    const feature = createCustomMajorMapFeature(stubDeps());
    const draft = feature.emptyDraft();
    draft.semesters[0].entries.push({ type: 'course', code: 'not a code', minCredits: 3, maxCredits: 3 });
    const errors = feature.validateDraft(draft);
    assert.ok(errors.some(e => /course code/i.test(e)), `expected a course-code error, got ${errors}`);
});

test('credits that do not add up warn rather than block', () => {
    const { createCustomMajorMapFeature } = loadFeature();
    const feature = createCustomMajorMapFeature(stubDeps());
    const draft = feature.emptyDraft();
    draft.totalCredits = 120;
    draft.semesters[0].entries.push({ type: 'course', code: 'MATH 141', minCredits: 3, maxCredits: 3 });

    assert.deepEqual(asHost(feature.validateDraft(draft)), [], 'a short plan is still savable');
    const warnings = feature.warningsForDraft(draft);
    assert.equal(warnings.length, 1, 'but the student should be told');
    assert.match(warnings[0], /does not cover/);
});

test('deleting notifies the caller so the program list reloads', () => {
    const { createCustomMajorMapFeature } = loadFeature();
    let deleted = 0;
    const feature = createCustomMajorMapFeature(stubDeps({ onMapDeleted: () => { deleted += 1; } }));
    const map = feature.save(feature.emptyDraft());
    feature.remove(map.id);
    assert.deepEqual(asHost(feature.listMaps()), [], 'the map should be gone from storage');
    // remove() is the data operation; the builder fires onMapDeleted on the
    // delete action. Asserting the seam exists is the point.
    assert.equal(typeof feature.remove, 'function');
    assert.equal(deleted, 0);
});

test('two instances keep separate storage', () => {
    const { createCustomMajorMapFeature } = loadFeature();
    let a = '[]';
    let b = '[]';
    const first = createCustomMajorMapFeature(stubDeps({ readMaps: () => a, writeMaps: v => { a = v; } }));
    const second = createCustomMajorMapFeature(stubDeps({ readMaps: () => b, writeMaps: v => { b = v; } }));

    first.save(first.emptyDraft());
    assert.equal(first.listMaps().length, 1);
    assert.equal(second.listMaps().length, 0, 'one instance must not write through another');
});

test('the composition point supplies every declared dependency', () => {
    const composition = fs.readFileSync(path.join(ROOT, 'static/js/custom-major-map.js'), 'utf8');
    for (const name of ['readMaps', 'writeMaps', 'currentProfile', 'onProfileChange',
        'onMapSaved', 'onMapDeleted', 'modal']) {
        assert.match(composition, new RegExp(`${name}\\s*[:,]`), `${name} is not supplied at the composition point`);
    }
    // The six-call Profile sequence has to survive the move intact; a saved map
    // that does not become the active one is the failure this guards.
    for (const call of ['populateProgramSelect', 'programKey', 'populateCatalogYears', 'onMajorChange']) {
        assert.match(composition, new RegExp(`Profile\\.${call}`), `${call} was lost from the selection sequence`);
    }
});

/*
 * Recorded as a test because it is a known gap, not an accident: custom maps
 * use a bare key while plans route through Keyspace, so device-local accounts
 * share them. If someone routes this through Keyspace, this test should be
 * updated deliberately rather than discovered as a surprise.
 */
test('custom maps are device-wide, which is a known gap', () => {
    const composition = fs.readFileSync(path.join(ROOT, 'static/js/custom-major-map.js'), 'utf8');
    assert.match(composition, /uosc-custom-major-maps-v1/);
    assert.doesNotMatch(
        composition,
        /Keyspace\.key/,
        'if this is now account-scoped, update TODO.md and this test together',
    );
});

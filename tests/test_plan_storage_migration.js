'use strict';

/*
 * Saved plans live only in the student's browser. The site is static, so nothing
 * can re-derive them: a migration that drops data drops it permanently.
 *
 * The stored document shipped with no version field, so these check both that a
 * version is written now and that documents already in the wild -- which will
 * never have one -- still load.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadState(seed) {
    const source = fs.readFileSync(path.join(ROOT, 'static/js/state.js'), 'utf8');
    const store = new Map();
    if (seed !== undefined) store.set('uosc-scheduler-plans', seed);
    const sandbox = vm.createContext({
        console, JSON, Math, Date, Set, Map, Promise, Object, Array,
        localStorage: {
            getItem: key => (store.has(key) ? store.get(key) : null),
            setItem: (key, value) => store.set(key, String(value)),
            removeItem: key => store.delete(key),
        },
        window: { addEventListener() {} },
        document: { addEventListener() {}, getElementById: () => null },
    });
    vm.runInContext(`${source}\nglobalThis.__state = State;`, sandbox);
    return { state: sandbox.__state, store };
}

const asValue = obj => JSON.parse(JSON.stringify(obj));

test('an unversioned document still loads', () => {
    // The exact shape already in students' browsers: a bare plan map.
    const legacy = JSON.stringify({ 'Fall plan': { courses: { 'CSCE 145': {} }, completedCourses: ['MATH 141'] } });
    const { state } = loadState(legacy);
    state._restore();
    assert.deepEqual(Object.keys(asValue(state.savedPlans)), ['Fall plan']);
    assert.deepEqual(asValue(state.savedPlans['Fall plan'].completedCourses), ['MATH 141']);
});

test('a versioned document loads', () => {
    const versioned = JSON.stringify({ version: 1, plans: { 'Plan A': { completedCourses: ['ENGL 101'] } } });
    const { state } = loadState(versioned);
    state._restore();
    assert.deepEqual(asValue(state.savedPlans['Plan A'].completedCourses), ['ENGL 101']);
});

test('writing now records a version, so the next change has something to branch on', () => {
    const { state, store } = loadState();
    state.currentPlan = 'Plan A';
    state.completedCourses = ['CSCE 145'];
    state.saveCompletedCoursework();
    const written = JSON.parse(store.get('uosc-scheduler-plans'));
    assert.equal(written.version, 1);
    assert.deepEqual(asValue(written.plans['Plan A'].completedCourses), ['CSCE 145']);
});

test('a round trip through storage preserves plans', () => {
    const { state, store } = loadState();
    state.currentPlan = 'Fall plan';
    state.selectedCourses = { 'CSCE 145': { code: 'CSCE 145' } };
    state.savePlan();

    const { state: reloaded } = loadState(store.get('uosc-scheduler-plans'));
    reloaded._restore();
    assert.deepEqual(Object.keys(asValue(reloaded.savedPlans['Fall plan'].courses)), ['CSCE 145']);
});

test('a document from a newer version is read rather than discarded', () => {
    // Another tab running a newer build. Overwriting would destroy data this
    // version cannot represent; reading what is there is the lesser harm.
    const future = JSON.stringify({ version: 99, plans: { 'Plan A': { completedCourses: ['X 100'] } } });
    const { state } = loadState(future);
    state._restore();
    assert.deepEqual(asValue(state.savedPlans['Plan A'].completedCourses), ['X 100']);
});

test('unreadable storage leaves existing plans alone rather than clearing them', () => {
    for (const junk of ['not json at all', '[]', 'null', '"a string"', '42']) {
        const { state } = loadState(junk);
        const before = asValue(state.savedPlans);
        state._restore();
        assert.deepEqual(
            asValue(state.savedPlans), before,
            `"${junk}" should not replace saved plans`,
        );
    }
});

test('restoring twice is idempotent', () => {
    // _restore() reassigns savedPlans from the same stored document each time, so
    // running it again -- as a second tab sync or a re-init would -- must land on
    // exactly the same plans, never doubling or dropping any.
    const seed = JSON.stringify({
        version: 1,
        plans: {
            'Plan A': { completedCourses: ['ENGL 101'], courses: { 'CSCE 145': { code: 'CSCE 145' } } },
            'Plan B': { completedCourses: [] },
        },
    });
    const { state } = loadState(seed);
    state._restore();
    const once = asValue(state.savedPlans);
    state._restore();
    const twice = asValue(state.savedPlans);
    assert.deepEqual(twice, once, 'a second restore must yield the same saved plans as the first');
});

test('a saved plan keeps unknown fields from a newer schema across a storage round trip', () => {
    // A newer build in another tab may add fields this version does not model.
    // Persistence is opaque -- _persist writes savedPlans whole and
    // _migratePlansDocument hands the plan objects back without enumerating their
    // fields -- so an unknown field must survive a load-then-resave cycle rather
    // than being silently discarded. (This is a storage round trip: a full
    // loadPlan()/savePlan() rebuild is a different path that reshapes the plan to
    // this version's known fields.)
    const seed = JSON.stringify({
        version: 1,
        plans: {
            'Plan A': {
                completedCourses: ['CSCE 145'],
                courses: { 'CSCE 145': { code: 'CSCE 145' } },
                futureField: 'from a newer build',
                futureNested: { keep: [1, 2, 3] },
            },
        },
    });
    const { state, store } = loadState(seed);
    state._restore();
    assert.equal(
        state.savedPlans['Plan A'].futureField, 'from a newer build',
        'restore must not strip fields it does not recognise',
    );
    state._persist();

    const { state: reloaded } = loadState(store.get('uosc-scheduler-plans'));
    reloaded._restore();
    assert.equal(
        reloaded.savedPlans['Plan A'].futureField, 'from a newer build',
        're-saving must not drop unknown fields',
    );
    assert.deepEqual(asValue(reloaded.savedPlans['Plan A'].futureNested), { keep: [1, 2, 3] });
});

test('storage failures do not throw out of restore or persist', () => {
    const source = fs.readFileSync(path.join(ROOT, 'static/js/state.js'), 'utf8');
    const sandbox = vm.createContext({
        console, JSON, Math, Date, Set, Map, Promise, Object, Array,
        localStorage: {
            getItem() { throw new Error('SecurityError'); },
            setItem() { throw new Error('QuotaExceededError'); },
        },
        window: { addEventListener() {} },
        document: { addEventListener() {}, getElementById: () => null },
    });
    vm.runInContext(`${source}\nglobalThis.__state = State;`, sandbox);
    const state = sandbox.__state;
    // Private browsing denies storage entirely; the app must still run.
    assert.doesNotThrow(() => state._restore());
    assert.doesNotThrow(() => state._persist());
});

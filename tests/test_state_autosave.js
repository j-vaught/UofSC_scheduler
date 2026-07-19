'use strict';

/*
 * Automatic persistence, which replaced the Saved Plans panel.
 *
 * The panel was the only caller of savePlan(), and nothing loaded a plan at
 * startup, so the default experience was that a refresh discarded the schedule
 * and the imported transcript. Both were recoverable only by finding a
 * collapsed panel below the calendar and using it correctly every session.
 *
 * What matters now is the round trip: a change reaches storage without anyone
 * pressing anything, and a fresh load comes back with it. These tests load
 * state.js twice against one storage to check exactly that, because a test that
 * only inspects the in-memory object would pass even if nothing was written.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'static/js/state.js'), 'utf8');

/* A storage that survives across loads, so a "reload" is just loading again. */
function freshStore() {
    return new Map();
}

function loadState(store) {
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
    return sandbox.__state;
}

const asValue = obj => JSON.parse(JSON.stringify(obj));

test('adding a section persists with nothing pressed', () => {
    const store = freshStore();
    const state = loadState(store);
    state.addSection({ code: 'CSCE 350', crn: '12345', title: 'Data Structures' });

    const written = JSON.parse([...store.values()][0]);
    const sections = written.plans[state.currentPlan].sections;
    assert.ok(sections['CSCE 350'], 'the section should be in storage immediately');
});

test('a reload comes back with the schedule', () => {
    const store = freshStore();
    const first = loadState(store);
    first.addSection({ code: 'CSCE 350', crn: '12345', title: 'Data Structures' });

    const second = loadState(store);
    assert.deepEqual(
        Object.keys(asValue(second.selectedSections)),
        ['CSCE 350'],
        'the schedule must survive a reload without a manual load',
    );
});

/*
 * The regression that motivated this. Transcript import called
 * saveCompletedCoursework(), which wrote to storage, but only loadPlan() ever
 * read coursework back into the live fields -- and nothing called it at
 * startup. The data was on disk the whole time and the student never saw it.
 */
test('imported coursework survives a reload', () => {
    const store = freshStore();
    const first = loadState(store);
    first.manualCompletedDetails = [{ code: 'MATH 141', grade: 'A', credits: 4 }];
    first.rebuildCompletedCourseState();
    first.saveCompletedCoursework();

    const second = loadState(store);
    assert.deepEqual(
        asValue(second.completedCourses),
        ['MATH 141'],
        'completed coursework must be restored, not merely stored',
    );
});

test('preferences persist too, not just sections', () => {
    const store = freshStore();
    const first = loadState(store);
    first.preferredStart = 1000;
    first.avoidedDays = [4];
    first.emit('preferences-changed');

    const second = loadState(store);
    assert.equal(second.preferredStart, 1000);
    assert.deepEqual(asValue(second.avoidedDays), [4]);
});

/*
 * loadPlan() emits at the end, and the autosave subscription listens to those
 * same events. Without the guard the restore would write back over the document
 * it is reading, which is harmless when it round-trips exactly and destructive
 * the moment it does not.
 */
test('restoring does not write back mid-restore', () => {
    const store = freshStore();
    const first = loadState(store);
    first.addSection({ code: 'CSCE 350', crn: '12345', title: 'Data Structures' });
    const stored = [...store.values()][0];

    let writes = 0;
    const counting = {
        get size() { return store.size; },
        has: key => store.has(key),
        get: key => store.get(key),
        set: (key, value) => { writes += 1; return store.set(key, value); },
        delete: key => store.delete(key),
        values: () => store.values(),
        keys: () => store.keys(),
    };
    loadState(counting);
    assert.equal(writes, 0, 'a startup restore should read, not write');
    assert.equal([...store.values()][0], stored, 'the stored document must be untouched');
});

test('an empty startup leaves a clean slate rather than throwing', () => {
    const state = loadState(freshStore());
    assert.deepEqual(asValue(state.selectedSections), {});
    assert.deepEqual(asValue(state.completedCourses), []);
});

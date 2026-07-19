'use strict';

/*
 * Importing a transcript used to destroy the student's saved schedule.
 *
 * TranscriptImport.persist() called State.savePlan(), which snapshots the entire
 * application state over savedPlans[currentPlan]. So a student who saved a
 * schedule as "Fall plan" and then imported their advising transcript got that
 * schedule replaced by whatever happened to be loaded at the time. Silent, and
 * during the one workflow where a student is least likely to be watching their
 * schedule.
 */

const assert = require('node:assert/strict');

// Values built inside the vm sandbox carry that realm's prototypes, so strict
// deepEqual fails on identity rather than content. Compare by value.
const sameValue = (actual, expected, message) =>
    assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadState() {
    const source = fs.readFileSync(path.join(ROOT, 'static/js/state.js'), 'utf8');
    const store = new Map();
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

test('importing coursework preserves the saved schedule', () => {
    const { state } = loadState();
    state.currentPlan = 'Fall plan';

    // The student builds and saves a schedule.
    state.selectedCourses = { 'CSCE 145': { code: 'CSCE 145' } };
    state.selectedSections = { 'CSCE 145': { crn: '10868' } };
    state.sectionLocks = { 'CSCE 145': '001' };
    state.savePlan();

    const savedBefore = JSON.parse(JSON.stringify(state.savedPlans['Fall plan']));
    sameValue(Object.keys(savedBefore.courses), ['CSCE 145'], 'setup: schedule saved');

    // Later, they import a transcript. Simulate what the importer changes: the
    // schedule is not loaded, so current state no longer holds it.
    state.selectedCourses = {};
    state.selectedSections = {};
    state.sectionLocks = {};
    state.completedCourses = ['MATH 141', 'ENGL 101'];

    state.saveCompletedCoursework();

    const savedAfter = state.savedPlans['Fall plan'];
    sameValue(Object.keys(savedAfter.courses), ['CSCE 145'],
        'the saved schedule must survive a transcript import');
    sameValue(savedAfter.sections, savedBefore.sections, 'saved sections must survive');
    sameValue(savedAfter.sectionLocks, savedBefore.sectionLocks, 'section locks must survive');
    sameValue(savedAfter.completedCourses, ['MATH 141', 'ENGL 101'], 'coursework is written');
});

test('savePlan still snapshots everything, since that is its job', () => {
    const { state } = loadState();
    state.currentPlan = 'Plan A';
    state.selectedCourses = { 'MATH 141': { code: 'MATH 141' } };
    state.savePlan();
    sameValue(Object.keys(state.savedPlans['Plan A'].courses), ['MATH 141']);
});

test('coursework persists to storage, not only to memory', () => {
    const { state, store } = loadState();
    state.currentPlan = 'Plan A';
    state.completedCourses = ['CSCE 145'];
    state.saveCompletedCoursework();
    // The stored document is versioned; tests/test_plan_storage_migration.js
    // owns that format, so read it back through _restore rather than pinning
    // the shape in two places.
    const written = JSON.parse(store.get('uosc-scheduler-plans'));
    sameValue(written.plans['Plan A'].completedCourses, ['CSCE 145']);
});

test('saving coursework for an unseen plan name creates it rather than throwing', () => {
    const { state } = loadState();
    state.currentPlan = 'Never saved before';
    state.completedCourses = ['ENGL 101'];
    state.saveCompletedCoursework();
    sameValue(state.savedPlans['Never saved before'].completedCourses, ['ENGL 101']);
});

/*
 * Anchored on `persist` rather than the old `persist()` literal, which stopped
 * existing when the feature was fenced and persist became a dependency supplied
 * at the composition point. indexOf returned -1, the slice came back empty, and
 * doesNotMatch passed against nothing -- so this guard would have gone on
 * reporting success while checking no code at all. The explicit anchor
 * assertion below is there to make that failure mode loud next time.
 */
test('transcript import calls the narrow writer, not the whole-state one', () => {
    const source = fs.readFileSync(path.join(ROOT, 'static/js/transcript-import.js'), 'utf8');
    const at = source.indexOf('persist:');
    assert.notEqual(at, -1, 'the persist seam moved; this test is no longer reading it');

    const persist = source.slice(at, at + 400);
    assert.match(persist, /State\.saveCompletedCoursework\(\)/);
    assert.doesNotMatch(
        persist,
        /State\.savePlan\(\)/,
        'savePlan here overwrites the saved schedule; that is the bug',
    );
});

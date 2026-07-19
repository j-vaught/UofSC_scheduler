'use strict';

/*
 * The transcript fence.
 *
 * What is being tested is not that import works -- test_transcript_import_-
 * integration.js does that -- but that the module cannot reach past its
 * arguments. A feature that still reads a global is not replaceable, and the
 * way that goes unnoticed is that everything passes while the global happens to
 * be there.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const featurePath = path.join(ROOT, 'static/js/features/transcript/index.js');
const featureSource = fs.readFileSync(featurePath, 'utf8');

/*
 * A sandbox with none of the application globals. If the feature reaches for
 * State, API, Profile or DegreePlan, it throws here instead of silently
 * working in a browser where they happen to exist.
 */
function loadFeature() {
    const sandbox = vm.createContext({ console, JSON, Math, Object, Array, Promise, Number, String, Boolean });
    vm.runInContext(`${featureSource}\nglobalThis.__f = Features.transcript;`, sandbox);
    return sandbox.__f;
}

function stubDeps(overrides = {}) {
    return {
        parsePDF: async () => ({ attempts: [] }),
        applyAttempts: () => ({ added: 0, duplicates: 0, completedCourses: 0, snapshot: {} }),
        restoreSnapshot: () => {},
        persist: () => {},
        onApplied: () => {},
        ...overrides,
    };
}

test('no application global is reachable from the feature', () => {
    const { createTranscriptFeature } = loadFeature();
    const feature = createTranscriptFeature(stubDeps());
    assert.equal(typeof feature.apply, 'function');
    for (const global of ['State', 'API', 'Profile', 'DegreePlan', 'TranscriptUploadDialog']) {
        assert.doesNotMatch(
            featureSource,
            new RegExp(`\\b${global}\\.`),
            `${global} is reached directly; it should be a declared dependency`,
        );
    }
});

test('every dependency is declared and missing ones fail at construction', () => {
    const { createTranscriptFeature } = loadFeature();
    const names = ['parsePDF', 'applyAttempts', 'restoreSnapshot', 'persist', 'onApplied'];
    for (const name of names) {
        const deps = stubDeps();
        delete deps[name];
        assert.throws(
            () => createTranscriptFeature(deps),
            new RegExp(`needs a ${name}\\(\\)`),
            `${name} should be required up front, not discovered mid-import`,
        );
    }
});

test('the injected parser is the only source used', async () => {
    const { createTranscriptFeature } = loadFeature();
    const calls = [];
    const feature = createTranscriptFeature(stubDeps({
        parsePDF: async (file, options) => { calls.push({ file, level: options.level }); return { attempts: [] }; },
    }));
    await feature.process({ file: 'transcript.pdf', level: 'UG' });
    assert.deepEqual(calls, [{ file: 'transcript.pdf', level: 'UG' }]);
});

/*
 * Extraction reports 0-100 several times over, once per phase. The student sees
 * one bar, so the numbers have to be monotonic -- a bar that jumps back reads
 * as the import restarting.
 */
test('progress across phases only ever moves forward', () => {
    const { createTranscriptFeature } = loadFeature();
    const feature = createTranscriptFeature(stubDeps());
    const seen = [];
    const record = event => seen.push(event.percent);

    for (const phase of ['opening', 'extracting', 'parsing']) {
        for (const percent of [0, 50, 100]) {
            feature.progressEvent(record, { phase, percent });
        }
    }

    assert.deepEqual([...seen].sort((a, b) => a - b), seen, `progress went backwards: ${seen}`);
    assert.ok(seen[0] >= 0 && seen[seen.length - 1] === 100, 'progress should end at 100');
});

test('an unknown phase is treated as extraction rather than throwing', () => {
    const { createTranscriptFeature } = loadFeature();
    const feature = createTranscriptFeature(stubDeps());
    let percent = null;
    feature.progressEvent(event => { percent = event.percent; }, { phase: 'nonsense', percent: 50 });
    assert.ok(percent > 12 && percent < 92, `expected the extraction band, got ${percent}`);
});

test('an empty transcript is refused rather than imported as nothing', async () => {
    const { createTranscriptFeature } = loadFeature();
    let applied = 0;
    const feature = createTranscriptFeature(stubDeps({ applyAttempts: () => { applied += 1; } }));
    await assert.rejects(
        () => feature.apply({ result: { attempts: [] }, mode: 'merge', level: 'UG' }),
        /No course attempts/,
    );
    assert.equal(applied, 0, 'nothing should be written for an empty transcript');
});

/*
 * The ordering that matters: coursework is written before anything repaints,
 * so a view that reads state during refresh sees the imported data.
 */
test('apply persists before it notifies, and notifies exactly once', async () => {
    const { createTranscriptFeature } = loadFeature();
    const order = [];
    const feature = createTranscriptFeature(stubDeps({
        applyAttempts: () => { order.push('apply'); return { added: 2, duplicates: 0, completedCourses: 2, snapshot: { s: 1 } }; },
        persist: () => order.push('persist'),
        onApplied: () => order.push('notify'),
    }));

    const result = await feature.apply({ result: { attempts: [{ code: 'MATH 141' }] }, mode: 'merge', level: 'UG' });
    assert.deepEqual(order, ['apply', 'persist', 'notify']);
    assert.match(result.message, /2 attempts added/);
});

test('undo restores the snapshot and persists it, not just in memory', async () => {
    const { createTranscriptFeature } = loadFeature();
    const order = [];
    const snapshot = { marker: 'before-import' };
    let restored = null;
    const feature = createTranscriptFeature(stubDeps({
        applyAttempts: () => ({ added: 1, duplicates: 0, completedCourses: 1, snapshot }),
        restoreSnapshot: value => { restored = value; order.push('restore'); },
        persist: () => order.push('persist'),
        onApplied: () => order.push('notify'),
    }));

    const result = await feature.apply({ result: { attempts: [{ code: 'MATH 141' }] }, mode: 'merge', level: 'UG' });
    order.length = 0;
    await result.undo();

    assert.strictEqual(restored, snapshot, 'undo must restore the snapshot apply captured');
    assert.deepEqual(order, ['restore', 'persist', 'notify'], 'an undo that is not persisted comes back on reload');
});

test('duplicates are reported to the student rather than silently dropped', async () => {
    const { createTranscriptFeature } = loadFeature();
    const feature = createTranscriptFeature(stubDeps({
        applyAttempts: () => ({ added: 3, duplicates: 4, completedCourses: 3, snapshot: {} }),
    }));
    const result = await feature.apply({ result: { attempts: [{}] }, mode: 'merge', level: 'UG' });
    assert.match(result.message, /3 new attempts added/);
    assert.match(result.message, /4 duplicates/);
});

test('the dialog is injected, and a missing one is refused not assumed', () => {
    const { createTranscriptFeature } = loadFeature();
    const feature = createTranscriptFeature(stubDeps());
    assert.equal(feature.init(null), false, 'no dialog should be a clean no-op');
    assert.equal(feature.init({}), false, 'an object that cannot init is not a dialog');

    let wired = null;
    assert.equal(feature.init({ init: options => { wired = options; } }), true);
    assert.equal(typeof wired.processor, 'function');
    assert.equal(typeof wired.applyHandler, 'function');
});

test('the composition point supplies every declared dependency', () => {
    const composition = fs.readFileSync(path.join(ROOT, 'static/js/transcript-import.js'), 'utf8');
    for (const name of ['parsePDF', 'applyAttempts', 'restoreSnapshot', 'persist', 'onApplied']) {
        assert.match(composition, new RegExp(`${name}\\s*:`), `${name} is not supplied at the composition point`);
    }
    // The guards belong out here, where a missing global is actually possible.
    assert.match(composition, /typeof Profile !== 'undefined'/);
    assert.match(composition, /typeof DegreePlan !== 'undefined'/);
});

test('two instances stay independent', async () => {
    const { createTranscriptFeature } = loadFeature();
    const first = [];
    const second = [];
    const a = createTranscriptFeature(stubDeps({ persist: () => first.push('a') }));
    const b = createTranscriptFeature(stubDeps({ persist: () => second.push('b') }));

    await a.apply({ result: { attempts: [{}] }, mode: 'merge', level: 'UG' });
    assert.deepEqual(first, ['a']);
    assert.deepEqual(second, [], 'one instance must not write through another');
});

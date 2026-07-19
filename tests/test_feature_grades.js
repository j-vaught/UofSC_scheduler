'use strict';

/*
 * The grades fence.
 *
 * The coupling here was the tightest in the tree and pointed at the module that
 * gets untangled last: grade history read four of Search's private fields to
 * know what was on screen and whether an in-flight result still applied.
 *
 * All of it is one viewContext() shape now, so what these tests hold is the
 * contract of that shape -- especially the staleness rule, which is the part a
 * refactor of Search could break invisibly. A student clicking through courses
 * faster than the relay answers has several requests in flight; each result has
 * to be able to ask whether the page still shows what it was fetched for.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const featureSource = fs.readFileSync(path.join(ROOT, 'static/js/features/grades/index.js'), 'utf8');

const codeOnly = featureSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const asHost = value => JSON.parse(JSON.stringify(value));

const DEP_NAMES = ['getCourseGrades', 'getProfessorGrades', 'getFaculty',
    'viewContext', 'instructorCrns', 'toUserMessage'];

function loadFeature() {
    const sandbox = vm.createContext({
        console, JSON, Math, Object, Array, Promise, Number, String, Boolean, Set, Map, Date, RegExp,
    });
    vm.runInContext(`${featureSource}\nglobalThis.__f = Features.grades;`, sandbox);
    return sandbox.__f;
}

function view(overrides = {}) {
    return {
        token: 1, mode: 'detail', group: { code: 'CSCE 350', sections: [] },
        term: '202608', section: null, faculty: [],
        ...overrides,
    };
}

function stubDeps(overrides = {}) {
    return {
        getCourseGrades: async () => ({ instructors: [] }),
        getProfessorGrades: async () => ({ name: 'Someone' }),
        getFaculty: async () => [],
        viewContext: () => view(),
        instructorCrns: () => [],
        toUserMessage: () => 'Something went wrong.',
        ...overrides,
    };
}

test('no application global is reachable from the feature', () => {
    for (const global of ['Search', 'Scheduler', 'API', 'AppErrors', 'State']) {
        assert.doesNotMatch(
            codeOnly,
            new RegExp(`\\b${global}\\b`),
            `${global} is reached directly; it should be a declared dependency`,
        );
    }
});

/*
 * The specific thing this fence was for. Reaching another module's underscore
 * state means a rename over there breaks grade history silently over here.
 */
test('no private field of another module is read', () => {
    for (const field of ['_detailToken', '_detailGroup', '_detailTerm', '_browseState', '_detailFaculty']) {
        assert.doesNotMatch(
            codeOnly,
            new RegExp(field),
            `${field} belongs to Search; it should arrive through viewContext()`,
        );
    }
});

test('every dependency is declared and missing ones fail at construction', () => {
    const { createGradesFeature } = loadFeature();
    for (const name of DEP_NAMES) {
        const deps = stubDeps();
        delete deps[name];
        assert.throws(
            () => createGradesFeature(deps),
            new RegExp(`needs a ${name}\\(\\)`),
            `${name} should be required up front`,
        );
    }
});

test('instructor summaries are optional but type-checked when supplied', () => {
    const { createGradesFeature } = loadFeature();
    assert.doesNotThrow(() => createGradesFeature(stubDeps()));
    assert.doesNotThrow(() => createGradesFeature(stubDeps({ instructorSummaries: () => [] })));
    assert.throws(
        () => createGradesFeature(stubDeps({ instructorSummaries: true })),
        /instructorSummaries\(\) to be a function/,
    );
});

/*
 * The staleness contract, which is the whole reason the shape carries a token.
 * A result that lands after the student has moved on must not overwrite the
 * course they are now looking at.
 */
test('a result is current only when token, mode and course all still match', () => {
    const { createGradesFeature } = loadFeature();
    const feature = createGradesFeature(stubDeps({
        viewContext: () => view({ token: 7, mode: 'detail', group: { code: 'CSCE 350' } }),
    }));

    assert.equal(feature.professorDetailContextIsCurrent(7, 'CSCE 350'), true);
    assert.equal(feature.professorDetailContextIsCurrent(6, 'CSCE 350'), false, 'a stale token must not be current');
    assert.equal(feature.professorDetailContextIsCurrent(7, 'MATH 141'), false, 'another course must not be current');
});

test('a browse view that left the detail pane is never current', () => {
    const { createGradesFeature } = loadFeature();
    const feature = createGradesFeature(stubDeps({
        viewContext: () => view({ token: 7, mode: 'results', group: { code: 'CSCE 350' } }),
    }));
    assert.equal(feature.professorDetailContextIsCurrent(7, 'CSCE 350'), false,
        'leaving the detail pane must invalidate an in-flight result');
});

/*
 * Deliberate: a caller with no token is not making a staleness claim, so the
 * result is treated as current rather than silently discarded. Getting this
 * backwards would make grade history never render at all.
 */
test('an absent token means the caller is not claiming staleness', () => {
    const { createGradesFeature } = loadFeature();
    const feature = createGradesFeature(stubDeps());
    assert.equal(feature.professorDetailContextIsCurrent(null, 'CSCE 350'), true);
    assert.equal(feature.professorDetailContextIsCurrent(undefined, 'CSCE 350'), true);
    assert.equal(feature.professorDetailContextIsCurrent(1, ''), true);
});

test('the injected grade source is the only one used, and results are cached', async () => {
    const { createGradesFeature } = loadFeature();
    const asked = [];
    const feature = createGradesFeature(stubDeps({
        getCourseGrades: async code => { asked.push(code); return { instructors: [], code }; },
    }));

    const first = await feature.courseData('CSCE 350');
    const second = await feature.courseData('CSCE 350');
    assert.deepEqual(asHost(asked), ['CSCE 350'], 'a repeat view should not refetch');
    assert.equal(first, second);
});

test('the faculty cache key includes term and CRNs, so a term change is a different key', () => {
    const { createGradesFeature } = loadFeature();
    let term = '202608';
    const feature = createGradesFeature(stubDeps({
        viewContext: () => view({ term }),
        instructorCrns: () => ['11111', '22222'],
    }));

    const fall = feature.courseFacultyKey('CSCE 350');
    term = '202601';
    const spring = feature.courseFacultyKey('CSCE 350');
    assert.notEqual(fall, spring, 'the same course in another term must not reuse cached faculty');
    assert.match(fall, /202608/);
    assert.match(fall, /CSCE 350/);
});

test('CRN order does not change the cache key', () => {
    const { createGradesFeature } = loadFeature();
    let crns = ['22222', '11111'];
    const feature = createGradesFeature(stubDeps({ instructorCrns: () => crns }));
    const first = feature.courseFacultyKey('CSCE 350');
    crns = ['11111', '22222'];
    assert.equal(feature.courseFacultyKey('CSCE 350'), first, 'the key should be order-independent');
});

test('without instructor summaries the feature falls back rather than emptying', () => {
    const { createGradesFeature } = loadFeature();
    const feature = createGradesFeature(stubDeps());
    const data = { instructors: [{ name: 'Ada Lovelace', gpa: 3.5 }] };
    const records = feature.currentInstructorRecords(data, []);
    assert.ok(Array.isArray(records), 'a missing scheduler must not produce a non-array');
});

test('supplied instructor summaries are used in preference to the fallback', () => {
    const { createGradesFeature } = loadFeature();
    const calls = [];
    const feature = createGradesFeature(stubDeps({
        instructorSummaries: (group, data, faculty) => { calls.push(group?.code); return [{ name: 'From scheduler' }]; },
    }));
    const records = feature.currentInstructorRecords({ instructors: [] }, []);
    assert.deepEqual(asHost(calls), ['CSCE 350']);
    assert.deepEqual(asHost(records), [{ name: 'From scheduler' }]);
});

test('two instances keep separate caches', async () => {
    const { createGradesFeature } = loadFeature();
    let aCalls = 0;
    let bCalls = 0;
    const a = createGradesFeature(stubDeps({ getCourseGrades: async () => { aCalls += 1; return {}; } }));
    const b = createGradesFeature(stubDeps({ getCourseGrades: async () => { bCalls += 1; return {}; } }));

    await a.courseData('CSCE 350');
    await b.courseData('CSCE 350');
    assert.equal(aCalls, 1);
    assert.equal(bCalls, 1, 'one instance must not serve another from its cache');
});

test('the composition point supplies every declared dependency', () => {
    const composition = fs.readFileSync(path.join(ROOT, 'static/js/grades.js'), 'utf8');
    for (const name of DEP_NAMES) {
        assert.match(composition, new RegExp(`${name}[,:]`), `${name} is not supplied at the composition point`);
    }
    assert.match(composition, /instructorSummaries:/);
    // Every field the contract promises must actually be assembled.
    for (const field of ['token', 'mode', 'group', 'term', 'section', 'faculty']) {
        assert.match(composition, new RegExp(`${field}:`), `viewContext() must supply ${field}`);
    }
});

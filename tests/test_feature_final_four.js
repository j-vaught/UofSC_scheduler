'use strict';

/*
 * The last four fences: export, prereqs, scheduler, search.
 *
 * The plan called scheduler+search an irreducible cycle where the facade rule
 * would not be optional. Measured, the cycle is seven methods wide across 6,300
 * lines -- scheduler reaches search through three, search reaches scheduler
 * through four. Both directions are injected now, so neither module names the
 * other, and no facade was needed.
 *
 * These two use a coarser seam than the other features: collaborators arrive as
 * objects rather than as individually named functions. That is a deliberate
 * trade. Flattening thirty-five dependencies each would have meant a mechanical
 * edit across thousands of lines that had to get property-versus-method right
 * every time, which is exactly the shape of edit that produces a bug looking
 * like a refactor. The architectural property is the same and the tests below
 * check it: nothing ambient is reachable, and every collaborator is chosen by
 * the composition point.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

const APP_GLOBALS = ['State', 'API', 'Search', 'Scheduler', 'WalkingMap', 'Calendar',
    'Tabs', 'Prereqs', 'Grades', 'History', 'Profile', 'DegreePlan', 'CustomMajorMap'];

function featureSource(name) {
    return fs.readFileSync(path.join(ROOT, `static/js/features/${name}/index.js`), 'utf8');
}

/*
 * Comments only. Stripping string literals was tried and abandoned: template
 * literals here span lines and nest `${}` with their own quotes, so a regex
 * that claims to remove them removes the wrong spans and reports globals that
 * are really prose -- "Search failed. Try again.", a google.com/search URL.
 *
 * So the assertions below target the two mechanisms by which this codebase
 * actually reached a global: member access (`State.term`) and existence checks
 * (`typeof WalkingMap`). Both are case-sensitive and neither matches the
 * injected `deps.state` / `deps.walkingMap` spelling. A global used as a bare
 * value would slip past, which is a real limit -- but no module here did that,
 * and a check that is precise about what it catches beats one that is vague
 * about everything.
 */
function codeOnly(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/*
 * The property that makes a fence a fence. Checked on all four together,
 * because the failure it prevents -- a module quietly reading a global that
 * happens to exist in a browser -- is identical in each.
 */
for (const name of ['export', 'prereqs', 'scheduler', 'search']) {
    test(`${name}: no application global is reachable`, () => {
        const code = codeOnly(featureSource(name));
        for (const global of APP_GLOBALS) {
            assert.doesNotMatch(
                code,
                new RegExp(`(?<![\\w.$])${global}\\.`),
                `${name} reaches ${global} directly instead of through a collaborator`,
            );
            assert.doesNotMatch(
                code,
                new RegExp(`typeof\\s+${global}\\b`),
                `${name} still existence-checks the ${global} global; inside a fence that is always undefined`,
            );
        }
    });
}

/*
 * The cycle, from both ends. These are the seven edges the plan expected to
 * need a facade; naming them keeps a later change from quietly re-adding one.
 */
test('the scheduler reaches search only through its injected collaborator', () => {
    const code = codeOnly(featureSource('scheduler'));
    for (const method of ['fetchBulletinDetailsForCourse', 'searchLiveCourses', 'openCourseFromExternal']) {
        assert.match(code, new RegExp(`deps\\.search\\.${method}`), `${method} should go through deps.search`);
    }
});

test('search reaches the scheduler only through its injected collaborator', () => {
    const code = codeOnly(featureSource('search'));
    for (const method of ['addCourseGroup', 'registrationRestrictionText',
        'registrationRestrictionNeedsAttention', 'parseCreditHours']) {
        assert.match(code, new RegExp(`deps\\.scheduler\\.${method}`), `${method} should go through deps.scheduler`);
    }
});

/*
 * Grade history reads search's view state through the viewContext() shape
 * assembled in grades.js. Those fields have to stay private to search, or the
 * indirection that decoupling bought is gone.
 */
test('search keeps its detail state private to itself', () => {
    for (const name of ['grades', 'scheduler', 'export', 'prereqs']) {
        const code = codeOnly(featureSource(name));
        for (const field of ['_detailToken', '_detailGroup', '_detailTerm', '_browseState']) {
            assert.doesNotMatch(code, new RegExp(field), `${name} reaches into search's ${field}`);
        }
    }
});

test('every composition point supplies collaborators for its feature', () => {
    const cases = {
        scheduler: ['state', 'api', 'calendar', 'grades', 'prereqs', 'search', 'tabs', 'walkingMap'],
        search: ['state', 'api', 'grades', 'history', 'prereqs', 'scheduler', 'tabs', 'walkingMap'],
        export: ['selectedSections', 'currentTerm'],
        prereqs: ['bulletinSearch', 'bulletinDetails', 'searchCourses', 'completedCourses',
            'currentTerm', 'showCourseDetail'],
    };
    for (const [name, deps] of Object.entries(cases)) {
        const composition = fs.readFileSync(path.join(ROOT, `static/js/${name}.js`), 'utf8');
        for (const dep of deps) {
            // Getters for the pair, plain properties for the smaller two.
            assert.match(
                composition,
                new RegExp(`(get\\s+${dep}\\(\\)|${dep}:)`),
                `${name}.js does not supply ${dep}`,
            );
        }
    }
});

/*
 * Faithfulness, not laxity. The original modules referenced State and API
 * lazily inside their methods, so a page or a test could construct them without
 * either and only fail on the path that needed one. Requiring collaborators at
 * construction would be a behaviour change smuggled inside an extraction.
 */
test('the pair construct without collaborators, as they always did', () => {
    for (const [name, create, exported] of [
        ['scheduler', 'createSchedulerFeature', 'Features.scheduler'],
        ['search', 'createSearchFeature', 'Features.search'],
    ]) {
        const sandbox = vm.createContext({
            console, JSON, Math, Object, Array, Promise, Number, String, Boolean,
            Set, Map, Date, RegExp, isNaN, parseInt, parseFloat,
        });
        vm.runInContext(`${featureSource(name)}\nglobalThis.__f = ${exported};`, sandbox);
        assert.doesNotThrow(() => sandbox.__f[create]({}), `${name} should construct bare`);
    }
});

/*
 * The pair deliberately do NOT inspect collaborators at construction, and this
 * pins that decision because it is the sort of thing a later change would
 * "tidy up" without seeing the consequence.
 *
 * These are classic scripts: `const Foo = ...` at the top level creates a
 * global lexical binding that does not exist until that script has run, so the
 * composition points supply getters. Touching a collaborator at construction
 * forces it to resolve at the one moment it is least likely to be ready.
 *
 * This is not hypothetical. Eager resolution of `History` returned the DOM's
 * built-in History constructor, because history.js had not run yet -- a wrong
 * value that no existence check would reject, since it is very much defined.
 * The browser reported it as "Search is not defined", because the composition
 * point threw and left the const in its temporal dead zone.
 */
test('the pair do not inspect collaborators at construction', () => {
    for (const [name, create, exported] of [
        ['scheduler', 'createSchedulerFeature', 'Features.scheduler'],
        ['search', 'createSearchFeature', 'Features.search'],
    ]) {
        const sandbox = vm.createContext({
            console, JSON, Math, Object, Array, Promise, Number, String, Boolean,
            Set, Map, Date, RegExp, isNaN, parseInt, parseFloat,
        });
        vm.runInContext(`${featureSource(name)}\nglobalThis.__f = ${exported};`, sandbox);

        let touched = 0;
        const probe = {};
        for (const dep of ['state', 'api', 'grades', 'prereqs', 'tabs', 'walkingMap']) {
            Object.defineProperty(probe, dep, { get() { touched += 1; return {}; }, enumerable: true });
        }
        assert.doesNotThrow(() => sandbox.__f[create](probe));
        assert.equal(touched, 0, `${name} read a collaborator at construction`);
    }
});

test('the History global collision is handled by type, not by existence', () => {
    const composition = fs.readFileSync(path.join(ROOT, 'static/js/search.js'), 'utf8');
    assert.match(
        composition,
        /typeof History === 'object'/,
        "an existence check accepts the DOM's History constructor; only a type check rejects it",
    );
});

test('export and prereqs declare their dependencies individually', () => {
    const sandbox = vm.createContext({ console, JSON, Math, Object, Array, Promise, Set, Map, Date, RegExp });
    vm.runInContext(`${featureSource('export')}\nglobalThis.__e = Features.export;`, sandbox);
    assert.throws(() => sandbox.__e.createExportFeature({}), /needs a selectedSections\(\)/);
    assert.throws(
        () => sandbox.__e.createExportFeature({ selectedSections: () => ({}) }),
        /needs a currentTerm\(\)/,
    );

    const sandbox2 = vm.createContext({ console, JSON, Math, Object, Array, Promise, Set, Map, Date, RegExp });
    vm.runInContext(`${featureSource('prereqs')}\nglobalThis.__p = Features.prereqs;`, sandbox2);
    assert.throws(() => sandbox2.__p.createPrereqsFeature({}), /needs a bulletinSearch\(\)/);
});

test('the ICS exporter builds from the injected schedule and term', () => {
    const sandbox = vm.createContext({ console, JSON, Math, Object, Array, Promise, Set, Map, Date, RegExp });
    vm.runInContext(`${featureSource('export')}\nglobalThis.__e = Features.export;`, sandbox);
    const feature = sandbox.__e.createExportFeature({
        selectedSections: () => ({}),
        currentTerm: () => '202608',
    });
    assert.equal(typeof feature.exportICS, 'function');
    assert.deepEqual(JSON.parse(JSON.stringify(feature.parseMeetingTimes(null))), []);
    // A malformed payload must not throw out of an export.
    assert.deepEqual(JSON.parse(JSON.stringify(feature.parseMeetingTimes('{oops'))), []);
});

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
    /*
     * The whole feature, however many files it is in. Search is five parts plus
     * an index that merges them, so reading index.js alone would find state and
     * composition and none of the methods -- and a doesNotMatch assertion would
     * quietly pass against the wrong file.
     */
    const dir = path.join(ROOT, `static/js/features/${name}`);
    const files = fs.readdirSync(dir).filter(file => file.endsWith('.js')).sort();
    return files.map(file => fs.readFileSync(path.join(dir, file), 'utf8')).join('\n');
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
        search: ['state', 'api', 'carolinaCore', 'grades', 'history', 'prereqs', 'scheduler',
            'tabs', 'walkingMap'],
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

/*
 * The Carolina Core filter scraped a `carolinacore` field off the bulletin
 * detail payload. That field does not exist -- the payload carries code,
 * title, hours, description and prerequisites -- so the scrape always produced
 * an empty list and all ten outcome options returned zero results. Selecting
 * "CMW" hid every course, ENGL 101 included.
 *
 * The data was in the build the whole time, as the shard the degree planner's
 * Core picker already reads.
 */
test('Carolina Core outcomes come from the catalogue, not a scraped field', async () => {
    const source = featureSource('search');
    assert.doesNotMatch(
        source,
        /details\.carolinacore/,
        'the bulletin payload has no carolinacore field; scraping it matches nothing',
    );
    assert.match(source, /deps\.carolinaCore\.loadCatalog\(\)/);

    const sandbox = vm.createContext({
        console, JSON, Math, Object, Array, Promise, Number, String, Boolean,
        Set, Map, Date, RegExp, isNaN, parseInt, parseFloat,
    });
    vm.runInContext(`${source}\nglobalThis.__f = Features.search;`, sandbox);
    const feature = sandbox.__f.createSearchFeature({
        carolinaCore: {
            loadCatalog: async () => ({
                courses: [
                    { code: 'ENGL 101', outcomes: ['CMW'] },
                    { code: 'MATH 141', outcomes: ['ARP'] },
                ],
            }),
        },
    });

    assert.deepEqual(JSON.parse(JSON.stringify(await feature.fetchCarolinaCoreCodes('ENGL 101'))), ['CMW']);
    assert.deepEqual(JSON.parse(JSON.stringify(await feature.fetchCarolinaCoreCodes('MATH 141'))), ['ARP']);
    assert.deepEqual(JSON.parse(JSON.stringify(await feature.fetchCarolinaCoreCodes('CSCE 145'))), []);
});

test('an unreachable Core catalogue yields no outcomes rather than throwing', async () => {
    const sandbox = vm.createContext({
        console, JSON, Math, Object, Array, Promise, Number, String, Boolean,
        Set, Map, Date, RegExp, isNaN, parseInt, parseFloat,
    });
    vm.runInContext(`${featureSource('search')}\nglobalThis.__f = Features.search;`, sandbox);
    const feature = sandbox.__f.createSearchFeature({
        carolinaCore: { loadCatalog: async () => { throw new Error('offline'); } },
    });
    assert.deepEqual(JSON.parse(JSON.stringify(await feature.fetchCarolinaCoreCodes('ENGL 101'))), []);
});

/*
 * Carolina Core is a search criterion now, not a post-filter: upstream matches
 * course_attr against the exact display string, so one request returns only the
 * sections carrying the outcome.
 *
 * The pair of tests below are really one property. Exactly one mechanism may
 * narrow, never both -- applying the shard on top of an upstream-filtered set
 * lets a stale catalogue drop a course upstream was right to return, which is
 * the failure a newly-designated course would hit and nobody would see.
 */
/*
 * The decision itself, tested directly.
 *
 * Driving the whole of doSearch here was tried and dropped: it reads a dozen
 * filter elements before it builds criteria, so a sandbox stub large enough to
 * reach the criterion would be asserting mostly on the stub. The seam below is
 * what decides, and the wiring is pinned separately and verified in a browser.
 */
test('every outcome resolves to its exact upstream search value', () => {
    const sandbox = vm.createContext({
        console, JSON, Math, Object, Array, Promise, Number, String, Boolean,
        Set, Map, Date, RegExp, isNaN, parseInt, parseFloat,
    });
    vm.runInContext(`${featureSource('search')}\nglobalThis.__f = Features.search;`, sandbox);
    const carolinaCore = require('../static/js/carolina-core.js');
    const feature = sandbox.__f.createSearchFeature({ carolinaCore });

    assert.equal(feature.carolinaCoreSearchValue('ARP'), 'ARP: Analytical Reasoning (3ARP)');
    assert.equal(feature.carolinaCoreSearchValue('GFL'), 'GFL: Global/Language (3GFL)');
    for (const outcome of Object.keys(carolinaCore.labels)) {
        assert.notEqual(feature.carolinaCoreSearchValue(outcome), '', `${outcome} has no search value`);
    }
    // '' is what routes to the shard fallback, so these must not invent a value.
    assert.equal(feature.carolinaCoreSearchValue(''), '');
    assert.equal(feature.carolinaCoreSearchValue('NOPE'), '');
});

test('without a Core catalogue the search value is empty, not wrong', () => {
    const sandbox = vm.createContext({
        console, JSON, Math, Object, Array, Promise, Number, String, Boolean,
        Set, Map, Date, RegExp, isNaN, parseInt, parseFloat,
    });
    vm.runInContext(`${featureSource('search')}\nglobalThis.__f = Features.search;`, sandbox);
    const feature = sandbox.__f.createSearchFeature({});
    assert.equal(feature.carolinaCoreSearchValue('ARP'), '',
        'a missing catalogue must fall back to the shard path, not match everything');
});

/*
 * The wiring. Anchored before slicing, because an unanchored source assertion
 * silently checks an empty string once the code moves -- six of those were
 * found in this suite already.
 */
test('doSearch pushes the criterion before it issues any search', () => {
    const source = featureSource('search');
    const at = source.indexOf('async doSearch(');
    assert.notEqual(at, -1, 'doSearch moved; this test is not reading it');

    const body = source.slice(at);
    const pushAt = body.indexOf("criteria.push({ field: 'course_attr'");
    assert.notEqual(pushAt, -1, 'doSearch no longer sends Carolina Core as a criterion');

    const firstSearchAt = body.indexOf('deps.api.searchCourses(');
    assert.notEqual(firstSearchAt, -1);
    assert.ok(
        pushAt < firstSearchAt,
        'the criterion must be added before the request that should carry it',
    );
});

test('the shard filter stands down once upstream has already narrowed', async () => {
    const sandbox = vm.createContext({
        console, JSON, Math, Object, Array, Promise, Number, String, Boolean,
        Set, Map, Date, RegExp, isNaN, parseInt, parseFloat,
    });
    vm.runInContext(`${featureSource('search')}\nglobalThis.__f = Features.search;`, sandbox);

    let catalogReads = 0;
    const feature = sandbox.__f.createSearchFeature({
        carolinaCore: {
            searchValue: outcome => (outcome === 'ARP' ? 'ARP: Analytical Reasoning (3ARP)' : ''),
            loadCatalog: async () => { catalogReads += 1; return { courses: [] }; },
        },
    });

    // Upstream handled ARP, so these pass through untouched even though the
    // stub catalogue knows no courses at all.
    const upstreamFiltered = [{ code: 'CSCE 145' }, { code: 'CSCE 101' }];
    const kept = await feature.filterByCarolinaCore(upstreamFiltered, 'ARP');
    assert.deepEqual(JSON.parse(JSON.stringify(kept)), JSON.parse(JSON.stringify(upstreamFiltered)));
    assert.equal(catalogReads, 0, 'the shard must not be consulted for an outcome upstream can express');
});

test('an outcome upstream cannot express still falls back to the shard', async () => {
    const sandbox = vm.createContext({
        console, JSON, Math, Object, Array, Promise, Number, String, Boolean,
        Set, Map, Date, RegExp, isNaN, parseInt, parseFloat,
    });
    vm.runInContext(`${featureSource('search')}\nglobalThis.__f = Features.search;`, sandbox);

    const feature = sandbox.__f.createSearchFeature({
        carolinaCore: {
            searchValue: () => '',
            loadCatalog: async () => ({ courses: [{ code: 'CSCE 145', outcomes: ['ARP'] }] }),
        },
    });
    const kept = await feature.filterByCarolinaCore([{ code: 'CSCE 145' }, { code: 'CSCE 999' }], 'ARP');
    assert.deepEqual(JSON.parse(JSON.stringify(kept)), [{ code: 'CSCE 145' }],
        'with no upstream value the shard must still narrow');
});

test('the relay, the contract and the browser encoder allow the same fields', () => {
    const contract = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts/wire/fose-v1.json'), 'utf8'));
    const allowed = contract.routes['/api/search'].request.criteria.allowed_fields;
    assert.ok(allowed.includes('course_attr'), 'the contract must allow course_attr');

    const relay = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    const encoder = fs.readFileSync(path.join(ROOT, 'static/js/platform/university/wire/fose-v1.js'), 'utf8');
    for (const field of allowed) {
        assert.match(relay, new RegExp(`'${field}'`), `the relay does not allow ${field}`);
        assert.match(encoder, new RegExp(`'${field}'`), `the browser encoder does not allow ${field}`);
    }
});

/*
 * The search feature is five part files merged onto one object by its index.
 *
 * What can go wrong in a split like this is not a syntax error -- it is a
 * method quietly not making it across, which no other test would notice
 * because each one exercises a handful of methods. So this pins the surface
 * itself: every part contributes, nothing collides, and the whole is what the
 * composition point gets.
 */
test('the search feature merges its parts into one complete object', () => {
    const dir = path.join(ROOT, 'static/js/features/search');
    const partFiles = fs.readdirSync(dir)
        .filter(file => file.endsWith('.js') && file !== 'index.js').sort();
    assert.ok(partFiles.length >= 5, `expected the feature to be split, found ${partFiles.length}`);

    const sandbox = vm.createContext({
        console, JSON, Math, Object, Array, Promise, Number, String, Boolean,
        Set, Map, Date, RegExp, isNaN, parseInt, parseFloat,
    });
    const source = [
        ...partFiles.map(file => fs.readFileSync(path.join(dir, file), 'utf8')),
        fs.readFileSync(path.join(dir, 'index.js'), 'utf8'),
    ].join('\n');
    vm.runInContext(`${source}\nglobalThis.__f = Features.search;`, sandbox);

    const feature = sandbox.__f.createSearchFeature({});
    const methods = Object.keys(feature).filter(key => typeof feature[key] === 'function');
    assert.ok(methods.length >= 140, `expected the full method set, found ${methods.length}`);

    // A handful from each part, so losing any one file fails loudly here.
    for (const method of [
        'loadSubjects', 'buildCourseScope',        // query
        'init', 'doSearch', 'openFilters',         // shell
        'applySectionFilters', 'filterByClassSize', // filters
        'showCourseDetail', 'renderSectionCalendar', // detail
        'renderResults', 'showSearchError',        // results
    ]) {
        assert.equal(typeof feature[method], 'function', `${method} did not survive the split`);
    }

    // State stays on the index, and the parts must not have shadowed it.
    assert.equal(feature._browseState, 'empty');
    assert.ok(feature._searchViewCache instanceof Map);
});

test('no two search parts define the same method', () => {
    const dir = path.join(ROOT, 'static/js/features/search');
    const seen = new Map();
    const collisions = [];
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js') && f !== 'index.js').sort()) {
        const source = fs.readFileSync(path.join(dir, file), 'utf8');
        for (const match of source.matchAll(/^        (?:async )?([a-zA-Z_][\w]*)\(/gm)) {
            const name = match[1];
            if (seen.has(name)) collisions.push(`${name}: ${seen.get(name)} and ${file}`);
            else seen.set(name, file);
        }
    }
    assert.deepEqual(collisions, [],
        `later parts silently overwrite earlier ones in Object.assign: ${collisions.join('; ')}`);
});

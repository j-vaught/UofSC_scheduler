const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const path = require('node:path');
const ROOT_DIR = path.resolve(__dirname, '..');

const CarolinaCore = require('../static/js/carolina-core.js');

/*
 * Composition points construct their feature from `Features.<name>`, so the
 * feature modules have to be in the context before the file under test runs.
 * Loading all of them is deliberate: each only registers itself, so this costs
 * nothing, and the next extraction needs no change here.
 */
function featureSources(rootDir) {
    const dir = path.join(rootDir, 'static/js/features');
    if (!fs.existsSync(dir)) return '';
    return fs.readdirSync(dir)
        .map(name => path.join(dir, name, 'index.js'))
        .filter(file => fs.existsSync(file))
        .map(file => fs.readFileSync(file, 'utf8'))
        .join('\n');
}


function loadDegreePlan(overrides = {}) {
    const context = vm.createContext({
        console,
        State: overrides.State || { degreePlan: { semesters: [], pins: {} } },
        window: overrides.window || { AppModal: { close() {} } },
        document: overrides.document || {},
        CarolinaCore,
    });
    const source = [
        featureSources(ROOT_DIR),
        fs.readFileSync('static/js/degree-plan.js', 'utf8'),
        'globalThis.__DegreePlan = DegreePlan;',
    ].join('\n');
    vm.runInContext(source, context);
    return context.__DegreePlan;
}

test('Carolina Core catalog filtering works without a text query', () => {
    const courses = [
        { code: 'ENGL 102', title: 'Rhetoric and Composition', outcomes: ['CMW', 'INF'] },
        { code: 'MATH 141', title: 'Calculus I', outcomes: ['ARP'] },
    ];

    assert.deepEqual(
        CarolinaCore.filterCourses(courses, { outcome: 'INF' }).map(course => course.code),
        ['ENGL 102'],
    );
    assert.deepEqual(
        CarolinaCore.filterCourses(courses, { query: 'calculus' }).map(course => course.code),
        ['MATH 141'],
    );
});

test('generic and coded Carolina Core planner slots are recognized', () => {
    const planner = loadDegreePlan();

    assert.equal(planner.isCarolinaCoreRequirement({
        category: 'carolina_core',
        title: 'Carolina Core Requirement',
    }), true);
    assert.equal(planner.carolinaCoreCode({
        category: 'carolina_core',
        title: 'Carolina Core ARP Requirement',
    }), 'ARP');
});

test('selecting an approved course replaces the requirement in place', () => {
    let rendered = false;
    let closed = false;
    const State = {
        degreePlan: {
            pins: {},
            semesters: [{
                term: '202608',
                courses: [{
                    code: '[Carolina Core ARP]',
                    title: 'Carolina Core ARP',
                    credits: 3,
                    category: 'carolina_core',
                    is_elective_slot: true,
                    elective_group_id: 'core-arp',
                }],
            }],
        },
    };
    const planner = loadDegreePlan({
        State,
        window: { AppModal: { close() { closed = true; } } },
    });
    planner.render = () => { rendered = true; };

    planner.selectRequirementCourse({
        groupId: '[Carolina Core ARP]',
        term: '202608',
        slot: State.degreePlan.semesters[0].courses[0],
        selected: { code: 'MATH 141', title: 'Calculus I', outcomes: ['ARP'] },
    });

    const selected = State.degreePlan.semesters[0].courses[0];
    assert.equal(selected.code, 'MATH 141');
    assert.equal(selected.title, 'Calculus I');
    assert.equal(selected.category, 'carolina_core');
    assert.equal(selected.is_elective_slot, false);
    assert.equal(State.degreePlan.pins['MATH 141'], '202608');
    assert.equal(closed, true);
    assert.equal(rendered, true);
});

/*
 * Reads the fenced feature, where this logic now lives, and asserts its own
 * anchors first. The slice below previously came from degree-plan.js; when the
 * logic moved, both indexOf calls returned -1, the slice came back empty, and
 * doesNotMatch passed against nothing -- reporting success while checking no
 * code at all. Source-text assertions fail open, so they have to prove they
 * found the code before judging it.
 */
test('planner uses the in-place Core chooser instead of navigating to Search', () => {
    const source = fs.readFileSync(
        path.join(ROOT_DIR, 'static/js/features/degree-plan/index.js'), 'utf8');
    const from = source.indexOf('if (this.isCarolinaCoreRequirement(course))');
    const to = source.indexOf("if (!course.options || course.options.length === 0)");
    assert.notEqual(from, -1, 'the Carolina Core branch moved; this test is not reading it');
    assert.notEqual(to, -1, 'the end of the Core branch moved; this test is not reading it');
    assert.ok(to > from, 'the slice bounds are inverted, so nothing is being checked');

    const coreBranch = source.slice(from, to);
    assert.match(coreBranch, /openCarolinaCorePicker/);
    // searchFor is the fenced navigation seam; the Core branch must not use it.
    assert.doesNotMatch(coreBranch, /Tabs\.switchTo|Search\.doSearch|deps\.searchFor/);
});

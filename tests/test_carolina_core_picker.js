const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const CarolinaCore = require('../static/js/carolina-core.js');

function loadDegreePlan(overrides = {}) {
    const context = vm.createContext({
        console,
        State: overrides.State || { degreePlan: { semesters: [], pins: {} } },
        window: overrides.window || { AppModal: { close() {} } },
        document: overrides.document || {},
        CarolinaCore,
    });
    const source = `${fs.readFileSync('static/js/degree-plan.js', 'utf8')}\nglobalThis.__DegreePlan = DegreePlan;`;
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

test('planner uses the in-place Core chooser instead of navigating to Search', () => {
    const source = fs.readFileSync('static/js/degree-plan.js', 'utf8');
    const coreBranch = source.slice(
        source.indexOf('if (this.isCarolinaCoreRequirement(course))'),
        source.indexOf("if (!course.options || course.options.length === 0)"),
    );

    assert.match(coreBranch, /openCarolinaCorePicker/);
    assert.doesNotMatch(coreBranch, /Tabs\.switchTo|Search\.doSearch/);
});

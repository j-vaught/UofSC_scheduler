const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

require('../static/js/runtime/offering-analyzer.js');
const planner = require('../static/js/runtime/degree-planner.js');

const root = path.resolve(__dirname, '..');

function loadObject(relativePath, name, contextValues = {}) {
    const context = vm.createContext({ ...contextValues });
    const source = `${fs.readFileSync(path.join(root, relativePath), 'utf8')}\nglobalThis.__result = ${name};`;
    vm.runInContext(source, context);
    return context.__result;
}

test('degree planner shell uses four guided full-page stages', () => {
    const html = fs.readFileSync(path.join(root, 'static/index.html'), 'utf8');
    for (const step of [1, 2, 3, 4]) {
        assert.match(html, new RegExp(`data-degree-step="${step}"`));
    }
    assert.match(html, /I HAVE NOT TAKEN ANY COURSES YET/);
    assert.match(html, /Advanced course entry/);
    const wizard = fs.readFileSync(path.join(root, 'static/js/degree-wizard.js'), 'utf8');
    assert.match(wizard, /VIEW PDF/);
});

test('Electrical Engineering plans every official required credit', () => {
    const map = JSON.parse(fs.readFileSync(
        path.join(root, 'data/maps/imported/2026-2027/map_374cc4bc138c13c7.json'),
        'utf8',
    ));
    const plan = planner.planDegree(map, [], { start_term: '202608', strategy: 'major_map' });
    const plannedCredits = plan.semesters.reduce((sum, semester) => sum + semester.total_credits, 0);
    assert.equal(map.total_credits_required, 126);
    assert.equal(plan.total_credits_remaining, 126);
    assert.equal(plannedCredits, 126);
    assert.deepEqual(plan.semesters.map(semester => semester.total_credits), [15, 17, 16, 18, 18, 15, 15, 12]);
});

test('major maps without concentrations expose an explicit unavailable state', () => {
    const source = fs.readFileSync(path.join(root, 'static/js/profile.js'), 'utf8');
    assert.match(source, /option\.textContent = 'None available'/);
    assert.match(source, /concSel\.disabled = true/);
});

test('major-map courses reuse cached bulletin requirements before planning', async () => {
    const calls = { search: 0, details: 0 };
    const api = {
        async bulletinSearch(subject, catalogYear) {
            calls.search += 1;
            assert.equal(subject, 'CSCE');
            assert.equal(catalogYear, '2026');
            return {
                results: [{
                    code: 'CSCE 146',
                    key: 'csce-146',
                    prerequisite_text: 'Prerequisites: CSCE 145 or CSCE 106.',
                }],
            };
        },
        async bulletinDetails(key, catalogYear) {
            calls.details += 1;
            assert.equal(key, 'csce-146');
            assert.equal(catalogYear, '2026');
            return {
                prereq: 'Prerequisites: CSCE 145 or CSCE 106.',
                corequisite: 'Corequisite: MATH 141.',
            };
        },
    };
    const prereqs = loadObject('static/js/prereqs.js', 'Prereqs', { API: api });
    const map = {
        catalog_year: '2026-2027',
        required_courses: [{
            code: 'CSCE 146',
            prerequisites: [],
            corequisites: [],
        }],
    };

    const enriched = await prereqs.enrichMajorMap(map);
    const course = enriched.required_courses[0];
    assert.deepEqual(JSON.parse(JSON.stringify(course.prerequisite_groups)), [{
        courses: ['CSCE 145', 'CSCE 106'],
        type: 'or',
    }]);
    assert.deepEqual(JSON.parse(JSON.stringify(course.corequisite_groups)), [{
        courses: ['MATH 141'],
        type: 'and',
    }]);
    assert.deepEqual(JSON.parse(JSON.stringify(course.prerequisites)), ['CSCE 145', 'CSCE 106']);
    assert.deepEqual(JSON.parse(JSON.stringify(course.corequisites)), ['MATH 141']);

    await prereqs.enrichMajorMap(map);
    assert.deepEqual(calls, { search: 1, details: 1 });
});

test('degree planner places normalized corequisites atomically', () => {
    const map = {
        total_credits_required: 6,
        required_courses: [
            {
                code: 'TEST 202',
                title: 'Lecture',
                credits: 3,
                corequisite_groups: [{ courses: ['TEST 202L'], type: 'and' }],
            },
            { code: 'TEST 202L', title: 'Lab', credits: 3 },
        ],
    };
    const plan = planner.planDegree(map, [], { start_term: '202608' });
    assert.equal(plan.semesters.length, 1);
    assert.deepEqual(plan.semesters[0].courses.map(course => course.code), ['TEST 202', 'TEST 202L']);
    assert.deepEqual(planner.requiredCorequisiteCodes(
        [{ courses: ['TEST 202L', 'TEST 203L'], type: 'or' }],
        [],
        ['TEST 203L'],
    ), ['TEST 203L']);
});

test('degree-plan drag validation protects downstream prerequisite order', () => {
    const alerts = [];
    const state = {
        completedCourses: [],
        profile: {
            majorData: {
                required_courses: [
                    { code: 'TEST 101', prerequisites: [] },
                    {
                        code: 'TEST 201',
                        prerequisite_groups: [{ courses: ['TEST 101'], type: 'and' }],
                    },
                    {
                        code: 'TEST 301',
                        prerequisite_groups: [{ courses: ['TEST 201'], type: 'and' }],
                    },
                ],
            },
        },
        degreePlan: {
            pins: {},
            semesters: [
                { term: '202608', label: 'Fall 2026', courses: [{ code: 'TEST 101', credits: 3 }], total_credits: 3 },
                { term: '202701', label: 'Spring 2027', courses: [{ code: 'TEST 201', credits: 3 }], total_credits: 3 },
                { term: '202708', label: 'Fall 2027', courses: [{ code: 'TEST 301', credits: 3 }], total_credits: 3 },
                { term: '202801', label: 'Spring 2028', courses: [], total_credits: 0 },
            ],
        },
    };
    const degreePlan = loadObject('static/js/degree-plan.js', 'DegreePlan', {
        State: state,
        DegreePlannerRuntime: planner,
        alert: message => alerts.push(message),
    });
    degreePlan.render = () => {};

    const blocked = degreePlan.validatePlannedMove('TEST 101', '202608', '202708');
    assert.equal(blocked.valid, false);
    assert.equal(blocked.reason, 'dependent');
    assert.equal(blocked.course, 'TEST 201');
    degreePlan.moveCourse('TEST 101', '202608', '202708', 'planned', 'planned');
    assert.deepEqual(state.degreePlan.semesters[0].courses.map(course => course.code), ['TEST 101']);
    assert.match(alerts[0], /TEST 201 requires it first/);

    const allowed = degreePlan.validatePlannedMove('TEST 301', '202708', '202801');
    assert.equal(allowed.valid, true);
    degreePlan.moveCourse('TEST 301', '202708', '202801', 'planned', 'planned');
    assert.deepEqual(state.degreePlan.semesters[2].courses, []);
    assert.deepEqual(state.degreePlan.semesters[3].courses.map(course => course.code), ['TEST 301']);
    assert.equal(state.degreePlan.pins['TEST 301'], '202801');
});

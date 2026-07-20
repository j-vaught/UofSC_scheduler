const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const planner = require('../static/js/runtime/degree-planner.js');
const { loadObject } = require('./support/scheduler-harness.js');

const ROOT = path.resolve(__dirname, '..');

function loadWorker(relativePath) {
    const filePath = path.join(ROOT, relativePath);
    const messages = [];
    const listeners = {};
    let context;
    const self = {
        addEventListener(type, listener) { listeners[type] = listener; },
        postMessage(message) { messages.push(message); },
        importScripts(...scripts) {
            for (const script of scripts) {
                const importedPath = path.resolve(path.dirname(filePath), script.split(/[?#]/, 1)[0]);
                vm.runInContext(fs.readFileSync(importedPath, 'utf8'), context, { filename: importedPath });
            }
        },
    };
    context = vm.createContext({ self, globalThis: self, console, Set, Map, Object });
    vm.runInContext(fs.readFileSync(filePath, 'utf8'), context, { filename: filePath });
    return {
        async request(data) {
            listeners.message({ data });
            return JSON.parse(JSON.stringify(messages.shift()));
        },
    };
}



test('planner consumes browser-style AND/OR groups without adding a second text parser', () => {
    const groups = [
        { courses: ['MATH 111', 'MATH 115'], type: 'or' },
        { courses: ['CSCE 145'], type: 'and' },
    ];
    assert.deepEqual(planner.evaluateRequirementGroups(groups, ['MATH 115', 'CSCE 145']), {
        satisfied: true,
        eligible: true,
        uncertain: false,
        missing: [],
    });
    assert.deepEqual(planner.evaluateRequirementGroups(groups, ['MATH 115']), {
        satisfied: false,
        eligible: false,
        uncertain: false,
        missing: ['CSCE 145'],
    });
    const manualAlternative = [{
        courses: ['MATH 111'],
        type: 'or',
        conditions: [{ label: 'Placement exam', kind: 'manual' }],
    }];
    assert.deepEqual(planner.evaluateRequirementGroups(manualAlternative, []), {
        satisfied: false,
        eligible: true,
        uncertain: true,
        missing: [],
    });
});

test('the browser parser and the runtime evaluator agree on every group type', () => {
    /*
     * The two groupIsMet implementations are duplicated on purpose for now --
     * the browser feature cannot import the runtime and vice versa. Duplication
     * is only tolerable while something proves the copies still agree, so every
     * group type the parser can emit is fed to both and compared. A new type
     * added to one side and not the other fails here rather than in a plan.
     */
    const prereqs = loadObject('static/js/prereqs.js', 'Prereqs', {});
    const parsed = [
        'C or better in CSCE 145 or CSCE 106.',
        'C or better in MATH 142; C or better in either ELCT 102 or AESP 265 or D or better in ELCT 220.',
        'C or better in MATH 111 or higher.',
        'Prerequisites: C or better in MATH 112, MATH 115, MATH 116, or through placement exam.',
        'D or better in ENCP 200 D or better in PHYS 211',
    ].flatMap(text => prereqs.parsePrereqGroups(text));
    assert.ok(parsed.some(group => group.type === 'at-least'), 'the corpus must exercise every type');
    assert.ok(parsed.some(group => (group.conditions || []).length));

    const rosters = [
        [], ['MATH 111'], ['MATH 141'], ['MATH 110'], ['ELCT 220'],
        ['CSCE 106'], ['ENCP 200', 'PHYS 211'], ['MATH 116'], ['ENGL 200'],
    ];
    for (const group of parsed) {
        for (const roster of rosters) {
            assert.equal(
                prereqs.groupIsMet(group, new Set(roster)),
                // The runtime normalizes before evaluating, so compare through
                // that path rather than against the raw parser output.
                planner.evaluateRequirementGroups(
                    planner.requirementGroupsForCourse({ prerequisite_groups: [group] }),
                    roster,
                ).satisfied,
                `${JSON.stringify(group)} vs ${JSON.stringify(roster)}`,
            );
        }
    }
});

test('planner terminates with a useful warning when prerequisite cycles make progress impossible', () => {
    const cyclicMap = {
        total_credits_required: 6,
        required_courses: [
            { code: 'TEST 401', title: 'Cycle A', credits: 3, prerequisites: ['TEST 402'] },
            { code: 'TEST 402', title: 'Cycle B', credits: 3, prerequisites: ['TEST 401'] },
        ],
    };
    const result = planner.planDegree(cyclicMap, [], { start_term: '202608' });
    assert.deepEqual(result.semesters, []);
    assert.equal(result.estimated_graduation, 'Unknown');
    assert.equal(result.warnings[0].type, 'error');
    assert.match(result.warnings[0].message, /Could not place 2 course\(s\): TEST 401, TEST 402/);
});

test('planner does not silently discard prerequisites outside the remaining degree map', () => {
    const map = {
        total_credits_required: 3,
        required_courses: [
            { code: 'TEST 450', title: 'Advanced Topic', credits: 3, prerequisites: ['TEST 250'] },
        ],
    };
    const blocked = planner.planDegree(map, [], { start_term: '202608' });
    assert.deepEqual(blocked.semesters, []);
    assert.match(blocked.warnings[0].message, /Could not place 1 course\(s\): TEST 450/);

    const eligible = planner.planDegree(map, ['TEST 250'], { start_term: '202608' });
    assert.equal(eligible.semesters[0].courses[0].code, 'TEST 450');
});

test('dedicated workers return correlated results and structured errors', async () => {
    const offeringWorker = loadWorker('static/js/workers/offering-analysis-worker.js');
    const offeringResponse = await offeringWorker.request({
        requestId: 'history-1',
        operation: 'predict',
        payload: { pattern_data: { pattern: 'fall_only' }, current_term: '202601' },
    });
    assert.deepEqual(offeringResponse, { requestId: 'history-1', ok: true, result: '202608' });

    const transcriptWorker = loadWorker('static/js/workers/transcript-worker.js');
    const transcriptResponse = await transcriptWorker.request({
        requestId: 'transcript-1',
        operation: 'parse-text',
        payload: { text: 'CSCE145; MATH141' },
    });
    assert.deepEqual(transcriptResponse, {
        requestId: 'transcript-1',
        ok: true,
        result: ['CSCE 145', 'MATH 141'],
    });

    const plannerWorker = loadWorker('static/js/workers/degree-planner-worker.js');
    const plannerResponse = await plannerWorker.request({
        requestId: 'planner-1',
        operation: 'evaluate-requirements',
        payload: { groups: [{ courses: ['CSCE 145'], type: 'and' }], completed: ['CSCE 145'] },
    });
    assert.deepEqual(plannerResponse, {
        requestId: 'planner-1',
        ok: true,
        result: { satisfied: true, eligible: true, uncertain: false, missing: [] },
    });
    const errorResponse = await plannerWorker.request({ requestId: 'bad-1', operation: 'not-real' });
    assert.equal(errorResponse.requestId, 'bad-1');
    assert.equal(errorResponse.ok, false);
    assert.match(errorResponse.error, /Unknown degree-planner operation/);
});

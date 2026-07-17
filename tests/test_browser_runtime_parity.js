const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const offering = require('../static/js/runtime/offering-analyzer.js');
const transcript = require('../static/js/runtime/transcript-parser.js');
const planner = require('../static/js/runtime/degree-planner.js');

const ROOT = path.resolve(__dirname, '..');
const PYTHON = fs.existsSync(path.join(ROOT, '.venv/bin/python'))
    ? path.join(ROOT, '.venv/bin/python')
    : 'python3';

function pythonResult(moduleName, functionName, args = [], kwargs = {}) {
    const script = [
        'import importlib, json, sys',
        'payload = json.load(sys.stdin)',
        `function = getattr(importlib.import_module(${JSON.stringify(moduleName)}), ${JSON.stringify(functionName)})`,
        'result = function(*payload["args"], **payload["kwargs"])',
        'print(json.dumps(result, sort_keys=True))',
    ].join('\n');
    const process = childProcess.spawnSync(PYTHON, ['-c', script], {
        cwd: ROOT,
        input: JSON.stringify({ args, kwargs }),
        encoding: 'utf8',
    });
    assert.equal(process.status, 0, process.stderr);
    return JSON.parse(process.stdout);
}

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
                const importedPath = path.resolve(path.dirname(filePath), script);
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

test('offering analysis matches Python for cutoffs, failed terms, enrollment, and tie rounding', () => {
    const histories = [
        {
            history: {
                terms: [
                    { term: '202401', offered: true, enrollment: 20, capacity: 25 },
                    { term: '202405', offered: false, error: true },
                    { term: '202408', offered: true, enrolled: '30', max_enrollment: '40' },
                    { term: '202501', offered: false },
                    { term: '202508', offered: true },
                    { term: '202601', offered: false },
                ],
            },
            cutoff: '202601',
        },
        {
            history: {
                terms: [
                    { term: '202301', offered: true },
                    { term: '202305', offered: true },
                    { term: '202308', offered: true },
                    { term: '202401', offered: true },
                    { term: '202405', offered: true },
                    { term: '202408', offered: false },
                    { term: '202501', offered: false },
                    { term: '202505', offered: false },
                ],
            },
            cutoff: '202508',
        },
        { history: { terms: [] }, cutoff: '202608' },
    ];

    for (const fixture of histories) {
        const expected = pythonResult(
            'offering_analyzer',
            'analyze_offering_pattern',
            [fixture.history],
            { as_of_term: fixture.cutoff },
        );
        assert.deepEqual(offering.analyzeOfferingPattern(fixture.history, fixture.cutoff), expected);
    }
});

test('offering summary and prediction match Python across named patterns', () => {
    const patterns = [
        [{ pattern: 'every_semester' }, '202608'],
        [{ pattern: 'fall_and_spring' }, '202605'],
        [{ pattern: 'fall_only' }, '202608'],
        [{ pattern: 'spring_only' }, '202601'],
        [{ pattern: 'every_3_semesters', avg_gap: 3 }, '202608'],
        [{ pattern: 'unknown' }, '202608'],
    ];
    for (const [pattern, currentTerm] of patterns) {
        const expected = pythonResult(
            'offering_analyzer',
            'predict_next_offering',
            [pattern, currentTerm],
        );
        assert.equal(offering.predictNextOffering(pattern, currentTerm), expected);
    }
});

test('transcript text parsing and normalization match Python', () => {
    const input = 'csce145, MATH 141; bad value. Csce145\nENGL101a';
    assert.deepEqual(
        transcript.parseText(input),
        pythonResult('transcript', 'parse_text', [input]),
    );
    for (const value of ['csce145', 'prefix MATH 141 suffix', 'bad value', 'ENGL101a']) {
        assert.equal(
            transcript.normalizeCode(value),
            pythonResult('transcript', 'normalize_code', [value]),
        );
    }
});

test('transcript CSV parsing matches Python for separate columns, quotes, duplicates, and headerless input', () => {
    const fixtures = [
        [
            'Subject,Number,Grade,Credit Hours,Term',
            'CSCE,145,A,4,Fall 2025',
            'MATH,141,B+,4,Spring 2026',
            'CSCE,145,C,4,Fall 2024',
            'ENGL,101,,3.0,"Fall, 2025"',
        ].join('\n'),
        'CSCE 145,MATH141\nENGL 101,not a course',
        'Course,Grade\n"CSCE 145",A\n"HIST 111",W',
    ];
    for (const csv of fixtures) {
        assert.deepEqual(
            transcript.parseCsv(csv),
            pythonResult('transcript', 'parse_csv', [csv]),
        );
    }
});

test('grade threshold handling matches Python', () => {
    for (const grade of [null, 'A-', 'C', 'C-', 'D+', 'F', 'W', 'S', 'unknown']) {
        for (const minimum of ['B', 'C', 'D']) {
            assert.equal(
                transcript.isPassing(grade, minimum),
                pythonResult('transcript', 'is_passing', [grade], { min_grade: minimum }),
            );
        }
    }
});

const MAJOR_MAP = {
    total_credits_required: 16,
    offering_hints: {},
    concentrations: { general: { extra_required: [] } },
    required_courses: [
        { code: 'TEST 101', title: 'First', credits: 4, typical_year: 1, prerequisites: [], category: 'major' },
        { code: 'TEST 102', title: 'Second', credits: 4, typical_year: 1, prerequisites: ['TEST 101'], category: 'major' },
        { code: 'TEST 201', title: 'Third', credits: 3, typical_year: 2, prerequisites: [], category: 'major' },
        { code: 'TEST 301', title: 'Fourth', credits: 3, typical_year: 3, prerequisites: ['TEST 102'], category: 'major' },
    ],
    elective_groups: [
        { id: 'choice', label: 'Program elective', options: ['TEST 250'], pick: 1, credits_each: 2, category: 'elective' },
    ],
};

test('remaining-degree analysis matches Python for required and elective credits', () => {
    const completed = ['TEST 101'];
    assert.deepEqual(
        planner.computeRemaining(MAJOR_MAP, completed, 'general'),
        pythonResult('planner', 'compute_remaining', [MAJOR_MAP, completed], { concentration: 'general' }),
    );
});

test('legacy flat-map degree plans match Python semester for semester', () => {
    const completed = [];
    const options = {
        mode: 'full_time',
        pins: { 'TEST 201': '202608' },
        start_term: '202608',
        include_summer: false,
        concentration: 'general',
    };
    assert.deepEqual(
        planner.planDegree(MAJOR_MAP, completed, options),
        pythonResult('planner', 'plan_degree', [MAJOR_MAP, completed], options),
    );
});

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

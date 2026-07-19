const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const solverSource = fs.readFileSync('static/js/solver-core.js', 'utf8');

function loadSolver() {
    const context = vm.createContext({});
    vm.runInContext(`${solverSource}\nglobalThis.__solver = SolverCore;`, context);
    return context.__solver;
}

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function section(crn, meetingTimes, overrides = {}) {
    return {
        crn,
        code: overrides.code || 'TEST 101',
        meetingTimes,
        hours: 3,
        ...overrides,
    };
}

/*
 * These expectations were originally produced by a Python reference solver,
 * which has since been removed. Its outputs are frozen in the fixture file so
 * the browser solver stays pinned to a known-good result on every run.
 *
 * To re-record after an intentional change, restore src/scheduler.py and run
 * this file with PARITY_RECORD=1.
 */
const SOLVER_FIXTURES = path.join(__dirname, 'fixtures/solver_reference.json');
const SOLVER_RECORDING = process.env.PARITY_RECORD === '1';
const solverRecorded = SOLVER_RECORDING || !fs.existsSync(SOLVER_FIXTURES)
    ? {}
    : JSON.parse(fs.readFileSync(SOLVER_FIXTURES, 'utf8'));

function computeSolveFromPython(fixtures) {
    const projectPython = path.resolve('.venv/bin/python');
    const python = fs.existsSync(projectPython) ? projectPython : 'python3';
    const script = [
        'import json, sys',
        'from scheduler import solve',
        'fixtures = json.load(sys.stdin)',
        'json.dump([solve(fixture) for fixture in fixtures], sys.stdout)',
    ].join('\n');
    const result = childProcess.spawnSync(python, ['-c', script], {
        cwd: process.cwd(),
        encoding: 'utf8',
        input: JSON.stringify(fixtures),
        env: { ...process.env, PYTHONPATH: path.resolve('src') },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
}

function pythonSolve(fixtures) {
    const key = JSON.stringify(fixtures);
    if (SOLVER_RECORDING) {
        solverRecorded[key] = computeSolveFromPython(fixtures);
        fs.writeFileSync(SOLVER_FIXTURES, `${JSON.stringify(solverRecorded, null, 2)}\n`);
        return solverRecorded[key];
    }
    assert.ok(
        Object.prototype.hasOwnProperty.call(solverRecorded, key),
        'No recorded solver output for this fixture set. Restore src/scheduler.py '
        + 'and re-record with PARITY_RECORD=1.',
    );
    return solverRecorded[key];
}

test('browser solver matches Python solver across representative schedules', () => {
    const fixtures = [
        {
            courses: [{
                code: 'TEST 101',
                sections: [
                    section('monday', '[{"meet_day":0,"start_time":900,"end_time":1000}]'),
                    section('tuesday', '[{"meet_day":1,"start_time":900,"end_time":1000}]'),
                ],
            }],
            preferences: { avoided_days: [0] },
        },
        {
            courses: [
                {
                    code: 'TEST 101',
                    sections: [section('online', '', {
                        hours: '1 TO 4',
                        meets: 'Does Not Meet',
                        inst_mthd: 'DWEB',
                    })],
                },
                {
                    code: 'TEST 102',
                    sections: [section('campus', '[{"meet_day":2,"start_time":1430,"end_time":1545}]', {
                        code: 'TEST 102',
                        hours: 2,
                    })],
                },
            ],
            preferences: { max_credits: 6, preferred_end: 1500 },
        },
        {
            courses: [
                {
                    code: 'TEST 101',
                    sections: [section('origin', '[{"meet_day":0,"start_time":900,"end_time":1000}]', {
                        _walking_locations: [{
                            day: 0,
                            start: 540,
                            latitude: 34,
                            longitude: -81,
                        }],
                    })],
                },
                {
                    code: 'TEST 102',
                    sections: [
                        section('short', '[{"meet_day":0,"start_time":1010,"end_time":1100}]', {
                            code: 'TEST 102',
                            _walking_locations: [{
                                day: 0,
                                start: 610,
                                latitude: 34,
                                longitude: -80.999,
                            }],
                        }),
                        section('long', '[{"meet_day":0,"start_time":1030,"end_time":1100}]', {
                            code: 'TEST 102',
                            _walking_locations: [{
                                day: 0,
                                start: 630,
                                latitude: 34,
                                longitude: -80.999,
                            }],
                        }),
                    ],
                },
            ],
            preferences: {
                minimum_walking_buffer_minutes: 10,
                walking_buffer_required: true,
            },
        },
        {
            courses: [{
                code: 'TEST 101',
                sections: [
                    section('early', '[{"meet_day":0,"start_time":730,"end_time":820}]'),
                    section('painted', '[{"meet_day":0,"start_time":900,"end_time":1000}]'),
                    section('allowed', '[{"meet_day":0,"start_time":1100,"end_time":1200}]'),
                ],
            }],
            preferences: {
                preferred_start: 800,
                preferred_end: 2100,
                avoided_time_blocks: [{ day: 0, start: 900, end: 1000 }],
                time_preferences_required: true,
            },
        },
        {
            courses: [
                {
                    code: 'TEST 101',
                    sections: [
                        section('a1', '[{"meet_day":0,"start_time":900,"end_time":950}]'),
                        section('a2', '[{"meet_day":1,"start_time":900,"end_time":950}]'),
                        section('a3', '[{"meet_day":2,"start_time":900,"end_time":950}]'),
                    ],
                },
                {
                    code: 'TEST 102',
                    sections: [
                        section('b1', '[{"meet_day":0,"start_time":1000,"end_time":1050}]', { code: 'TEST 102' }),
                        section('b2', '[{"meet_day":1,"start_time":1000,"end_time":1050}]', { code: 'TEST 102' }),
                        section('b3', '[{"meet_day":2,"start_time":1000,"end_time":1050}]', { code: 'TEST 102' }),
                    ],
                },
            ],
            preferences: {},
            max_results: 2,
        },
        {
            courses: [{
                code: 'TEST 101',
                sections: [section('round-half-even', '[]', {
                    instr: 'Preferred',
                    meets: 'Online asynchronous',
                })],
            }],
            preferences: { preferred_instructors: { Preferred: 0.2125 } },
        },
    ];

    const expected = pythonSolve(fixtures);
    const solver = loadSolver();
    const actual = fixtures.map(fixture => plain(solver.solve(fixture)));
    assert.deepEqual(actual, expected);
});

test('browser solver preserves asynchronous, TBA, credit, and conflict behavior', () => {
    const solver = loadSolver();
    const asynchronous = solver.solve({
        courses: [{
            code: 'TEST 101',
            sections: [section('online', '', { meets: 'Online asynchronous' })],
        }],
    });
    const unscheduled = solver.solve({
        courses: [{
            code: 'TEST 101',
            sections: [section('tba', '', { meets: 'TBA' })],
        }],
    });
    const creditLimited = solver.solve({
        courses: [
            {
                code: 'TEST 101',
                sections: [section('10001', '[]', { meets: 'Online asynchronous' })],
            },
            {
                code: 'TEST 102',
                sections: [section('10002', '[]', {
                    code: 'TEST 102',
                    meets: 'Online asynchronous',
                })],
            },
        ],
        preferences: { max_credits: 5 },
    });

    assert.equal(asynchronous.total_found, 1);
    assert.equal(unscheduled.total_found, 0);
    assert.equal(creditLimited.total_found, 0);
});

test('browser solver ranks the worst route rather than aggregate route time', () => {
    const solver = loadSolver();
    const origin = { day: 0, start: 900, end: 1000, latitude: 34, longitude: -81 };
    const destination = {
        day: 0,
        start: 1020,
        end: 1100,
        latitude: 34,
        longitude: -80.99,
    };
    const singleRoute = {
        A: { _parsed_times: [origin] },
        B: { _parsed_times: [destination] },
    };
    const repeatedRoutes = {
        ...singleRoute,
        C: { _parsed_times: [{
            day: 0,
            start: 1120,
            end: 1200,
            latitude: 34,
            longitude: -81,
        }] },
        D: { _parsed_times: [{
            day: 0,
            start: 1220,
            end: 1300,
            latitude: 34,
            longitude: -80.99,
        }] },
    };

    assert.equal(solver.scoreSchedule(singleRoute, {}), solver.scoreSchedule(repeatedRoutes, {}));
});

test('solver worker returns results under the originating request identifier', () => {
    let messageHandler;
    const posted = [];
    const context = vm.createContext({
        importScripts() {
            vm.runInContext(solverSource, context);
        },
        self: {
            addEventListener(type, handler) {
                if (type === 'message') messageHandler = handler;
            },
            postMessage(message) {
                posted.push(message);
            },
        },
    });
    vm.runInContext(fs.readFileSync('static/js/solver-worker.js', 'utf8'), context);
    messageHandler({
        data: {
            id: 42,
            params: {
                courses: [{
                    code: 'TEST 101',
                    sections: [section('online', '', { meets: 'Online asynchronous' })],
                }],
            },
        },
    });

    assert.equal(posted.length, 1);
    assert.equal(posted[0].id, 42);
    assert.equal(posted[0].result.total_found, 1);
});

test('API solver fallback runs locally and never calls the server', async () => {
    const context = vm.createContext({
        fetch() {
            throw new Error('Network should not be used for schedule solving');
        },
        Worker: undefined,
    });
    vm.runInContext(solverSource, context);
    vm.runInContext(`${fs.readFileSync('static/js/api.js', 'utf8')}\nglobalThis.__api = API;`, context);
    const result = await context.__api.solve([
        {
            code: 'TEST 101',
            sections: [section('online', '', { meets: 'Online asynchronous' })],
        },
    ], {}, 10);

    assert.equal(result.total_found, 1);
    assert.equal(result.schedules[0].sections['TEST 101'].crn, 'online');
});

test('API solver reuses one worker and matches concurrent replies by identifier', async () => {
    const solver = loadSolver();
    const workers = [];
    class FakeWorker {
        constructor(url) {
            this.url = url;
            this.listeners = {};
            this.messages = [];
            workers.push(this);
        }

        addEventListener(type, handler) {
            this.listeners[type] = handler;
        }

        postMessage(message) {
            this.messages.push(message);
            setImmediate(() => this.listeners.message({
                data: { id: message.id, result: plain(solver.solve(message.params)) },
            }));
        }

        terminate() {}
    }

    const context = vm.createContext({ Worker: FakeWorker });
    vm.runInContext(`${fs.readFileSync('static/js/api.js', 'utf8')}\nglobalThis.__api = API;`, context);
    const makeCourse = code => ({
        code,
        sections: [section(`${code}-online`, '', { code, meets: 'Online asynchronous' })],
    });
    const [first, second] = await Promise.all([
        context.__api.solve([makeCourse('TEST 101')], {}, 10),
        context.__api.solve([makeCourse('TEST 102')], {}, 10),
    ]);

    assert.equal(workers.length, 1);
    assert.equal(workers[0].url, '/static/js/solver-worker.js');
    assert.deepEqual(workers[0].messages.map(message => message.id), [1, 2]);
    assert.equal(first.schedules[0].sections['TEST 101'].crn, 'TEST 101-online');
    assert.equal(second.schedules[0].sections['TEST 102'].crn, 'TEST 102-online');
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
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

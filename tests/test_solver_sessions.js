const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const { performance } = require('node:perf_hooks');
const SolverCore = require('../static/js/solver-core.js');
const SolverClient = require('../static/js/solver-client.js');
const plain = value => JSON.parse(JSON.stringify(value));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function section(crn, meetings = [], extra = {}) {
    return { crn, hours: 3, meetingTimes: JSON.stringify(meetings),
        ...(meetings.length ? {} : { meets: 'Online asynchronous' }), ...extra };
}
function meeting(day, start, end) { return { meet_day: day, start_time: start, end_time: end }; }
function collect(params, checkpoint = null, limit = 3) {
    let session = SolverCore.createSession(params, checkpoint);
    const results = [];
    while (!session.complete) {
        const batch = SolverCore.step(session, { budgetMs: 50, maxResults: limit });
        results.push(...batch.results);
        session = SolverCore.createSession(params, plain(batch.checkpoint));
    }
    return { results, checkpoint: SolverCore.getCheckpoint(session) };
}
// Independent exhaustive enumerator. It does not use session domains, the
// compatibility cache, selection ordering, or continuation machinery.
function exhaustive(params) {
    const found = [];
    const assignment = {};
    function visit(index, credits) {
        if (index === params.courses.length) {
            if (SolverCore.requiredPreferencesSatisfied(assignment, params.preferences || {})) {
                found.push(JSON.stringify([String(params.term || ''), Object.entries(assignment)
                    .map(([code, value]) => [code, String(value.crn)])
                    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))]));
            }
            return;
        }
        const course = params.courses[index];
        for (const original of course.sections) {
            const lock = params.section_locks?.[course.code];
            if (lock && String(original.crn) !== String(lock)) continue;
            const parsed = SolverCore.attachWalkingLocations(SolverCore.parseMeetingTimes(original.meetingTimes), original._walking_locations || []);
            if (!parsed.length && !SolverCore.isAsynchronous(original)) continue;
            const nextCredits = credits + SolverCore.sectionCredits(original);
            if (params.preferences?.max_credits != null && nextCredits > params.preferences.max_credits) continue;
            if (SolverCore.blockedConflict(parsed, params.preferences?.blocked_times || [])) continue;
            if (Object.values(assignment).some(value => SolverCore.timesOverlap(parsed, value._parsed_times))) continue;
            assignment[course.code] = { ...original, _parsed_times: parsed };
            visit(index + 1, nextCredits);
            delete assignment[course.code];
        }
    }
    visit(0, 0);
    return found.sort();
}

const fixture = {
    term: '202701', session_id: 'small', input_revision: 'revision-1', preferences: { max_credits: 12 },
    courses: [
        { code: 'A 101', sections: [section('a1', [meeting(0, 900, 1000)]), section('a2', [meeting(1, 1100, 1200)]), section('a3')] },
        { code: 'B 101', sections: [section('b1', [meeting(0, 930, 1030)]), section('b2', [meeting(0, 1030, 1130)]), section('b3', [meeting(6, 1000, 1100)])] },
        { code: 'C 101', sections: [section('c1', [meeting(1, 1130, 1230)]), section('c2'), section('tba', [], { meets: 'TBA' })] },
    ],
};

test('resumed iterative search exactly matches independent exhaustive enumeration', () => {
    const found = collect(fixture);
    assert.deepEqual(found.results.map(value => value.id).sort(), exhaustive(fixture));
    assert.equal(new Set(found.results.map(value => value.id)).size, found.results.length);
    assert.deepEqual(found.results.map(value => value.ordinal), found.results.map((_, index) => index + 1));
    assert.equal(found.checkpoint.total_found, found.results.length);
    assert.equal(found.checkpoint.complete, true);
    for (const result of found.results) {
        assert.equal(Object.keys(SolverCore.materializeResult(fixture, result).sections).length, 3);
    }
});

test('required constraints, locks, missing credits, weekend and online behavior match exhaustive search', () => {
    for (const preferences of [
        { max_credits: 8 },
        { time_preferences_required: true, preferred_start: 1000, preferred_end: 1200 },
        { avoided_days_required: true, avoided_days: ['0', '6'] },
        { blocked_times: [{ day: 1, start: 1100, end: 1300 }] },
        { time_preferences_required: true, avoided_time_blocks: [{ day: 0, start: 1000, end: 1200 }] },
        { walking_buffer_required: true, minimum_walking_buffer_minutes: 45 },
    ]) {
        const params = { ...fixture, preferences };
        assert.deepEqual(collect(params).results.map(value => value.id).sort(), exhaustive(params));
    }
    const locked = { ...fixture, section_locks: { 'A 101': 'a2' } };
    assert.deepEqual(collect(locked).results.map(value => value.id).sort(), exhaustive(locked));
    const missingCredit = { courses: [{ code: 'A', sections: [section('a', [], { hours: null })] }], preferences: { max_credits: 2 } };
    assert.equal(collect(missingCredit).results.length, 0);
});

test('higher-order required walking rule is never pruned on a partial assignment', () => {
    const params = { preferences: { walking_buffer_required: true }, courses: [
        { code: 'A', sections: [section('a', [meeting(0, 900, 1000)], { _walking_locations: [{ day: 0, start: 540, latitude: 34, longitude: -81 }] })] },
        { code: 'B', sections: [section('b', [meeting(0, 1030, 1100)], { _walking_locations: [{ day: 0, start: 630, latitude: 34, longitude: -80.95 }] })] },
        { code: 'C', sections: [section('c', [meeting(0, 1010, 1020)])] },
    ] };
    assert.equal(collect(params).results.length, 1);
    assert.deepEqual(collect(params).results.map(value => value.id), exhaustive(params));
});

test('bounded legacy solve searches past the first thirty and returns globally best completed ranking', () => {
    const params = { max_results: 10, preferences: { preferred_instructors: { Favorite: 10 } }, courses: [
        { code: 'A', sections: Array.from({ length: 100 }, (_, index) => section(`a${index}`, [], { instructor: index === 99 ? 'Favorite' : 'Other' })) },
    ] };
    const result = SolverCore.solve(params);
    assert.equal(result.total_found, 100);
    assert.equal(result.search_complete, true);
    assert.equal(result.schedules[0].sections.A.crn, 'a99');
    assert.equal(result.returned, 10);
});

test('there is no course-count cap and duplicate catalog entries do not create duplicate schedules', () => {
    const params = { courses: Array.from({ length: 80 }, (_, index) => ({ code: `C${index}`, sections: [section(`x${index}`), section(`x${index}`)] })) };
    const found = collect(params);
    assert.equal(found.results.length, 1);
    assert.equal(found.results[0].refs.length, 80);
});

test('metrics include scheduled online meetings, Sunday, gaps and earliest start', () => {
    const params = { courses: [
        { code: 'A', sections: [section('a', [meeting(6, 900, 1000)])] },
        { code: 'B', sections: [section('b', [meeting(6, 1100, 1200)], { section: 'J01' })] },
        { code: 'C', sections: [section('c')] },
    ] };
    assert.deepEqual(collect(params).results[0].metrics, { campusDays: 1, campusDaysCompleteness: 'missing', gaps: 60, laterStart: 540, online: 2 });
});

test('checkpoint version and revision protect continuation identity', () => {
    const session = SolverCore.createSession(fixture);
    const checkpoint = SolverCore.getCheckpoint(session);
    assert.throws(() => SolverCore.createSession({ ...fixture, input_revision: 'changed' }, checkpoint), /does not match/);
    assert.throws(() => SolverCore.createSession(fixture, { ...checkpoint, version: 'unknown' }), /does not match/);
});

function largeFixture(count = 9, choices = 9) {
    return { term: '202701', session_id: 'large', input_revision: 'revision-large', courses: Array.from({ length: count }, (_, index) => ({
        code: `COURSE ${index}`, sections: Array.from({ length: choices }, (_, choice) => section(`${index}-${choice}`)),
    })) };
}

test('temporary client yields, atomically acknowledges batches and resumes after active-time pause', async () => {
    const params = largeFixture(5, 5);
    const all = [];
    const batches = [];
    const client = SolverClient.create(params, { useWorker: false, runBudgetMs: 1,
        onBatch: async batch => { await delay(2); all.push(...batch.results); batches.push(plain(batch)); } });
    const first = await client.start();
    assert.equal(first.state, 'paused');
    assert.equal(first.stop_reason, 'time_budget');
    let calls = 0;
    while (client.state !== 'complete' && calls++ < 1000) await client.resume();
    assert.equal(client.state, 'complete');
    assert.equal(all.length, 3125);
    assert.equal(new Set(all.map(value => value.id)).size, 3125);
    assert.equal(batches.at(-1).checkpoint.total_found, 3125);
    assert.ok(batches.every(batch => batch.results.length <= 250));
    client.dispose();
});

test('search cannot advance while a result batch awaits storage acknowledgement', async () => {
    let release;
    let received;
    const notified = new Promise(resolve => { received = resolve; });
    const client = SolverClient.create(largeFixture(), { useWorker: false, onBatch: batch => {
        received(batch);
        return new Promise(resolve => { release = resolve; });
    } });
    const running = client.start();
    const batch = await notified;
    const before = plain(batch.checkpoint);
    await delay(20);
    assert.deepEqual(batch.checkpoint, before);
    assert.equal(client.checkpoint.total_found, 0);
    const paused = client.pause();
    release();
    // A terminal empty batch also needs acknowledgement.
    const timer = setInterval(() => release?.(), 2);
    const result = await paused;
    clearInterval(timer);
    assert.equal(result.state, 'paused');
    assert.ok(result.total_found >= 250);
    await running;
    client.dispose();
});

test('storage failure rolls back to committed checkpoint without claiming completion', async () => {
    const client = SolverClient.create(largeFixture(), { useWorker: false, onBatch: () => { throw new Error('Quota exceeded'); } });
    const result = await client.start();
    assert.equal(result.state, 'paused');
    assert.equal(result.stop_reason, 'storage');
    assert.equal(result.total_found, 0);
    assert.equal(client.checkpoint.total_found, 0);
    assert.equal(result.checkpoint.complete, false);
    client.dispose();
});

test('immediate pause is honored and pause acknowledgement is under 500 milliseconds', async () => {
    const client = SolverClient.create(largeFixture(), { useWorker: false, onBatch: async () => {} });
    client.start();
    const start = performance.now();
    const result = await client.pause();
    const latency = performance.now() - start;
    assert.equal(result.state, 'paused');
    assert.equal(result.total_found, 0);
    assert.ok(latency < 500, `pause took ${latency}ms`);
    client.dispose();
});

class NativeWorkerHarness {
    constructor() {
        this.listeners = {};
        this.dead = false;
        const worker = this;
        const context = vm.createContext({ performance, setTimeout, clearTimeout,
            self: { addEventListener(_type, callback) { worker.handler = callback; },
                postMessage(message) { setImmediate(() => { if (!worker.dead) worker.listeners.message?.({ data: plain(message) }); }); } },
            importScripts(...urls) { urls.forEach(url => vm.runInContext(fs.readFileSync(`.${url}`, 'utf8'), context)); },
        });
        vm.runInContext(fs.readFileSync('static/js/solver-worker.js', 'utf8'), context);
        NativeWorkerHarness.instances.push(this);
    }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    postMessage(message) { setImmediate(() => { if (!this.dead) this.handler({ data: plain(message) }); }); }
    terminate() { this.dead = true; }
}
NativeWorkerHarness.instances = [];

test('real worker protocol restores from committed checkpoint after worker failure', async () => {
    const previousWorker = global.Worker;
    global.Worker = NativeWorkerHarness;
    try {
        const results = [];
        let killed = false;
        const client = SolverClient.create(largeFixture(4, 5), { runBudgetMs: 30000,
            onBatch: async batch => {
                results.push(...batch.results);
                if (!killed && batch.results.length) {
                    killed = true;
                    setImmediate(() => NativeWorkerHarness.instances.at(-1).listeners.error({ message: 'Simulated failure' }));
                }
            } });
        const end = await client.start();
        assert.equal(end.state, 'complete');
        assert.equal(results.length, 625);
        assert.equal(new Set(results.map(value => value.id)).size, 625);
        client.dispose();
    } finally { global.Worker = previousWorker; }
});

test('worker pause, refresh continuation, stale events, and page query preserve session boundaries', async () => {
    const previousWorker = global.Worker;
    global.Worker = NativeWorkerHarness;
    try {
        const params = largeFixture(4, 5);
        const found = [];
        let client;
        let requested = false;
        client = SolverClient.create(params, { onBatch: async batch => {
            found.push(...batch.results);
            if (!requested && batch.results.length) { requested = true; client.pause(); }
        }, onPageQuery: query => ({ query, count: found.length }) });
        const first = await client.start();
        assert.equal(first.state, 'paused');
        assert.equal(first.stop_reason, 'user');
        const checkpoint = plain(first.checkpoint);
        assert.equal((await client.queryPage({ page: 1 })).count, found.length);
        client.dispose();
        const count = found.length;
        NativeWorkerHarness.instances.at(-1).listeners.message({ data: { type: 'batch', session_id: params.session_id,
            input_revision: params.input_revision, results: [found[0]], checkpoint } });
        assert.equal(found.length, count);
        const refreshed = SolverClient.create(params, { checkpoint, onBatch: async batch => found.push(...batch.results) });
        assert.equal((await refreshed.start()).state, 'complete');
        assert.equal(found.length, 625);
        assert.equal(new Set(found.map(value => value.id)).size, 625);
        refreshed.dispose();
    } finally { global.Worker = previousWorker; }
});

test('representative and difficult-case measurements keep slices and pause latency bounded', async t => {
    const session = SolverCore.createSession(largeFixture(12, 20));
    const started = performance.now();
    let maximumSlice = 0;
    let firstResult = null;
    for (let index = 0; index < 20; index++) {
        const batch = SolverCore.step(session);
        maximumSlice = Math.max(maximumSlice, batch.active_ms);
        if (firstResult === null && batch.results.length) firstResult = performance.now() - started;
    }
    assert.equal(session.complete, false);
    assert.ok(session.cacheBytes <= SolverCore.CACHE_LIMIT_BYTES);
    const client = SolverClient.create(largeFixture(12, 20), { useWorker: false, onBatch: async () => {} });
    client.start();
    await delay(10);
    const pauseStarted = performance.now();
    const stopped = await client.pause();
    const latency = performance.now() - pauseStarted;
    assert.equal(stopped.state, 'paused');
    assert.ok(latency < 500);
    t.diagnostic(JSON.stringify({ first_result_ms: firstResult, maximum_slice_ms: maximumSlice,
        visited_branches: session.visited, schedules_found: session.total_found,
        compatibility_cache_bytes: session.cacheBytes, pause_latency_ms: latency }));
    client.dispose();
});


test('zero-solution sessions commit a terminal empty batch', async () => {
    let persisted;
    const client = SolverClient.create({ courses: [{ code: 'A', sections: [] }] }, { useWorker: false,
        onBatch: async batch => { persisted = batch; } });
    const result = await client.start();
    assert.equal(result.state, 'complete');
    assert.equal(persisted.state, 'complete');
    assert.equal(persisted.results.length, 0);
    assert.equal(persisted.checkpoint.complete, true);
    client.dispose();
});

test('campus day completeness distinguishes unknown and mixed campus locations', () => {
    const known = section('known', [meeting(0, 900, 1000)], { _walking_locations: [{ day: 0, start: 540, latitude: 34, longitude: -81 }] });
    const unknown = section('unknown', [meeting(1, 900, 1000)]);
    const knownParams = { courses: [{ code: 'A', sections: [known] }] };
    assert.equal(collect(knownParams).results[0].metrics.campusDaysCompleteness, 'complete');
    const mixed = { courses: [...knownParams.courses, { code: 'B', sections: [unknown] }] };
    assert.equal(collect(mixed).results[0].metrics.campusDaysCompleteness, 'partial');
    assert.equal(collect({ courses: [{ code: 'B', sections: [unknown] }] }).results[0].metrics.campusDaysCompleteness, 'missing');
});


test('checkpoint during forward-check scanning resumes every remaining candidate', () => {
    const params = { courses: [
        { code: 'A', sections: [section('a')] },
        { code: 'B', sections: Array.from({ length: 50 }, (_, index) => section(`b${index}`)) },
        { code: 'C', sections: Array.from({ length: 5 }, (_, index) => section(`c${index}`)) },
    ] };
    const session = SolverCore.createSession(params);
    const realPerformance = global.performance;
    let timestamp = 0;
    global.performance = { now: () => { timestamp += 0.01; return timestamp; } };
    let batch;
    try { batch = SolverCore.step(session, { budgetMs: 0.1 }); }
    finally { global.performance = realPerformance; }
    assert.ok(batch.checkpoint.stack.some(frame => frame.pending));
    const remaining = collect(params, plain(batch.checkpoint));
    const ids = [...batch.results, ...remaining.results].map(value => value.id).sort();
    assert.deepEqual(ids, exhaustive(params));
});

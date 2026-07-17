'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const {
    LiveUniversityClient,
    UniversityAccessBlockedError,
} = require('../static/js/live-university-client.js');

function jsonResponse(value, status = 200) {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function loadApi(contextValues = {}) {
    const context = vm.createContext({ ...contextValues });
    const source = `${fs.readFileSync('static/js/api.js', 'utf8')}\nglobalThis.__api = API;`;
    vm.runInContext(source, context);
    return { api: context.__api, context };
}

test('direct client coalesces and caches requests without exceeding its concurrency limit', async () => {
    let active = 0;
    let maximum = 0;
    const releases = [];
    const calls = [];
    const client = new LiveUniversityClient({
        maxConcurrency: 2,
        timeoutMs: 10_000,
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            active += 1;
            maximum = Math.max(maximum, active);
            await new Promise(resolve => releases.push(resolve));
            active -= 1;
            return jsonResponse({ request: JSON.parse(options.body).criteria[0].value });
        },
    });

    const first = client.searchCourses('202608', [{ field: 'subject', value: 'CSCE' }]);
    const duplicate = client.searchCourses('202608', [{ field: 'subject', value: 'CSCE' }]);
    const second = client.searchCourses('202608', [{ field: 'subject', value: 'MATH' }]);
    const third = client.searchCourses('202608', [{ field: 'subject', value: 'EMCH' }]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 2);
    assert.equal(maximum, 2);
    releases.splice(0).forEach(resolve => resolve());
    await new Promise(resolve => setImmediate(resolve));
    releases.splice(0).forEach(resolve => resolve());
    assert.deepEqual(await Promise.all([first, duplicate, second, third]), [
        { request: 'CSCE' },
        { request: 'CSCE' },
        { request: 'MATH' },
        { request: 'EMCH' },
    ]);
    await client.searchCourses('202608', [{ field: 'subject', value: 'CSCE' }]);
    assert.equal(calls.length, 3, 'the duplicate and warm-cache calls share one network request');
});

test('direct client retries transient HTTP failures but identifies browser access blocking', async () => {
    let attempts = 0;
    const retrying = new LiveUniversityClient({
        retries: 1,
        retryBaseMs: 0,
        sleep: async () => {},
        fetchImpl: async () => {
            attempts += 1;
            return attempts === 1 ? jsonResponse({}, 503) : jsonResponse({ results: [] });
        },
    });
    assert.deepEqual(await retrying.searchCourses('202608', []), { results: [] });
    assert.equal(attempts, 2);

    const blocked = new LiveUniversityClient({
        origin: 'https://scheduler.example',
        fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    });
    await assert.rejects(
        () => blocked.searchCourses('202608', []),
        error => error instanceof UniversityAccessBlockedError
            && error.code === 'DIRECT_ACCESS_BLOCKED'
            && error.corsBlocked === true,
    );
});

test('static API uses only browser data and workers and never requests a same-origin API route', async () => {
    const fetchCalls = [];
    const artifactCalls = [];
    const catalog = {
        'CSCE 145': {
            code: 'CSCE 145',
            subject: 'CSCE',
            key: '145-key',
            title: 'Algorithmic Design I',
            description: 'Problem solving and programming',
            prerequisite_text: 'Prerequisite: MATH 111.',
        },
    };
    const artifacts = {
        'catalog/subjects': { subjects: ['CSCE', 'MATH'] },
        'catalog/courses/CSCE': { courses: catalog },
        'catalog/courses/MATH': { courses: {} },
        'major-maps/index': { maps: [{ id: 'test-map', major: 'Test' }] },
        'major-maps/test-map': { id: 'test-map', required_courses: [] },
    };
    const dataStore = {
        async getArtifact(name) {
            artifactCalls.push(name);
            return artifacts[name];
        },
        async getOfferingHistory(code) {
            return { code, as_of_term: '202608', terms: [{ term: '202601', offered: true }] };
        },
        async getCourseGrades(code) { return { code, average_gpa: 3.25 }; },
        async getProfessorGrades(id) { return { id, average_gpa: 3.5 }; },
    };
    class BlockedLiveClient {
        async request() {
            throw new UniversityAccessBlockedError('https://classes.sc.edu/api/');
        }
    }
    const { api } = loadApi({
        CourseSchedulerConfig: { apiMode: 'static' },
        CourseDataStore: dataStore,
        LiveUniversityClient: BlockedLiveClient,
        Worker: undefined,
        TranscriptParserRuntime: {
            parseText: () => ['CSCE 145'],
            parseCsv: () => [{ code: 'CSCE 145', grade: 'A', credits: 4, semester: '202601' }],
        },
        DegreePlannerRuntime: {
            planDegree: (_map, completed) => ({ completed }),
        },
        OfferingAnalyzerRuntime: {
            getOfferingSummary: history => ({ code: history.code, frequency: 1 }),
        },
        fetch: async url => {
            fetchCalls.push(String(url));
            throw new Error('same-origin API must not be used');
        },
    });

    assert.deepEqual(plain(await api.getSubjects()), ['CSCE', 'MATH']);
    assert.deepEqual(plain(await api.getMajorMaps()), [{ id: 'test-map', major: 'Test' }]);
    assert.equal((await api.getMajorMap('test-map')).id, 'test-map');
    assert.equal((await api.getCourseGrades('CSCE 145')).average_gpa, 3.25);
    assert.equal((await api.getProfessorGrades('prof_1')).average_gpa, 3.5);
    assert.equal((await api.getHistory('CSCE 145')).terms.length, 1);
    assert.equal((await api.parseTranscript('CSCE 145')).courses[0].code, 'CSCE 145');
    assert.deepEqual(plain(await api.getDegreePlan({
        map_id: 'test-map',
        completed: ['CSCE 145'],
    })), { completed: ['CSCE 145'] });
    assert.equal((await api.getOfferingAnalysis('CSCE 145', '202608')).frequency, 1);

    const fallback = await api.searchCourses('202608', [
        { field: 'subject', value: 'CSCE' },
    ]);
    assert.equal(fallback.results[0].code, 'CSCE 145');
    assert.equal(fallback.results[0].availability_unknown, true);
    assert.equal(fallback.availability_unknown, true);
    assert.equal(fallback._live_error.code, 'DIRECT_ACCESS_BLOCKED');
    const exactFallback = await api.searchCourses('202608', [
        { field: 'alias', value: 'CSCE 145' },
    ]);
    assert.equal(exactFallback.results[0].code, 'CSCE 145');
    assert.equal(
        artifactCalls.includes('catalog/courses/MATH'),
        false,
        'an exact course code loads only its inferred subject shard',
    );
    assert.equal((await api.bulletinDetails('145-key')).prereq, 'Prerequisite: MATH 111.');
    assert.deepEqual(fetchCalls, []);

    await assert.rejects(
        () => api.searchCourses('202608', [{ field: 'crn', value: '12345' }]),
        error => error.code === 'DIRECT_ACCESS_BLOCKED',
    );
    assert.deepEqual(fetchCalls, []);
});

test('runtime worker replies are correlated when concurrent responses arrive out of order', async () => {
    const workers = [];
    class FakeWorker {
        constructor(url) {
            this.url = url;
            this.listeners = {};
            this.messages = [];
            workers.push(this);
        }

        addEventListener(type, listener) { this.listeners[type] = listener; }
        postMessage(message) { this.messages.push(message); }
        terminate() {}
        reply(message, result) {
            this.listeners.message({
                data: { requestId: message.requestId, ok: true, result },
            });
        }
    }
    const { api } = loadApi({
        CourseSchedulerConfig: { apiMode: 'static' },
        CourseDataStore: {},
        LiveUniversityClient: class {},
        Worker: FakeWorker,
    });
    const first = api.parseTranscript('CSCE 145');
    const second = api.parseTranscript('MATH 141');
    assert.equal(workers.length, 1);
    assert.equal(workers[0].url, '/static/js/workers/transcript-worker.js');
    const [firstMessage, secondMessage] = workers[0].messages;
    workers[0].reply(secondMessage, ['MATH 141']);
    workers[0].reply(firstMessage, ['CSCE 145']);
    assert.equal((await first).courses[0].code, 'CSCE 145');
    assert.equal((await second).courses[0].code, 'MATH 141');
});

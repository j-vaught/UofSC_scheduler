'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const {
    DEFAULT_ENDPOINTS,
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

test('live client uses the same-origin relay for course search, details, and faculty', async () => {
    const calls = [];
    const client = new LiveUniversityClient({
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            if (url === '/api/search') return jsonResponse({ results: [] });
            if (url === '/api/details') return jsonResponse({ code: 'CSCE 145' });
            return jsonResponse({ faculty: [{ crn: '10868', professor_id: 'prof_test' }] });
        },
    });

    await client.searchCourses('202608', [{ field: 'alias', value: 'CSCE 145' }]);
    await client.getDetails('10868', '202608');
    await client.faculty('202608', ['10868']);

    assert.equal(DEFAULT_ENDPOINTS.courseSearch, '/api/search');
    assert.equal(DEFAULT_ENDPOINTS.courseDetails, '/api/details');
    assert.equal(DEFAULT_ENDPOINTS.faculty, '/api/faculty');
    assert.equal(calls[0].url, '/api/search');
    assert.deepEqual(JSON.parse(calls[0].options.body), {
        other: { srcdb: '202608' },
        criteria: [{ field: 'alias', value: 'CSCE 145' }],
    });
    assert.equal(calls[1].url, '/api/details');
    assert.deepEqual(JSON.parse(calls[1].options.body), {
        group: 'crn:10868',
        srcdb: '202608',
    });
    assert.equal(calls[2].url, '/api/faculty');
    assert.deepEqual(JSON.parse(calls[2].options.body), {
        term: '202608',
        crns: ['10868'],
    });
});

test('static API batches faculty identities through the same-origin client', async () => {
    const facultyCalls = [];
    class FacultyClient {
        async faculty(term, crns, options) {
            facultyCalls.push({ term, crns, options });
            return {
                faculty: crns.map(crn => ({
                    crn,
                    name: 'Simin, Grigory',
                    email: 'simin@engr.sc.edu',
                    professor_id: 'prof_c68c41fec5f7f933',
                })),
            };
        }
    }
    const { api } = loadApi({
        CourseSchedulerConfig: { apiMode: 'static' },
        LiveUniversityClient: FacultyClient,
    });

    const result = await api.getFaculty('202608', ['10368', '10368'], { forceRefresh: true });

    assert.equal(facultyCalls.length, 1);
    assert.deepEqual(plain(facultyCalls[0]), {
        term: '202608',
        crns: ['10368'],
        options: { forceRefresh: true },
    });
    assert.equal(result.faculty[0].professor_id, 'prof_c68c41fec5f7f933');
});

test('live client coalesces and caches requests without exceeding its concurrency limit', async () => {
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

test('live client retries transient HTTP failures and identifies cross-origin blocking', async () => {
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
        endpoints: {
            courseSearch: 'https://courses.example/api/search',
        },
        fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    });
    await assert.rejects(
        () => blocked.searchCourses('202608', []),
        error => error instanceof UniversityAccessBlockedError
            && error.code === 'DIRECT_ACCESS_BLOCKED'
            && error.corsBlocked === true,
    );
});

test('static API uses browser data and workers when the live overlay is unavailable', async () => {
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

test('static API loads compact-index major-map descriptors through the data store', async () => {
    const descriptor = {
        url: 'releases/test-release/major-maps/test-map.1234.json',
        bytes: 62,
        sha256: 'a'.repeat(64),
    };
    const loadCalls = [];
    const dataStore = {
        async getArtifact(name) {
            assert.equal(name, 'major-maps/index');
            return { maps: [{ id: 'test-map', major: 'Test', artifact: descriptor }] };
        },
        async getManifest() {
            return { release_id: 'test-release' };
        },
        async _loadArtifact(options) {
            loadCalls.push(options);
            return { id: 'test-map', required_courses: [] };
        },
    };
    const { api } = loadApi({
        CourseSchedulerConfig: { apiMode: 'static' },
        CourseDataStore: dataStore,
    });

    assert.equal((await api.getMajorMap('test-map')).id, 'test-map');
    assert.equal((await api.getMajorMap('test-map')).id, 'test-map');
    assert.equal(loadCalls.length, 1, 'the verified lazy artifact is reused in memory');
    assert.equal(loadCalls[0].logicalName, 'major-maps/test-map');
    assert.equal(loadCalls[0].descriptor, descriptor);
    assert.equal(loadCalls[0].manifest.release_id, 'test-release');
    assert.equal(loadCalls[0].memoryKey, 'test-release:major-maps/test-map');
    assert.equal(loadCalls[0].forceRefresh, false);
});

test('static API rejects compact-index descriptors it cannot verify', async () => {
    const dataStore = {
        async getArtifact() {
            return {
                maps: [{
                    id: 'test-map',
                    artifact: {
                        url: 'releases/test-release/major-maps/test-map.json',
                        bytes: 10,
                        sha256: 'b'.repeat(64),
                    },
                }],
            };
        },
    };
    const { api } = loadApi({
        CourseSchedulerConfig: { apiMode: 'static' },
        CourseDataStore: dataStore,
    });

    await assert.rejects(
        () => api.getMajorMap('test-map'),
        error => error.code === 'MAJOR_MAP_ARTIFACT_UNSUPPORTED',
    );
});

test('static API reuses a catalog-year major-map bundle', async () => {
    const descriptor = {
        url: 'releases/test-release/major-maps/major-maps-2026-2027.json',
        bytes: 200,
        sha256: 'c'.repeat(64),
        bundle_key: 'major-maps/catalog-year/2026-2027',
    };
    const loadCalls = [];
    const dataStore = {
        async getArtifact(name) {
            assert.equal(name, 'major-maps/index');
            return {
                maps: [
                    { id: 'map-a', artifact: { ...descriptor, entry_key: 'map-a' } },
                    { id: 'map-b', artifact: { ...descriptor, entry_key: 'map-b' } },
                ],
            };
        },
        async getManifest() {
            return { release_id: 'test-release' };
        },
        async _loadArtifact(options) {
            loadCalls.push(options);
            return { maps: { 'map-a': { id: 'map-a' }, 'map-b': { id: 'map-b' } } };
        },
    };
    const { api } = loadApi({
        CourseSchedulerConfig: { apiMode: 'static' },
        CourseDataStore: dataStore,
    });

    assert.equal((await api.getMajorMap('map-a')).id, 'map-a');
    assert.equal((await api.getMajorMap('map-b')).id, 'map-b');
    assert.equal(loadCalls.length, 1);
    assert.equal(loadCalls[0].logicalName, 'major-maps/catalog-year/2026-2027');
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
    // Bare in the source: the build stamps this with a digest of the worker as
    // built, so a version here would be hand-written and would drift. The
    // digest itself is checked against the real dist in
    // tests/test_worker_asset_stamping.py.
    assert.equal(workers[0].url, '/static/js/workers/transcript-worker.js');
    const [firstMessage, secondMessage] = workers[0].messages;
    workers[0].reply(secondMessage, ['MATH 141']);
    workers[0].reply(firstMessage, ['CSCE 145']);
    assert.equal((await first).courses[0].code, 'CSCE 145');
    assert.equal((await second).courses[0].code, 'MATH 141');
});

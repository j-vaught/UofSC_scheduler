/*
 * Behaviour contracts for the browser API client (static/js/api.js):
 * request coalescing, caching, detail prefetch and offering-history streaming.
 * Split out of test_scheduler_frontend.js by module-under-test.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    loadObject,
} = require('./support/scheduler-harness.js');

test('API error payloads reject so failed searches are never cached as empty results', async () => {
    const api = loadObject('static/js/api.js', 'API', {
        fetch: async () => ({
            ok: true,
            status: 200,
            async json() { return { error: 'upstream unavailable' }; },
        }),
    });

    await assert.rejects(
        () => api.post('/api/search', {}),
        /upstream unavailable/,
    );
});

test('API coalesces duplicate live requests and reuses its short browser cache', async () => {
    let release;
    let calls = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const api = loadObject('static/js/api.js', 'API', {
        fetch: async () => {
            calls += 1;
            await gate;
            return {
                ok: true,
                status: 200,
                async json() { return { results: [{ code: 'CSCE 145' }] }; },
            };
        },
    });

    const first = api.searchCourses('202608', [{ field: 'subject', value: 'CSCE' }]);
    const second = api.searchCourses('202608', [{ value: 'CSCE', field: 'subject' }]);
    await Promise.resolve();
    assert.equal(calls, 1);
    release();
    assert.deepEqual(await first, await second);
    await api.searchCourses('202608', [{ field: 'subject', value: 'CSCE' }]);
    assert.equal(calls, 1);
});

test('API browser cache keeps recently reused entries during eviction', () => {
    const api = loadObject('static/js/api.js', 'API', {});
    api._responseCacheMaxEntries = 2;
    api._storeCached('older-hot', { value: 1 }, 60_000);
    api._storeCached('newer-cold', { value: 2 }, 60_000);

    assert.deepEqual(api._cached('older-hot'), { value: 1 });
    api._storeCached('newest', { value: 3 }, 60_000);

    assert.equal(api._responseCache.has('newer-cold'), false);
    assert.equal(api._responseCache.has('older-hot'), true);
    assert.equal(api._responseCache.has('newest'), true);
});

test('detail prefetch is sequential and stops after cancellation', async () => {
    const controller = new AbortController();
    const calls = [];
    const api = loadObject('static/js/api.js', 'API', {
        requestIdleCallback: callback => callback(),
        setTimeout: callback => callback(),
        fetch: async (_path, options) => {
            const body = JSON.parse(options.body);
            calls.push(body.group);
            if (calls.length === 1) controller.abort();
            return { ok: true, status: 200, async json() { return {}; } };
        },
    });

    await api.prefetchCourseDetails(
        [{ crn: '10001' }, { crn: '10001' }, { crn: '10002' }],
        '202608',
        { signal: controller.signal },
    );

    assert.deepEqual(calls, ['crn:10001']);
});

test('A browser reload requests fresh live data without changing historical cache behavior', async () => {
    const requests = [];
    const api = loadObject('static/js/api.js', 'API', {
        performance: { getEntriesByType: () => [{ type: 'reload' }] },
        fetch: async (path, options) => {
            requests.push({ path, options });
            return { ok: true, status: 200, async json() { return {}; } };
        },
    });

    assert.equal(api.shouldRefreshAfterReload(), true);
    api.setForceRefreshLive(true);
    await api.post('/api/search', {});
    api.setForceRefreshLive(false);
    await api.post('/api/history', { code: 'CSCE 145' });

    assert.equal(requests[0].options.headers['X-UofSC-Refresh-Live'], '1');
    assert.equal(requests[1].options.headers['X-UofSC-Refresh-Live'], undefined);
});

test('Offering history stream reports real progress before returning its aggregate', async () => {
    const events = [
        JSON.stringify({ type: 'progress', phase: 'terms', completed: 0, total: 8, label: 'Fall 2023' }),
        JSON.stringify({ type: 'progress', phase: 'terms', completed: 3, total: 8, label: 'Fall 2024' }),
        JSON.stringify({ type: 'result', data: { code: 'CSCE 145', terms: [] } }),
    ].join('\n') + '\n';
    const encoded = new TextEncoder().encode(events);
    const chunks = [encoded.slice(0, 47), encoded.slice(47, 121), encoded.slice(121)];
    const requests = [];
    const api = loadObject('static/js/api.js', 'API', {
        TextDecoder,
        fetch: async (path, options) => {
            requests.push({ path, options });
            let index = 0;
            return {
                ok: true,
                status: 200,
                body: {
                    getReader() {
                        return {
                            async read() {
                                if (index >= chunks.length) return { done: true };
                                return { done: false, value: chunks[index++] };
                            },
                        };
                    },
                },
            };
        },
    });
    const progress = [];

    const result = await api.getHistory('CSCE 145', event => progress.push(event));

    assert.equal(requests[0].path, '/api/history-stream');
    assert.equal(requests[0].options.method, 'POST');
    assert.deepEqual(JSON.parse(requests[0].options.body), { code: 'CSCE 145' });
    assert.deepEqual(progress.map(event => [event.completed, event.total]), [[0, 8], [3, 8]]);
    assert.equal(result.code, 'CSCE 145');
});

test('Offering history falls back when its progress stream is unavailable', async () => {
    const requests = [];
    const api = loadObject('static/js/api.js', 'API', {
        fetch: async (path, options) => {
            requests.push({ path, options });
            if (path === '/api/history-stream') {
                return { ok: false, status: 404 };
            }
            return {
                ok: true,
                status: 200,
                async json() {
                    return {
                        code: 'CSCE 883',
                        complete: true,
                        terms: [{ term: '202508', offered: true }],
                    };
                },
            };
        },
    });

    const result = await api.getHistory('CSCE 883', () => {});

    assert.deepEqual(requests.map(request => request.path), [
        '/api/history-stream',
        '/api/history',
    ]);
    assert.deepEqual(JSON.parse(requests[1].options.body), { code: 'CSCE 883' });
    assert.equal(result.code, 'CSCE 883');
    assert.equal(result.terms[0].offered, true);
});

test('Offering history does not retry genuine progress-stream failures', async () => {
    const requests = [];
    const api = loadObject('static/js/api.js', 'API', {
        fetch: async path => {
            requests.push(path);
            return { ok: false, status: 500 };
        },
    });

    await assert.rejects(
        () => api.getHistory('CSCE 883', () => {}),
        /status 500/,
    );
    assert.deepEqual(requests, ['/api/history-stream']);
});

test('Offering history falls back from a malformed progress response', async () => {
    const requests = [];
    const api = loadObject('static/js/api.js', 'API', {
        fetch: async (path, options) => {
            requests.push({ path, options });
            if (path === '/api/history-stream') {
                return {
                    ok: true,
                    status: 200,
                    body: null,
                    async text() { return '<html>not a progress stream</html>'; },
                };
            }
            return {
                ok: true,
                status: 200,
                async json() { return { code: 'CSCE 883', complete: true, terms: [] }; },
            };
        },
    });

    const result = await api.getHistory('CSCE 883', () => {});

    assert.deepEqual(requests.map(request => request.path), [
        '/api/history-stream',
        '/api/history',
    ]);
    assert.equal(result.code, 'CSCE 883');
});

test('Offering history preserves errors returned by a valid progress stream', async () => {
    const requests = [];
    const api = loadObject('static/js/api.js', 'API', {
        fetch: async path => {
            requests.push(path);
            return {
                ok: true,
                status: 200,
                body: null,
                async text() {
                    return `${JSON.stringify({
                        type: 'result',
                        data: { error: 'upstream unavailable' },
                    })}\n`;
                },
            };
        },
    });

    await assert.rejects(
        () => api.getHistory('CSCE 883', () => {}),
        /upstream unavailable/,
    );
    assert.deepEqual(requests, ['/api/history-stream']);
});

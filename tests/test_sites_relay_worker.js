'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

// The upstream URLs are the contract's, not this test's: reading them here keeps
// the assertion honest when tools/contracts/wire/fose-v1.json moves a route.
const ROOT = path.resolve(__dirname, '..');
const contract = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'tools/contracts/wire/fose-v1.json'), 'utf8'),
);

let worker;
let temporaryBuild;
let originalFetch;

function relayRequest(pathname, body, headers = {}) {
    return new Request(`https://scheduler.example${pathname}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Origin: 'https://scheduler.example',
            ...headers,
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

test.before(async () => {
    temporaryBuild = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-relay-test-'));
    const result = spawnSync(
        process.env.PYTHON || 'python3',
        ['tools/build_static_site.py', '--output', temporaryBuild],
        { cwd: process.cwd(), encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const moduleUrl = pathToFileURL(path.join(temporaryBuild, 'server', 'index.js')).href;
    worker = (await import(`${moduleUrl}?test=${Date.now()}`)).default;
    originalFetch = globalThis.fetch;
});

test.after(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(temporaryBuild, { recursive: true, force: true });
});

test('Sites worker relays a valid course search to the fixed upstream', async () => {
    const upstreamCalls = [];
    globalThis.fetch = async (url, options) => {
        upstreamCalls.push({ url, options });
        return new Response(JSON.stringify({
            count: 1,
            results: [{ code: 'CSCE 145', crn: '10868', section: '001' }],
        }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Set-Cookie': 'must-not-leak=1',
            },
        });
    };
    const payload = {
        other: { srcdb: '202608' },
        criteria: [{ field: 'alias', value: 'CSCE 145' }],
    };

    const response = await worker.fetch(relayRequest('/api/search', payload), {});
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-scheduler-relay'), 'sites-worker');
    assert.equal(response.headers.has('set-cookie'), false);
    assert.equal(data.results[0].crn, '10868');
    assert.equal(upstreamCalls.length, 1);
    assert.equal(upstreamCalls[0].url, contract.routes['/api/search'].upstream);
    assert.equal(upstreamCalls[0].options.method, 'POST');
    assert.deepEqual(Object.keys(upstreamCalls[0].options.headers).sort(), [
        'Accept',
        'Content-Type',
    ]);
    assert.equal(upstreamCalls[0].options.headers.Cookie, undefined);
    assert.equal(upstreamCalls[0].options.headers.Authorization, undefined);
    assert.deepEqual(JSON.parse(upstreamCalls[0].options.body), payload);
});

test('Sites worker relays valid section details', async () => {
    globalThis.fetch = async (url, options) => {
        assert.equal(url, contract.routes['/api/details'].upstream);
        assert.deepEqual(JSON.parse(options.body), {
            group: 'crn:10868',
            srcdb: '202608',
        });
        return new Response(JSON.stringify({ code: 'CSCE 145', seats: '8 available' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    };

    const response = await worker.fetch(relayRequest('/api/details', {
        group: 'crn:10868',
        srcdb: '202608',
    }), {});

    assert.equal(response.status, 200);
    assert.equal((await response.json()).code, 'CSCE 145');
});

test('Sites worker relays faculty through a fixed Columbia-campus request and stable ID', async () => {
    const upstreamCalls = [];
    globalThis.fetch = async (url, options) => {
        upstreamCalls.push({ url, options });
        const endpoint = new URL(url);
        assert.equal(endpoint.origin, 'https://banner.onecarolina.sc.edu');
        assert.equal(endpoint.pathname, '/StudentRegistrationSsb/ssb/searchResults/getFacultyMeetingTimes');
        assert.equal(endpoint.searchParams.get('term'), '202608');
        assert.equal(endpoint.searchParams.get('mepCode'), 'COL');
        assert.equal(options.method, 'GET');
        return new Response(JSON.stringify({
            fmt: [{
                faculty: [{
                    bannerId: 'C14765226',
                    displayName: 'Simin, Grigory',
                    emailAddress: 'different-identity@example.edu',
                    primaryIndicator: true,
                }, {
                    bannerId: '',
                    displayName: 'Placeholder, Email',
                    emailAddress: 'none',
                    primaryIndicator: 'false',
                }],
            }],
        }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Set-Cookie': 'must-not-leak=1',
            },
        });
    };

    const response = await worker.fetch(relayRequest('/api/faculty', {
        term: '202608',
        crns: ['10368'],
    }), {});
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-scheduler-relay'), 'sites-worker');
    assert.equal(response.headers.has('set-cookie'), false);
    assert.equal(upstreamCalls.length, 1);
    assert.deepEqual(data.faculty, [
        {
            crn: '10368',
            name: 'Simin, Grigory',
            email: 'different-identity@example.edu',
            primary: true,
            professor_id: 'prof_c68c41fec5f7f933',
            identity_source: 'faculty_id',
        },
        {
            crn: '10368',
            name: 'Placeholder, Email',
            email: '',
            primary: false,
            professor_id: '',
            identity_source: '',
        },
    ]);
});

test('Sites worker limits faculty provider concurrency to four requests', async () => {
    let active = 0;
    let maximum = 0;
    globalThis.fetch = async url => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise(resolve => setImmediate(resolve));
        active -= 1;
        const crn = new URL(url).searchParams.get('courseReferenceNumber');
        return new Response(JSON.stringify({
            fmt: [{ faculty: [{ bannerId: `B${crn}`, displayName: `Faculty, ${crn}` }] }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const response = await worker.fetch(relayRequest('/api/faculty', {
        term: '202608',
        crns: ['10001', '10002', '10003', '10004', '10005', '10006', '10007', '10008'],
    }), {});

    assert.equal(response.status, 200);
    assert.equal((await response.json()).faculty.length, 8);
    assert.equal(maximum, 4);
});

test('Sites worker rejects requests outside the fixed relay contract', async () => {
    let upstreamCalls = 0;
    globalThis.fetch = async () => {
        upstreamCalls += 1;
        return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    };
    const payload = {
        other: { srcdb: '202608' },
        criteria: [{ field: 'subject', value: 'CSCE' }],
    };

    const crossOrigin = await worker.fetch(relayRequest('/api/search', payload, {
        Origin: 'https://attacker.example',
    }), {});
    assert.equal(crossOrigin.status, 403);

    const invalidType = await worker.fetch(new Request('https://scheduler.example/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', Origin: 'https://scheduler.example' },
        body: JSON.stringify(payload),
    }), {});
    assert.equal(invalidType.status, 415);

    const invalidSchema = await worker.fetch(relayRequest('/api/search', {
        other: { srcdb: '202608' },
        criteria: [],
    }), {});
    assert.equal(invalidSchema.status, 400);

    const invalidFaculty = await worker.fetch(relayRequest('/api/faculty', {
        term: 'Fall 2026',
        crns: ['10368'],
    }), {});
    assert.equal(invalidFaculty.status, 400);

    const duplicateFacultyCrn = await worker.fetch(relayRequest('/api/faculty', {
        term: '202608',
        crns: ['10368', '10368'],
    }), {});
    assert.equal(duplicateFacultyCrn.status, 400);

    const oversized = await worker.fetch(relayRequest('/api/search', 'x'.repeat(17 * 1024)), {});
    assert.equal(oversized.status, 413);

    const wrongMethod = await worker.fetch(new Request('https://scheduler.example/api/search'), {});
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'POST');

    const arbitraryRoute = await worker.fetch(relayRequest('/api/arbitrary', payload), {
        ASSETS: { fetch: async () => { throw new Error('POST must not reach assets'); } },
    });
    assert.equal(arbitraryRoute.status, 405);
    assert.equal(upstreamCalls, 0);
});

test('Sites worker rejects an invalid upstream response and preserves static assets', async () => {
    globalThis.fetch = async () => new Response('<html>not json</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
    });
    const relay = await worker.fetch(relayRequest('/api/search', {
        other: { srcdb: '202608' },
        criteria: [{ field: 'subject', value: 'CSCE' }],
    }), {});
    assert.equal(relay.status, 502);
    assert.equal((await relay.json()).code, 'INVALID_UPSTREAM_CONTENT_TYPE');

    let assetCalls = 0;
    const asset = await worker.fetch(new Request('https://scheduler.example/static/app.js'), {
        ASSETS: {
            fetch: async () => {
                assetCalls += 1;
                return new Response('asset', { status: 200 });
            },
        },
    });
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), 'asset');
    assert.equal(assetCalls, 1);
});

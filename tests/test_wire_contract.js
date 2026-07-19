'use strict';

/*
 * The wire contract is only worth having if it is enforced. A document that
 * merely describes the relay drifts from it silently and is then worse than no
 * document, because people trust it.
 *
 * These run the real relay against the contract's own examples. If someone
 * loosens a validator without editing the contract, or edits the contract
 * without touching the relay, one of these fails.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const contract = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'contracts/wire/fose-v1.json'), 'utf8'),
);

let worker;

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

// Upstream is never contacted: every case here is rejected before the relay
// would fetch, or is checked for its status alone.
const env = { ASSETS: { fetch: async () => new Response('', { status: 404 }) } };

test.before(async () => {
    const build = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-contract-'));
    const result = spawnSync(
        process.env.PYTHON || 'uv',
        ['run', 'python', 'scripts/build_static_site.py', '--allow-representative', '--output', build],
        { cwd: ROOT, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    ({ default: worker } = await import(pathToFileURL(path.join(build, 'server/index.js')).href));
});

test('the contract names exactly the routes the relay serves', () => {
    const relaySource = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    const relayRoutes = [...relaySource.matchAll(/^\s{4}'(\/api\/[a-z]+)':/gm)].map(m => m[1]).sort();
    assert.deepEqual(Object.keys(contract.routes).sort(), relayRoutes,
        'a route in one and not the other means the contract is already stale');
});

test('the contract limits match the relay constants', () => {
    const relaySource = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    const constant = name => {
        const match = relaySource.match(new RegExp(`const ${name} = ([^;]+);`));
        assert.ok(match, `${name} should exist in the relay`);
        // eslint-disable-next-line no-eval
        return eval(match[1]);
    };
    assert.equal(contract.limits.max_body_bytes, constant('MAX_RELAY_BODY_BYTES'));
    assert.equal(contract.limits.upstream_timeout_ms, constant('UPSTREAM_TIMEOUT_MS'));
    assert.equal(contract.limits.max_faculty_crns, constant('MAX_FACULTY_CRNS'));
    assert.equal(contract.limits.max_faculty_concurrency, constant('MAX_FACULTY_CONCURRENCY'));
});

test('the allowed search fields match the relay allowlist', () => {
    const relaySource = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    const match = relaySource.match(/const SEARCH_FIELDS = new Set\(\[([^\]]+)\]\)/);
    assert.ok(match, 'SEARCH_FIELDS should exist');
    const relayFields = match[1].split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean).sort();
    assert.deepEqual(
        [...contract.routes['/api/search'].request.criteria.allowed_fields].sort(),
        relayFields,
    );
});

test('every term the contract calls valid is accepted, and every invalid one refused', async () => {
    for (const term of contract.types.term.valid) {
        const response = await worker.fetch(
            relayRequest('/api/details', { group: 'crn:10868', srcdb: term }), env, {},
        );
        assert.notEqual(response.status, 400, `${term} is contract-valid but the relay rejected it`);
    }
    for (const term of contract.types.term.invalid) {
        const response = await worker.fetch(
            relayRequest('/api/details', { group: 'crn:10868', srcdb: term }), env, {},
        );
        assert.equal(response.status, 400, `${term} is contract-invalid but the relay accepted it`);
    }
});

test('every detail group the contract calls valid is accepted, and every invalid one refused', async () => {
    for (const group of contract.types.detail_group.valid) {
        const response = await worker.fetch(
            relayRequest('/api/details', { group, srcdb: '202608' }), env, {},
        );
        assert.notEqual(response.status, 400, `${group} should be accepted`);
    }
    for (const group of contract.types.detail_group.invalid) {
        const response = await worker.fetch(
            relayRequest('/api/details', { group, srcdb: '202608' }), env, {},
        );
        assert.equal(response.status, 400, `${group} should be refused`);
    }
});

test('the search criteria rules hold against the relay', async () => {
    const rules = contract.routes['/api/search'].request.criteria;
    const search = criteria => worker.fetch(
        relayRequest('/api/search', { other: { srcdb: '202608' }, criteria }), env, {},
    );

    for (const field of rules.allowed_fields) {
        const criteria = field === 'stat'
            ? [{ field: 'stat', value: 'open' }, { field: 'subject', value: 'CSCE' }]
            : [{ field, value: 'CSCE' }];
        const response = await search(criteria);
        assert.notEqual(response.status, 400, `${field} is allowlisted but was rejected`);
    }

    assert.equal((await search([{ field: 'instructor', value: 'Deng' }])).status, 400,
        'a field outside the allowlist must be refused');
    assert.equal((await search([])).status, 400, 'fewer than min_items must be refused');
    assert.equal(
        (await search(Array.from({ length: rules.max_items + 1 }, (_, i) => ({ field: 'keyword', value: `k${i}` })))).status,
        400, 'more than max_items must be refused');
    assert.equal((await search([{ field: 'stat', value: 'open' }])).status, 400,
        'a stat-only query must be refused');
    assert.equal((await search([{ field: 'keyword', value: 'x'.repeat(rules.value_max_length + 1) }])).status, 400,
        'a value over value_max_length must be refused');
});

test('the faculty CRN cap matches the contract', async () => {
    const max = contract.routes['/api/faculty'].request.crns.max_items;
    const crns = n => Array.from({ length: n }, (_, i) => String(10000 + i));
    const over = await worker.fetch(relayRequest('/api/faculty', { term: '202608', crns: crns(max + 1) }), env, {});
    assert.equal(over.status, 400, `more than ${max} CRNs must be refused`);
    const empty = await worker.fetch(relayRequest('/api/faculty', { term: '202608', crns: [] }), env, {});
    assert.equal(empty.status, 400, 'an empty CRN list must be refused');
});

test('the documented rejection statuses are the ones the relay returns', async () => {
    const wrongMethod = await worker.fetch(
        new Request('https://scheduler.example/api/search', { method: 'GET' }), env, {},
    );
    assert.equal(wrongMethod.status, contract.rejections.wrong_method);

    const wrongType = await worker.fetch(
        new Request('https://scheduler.example/api/search', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain', Origin: 'https://scheduler.example' },
            body: 'x',
        }), env, {},
    );
    assert.equal(wrongType.status, contract.rejections.wrong_content_type);

    const crossOrigin = await worker.fetch(
        relayRequest('/api/search', {}, { Origin: 'https://evil.example' }), env, {},
    );
    assert.equal(crossOrigin.status, contract.rejections.cross_origin);

    const tooLarge = await worker.fetch(
        relayRequest('/api/search', 'x'.repeat(contract.limits.max_body_bytes + 1)), env, {},
    );
    assert.equal(tooLarge.status, contract.rejections.body_too_large);

    const invalid = await worker.fetch(relayRequest('/api/search', {}), env, {});
    assert.equal(invalid.status, contract.rejections.invalid_body);
});

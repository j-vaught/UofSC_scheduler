'use strict';

/*
 * The shared response cache (static/js/response-cache.js), which api.js and
 * live-university-client.js now both use. It pins the two behaviours those
 * callers relied on: a deterministic key that ignores object-key order (request
 * coalescing depends on it) and an LRU-by-reinsertion TTL store whose limit and
 * clock are both injectable.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const ResponseCache = require('../static/js/response-cache.js');

test('stableCacheKey ignores object key order so equal bodies coalesce', () => {
    const a = ResponseCache.stableCacheKey('/api/search', { field: 'subject', value: 'CSCE' });
    const b = ResponseCache.stableCacheKey('/api/search', { value: 'CSCE', field: 'subject' });
    assert.equal(a, b);
    // Nested and array bodies normalise recursively.
    assert.equal(
        ResponseCache.stableCacheKey('/x', { a: [{ p: 1, q: 2 }] }),
        ResponseCache.stableCacheKey('/x', { a: [{ q: 2, p: 1 }] }),
    );
    // The path prefixes the key, so two endpoints never collide.
    assert.notEqual(
        ResponseCache.stableCacheKey('/api/search', {}),
        ResponseCache.stableCacheKey('/api/details', {}),
    );
});

test('a stored value is returned until it expires, then is gone', () => {
    let clock = 1000;
    const cache = ResponseCache.make(10, { now: () => clock });
    cache.set('k', { hit: true }, 500);
    assert.deepEqual(cache.get('k'), { hit: true });
    clock = 1499;
    assert.deepEqual(cache.get('k'), { hit: true });
    clock = 1500; // now >= expiresAt
    assert.equal(cache.get('k'), null);
    assert.equal(cache.get('missing'), null);
});

test('eviction removes the least-recently-used, and a read counts as use', () => {
    const cache = ResponseCache.make(2);
    cache.set('older-hot', 1, 60_000);
    cache.set('newer-cold', 2, 60_000);
    // Reading older-hot moves it to the most-recently-used end.
    assert.equal(cache.get('older-hot'), 1);
    cache.set('newest', 3, 60_000);
    // newer-cold was the least-recently-used, so it is the one evicted.
    assert.equal(cache.has('newer-cold'), false);
    assert.equal(cache.has('older-hot'), true);
    assert.equal(cache.has('newest'), true);
    assert.equal(cache.size, 2);
});

test('a function limit is re-read on every insert, so a caller can lower it', () => {
    // This is exactly how api.js lets a test shrink its cache after construction.
    let max = 3;
    const cache = ResponseCache.make(() => max);
    cache.set('a', 1, 60_000);
    cache.set('b', 2, 60_000);
    cache.set('c', 3, 60_000);
    assert.equal(cache.size, 3);
    max = 1;
    cache.set('d', 4, 60_000);
    assert.equal(cache.size, 1);
    assert.equal(cache.has('d'), true);
});

test('clear empties the store', () => {
    const cache = ResponseCache.make(10);
    cache.set('a', 1, 60_000);
    cache.set('b', 2, 60_000);
    cache.clear();
    assert.equal(cache.size, 0);
    assert.equal(cache.get('a'), null);
});

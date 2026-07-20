/*
 * The one TTL + LRU response cache, shared by the two request boundaries.
 *
 * api.js and live-university-client.js each carried their own copy of the same
 * two things: a recursive stable-stringify for the cache key, and a small
 * Map-backed cache whose LRU order is expressed by reinsertion. The copies were
 * identical in intent and drifted only in incidentals (one read Date.now()
 * directly, the other an injectable clock). Consolidated here so a fix or a
 * bug lives in one place.
 *
 * LRU-by-reinsertion: a read deletes and re-sets its entry, so Map iteration
 * order keeps the most-recently-used last; eviction deletes from the front.
 * This is exactly what both callers did and is preserved byte-for-byte.
 *
 * Dual export like keyspace.js: a browser global and a CommonJS module, because
 * live-university-client.js runs under Node in the test suite.
 */
(function initResponseCache(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.ResponseCache = api;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';

    // Sort object keys recursively so two logically-equal bodies that differ
    // only in key order hash to one entry. The request-coalescing tests depend
    // on {field, value} and {value, field} collapsing to the same key.
    function stableValue(value) {
        if (Array.isArray(value)) return value.map(stableValue);
        if (value && typeof value === 'object') {
            return Object.fromEntries(
                Object.keys(value).sort().map(key => [key, stableValue(value[key])]),
            );
        }
        return value;
    }

    function stableCacheKey(path, body) {
        return `${path}:${JSON.stringify(stableValue(body))}`;
    }

    /*
     * A cache instance. `maxEntries` may be a number or a function returning
     * one, evaluated on every insert -- api.js lowers its own limit after
     * construction and expects eviction to honour the new value immediately.
     * `now` is injectable so a client can drive expiry deterministically.
     */
    function make(maxEntries, options = {}) {
        const now = options.now || (() => Date.now());
        const store = new Map();
        const limit = () => (typeof maxEntries === 'function' ? maxEntries() : maxEntries);

        return {
            get(key) {
                const entry = store.get(key);
                if (!entry) return null;
                if (now() >= entry.expiresAt) {
                    store.delete(key);
                    return null;
                }
                store.delete(key);
                store.set(key, entry);
                return entry.data;
            },

            set(key, value, ttlMs) {
                store.delete(key);
                store.set(key, { data: value, expiresAt: now() + ttlMs });
                while (store.size > limit()) {
                    store.delete(store.keys().next().value);
                }
            },

            has(key) {
                return store.has(key);
            },

            clear() {
                store.clear();
            },

            get size() {
                return store.size;
            },
        };
    }

    return { make, stableCacheKey, stableValue };
}));

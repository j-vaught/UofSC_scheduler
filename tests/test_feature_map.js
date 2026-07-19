'use strict';

/*
 * The second feature fenced under phase 7a.
 *
 * Larger than history and correspondingly more revealing: the extraction found
 * three ambient dependencies the module's shape had hidden.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const feature = require('../static/js/features/map/index.js');
const source = fs.readFileSync(path.join(ROOT, 'static/js/features/map/index.js'), 'utf8');

function makeDeps(overrides = {}) {
    return {
        getDetails: async () => ({ meeting_html: '' }),
        currentTerm: () => '202608',
        selectedSections: () => ({}),
        onStateChange: () => {},
        fetch: async () => ({ ok: true, json: async () => ({}) }),
        storage: { getItem: () => null, setItem: () => true },
        ...overrides,
    };
}

test('the feature reaches no application global', () => {
    const body = source.slice(source.indexOf('function createMapFeature'));
    for (const global of ['API.', 'State.', 'localStorage']) {
        assert.equal(body.includes(global), false, `the fenced feature still reaches ${global}`);
    }
});

test('every dependency is declared, and a missing one fails at construction', () => {
    for (const missing of ['getDetails', 'currentTerm', 'selectedSections', 'onStateChange', 'fetch']) {
        const deps = makeDeps();
        delete deps[missing];
        assert.throws(() => feature.createMapFeature(deps), new RegExp(missing));
    }
    const noStorage = makeDeps();
    delete noStorage.storage;
    assert.throws(() => feature.createMapFeature(noStorage), /storage/);
});

test('section details load through the injected source', async () => {
    const asked = [];
    const map = feature.createMapFeature(makeDeps({
        getDetails: async crn => { asked.push(crn); return { meeting_html: '' }; },
    }));
    await map.hydrateSectionDetail({ crn: '10001' });
    assert.deepEqual(asked, ['10001'], 'the injected source should be the only one used');
});

test('a failed detail is retried rather than cached as success', async () => {
    let calls = 0;
    const map = feature.createMapFeature(makeDeps({
        getDetails: async () => {
            calls += 1;
            if (calls === 1) throw new Error('temporary failure');
            return { meeting_html: '' };
        },
    }));
    const section = { crn: '10001' };
    await map.hydrateSectionDetail(section);
    assert.equal(map.sectionDetails.has(map.sectionDetailKey(section)), false, 'a failure must not cache');
    await map.hydrateSectionDetail(section);
    assert.equal(calls, 2);
    assert.equal(map.sectionDetails.has(map.sectionDetailKey(section)), true);
});

test('denied storage does not break the route cache', () => {
    const map = feature.createMapFeature(makeDeps({
        storage: {
            getItem() { throw new Error('SecurityError'); },
            setItem() { throw new Error('QuotaExceededError'); },
        },
    }));
    // Private browsing denies storage; the map must still function without it.
    assert.doesNotThrow(() => map.loadRouteCache && map.loadRouteCache());
});

test('two instances keep separate detail caches', async () => {
    const first = feature.createMapFeature(makeDeps());
    const second = feature.createMapFeature(makeDeps());
    await first.hydrateSectionDetail({ crn: '10001' });
    assert.equal(second.sectionDetails.size, 0, 'instances must not share state');
});

test('the composition point supplies every declared dependency', () => {
    const composition = fs.readFileSync(path.join(ROOT, 'static/js/map.js'), 'utf8');
    for (const name of ['getDetails', 'currentTerm', 'selectedSections', 'onStateChange', 'fetch', 'storage']) {
        assert.match(composition, new RegExp(name), `map.js should supply ${name}`);
    }
});

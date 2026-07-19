'use strict';

/*
 * The first feature fenced under phase 7a.
 *
 * What a fence has to mean: the module states what it needs and cannot reach
 * anything else. These check that property directly, because a module that
 * merely lives in a features/ folder while still reading globals has been moved,
 * not fenced.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const feature = require('../static/js/features/history/index.js');
const source = fs.readFileSync(path.join(ROOT, 'static/js/features/history/index.js'), 'utf8');

function deps(overrides = {}) {
    const container = { innerHTML: '' };
    return {
        container,
        deps: {
            getHistory: async () => ({ code: 'CSCE 145', terms: [] }),
            currentTerm: () => '202608',
            container: () => container,
            createElement: () => ({ textContent: '', get innerHTML() { return this.textContent; } }),
            ...overrides,
        },
    };
}

test('the feature reaches no ambient global', () => {
    // The coupling the extraction removed. A reference here means the fence
    // leaks and the module cannot be reused or replaced independently.
    const body = source.slice(source.indexOf('function createHistoryFeature'));
    for (const global of ['API.', 'State.', 'Search.', 'Tabs.', 'document.', 'window.', 'localStorage']) {
        assert.equal(
            body.includes(global), false,
            `the fenced feature still reaches ${global}`,
        );
    }
});

test('every dependency is declared, and a missing one fails loudly', () => {
    for (const missing of ['getHistory', 'currentTerm', 'container', 'createElement']) {
        const { deps: d } = deps();
        delete d[missing];
        assert.throws(
            () => feature.createHistoryFeature(d),
            new RegExp(missing),
            `omitting ${missing} should be refused at construction, not at first use`,
        );
    }
});

test('it loads history through the injected source, not a global', async () => {
    const asked = [];
    const { deps: d, container } = deps({
        getHistory: async code => { asked.push(code); return { code, terms: [] }; },
    });
    const history = feature.createHistoryFeature(d);
    await history.loadForCourse('CSCE 145');
    assert.deepEqual(asked, ['CSCE 145'], 'the injected source should be the only one used');
    assert.ok(container.innerHTML.length > 0, 'it should render into the injected container');
});

test('a failing data source renders a message rather than throwing', async () => {
    const { deps: d, container } = deps({
        getHistory: async () => { throw new Error('relay 502'); },
    });
    const history = feature.createHistoryFeature(d);
    await assert.doesNotReject(() => history.loadForCourse('CSCE 145'));
    assert.match(container.innerHTML, /unavailable/i);
});

test('two instances are independent, which is what replaceability requires', async () => {
    const a = deps();
    const b = deps();
    const first = feature.createHistoryFeature(a.deps);
    const second = feature.createHistoryFeature(b.deps);
    await first.loadForCourse('CSCE 145');
    assert.equal(b.container.innerHTML, '', 'one instance must not render into another container');
    await second.loadForCourse('MATH 141');
    assert.ok(b.container.innerHTML.length > 0);
});

test('the composition point supplies exactly the declared dependencies', () => {
    const composition = fs.readFileSync(path.join(ROOT, 'static/js/history.js'), 'utf8');
    for (const name of ['getHistory', 'currentTerm', 'container', 'createElement']) {
        assert.match(composition, new RegExp(`${name}:`), `history.js should supply ${name}`);
    }
    assert.match(composition, /createHistoryFeature/);
});

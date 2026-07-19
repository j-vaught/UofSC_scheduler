'use strict';

/*
 * The harness has to be trustworthy before anything is migrated onto it, so
 * these check it against the real markup and real modules rather than against
 * fixtures written to make it pass.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    createElement,
    createDocument,
    createContext,
    elementIdsFromMarkup,
    loadModule,
} = require('./support/harness.js');

test('element ids come from the real markup, not a hand-written list', () => {
    const ids = elementIdsFromMarkup();
    assert.ok(ids.length > 80, `expected the full markup, found ${ids.length} ids`);
    // Spot-check ids that matter and that this session touched.
    for (const id of ['keyword-input', 'btn-search', 'btn-solve', 'solver-container',
        'major-program-select', 'plans-container', 'btn-export', 'site-notices']) {
        assert.ok(ids.includes(id), `${id} should exist in index.html`);
    }
});

test('the document resolves those ids and supports the queries modules make', () => {
    const document = createDocument();
    const input = document.getElementById('keyword-input');
    assert.ok(input, 'keyword-input should resolve');
    assert.equal(document.getElementById('definitely-not-here'), null);

    const holder = document.getElementById('solver-container');
    const child = document.createElement('button');
    child.classList.add('option');
    child.setAttribute('data-index', '1');
    holder.appendChild(child);

    assert.equal(holder.querySelectorAll('.option').length, 1);
    assert.equal(holder.querySelector('BUTTON'), child);
    assert.equal(child.closest('.option'), child);
    assert.equal(child.getAttribute('data-index'), '1');
});

test('listeners registered by a module can be fired by a test', () => {
    const button = createElement('button', 'go');
    let clicks = 0;
    button.addEventListener('click', () => { clicks += 1; });
    button.click();
    button._fire('click');
    assert.equal(clicks, 2);
    assert.equal(button._listenerCount('click'), 1);
});

test('State is a working emitter, so wiring bugs surface instead of hiding', () => {
    const context = createContext();
    let seen = 0;
    context.State.on('courses-changed', () => { seen += 1; });
    context.State.emit('courses-changed');
    assert.equal(seen, 1);
    assert.equal(context.State._handlerCount('courses-changed'), 1);
});

test('a real module loads and binds against the harness', () => {
    // Export is a good probe: it binds nine ids and nothing else, so a
    // successful load proves the document satisfies a real module's needs.
    const context = createContext();
    const { module: exporter } = loadModule('static/js/export.js', 'Export', context);
    assert.equal(typeof exporter.init, 'function');
    assert.equal(typeof exporter.exportICS, 'function');

    exporter.init();
    assert.equal(
        context.document.getElementById('btn-export')._listenerCount('click'),
        1,
        'Export.init should bind the calendar export control',
    );
    assert.equal(
        context.document.getElementById('json-import')._listenerCount('change'),
        1,
        'Export.init should bind the JSON import control',
    );
});

test('a real module renders into the harness document', () => {
    const context = createContext({
        State: {
            savedPlans: { 'Plan A': { sections: { 'CSCE 350': {} }, completedCourses: ['MATH 141'] } },
            listPlans: () => ['Plan A'],
        },
    });
    const { module: exporter } = loadModule('static/js/export.js', 'Export', context);
    exporter.renderSavedPlans();
    const rendered = context.document.getElementById('plans-container').innerHTML;
    assert.match(rendered, /Plan A/);
    assert.match(rendered, /1 courses selected, 1 completed/);
});

test('the runtime modules load unchanged, which is what an MCP or CLI would need', () => {
    // These already carry a dual export, so Node can require them directly with
    // no DOM at all. That property is what makes a non-browser surface cheap
    // later, and it should not regress.
    const planner = require('../static/js/runtime/degree-planner.js');
    const offering = require('../static/js/runtime/offering-analyzer.js');
    const transcript = require('../static/js/runtime/transcript-parser.js');
    for (const [name, mod] of [['degree-planner', planner], ['offering-analyzer', offering],
        ['transcript-parser', transcript]]) {
        assert.equal(typeof mod, 'object', `${name} should export an object`);
    }
    assert.equal(typeof planner.planDegree, 'function');
    assert.equal(typeof offering.analyzeOfferingPattern, 'function');
    assert.equal(typeof transcript.parseText, 'function');
});

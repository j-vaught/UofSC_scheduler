'use strict';

/*
 * Export.init() binds by element id. Every id it looks up must exist in
 * index.html, or the feature loads, initializes, and silently does nothing --
 * which is exactly how ICS export went unreachable once before.
 *
 * The Saved Plans panel this file used to cover is gone. Its tests moved to
 * test_state_autosave.js, which checks the behaviour that replaced it: state
 * persists on change and comes back at startup, with no control to press.
 *
 * Migrated onto tests/support/harness.js. This previously carried its own
 * element stub, which meant it asserted against a DOM the test itself invented
 * rather than one derived from the real markup. It now runs the real module
 * against the real ids, so "the control exists" and "the control is bound" are
 * checked against the same source of truth.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { ROOT, createContext, loadModule, elementIdsFromMarkup } = require('./support/harness.js');

const exportSource = fs.readFileSync(path.join(ROOT, 'static/js/export.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'static/index.html'), 'utf8');

function boundIds(source) {
    return [...source.matchAll(/getElementById\('([a-z0-9-]+)'\)/g)].map(match => match[1]);
}

test('every id Export binds resolves in index.html', () => {
    const ids = boundIds(exportSource);
    assert.ok(ids.length >= 1, `expected Export to bind at least one id, found ${ids.length}`);
    const markupIds = new Set(elementIdsFromMarkup());
    const missing = ids.filter(id => !markupIds.has(id));
    assert.deepEqual(missing, [], `Export binds ids absent from index.html: ${missing.join(', ')}`);
});

test('Export.init attaches a handler to every control it looks up', () => {
    const context = createContext();
    const { module: exporter } = loadModule('static/js/export.js', 'Export', context);
    exporter.init();

    const expected = [...new Set(boundIds(exportSource))].sort();
    const unbound = expected.filter(id => {
        const element = context.document.getElementById(id);
        return !element || (element._listenerCount('click') + element._listenerCount('change')) === 0;
    });
    assert.deepEqual(unbound, [], `these controls exist but nothing listens to them: ${unbound.join(', ')}`);
});

test('clicking export calls exportICS rather than merely being bound', () => {
    const context = createContext();
    const { module: exporter } = loadModule('static/js/export.js', 'Export', context);
    let called = 0;
    exporter.exportICS = () => { called += 1; };
    exporter.init();
    context.document.getElementById('btn-export')._fire('click');
    assert.equal(called, 1, 'the export button should invoke exportICS');
});

test('the export control is reachable from the schedule tab', () => {
    const scheduleTab = html.slice(html.indexOf('id="tab-schedule"'));
    assert.ok(
        scheduleTab.includes('id="btn-export"'),
        'the calendar export button must live inside the schedule tab',
    );
});

/*
 * The panel is gone from the markup, and the module no longer reaches for it.
 * Asserting on its absence keeps a later change from reintroducing controls
 * that would now compete with automatic persistence for the same storage.
 */
test('no saved-plan controls remain in the markup or the module', () => {
    const gone = ['plans-panel', 'plan-name-input', 'btn-save-plan', 'btn-load-plan',
        'btn-delete-plan', 'plans-container', 'btn-export-json', 'json-import'];
    const inMarkup = gone.filter(id => html.includes(`id="${id}"`));
    assert.deepEqual(inMarkup, [], `saved-plan controls still in index.html: ${inMarkup.join(', ')}`);
    const inModule = gone.filter(id => exportSource.includes(`'${id}'`));
    assert.deepEqual(inModule, [], `Export still binds removed controls: ${inModule.join(', ')}`);
});

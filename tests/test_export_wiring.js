'use strict';

/*
 * Export.init() binds by element id. Every id it looks up must exist in
 * index.html, or the feature loads, initializes, and silently does nothing --
 * which is exactly how ICS export and plan save/load went unreachable.
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
    assert.ok(ids.length >= 8, `expected Export to bind several ids, found ${ids.length}`);
    const markupIds = new Set(elementIdsFromMarkup());
    const missing = ids.filter(id => !markupIds.has(id));
    assert.deepEqual(missing, [], `Export binds ids absent from index.html: ${missing.join(', ')}`);
});

test('Export.init attaches a handler to every control it looks up', () => {
    const context = createContext();
    const { module: exporter } = loadModule('static/js/export.js', 'Export', context);
    exporter.init();

    // plans-container is rendered into and plan-name-input is read via .value;
    // neither takes a listener. Every remaining control must get a handler.
    const passive = new Set(['plans-container', 'plan-name-input']);
    const expected = [...new Set(boundIds(exportSource))].filter(id => !passive.has(id)).sort();

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
    assert.ok(
        scheduleTab.includes('id="plans-container"'),
        'the saved-plans panel must live inside the schedule tab',
    );
});

test('Export renders saved plans into the real container', () => {
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

test('an empty plan list renders a hint rather than nothing', () => {
    const context = createContext();
    const { module: exporter } = loadModule('static/js/export.js', 'Export', context);
    exporter.renderSavedPlans();
    const rendered = context.document.getElementById('plans-container').innerHTML;
    assert.match(rendered, /No saved plans yet/);
});

'use strict';

/*
 * Export.init() binds by element id. Every id it looks up must exist in
 * index.html, or the feature loads, initializes, and silently does nothing --
 * which is exactly how ICS export and plan save/load went unreachable.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const exportSource = fs.readFileSync(path.join(ROOT, 'static/js/export.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'static/index.html'), 'utf8');

function boundIds(source) {
    return [...source.matchAll(/getElementById\('([a-z0-9-]+)'\)/g)].map(match => match[1]);
}

test('every id Export binds resolves in index.html', () => {
    const ids = boundIds(exportSource);
    assert.ok(ids.length >= 8, `expected Export to bind several ids, found ${ids.length}`);
    const missing = ids.filter(id => !html.includes(`id="${id}"`));
    assert.deepEqual(missing, [], `Export binds ids absent from index.html: ${missing.join(', ')}`);
});

test('Export.init attaches a handler to every control it looks up', () => {
    const ids = new Set(boundIds(exportSource));
    const bound = new Set();
    const listeners = new Map();

    function makeElement(id) {
        return {
            id,
            value: '',
            innerHTML: '',
            dataset: {},
            addEventListener(type, handler) {
                bound.add(id);
                listeners.set(`${id}:${type}`, handler);
            },
            querySelectorAll: () => [],
        };
    }

    const elements = new Map([...ids].map(id => [id, makeElement(id)]));
    const context = vm.createContext({
        document: {
            getElementById: id => elements.get(id) || null,
            createElement: () => ({ click() {}, style: {} }),
        },
        State: {
            savedPlans: {},
            listPlans: () => [],
            savePlan() {},
            loadPlan: () => true,
            deletePlan() {},
        },
        console,
    });

    vm.runInContext(`${exportSource};globalThis.__Export = Export;`, context);
    context.__Export.init();

    // plans-container is rendered into and plan-name-input is read via .value;
    // neither takes a listener. Every remaining control must get a handler.
    const passive = new Set(['plans-container', 'plan-name-input']);
    const expected = [...ids].filter(id => !passive.has(id)).sort();
    assert.deepEqual([...bound].sort(), expected);
    assert.equal(typeof listeners.get('btn-export:click'), 'function');
    assert.equal(typeof listeners.get('json-import:change'), 'function');
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

test('Export renders saved plans without a live DOM tree', () => {
    const rendered = { innerHTML: '', querySelectorAll: () => [] };
    const context = vm.createContext({
        document: { getElementById: id => (id === 'plans-container' ? rendered : null) },
        State: {
            savedPlans: { 'Plan A': { sections: { 'CSCE 350': {} }, completedCourses: ['MATH 141'] } },
            listPlans: () => ['Plan A'],
        },
        console,
    });
    vm.runInContext(`${exportSource};globalThis.__Export = Export;`, context);
    context.__Export.renderSavedPlans();
    assert.match(rendered.innerHTML, /Plan A/);
    assert.match(rendered.innerHTML, /1 courses selected, 1 completed/);
});

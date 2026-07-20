'use strict';

/*
 * Shared test harness.
 *
 * Two problems this solves.
 *
 * Most suites assert on source TEXT -- regexes over index.html and over module
 * files -- rather than on behaviour. Those tests pass when a file contains the
 * right characters and break when code moves, which is backwards: they resist
 * exactly the restructuring they should be enabling, and they cannot catch a
 * behavioural regression that leaves the source looking the same.
 *
 * The suites that do test behaviour each rebuild their own DOM stub by hand,
 * one object literal per element, so every new test re-derives what an element
 * is and they drift apart.
 *
 * This gives them one place to get a DOM good enough to run real modules
 * against. It deliberately uses no jsdom and no dependency at all: the project
 * ships 31 classic scripts with an empty dependency tree, and an architecture
 * pass that added a package manager to run tests would cost more than it
 * returns. `vm` plus a focused element model covers what these modules touch.
 *
 * What it is not: a browser. There is no layout, no real event dispatch order,
 * and no CSS. Anything depending on those still needs a browser.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');

function classList(element) {
    const set = new Set();
    return {
        add: (...names) => names.forEach(name => set.add(name)),
        remove: (...names) => names.forEach(name => set.delete(name)),
        toggle: (name, force) => {
            const on = force === undefined ? !set.has(name) : Boolean(force);
            if (on) set.add(name); else set.delete(name);
            return on;
        },
        contains: name => set.has(name),
        get length() { return set.size; },
        _names: set,
        _owner: element,
    };
}

/*
 * An element with the surface these modules actually use. Children are tracked
 * so querySelectorAll can answer, but selector support is intentionally narrow:
 * tag, .class, #id, and [attr]. A test needing more than that is a test that
 * wants a browser.
 */
function createElement(tag = 'div', id = '') {
    const listeners = new Map();
    const element = {
        tagName: String(tag).toUpperCase(),
        id,
        children: [],
        parentElement: null,
        innerHTML: '',
        textContent: '',
        value: '',
        checked: false,
        disabled: false,
        hidden: false,
        dataset: {},
        style: {},
        attributes: {},
        options: [],
        offsetParent: {},

        addEventListener(type, handler) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(handler);
        },
        removeEventListener(type, handler) {
            const list = listeners.get(type) || [];
            const index = list.indexOf(handler);
            if (index >= 0) list.splice(index, 1);
        },
        dispatchEvent(event) {
            const type = event && event.type;
            (listeners.get(type) || []).forEach(handler => handler({ target: element, ...event }));
            return !(event && event.defaultPrevented);
        },
        // Test-facing: fire a handler the module registered.
        _fire(type, event = {}) {
            return element.dispatchEvent({ type, target: element, ...event });
        },
        _listenerCount(type) { return (listeners.get(type) || []).length; },

        setAttribute(name, value) { element.attributes[name] = String(value); },
        getAttribute(name) {
            return Object.prototype.hasOwnProperty.call(element.attributes, name)
                ? element.attributes[name] : null;
        },
        removeAttribute(name) { delete element.attributes[name]; },
        hasAttribute(name) {
            return Object.prototype.hasOwnProperty.call(element.attributes, name);
        },

        appendChild(child) { child.parentElement = element; element.children.push(child); return child; },
        prepend(child) { child.parentElement = element; element.children.unshift(child); return child; },
        replaceChildren(...next) { element.children = next; },
        remove() {
            const siblings = element.parentElement && element.parentElement.children;
            if (siblings) siblings.splice(siblings.indexOf(element), 1);
        },
        closest(selector) {
            let node = element;
            while (node) {
                if (matches(node, selector)) return node;
                node = node.parentElement;
            }
            return null;
        },
        querySelector(selector) { return element.querySelectorAll(selector)[0] || null; },
        querySelectorAll(selector) {
            const found = [];
            const walk = node => node.children.forEach(child => {
                if (matches(child, selector)) found.push(child);
                walk(child);
            });
            walk(element);
            return found;
        },
        focus() { element._focused = true; },
        click() { element._fire('click'); },
    };
    element.classList = classList(element);
    return element;
}

function matches(element, selector) {
    return String(selector).split(',').map(part => part.trim()).filter(Boolean).some(part => {
        if (part.startsWith('#')) return element.id === part.slice(1);
        if (part.startsWith('.')) return element.classList.contains(part.slice(1));
        if (part.startsWith('[')) {
            const name = part.slice(1, -1).split('=')[0];
            return element.hasAttribute(name);
        }
        return element.tagName === part.toUpperCase();
    });
}

/*
 * Real element ids, read from index.html rather than guessed. A stub built from
 * a hand-written list silently diverges from the markup; this cannot.
 */
function elementIdsFromMarkup(markupPath = 'static/index.html') {
    const html = fs.readFileSync(path.join(ROOT, markupPath), 'utf8');
    return [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
}

function createDocument(ids = elementIdsFromMarkup()) {
    const byId = new Map();
    const body = createElement('body');
    for (const id of ids) {
        const element = createElement('div', id);
        byId.set(id, element);
        body.appendChild(element);
    }
    const document = {
        body,
        documentElement: createElement('html'),
        readyState: 'complete',
        getElementById: id => byId.get(id) || null,
        querySelector: selector => body.querySelector(selector),
        querySelectorAll: selector => body.querySelectorAll(selector),
        createElement: tag => createElement(tag),
        addEventListener() {},
        removeEventListener() {},
        // Test-facing: add an element the markup does not declare.
        _add(id, tag = 'div') {
            const element = createElement(tag, id);
            byId.set(id, element);
            body.appendChild(element);
            return element;
        },
        _byId: byId,
    };
    return document;
}

/*
 * Load one module and return the global it declares. Modules are classic
 * scripts assigning a top-level const, so the name has to be read back out of
 * the sandbox explicitly.
 */
/*
 * Composition points construct their feature from `Features.<name>`, so the
 * feature modules have to be in the context before the file under test runs.
 * Loading all of them is deliberate: each only registers itself, so this costs
 * nothing, and the next extraction needs no change here.
 */
function featureSources() {
    const dir = path.join(ROOT, 'static/js/features');
    if (!fs.existsSync(dir)) return '';
    /*
     * Parts before index.js. A feature may be split into sibling files that
     * register themselves for its index to merge -- search is, being 4,248
     * lines otherwise -- and index.js throws if they are not already loaded.
     * Loading everything in a feature directory keeps this independent of how
     * any one of them is arranged.
     */
    const sources = [];
    for (const feature of fs.readdirSync(dir)) {
        const featureDir = path.join(dir, feature);
        if (!fs.statSync(featureDir).isDirectory()) continue;
        const files = fs.readdirSync(featureDir).filter(file => file.endsWith('.js'));
        const parts = files.filter(file => file !== 'index.js').sort();
        for (const file of [...parts, ...files.filter(file => file === 'index.js')]) {
            sources.push(fs.readFileSync(path.join(featureDir, file), 'utf8'));
        }
    }
    return sources.join('\n');
}

function loadModule(relativePath, exportName, context = {}) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    const sandbox = vm.createContext({ console, JSON, Math, Date, Set, Map, Promise, ...context });
    vm.runInContext(`${featureSources()}\n${source}\nglobalThis.__exported = ${exportName};`, sandbox, {
        filename: relativePath,
    });
    return { module: sandbox.__exported, sandbox };
}

/*
 * A document plus the globals a module expects, so a test states only what it
 * cares about. State is a working event emitter rather than a stub, because
 * most modules coordinate through it and a silent one hides wiring bugs.
 */
function createContext(overrides = {}) {
    const document = overrides.document || createDocument();
    const handlers = new Map();
    const state = {
        term: '202608',
        selectedCourses: {},
        completedCourses: [],
        profile: {},
        degreePlan: {},
        savedPlans: {},
        // Methods modules call during init. Present with empty-but-valid results
        // so a test that does not care about plans still boots the module; a test
        // that does care overrides them.
        listPlans() { return Object.keys(state.savedPlans || {}); },
        savePlan() {},
        loadPlan() { return true; },
        deletePlan() {},
        exportToJSON() { return '{}'; },
        importFromJSON() { return true; },
        on(event, handler) {
            if (!handlers.has(event)) handlers.set(event, []);
            handlers.get(event).push(handler);
        },
        emit(event, payload) {
            (handlers.get(event) || []).forEach(handler => handler(payload));
        },
        _handlerCount(event) { return (handlers.get(event) || []).length; },
        ...(overrides.State || {}),
    };
    return {
        document,
        window: { addEventListener() {}, removeEventListener() {} },
        State: state,
        requestAnimationFrame: callback => callback(),
        setTimeout,
        clearTimeout,
        ...overrides,
    };
}

module.exports = {
    ROOT,
    createElement,
    createDocument,
    createContext,
    elementIdsFromMarkup,
    featureSources,
    loadModule,
};

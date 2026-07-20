'use strict';

/*
 * Shared readers for the frontend source-and-behaviour suites.
 *
 * These were the private helpers at the top of test_scheduler_frontend.js
 * before that 4,495-line file was split by module-under-test into
 * test_search_frontend.js, test_scheduler_frontend.js, test_map_frontend.js,
 * test_grades_frontend.js, test_api_frontend.js, test_static_layout.js and
 * test_misc_frontend.js. Every split file reads the same module sources and
 * the same stylesheet the same way, so the readers live here once instead of
 * being re-derived per file.
 *
 * Paths are anchored to the repo root (two levels up from tests/support)
 * rather than to process.cwd(), so a suite resolves the same files regardless
 * of where the runner is invoked from.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT_DIR, rel), 'utf8');

// The startup sequence moved out of an inline <script> in index.html and
// into static/js/boot.js, because the site's CSP forbids inline scripts.
function bootSource() {
    return read('static/js/boot.js');
}

// history.js and map.js compose fenced features that live in
// features/<name>/index.js, so the sandbox needs them present just as the
// browser does via their script tags. Composition points construct their
// feature from `Features.<name>`, so a test passes these in as
// `Features: { history: historyFeature }` / `Features: { map: mapFeature }`.
const historyFeature = require('../../static/js/features/history/index.js');
const mapFeature = require('../../static/js/features/map/index.js');

// map.js is now a composition point; its logic lives in the fenced feature, so
// assertions about that logic read both.
function mapSource() {
    return read('static/js/map.js') + read('static/js/features/map/index.js');
}

/*
 * Composition points construct their feature from `Features.<name>`, so the
 * feature modules have to be in the context before the file under test runs.
 * Loading all of them is deliberate: each one only registers itself, so this
 * costs nothing, and it means the next extraction needs no change here.
 */
function featureSources() {
    const dir = path.join(ROOT_DIR, 'static/js/features');
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

/*
 * search.js and scheduler.js are composition points now; their logic lives in
 * the fenced features. Assertions about that logic read both halves, so a seam
 * supplied by the wiring and a behaviour implemented in the feature are both
 * visible to the same test.
 *
 * Several assertions pin source text that names a collaborator. The fenced
 * features reach collaborators through `deps.state`, `deps.walkingMap` and so
 * on, while the unfenced composition points still name the globals directly,
 * so those patterns accept either spelling. Tightening them to one form would
 * break the moment a module moved in or out of a fence -- and silently, since
 * a source-text assertion that matches nothing simply fails open unless it is
 * anchored.
 */
function moduleSource(name) {
    // Every file in the feature directory, not just index.js: a feature may be
    // split into parts its index merges, and search is. Reading one file would
    // find a fraction of the module and let assertions pass against the rest.
    const dir = path.join(ROOT_DIR, `static/js/features/${name}`);
    const parts = fs.readdirSync(dir).filter(file => file.endsWith('.js')).sort()
        .map(file => fs.readFileSync(path.join(dir, file), 'utf8'));
    return [...parts, read(`static/js/${name}.js`)].join('\n');
}

/*
 * The stylesheet, however it happens to be split.
 *
 * style.css was one 5,066-line file and is now thirteen, linked in the order
 * they were cut from it because the cascade depends on that order. Tests care
 * about the rules, not which file holds them, so they read the whole sheet --
 * otherwise splitting a section again breaks assertions that are still true.
 */
function stylesheet() {
    const dir = path.join(ROOT_DIR, 'static/css');
    const html = fs.readFileSync(path.join(ROOT_DIR, 'static/index.html'), 'utf8');
    const linked = [...html.matchAll(/<link[^>]+href="\/static\/css\/([^"?]+)/g)].map(m => m[1]);
    return linked
        .filter(name => fs.existsSync(path.join(dir, name)))
        .map(name => fs.readFileSync(path.join(dir, name), 'utf8'))
        .join('\n');
}

/*
 * Grade-history logic lives in the fenced feature; grades.js is the wiring.
 * Assertions about either belong against both.
 */
function gradesSource() {
    return [
        read('static/js/features/grades/index.js'),
        read('static/js/grades.js'),
    ].join('\n');
}

/*
 * Load one module and return the object it declares. Modules are classic
 * scripts assigning a top-level const, so the name has to be read back out of
 * the sandbox explicitly. `file` is a repo-relative path (e.g.
 * 'static/js/scheduler.js'), matching how the test blocks were written.
 */
function loadObject(file, name, contextValues) {
    const context = vm.createContext({ ...contextValues });
    const source = `${featureSources()}\n${read(file)}\nglobalThis.__result = ${name};`;
    vm.runInContext(source, context);
    return context.__result;
}

/*
 * Markup and CSS readers for order-independent assertions.
 *
 * A test that pins the order of attributes within a tag, or of declarations
 * within a CSS rule, breaks on a behaviour-preserving reformat -- moving an
 * attribute or reordering two properties changes nothing a browser or a screen
 * reader sees, but fails the regex. These extract the relevant tag or rule so a
 * test can assert on its parts as a set instead.
 */

// The opening tag (e.g. `<button ...>`) whose text contains `needle`, or null.
function openingTag(html, needle) {
    const at = html.indexOf(needle);
    if (at === -1) return null;
    const start = html.lastIndexOf('<', at);
    const end = html.indexOf('>', at);
    if (start === -1 || end === -1) return null;
    return html.slice(start, end + 1);
}

// Attributes of an opening tag as a map. A valueless (boolean) attribute such
// as `disabled` maps to true; a `name="value"` attribute maps to its value.
function tagAttributes(tag) {
    const attributes = {};
    const inner = String(tag).replace(/^<\s*[a-zA-Z][\w-]*/, '').replace(/\/?>\s*$/, '');
    for (const match of inner.matchAll(/([^\s=/>]+)(?:\s*=\s*"([^"]*)")?/g)) {
        if (match[1]) attributes[match[1]] = match[2] === undefined ? true : match[2];
    }
    return attributes;
}

// The declaration body of the first `selector { ... }` rule, or null. The
// selector is matched literally, so pass its exact text (e.g. '#filter-panel').
// A CSS rule has no nested braces, so a single [^}] run is enough.
function cssRule(css, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = css.match(new RegExp(escaped + '\\s*\\{([^}]*)\\}'));
    return match ? match[1] : null;
}

// The body of an @media / @container block, brace-matched so its nested rules
// are included, or null. `prelude` is the literal text before the `{`.
function atRuleBody(css, prelude) {
    const at = css.indexOf(prelude);
    if (at === -1) return null;
    let i = css.indexOf('{', at);
    if (i === -1) return null;
    const start = i;
    let depth = 0;
    for (; i < css.length; i += 1) {
        if (css[i] === '{') depth += 1;
        else if (css[i] === '}') { depth -= 1; if (depth === 0) return css.slice(start + 1, i); }
    }
    return null;
}

module.exports = {
    ROOT_DIR,
    bootSource,
    mapSource,
    featureSources,
    moduleSource,
    stylesheet,
    gradesSource,
    loadObject,
    historyFeature,
    mapFeature,
    openingTag,
    tagAttributes,
    cssRule,
    atRuleBody,
};

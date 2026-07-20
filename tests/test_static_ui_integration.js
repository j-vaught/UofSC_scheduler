const path = require('node:path');
const ROOT_DIR_CSS = path.resolve(__dirname, '..');

/*
 * The stylesheet, however it happens to be split.
 *
 * style.css was one 5,066-line file and is now thirteen, linked in the order
 * they were cut from it because the cascade depends on that order. Tests care
 * about the rules, not which file holds them, so they read the whole sheet --
 * otherwise splitting a section again breaks assertions that are still true.
 */
function stylesheet() {
    const dir = path.join(ROOT_DIR_CSS, 'static/css');
    const html = fs.readFileSync(path.join(ROOT_DIR_CSS, 'static/index.html'), 'utf8');
    const linked = [...html.matchAll(/<link[^>]+href="\/static\/css\/([^"?]+)/g)].map(m => m[1]);
    return linked
        .filter(name => fs.existsSync(path.join(dir, name)))
        .map(name => fs.readFileSync(path.join(dir, name), 'utf8'))
        .join('\n');
}

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

// The startup sequence moved out of an inline <script> in index.html and
// into static/js/boot.js, because the site's CSP forbids inline scripts.
function bootSource() {
    return require('node:fs').readFileSync('static/js/boot.js', 'utf8');
}

const UI_FILES = [
    'static/index.html',
    'static/js/grades.js',
    'static/js/profile.js',
    'static/js/degree-plan.js',
    'static/js/search.js',
];

test('UI modules use the API adapter instead of process-backed fetches', () => {
    // Every composition point and every fenced feature, so a raw relay call
    // cannot hide in either half.
    const featureDir = 'static/js/features';
    const featureFiles = fs.existsSync(featureDir)
        ? fs.readdirSync(featureDir)
            .map(name => `${featureDir}/${name}/index.js`)
            .filter(file => fs.existsSync(file))
        : [];
    for (const path of [...UI_FILES, ...featureFiles]) {
        const source = fs.readFileSync(path, 'utf8');
        assert.doesNotMatch(source, /fetch\s*\(\s*['"]\/api\//, path);
    }

    assert.match(fs.readFileSync('static/js/profile.js', 'utf8'), /API\.getMajorMaps\(\)/);
    assert.match(fs.readFileSync('static/js/profile.js', 'utf8'), /API\.parseTranscriptCSV\(/);
    assert.match(fs.readFileSync('static/js/degree-plan.js', 'utf8'), /API\.getDegreePlan\(/);
    assert.match(fs.readFileSync('static/js/grades.js', 'utf8'), /API\.getProfessorGrades\(/);

    /*
     * Search reaches the adapter through an injected collaborator rather than
     * the global, so the assertion is in two parts: the feature asks its api
     * collaborator, and the composition point is what supplies the real one.
     * Checking only one half would pass while the other was wired to nothing.
     */
    const searchFeature = fs.readdirSync('static/js/features/search')
        .filter(file => file.endsWith('.js')).sort()
        .map(file => fs.readFileSync(`static/js/features/search/${file}`, 'utf8'))
        .join('\n');
    assert.match(searchFeature, /deps\.api\.getSubjects\(\)/);
    assert.match(fs.readFileSync('static/js/search.js', 'utf8'), /get api\(\)[^}]*\bAPI\b/);
});

test('static data and browser runtimes load before the API adapter', () => {
    const html = fs.readFileSync('static/index.html', 'utf8');
    const scripts = [
        '/static/js/data-store.js',
        '/static/js/runtime/offering-analyzer.js',
        '/static/js/runtime/transcript-parser.js',
        '/static/js/runtime/degree-planner.js',
        '/static/js/solver-core.js',
        '/static/js/live-university-client.js',
        '/static/js/api.js',
    ];
    const positions = scripts.map(path => html.indexOf(`src="${path}`));
    positions.forEach((position, index) => assert.notEqual(position, -1, scripts[index]));
    assert.deepEqual([...positions].sort((left, right) => left - right), positions);
});

test('static worker registration and desktop-only guidance are nonblocking', () => {
    const html = fs.readFileSync('static/index.html', 'utf8');
    const styles = stylesheet();

    assert.match(html + bootSource(), /window\.addEventListener\('load',[\s\S]*navigator\.serviceWorker\.register/);
    assert.match(html + bootSource(), /source\.includes\('__STATIC_BUILD_ID__'\)/);
    assert.match(html, /class="desktop-only-gate" role="dialog" aria-modal="true"/);
    assert.match(styles, /@media screen and \(max-width: 720px\)[\s\S]*\.desktop-only-gate\s*{/);
});

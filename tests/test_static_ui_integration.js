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
    assert.match(
        fs.readFileSync('static/js/features/search/index.js', 'utf8'),
        /deps\.api\.getSubjects\(\)/,
    );
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
    const styles = fs.readFileSync('static/css/style.css', 'utf8');

    assert.match(html + bootSource(), /window\.addEventListener\('load',[\s\S]*navigator\.serviceWorker\.register/);
    assert.match(html + bootSource(), /source\.includes\('__STATIC_BUILD_ID__'\)/);
    assert.match(html, /class="desktop-only-gate" role="dialog" aria-modal="true"/);
    assert.match(styles, /@media screen and \(max-width: 720px\)[\s\S]*\.desktop-only-gate\s*{/);
});

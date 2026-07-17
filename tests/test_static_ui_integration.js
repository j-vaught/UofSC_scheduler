'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const UI_FILES = [
    'static/index.html',
    'static/js/grades.js',
    'static/js/profile.js',
    'static/js/degree-plan.js',
    'static/js/search.js',
];

test('UI modules use the API adapter instead of process-backed fetches', () => {
    for (const path of UI_FILES) {
        const source = fs.readFileSync(path, 'utf8');
        assert.doesNotMatch(source, /fetch\s*\(\s*['"]\/api\//, path);
    }

    assert.match(fs.readFileSync('static/js/profile.js', 'utf8'), /API\.getMajorMaps\(\)/);
    assert.match(fs.readFileSync('static/js/profile.js', 'utf8'), /API\.parseTranscriptCSV\(/);
    assert.match(fs.readFileSync('static/js/degree-plan.js', 'utf8'), /API\.getDegreePlan\(/);
    assert.match(fs.readFileSync('static/js/grades.js', 'utf8'), /API\.getProfessorGrades\(/);
    assert.match(fs.readFileSync('static/js/search.js', 'utf8'), /API\.getSubjects\(\)/);
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
    const positions = scripts.map(path => html.indexOf(`src="${path}"`));
    positions.forEach((position, index) => assert.notEqual(position, -1, scripts[index]));
    assert.deepEqual([...positions].sort((left, right) => left - right), positions);
});

test('static worker registration and desktop-only guidance are nonblocking', () => {
    const html = fs.readFileSync('static/index.html', 'utf8');
    const styles = fs.readFileSync('static/css/style.css', 'utf8');

    assert.match(html, /window\.addEventListener\('load',[\s\S]*navigator\.serviceWorker\.register/);
    assert.match(html, /source\.includes\('__STATIC_BUILD_ID__'\)/);
    assert.match(html, /class="desktop-only-gate" role="dialog" aria-modal="true"/);
    assert.match(styles, /@media screen and \(max-width: 720px\)[\s\S]*\.desktop-only-gate\s*{/);
});

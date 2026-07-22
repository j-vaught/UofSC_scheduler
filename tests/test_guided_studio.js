const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const html = fs.readFileSync('static/index.html', 'utf8');
const css = fs.readFileSync('static/css/focus-workspace.css', 'utf8');
const studio = fs.readFileSync('static/js/guided-studio.js', 'utf8');

test('Guided Studio provides a workflow rail, document stage, and action dock', () => {
    assert.match(html, /<body class="guided-studio">/);
    assert.match(html, /class="studio-brand"/);
    assert.match(html, /class="studio-context"/);
    assert.match(html, /class="studio-stage"/);
    assert.match(html, /id="studio-action-dock"/);
    assert.match(css, /grid-template-columns:\s*var\(--studio-rail\) minmax\(0, 1fr\)/);
    assert.match(css, /\.browse-detail #semester-search[\s\S]*display:\s*none/);
});

test('new contextual actions delegate to existing feature controls', () => {
    const sourceIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
    const proxies = [...html.matchAll(/data-studio-proxy="([^"]+)"/g)].map((match) => match[1]);
    assert.ok(proxies.length >= 6);
    proxies.forEach((id) => assert.ok(sourceIds.has(id), `${id} must resolve to an existing feature control`));
    assert.match(studio, /document\.getElementById\(proxy\.dataset\.studioProxy\)/);
    assert.match(studio, /source\.click\(\)/);
});

test('schedule course tools and options are mutually exclusive drawers', () => {
    assert.match(html, /data-studio-drawer="courses"/);
    assert.match(html, /data-studio-drawer="options"/);
    assert.match(studio, /studio-course-tools-open/);
    assert.match(studio, /studio-options-open/);
    assert.match(css, /\.schedule-layout\.studio-course-tools-open #schedule-sidebar/);
    assert.match(css, /\.schedule-layout\.studio-options-open #solver-section/);
});

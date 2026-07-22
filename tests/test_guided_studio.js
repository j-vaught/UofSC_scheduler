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
    assert.match(css, /\.studio-stage\s*{[^}]*inset:\s*0 0 0 var\(--studio-rail\);[^}]*position:\s*fixed;[^}]*width:\s*calc\(100vw - var\(--studio-rail\)\);/s);
    assert.match(css, /\.studio-stage > main\s*{[^}]*flex:\s*1 1 0;[^}]*position:\s*relative;[^}]*width:\s*100%;/s);
    assert.match(css, /\.studio-stage > main > \.main-tab\.active\s*{[^}]*display:\s*flex !important;[^}]*visibility:\s*visible;/s);
    assert.match(css, /\.browse-detail #semester-search[\s\S]*display:\s*none/);
});

test('every workspace remains a direct child of the visible center canvas', () => {
    const mainStart = html.indexOf('<main>');
    const mainEnd = html.indexOf('</main>', mainStart);
    const main = html.slice(mainStart, mainEnd);
    assert.notEqual(mainStart, -1);
    assert.notEqual(mainEnd, -1);
    for (const id of ['tab-semester', 'tab-degree', 'tab-schedule']) {
        assert.match(main, new RegExp(`id="${id}"`));
    }
    assert.match(html, /<div class="studio-stage">\s*<div id="site-notices"[\s\S]*<main>/);
    assert.match(html, /<div id="tab-semester" class="main-tab active">/);
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

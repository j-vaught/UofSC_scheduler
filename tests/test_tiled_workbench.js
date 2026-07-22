'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const html = fs.readFileSync('static/index.html', 'utf8');
const styles = fs.readFileSync('static/css/tiled-workbench.css', 'utf8');
const behavior = fs.readFileSync('static/js/tiled-workbench.js', 'utf8');

test('search is structurally composed from query, results, and intelligence tiles', () => {
    assert.match(html, /class="tiled-search-board"/);
    assert.match(html, /QUERY \+ FILTERS/);
    assert.match(html, /<aside id="semester-search">[\s\S]*RESULTS/);
    assert.match(html, /<section id="semester-content">[\s\S]*COURSE INTELLIGENCE/);
    assert.match(styles, /\.tiled-search-board\s*\{[^}]*display:\s*grid;/s);
    assert.match(styles, /grid-template-columns:\s*minmax\(250px, 0\.72fr\) minmax\(300px, 0\.9fr\) minmax\(430px, 1\.6fr\);/);
});

test('schedule is a four-window two-by-two board at laptop widths', () => {
    for (const label of ['COURSE TRAY', 'Schedule Options', 'Weekly Preview', 'ROUTES + CAMPUS MAP']) {
        assert.ok(html.includes(label), `missing schedule tile ${label}`);
    }
    assert.match(styles, /\.schedule-layout\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:[^}]*grid-template-rows:/s);
    assert.match(styles, /#solver-section\s*\{\s*grid-column:\s*2;\s*grid-row:\s*1;/);
    assert.match(styles, /\.schedule-preview-panel\s*\{\s*grid-column:\s*1;\s*grid-row:\s*2;/);
    assert.match(styles, /\.tiled-map-window\s*\{[^}]*grid-column:\s*2;\s*grid-row:\s*2;/s);
});

test('compact workbenches expose a sticky keyboard-operable tile switcher', () => {
    assert.equal((html.match(/class="tile-switcher"/g) || []).length, 3);
    assert.match(styles, /@media screen and \(max-width:\s*900px\)[\s\S]*\.tile-switcher\s*\{[^}]*display:\s*flex;[^}]*position:\s*sticky;/);
    assert.match(behavior, /addEventListener\('click', \(\) => reveal\(button\)\)/);
    assert.match(behavior, /scrollIntoView\(\{ behavior:\s*'smooth'/);
});

test('all original feature hooks remain present in the restructured workbench', () => {
    for (const id of [
        'filter-panel',
        'course-detail-tabs',
        'grades-container',
        'history-container',
        'course-resource-links',
        'btn-registration-info',
        'btn-export',
        'walking-map-container',
        'major-program-select',
        'btn-add-custom-major-map',
        'transcript-input',
    ]) {
        assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
    }
});

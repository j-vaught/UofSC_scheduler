const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const html = fs.readFileSync('static/index.html', 'utf8');
const css = fs.readFileSync('static/css/command-center.css', 'utf8');

function mediaBody(maxWidth) {
    const start = css.indexOf(`@media (max-width: ${maxWidth}px)`);
    assert.notEqual(start, -1, `missing ${maxWidth}px responsive rules`);
    const next = css.indexOf('\n@media ', start + 1);
    return css.slice(start, next === -1 ? css.length : next);
}

test('Command Center uses a rail and a separate task workspace', () => {
    assert.match(html, /<body class="command-center">/);
    assert.match(html, /<header>[\s\S]*id="main-tabs"[\s\S]*<\/header>[\s\S]*class="command-workspace"/);
    assert.match(html, /class="command-topbar"[\s\S]*id="command-search-launch"[\s\S]*id="term-select"/);
    assert.match(css, /body\.command-center\s*{[^}]*grid-template-columns:\s*var\(--cc-nav-width\) minmax\(0, 1fr\);/s);
    assert.match(css, /\.command-workspace\s*{[^}]*grid-column:\s*2;/s);
});

test('narrow Schedule tools overlay instead of squeezing the canvas', () => {
    const narrow = mediaBody(760);
    assert.match(narrow, /\.schedule-layout\s*{[^}]*position:\s*relative;[^}]*width:\s*100%;/s);
    assert.match(narrow, /#schedule-sidebar\s*{[^}]*position:\s*absolute;[^}]*width:\s*min\(72vw, 270px\) !important;/s);
    assert.match(narrow, /#schedule-content\s*{[^}]*min-width:\s*0;[^}]*width:\s*100%;/s);
    assert.match(narrow, /\.schedule-layout\.schedule-sidebar-collapsed #schedule-sidebar\s*{[^}]*display:\s*none;/s);
    assert.match(narrow, /\.schedule-sidebar-toggle-rail\s*{[^}]*display:\s*flex;[^}]*position:\s*absolute;/s);
    assert.match(narrow, /\.schedule-sidebar-toggle-rail\s*{[^}]*height:\s*auto;[^}]*width:\s*8px;/s);
});

test('narrow task pages retain the full remaining workspace width', () => {
    const narrow = mediaBody(760);
    assert.match(narrow, /body\.command-center\s*{[^}]*grid-template-columns:\s*var\(--cc-nav-width\) minmax\(0, 1fr\);/s);
    assert.match(narrow, /\.command-workspace,[\s\S]*\.main-tab\.active\s*{[^}]*min-width:\s*0;[^}]*width:\s*100%;/s);
});

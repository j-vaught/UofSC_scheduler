/*
 * Pure markup and stylesheet contracts with no single module owner:
 * index.html structure and the linked CSS rules that lay out the shell.
 * Split out of test_scheduler_frontend.js.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const {
    stylesheet, cssRule, atRuleBody,
} = require('./support/scheduler-harness.js');

test('browse filters separate primary and additional course choices', () => {
    const source = fs.readFileSync('static/index.html', 'utf8');
    const styles = stylesheet();

    assert.match(source, /id="filter-show-all"/);
    assert.doesNotMatch(source, /id="filter-current-term"/);
    assert.match(source, /id="filter-method"/);
    assert.match(source, /id="filter-carolina-core"/);
    assert.match(source, /class="filter-primary-column filter-primary-checkboxes">[\s\S]*id="filter-show-all"[\s\S]*id="filter-open"[\s\S]*id="filter-eligible"[\s\S]*class="filter-primary-column filter-primary-selects">[\s\S]*id="filter-method"[\s\S]*id="filter-carolina-core"/);
    assert.match(source, /value="CMW"/);
    assert.match(source, /value="VSR"/);
    assert.match(source, /id="additional-filter-toggle"/);
    // The additional-filters region must CONTAIN this set of controls. The order
    // they appear in the markup is presentation, not contract, so scope to the
    // region and assert membership. The panel-start anchor is kept from Job 2: a
    // renamed panel makes panelStart -1 and an unscoped search would match ids
    // elsewhere in the document, passing even after a control left the panel.
    const panelStart = source.indexOf('id="additional-filter-panel"');
    assert.notEqual(panelStart, -1, 'the additional filter panel moved; this test is not reading it');
    const panelEnd = source.indexOf('</section>', panelStart);
    assert.notEqual(panelEnd, -1, 'the browse filter section is unterminated; the panel scope is unbounded');
    const additionalFilters = source.slice(panelStart, panelEnd);
    for (const control of [
        'id="filter-part-of-term"',
        'id="filter-course-attribute"',
        'id="filter-honors"',
        'id="filter-meeting-pattern"',
        'id="filter-size-mode"',
        'id="filter-avail-mode"',
        'id="btn-apply-filters"',
        'id="btn-clear-filters"',
    ]) {
        assert.ok(additionalFilters.includes(control), `the additional filters must contain ${control}`);
    }
    assert.match(styles, /\.filter-actions\s*{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s);
    assert.match(styles, /@container browse-sidebar \(max-width:\s*285px\)/);
    assert.match(styles, /\.filter-action-compact\s*{\s*display:\s*inline;/s);
});

test('navigation is centered inside the single garnet header', () => {
    const html = fs.readFileSync('static/index.html', 'utf8');
    const styles = stylesheet();
    const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>') + 9);

    assert.match(html, /<title>Course Scheduler<\/title>/);
    assert.match(header, /<h1>Course Scheduler<\/h1>/);
    assert.match(header, /<nav id="main-tabs"/);
    assert.match(styles, /header\s*{[^}]*grid-template-columns:\s*minmax\(180px, 1fr\) auto minmax\(180px, 1fr\);/s);
    assert.match(styles, /#main-tabs\s*{[^}]*background:\s*transparent;[^}]*justify-content:\s*center;/s);
    assert.match(styles, /body\s*{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*height:\s*100dvh;/s);
    assert.match(styles, /main\s*{[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;/s);
    assert.match(html, /id="site-notices"[^>]*hidden[^>]*aria-live="polite"/);
    assert.doesNotMatch(html, /UOFSC COURSE SCHEDULER/);
});

test('schedule workspace remains split and contained on narrower desktop screens', () => {
    const styles = stylesheet();

    // Extract each rule block, then match one property inside it. This is
    // order-independent: reordering declarations within a rule, or reordering
    // rules within the media query, changes nothing the cascade applies, so the
    // assertion must not depend on either. The old spanning `[\s\S]*` could also
    // match a `grid-template-columns` from a different rule inside the query.
    const workspace = cssRule(styles, '.schedule-workspace');
    assert.ok(workspace, 'the .schedule-workspace rule moved; this test is not reading it');
    assert.match(workspace, /grid-template-columns:\s*minmax\(180px, 0\.56fr\) minmax\(0, 1\.5fr\);/);

    const narrow = atRuleBody(styles, '@media (max-width: 1100px)');
    assert.ok(narrow, 'the 1100px narrowing media query moved; this test is not reading it');
    const narrowWorkspace = cssRule(narrow, '.schedule-workspace');
    assert.ok(narrowWorkspace, 'the narrowed workspace rule moved');
    assert.match(narrowWorkspace, /grid-template-columns:\s*minmax\(170px, 0\.56fr\) minmax\(0, 1\.35fr\);/);
    const narrowResizer = cssRule(narrow, '.schedule-vertical-resizer');
    assert.ok(narrowResizer, 'the narrowed vertical-resizer rule moved');
    assert.match(narrowResizer, /display:\s*flex;/);
    assert.match(styles, /#calendar-container\s*{[^}]*max-width:\s*100%;[^}]*overflow:\s*auto;[^}]*width:\s*100%;/s);
    assert.match(styles, /#calendar-grid\s*{[^}]*min-width:\s*460px;/s);
    assert.match(styles, /@container schedule-options \(max-width:\s*220px\)/);
    assert.ok(
        styles.indexOf('@container schedule-options (max-width: 220px)')
            > styles.indexOf('.btn-panel-registration:disabled'),
        'narrow container overrides must follow the base action-button rules',
    );
    assert.match(
        styles,
        /@container schedule-options \(max-width:\s*220px\)[\s\S]*\.btn-panel-registration\s*{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/,
    );
    assert.match(styles, /\.sched-course\s*{[^}]*background:\s*transparent;/s);

    const mapStyles = fs.readFileSync('static/css/map.css', 'utf8');
    assert.match(mapStyles, /container-name:\s*route-map;/);
    assert.match(mapStyles, /@container route-map \(max-width:\s*570px\)/);
    assert.match(mapStyles, /grid-template-rows:\s*minmax\(110px, 1\.2fr\) minmax\(72px, 1fr\);/);
});

test('schedule map divider is centered between the calendar and map', () => {
    const styles = stylesheet();
    const rule = styles.match(/\.schedule-vertical-resizer\s*\{([^}]*)\}/)?.[1] || '';

    assert.match(rule, /align-self:\s*center;/);
    assert.match(rule, /margin:\s*-7px auto;/);
    assert.match(rule, /width:\s*calc\(100%\s*-\s*20px\);/);
    assert.match(rule, /justify-content:\s*center;/);
});

test('schedule course tools have an accessible persistent collapse rail', () => {
    const source = fs.readFileSync('static/index.html', 'utf8');
    const styles = stylesheet();
    const asideStart = source.indexOf('<aside id="schedule-sidebar">');
    const asideEnd = source.indexOf('</aside>', asideStart);
    // Anchor both: a renamed aside makes the slice empty so the "toggle lives
    // outside the aside" check passes against nothing; an unterminated aside
    // makes the slice the whole document. Either way it fails open.
    assert.notEqual(asideStart, -1, 'the schedule sidebar aside moved; this test is not reading it');
    assert.notEqual(asideEnd, -1, 'the schedule sidebar aside is unterminated; the slice is unbounded');
    const aside = source.slice(asideStart, asideEnd);

    assert.match(
        source,
        /id="btn-toggle-schedule-sidebar"[^>]*aria-controls="schedule-sidebar"[^>]*aria-expanded="true"/,
    );
    assert.match(
        source,
        /id="schedule-sidebar-resize-handle"[^>]*role="separator"[^>]*aria-orientation="vertical"/,
    );
    assert.doesNotMatch(aside, /btn-toggle-schedule-sidebar/);
    assert.doesNotMatch(source, /schedule-sidebar-toggle-text/);
    assert.match(
        styles,
        /\.schedule-layout\.schedule-sidebar-collapsed #schedule-sidebar\s*\{[^}]*display:\s*none;/s,
    );
    assert.match(styles, /\.schedule-sidebar-toggle-rail\s*\{[^}]*flex:\s*0 0 10px;/s);
    assert.match(styles, /\.schedule-sidebar-toggle-rail\s*\{[^}]*border-left:\s*2px solid #000000;/s);
    assert.match(styles, /\.schedule-sidebar-toggle-rail\s*\{[^}]*background:\s*#ffffff;/s);
    assert.doesNotMatch(
        styles.match(/\.schedule-sidebar-toggle-rail\s*\{([^}]*)\}/)?.[1] || '',
        /border-right/,
    );
    assert.match(styles, /\.schedule-sidebar-toggle\s*\{[^}]*background:\s*transparent;/s);
    assert.match(styles, /\.schedule-sidebar-toggle\s*\{[^}]*width:\s*24px;/s);
    assert.match(styles, /\.schedule-sidebar-toggle::before\s*\{[^}]*background:\s*#000000;/s);
    assert.match(styles, /\.schedule-sidebar-toggle::before\s*\{[^}]*width:\s*10px;/s);
    assert.match(styles, /\.schedule-sidebar-toggle\s*\{[^}]*color:\s*#ffffff;/s);
    assert.match(styles, /\.schedule-sidebar-toggle-icon\s*\{[^}]*left:\s*50%;/s);
    assert.match(
        styles,
        /\.schedule-sidebar-collapsed \.schedule-sidebar-toggle-icon\s*\{[^}]*left:\s*calc\(50% - 1px\);/s,
    );
    assert.match(styles, /\.schedule-sidebar-resize-handle\s*\{[^}]*cursor:\s*col-resize;/s);
    assert.match(styles, /#schedule-sidebar\s*\{[^}]*width:\s*var\(--schedule-sidebar-width, 340px\);/s);
    assert.match(styles, /@media \(max-width:\s*760px\)[\s\S]*#schedule-sidebar\s*\{[^}]*max-width:\s*none;/);
    assert.match(styles, /#schedule-content\s*\{[^}]*min-width:\s*0;/s);
    assert.match(styles, /@media \(max-width:\s*760px\)[\s\S]*\.schedule-sidebar-toggle-rail\s*\{/);
    assert.match(source, /class="schedule-search-button-wide">SEARCH COURSES<\/span>/);
    assert.match(source, /class="schedule-search-button-compact">SEARCH<\/span>/);
    assert.match(source, /id="schedule-selected-heading"[^>]*>Your Courses<\/h2>/);
    assert.match(styles, /@container schedule-sidebar \(max-width:\s*240px\)/);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function loadObject(path, name, contextValues) {
    const context = vm.createContext({ ...contextValues });
    const source = `${fs.readFileSync(path, 'utf8')}\nglobalThis.__result = ${name};`;
    vm.runInContext(source, context);
    return context.__result;
}

test('applied section appears in the section dropdown without a separate status line', () => {
    const elements = {
        'selected-courses-list': { innerHTML: '', querySelectorAll: () => [] },
        'selected-credits': { textContent: '' },
        'schedule-selected-count': { textContent: '' },
    };
    const sidebar = loadObject('static/js/degree-plan.js', 'ScheduleSidebar', {
        State: {
            selectedCourses: {
                'TEST 101': {
                    title: 'Test Course',
                    sections: [{ crn: '10101', section: '004', stat: 'A', hours: '3' }],
                },
            },
            selectedSections: { 'TEST 101': { crn: '10101', section: '004' } },
            sectionLocks: {},
        },
        document: { getElementById: id => elements[id] || null },
    });

    sidebar.render();

    assert.match(elements['selected-courses-list'].innerHTML, /<option value="">Section 004 selected<\/option>/);
    assert.doesNotMatch(elements['selected-courses-list'].innerHTML, /Applied section 004/);
});

test('full sections remain selectable as an explicit planning override', () => {
    const elements = {
        'selected-courses-list': { innerHTML: '', querySelectorAll: () => [] },
        'selected-credits': { textContent: '' },
    };
    const sidebar = loadObject('static/js/degree-plan.js', 'ScheduleSidebar', {
        State: {
            selectedCourses: {
                'TEST 101': {
                    title: 'Test Course',
                    sections: [{ crn: '10101', section: '001', stat: 'C', hours: '3' }],
                },
            },
            selectedSections: {},
            sectionLocks: { 'TEST 101': '10101' },
        },
        document: { getElementById: id => elements[id] || null },
    });

    sidebar.render();

    assert.match(elements['selected-courses-list'].innerHTML, /value="10101" selected/);
    assert.doesNotMatch(elements['selected-courses-list'].innerHTML, /value="10101"[^>]*disabled/);
    assert.match(elements['selected-courses-list'].innerHTML, /Full section selected\. Planning only/);
});

test('locked section is shown in the dropdown with a clear-section action', () => {
    const elements = {
        'selected-courses-list': { innerHTML: '', querySelectorAll: () => [] },
        'selected-credits': { textContent: '' },
        'schedule-selected-count': { textContent: '' },
    };
    const sidebar = loadObject('static/js/degree-plan.js', 'ScheduleSidebar', {
        State: {
            selectedCourses: {
                'CSCE 145': {
                    title: 'Algorithmic Design I',
                    sections: [{ crn: '10868', section: '001', stat: 'A', hours: '4' }],
                },
            },
            selectedSections: {},
            sectionLocks: { 'CSCE 145': '10868' },
        },
        document: { getElementById: id => elements[id] || null },
    });

    sidebar.render();

    assert.match(elements['selected-courses-list'].innerHTML, /value="10868" selected>Section 001/);
    assert.match(elements['selected-courses-list'].innerHTML, /class="btn-clear-section"/);
    assert.doesNotMatch(elements['selected-courses-list'].innerHTML, /will be used in all schedules/);
    assert.doesNotMatch(elements['selected-courses-list'].innerHTML, /Locked section will be required/);
});

test('schedule sidebar totals actual one, four, and three credit courses', () => {
    const elements = {
        'selected-courses-list': { innerHTML: '', querySelectorAll: () => [] },
        'selected-credits': { textContent: '' },
        'schedule-selected-count': { textContent: '' },
    };
    const sidebar = loadObject('static/js/degree-plan.js', 'ScheduleSidebar', {
        State: {
            selectedCourses: {
                'CSCE 190': { title: 'Computing in the Modern World', credits: 1, sections: [] },
                'CSCE 145': { title: 'Algorithmic Design I', credits: 4, sections: [] },
                'CSCE 211': { title: 'Digital Logic Design', credits: 3, sections: [] },
            },
            selectedSections: {},
            sectionLocks: {},
        },
        document: { getElementById: id => elements[id] || null },
    });

    sidebar.render();

    assert.equal(elements['selected-credits'].textContent, '8 credits');
});

test('course credit hydration stores detail credits on every live section', async () => {
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {
        API: { async getDetails() { return { hours_html: '4 Credit Hours' }; } },
        State: { term: '202608' },
    });
    const group = {
        code: 'CSCE 145',
        sections: [{ crn: '10868' }, { crn: '10869' }],
    };

    await scheduler.hydrateCourseCredits(group);

    assert.equal(group.credits, 4);
    assert.equal(group.sections[0].hours, 4);
    assert.equal(group.sections[1].hours, 4);
});

test('semantic catalog matches retain complete live section records', () => {
    const search = loadObject('static/js/search.js', 'Search', {});
    const liveSection = {
        code: 'CSCE 145',
        title: 'Algorithmic Design I',
        crn: '10868',
        section: '001',
        instr: 'Example Professor',
        meets: 'MW 10:00-11:15a',
        inst_mthd: 'Face-to-Face Instruction',
        stat: 'A',
    };
    const index = search.buildLiveCourseIndex([liveSection]);

    const merged = search.mergeCatalogWithLiveSections([
        { code: 'CSCE 145', title: 'Algorithmic Design I', key: '1407', _relevanceScore: 0.9 },
    ], index);

    assert.equal(merged.length, 1);
    assert.equal(merged[0].crn, '10868');
    assert.equal(merged[0].instr, 'Example Professor');
    assert.equal(merged[0].inst_mthd, 'Face-to-Face Instruction');
    assert.equal(merged[0]._isCatalog, undefined);

    const catalogOnly = search.mergeCatalogWithLiveSections([
        { code: 'CSCE 999', title: 'Future Course', key: '1999' },
    ], index);
    assert.equal(catalogOnly[0].meets, 'Not offered this term');
    assert.equal(catalogOnly[0]._isCatalog, true);
});

test('browse course availability uses concise color-coded states', () => {
    const search = loadObject('static/js/search.js', 'Search', {});
    const open = search.courseAvailability({
        sections: [
            { crn: '10001', stat: 'A' },
            { crn: '10002', stat: 'A' },
            { crn: '10003', stat: 'C' },
        ],
    });
    const full = search.courseAvailability({
        sections: [{ crn: '20001', stat: 'C' }, { crn: '20002', stat: 'C' }],
    });
    const unavailable = search.courseAvailability({
        sections: [{ _isCatalog: true, meets: 'Not offered this term' }],
    });
    const unknown = search.courseAvailability({
        sections: [{ _isCatalog: true, availability_unknown: true }],
    });

    assert.equal(open.kind, 'open');
    assert.equal(open.text, '2 of 3 sections open');
    assert.equal(full.kind, 'full');
    assert.equal(full.text, 'All 2 sections full');
    assert.equal(unavailable.kind, 'unavailable');
    assert.equal(unavailable.text, 'Not offered');
    assert.equal(unknown.kind, 'unknown');
    assert.equal(unknown.text, 'Live availability unavailable');
});

test('browse results reserve course add actions for the details pane', () => {
    const source = fs.readFileSync('static/js/search.js', 'utf8');
    const styles = fs.readFileSync('static/css/style.css', 'utf8');

    assert.doesNotMatch(source, /class="btn-course-add/);
    assert.match(source, /class="course-header-main"/);
    assert.match(source, /class="course-availability \$\{availability\.kind\}"/);
    assert.match(source, /unschedulable \? ' disabled' : ''/);
    assert.match(source, /unavailableLabel/);
    assert.match(styles, /\.course-header-main\s*{[^}]*text-overflow:\s*ellipsis;/s);
    assert.match(styles, /\.course-availability\.open[^}]*color:\s*#2e7d32/s);
    assert.match(styles, /\.course-availability\.full[^}]*color:\s*#c62828/s);
    assert.match(styles, /\.course-availability\.unavailable[^}]*color:\s*#5C5C5C/s);
});

test('Search results do not display a selected-course counter', () => {
    const html = fs.readFileSync('static/index.html', 'utf8');
    const styles = fs.readFileSync('static/css/style.css', 'utf8');

    assert.doesNotMatch(html, /id="pick-count"|\(\$\{count\} selected\)/);
    assert.doesNotMatch(styles, /\.pick-count|\.results-header:has\(\.pick-count/);
    assert.match(html, /State\.on\('courses-changed', \(\) => ScheduleSidebar\.render\(\)\)/);
});

test('browse section details add and lock the specific section', () => {
    const source = fs.readFileSync('static/js/search.js', 'utf8');
    const registrationNotes = source.slice(
        source.indexOf('sectionRegistrationNotes(details = null)'),
        source.indexOf('destroyDetailMap()'),
    );

    assert.match(source, /ADD SECTION \$\{sectionLabel\} TO SCHEDULE/);
    assert.match(source, /LET SCHEDULER CHOOSE/);
    assert.match(source, /Use Section \$\{sectionLabel\} in every generated schedule/);
    assert.match(source, /State\.setSectionLock\(group\.code, locked \? null : section\.crn\)/);
    assert.match(source, /You can still use this full section for planning\./);
    assert.match(source, /this\._detailSectionData\[this\._detailSectionCrn\] = \{ details, faculty \}/);
    assert.match(source, /picker\.querySelectorAll\('\[data-detail-crn\]'\)[\s\S]*selectDetailSection\(button\.dataset\.detailCrn\)/);
    assert.match(source, /class="course-section-visuals"/);
    assert.match(source, /id="course-section-map"/);
    assert.match(source, /Registration notes for this section/);
    assert.match(source, /\$\{this\.sectionRegistrationNotes\(details\)\}[\s\S]*<details class="course-time-location"/);
    assert.doesNotMatch(source, /id="btn-view-schedule"/);
    assert.match(source, /id="btn-course-view-schedule"/);
    assert.doesNotMatch(registrationNotes, /part_of_term|Part of term/);
});

test('course time and location collapse preference persists locally and defaults expanded', () => {
    const source = fs.readFileSync('static/js/search.js', 'utf8');
    const values = new Map();
    const localStorage = {
        getItem(key) { return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { values.set(key, String(value)); },
    };
    const firstLoad = loadObject('static/js/search.js', 'Search', { localStorage });

    assert.equal(firstLoad.detailTimeLocationExpanded(), true);
    firstLoad.setDetailTimeLocationExpanded(false);
    assert.equal(values.get('uofsc-course-time-location-expanded-v1'), 'false');

    const reloaded = loadObject('static/js/search.js', 'Search', { localStorage });
    assert.equal(reloaded.detailTimeLocationExpanded(), false);
    reloaded.setDetailTimeLocationExpanded(true);
    assert.equal(reloaded.detailTimeLocationExpanded(), true);

    reloaded.setDetailTimeLocationExpanded(false);
    const listeners = {};
    const attributes = {};
    const summary = { setAttribute(name, value) { attributes[name] = value; } };
    const content = { hidden: false };
    const details = {
        tagName: 'DETAILS',
        open: true,
        querySelector: selector => selector === 'summary' ? summary : null,
        addEventListener(type, listener) { listeners[type] = listener; },
    };
    const root = {
        querySelector(selector) {
            if (selector === '[data-time-location-toggle]') return details;
            if (selector === '[data-time-location-content]') return content;
            return null;
        },
    };
    let expandedCalls = 0;
    let collapsedCalls = 0;
    assert.equal(reloaded.bindDetailTimeLocationPreference(root, {
        onExpand: () => { expandedCalls += 1; },
        onCollapse: () => { collapsedCalls += 1; },
    }), false);
    assert.equal(details.open, false);
    assert.equal(content.hidden, true);
    assert.equal(attributes['aria-expanded'], 'false');
    details.open = true;
    listeners.toggle();
    assert.equal(content.hidden, false);
    assert.equal(attributes['aria-expanded'], 'true');
    assert.equal(reloaded.detailTimeLocationExpanded(), true);
    assert.equal(expandedCalls, 1);
    assert.equal(collapsedCalls, 0);

    const blockedStorage = loadObject('static/js/search.js', 'Search', {
        localStorage: {
            getItem() { throw new Error('Storage unavailable'); },
            setItem() { throw new Error('Storage unavailable'); },
        },
    });
    assert.equal(blockedStorage.detailTimeLocationExpanded(), true);
    assert.doesNotThrow(() => blockedStorage.setDetailTimeLocationExpanded(false));

    assert.match(source, /data-time-location-toggle/);
    assert.match(source, /data-time-location-content/);
    assert.match(source, /bindDetailTimeLocationPreference\(root, \{ onExpand, onCollapse \} = \{\}\)/);
    assert.match(source, /content\.hidden = !value/);
    assert.match(source, /control\?\.setAttribute\('aria-expanded', String\(value\)\)/);
    assert.match(source, /this\.setDetailTimeLocationExpanded\(value\)/);
    assert.match(source, /this\.bindDetailTimeLocationPreference\(container/);
});

test('course calendar uses exact padded bounds with a four-hour minimum', () => {
    const search = loadObject('static/js/search.js', 'Search', {});

    const broad = search.sectionCalendarRange([{ start: 510, end: 810 }]);
    assert.equal(broad.start, 480);
    assert.equal(broad.end, 840);
    const minimum = search.sectionCalendarRange([{ start: 650, end: 700 }]);
    assert.equal(minimum.start, 620);
    assert.equal(minimum.end, 860);
    const late = search.sectionCalendarRange([{ start: 1200, end: 1230 }]);
    assert.equal(late.start, 1020);
    assert.equal(late.end, 1260);
});

test('course calendar keeps the final time label inside its explicit grid', () => {
    const search = loadObject('static/js/search.js', 'Search', {});
    search.escapeText = value => String(value);
    const calendar = search.renderSectionCalendar({}, null, {
        dayCount: 5,
        range: { start: 670, end: 910 },
        events: [{
            color: '#73000A',
            day: 1,
            end: 790,
            foreground: '#FFFFFF',
            locationIndex: null,
            locationNumber: null,
            rawLocation: '',
            start: 700,
        }],
    });

    assert.match(calendar, /grid-template-rows:28px repeat\(48, minmax\(2px, 1fr\)\)/);
    assert.match(calendar, /section-calendar-track[^>]*grid-row:2 \/ span 48/);
    assert.match(calendar, /section-calendar-half-hour hour[^>]*grid-row:48/);
    assert.match(calendar, /section-calendar-time[^>]*grid-row:48 \/ span 2[^>]*>3:00 PM/);
    assert.doesNotMatch(calendar, /grid-row:48 \/ span 6/);
    assert.match(calendar, /aria-label="Weekly meeting calendar from 11:10 AM to 3:10 PM"/);
    const labelRows = [...calendar.matchAll(/section-calendar-time[^>]*grid-row:(\d+) \/ span (\d+)/g)];
    assert.ok(labelRows.length > 0);
    assert.ok(labelRows.every(match => Number(match[1]) + Number(match[2]) <= 50));
});

test('course time and location correlates numbered colors across calendar and map', () => {
    const buildings = {
        Gambrell: { kind: 'known', code: 'GAMBRL', name: 'Gambrell Hall', lat: 34, lon: -81 },
        CloseHipp: { kind: 'known', code: 'CLHIPP', name: 'Close-Hipp Building', lat: 34.01, lon: -81.01 },
    };
    const walkingMap = {
        parseMeetingTimes() {
            return [
                { day: 0, start: 510, end: 560 },
                { day: 2, start: 630, end: 680 },
            ];
        },
        parseMeetingDetails() {
            return [
                { days: [0], start: 510, end: 560, rawLocation: 'Gambrell 152', building: buildings.Gambrell },
                { days: [2], start: 630, end: 680, rawLocation: 'Close-Hipp 750', building: buildings.CloseHipp },
            ];
        },
        resolveBuilding(value) { return value.includes('Gambrell') ? buildings.Gambrell : buildings.CloseHipp; },
        normalizeLocation(value) { return value.toLowerCase(); },
        formatTime(minutes) {
            const hour24 = Math.floor(minutes / 60);
            const minute = minutes % 60;
            return `${hour24 % 12 || 12}:${String(minute).padStart(2, '0')} ${hour24 >= 12 ? 'PM' : 'AM'}`;
        },
    };
    const search = loadObject('static/js/search.js', 'Search', { WalkingMap: walkingMap });
    search.escapeText = value => String(value);
    const view = search.sectionTimeLocationData(
        { meetingTimes: 'listed' },
        { meeting_html: '<div>meetings</div>' },
    );

    assert.equal(view.locations.length, 2);
    assert.deepEqual(view.events.map(event => event.locationNumber), [1, 2]);
    assert.notEqual(view.locations[0].color, view.locations[1].color);
    assert.equal(view.range.start, 480);
    assert.equal(view.range.end, 720);

    const calendar = search.renderSectionCalendar({}, null, view);
    assert.match(calendar, /data-location-index="0"/);
    assert.match(calendar, /data-location-index="1"/);
    assert.match(calendar, /section-calendar-location-number[^>]*>1</);
    assert.match(calendar, /section-calendar-location-number[^>]*>2</);
    assert.match(calendar, /repeat\(48, minmax\(2px, 1fr\)\)/);
    const key = search.renderSectionLocationKey(view);
    assert.match(key, /Gambrell 152/);
    assert.match(key, /Close-Hipp 750/);

    const source = fs.readFileSync('static/js/search.js', 'utf8');
    const styles = fs.readFileSync('static/css/style.css', 'utf8');
    assert.match(source, /markerElement\?\.addEventListener\('mouseenter'/);
    assert.match(source, /section-calendar-event\[data-location-index/);
    assert.match(source, /setSectionLocationInteractionState\(block, locationIndex, 'hover', true\)/);
    assert.match(source, /element\.dataset\.locationHover === 'true'/);
    assert.match(source, /element\.dataset\.locationFocus === 'true'/);
    assert.doesNotMatch(source, /<button[^>]*class="section-calendar-event"/);
    assert.match(styles, /\.section-mini-calendar-grid\s*{[^}]*height:\s*360px;/s);
    assert.match(styles, /\.course-section-map\s*{[^}]*height:\s*360px;/s);
    assert.match(styles, /\.course-section-map\s*{[^}]*isolation:\s*isolate;[^}]*z-index:\s*0;/s);
    assert.match(styles, /\.leaflet-marker-icon\.is-location-highlighted/);
});

test('prerequisite details use a compact status-first requirement tree', () => {
    const prereqs = loadObject('static/js/prereqs.js', 'Prereqs', {});
    const source = fs.readFileSync('static/js/prereqs.js', 'utf8');
    const styles = fs.readFileSync('static/css/style.css', 'utf8');
    const groups = [{ courses: ['CSCE 580'], type: 'and' }];
    const companions = [
        { mode: 'corequisite', text: 'CSCE 884.', groups: [{ courses: ['CSCE 884'], type: 'and' }] },
        { mode: 'either', text: 'CSCE 585.', groups: [{ courses: ['CSCE 585'], type: 'and' }] },
    ];
    const completed = new Set();

    const status = prereqs.renderStatus(groups, [], completed, true, false);
    const companionStatus = prereqs.renderStatus([], companions, completed, false, false);
    const reviewStatus = prereqs.renderStatus(groups, [], completed, true, true);
    const pathway = prereqs.renderPathways('CSCE 883', groups, companions, completed);
    const alternativeCompanions = [{
        mode: 'either',
        text: 'MATH 111 or MATH 115.',
        groups: prereqs.parsePrereqGroups('MATH 111 or MATH 115.'),
    }];
    const alternativeStatus = prereqs.renderStatus([], alternativeCompanions, completed, false, false);
    const alternativeTree = prereqs.renderPathways('CSCE 145', [], alternativeCompanions, completed);
    const catalog = prereqs.renderCatalogNote('CSCE 580.', companions, false);
    const requiredTogether = prereqs.parsePrereqGroups('C or better in ACCT 401 and MGSC 290.');
    const alternatives = prereqs.parsePrereqGroups('D or better in ENCP 200, ECIV 200, EMCH 200, or ECHE 300.');
    const mixed = prereqs.parsePrereqGroups('D or better in EMCH 290 or ENCP 290 and AESP 265.');
    const placementAlternative = prereqs.parsePrereqGroups(
        'Prerequisites: C or better in MATH 112, MATH 115, MATH 116, or through placement exam.',
    );
    const placementTree = prereqs.renderPathways('MATH 141', placementAlternative, [], completed);
    const mixedPlacement = prereqs.parsePrereqGroups(
        'C or better in MATH 111 and MATH 112, or placement exam.',
    );
    const unevenPathway = prereqs.renderPathways('CSCE 350', [
        { courses: ['CSCE 240'], type: 'and' },
        { courses: ['MATH 174', 'MATH 374', 'MATH 574'], type: 'or' },
        { courses: ['MATH 141', 'MATH 122'], type: 'or' },
    ], [], completed);

    assert.match(status, /1 prerequisite requirement remaining/);
    assert.match(companionStatus, /2 companion courses to plan/);
    assert.match(alternativeStatus, /1 companion course to plan/);
    assert.match(alternativeTree, /choose one/);
    assert.match(reviewStatus, /Review these requirements/);
    assert.match(pathway, /CSCE 580/);
    assert.match(pathway, /Needed/);
    assert.match(pathway, /CSCE 883/);
    assert.match(pathway, /This course/);
    assert.match(pathway, /prereq-tree-groups/);
    assert.match(pathway, /Take with this course/);
    assert.match(pathway, /Before or with this course/);
    const targetIndex = pathway.indexOf('prereq-course-card target');
    assert.ok(pathway.indexOf('Take with this course') < targetIndex);
    assert.ok(pathway.indexOf('Before or with this course') < targetIndex);
    assert.match(alternativeTree, /prereq-tree-groups single companions-only/);
    assert.match(alternativeTree, /prereq-tree-connector companion/);
    assert.doesNotMatch(pathway, /prereq-tree-companions|prereq-tree-companion-rise/);
    assert.match(unevenPathway, /prereq-course-options alternatives/);
    assert.equal((unevenPathway.match(/prereq-tree-branch-drop/g) || []).length, 3);
    assert.equal((unevenPathway.match(/class="prereq-link prereq-course-card/g) || []).length, 6);
    assert.match(unevenPathway, /prereq-course-options[^>]*>[\s\S]*prereq-tree-branch-drop/);
    assert.doesNotMatch(pathway, /<svg/);
    assert.match(catalog, /<details class="prereq-catalog-note">/);
    assert.match(catalog, /Catalog wording/);
    assert.equal(prereqs.requirementNeedsReview('CSCE 580.'), false);
    assert.equal(prereqs.requirementNeedsReview('C or better in CSCE 580.'), true);
    assert.equal(prereqs.requirementNeedsReview('CSCE 101 or above.'), true);
    assert.equal(prereqs.requirementNeedsReview('MATH 141 or placement.'), true);
    assert.deepEqual(
        JSON.parse(JSON.stringify(requiredTogether.map(group => [...group.courses]))),
        [['ACCT 401'], ['MGSC 290']],
    );
    assert.deepEqual(
        JSON.parse(JSON.stringify(alternatives[0].courses)),
        ['ENCP 200', 'ECIV 200', 'EMCH 200', 'ECHE 300'],
    );
    assert.deepEqual(
        JSON.parse(JSON.stringify(mixed.map(group => [...group.courses]))),
        [['EMCH 290', 'ENCP 290'], ['AESP 265']],
    );
    assert.deepEqual(
        JSON.parse(JSON.stringify(placementAlternative[0].courses)),
        ['MATH 112', 'MATH 115', 'MATH 116'],
    );
    assert.equal(placementAlternative.length, 1);
    assert.equal(placementAlternative[0].type, 'or');
    assert.equal(placementAlternative[0].conditions[0].label, 'Placement exam');
    assert.equal(prereqs.groupIsMet(placementAlternative[0], new Set(['MATH 115'])), true);
    assert.equal(prereqs.evaluateGroups(placementAlternative, new Set()).eligible, true);
    assert.equal(prereqs.evaluateGroups(placementAlternative, new Set()).uncertain, true);
    assert.equal(prereqs.evaluateGroups(placementAlternative, new Set(['MATH 115'])).satisfied, true);
    assert.equal(mixedPlacement.length, 2);
    assert.ok(mixedPlacement.every(group => !(group.conditions || []).length));
    assert.match(placementTree, /Complete one/);
    assert.match(placementTree, /Placement exam/);
    assert.match(placementTree, /prereq-course-card condition/);
    assert.doesNotMatch(placementTree, /prereq-tree-branch-label">Required/);
    assert.doesNotMatch(source, /Prerequisite Status|Some prerequisites are missing|Required before this course/);
    assert.match(source, /\{ html: details\.corequisite, mode: 'corequisite' \}/);
    assert.match(source, /\{ html: details\.prerequisite_or_corequisite, mode: 'either' \}/);
    assert.match(source, /getElementById\('browse-close-details'\)\?\.focus\(\)/);
    assert.match(styles, /\.prereq-status-card\.missing/);
    assert.match(styles, /\.prereq-course-card\.target/);
    assert.match(styles, /\.prereq-course-card\.condition\s*{[^}]*border-color:\s*#f2c200;/s);
    assert.match(styles, /\.prereq-tree-groups/);
    assert.match(styles, /\.prereq-tree-branch\s*{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s);
    assert.match(styles, /\.prereq-tree-branch-drop\s*{[^}]*flex:\s*1 1 14px;[^}]*width:\s*2px;/s);
    assert.match(styles, /\.prereq-tree-connector\s*{[^}]*background:\s*#000000;[^}]*width:\s*2px;/s);
    assert.doesNotMatch(styles, /\.prereq-tree-connector\s*{[^}]*border-left:/s);
    assert.match(styles, /\.prereq-course-options\.alternatives\s*{[^}]*flex-direction:\s*column;[^}]*flex-wrap:\s*nowrap;/s);
    assert.match(styles, /\.prereq-course-options\.alternatives \.prereq-course-card\s*{[^}]*width:\s*min\(150px, 100%\);/s);

    const eligibleSearch = loadObject('static/js/search.js', 'Search', {
        Prereqs: prereqs,
        State: { completedCourses: ['MATH 115'] },
    });
    assert.equal(eligibleSearch.checkEligibility('MATH 141', {
        'MATH 141': { prereqs: placementAlternative[0].courses, groups: placementAlternative },
    }).eligible, true);
    const unknownSearch = loadObject('static/js/search.js', 'Search', {
        Prereqs: prereqs,
        State: { completedCourses: [] },
    });
    const unknownEligibility = unknownSearch.checkEligibility('MATH 141', {
        'MATH 141': { prereqs: placementAlternative[0].courses, groups: placementAlternative },
    });
    assert.equal(unknownEligibility.eligible, true);
    assert.equal(unknownEligibility.unknown, true);
    assert.deepEqual(JSON.parse(JSON.stringify(unknownEligibility.missing)), []);
});

test('browse filters separate primary and additional course choices', () => {
    const source = fs.readFileSync('static/index.html', 'utf8');
    const styles = fs.readFileSync('static/css/style.css', 'utf8');

    assert.match(source, /id="filter-show-all"/);
    assert.doesNotMatch(source, /id="filter-current-term"/);
    assert.match(source, /id="filter-method"/);
    assert.match(source, /id="filter-carolina-core"/);
    assert.match(source, /class="filter-primary-column filter-primary-checkboxes">[\s\S]*id="filter-show-all"[\s\S]*id="filter-open"[\s\S]*id="filter-eligible"[\s\S]*class="filter-primary-column filter-primary-selects">[\s\S]*id="filter-method"[\s\S]*id="filter-carolina-core"/);
    assert.match(source, /value="CMW"/);
    assert.match(source, /value="VSR"/);
    assert.match(source, /id="additional-filter-toggle"/);
    const additionalStart = source.indexOf('id="additional-filter-panel"');
    assert.ok(source.indexOf('id="filter-part-of-term"') > additionalStart);
    assert.ok(source.indexOf('id="filter-course-attribute"') > additionalStart);
    assert.ok(source.indexOf('id="filter-honors"') > additionalStart);
    assert.ok(source.indexOf('id="filter-meeting-pattern"') > additionalStart);
    assert.ok(source.indexOf('id="filter-size-mode"') > additionalStart);
    assert.ok(source.indexOf('id="filter-avail-mode"') > additionalStart);
    assert.ok(source.indexOf('id="btn-apply-filters"') > additionalStart);
    assert.ok(source.indexOf('id="btn-clear-filters"') > additionalStart);
    assert.match(styles, /\.filter-actions\s*{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s);
    assert.match(styles, /@container browse-sidebar \(max-width:\s*285px\)/);
    assert.match(styles, /\.filter-action-compact\s*{\s*display:\s*inline;/s);
});

test('clear filters resets browse controls and reapplies the search', () => {
    const checkboxes = [{ checked: true }, { checked: true }];
    const selects = [{ selectedIndex: 2 }, { selectedIndex: 1 }];
    const numbers = [{ value: '25' }, { value: '4' }];
    const search = loadObject('static/js/search.js', 'Search', {
        document: {
            querySelectorAll(selector) {
                if (selector.includes('checkbox')) return checkboxes;
                if (selector.includes('select')) return selects;
                if (selector.includes('number')) return numbers;
                return [];
            },
            getElementById(id) {
                return id === 'keyword-input' ? { value: 'CSCE' } : null;
            },
        },
    });
    let searches = 0;
    search.doSearch = () => { searches += 1; };

    search.clearFilters();

    assert.equal(checkboxes.every(input => input.checked === false), true);
    assert.equal(selects.every(select => select.selectedIndex === 0), true);
    assert.equal(numbers.every(input => input.value === ''), true);
    assert.equal(searches, 1);
});

test('instructional method and Carolina Core filters use section and bulletin data', async () => {
    const search = loadObject('static/js/search.js', 'Search', {
        API: {
            async bulletinSearch() {
                return { results: [{ code: 'ENGL 101', key: '3001' }] };
            },
            async bulletinDetails() {
                return { carolinacore: '<strong>Carolina Core:</strong> CMW, INF' };
            },
        },
    });
    const results = [
        { code: 'ENGL 101', crn: '10001', inst_mthd: 'Face-to-Face Instruction' },
        { code: 'TEST 101', crn: '10002', inst_mthd: '100% Web Asynchronous' },
    ];

    assert.equal(search.matchesInstructionalMethod(results[0], 'face-to-face'), true);
    assert.equal(search.matchesInstructionalMethod(results[1], 'online'), true);
    const coreResults = await search.filterByCarolinaCore(results, 'INF');
    assert.deepEqual(Array.from(coreResults, result => result.code), ['ENGL 101']);
});

test('meeting pattern stays separate from instructional method', () => {
    const search = loadObject('static/js/search.js', 'Search', {});
    const asynchronous = {
        inst_mthd: '100% Web Asynchronous',
        meetingTimes: '[]',
    };
    const twiceWeeklyOnline = {
        inst_mthd: 'Synchronous Web Instruction',
        meetingTimes: '[{"meet_day":"1"},{"meet_day":"3"}]',
    };

    assert.equal(search.matchesInstructionalMethod(asynchronous, 'online'), true);
    assert.equal(search.matchesMeetingPattern(asynchronous, 'unscheduled'), true);
    assert.equal(search.matchesInstructionalMethod(twiceWeeklyOnline, 'online'), true);
    assert.equal(search.matchesMeetingPattern(twiceWeeklyOnline, 'twice'), true);
    assert.equal(search.matchesMeetingPattern(twiceWeeklyOnline, 'unscheduled'), false);
    assert.equal(search.matchesMeetingPattern({ _isCatalog: true }, 'unscheduled'), false);
});

test('part-of-term, honors, and course-attribute filters recognize live values', () => {
    const search = loadObject('static/js/search.js', 'Search', {});

    assert.equal(search.matchesPartOfTerm('30 (30 - Columbia Full Term)', 'full'), true);
    assert.equal(search.matchesPartOfTerm('3A (3A - Columbia First Half Term)', 'first'), true);
    assert.equal(search.matchesPartOfTerm('3B (3B - Columbia Second Half Term)', 'second'), true);
    assert.equal(search.isHonorsSection({ code: 'SCHC 158', section: 'H01', title: 'HNRS: Rhetoric' }), true);
    assert.equal(search.isHonorsSection({ code: 'CSCE 145', section: '001', title: 'Algorithmic Design I' }), false);
    assert.equal(search.matchesCourseAttribute({
        experiential: '<strong>Experiential Learning:</strong> Experiential Learning Opportunity',
    }, 'elo'), true);
    assert.equal(search.matchesCourseAttribute({
        founding_documents: '<strong>Founding Documents:</strong> FND Founding Documents',
    }, 'founding'), true);
    assert.equal(search.matchesCourseAttribute({
        graduation: '<strong>Graduation with Leadership Distinction:</strong> GLD: Global Learning',
    }, 'gld-global'), true);
});

test('solver uses course-level choices instead of applied sections', async () => {
    let solvedCourses;
    let requestedResults;
    const state = {
        term: '202608',
        selectedCourses: {
            'TEST 101': {
                code: 'TEST 101',
                sections: [
                    { crn: '10101', stat: 'A', meetingTimes: '[]' },
                    { crn: '10102', stat: 'C', meetingTimes: '[]' },
                ],
            },
        },
        selectedSections: { 'TEST 101': { crn: 'old-section' } },
        sectionLocks: { 'TEST 101': '10102' },
        profile: { customCredits: { max: 18 } },
        getPreferences: () => ({}),
    };
    const container = { innerHTML: '', querySelectorAll: () => [] };
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {
        State: state,
        API: {
            async solve(courses, preferences, maxResults) {
                solvedCourses = courses;
                requestedResults = maxResults;
                return { total_found: 0, returned: 0, schedules: [] };
            },
        },
        document: { getElementById: () => container },
        alert() {},
    });

    await scheduler.solve(20);

    assert.equal(solvedCourses[0].code, 'TEST 101');
    assert.equal(solvedCourses[0].sections.length, 1);
    assert.equal(solvedCourses[0].sections[0].crn, '10102');
    assert.equal(requestedResults, 20);
    assert.equal(state.selectedSections['TEST 101'].crn, 'old-section');
});

test('schedule preferences expose one walking-aware transition choice', () => {
    const state = loadObject('static/js/state.js', 'State', {
        localStorage: { getItem: () => null },
    });
    assert.equal(state.getPreferences().minimum_walking_buffer_minutes, 1);
    state.avoidedDays = [1, 3];
    state.avoidedTimeBlocks = [{ day: 2, start: 1030, end: 1100 }];
    state.minimumWalkingBuffer = 5;
    state.timePreferencesRequired = true;
    state.walkingBufferRequired = true;
    state.avoidedDaysRequired = true;

    const preferences = state.getPreferences();

    assert.deepEqual(Array.from(preferences.avoided_days), [1, 3]);
    assert.deepEqual(Array.from(preferences.avoided_time_blocks, block => ({ ...block })), [
        { day: 2, start: 1030, end: 1100 },
    ]);
    assert.equal(preferences.minimum_walking_buffer_minutes, 5);
    assert.equal(preferences.time_preferences_required, true);
    assert.equal(preferences.walking_buffer_required, true);
    assert.equal(preferences.avoided_days_required, true);
    assert.equal(preferences.minimum_transition_minutes, undefined);
    assert.equal(preferences.preferred_maximum_walk_minutes, undefined);

    const source = fs.readFileSync('static/js/scheduler.js', 'utf8');
    const styles = fs.readFileSync('static/css/style.css', 'utf8');
    assert.match(source, /class="schedule-preference-times"/);
    assert.match(source, /id="schedule-preferred-start"/);
    assert.match(source, /id="schedule-preferred-end"/);
    assert.match(source, /id="btn-advanced-time-avoidance"/);
    assert.match(source, /id="schedule-advanced-calendar"/);
    assert.match(source, /buildAdvancedTimeAvoidance/);
    assert.match(source, /State\.avoidedTimeBlocks/);
    assert.match(source, /id="schedule-minimum-walking-buffer"/);
    assert.match(source, /modeControl\('schedule-time-mode-required'/);
    assert.match(source, /modeControl\('schedule-walking-mode-required'/);
    assert.match(source, /modeControl\('schedule-days-mode-required'/);
    assert.match(source, />PREFER<\/span><span class="require">REQUIRE</);
    assert.doesNotMatch(source, /class="schedule-preference-legend"/);
    assert.doesNotMatch(source, /How to apply/);
    assert.doesNotMatch(source, /when possible/i);
    assert.match(source, /Extra time after walking between classes/);
    assert.match(source, /Choose 10 to arrive at least ten minutes early/);
    assert.doesNotMatch(source, /Minutes remaining after travel/);
    assert.doesNotMatch(source, /id="schedule-minimum-buffer"/);
    assert.doesNotMatch(source, /id="schedule-preferred-maximum-walk"/);
    assert.match(source, /min="1"/);
    assert.match(styles, /input:checked \+ \.schedule-preference-mode-track \.require\s*{[^}]*background:\s*#000000;/s);
    assert.match(styles, /\.schedule-preference-mode\s*{[^}]*top:\s*-14px;[^}]*transform:\s*translateY\(-50%\);/s);
    assert.match(styles, /\.schedule-advanced-calendar\s*{[^}]*grid-auto-rows:\s*16px;[^}]*grid-template-rows:\s*auto;[^}]*row-gap:\s*0;/s);
    assert.match(styles, /\.schedule-advanced-cell:nth-child\(16n \+ 18\)[\s\S]*\.schedule-advanced-cell:nth-child\(16n \+ 24\)/);
    assert.doesNotMatch(styles, /\.schedule-advanced-cell:nth-child\(16n \+ 10\)/);
    assert.doesNotMatch(styles, /schedule-preference-mode[^}]*#73000A/s);
});

test('saving schedule preferences preserves each prefer-require mode', () => {
    const elements = {
        'schedule-preferred-start': { value: '08:00' },
        'schedule-preferred-end': { value: '21:00' },
        'schedule-minimum-walking-buffer': { value: '10' },
        'schedule-time-mode-required': { checked: true },
        'schedule-walking-mode-required': { checked: false },
        'schedule-days-mode-required': { checked: true },
        'schedule-preferences-error': { textContent: '' },
        'modal-overlay': { classList: { add() {} } },
    };
    let emitted = false;
    let modalClosed = false;
    const state = { emit() { emitted = true; } };
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {
        State: state,
        window: { AppModal: { close() { modalClosed = true; } } },
        document: {
            getElementById: id => elements[id],
            querySelectorAll(selector) {
                if (selector.includes('schedule-avoid-day')) return [{ value: '1' }];
                if (selector.includes('schedule-advanced-cell')) {
                    return [{ dataset: { day: '2', start: '1030', end: '1100' } }];
                }
                return [];
            },
        },
    });

    assert.equal(scheduler.saveSchedulePreferences(), true);
    assert.equal(state.timePreferencesRequired, true);
    assert.equal(state.walkingBufferRequired, false);
    assert.equal(state.avoidedDaysRequired, true);
    assert.deepEqual(Array.from(state.avoidedDays), [1]);
    assert.equal(emitted, true);
    assert.equal(modalClosed, true);
});

test('schedule actions live in the options panel and quick ICS export is removed', () => {
    const source = fs.readFileSync('static/index.html', 'utf8');
    const styles = fs.readFileSync('static/css/style.css', 'utf8');
    const optionsStart = source.indexOf('<section id="solver-section">');
    const optionsEnd = source.indexOf('<div id="solver-container">', optionsStart);
    const optionsHeading = source.slice(optionsStart, optionsEnd);

    assert.match(optionsHeading, /id="btn-schedule-preferences"/);
    assert.match(optionsHeading, /id="btn-schedule-preferences"[^>]*aria-label="Schedule preferences"[^>]*title="Schedule preferences"[^>]*aria-haspopup="dialog"[^>]*aria-controls="modal"/);
    assert.match(optionsHeading, /id="btn-schedule-preferences"[\s\S]*?<span class="filter-sliders-icon" aria-hidden="true">/);
    assert.doesNotMatch(optionsHeading, />PREFERENCES<\/button>/);
    assert.match(optionsHeading, /id="btn-solve"/);
    assert.match(optionsHeading, /id="btn-solve"[^>]*aria-label="Generate schedules"[^>]*title="Generate schedules"/);
    assert.match(optionsHeading, /class="schedule-action-label-wide" aria-hidden="true">GENERATE SCHEDULES/);
    assert.match(optionsHeading, /class="schedule-action-label-compact" aria-hidden="true">GENERATE/);
    assert.match(optionsHeading, /id="btn-registration-info"[^>]*aria-label="Registration info"[^>]*title="Registration info"[^>]*disabled/);
    assert.match(optionsHeading, /class="schedule-action-label-wide" aria-hidden="true">REGISTRATION INFO/);
    assert.match(optionsHeading, /class="schedule-action-label-compact" aria-hidden="true">REGISTER/);
    assert.match(optionsHeading, /<div class="schedule-panel-heading">\s*<h3>Schedule Options<\/h3>\s*<\/div>\s*<div class="schedule-panel-actions">/);
    assert.ok(optionsHeading.indexOf('id="btn-solve"') < optionsHeading.indexOf('id="btn-schedule-preferences"'));
    assert.doesNotMatch(source, /id="btn-export-quick"/);
    assert.match(source, /class="schedule-selected-section"/);
    assert.match(styles, /#modal-overlay\s*{[^}]*z-index:\s*5000;/s);
    assert.match(styles, /#solver-section\s*{[^}]*display:\s*flex;[^}]*overflow:\s*hidden;/s);
    assert.match(styles, /#solver-container\s*{[^}]*flex:\s*1 1 auto;[^}]*overflow-y:\s*auto;/s);
    assert.match(styles, /\.schedule-panel-heading\s*{[^}]*position:\s*sticky;/s);
    assert.match(styles, /#solver-section\s*{[^}]*container-name:\s*schedule-options;[^}]*container-type:\s*inline-size;/s);
    assert.match(styles, /@container schedule-options \(max-width:\s*390px\)[\s\S]*\.schedule-action-label-wide\s*{\s*display:\s*none;\s*}[\s\S]*\.schedule-action-label-compact\s*{\s*display:\s*inline;/);
    assert.match(styles, /\.schedule-preferences-button\s*{[^}]*display:\s*flex;[^}]*height:\s*28px;[^}]*width:\s*32px;/s);
    assert.doesNotMatch(fs.readFileSync('static/js/scheduler.js', 'utf8'), /Avoid-day and time choices improve ranking/);
});

test('navigation is centered inside the single garnet header', () => {
    const html = fs.readFileSync('static/index.html', 'utf8');
    const styles = fs.readFileSync('static/css/style.css', 'utf8');
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

test('registration info unlocks for selected sections and links to the CRN cart', () => {
    const source = fs.readFileSync('static/js/scheduler.js', 'utf8');
    const html = fs.readFileSync('static/index.html', 'utf8');
    const styles = fs.readFileSync('static/css/style.css', 'utf8');

    assert.match(html, /id="btn-registration-info"[^>]*aria-label="Registration info"[^>]*disabled>[\s\S]*schedule-action-label-wide[^>]*>REGISTRATION INFO/);
    assert.match(source, /button\.disabled = this\.registrationSections\(\)\.length === 0;/);
    assert.match(source, /data-registration-copy="\$\{this\.escapeHtml\(section\.crn\)\}">COPY CRN/);
    assert.match(source, /copyRegistrationCrn\(section, button, copyStatus\)/);
    assert.doesNotMatch(source, /COPY CRNs/);
    assert.match(source, /data-registration-seats/);
    assert.match(source, /data-registration-requirements/);
    assert.match(source, /bulletin\.prereq/);
    assert.match(source, /details\.section_coreqs/);
    assert.match(source, /registration_restrictions/);
    assert.match(source, /full — planning only/i);
    assert.match(source, /data-registration-expand/);
    assert.match(source, /data-registration-details hidden/);
    assert.match(source, /data-registration-warning/);
    assert.match(source, /registrationRequirementSatisfied/);
    assert.doesNotMatch(source, /This planner cannot verify registration eligibility/);
    assert.doesNotMatch(source, /READY TO REGISTER/);
    assert.doesNotMatch(source, /termLabel/);
    assert.doesNotMatch(source, /value \|\| 'None listed'/);
    assert.doesNotMatch(source, /showWhenEmpty/);
    assert.match(source, /registrationRestrictionText\(details\.registration_restrictions\)/);
    assert.doesNotMatch(source, /data-registration-schedule/);
    assert.doesNotMatch(source, /data-registration-status/);
    assert.doesNotMatch(source, /data-registration-term|PART OF TERM|part_of_term/);
    assert.match(source, /banner\.onecarolina\.sc\.edu\/StudentRegistrationSsb\/ssb\/classRegistration\/classRegistration#" target="_blank"/);
    assert.match(styles, /\.btn-panel-registration\s*{[^}]*margin-left:\s*auto;/s);
    assert.match(styles, /\.btn-panel-registration:disabled\s*{[^}]*background:\s*#C7C7C7;/s);
    assert.match(styles, /\.registration-copy-crn\s*{[^}]*width:\s*84px;/s);
    assert.match(styles, /\.registration-course-details\[hidden\]\s*{[^}]*display:\s*none;/s);
    assert.match(styles, /\.registration-warning-icon::after\s*{[^}]*background:\s*#FFEB66;/s);
    assert.match(styles, /clip-path:\s*polygon\(50% 0, 100% 100%, 0 100%\)/);
    assert.match(styles, /\.registration-course-card\s*{\s*border:\s*1px solid #A2A2A2;\s*padding:/s);
    assert.doesNotMatch(styles, /\.registration-course-card\s*{[^}]*border-left:/s);
    assert.match(styles, /\.registration-requirements p\.attention\s*{[^}]*border-left:\s*4px solid #CC2E40;/s);
    assert.match(source, /requirementList\.closest\('\.registration-requirements'\)\.hidden = !requirements\.html;/);
    assert.match(source, /querySelectorAll\('\[data-registration-expand\]\[aria-expanded="true"\]'\)/);
    assert.match(source, /otherDetails\.hidden = true/);
});

test('course and registration dialogs close when the backdrop is pressed', () => {
    const html = fs.readFileSync('static/index.html', 'utf8');

    assert.match(html, /window\.AppModal = \{/);
    assert.match(html, /modalOverlay\.addEventListener\('click'/);
    assert.match(html, /if \(event\.target === modalOverlay\) closeModal\(\);/);
    assert.match(html, /if \(event\.key === 'Escape'\)/);
    assert.match(html, /modal\.classList\.remove\(\.\.\.modalClasses\)/);
    assert.match(html, /requestAnimationFrame\(\(\) => restore\?\.isConnected && restore\.focus\(\)\)/);
});

test('registration prerequisite warnings account for completed alternatives', () => {
    const state = { profile: { majorData: { major: 'Mechanical Engineering' } } };
    const prereqs = loadObject('static/js/prereqs.js', 'Prereqs', {});
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', { State: state, Prereqs: prereqs });
    scheduler.stripHtml = value => String(value || '');

    assert.equal(
        scheduler.registrationRequirementSatisfied(
            'D or better in EMCH 260 or ENCP 260.',
            new Set(['EMCH 260']),
        ),
        true,
    );
    assert.equal(
        scheduler.registrationRequirementSatisfied(
            'C or better in MATH 112, MATH 115, MATH 116, or through placement exam.',
            new Set(['MATH 115']),
        ),
        true,
    );
    assert.equal(
        scheduler.registrationRequirementSatisfied(
            'C or better in MATH 112, MATH 115, MATH 116, or through placement exam.',
            new Set(),
        ),
        false,
    );
    assert.equal(
        scheduler.registrationRequirementSatisfied(
            'MATH 242; C or better in EMCH 200 or ENCP 200.',
            new Set(['MATH 242']),
        ),
        false,
    );
    assert.equal(
        scheduler.registrationRequirementSatisfied(
            'MATH 242; C or better in EMCH 200 or ENCP 200.',
            new Set(['MATH 242', 'ENCP 200']),
        ),
        true,
    );
    assert.equal(
        scheduler.registrationRestrictionNeedsAttention(
            'Enrollment limited to students in the Mechanical Engineering Major.',
        ),
        false,
    );
    assert.equal(
        scheduler.registrationRestrictionNeedsAttention(
            'Enrollment limited to students in the Nursing Major.',
        ),
        true,
    );
    assert.equal(
        scheduler.registrationRestrictionText(
            'Enrollment limited to students in the Mechanical Engineering Major. Enrollment limited to students in the USC Columbia campus.',
        ),
        'Enrollment limited to students in the Mechanical Engineering Major.',
    );
    assert.equal(
        scheduler.registrationRestrictionText(
            'Enrollment limited to students in the USC Columbia campus.',
        ),
        '',
    );
});

test('registration info omits cross-listed course information', () => {
    const source = fs.readFileSync('static/js/scheduler.js', 'utf8');

    assert.doesNotMatch(source, /Cross-listed sections/);
    assert.doesNotMatch(source, /details\.xlist/);
    assert.doesNotMatch(source, /bulletin\.crosslisted/);
});

test('course results remain visible with useful empty states', () => {
    const results = { innerHTML: '', querySelector: () => null };
    const input = { value: '' };
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {
        document: {
            getElementById(id) {
                if (id === 'schedule-search-results') return results;
                if (id === 'schedule-course-input') return input;
                return null;
            },
        },
    });

    scheduler.renderCourseSearchResults();
    assert.match(results.innerHTML, /Use the Search tab for the full search experience/);

    input.value = 'NO MATCH';
    scheduler.renderCourseSearchResults();
    assert.match(results.innerHTML, /No direct matches/);
    assert.match(results.innerHTML, /Search tab for broader results/);
});

test('schedule search results use compact availability summaries', () => {
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {});
    const open = scheduler.scheduleCourseAvailability({
        sections: [
            { crn: '1', stat: 'A' },
            { crn: '2', stat: 'C' },
            { crn: '3', stat: 'C' },
        ],
    });
    const full = scheduler.scheduleCourseAvailability({
        sections: Array.from({ length: 18 }, (_, index) => ({ crn: String(index + 1), stat: 'C' })),
    });
    const unavailable = scheduler.scheduleCourseAvailability({
        sections: [{ _isCatalog: true }],
    });

    assert.equal(open.kind, 'open');
    assert.equal(open.text, '1 of 3 open');
    assert.equal(full.kind, 'full');
    assert.equal(full.text, 'All 18 are full');
    assert.equal(unavailable.kind, 'unavailable');
    assert.equal(unavailable.text, 'Not offered');
});

test('schedule result cards use fixed add-remove buttons and truncating text', () => {
    const source = fs.readFileSync('static/js/scheduler.js', 'utf8');
    const styles = fs.readFileSync('static/css/style.css', 'utf8');

    assert.match(source, /selected \? 'btn-danger added' : 'btn-green'/);
    assert.match(source, /selected \? 'REMOVE' : 'ADD'/);
    assert.match(styles, /\.schedule-search-course \.schedule-course-add\s*{[^}]*flex:\s*0 0 68px;[^}]*height:\s*30px;[^}]*width:\s*68px;/s);
    assert.match(styles, /\.schedule-search-course \.schedule-course-add\.added\s*{[^}]*background:\s*#c62828;/s);
    assert.match(styles, /\.schedule-search-course-copy span\s*{[^}]*text-overflow:\s*ellipsis;/s);
    assert.match(styles, /\.schedule-course-availability\.open\s*{\s*color:\s*#2e7d32;/s);
    assert.match(styles, /\.schedule-course-availability\.full\s*{\s*color:\s*#c62828;/s);
    assert.doesNotMatch(styles, /\.schedule-search-course\.selected\s*{[^}]*border-left:/s);
});

test('schedule course cards open a visual quick view without hijacking add-remove', () => {
    const source = fs.readFileSync('static/js/scheduler.js', 'utf8');
    const api = fs.readFileSync('static/js/api.js', 'utf8');
    const styles = fs.readFileSync('static/css/style.css', 'utf8');

    assert.match(source, /courseCopy\.addEventListener\('click', \(\) => this\.openCourseQuickView\(group\)\)/);
    assert.match(source, /id="btn-quick-course-toggle"/);
    assert.match(source, /id="btn-quick-view-browse"/);
    assert.match(source, /const button = event\.currentTarget;/);
    assert.match(source, /button\.textContent = State\.isCourseSelected\(group\.code\) \? 'REMOVE' : 'ADD TO SCHEDULE';/);
    assert.match(source, /button\.className = State\.isCourseSelected\(group\.code\) \? 'btn-danger' : 'btn-green';/);
    assert.match(source, /quick-grade-strip/);
    assert.match(source, /quick-frequency-ring/);
    assert.match(source, /API\.getFaculty\(State\.term, facultyCrns\)/);
    assert.match(source, /href="mailto:\$\{this\.escapeHtml\(instructor\.email\)\}"/);
    assert.match(source, /data-quick-instructor-index="\$\{index\}"/);
    assert.match(source, /VIEW DETAILS FOR SECTION \$\{this\.escapeHtml\(selectedSection\.section/);
    assert.match(source, /Offered in \$\{frequency\}% of recent terms/);
    assert.match(source, /Last offered \$\{offering\.last_offered_label\}/);
    assert.match(source, /const detailsPromise =/);
    assert.match(source, /const gradesPromise = API\.getCourseGrades\(group\.code\)/);
    assert.match(source, /this\.renderCourseQuickView\(\s*group,\s*\{\},\s*\{\},\s*\{\},\s*true,/s);
    assert.match(source, /gradesPromise\s*\.then\(result =>/);
    assert.match(source, /this\.updateQuickGrades\(gradeData\)/);
    assert.doesNotMatch(source, /await Promise\.allSettled\(\[API\.getCourseGrades\(group\.code\)\]\)/);
    assert.match(source, /detailsPromise\s*\.then\(details =>/);
    assert.match(api, /async getCourseGrades\(code\)/);
    assert.match(api, /async getFaculty\(term, crns\)/);
    assert.match(styles, /#modal\.course-quick-modal\s*{[^}]*max-width:\s*780px;/s);
    assert.match(styles, /\.quick-instructor-grid\s*{[^}]*grid-template-columns:\s*repeat\(2,/s);
    assert.match(styles, /\.quick-instructor-card small\s*{[^}]*font-size:\s*0\.7rem;/s);
});

test('quick instructor profiles open Search at the same course and section before showing the professor', async () => {
    const calls = [];
    const appModal = { close() { calls.push(['close']); } };
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {
        window: { AppModal: appModal },
        AppModal: appModal,
        Tabs: { switchTo(tab) { calls.push(['tab', tab]); } },
        Search: {
            async openCourseFromExternal(group, crn) {
                calls.push(['course', group.code, crn]);
            },
        },
        Grades: {
            async showProfessorForCourseName(code, name, email, professorId) {
                calls.push(['professor', code, name, email, professorId]);
            },
        },
    });

    await scheduler.openProfessorInBrowse(
        { code: 'EMCH 741' },
        '23800',
        {
            displayName: 'Ling, Yue',
            email: 'stanley_ling@sc.edu',
            professorId: 'prof_ling',
        },
    );

    assert.deepEqual(calls, [
        ['close'],
        ['tab', 'semester'],
        ['course', 'EMCH 741', '23800'],
        ['professor', 'EMCH 741', 'Ling, Yue', 'stanley_ling@sc.edu', 'prof_ling'],
    ]);
});

test('quick view compares grades only for instructors teaching the current term', () => {
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {});
    const summaries = scheduler.currentInstructorSummaries({
        sections: [
            { crn: '1', instr: 'Kanapala, Neema', stat: 'A' },
            { crn: '2', instr: 'Kanapala, Neema', stat: 'C' },
            { crn: '3', instr: 'Hoskins, William', stat: 'A' },
            { crn: '4', instr: 'Staff', stat: 'A' },
        ],
    }, {
        instructors: [
            { name: 'Kanapala, Neema', average_gpa: 3.04 },
            { name: 'Shepherd, Jeremiah', average_gpa: 3.01 },
        ],
    });

    assert.equal(summaries.length, 2);
    assert.equal(summaries[0].name, 'Kanapala, Neema');
    assert.equal(summaries[0].sections, 2);
    assert.equal(summaries[0].open, 1);
    assert.equal(summaries[0].grade.average_gpa, 3.04);
    assert.equal(summaries[1].name, 'Hoskins, William');
    assert.equal(summaries[1].grade, null);
});

test('current faculty records replace surname-only labels and add email', () => {
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {});
    const summaries = scheduler.currentInstructorSummaries({
        sections: [
            { crn: '10868', instr: 'Kanapala', stat: 'A' },
            { crn: '16759', instr: 'Kanapala', stat: 'A' },
            { crn: '10869', instr: 'Kanapala', stat: 'C' },
        ],
    }, {
        instructors: [
            { name: 'Kanapala, Neema', average_gpa: 3.04, graded_students: 1149 },
        ],
    }, [
        { crn: '10868', name: 'Kanapala, Neema', email: 'neema@cse.sc.edu' },
        { crn: '16759', name: 'Kanapala, Neema', email: 'neema@cse.sc.edu' },
    ]);

    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].displayName, 'Kanapala, Neema');
    assert.equal(summaries[0].email, 'neema@cse.sc.edu');
    assert.equal(summaries[0].sections, 3);
    assert.equal(summaries[0].open, 2);
    assert.equal(summaries[0].grade.average_gpa, 3.04);
});

test('current faculty records prefer stable professor IDs over duplicate names', () => {
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {});
    const summaries = scheduler.currentInstructorSummaries({
        sections: [{ crn: '70501', instr: 'Johnson, Rhonda', stat: 'A' }],
    }, {
        instructors: [
            { id: 'prof_other', name: 'Johnson, Rhonda', average_gpa: 2.4 },
            { id: 'prof_selected', name: 'Johnson, Rhonda', average_gpa: 3.6 },
        ],
    }, [
        { crn: '70501', professor_id: 'prof_selected', name: 'Johnson, Rhonda', email: 'rhonda@sc.edu' },
    ]);

    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].professorId, 'prof_selected');
    assert.equal(summaries[0].grade.id, 'prof_selected');
    assert.equal(summaries[0].grade.average_gpa, 3.6);
});

test('stable professor IDs never fall back to a different same-name record', () => {
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {});
    const summaries = scheduler.currentInstructorSummaries({
        sections: [{ crn: '70501', instr: 'Johnson, Rhonda', stat: 'A' }],
    }, {
        instructors: [
            { id: 'prof_other', name: 'Johnson, Rhonda', average_gpa: 2.4 },
        ],
    }, [
        { crn: '70501', professor_id: 'prof_current', name: 'Johnson, Rhonda' },
    ]);

    assert.equal(summaries[0].professorId, 'prof_current');
    assert.equal(summaries[0].grade, null);
    assert.equal(summaries[0].matchStatus, 'unmatched');
});

test('current faculty deduplicates mixed email records and refuses ambiguous name matches', () => {
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {});
    const deduplicated = scheduler.currentInstructorSummaries({
        sections: [
            { crn: '1', instr: 'Hoskins, William', stat: 'A' },
            { crn: '2', instr: 'Hoskins, William', stat: 'A' },
        ],
    }, { instructors: [] }, [
        { crn: '1', name: 'Hoskins, William', email: '' },
        { crn: '2', name: 'Hoskins, William', email: 'hoskinsw@cec.sc.edu' },
    ]);
    const ambiguous = scheduler.currentInstructorSummaries({
        sections: [{ crn: '3', instr: 'Nichols, Hannah', stat: 'A' }],
    }, {
        instructors: [
            { id: 'prof_one', name: 'Nichols, Hannah', average_gpa: 3.1 },
            { id: 'prof_two', name: 'Nichols, Hannah', average_gpa: 3.8 },
        ],
    });

    assert.equal(deduplicated.length, 1);
    assert.equal(deduplicated[0].sections, 2);
    assert.equal(deduplicated[0].email, 'hoskinsw@cec.sc.edu');
    assert.equal(ambiguous[0].grade, null);
    assert.equal(ambiguous[0].matchStatus, 'ambiguous');
});

test('quick view grade diagram groups outcomes into readable bands', () => {
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {});
    const buckets = scheduler.gradeBuckets({
        grade_counts: { A: 50, 'B+': 10, B: 20, 'C+': 5, C: 5, 'D+': 2, D: 3, F: 5, FN: 0 },
    });

    assert.deepEqual(Array.from(buckets, bucket => bucket.label), ['A', 'B', 'C', 'D / F']);
    assert.deepEqual(Array.from(buckets, bucket => bucket.percent), [50, 30, 10, 10]);
});

test('course results divider is adjustable while preserving selected-course space', () => {
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {});
    const source = fs.readFileSync('static/index.html', 'utf8');
    const styles = fs.readFileSync('static/css/style.css', 'utf8');

    const balanced = scheduler.fitCoursePanelSizes(300, 600);
    const clamped = scheduler.fitCoursePanelSizes(500, 600);
    assert.equal(balanced.results, 300);
    assert.equal(balanced.selected, 300);
    assert.equal(clamped.results, 410);
    assert.equal(clamped.selected, 190);
    assert.match(source, /id="schedule-course-divider"[^>]*role="separator"/);
    assert.match(styles, /\.schedule-course-divider\s*{[^}]*cursor:\s*row-resize;/s);
});

test('course results divider starts near the middle and repairs the legacy tiny default', () => {
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {});

    assert.equal(scheduler.initialCourseResultsHeight(null, 600), 300);
    assert.equal(scheduler.initialCourseResultsHeight({ resultsHeight: 170 }, 600), 300);
    assert.equal(scheduler.initialCourseResultsHeight({ resultsHeight: 95 }, 600), 300);
    assert.equal(scheduler.initialCourseResultsHeight({ resultsHeight: 280 }, 600), 280);
    assert.equal(scheduler.initialCourseResultsHeight({
        version: 2,
        resultsHeight: 220,
        resultsRatio: 0.4,
    }, 800), 320);
});

test('schedule results offer ten more ranked options when more are available', () => {
    const listeners = {};
    const showMore = {
        dataset: { nextLimit: '20' },
        addEventListener(type, listener) { listeners[type] = listener; },
    };
    const container = {
        innerHTML: '',
        querySelector(selector) { return selector === '.btn-show-more' ? showMore : null; },
        querySelectorAll() { return []; },
    };
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {
        State: { selectedSections: {}, sectionLocks: {}, solverResults: [] },
    });
    let requestedResults;
    scheduler.solve = maxResults => { requestedResults = maxResults; };

    scheduler.renderResults({
        total_found: 30,
        returned: 10,
        schedules: [{ sections: { 'TEST 101': { crn: '10101', section: '001' } } }],
    }, container);

    assert.match(container.innerHTML, /SHOW 10 MORE/);
    listeners.click();
    assert.equal(requestedResults, 20);
});

test('schedule splitter keeps both panels in bounds and snaps either panel fully closed', () => {
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {});

    const balanced = scheduler.fitPanelSizes(300, 700);
    const mapOnly = scheduler.fitPanelSizes(20, 700);
    const calendarOnly = scheduler.fitPanelSizes(680, 700);

    assert.equal(balanced.workspace + balanced.map, 700);
    assert.equal(mapOnly.workspace, 0);
    assert.equal(mapOnly.map, 700);
    assert.equal(calendarOnly.workspace, 700);
    assert.equal(calendarOnly.map, 0);
});

test('schedule workspace remains split and contained on narrower desktop screens', () => {
    const styles = fs.readFileSync('static/css/style.css', 'utf8');

    assert.match(styles, /\.schedule-workspace\s*{[^}]*grid-template-columns:\s*minmax\(220px, 0\.68fr\) minmax\(0, 1\.5fr\);/s);
    assert.match(styles, /@media \(max-width:\s*1100px\)[\s\S]*\.schedule-workspace\s*{[^}]*grid-template-columns:\s*minmax\(210px, 0\.68fr\) minmax\(0, 1\.35fr\);/);
    assert.match(styles, /@media \(max-width:\s*1100px\)[\s\S]*\.schedule-vertical-resizer\s*{\s*display:\s*flex;/);
    assert.match(styles, /#calendar-container\s*{[^}]*max-width:\s*100%;[^}]*overflow:\s*auto;[^}]*width:\s*100%;/s);
    assert.match(styles, /\.sched-course\s*{[^}]*background:\s*transparent;/s);
});

test('schedule map divider is centered between the calendar and map', () => {
    const styles = fs.readFileSync('static/css/style.css', 'utf8');
    const rule = styles.match(/\.schedule-vertical-resizer\s*\{([^}]*)\}/)?.[1] || '';

    assert.match(rule, /align-self:\s*center;/);
    assert.match(rule, /margin:\s*-7px auto;/);
    assert.match(rule, /width:\s*calc\(100%\s*-\s*20px\);/);
    assert.match(rule, /justify-content:\s*center;/);
});

test('schedule course tools have an accessible persistent collapse rail', () => {
    const source = fs.readFileSync('static/index.html', 'utf8');
    const styles = fs.readFileSync('static/css/style.css', 'utf8');
    const asideStart = source.indexOf('<aside id="schedule-sidebar">');
    const aside = source.slice(asideStart, source.indexOf('</aside>', asideStart));

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

test('schedule course tools collapse, restore, persist, and resize the map', () => {
    const classes = new Set();
    const attributes = { 'aria-expanded': 'true' };
    const listeners = {};
    const layout = {
        classList: {
            toggle(name, enabled) {
                if (enabled) classes.add(name);
                else classes.delete(name);
            },
        },
    };
    const sidebar = {
        style: { width: '340px' },
        getBoundingClientRect() { return { width: 340 }; },
        setAttribute(name, value) { this[name] = value; },
    };
    const button = {
        dataset: {},
        title: '',
        addEventListener(type, listener) { listeners[type] = listener; },
        getAttribute(name) { return attributes[name]; },
        setAttribute(name, value) { attributes[name] = value; },
    };
    const values = new Map();
    const localStorage = {
        getItem(key) { return values.get(key) || null; },
        setItem(key, value) { values.set(key, value); },
    };
    let mapInvalidations = 0;
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {
        document: {
            getElementById(id) {
                return {
                    'btn-toggle-schedule-sidebar': button,
                    'schedule-sidebar': sidebar,
                }[id] || null;
            },
            querySelector(selector) {
                return selector === '#tab-schedule .schedule-layout' ? layout : null;
            },
        },
        localStorage,
        requestAnimationFrame(callback) { callback(); },
        WalkingMap: { _map: { invalidateSize() { mapInvalidations += 1; } } },
    });

    scheduler.initScheduleSidebarCollapse();
    assert.equal(classes.has('schedule-sidebar-collapsed'), false);
    assert.equal(attributes['aria-expanded'], 'true');
    assert.equal(sidebar['aria-hidden'], 'false');

    button.dataset.ignoreNextClick = 'true';
    listeners.click();
    assert.equal(classes.has('schedule-sidebar-collapsed'), false);
    assert.equal(button.dataset.ignoreNextClick, undefined);

    listeners.click();
    assert.equal(classes.has('schedule-sidebar-collapsed'), true);
    assert.equal(attributes['aria-expanded'], 'false');
    assert.equal(sidebar['aria-hidden'], 'true');
    assert.equal(values.get('uofsc-schedule-sidebar-collapsed-v1'), 'true');

    listeners.click();
    assert.equal(classes.has('schedule-sidebar-collapsed'), false);
    assert.equal(attributes['aria-expanded'], 'true');
    assert.equal(sidebar['aria-hidden'], 'false');
    assert.equal(values.get('uofsc-schedule-sidebar-collapsed-v1'), 'false');
    assert.equal(mapInvalidations, 3);
});

test('schedule course tools resize from the rail or arrow and snap closed below 160 pixels', () => {
    const layoutClasses = new Set();
    const handleClasses = new Set();
    const bodyClasses = new Set();
    const handleListeners = {};
    const buttonListeners = {};
    const documentListeners = {};
    const scheduledTimers = [];
    const values = new Map([['uofsc-schedule-sidebar-width-v1', '320']]);
    const attributes = { 'aria-expanded': 'true' };
    const layout = {
        classList: {
            contains(name) { return layoutClasses.has(name); },
            toggle(name, enabled) {
                if (enabled) layoutClasses.add(name);
                else layoutClasses.delete(name);
            },
        },
        getBoundingClientRect() { return { width: 1000 }; },
    };
    const sidebarProperties = new Map();
    const sidebar = {
        style: {
            setProperty(name, value) { sidebarProperties.set(name, value); },
        },
        getBoundingClientRect() {
            return {
                width: Number.parseFloat(sidebarProperties.get('--schedule-sidebar-width')) || 340,
            };
        },
        setAttribute(name, value) { this[name] = value; },
    };
    const handle = {
        classList: {
            add(name) { handleClasses.add(name); },
            remove(name) { handleClasses.delete(name); },
        },
        addEventListener(type, listener) { handleListeners[type] = listener; },
        setAttribute(name, value) { this[name] = value; },
    };
    const button = {
        dataset: {},
        title: '',
        addEventListener(type, listener) { buttonListeners[type] = listener; },
        getAttribute(name) { return attributes[name]; },
        setAttribute(name, value) { attributes[name] = value; },
    };
    const localStorage = {
        getItem(key) { return values.get(key) || null; },
        setItem(key, value) { values.set(key, value); },
    };
    const document = {
        body: {
            classList: {
                add(name) { bodyClasses.add(name); },
                remove(name) { bodyClasses.delete(name); },
            },
        },
        addEventListener(type, listener) { documentListeners[type] = listener; },
        removeEventListener(type) { delete documentListeners[type]; },
        getElementById(id) {
            return {
                'btn-toggle-schedule-sidebar': button,
                'schedule-sidebar': sidebar,
                'schedule-sidebar-resize-handle': handle,
            }[id] || null;
        },
        querySelector(selector) {
            return selector === '#tab-schedule .schedule-layout' ? layout : null;
        },
    };
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {
        document,
        localStorage,
        requestAnimationFrame(callback) { callback(); },
        WalkingMap: { _map: { invalidateSize() {} } },
        window: {
            innerWidth: 1200,
            addEventListener() {},
            setTimeout(callback) { scheduledTimers.push(callback); },
        },
    });

    scheduler.initScheduleSidebarResize();
    assert.equal(sidebarProperties.get('--schedule-sidebar-width'), '320px');
    assert.equal(handle['aria-valuenow'], '320');

    handleListeners.pointerdown({ clientX: 320, preventDefault() {} });
    assert.equal(handleClasses.has('active'), true);
    assert.equal(bodyClasses.has('resizing-schedule-sidebar'), true);

    documentListeners.pointermove({ clientX: 300 });
    assert.equal(layoutClasses.has('schedule-sidebar-collapsed'), false);
    assert.equal(sidebarProperties.get('--schedule-sidebar-width'), '300px');

    documentListeners.pointermove({ clientX: 159 });
    assert.equal(documentListeners.pointerup, undefined);
    assert.equal(values.get('uofsc-schedule-sidebar-width-v1'), '300');
    assert.equal(values.get('uofsc-schedule-sidebar-collapsed-v1'), 'true');
    assert.equal(layoutClasses.has('schedule-sidebar-collapsed'), true);
    assert.equal(attributes['aria-expanded'], 'false');
    assert.equal(handle['aria-valuenow'], '0');
    assert.equal(handleClasses.has('active'), false);
    assert.equal(bodyClasses.has('resizing-schedule-sidebar'), false);

    scheduler.setScheduleSidebarCollapsed(false);
    assert.equal(layoutClasses.has('schedule-sidebar-collapsed'), false);
    assert.equal(sidebarProperties.get('--schedule-sidebar-width'), '300px');
    assert.equal(values.get('uofsc-schedule-sidebar-collapsed-v1'), 'false');

    buttonListeners.pointerdown({ clientX: 300 });
    documentListeners.pointermove({ clientX: 270, cancelable: true, preventDefault() {} });
    documentListeners.pointerup();
    assert.equal(sidebarProperties.get('--schedule-sidebar-width'), '270px');
    assert.equal(button.dataset.ignoreNextClick, 'true');
    scheduledTimers.shift()();
    assert.equal(button.dataset.ignoreNextClick, undefined);

    buttonListeners.pointerdown({ clientX: 270 });
    documentListeners.pointermove({ clientX: 159, cancelable: true, preventDefault() {} });
    assert.equal(layoutClasses.has('schedule-sidebar-collapsed'), true);
    assert.equal(button.dataset.ignoreNextClick, 'true');
    documentListeners.pointerup();
    scheduledTimers.shift()();
    assert.equal(button.dataset.ignoreNextClick, undefined);
    scheduler.setScheduleSidebarCollapsed(false);

    scheduler.setScheduleSidebarWidth(200, true);
    let prevented = 0;
    handleListeners.keydown({ key: 'ArrowLeft', preventDefault() { prevented += 1; } });
    assert.equal(layoutClasses.has('schedule-sidebar-collapsed'), true);
    assert.equal(prevented, 1);
});

test('schedule sidebar width fitting preserves the calendar and rejects invalid values', () => {
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {});

    assert.deepEqual(
        { ...scheduler.fitScheduleSidebarWidth(340, 1000) },
        { collapseAt: 160, maximum: 550, minimum: 200, width: 340 },
    );
    assert.equal(scheduler.fitScheduleSidebarWidth(200, 1000).width, 200);
    assert.equal(scheduler.fitScheduleSidebarWidth(900, 1600).width, 560);
    assert.equal(scheduler.fitScheduleSidebarWidth('invalid', 1000).width, 340);
    assert.equal(scheduler.fitScheduleSidebarWidth(340, 800).width, 340);
    assert.equal(scheduler.fitScheduleSidebarWidth(500, 1200).width, 500);
    assert.equal(
        scheduler.fitScheduleSidebarWidth(560, 1100).width,
        scheduler.fitScheduleSidebarWidth(560, 1101).width,
    );
});

test('schedule splitter uses a safe default when initialized in a hidden tab', () => {
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {});

    assert.equal(scheduler.initialPanelHeight(null, 0), 620);
    assert.equal(scheduler.initialPanelHeight(0, 0), 0);
    assert.equal(scheduler.initialPanelHeight(540, 0), 540);
    assert.equal(scheduler.initialPanelHeight(null, 575), 575);
    assert.equal(scheduler.preferredPanelHeight(700, null, 575), 575);
    assert.equal(scheduler.preferredPanelHeight(700, undefined, 575), 575);
    assert.equal(scheduler.preferredPanelHeight(700, 0, 575), 0);
    assert.equal(scheduler.preferredPanelHeight(700, 1, 575), 700);
    assert.equal(scheduler.preferredPanelHeight(700, 0.5, 575), 350);
});

test('schedule splitter recalculates when the schedule tab becomes visible', () => {
    const source = fs.readFileSync('static/js/scheduler.js', 'utf8');

    assert.match(source, /addEventListener\('tab-changed'/);
    assert.match(source, /event\.detail\?\.tab === 'schedule'/);
    assert.match(source, /if \(available <= 0\) return;/);
    assert.match(source, /workspaceRatio:\s*Number\.isFinite\(Number\(this\._preferredWorkspaceRatio\)\)/);
    assert.match(source, /availableAtInit \* storedRatio/);
    assert.match(source, /this\.preferredPanelHeight\(/);
    assert.match(source, /preferredRatio !== null && preferredRatio !== undefined/);
    assert.match(source, /this\._preferredWorkspaceRatio = available > 0 \? workspace \/ available : null/);
    assert.match(source, /addEventListener\('pointercancel', stop\)/);
});

test('adding a course code stores every live section without choosing one', async () => {
    let addedGroup;
    const state = {
        term: '202608',
        addCourse(group) { addedGroup = group; },
    };
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {
        State: state,
        API: {
            async searchCourses() {
                return {
                    results: [
                        { code: 'CSCE 145', crn: '11111' },
                        { code: 'CSCE 145', crn: '22222' },
                        { code: 'CSCE 146', crn: '33333' },
                    ],
                };
            },
        },
    });

    await scheduler.addCourseByCode('csce145');

    assert.equal(addedGroup.code, 'CSCE 145');
    assert.equal(addedGroup.sections.length, 2);
    assert.equal(state.selectedSections, undefined);
});

test('schedule search groups live sections into course-level results', async () => {
    let submittedQuery;
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {
        State: { term: '202608' },
        Search: {
            async searchLiveCourses(query) {
                submittedQuery = query;
                return {
                    results: [
                        { code: 'CSCE 145', crn: '11111', title: 'Algorithmic Design I' },
                        { code: 'CSCE 145', crn: '22222', title: 'Algorithmic Design I' },
                        { code: 'CSCE 146', crn: '33333', title: 'Algorithmic Design II' },
                    ],
                };
            },
        },
    });

    const groups = await scheduler.searchCourseGroups('CSCE');

    assert.equal(submittedQuery, 'CSCE');
    assert.equal(groups.length, 2);
    assert.equal(groups[0].sections.length, 2);
});

test('schedule search UI keeps the newest concurrent result', async () => {
    const input = { value: 'old search' };
    const button = { disabled: false };
    const results = { innerHTML: '' };
    const pending = {};
    const rendered = [];
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {
        document: {
            getElementById(id) {
                return {
                    'schedule-course-input': input,
                    'btn-search-schedule-courses': button,
                    'schedule-search-results': results,
                }[id] || null;
            },
        },
    });
    scheduler.setCourseStatus = () => {};
    scheduler.searchCourseGroups = query => new Promise(resolve => { pending[query] = resolve; });
    scheduler.renderCourseSearchResults = () => {
        rendered.push(Array.from(scheduler._lastSearchGroups, group => group.code));
    };

    const olderSearch = scheduler.searchFromInput();
    input.value = 'new search';
    const newerSearch = scheduler.searchFromInput();
    pending['new search']([{ code: 'NEW 101' }]);
    await newerSearch;
    pending['old search']([{ code: 'OLD 101' }]);
    await olderSearch;

    assert.deepEqual(Array.from(scheduler._lastSearchGroups, group => group.code), ['NEW 101']);
    assert.deepEqual(rendered, [['NEW 101']]);
    assert.equal(button.disabled, false);
});

test('schedule search shares browse CRN, range, partial, and direct keyword behavior', async () => {
    const calls = [];
    const search = loadObject('static/js/search.js', 'Search', {
        State: { term: '202608' },
        API: {
            async searchCourses(term, criteria) {
                calls.push(criteria);
                return {
                    results: [
                        { code: 'CSCE 501', crn: '10501' },
                        { code: 'CSCE 550', crn: '10550' },
                        { code: 'CSCE 410', crn: '10410' },
                    ],
                };
            },
        },
    });

    const crn = await search.searchLiveCourses('10501');
    assert.equal(calls[0][0].field, 'crn');
    assert.equal(calls[0][0].value, '10501');
    assert.equal(crn.results.length, 3);
    assert.equal(crn.queryType, 'crn');
    assert.equal(crn.crn, '10501');

    const boundedRange = await search.searchLiveCourses('CSCE 501-525');
    assert.deepEqual(Array.from(boundedRange.results, result => result.code), ['CSCE 501']);

    const wordRange = await search.searchLiveCourses('CSCE 501 to 550');
    assert.deepEqual(Array.from(wordRange.results, result => result.code), ['CSCE 501', 'CSCE 550']);

    const range = await search.searchLiveCourses('CSCE 500+');
    assert.deepEqual(Array.from(range.results, result => result.code), ['CSCE 501', 'CSCE 550']);

    const partial = await search.searchLiveCourses('CSCE 5');
    assert.deepEqual(Array.from(partial.results, result => result.code), ['CSCE 501', 'CSCE 550']);

    search._doSemanticSearch = async () => {
        throw new Error('Schedule search must not start semantic search.');
    };
    const keyword = await search.searchLiveCourses('graph algorithms');
    assert.equal(calls.at(-1).length, 1);
    assert.equal(calls.at(-1)[0].field, 'keyword');
    assert.equal(calls.at(-1)[0].value, 'graph algorithms');
    assert.equal(keyword.semantic, false);
    assert.equal(keyword.queryType, 'keyword');
});

test('schedule search applies multi-subject and number scopes without semantic search', async () => {
    const calls = [];
    const search = loadObject('static/js/search.js', 'Search', {
        State: { term: '202608' },
        API: {
            async searchCourses(term, criteria) {
                calls.push(criteria);
                const subject = criteria.find(item => item.field === 'subject')?.value || 'HIST';
                return {
                    results: [
                        { code: `${subject} 510`, crn: `${subject}510` },
                        { code: `${subject} 410`, crn: `${subject}410` },
                        { code: 'HIST 610', crn: 'HIST610' },
                    ],
                };
            },
        },
    });
    search._subjects = ['EMCH', 'CSCE', 'MATH'];
    search._doSemanticSearch = async () => {
        throw new Error('Schedule search must not start semantic search.');
    };

    const scoped = await search.searchLiveCourses(
        'EMCH; CSCE; MATH 500+ :: machine learning',
    );

    assert.equal(scoped.semantic, false);
    assert.equal(scoped.queryType, 'scoped');
    assert.deepEqual(
        Array.from(scoped.results, result => result.code),
        ['EMCH 510', 'CSCE 510', 'MATH 510'],
    );
    assert.deepEqual(
        calls.map(criteria => criteria.find(item => item.field === 'subject')?.value),
        ['EMCH', 'CSCE', 'MATH'],
    );
    calls.forEach(criteria => {
        const keyword = criteria.find(item => item.field === 'keyword');
        assert.equal(keyword?.field, 'keyword');
        assert.equal(keyword?.value, 'machine learning');
    });

    calls.length = 0;
    const scopeOnly = await search.searchLiveCourses('EMCH CSCE MATH 500+');
    assert.deepEqual(
        Array.from(scopeOnly.results, result => result.code),
        ['EMCH 510', 'CSCE 510', 'MATH 510'],
    );
    calls.forEach(criteria => assert.equal(
        criteria.some(item => item.field === 'keyword'),
        false,
    ));
});

test('a newer schedule search cancels an older direct request', async () => {
    let finishDirect;
    const search = loadObject('static/js/search.js', 'Search', {
        State: { term: '202608' },
        API: {
            async searchCourses(term, criteria) {
                if (criteria.some(item => item.field === 'keyword')) {
                    return new Promise(resolve => { finishDirect = resolve; });
                }
                return { results: [{ code: 'CSCE 145', crn: '10145' }] };
            },
        },
    });

    const olderSearch = search.searchLiveCourses('graph algorithms');
    await Promise.resolve();
    const newerSearch = await search.searchLiveCourses('CSCE');
    finishDirect({ results: [{ code: 'CSCE 585' }] });
    const staleSearch = await olderSearch;

    assert.equal(newerSearch.results[0].code, 'CSCE 145');
    assert.deepEqual(Array.from(staleSearch.results), []);
    assert.equal(staleSearch.stale, true);
});

test('adding a CRN search result locks and confirms its exact section', async () => {
    let locked;
    const status = { textContent: '', className: '' };
    const state = {
        term: '202608',
        addCourse() {},
        setSectionLock(code, crn) { locked = { code, crn }; },
    };
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {
        State: state,
        document: { getElementById: id => id === 'schedule-course-status' ? status : null },
    });
    scheduler.hydrateCourseCredits = async group => group;

    await scheduler.addCourseGroup({
        code: 'CSCE 145',
        title: 'Algorithmic Design I',
        _exactCrn: '16759',
        sections: [{ code: 'CSCE 145', section: '002', crn: '16759' }],
    });

    assert.deepEqual(locked, { code: 'CSCE 145', crn: '16759' });
    assert.equal(status.textContent, 'CSCE 145 Section 002 added from CRN 16759.');
});

test('numeric course ranges are parsed before semantic search in Browse', () => {
    const source = fs.readFileSync('static/js/search.js', 'utf8');
    const numericRange = source.indexOf('Inclusive numeric range');
    const semanticSearch = source.indexOf('Meaning-based search via Transformers.js');

    assert.ok(numericRange > 0);
    assert.ok(numericRange < semanticSearch);
    assert.match(source, /CSCE 140-150/);
    assert.match(fs.readFileSync('static/index.html', 'utf8'), /range \(CSCE 140-199\)/);
});

test('scoped search accepts flexible subject separators and canonical number limits', () => {
    const search = loadObject('static/js/search.js', 'Search', {});
    const variants = [
        'CSCE MATH EMCH 500+ :: machine learning',
        'CSCE; MATH; EMCH 500+ :: machine learning',
        'CSCE,MATH,EMCH 500+ :: machine learning',
        'CSCE/MATH|EMCH 500+ :: machine learning',
        'CSCE & MATH & EMCH 500+ :: machine learning',
    ];

    variants.forEach(value => {
        const parsed = search.parseCompactScopedQuery(value);
        assert.deepEqual(Array.from(parsed.subjects), ['CSCE', 'MATH', 'EMCH']);
        assert.equal(parsed.subjectText, 'CSCE; MATH; EMCH');
        assert.equal(parsed.numberText, '500+');
        assert.equal(parsed.topic, 'machine learning');
    });

    const wordRange = search.parseCompactScopedQuery('CSCE MATH 100 to 500 :: data analysis');
    assert.equal(wordRange.numberText, '100-500');
    const subjectTopic = search.parseCompactScopedQuery('EMCH :: fluid mechanics');
    assert.deepEqual(Array.from(subjectTopic.subjects), ['EMCH']);
    assert.equal(subjectTopic.numberText, '');
    const numberTopic = search.parseCompactScopedQuery('500+ :: fluid mechanics');
    assert.deepEqual(Array.from(numberTopic.subjects), []);
    assert.equal(numberTopic.numberText, '500+');
    const standalone = search.parseStandaloneCourseScope('EMCH CSCE MATH 500+');
    assert.deepEqual(Array.from(standalone.subjects), ['EMCH', 'CSCE', 'MATH']);
    assert.equal(standalone.numberText, '500+');
    assert.equal(search.parseStandaloneCourseScope('CSCE 500+'), null);
    assert.equal(search.parseStandaloneCourseScope('history 101'), null);
    assert.equal(search.parseStandaloneCourseScope('COVID 19'), null);
    assert.equal(search.parseStandaloneCourseScope('World War 2'), null);
    assert.equal(search.parseStandaloneCourseScope('AI, law'), null);
    assert.equal(search.parseStandaloneCourseScope('AI LAW'), null);
    const wildcard = search.buildCourseScope('CSCE; MATH', '5xx');
    assert.equal(wildcard.matches('CSCE 585'), true);
    assert.equal(wildcard.matches('MATH 524'), true);
    assert.equal(wildcard.matches('EMCH 585'), false);
    assert.equal(wildcard.matches('CSCE 499'), false);
    const minimum = search.buildCourseScope('', '500+');
    assert.equal(minimum.matches('HIST 700'), true);
    assert.equal(minimum.matches('HIST 499'), false);
    const multiSubjectScope = search.buildCourseScope('CSCE; MATH', '500+');
    assert.deepEqual(Array.from(search.scopedSubjectsForQuery('CSCE', multiSubjectScope)), ['CSCE']);
    assert.deepEqual(Array.from(search.scopedSubjectsForQuery('EMCH', multiSubjectScope)), []);
    assert.throws(() => search.parseCompactScopedQuery('CSCE 600-500 :: controls'), /lower than the last/);
    assert.throws(() => search.buildCourseScope('CSCE', '5$$'), /Use a course number/);
    assert.throws(
        () => search.buildCourseScope('AAA BBB CCC DDD EEE FFF GGG HHH III JJJ KKK LLL MMM', ''),
        /12 or fewer subjects/,
    );
    search._subjects = ['CSCE', 'MATH', 'EMCH'];
    assert.throws(() => search.buildCourseScope('CSEC', ''), /Unknown subject "CSEC"\. Try CSCE/);
});

test('course scope is a hard filter for API, local, and merged candidates', () => {
    const search = loadObject('static/js/search.js', 'Search', {});
    const scope = search.buildCourseScope('CSCE MATH', '500+');
    const filtered = search.filterByCourseScope([
        { code: 'CSCE 585' },
        { code: 'MATH 524' },
        { code: 'CSCE 350' },
        { code: 'EMCH 585' },
    ], scope);

    assert.deepEqual(Array.from(filtered, result => result.code), ['CSCE 585', 'MATH 524']);
});

test('semantic scope filters every bounded batch and reports the adaptive search count', async () => {
    let calls = 0;
    const progress = [];
    const extractor = async values => ({ data: new Float32Array(values.map(() => 1)) });
    const search = loadObject('static/js/search.js', 'Search', {
        API: {
            async post() {
                calls += 1;
                return {
                    results: [
                        { code: 'CSCE 585', title: 'Machine Learning Systems' },
                        { code: 'EMCH 585', title: 'Fluid Systems' },
                    ],
                };
            },
        },
        State: { term: '202608' },
        console,
    });
    search._searchId = 1;
    search._loadExtractor = async () => extractor;
    search._loadPhraseData = async () => {};
    search._embedQuery = async () => new Float32Array([1]);
    search._findNearestPhrases = () => Array.from(
        { length: 19 },
        (_, index) => ({ phrase: `generated ${index + 1}`, sim: 0.9 }),
    );
    search._courseEmbeddings = { courses: [] };
    search._courseVecs = [];
    search._pcaParams = { mean: [0], components: [[1]], dims: 1 };

    const result = await search._doSemanticSearch(
        'machine learning',
        false,
        false,
        1,
        search.buildCourseScope('CSCE', '500+'),
        state => progress.push({ ...state }),
    );

    assert.equal(calls, 4);
    assert.equal(result.searches.length, 4);
    assert.deepEqual(Array.from(result.results, item => item.code), ['CSCE 585']);
    assert.deepEqual(Array.from(result.searchResults.flat(), item => item.code), Array(4).fill('CSCE 585'));
    assert.equal(progress[0].total, 6);
    assert.equal(progress.some(state => state.completed === 4 && state.total === 6), true);
    assert.equal(result.requestBudget.totalLimit, 10);
});

test('semantic search uses its larger scoped budget when early batches have no matches', async () => {
    let calls = 0;
    const extractor = async values => ({ data: new Float32Array(values.map(() => 1)) });
    const search = loadObject('static/js/search.js', 'Search', {
        API: {
            async post() {
                calls += 1;
                return {
                    results: calls <= 4
                        ? [{ code: 'EMCH 585', title: 'Fluid Systems' }]
                        : [{ code: 'CSCE 585', title: 'Machine Learning Systems' }],
                };
            },
        },
        State: { term: '202608' },
        console,
    });
    search._searchId = 1;
    search._loadExtractor = async () => extractor;
    search._loadPhraseData = async () => {};
    search._embedQuery = async () => new Float32Array([1]);
    search._findNearestPhrases = () => Array.from(
        { length: 19 },
        (_, index) => ({ phrase: `generated ${index + 1}`, sim: 0.9 }),
    );
    search._courseEmbeddings = { courses: [] };
    search._courseVecs = [];
    search._pcaParams = { mean: [0], components: [[1]], dims: 1 };

    const result = await search._doSemanticSearch(
        'machine learning',
        false,
        false,
        1,
        search.buildCourseScope('CSCE', '500+'),
    );

    assert.equal(calls, 6);
    assert.deepEqual(Array.from(result.results, item => item.code), ['CSCE 585']);
    assert.equal(result.requestBudget.totalLimit, 10);
});

test('Browse uses progressive states with AI-assisted search on by default', () => {
    const html = fs.readFileSync('static/index.html', 'utf8');
    const source = fs.readFileSync('static/js/search.js', 'utf8');
    const styles = fs.readFileSync('static/css/style.css', 'utf8');

    assert.match(html, /id="browse-workspace" class="semester-layout browse-empty"/);
    assert.match(html, /id="filter-ai-search" type="checkbox" checked/);
    assert.doesNotMatch(html, /id="smart-search-toggle"/);
    assert.match(html, /id="browse-close-details"/);
    assert.match(html, /id="course-detail-tabs"[^>]*role="tablist"/);
    assert.match(html, /data-course-tab="overview"/);
    assert.doesNotMatch(html, /data-course-tab="sections"/);
    assert.doesNotMatch(html, /id="course-panel-sections"/);
    assert.match(html, /data-course-tab="grades"/);
    assert.match(html, /data-course-tab="history"/);
    assert.match(html, /data-course-tab="resources"/);
    assert.match(html, /id="active-filter-chips"/);
    assert.match(html, /id="filter-backdrop"/);
    assert.match(html, /id="filter-panel"/);
    assert.match(html, /role="dialog" aria-modal="true"/);
    assert.doesNotMatch(html, /<span>Results<\/span>/);
    assert.match(source, /setBrowseState\('results'\)/);
    assert.match(source, /setBrowseState\('detail'\)/);
    assert.match(source, /let aiAssisted = document\.getElementById\('filter-ai-search'\)\?\.checked !== false/);
    assert.match(source, /preload\(\);\s*requestAnimationFrame/);
    assert.match(styles, /\.browse-empty \.browse-body\s*{\s*display:\s*none;/);
    assert.match(styles, /\.browse-results #semester-content\s*{\s*display:\s*none;/);
    assert.match(styles, /\.browse-detail #semester-content\s*{[^}]*display:\s*block;/s);
    assert.match(styles, /\.browse-results \.browse-search-examples,[\s\S]*\.browse-detail \.browse-search-examples\s*{\s*display:\s*none;/);
});

test('Browse filters open as a centered modal and applying closes them', () => {
    const html = fs.readFileSync('static/index.html', 'utf8');
    const source = fs.readFileSync('static/js/search.js', 'utf8');
    const styles = fs.readFileSync('static/css/style.css', 'utf8');

    assert.match(styles, /\.filter-backdrop\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*2040;/s);
    assert.match(styles, /#filter-panel\s*\{[^}]*left:\s*50%;[^}]*position:\s*fixed;[^}]*top:\s*50%;[^}]*transform:\s*translate\(-50%, -50%\);[^}]*width:\s*min\(720px,/s);
    assert.match(source, /document\.body\.append\(filterBackdrop, filterPanel\)/);
    assert.match(source, /openFilters\([\s\S]*backdrop\?\.classList\.remove\('hidden'\)/);
    assert.match(source, /document\.getElementById\('btn-apply-filters'\)\?\.addEventListener\('click',[\s\S]*?this\.doSearch\(\)/);
    assert.match(source, /if \(event\.key === 'Escape'[\s\S]*?event\.stopImmediatePropagation\(\);[\s\S]*?this\.closeFilters\(\);/);
    assert.match(source, /if \(event\.key !== 'Tab'\) return;[\s\S]*filterPanel\.querySelectorAll/);
    assert.match(source, /this\._filterPreviousFocus = document\.activeElement/);
    assert.match(source, /document\.getElementById\('filter-panel'\)\?\.classList\.contains\('hidden'\)/);
    assert.match(html, /id="additional-filter-toggle" type="button" aria-expanded="false" aria-controls="additional-filter-panel"/);
    assert.match(source, /additionalToggle\.setAttribute\('aria-expanded', String\(willExpand\)\)/);
});

test('Browse teaches structured searches and presents generated searches compactly', () => {
    const html = fs.readFileSync('static/index.html', 'utf8');
    const source = fs.readFileSync('static/js/search.js', 'utf8');
    const styles = fs.readFileSync('static/css/style.css', 'utf8');

    assert.match(html, /data-search-example="Machine Learning"/);
    assert.match(html, /data-search-example="CSCE 500\+"/);
    assert.match(html, /data-search-example="CSCE 5xx"/);
    assert.match(html, /data-search-example="CSCE 140-199"/);
    assert.doesNotMatch(html, /\d{3}\s+to\s+\d{3}/i);
    assert.doesNotMatch(html, /CSCE 140–199/);
    assert.match(html, /id="filter-scope-subjects"/);
    assert.match(html, /id="filter-scope-numbers"/);
    assert.match(html, /EMCH :: how heat moves through machines/);
    assert.doesNotMatch(html, /CSCE; MATH; EMCH 500\+ :: machine learning/);
    assert.match(html, /id="search-syntax-open"/);
    assert.match(html, />Syntax examples</);
    assert.match(html, /courses about machine learning for healthcare/);
    assert.match(html, /EMCH 500\+ :: designing quieter and more efficient engines/);
    assert.match(html, /500\+ :: advanced courses about climate modeling/);
    assert.match(html, /EMCH CSCE MATH 500\+<\/code><small>Multiple subjects without a topic/);
    assert.match(html, /EMCH CSCE MATH 500\+ :: using machine learning to model physical systems/);
    assert.match(html, /Exact Course Reference Number \(CRN\)/);
    const orderedExamples = [
        '>CSCE<',
        '>CSCE 145<',
        '>CSCE 140-199<',
        '>CSCE 5xx<',
        '>CSCE 500+<',
        '>EMCH CSCE MATH 500+<',
        '>courses about machine learning for healthcare<',
        '>design safer medical devices<',
        '>how cities shape public health<',
        '>EMCH :: how heat moves through machines<',
        '>500+ :: advanced courses about climate modeling<',
        '>EMCH 500+ :: designing quieter and more efficient engines<',
        '>EMCH CSCE MATH 500+ :: using machine learning to model physical systems<',
        '>16759<',
    ];
    const syntaxMarkup = html.slice(
        html.indexOf('<div class="search-syntax-grid">'),
        html.indexOf('<section class="course-scope-filter"'),
    );
    orderedExamples.slice(1).forEach((example, index) => {
        assert.ok(syntaxMarkup.indexOf(orderedExamples[index]) < syntaxMarkup.indexOf(example));
    });
    assert.ok(html.indexOf('id="search-syntax-guide"') < html.indexOf('class="course-scope-filter"'));
    assert.doesNotMatch(html, /search-syntax-wide/);
    assert.equal((html.match(/class="filter-sliders-icon"/g) || []).length, 2);
    assert.match(styles, /\.filter-sliders-icon\s*{[^}]*width:\s*24px;/s);
    assert.match(styles, /\.filter-sliders-icon > span\s*{[^}]*height:\s*2px;/s);
    assert.match(styles, /\.filter-sliders-icon i\s*{[^}]*height:\s*8px;[^}]*transform:\s*translateY\(-50%\);[^}]*width:\s*8px;/s);
    assert.match(styles, /\.filter-sliders-icon > span:nth-child\(2\) i\s*{\s*left:\s*13px;/);
    assert.match(html, /id="smart-model-loading-stage">Preparing AI-assisted search/);
    assert.doesNotMatch(html, /id="smart-search-status"/);
    assert.doesNotMatch(html, /id="smart-search-query-list"/);
    assert.doesNotMatch(html, /id="smart-search-aggregate"/);
    assert.match(source, /input\.disabled = active/);
    assert.match(source, /openRegularSearch\(term\)/);
    assert.match(source, /this\._relatedSearchOrigin = origin;[\s\S]*this\._directSearchOnce = true;[\s\S]*this\.doSearch\(\);/);
    assert.match(source, /class="semantic-search-term\$\{failedClass\}" data-regular-search-index/);
    assert.match(source, /const relatedBatches = await Promise\.all/);
    assert.match(source, /this\.filterByCourseScope\(candidates, courseScope\)/);
    assert.match(source, /const treatAsTopic = this\._topicSearchMode \|\| scopedShortTopic/);
    assert.match(source, /\.filter\(code => visibleCodes\.has\(code\)\)/);
    assert.match(source, /count: matchingCodes\.length/);
    assert.match(source, /<strong>\$\{countLabel\}<\/strong>/);
    assert.match(source, /class="semantic-search-terms-toggle" aria-expanded="false"/);
    assert.match(source, /\$\{searchTerms\.length\} Search sources/);
    assert.match(source, /Meaning-based catalog matches/);
    assert.match(source, /id="semantic-search-term-list" class="semantic-search-term-list hidden"/);
    assert.match(source, /searchTermsToggle\?\.addEventListener\('click'/);
    assert.match(source, /class="related-search-back-icon"/);
    assert.match(source, /class="related-search-back-copy"/);
    assert.match(styles, /\.smart-model-loading\s*{[^}]*position:\s*absolute;/s);
    assert.match(styles, /\.semantic-search-term\s*{[^}]*cursor:\s*pointer;/s);
    assert.match(styles, /\.semantic-search-term strong\s*{[^}]*background:\s*#466A9F;/s);
    assert.match(styles, /\.semantic-search-terms-toggle\s*{[^}]*width:\s*100%;/s);
    assert.match(styles, /\.semantic-search-terms-toggle\[aria-expanded="true"\] i\s*{\s*transform:\s*rotate\(180deg\);/s);
    assert.match(styles, /\.related-search-back\s*{[^}]*border:\s*2px solid #000000;[^}]*grid-template-columns:\s*38px minmax\(0, 1fr\);/s);
    assert.match(source, /onProgress\?\.\(\{[\s\S]*completed: usedSearches\.length,[\s\S]*total: searches\.length/);
    assert.match(source, /failed: usedSearchFailures\[index\]/);
    assert.match(source, /No results found\.[\s\S]*generatedSearchesMarkup\(searchTerms\)/);
    assert.match(styles, /\.semantic-search-term\.is-failed\s*\{[^}]*border-color:\s*#CC2E40;/s);
    assert.match(styles, /\.semantic-search-term\.is-catalog,[\s\S]*cursor:\s*default;/);
    assert.match(source, /_findNearestPhrases\(queryVec, 19, query\)/);
    assert.match(styles, /\.search-progress\s*{[^}]*border:\s*2px solid #000000;/s);
});

test('Repeated and historical searches reuse a bounded one-hour in-memory cache', () => {
    const search = loadObject('static/js/search.js', 'Search', {});
    const source = fs.readFileSync('static/js/search.js', 'utf8');
    const rendered = [];
    search.renderResults = (...args) => rendered.push(args);
    search._searchViewCache = new Map();
    search._mainSearchQuery = 'Machine Learning';
    search._relatedSearchOrigin = '';

    search.renderAndCacheSearch('parent', [{ code: 'CSCE 883' }], 1, {}, false, [
        { term: 'deep learning', count: 3 },
    ]);
    search._mainSearchQuery = '';
    search._relatedSearchOrigin = 'Machine Learning';

    assert.equal(search.restoreCachedSearch('parent'), true);
    assert.equal(search._mainSearchQuery, 'Machine Learning');
    assert.equal(search._relatedSearchOrigin, '');
    assert.equal(rendered.length, 2);
    assert.equal(rendered[1][0][0].code, 'CSCE 883');
    assert.equal(search._searchCacheTtlMs, 60 * 60 * 1000);
    assert.equal(search._searchCacheMaxEntries, 30);
    assert.match(source, /if \(!bypassCache && !this\._semanticFallbackOnce[\s\S]*this\.restoreCachedSearch\(searchCacheKey\)\) return;/);
    assert.match(source, /await this\.doSearch\(\{ bypassCache: true \}\)/);
    assert.match(source, /this\._semanticFallbackOnce \? null : searchCacheKey/);
    const emptySemanticStart = source.indexOf('if (semantic.results.length === 0)');
    const emptySemanticEnd = source.indexOf('let results = semantic.results;', emptySemanticStart);
    const emptySemanticBlock = source.slice(emptySemanticStart, emptySemanticEnd);
    assert.match(emptySemanticBlock, /semantic\.hadRequestFailure \? null : searchCacheKey/);
    assert.match(emptySemanticBlock, /renderAndCacheSearch/);
    assert.match(emptySemanticBlock, /semantic\.searches/);
    assert.match(source, /hadRequestFailure \|\|= response\.failed/);
    assert.match(source, /const incompleteSearch = semantic\.hadRequestFailure[\s\S]*liveHydration\.hadRequestFailure/);
    assert.match(source, /incompleteSearch \? null : searchCacheKey/);
    const catalogLiveStart = source.indexOf('// Also fetch live term data to cross-reference availability');
    const catalogLiveEnd = source.indexOf('// Build a set of course codes offered this term', catalogLiveStart);
    assert.doesNotMatch(source.slice(catalogLiveStart, catalogLiveEnd), /catch\(/);

    for (let index = 0; index < 32; index += 1) {
        search.renderAndCacheSearch(`query-${index}`, [], 0, {}, false);
    }
    assert.equal(search._searchViewCache.size, 30);
    search.renderAndCacheSearch(null, [], 0, {}, false);
    assert.equal(search._searchViewCache.size, 30);

    const expired = search._searchViewCache.get('query-31');
    expired.storedAt = Date.now() - search._searchCacheTtlMs - 1;
    assert.equal(search.restoreCachedSearch('query-31'), false);

    const profileState = { term: '202608', completedCourses: ['CSCE 145'] };
    const filters = { 'filter-eligible': { checked: true } };
    const profileSearch = loadObject('static/js/search.js', 'Search', {
        URL,
        State: profileState,
        document: { getElementById: id => filters[id] || null },
        window: { location: { href: 'http://localhost/?tab=search' } },
    });
    const firstProfileKey = profileSearch.searchCacheKey({ query: 'algorithms' });
    assert.equal(
        profileSearch.searchCacheKey({ query: 'csce145' }),
        profileSearch.searchCacheKey({ query: 'CSCE 145' }),
    );
    assert.equal(
        profileSearch.searchCacheKey({ query: 'csce 140 – 150' }),
        profileSearch.searchCacheKey({ query: 'CSCE140-150' }),
    );
    assert.equal(
        profileSearch.searchCacheKey({ query: 'Machine Learning' }),
        profileSearch.searchCacheKey({ query: 'machine learning' }),
    );
    profileState.completedCourses = ['CSCE 211'];
    const secondProfileKey = profileSearch.searchCacheKey({ query: 'algorithms' });
    assert.notEqual(firstProfileKey, secondProfileKey);
});

test('API error payloads reject so failed searches are never cached as empty results', async () => {
    const api = loadObject('static/js/api.js', 'API', {
        fetch: async () => ({
            ok: true,
            status: 200,
            async json() { return { error: 'upstream unavailable' }; },
        }),
    });

    await assert.rejects(
        () => api.post('/api/search', {}),
        /upstream unavailable/,
    );
});

test('API coalesces duplicate live requests and reuses its short browser cache', async () => {
    let release;
    let calls = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const api = loadObject('static/js/api.js', 'API', {
        fetch: async () => {
            calls += 1;
            await gate;
            return {
                ok: true,
                status: 200,
                async json() { return { results: [{ code: 'CSCE 145' }] }; },
            };
        },
    });

    const first = api.searchCourses('202608', [{ field: 'subject', value: 'CSCE' }]);
    const second = api.searchCourses('202608', [{ value: 'CSCE', field: 'subject' }]);
    await Promise.resolve();
    assert.equal(calls, 1);
    release();
    assert.deepEqual(await first, await second);
    await api.searchCourses('202608', [{ field: 'subject', value: 'CSCE' }]);
    assert.equal(calls, 1);
});

test('API browser cache keeps recently reused entries during eviction', () => {
    const api = loadObject('static/js/api.js', 'API', {});
    api._responseCacheMaxEntries = 2;
    api._storeCached('older-hot', { value: 1 }, 60_000);
    api._storeCached('newer-cold', { value: 2 }, 60_000);

    assert.deepEqual(api._cached('older-hot'), { value: 1 });
    api._storeCached('newest', { value: 3 }, 60_000);

    assert.equal(api._responseCache.has('newer-cold'), false);
    assert.equal(api._responseCache.has('older-hot'), true);
    assert.equal(api._responseCache.has('newest'), true);
});

test('detail prefetch is sequential and stops after cancellation', async () => {
    const controller = new AbortController();
    const calls = [];
    const api = loadObject('static/js/api.js', 'API', {
        requestIdleCallback: callback => callback(),
        setTimeout: callback => callback(),
        fetch: async (_path, options) => {
            const body = JSON.parse(options.body);
            calls.push(body.group);
            if (calls.length === 1) controller.abort();
            return { ok: true, status: 200, async json() { return {}; } };
        },
    });

    await api.prefetchCourseDetails(
        [{ crn: '10001' }, { crn: '10001' }, { crn: '10002' }],
        '202608',
        { signal: controller.signal },
    );

    assert.deepEqual(calls, ['crn:10001']);
});

test('A browser reload requests fresh live data without changing historical cache behavior', async () => {
    const requests = [];
    const api = loadObject('static/js/api.js', 'API', {
        performance: { getEntriesByType: () => [{ type: 'reload' }] },
        fetch: async (path, options) => {
            requests.push({ path, options });
            return { ok: true, status: 200, async json() { return {}; } };
        },
    });

    assert.equal(api.shouldRefreshAfterReload(), true);
    api.setForceRefreshLive(true);
    await api.post('/api/search', {});
    api.setForceRefreshLive(false);
    await api.post('/api/history', { code: 'CSCE 145' });

    assert.equal(requests[0].options.headers['X-UofSC-Refresh-Live'], '1');
    assert.equal(requests[1].options.headers['X-UofSC-Refresh-Live'], undefined);
});

test('Offering history stream reports real progress before returning its aggregate', async () => {
    const events = [
        JSON.stringify({ type: 'progress', phase: 'terms', completed: 0, total: 8, label: 'Fall 2023' }),
        JSON.stringify({ type: 'progress', phase: 'terms', completed: 3, total: 8, label: 'Fall 2024' }),
        JSON.stringify({ type: 'result', data: { code: 'CSCE 145', terms: [] } }),
    ].join('\n') + '\n';
    const encoded = new TextEncoder().encode(events);
    const chunks = [encoded.slice(0, 47), encoded.slice(47, 121), encoded.slice(121)];
    const requests = [];
    const api = loadObject('static/js/api.js', 'API', {
        TextDecoder,
        fetch: async (path, options) => {
            requests.push({ path, options });
            let index = 0;
            return {
                ok: true,
                status: 200,
                body: {
                    getReader() {
                        return {
                            async read() {
                                if (index >= chunks.length) return { done: true };
                                return { done: false, value: chunks[index++] };
                            },
                        };
                    },
                },
            };
        },
    });
    const progress = [];

    const result = await api.getHistory('CSCE 145', event => progress.push(event));

    assert.equal(requests[0].path, '/api/history-stream');
    assert.equal(requests[0].options.method, 'POST');
    assert.deepEqual(JSON.parse(requests[0].options.body), { code: 'CSCE 145' });
    assert.deepEqual(progress.map(event => [event.completed, event.total]), [[0, 8], [3, 8]]);
    assert.equal(result.code, 'CSCE 145');
});

test('Offering history falls back when its progress stream is unavailable', async () => {
    const requests = [];
    const api = loadObject('static/js/api.js', 'API', {
        fetch: async (path, options) => {
            requests.push({ path, options });
            if (path === '/api/history-stream') {
                return { ok: false, status: 404 };
            }
            return {
                ok: true,
                status: 200,
                async json() {
                    return {
                        code: 'CSCE 883',
                        complete: true,
                        terms: [{ term: '202508', offered: true }],
                    };
                },
            };
        },
    });

    const result = await api.getHistory('CSCE 883', () => {});

    assert.deepEqual(requests.map(request => request.path), [
        '/api/history-stream',
        '/api/history',
    ]);
    assert.deepEqual(JSON.parse(requests[1].options.body), { code: 'CSCE 883' });
    assert.equal(result.code, 'CSCE 883');
    assert.equal(result.terms[0].offered, true);
});

test('Offering history does not retry genuine progress-stream failures', async () => {
    const requests = [];
    const api = loadObject('static/js/api.js', 'API', {
        fetch: async path => {
            requests.push(path);
            return { ok: false, status: 500 };
        },
    });

    await assert.rejects(
        () => api.getHistory('CSCE 883', () => {}),
        /status 500/,
    );
    assert.deepEqual(requests, ['/api/history-stream']);
});

test('Offering history falls back from a malformed progress response', async () => {
    const requests = [];
    const api = loadObject('static/js/api.js', 'API', {
        fetch: async (path, options) => {
            requests.push({ path, options });
            if (path === '/api/history-stream') {
                return {
                    ok: true,
                    status: 200,
                    body: null,
                    async text() { return '<html>not a progress stream</html>'; },
                };
            }
            return {
                ok: true,
                status: 200,
                async json() { return { code: 'CSCE 883', complete: true, terms: [] }; },
            };
        },
    });

    const result = await api.getHistory('CSCE 883', () => {});

    assert.deepEqual(requests.map(request => request.path), [
        '/api/history-stream',
        '/api/history',
    ]);
    assert.equal(result.code, 'CSCE 883');
});

test('Offering history preserves errors returned by a valid progress stream', async () => {
    const requests = [];
    const api = loadObject('static/js/api.js', 'API', {
        fetch: async path => {
            requests.push(path);
            return {
                ok: true,
                status: 200,
                body: null,
                async text() {
                    return `${JSON.stringify({
                        type: 'result',
                        data: { error: 'upstream unavailable' },
                    })}\n`;
                },
            };
        },
    });

    await assert.rejects(
        () => api.getHistory('CSCE 883', () => {}),
        /upstream unavailable/,
    );
    assert.deepEqual(requests, ['/api/history-stream']);
});

test('AI-assisted search can be disabled and related searches remain direct', () => {
    const html = fs.readFileSync('static/index.html', 'utf8');
    const source = fs.readFileSync('static/js/search.js', 'utf8');

    assert.match(html, /id="filter-ai-search" type="checkbox" checked/);
    assert.match(source, /const useDirectSearch = !aiAssisted[\s\S]*Boolean\(this\._relatedSearchOrigin\)[\s\S]*this\._directSearchOnce[\s\S]*this\._semanticFallbackOnce/);
    assert.match(source, /if \(aiToggle\) aiToggle\.checked = true/);
    assert.match(source, /openRegularSearch\(term\)[\s\S]*this\._directSearchOnce = true/);
    assert.match(source, /writeSearchHistory\(searchQuery,[\s\S]*origin: this\._relatedSearchOrigin/);
    assert.match(source, /Meaning-based matching is unavailable\. Showing direct matches\./);
});

test('Browse uses one search field for direct and AI-assisted queries', () => {
    const html = fs.readFileSync('static/index.html', 'utf8');
    const source = fs.readFileSync('static/js/search.js', 'utf8');
    const styles = fs.readFileSync('static/css/style.css', 'utf8');

    assert.equal((html.match(/id="keyword-input"/g) || []).length, 1);
    assert.doesNotMatch(html, /id="smart-keyword-input"/);
    assert.doesNotMatch(html, /id="smart-search-submit"/);
    assert.equal((html.match(/data-search-example=/g) || []).length, 6);
    assert.match(source, /keywordInput\.addEventListener\('keydown',[\s\S]*if \(e\.key === 'Enter'\) this\.submitSearch\(\)/);
    assert.doesNotMatch(styles, /\.browse-empty \.browse-filter-button\s*{\s*display:\s*none;/);
    assert.match(styles, /\.browse-empty \.browse-search-form\s*{\s*grid-template-columns:\s*minmax\(0, 1fr\) 44px 102px;/);
    assert.doesNotMatch(styles, /\.smart-search-active/);
});

test('Search navigation resets cleanly and URL history restores prior searches', () => {
    const search = fs.readFileSync('static/js/search.js', 'utf8');
    const tabs = fs.readFileSync('static/js/tabs.js', 'utf8');
    const styles = fs.readFileSync('static/css/style.css', 'utf8');

    assert.match(tabs, /btn\.dataset\.tab === 'semester'[\s\S]*search-tab-reset-requested/);
    assert.match(tabs, /writeTabHistory\(tabName, historyMode\)/);
    assert.match(tabs, /url\.searchParams\.set\('tab', tabName\)/);
    assert.match(tabs, /window\.addEventListener\('popstate', \(\) => this\.restoreFromLocation\(\)\)/);
    assert.match(search, /resetToCleanSearch\(\{ historyMode: 'push' \}\)/);
    assert.match(search, /history\.pushState\(state, '', next\)/);
    assert.match(search, /window\.addEventListener\('popstate', \(\) => this\.restoreFromLocation\(\)\)/);
    assert.match(search, /url\.searchParams\.set\('q', query\)/);
    assert.match(search, /url\.searchParams\.set\('term', State\.term\)/);
    assert.match(search, /url\.searchParams\.set\('from', origin\)/);
    assert.match(search, /if \(topic\) url\.searchParams\.set\('topic', '1'\)/);
    assert.match(search, /this\._topicSearchMode = params\.get\('topic'\) === '1'/);
    assert.match(search, /params\.get\('tab'\) !== 'search' && !params\.has\('q'\)/);
    assert.match(search, /State\.term = term/);
    assert.match(search, /class="related-search-back"/);
    assert.match(search, /history\.state\?\.relatedSearch/);
    assert.match(fs.readFileSync('static/index.html', 'utf8'), /id="keyword-input" aria-label="Search courses"/);
    assert.match(styles, /\.search-clear\s*{[^}]*right:\s*7px;/s);
    assert.match(styles, /@media \(max-width: 700px\)[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) 44px 88px;/s);
    assert.match(styles, /@media \(max-width: 420px\)[\s\S]*--search-side-gap:\s*8px;/s);
});

test('scope-only search URLs restore results but clean scoped URLs stay empty', async () => {
    const input = { value: '' };
    let searches = 0;
    let resets = 0;
    const window = {
        location: {
            href: 'http://localhost/?tab=search&term=202608&subjects=CSCE%3B+MATH&numbers=500%2B&scopeSearch=1',
        },
    };
    const search = loadObject('static/js/search.js', 'Search', {
        API: { shouldRefreshAfterReload: () => false, setForceRefreshLive() {} },
        State: { term: '202608' },
        Tabs: { switchTo() {} },
        URL,
        document: { getElementById: () => null },
        window,
    });
    search.applyFiltersFromLocation = () => {};
    search.activeSearchInput = () => input;
    search.doSearch = async () => { searches += 1; };
    search.resetToCleanSearch = () => { resets += 1; };

    await search.restoreFromLocation();
    assert.equal(searches, 1);
    assert.equal(resets, 0);

    window.location.href = 'http://localhost/?tab=search&term=202608&subjects=CSCE%3B+MATH&numbers=500%2B';
    await search.restoreFromLocation();
    assert.equal(searches, 1);
    assert.equal(resets, 1);
});

test('URL restoration preserves explicit natural-language topic mode', async () => {
    const input = { value: '' };
    const window = {
        location: {
            href: 'http://localhost/?tab=search&term=202608&q=heat&subjects=EMCH&numbers=500%2B&topic=1',
        },
    };
    const search = loadObject('static/js/search.js', 'Search', {
        API: { shouldRefreshAfterReload: () => false, setForceRefreshLive() {} },
        State: { term: '202608' },
        Tabs: { switchTo() {} },
        URL,
        document: { getElementById: () => null },
        window,
    });
    search.applyFiltersFromLocation = () => {};
    search.activeSearchInput = () => input;
    search.doSearch = async () => {};

    await search.restoreFromLocation();

    assert.equal(input.value, 'heat');
    assert.equal(search._topicSearchMode, true);
});

test('Course detail routes persist search context while section and panel changes replace history', () => {
    const location = {
        href: 'http://127.0.0.1:8765/?tab=search&term=202608&q=machine%20learning&open=1',
        pathname: '/',
        search: '?tab=search&term=202608&q=machine%20learning&open=1',
    };
    const historyCalls = [];
    const applyLocation = value => {
        const next = new URL(value, location.href);
        location.href = next.href;
        location.pathname = next.pathname;
        location.search = next.search;
    };
    const history = {
        state: { search: true, query: 'machine learning' },
        pushState(state, _title, url) {
            this.state = state;
            historyCalls.push({ mode: 'push', state, url });
            applyLocation(url);
        },
        replaceState(state, _title, url) {
            this.state = state;
            historyCalls.push({ mode: 'replace', state, url });
            applyLocation(url);
        },
    };
    const buttons = ['10868', '10869'].map(crn => ({
        dataset: { detailCrn: crn },
        classList: { toggle() {} },
        setAttribute() {},
        scrollIntoView() {},
        focus() {},
        tabIndex: -1,
    }));
    const group = {
        code: 'CSCE 145',
        sections: [
            { code: 'CSCE 145', crn: '10868', stat: 'A' },
            { code: 'CSCE 145', crn: '10869', stat: 'A' },
        ],
    };
    const search = loadObject('static/js/search.js', 'Search', {
        URL,
        window: { location },
        history,
        State: {
            term: '202608',
            courseGroups: [group],
            sectionLocks: {},
            selectedSections: {},
        },
        API: { getDetails: () => new Promise(() => {}) },
        document: {
            getElementById() { return null; },
            querySelectorAll(selector) {
                return selector === '[data-detail-crn]' ? buttons : [];
            },
        },
        requestAnimationFrame(callback) { callback(); },
    });
    search._browseState = 'detail';
    search._detailGroup = group;
    search._detailSectionCrn = '10868';
    search._detailTab = 'overview';
    search._detailLoads = {};
    search._detailToken = 1;
    search.destroyDetailMap = () => {};
    search.renderSectionSummary = () => {};
    search.renderCourseResources = () => {};
    search.refreshDetailGrades = () => {};
    search.loadSectionFaculty = () => new Promise(() => {});

    search.writeCourseDetailHistory({ mode: 'push' });
    search.setCourseDetailTab('grades');
    search.selectDetailSection('10869', false);

    assert.deepEqual(historyCalls.map(call => call.mode), ['push', 'replace', 'replace']);
    const opened = new URL(historyCalls[0].url, 'http://127.0.0.1:8765');
    assert.equal(opened.searchParams.get('q'), 'machine learning');
    assert.equal(opened.searchParams.get('open'), '1');
    assert.equal(opened.searchParams.get('course'), 'CSCE 145');
    assert.equal(historyCalls[0].state.detailParent, '/?tab=search&term=202608&q=machine+learning&open=1');
    const final = new URL(location.href);
    assert.equal(final.searchParams.get('course'), 'CSCE 145');
    assert.equal(final.searchParams.get('crn'), '10869');
    assert.equal(final.searchParams.get('panel'), 'grades');
    assert.equal(history.state.detailParent, historyCalls[0].state.detailParent);
});

test('Course detail tab changes preserve the detail pane scroll position', () => {
    const animationFrames = [];
    const scrollContainer = {
        clientHeight: 800,
        getBoundingClientRect: () => ({ top: 0 }),
        isConnected: true,
        scrollTop: 640,
    };
    const panelHost = {
        getBoundingClientRect: () => ({ top: 180 }),
        offsetTop: 820,
        style: {},
    };
    const focusCalls = [];
    const tabs = ['overview', 'grades', 'history', 'resources'].map(tab => ({
        dataset: { courseTab: tab },
        focus(options) {
            focusCalls.push({ options, tab });
            if (!options?.preventScroll) scrollContainer.scrollTop = 0;
        },
        setAttribute(name, value) { this[name] = value; },
        tabIndex: -1,
    }));
    const panels = ['overview', 'grades', 'history', 'resources'].map(tab => {
        let hidden = tab !== 'overview';
        return {
            dataset: { coursePanel: tab },
            get hidden() { return hidden; },
            set hidden(value) {
                hidden = value;
                if (tab === 'overview' && value) scrollContainer.scrollTop = 0;
            },
        };
    });
    const search = loadObject('static/js/search.js', 'Search', {
        document: {
            getElementById: id => id === 'semester-content' ? scrollContainer : null,
            querySelector: selector => selector === '.course-detail-panels' ? panelHost : null,
            querySelectorAll(selector) {
                if (selector === '[data-course-tab]') return tabs;
                if (selector === '[data-course-panel]') return panels;
                return [];
            },
        },
        requestAnimationFrame: callback => animationFrames.push(callback),
    });
    search._browseState = 'detail';
    search._detailTab = 'overview';
    search.loadCourseDetailTab = () => {};
    search.writeCourseDetailHistory = () => {};

    search.setCourseDetailTab('history', true);
    animationFrames.splice(0).forEach(callback => callback());

    assert.equal(scrollContainer.scrollTop, 640);
    assert.equal(panelHost.style.minHeight, '800px');
    assert.equal(focusCalls.length, 1);
    assert.equal(focusCalls[0].tab, 'history');
    assert.equal(focusCalls[0].options.preventScroll, true);
    assert.equal(
        tabs.find(tab => tab.dataset.courseTab === 'history')['aria-selected'],
        'true',
    );
    assert.equal(panels.find(panel => panel.dataset.coursePanel === 'overview').hidden, true);
    assert.equal(panels.find(panel => panel.dataset.coursePanel === 'history').hidden, false);
});

test('A refreshed course detail URL restores its term, section, and active panel', async () => {
    const location = {
        href: 'http://127.0.0.1:8765/?tab=search&term=202608&course=CSCE%20145&crn=10869&panel=grades',
        pathname: '/',
        search: '?tab=search&term=202608&course=CSCE%20145&crn=10869&panel=grades',
    };
    const termSelect = {
        value: '',
        querySelector(selector) {
            return selector === 'option[value="202608"]' ? {} : null;
        },
    };
    const input = { value: '' };
    const group = {
        code: 'CSCE 145',
        sections: [{ code: 'CSCE 145', crn: '10869', stat: 'A' }],
    };
    const events = [];
    const state = { term: '202601', courseGroups: [] };
    const search = loadObject('static/js/search.js', 'Search', {
        URL,
        window: { location },
        State: state,
        API: { shouldRefreshAfterReload() { return false; } },
        Tabs: { switchTo(tab) { events.push(`tab:${tab}`); } },
        document: {
            getElementById(id) {
                return id === 'term-select' ? termSelect : null;
            },
        },
    });
    let shown;
    search.applyFiltersFromLocation = () => events.push('filters');
    search.activeSearchInput = () => input;
    search.doSearch = async options => events.push(`search:${options.historyMode}`);
    search.courseDetailGroup = async (code, crn) => {
        events.push(`detail:${code}:${crn}`);
        return group;
    };
    search.showCourseDetail = (detailGroup, options) => { shown = { detailGroup, options }; };

    await search.restoreFromLocation({ initial: true });

    assert.equal(state.term, '202608');
    assert.equal(termSelect.value, '202608');
    assert.equal(input.value, 'CSCE 145');
    assert.equal(search._directSearchOnce, true);
    assert.deepEqual(events, [
        'filters',
        'tab:semester',
        'search:none',
        'detail:CSCE 145:10869',
    ]);
    assert.equal(shown.detailGroup, group);
    assert.equal(shown.options.sectionCrn, '10869');
    assert.equal(shown.options.panel, 'grades');
    assert.equal(shown.options.historyMode, 'none');
    assert.equal(search._restoringHistory, false);
});

test('A new search cancels a pending course-detail URL restoration', async () => {
    const location = {
        href: 'http://127.0.0.1:8765/?tab=search&term=202608&course=CSCE%20145&crn=10869',
        pathname: '/',
        search: '?tab=search&term=202608&course=CSCE%20145&crn=10869',
    };
    const input = { value: '' };
    let releaseRestoration;
    const restorationSearch = new Promise(resolve => { releaseRestoration = resolve; });
    let detailOpenCount = 0;
    const search = loadObject('static/js/search.js', 'Search', {
        URL,
        window: { location },
        State: { term: '202608', courseGroups: [] },
        API: { shouldRefreshAfterReload() { return false; } },
        Tabs: { switchTo() {} },
        document: { getElementById() { return null; } },
    });
    search.applyFiltersFromLocation = () => {};
    search.activeSearchInput = () => input;
    search.doSearch = ({ historyMode = 'push' } = {}) => (
        historyMode === 'none' ? restorationSearch : Promise.resolve()
    );
    search.courseDetailGroup = async () => ({
        code: 'CSCE 145',
        sections: [{ code: 'CSCE 145', crn: '10869', stat: 'A' }],
    });
    search.showCourseDetail = () => { detailOpenCount += 1; };

    const restoration = search.restoreFromLocation();
    await Promise.resolve();
    input.value = 'MATH 141';
    await search.submitSearch();
    releaseRestoration();
    await restoration;

    assert.equal(detailOpenCount, 0);
});

test('Back to the main search skips a related-search course detail entry', () => {
    const movements = [];
    const search = loadObject('static/js/search.js', 'Search', {
        history: {
            state: { courseDetail: true, detailFromRelatedSearch: true },
            go(distance) { movements.push(distance); },
            back() { movements.push(-1); },
        },
    });

    search.returnToMainSearch();

    assert.deepEqual(movements, [-2]);
});

test('Scheduler course details navigate through Search and preserve its detail route flow', async () => {
    const input = { value: '' };
    const staleGroup = {
        code: 'CSCE 145',
        sections: [{ code: 'CSCE 145', crn: '10868' }],
    };
    const freshGroup = {
        code: 'CSCE 145',
        sections: [{ code: 'CSCE 145', crn: '10869' }],
    };
    const events = [];
    const search = loadObject('static/js/search.js', 'Search', {
        State: { courseGroups: [freshGroup] },
    });
    let detail;
    search.activeSearchInput = () => input;
    search.doSearch = async options => { events.push(`search:${options.historyMode}`); };
    search.showCourseDetail = (group, options) => {
        detail = { group, options };
        events.push('detail');
    };
    const modal = { close() { events.push('modal'); } };
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {
        window: { AppModal: modal },
        AppModal: modal,
        Tabs: { switchTo(tab) { events.push(`tab:${tab}`); } },
        Search: search,
        document: { getElementById() { return null; } },
    });

    await scheduler.openCourseInBrowse(staleGroup);

    assert.deepEqual(events, ['modal', 'tab:semester', 'search:push', 'detail']);
    assert.equal(input.value, 'CSCE 145');
    assert.equal(detail.group, freshGroup);
    assert.equal(detail.options.historyMode, 'push');
});

test('Scheduler detail navigation preserves an exact section excluded by active filters', async () => {
    let viewed = null;
    const keyword = { value: '' };
    const State = {
        courseGroups: [{
            code: 'CSCE 145',
            title: 'Algorithmic Design I',
            sections: [{ crn: '10001', section: '001', stat: 'A' }],
        }],
    };
    const search = loadObject('static/js/search.js', 'Search', {
        State,
        document: { getElementById: id => (id === 'keyword-input' ? keyword : null) },
    });
    search.doSearch = async () => {};
    search.showCourseDetail = (group, options) => { viewed = { group, options }; };

    await search.openCourseFromExternal({
        code: 'CSCE 145',
        title: 'Algorithmic Design I',
        sections: [{ crn: '10002', section: '002', stat: 'C' }],
    }, '10002');

    assert.equal(keyword.value, 'CSCE 145');
    assert.equal(viewed.options.sectionCrn, '10002');
    assert.deepEqual(
        Array.from(viewed.group.sections, section => section.crn),
        ['10001', '10002'],
    );
});

test('Top-level tab history preserves Search when returning to an unparameterized page', () => {
    const location = {
        href: 'http://127.0.0.1:8765/',
        pathname: '/',
        search: '',
    };
    const historyCalls = [];
    const history = {
        state: { tab: 'semester' },
        pushState(state, _title, url) { historyCalls.push({ state, url }); },
        replaceState(state, _title, url) { historyCalls.push({ state, url, replace: true }); },
    };
    const tabs = loadObject('static/js/tabs.js', 'Tabs', {
        State: { term: '202608' },
        URL,
        window: { location },
        history,
        localStorage: { setItem() {}, getItem() { return null; } },
        document: {
            querySelectorAll() { return []; },
            querySelector() { return null; },
            getElementById() { return null; },
            dispatchEvent() {},
        },
        CustomEvent: class {},
    });

    tabs.switchTo('schedule');
    assert.equal(historyCalls[0].state.tab, 'schedule');
    assert.equal(historyCalls[0].url, '/?tab=schedule&term=202608');
    history.state = { tab: 'semester' };
    tabs.restoreFromLocation();
    assert.equal(tabs.current(), 'semester');
});

test('Changing terms does not run a hidden Search query from another tab', () => {
    const html = fs.readFileSync('static/index.html', 'utf8');

    assert.match(html, /if \(Tabs\.current\(\) === 'semester'\) \{[\s\S]*Search\.doSearch\(\);[\s\S]*\} else \{[\s\S]*Tabs\.writeTabHistory\(Tabs\.current\(\), 'replace'\);/);
});

test('Direct search ignores stale prerequisite completions and errors', () => {
    const source = fs.readFileSync('static/js/search.js', 'utf8');
    const prereqLoad = source.indexOf('? await this.loadPrereqsForResults(results)');
    const render = source.indexOf('this.renderAndCacheSearch(', prereqLoad);
    const staleGuard = source.lastIndexOf('if (searchId !== this._searchId) return;', render);
    const catchStart = source.indexOf('} catch (err) {', render);

    assert.ok(prereqLoad > 0 && render > prereqLoad);
    assert.ok(staleGuard > prereqLoad && staleGuard < render);
    assert.match(source.slice(catchStart, catchStart + 180), /if \(searchId !== this\._searchId\) return;/);
});

test('Course and professor close controls remain available while scrolling', () => {
    const source = fs.readFileSync('static/js/grades.js', 'utf8');
    const styles = fs.readFileSync('static/css/style.css', 'utf8');

    assert.match(styles, /\.course-detail-header-sticky\s*{[^}]*position:\s*sticky;/s);
    assert.match(styles, /\.course-detail-header-sticky \.browse-close-details\s*{[^}]*position:\s*absolute;/s);
    assert.match(styles, /\.browse-close-details:hover,[\s\S]*background:\s*#FFFFFF;[\s\S]*color:\s*#73000A;/);
    assert.match(styles, /#modal\.professor-profile-modal #modal-close\s*{[^}]*height:\s*44px;[^}]*position:\s*sticky;/s);
    assert.match(source, /openProfessorLoading\(name/);
    assert.match(source, /professorDetailContextIsCurrent/);
});

test('Course detail fills its pane and uses visual section, grade, and history summaries', () => {
    const search = fs.readFileSync('static/js/search.js', 'utf8');
    const grades = fs.readFileSync('static/js/grades.js', 'utf8');
    const history = fs.readFileSync('static/js/history.js', 'utf8');
    const styles = fs.readFileSync('static/css/style.css', 'utf8');
    const gradeStyles = fs.readFileSync('static/css/grades.css', 'utf8');

    assert.match(styles, /\.course-detail-shell\s*{[^}]*max-width:\s*none;[^}]*width:\s*100%;/s);
    assert.match(search, /renderSectionCalendar\(section, details/);
    assert.match(search, /WalkingMap\.resolveBuilding/);
    assert.match(search, /L\.marker\(\[building\.lat, building\.lon\]/);
    assert.match(search, /const bounds = L\.latLngBounds\(\[\]\)/);
    assert.match(search, /this\._detailMap\.fitBounds\(bounds, \{ maxZoom: 17, padding: \[32, 32\] \}\)/);
    assert.match(search, /button\.tabIndex = selected \? 0 : -1/);
    assert.match(search, /handleSectionPickerKeydown\(event\)/);
    assert.match(search, /selectedButton\?\.scrollIntoView\(\{ block: 'nearest', inline: 'center' \}\)/);
    assert.match(search, /Course description is unavailable\./);
    assert.match(search, /details\.section_coreqs/);
    assert.match(search, /details\.registration_restrictions/);
    assert.match(grades, /class="grade-distribution-plot"/);
    assert.doesNotMatch(grades, /class="grade-exact-grid"/);
    assert.match(gradeStyles, /\.grade-distribution-bar-wrap i\s*{[^}]*background:\s*#73000A;/s);
    assert.doesNotMatch(history, /View instructors and term details/);
    assert.doesNotMatch(history, /term\.instructors \|\|/);
});

test('Offering history uses one aggregate request and ignores stale loads', async () => {
    const container = { innerHTML: '' };
    const styles = fs.readFileSync('static/css/style.css', 'utf8');
    const pending = new Map();
    const progressCallbacks = new Map();
    const calls = [];
    const document = {
        getElementById: id => id === 'history-container' ? container : null,
        createElement() {
            let value = '';
            return {
                set textContent(text) { value = String(text); },
                get innerHTML() {
                    return value
                        .replaceAll('&', '&amp;')
                        .replaceAll('<', '&lt;')
                        .replaceAll('>', '&gt;')
                        .replaceAll('"', '&quot;');
                },
            };
        },
    };
    const history = loadObject('static/js/history.js', 'History', {
        API: {
            getHistory(code, onProgress) {
                calls.push(code);
                progressCallbacks.set(code, onProgress);
                return new Promise(resolve => pending.set(code, resolve));
            },
            getDetails() { throw new Error('Per-section history request should not run'); },
            searchCourses() { throw new Error('Per-term history request should not run'); },
        },
        State: { term: '202708' },
        document,
    });
    history._activeTerm = () => '202708';

    const first = history.loadForCourse('CSCE 145');
    assert.deepEqual(calls, ['CSCE 145']);
    assert.match(container.innerHTML, /role="progressbar"/);
    assert.match(container.innerHTML, /aria-valuemin="0"/);
    assert.match(container.innerHTML, /aria-valuemax="100"/);
    assert.doesNotMatch(container.innerHTML, /aria-valuenow=/);
    assert.match(container.innerHTML, /role="status" aria-live="polite" aria-atomic="true"/);
    assert.match(container.innerHTML, /Loading offering history/);
    assert.match(container.innerHTML, /Connecting to offering records/);
    assert.match(styles, /\.history-loading-card\s*{[^}]*border:\s*1px solid #000000;/s);
    assert.match(styles, /@media \(prefers-reduced-motion:\s*reduce\)/);

    progressCallbacks.get('CSCE 145')({
        phase: 'terms',
        completed: 3,
        total: 8,
        label: 'Fall 2024',
    });
    assert.match(container.innerHTML, /3 of 8 terms checked/);
    assert.match(container.innerHTML, /38%/);
    assert.match(container.innerHTML, /aria-valuenow="38"/);
    assert.match(container.innerHTML, /Checking Fall 2024/);

    progressCallbacks.get('CSCE 145')({
        phase: 'enrollment',
        completed: 3,
        total: 8,
        label: 'Fall 2024',
        section: 2,
        section_total: 5,
    });
    assert.match(container.innerHTML, /Reading enrollment for Fall 2024 · 2 of 5 sections/);

    const second = history.loadForCourse('CSCE 146');
    assert.deepEqual(calls, ['CSCE 145', 'CSCE 146']);
    progressCallbacks.get('CSCE 145')({
        phase: 'terms',
        completed: 7,
        total: 8,
        label: 'Spring 2026',
    });
    assert.match(container.innerHTML, /CSCE 146/);
    assert.doesNotMatch(container.innerHTML, /Spring 2026|88%/);
    progressCallbacks.get('CSCE 146')({
        phase: 'terms',
        completed: 4,
        total: 8,
        label: 'Spring 2025',
    });
    assert.match(container.innerHTML, /4 of 8 terms checked/);
    assert.match(container.innerHTML, /50%/);
    pending.get('CSCE 146')({
        code: 'CSCE 146',
        as_of_term: '202708',
        terms: [{
            term: '202601',
            label: 'Spring 2026',
            available: true,
            complete: true,
            offered: true,
            sections: 2,
        }],
    });
    await second;
    assert.match(container.innerHTML, /Spring 2026/);
    const currentMarkup = container.innerHTML;

    pending.get('CSCE 145')({
        code: 'CSCE 145',
        as_of_term: '202708',
        terms: [{
            term: '202508',
            label: 'Fall 2025',
            available: true,
            complete: true,
            offered: true,
            sections: 1,
        }],
    });
    await first;
    assert.equal(container.innerHTML, currentMarkup);
    assert.doesNotMatch(container.innerHTML, /Fall 2025/);
});

test('Offering history applies the earlier boundary and renders API errors safely', async () => {
    const container = { innerHTML: '' };
    const document = {
        getElementById: id => id === 'history-container' ? container : null,
        createElement() {
            let value = '';
            return {
                set textContent(text) { value = String(text); },
                get innerHTML() {
                    return value
                        .replaceAll('&', '&amp;')
                        .replaceAll('<', '&lt;')
                        .replaceAll('>', '&gt;')
                        .replaceAll('"', '&quot;');
                },
            };
        },
    };
    const history = loadObject('static/js/history.js', 'History', {
        API: { getHistory: async () => { throw new Error('<script>unsafe</script>'); } },
        State: { term: '202708' },
        document,
    });
    history._activeTerm = () => '202608';

    assert.equal(history._historyBoundary('202605'), '202605');
    assert.equal(history._historyBoundary('202801'), '202608');
    history.render({
        as_of_term: '202605',
        terms: [
            { term: '202501', label: 'Spring 2025', complete: true, available: true, offered: true, sections: 1 },
            { term: '202605', label: 'Summer 2026', complete: true, available: true, offered: true, sections: 1 },
        ],
    }, container);
    assert.match(container.innerHTML, /Spring 2025/);
    assert.doesNotMatch(container.innerHTML, /Summer 2026/);

    await history.loadForCourse('CSCE 145');
    assert.match(container.innerHTML, /role="alert"/);
    assert.match(container.innerHTML, /temporarily unavailable/);
    assert.doesNotMatch(container.innerHTML, /script|unsafe/);
});

test('Professor names use the first comma as the sole first and last name delimiter', () => {
    const grades = loadObject('static/js/grades.js', 'Grades', {});

    assert.equal(grades.displayProfessorName('KANAPALA, NEEMA'), 'NEEMA KANAPALA');
    assert.equal(grades.displayProfessorName('DE LA CRUZ, MARIA JOSE'), 'MARIA JOSE DE LA CRUZ');
    assert.equal(grades.displayProfessorName('Mary Ann Smith'), 'Mary Ann Smith');
});

test('surname-only live instructor labels resolve one unique historical professor', async () => {
    const grades = loadObject('static/js/grades.js', 'Grades', {
        Search: {
            _detailToken: 7,
            _detailGroup: { code: 'CSCE 145' },
            _browseState: 'detail',
        },
        window: { AppModal: { version: 3 } },
    });
    let selected = null;
    let unmatched = null;
    grades.openProfessorLoading = () => {};
    grades.courseData = async () => ({
        instructors: [
            { id: 'prof_kanapala', name: 'Kanapala, Neema', average_gpa: 3.04 },
            { id: 'prof_hoskins', name: 'Hoskins, William', average_gpa: 3.35 },
        ],
    });
    grades.showProfessor = (id, context) => { selected = { id, context }; };
    grades.showUnmatchedProfessor = (name, email) => { unmatched = { name, email }; };

    await grades.showProfessorForCourseName('CSCE 145', 'Kanapala', 'neema@cse.sc.edu');

    assert.equal(unmatched, null);
    assert.equal(selected.id, 'prof_kanapala');
    assert.equal(selected.context.displayName, 'Kanapala');
    assert.equal(selected.context.email, 'neema@cse.sc.edu');
    assert.equal(selected.context.currentCourse, 'CSCE 145');
});

test('surname-only professor matching refuses ambiguous historical records', async () => {
    const grades = loadObject('static/js/grades.js', 'Grades', {
        Search: {
            _detailToken: 8,
            _detailGroup: { code: 'TEST 101' },
            _browseState: 'detail',
        },
        window: { AppModal: { version: 4 } },
    });
    let selected = null;
    let unmatched = null;
    grades.openProfessorLoading = () => {};
    grades.courseData = async () => ({
        instructors: [
            { id: 'prof_alex', name: 'Smith, Alex', average_gpa: 3.2 },
            { id: 'prof_jordan', name: 'Smith, Jordan', average_gpa: 3.8 },
        ],
    });
    grades.showProfessor = (id, context) => { selected = { id, context }; };
    grades.showUnmatchedProfessor = (name, email) => { unmatched = { name, email }; };

    await grades.showProfessorForCourseName('TEST 101', 'Smith', '');

    assert.equal(selected, null);
    assert.deepEqual(unmatched, { name: 'Smith', email: '' });
});

test('surname fallback matches token boundaries instead of substrings', () => {
    const grades = loadObject('static/js/grades.js', 'Grades', {});
    const records = [
        { id: 'prof_hu', name: 'Hu, Ming' },
        { id: 'prof_huang', name: 'Huang, Lin' },
        { id: 'prof_li', name: 'Li, Wei' },
        { id: 'prof_franklin', name: 'Franklin, Tara' },
    ];

    assert.deepEqual(Array.from(grades.matchingProfessorRecords(records, 'Hu'), record => record.id), ['prof_hu']);
    assert.deepEqual(Array.from(grades.matchingProfessorRecords(records, 'Li'), record => record.id), ['prof_li']);
});

test('section professor lookup keeps a supplied stable ID ahead of same-name fallbacks', async () => {
    const grades = loadObject('static/js/grades.js', 'Grades', {
        Search: {
            _detailToken: 9,
            _detailGroup: { code: 'TEST 101' },
            _browseState: 'detail',
        },
        window: { AppModal: { version: 5 } },
    });
    let selected = null;
    let courseDataCalls = 0;
    grades.openProfessorLoading = () => {};
    grades.courseData = async () => {
        courseDataCalls += 1;
        return { instructors: [{ id: 'prof_old', name: 'Smith, Alex' }] };
    };
    grades.showProfessor = id => { selected = id; };
    grades.showUnmatchedProfessor = () => { throw new Error('stable ID should be used'); };

    await grades.showProfessorForCourseName(
        'TEST 101',
        'Smith, Alex',
        'alex@example.edu',
        'prof_current',
    );

    assert.equal(selected, 'prof_current');
    assert.equal(courseDataCalls, 0);
});

test('Professor profiles use alphabetical GPA rows and a full-year connected timeline', () => {
    const source = fs.readFileSync('static/js/grades.js', 'utf8');
    const styles = fs.readFileSync('static/css/grades.css', 'utf8');
    const html = fs.readFileSync('static/index.html', 'utf8');

    assert.match(source, /localeCompare\(String\(right\.code \|\| ''\), undefined, \{ numeric: true \}\)/);
    assert.match(source, /class="professor-course-gpa-dot/);
    assert.doesNotMatch(source, /<i><b style="width:\$\{width\}%"><\/b><\/i>/);
    assert.match(source, /class="professor-primary-gpa"/);
    assert.match(source, /class="professor-year-line"/);
    assert.match(source, /preserveAspectRatio="none"/);
    assert.match(source, /vector-effect="non-scaling-stroke"/);
    assert.doesNotMatch(source, /professor-year-segment/);
    assert.match(source, /\$\{point\.year\}: \$\{this\.formatGpa\(point\.gpa\)\} GPA/);
    assert.match(source, /\(point\.year - firstYear\) \* 90 \/ yearSpan/);
    assert.match(source, /Teaching span in available records/);
    assert.match(source, /currentFacultyForCourse\(code\)/);
    assert.match(source, /return `\$\{term\}:\$\{code\}:\$\{crns\.join\(','\)\}`/);
    assert.match(source, /const facultyKey = this\.courseFacultyKey\(code\)[\s\S]*this\.courseFacultyKey\(code\) !== facultyKey/);
    assert.match(fs.readFileSync('static/js/search.js', 'utf8'), /Grades\.refreshCourseFaculty\(group\.code\)/);
    assert.match(styles, /\.professor-year-line\s*{[^}]*stroke:\s*#73000A;[^}]*stroke-linecap:\s*butt;[^}]*stroke-linejoin:\s*miter;/s);
    assert.doesNotMatch(styles, /\.professor-year-segment/);
    assert.match(styles, /\.professor-year-plot\s*{[^}]*height:\s*clamp\(160px, 24vw, 210px\);/s);
    assert.match(styles, /\.professor-year-labels\s*{[^}]*border-left:\s*2px solid transparent;/s);
    assert.match(styles, /\.professor-year-point\s*{[^}]*border-radius:\s*50% !important;/s);
    assert.match(source, /class="professor-year-point" role="img" tabindex="0"/);
    assert.doesNotMatch(source, /<button[^>]*class="professor-year-point"/);
    assert.match(styles, /\.professor-year-point:focus\s*{/);
    assert.match(styles, /@media \(max-width: 520px\)[\s\S]*\.professor-year-label:not\(\.compact-visible\)/);
    assert.match(html, /update\(markup, options = \{\}\)/);
    assert.match(source, /AppModal\.update\(markup/);
    assert.match(source, /const professorId = instructor\?\.professorId \|\| instructor\?\.grade\?\.id/);
    assert.match(source, /!this\.professorDetailContextIsCurrent\(detailToken, detailCode\)\) return;/);
    assert.match(source, /data = await API\.getProfessorGrades\(professorId\)[\s\S]*if \(!data\)[\s\S]*this\.showUnmatchedProfessor\(context\.displayName \|\| 'Instructor', context\.email \|\| ''\)/);
});

test('Static catalog fallbacks never claim that an unverified course is not offered', () => {
    const source = fs.readFileSync('static/js/search.js', 'utf8');
    const styles = fs.readFileSync('static/css/style.css', 'utf8');
    assert.match(source, /availability_unknown[\s\S]*Live availability unavailable/);
    assert.match(source, /Live section totals unavailable/);
    assert.match(source, /LIVE SECTIONS UNAVAILABLE/);
    assert.match(source, /details\?\.hours[\s\S]*group\.sections\?\.\[0\]\?\.hours/);
    assert.match(styles, /\.course-availability\.unknown[\s\S]*#466A9F/);
});

test('Smart model startup skips nonexistent local model probes', () => {
    const source = fs.readFileSync('static/js/search.js', 'utf8');
    assert.match(source, /env\.allowLocalModels = false/);
});

test('Professor GPA timeline uses calendar-year spacing and an aligned zero-to-four scale', () => {
    const grades = loadObject('static/js/grades.js', 'Grades', {});
    const markup = grades.professorYearMarkup([
        { academic_year: 2018, average_gpa: 4 },
        { academic_year: 2020, average_gpa: 3 },
        { academic_year: 2024, average_gpa: 2 },
    ]);

    assert.match(markup, /left:5%;top:6%/);
    assert.match(markup, /left:35%;top:28%/);
    assert.match(markup, /left:95%;top:50%/);
    assert.match(markup, /class="professor-year-line" points="5,6 35,28 95,50"/);
    assert.doesNotMatch(markup, /professor-year-segment|stroke-dasharray/);
    assert.match(markup, /top:6%">4\.0/);
    assert.match(markup, /top:94%">0\.0/);
    assert.match(markup, /class="professor-year-gridline" x1="0" y1="28" x2="100" y2="28"/);
    assert.equal((markup.match(/class="professor-year-point"/g) || []).length, 3);
    assert.doesNotMatch(markup, /grid-template-columns/);
});

test('Professor GPA timeline plots values below one instead of pinning them to one', () => {
    const grades = loadObject('static/js/grades.js', 'Grades', {});
    const markup = grades.professorYearMarkup([
        { academic_year: 2021, average_gpa: 0.625 },
    ]);

    assert.match(markup, /left:50%;top:80\.25%/);
    assert.match(markup, /2021, 0\.63 GPA/);
    assert.doesNotMatch(markup, /class="professor-year-line"/);
});

test('Resources derive official section, bookstore, syllabus, and bulletin destinations safely', () => {
    const source = fs.readFileSync('static/js/search.js', 'utf8');
    const styles = fs.readFileSync('static/css/style.css', 'utf8');
    const search = loadObject('static/js/search.js', 'Search', { URL });

    assert.match(source, /action\.protocol !== 'https:'/);
    assert.match(source, /action\.hostname !== 'sc\.bncollege\.com'/);
    assert.match(source, /\|\| action\.port/);
    assert.match(source, /\['catalogId', 'storeId', 'termMapping', 'courseXml'\]/);
    assert.match(source, /form\.rel = 'noopener noreferrer'/);
    assert.match(source, /details&srcdb=\$\{encodeURIComponent\(this\._detailTerm \|\| State\.term\)\}&crn=/);
    const syllabus = new URL(search.syllabusResourceUrl('ACCT 222'));
    assert.equal(syllabus.pathname, '/syllabusarchive/studentcourselist.php');
    assert.equal(syllabus.searchParams.get('designator'), 'ACCT');
    assert.equal(syllabus.searchParams.get('courseNumber'), '222');
    assert.equal(syllabus.searchParams.get('instructor'), '');
    assert.equal(syllabus.searchParams.get('term'), 'all');
    assert.equal(search.syllabusSignInUrl(), 'https://www.sc.edu/syllabusarchive');
    assert.equal(
        search.rateMyProfessorsUrl('Hu, Ming'),
        'https://www.ratemyprofessors.com/search/professors/1309?q=Ming+Hu',
    );
    assert.equal(
        search.rateMyProfessorsUrl('De la Cruz, Ana Maria'),
        'https://www.ratemyprofessors.com/search/professors/1309?q=Ana+Maria+De+la+Cruz',
    );
    assert.equal(
        search.rateMyProfessorsUrl('Ming Hu'),
        'https://www.ratemyprofessors.com/search/professors/1309?q=Ming+Hu',
    );
    const bulletin = new URL(search.bulletinResourceUrl('CSCE 883'));
    assert.equal(bulletin.origin, 'https://academicbulletins.sc.edu');
    assert.equal(bulletin.pathname, '/search/');
    assert.equal(bulletin.searchParams.get('P'), 'CSCE 883');
    assert.match(source, /https:\/\/sc\.edu\/about\/directory\//);
    assert.match(source, /class="course-resource-syllabus"/);
    assert.match(source, /Sign in to the archive/);
    assert.match(source, /try step 2 again/);
    assert.match(source, /ratemyprofessors\.com\/search\/professors\/1309\?q=/);
    assert.match(source, /class="course-resource-layout"/);
    assert.doesNotMatch(source, /class="course-resource-card"/);
    assert.doesNotMatch(source, /course-resource-group-heading/);
    assert.match(styles, /\.course-resource-layout\s*{[^}]*grid-template-columns:/s);
    assert.match(styles, /\.course-resource-link\s*{[^}]*font-weight:\s*400;/s);
    assert.match(styles, /\.course-resource-link small\s*{[^}]*font-weight:\s*400;/s);
    assert.match(styles, /\.course-resource-link > b\s*{[^}]*font-weight:\s*700;/s);
    assert.match(styles, /\.course-resource-link:hover/);
    assert.match(source, /primaryFaculty\?\.professor_id/);
    assert.doesNotMatch(source, /uscbookstore\.com/);
    assert.doesNotMatch(source, /Official course information and useful searches open in a new tab/);
});

test('Course detail sections sort open first and naturally within availability groups', () => {
    const search = loadObject('static/js/search.js', 'Search', {});
    const group = {
        sections: [
            { crn: '4', section: '010', stat: 'C' },
            { crn: '3', section: '002', stat: 'C' },
            { crn: '2', section: '011', stat: 'A' },
            { crn: '1', section: '003', stat: 'A' },
        ],
    };

    assert.deepEqual(
        Array.from(search.sortedDetailSections(group), section => `${section.stat}:${section.section}`),
        ['A:003', 'A:011', 'C:002', 'C:010'],
    );
    assert.deepEqual(group.sections.map(section => section.crn), ['4', '3', '2', '1']);
});

test('Course detail section ordering preserves the active section for keyboard users', () => {
    const picker = {
        innerHTML: '',
        querySelectorAll() { return []; },
    };
    const elements = {
        'course-section-picker-wrap': { hidden: true },
        'course-section-picker': picker,
        'course-section-picker-count': { textContent: '' },
    };
    const document = {
        getElementById(id) { return elements[id] || null; },
        createElement() {
            const element = { innerHTML: '' };
            Object.defineProperty(element, 'textContent', {
                set(value) { element.innerHTML = String(value); },
            });
            return element;
        },
    };
    const search = loadObject('static/js/search.js', 'Search', { document });
    search._detailGroup = {
        sections: [
            { crn: '10', section: '010', stat: 'C', meets: 'TBA', instr: 'Staff' },
            { crn: '2', section: '002', stat: 'A', meets: 'MW', instr: 'Hu, Ming' },
            { crn: '1', section: '001', stat: 'A', meets: 'TTh', instr: 'Staff' },
        ],
    };
    search._detailSectionCrn = '10';

    search.renderDetailSections();

    assert.ok(picker.innerHTML.indexOf('data-detail-crn="1"') < picker.innerHTML.indexOf('data-detail-crn="2"'));
    assert.ok(picker.innerHTML.indexOf('data-detail-crn="2"') < picker.innerHTML.indexOf('data-detail-crn="10"'));
    assert.match(picker.innerHTML, /data-detail-crn="10" aria-pressed="true" tabindex="0"/);
    assert.match(picker.innerHTML, /data-detail-crn="1" aria-pressed="false" tabindex="-1"/);
});

test('Professor profile review links use the UofSC Rate My Professors school search', () => {
    const grades = loadObject('static/js/grades.js', 'Grades', {});

    assert.equal(
        grades.rateMyProfessorsUrl('Hu, Ming'),
        'https://www.ratemyprofessors.com/search/professors/1309?q=Ming+Hu',
    );
    const markup = grades.professorMarkup({ name: 'Hu, Ming', courses: [], years: [] });
    assert.match(markup, /href="https:\/\/www\.ratemyprofessors\.com\/search\/professors\/1309\?q=Ming\+Hu"/);
});

test('Course identity and actions stay together in a sticky black header', () => {
    const html = fs.readFileSync('static/index.html', 'utf8');
    const source = fs.readFileSync('static/js/search.js', 'utf8');
    const styles = fs.readFileSync('static/css/style.css', 'utf8');

    assert.match(html, /class="course-detail-header-sticky"[\s\S]*id="browse-close-details"[\s\S]*id="tab-details"/);
    assert.match(html, /id="course-detail-description-wrap"/);
    assert.match(source, /class="course-detail-header-topline"[\s\S]*class="course-detail-header-controls"[\s\S]*class="course-detail-credit"/);
    assert.match(source, /id="btn-course-toggle"[\s\S]*id="btn-course-view-schedule"/);
    assert.match(source, /Tabs\.switchTo\('schedule'\)/);
    assert.match(source, /Section \$\{selectedSection\.section \|\| '—'\} · CRN \$\{selectedSection\.crn\}/);
    assert.match(styles, /\.course-detail-header-sticky\s*{[^}]*position:\s*sticky;[^}]*z-index:\s*1000;/s);
    assert.match(styles, /\.course-detail-header-sticky \.browse-close-details\s*{[^}]*position:\s*absolute;/s);
    assert.match(styles, /\.course-detail-tabs\s*{[^}]*position:\s*relative;/s);
    assert.match(styles, /\.course-detail-header-controls\s*{[^}]*overflow-x:\s*auto;/s);
    assert.match(styles, /\.course-detail-primary-actions\s*{[^}]*flex-wrap:\s*nowrap;/s);
});

test('Browse result cards lazily add descriptions and historical grades', () => {
    const source = fs.readFileSync('static/js/search.js', 'utf8');
    const styles = fs.readFileSync('static/css/style.css', 'utf8');

    assert.match(source, /new IntersectionObserver/);
    assert.match(source, /API\.getCourseGrades\(group\.code\)/);
    assert.match(source, /course-result-description/);
    assert.match(source, /historical GPA/);
    assert.match(styles, /\.course-result-description/);
    assert.match(styles, /\.course-result-grade/);
});

test('schedule course search paginates matches instead of discarding them', () => {
    const source = fs.readFileSync('static/js/scheduler.js', 'utf8');

    assert.doesNotMatch(source, /Object\.values\(groups\)\.slice\(0, 30\)/);
    assert.match(source, /_searchPageSize:\s*30/);
    assert.match(source, /SHOW \$\{increment\} MORE/);
    assert.match(source, /Search\.searchLiveCourses\(query\)/);
});

test('preview renders a candidate without replacing selected sections', () => {
    const original = { 'TEST 101': { crn: '10101' } };
    let rendered;
    let renderOptions;
    const state = {
        selectedSections: original,
        solverResults: [{ sections: { 'TEST 101': { crn: '10102' } } }],
    };
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {
        State: state,
        Calendar: { render(options) { rendered = state.selectedSections; renderOptions = options; } },
    });

    scheduler.previewSchedule(0);

    assert.equal(rendered['TEST 101'].crn, '10102');
    assert.equal(renderOptions.preview, true);
    assert.strictEqual(state.selectedSections, original);
    assert.equal(state.selectedSections['TEST 101'].crn, '10101');
});

test('calendar runs from 8 AM through 10 PM', () => {
    const calendar = loadObject('static/js/calendar.js', 'Calendar', {});

    assert.equal(calendar.START_HOUR, 8);
    assert.equal(calendar.END_HOUR, 22);
});

test('calendar expands to seven days only when a weekend meeting is present', () => {
    const calendar = loadObject('static/js/calendar.js', 'Calendar', {});
    const weekdaySections = [
        { meetingTimes: '[{"meet_day": 4, "start_time": 900, "end_time": 950}]' },
    ];
    const saturdaySections = [
        { meetingTimes: '[{"meet_day": 5, "start_time": 900, "end_time": 950}]' },
    ];
    const sundaySections = [
        { meetingTimes: '[{"meet_day": 6, "start_time": 900, "end_time": 950}]' },
    ];

    assert.equal(calendar.visibleDayCount(weekdaySections), 5);
    assert.equal(calendar.visibleDayCount(saturdaySections), 7);
    assert.equal(calendar.visibleDayCount(sundaySections), 7);
    assert.deepEqual(Array.from(calendar.DAY_LABELS), ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']);
});

test('preview calendar blocks are disabled and do not open course details', () => {
    const source = fs.readFileSync('static/js/calendar.js', 'utf8');

    assert.match(source, /block\.disabled = Boolean\(options\.preview\)/);
    assert.match(source, /if \(!options\.preview\) \{\s*block\.addEventListener\('click'/s);
});

test('hovering a schedule option previews it and leaving restores the calendar', () => {
    const listeners = {};
    const classes = new Set();
    const card = {
        dataset: { idx: '0' },
        addEventListener(type, listener) { listeners[type] = listener; },
        classList: {
            add(value) { classes.add(value); },
            remove(value) { classes.delete(value); },
        },
    };
    const container = { querySelectorAll: () => [card] };
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {
        State: { solverResults: [{ sections: { 'TEST 101': { crn: '10102' } } }], selectedSections: {} },
    });
    let previewed = null;
    let cleared = false;
    let applied = null;
    scheduler.previewSchedule = index => { previewed = index; };
    scheduler.clearSchedulePreview = () => { cleared = true; };
    scheduler.applySchedule = index => { applied = index; };

    scheduler.bindScheduleCardPreview(card, container);
    listeners.mouseenter();

    assert.equal(previewed, 0);
    assert.equal(classes.has('selected'), true);

    listeners.mouseleave();

    assert.equal(cleared, true);
    assert.equal(classes.has('selected'), false);

    listeners.click({ target: card });

    assert.equal(applied, 0);
});

test('scrolling schedule options previews the card under a stationary pointer', () => {
    const classes = new Set();
    const card = {
        dataset: { idx: '1' },
        classList: {
            add(value) { classes.add(value); },
            remove(value) { classes.delete(value); },
        },
    };
    const otherCard = { classList: { remove() {} } };
    const target = { closest: selector => selector === '.schedule-card' ? card : null };
    const container = {
        contains: element => element === card,
        querySelectorAll: () => [otherCard, card],
    };
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {
        document: { elementFromPoint: () => target },
        State: { solverResults: [{}, {}], selectedSections: {} },
    });
    let previewed;
    scheduler.isAppliedSchedule = () => false;
    scheduler.previewSchedule = index => { previewed = index; };

    const result = scheduler.previewScheduleAtPoint(container, 100, 200);

    assert.equal(result, 1);
    assert.equal(previewed, 1);
    assert.equal(classes.has('selected'), true);
});

test('schedule scrolling reevaluates hover on every animation frame', () => {
    const source = fs.readFileSync('static/js/scheduler.js', 'utf8');

    assert.match(source, /addEventListener\('scroll', \(\) =>/);
    assert.match(source, /previewFrame = requestAnimationFrame\(\(\) =>/);
    assert.match(source, /document\.elementFromPoint\(clientX, clientY\)/);
    assert.match(source, /this\.previewScheduleAtPoint\(container, pointer\.x, pointer\.y\)/);
});

test('applied schedule matching compares every selected CRN', () => {
    const state = {
        selectedSections: {
            'TEST 101': { crn: '10101' },
            'TEST 102': { crn: '10201' },
        },
    };
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', { State: state });

    assert.equal(scheduler.isAppliedSchedule({
        sections: {
            'TEST 101': { crn: '10101' },
            'TEST 102': { crn: '10201' },
        },
    }), true);
    assert.equal(scheduler.isAppliedSchedule({
        sections: {
            'TEST 101': { crn: 'different' },
            'TEST 102': { crn: '10201' },
        },
    }), false);
});

test('schedule card containers do not disable or trap their interactive children', () => {
    const source = fs.readFileSync('static/js/scheduler.js', 'utf8');

    assert.match(source, /card\.removeAttribute\('aria-disabled'\)/);
    assert.match(source, /card\.removeAttribute\('tabindex'\)/);
    assert.doesNotMatch(source, /card\.setAttribute\('aria-disabled', String\(applied\)\)/);
    assert.match(source, /button\.disabled = applied/);
});

test('switching day patterns clears only automatic blocks', () => {
    function cell(day, manuallyBlocked = false) {
        const classes = new Set(manuallyBlocked ? ['blocked'] : []);
        return {
            dataset: { day: String(day) },
            classList: {
                add(value) { classes.add(value); },
                remove(value) { classes.delete(value); },
                contains(value) { return classes.has(value); },
            },
        };
    }

    const cells = [cell(0), cell(1, true), cell(2), cell(3), cell(4)];
    const preferences = loadObject('static/js/preferences.js', 'Preferences', {
        document: { querySelectorAll: () => cells },
        State: {},
    });
    preferences.updateBlockedTimes = () => {};

    preferences.setDayPreference([1, 3]);
    preferences.setDayPreference([0, 2, 4]);

    assert.equal(cells[0].classList.contains('blocked'), true);
    assert.equal(cells[1].classList.contains('blocked'), true);
    assert.equal(cells[3].classList.contains('blocked'), false);
    assert.equal(cells[4].classList.contains('blocked'), true);
});

test('walking map defaults to the all-days view', () => {
    const walkingMap = loadObject('static/js/map.js', 'WalkingMap', {});

    assert.equal(walkingMap.selectedDay, 'all');
});

test('scheduler background location prefetch only includes usable campus sections', () => {
    const meetingTimes = '[{"meet_day":1,"start_time":900,"end_time":950}]';
    const State = {
        selectedCourses: {
            'TEST 101': {
                sections: [
                    { crn: 'open-campus', stat: 'A', meetingTimes },
                    { crn: 'full-campus', stat: 'C', meetingTimes },
                    { crn: 'online', stat: 'A', meetingTimes, inst_mthd: 'Online' },
                    { crn: 'tba', stat: 'A', meetingTimes: '' },
                ],
            },
            'TEST 202': {
                sections: [
                    { crn: 'locked-full', stat: 'C', meetingTimes },
                    { crn: 'unused-open', stat: 'A', meetingTimes },
                ],
            },
        },
        sectionLocks: { 'TEST 202': 'locked-full' },
    };
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', { State });

    const crns = Array.from(scheduler.locationPrefetchSections(), section => section.crn);

    assert.deepEqual(crns, ['open-campus', 'locked-full']);
    const source = fs.readFileSync('static/js/scheduler.js', 'utf8');
    assert.doesNotMatch(source, /API\.prefetchCourseDetails/);
    assert.match(source, /background: true/);
    assert.match(source, /foreground: true/);
});

test('walking map includes weekend meetings and term-specific section details', () => {
    const State = { term: '202608' };
    const walkingMap = loadObject('static/js/map.js', 'WalkingMap', { State });
    const section = {
        code: 'TEST 101',
        crn: '10001',
        meetingTimes: '[{"meet_day":5,"start_time":900,"end_time":950}]',
    };
    walkingMap.sectionDetails.set(walkingMap.sectionDetailKey(section), [{
        days: [5],
        start: 540,
        end: 590,
        rawLocation: 'Test Building 101',
        building: { kind: 'known', code: 'TEST', name: 'Test Building', lat: 34, lon: -81 },
    }]);

    assert.deepEqual(Array.from(walkingMap.DAYS.slice(-2)), ['Saturday', 'Sunday']);
    assert.equal(walkingMap.buildEvents([section], 5).length, 1);
    State.term = '202701';
    assert.equal(walkingMap.buildEvents([section], 5)[0].building.kind, 'unknown');
});

test('failed background location details are retried by the foreground', async () => {
    let calls = 0;
    const State = { term: '202608' };
    const section = { crn: '10001' };
    const walkingMap = loadObject('static/js/map.js', 'WalkingMap', {
        State,
        API: {
            async getDetails() {
                calls += 1;
                if (calls === 1) throw new Error('temporary failure');
                return { meeting_html: '' };
            },
        },
    });

    await walkingMap.hydrateSectionDetail(section);
    assert.equal(walkingMap.sectionDetails.has(walkingMap.sectionDetailKey(section)), false);
    await walkingMap.hydrateSectionDetail(section);

    assert.equal(calls, 2);
    assert.equal(walkingMap.sectionDetails.has(walkingMap.sectionDetailKey(section)), true);
});

test('background detail hydration pauses after consecutive failures and foreground bypasses backoff', async () => {
    let calls = 0;
    let recovered = false;
    const State = { term: '202608' };
    const sections = ['10001', '10002', '10003'].map(crn => ({
        crn,
        meetingTimes: '[{"meet_day":1,"start_time":900,"end_time":950}]',
    }));
    const walkingMap = loadObject('static/js/map.js', 'WalkingMap', {
        State,
        API: {
            async getDetails() {
                calls += 1;
                if (!recovered) throw new Error('temporary failure');
                return { meeting_html: '' };
            },
        },
    });

    const first = await walkingMap.hydrateSectionDetails(sections, {
        background: true,
        delayMs: 0,
        maxConsecutiveFailures: 2,
    });
    const second = await walkingMap.hydrateSectionDetails(sections, {
        background: true,
        delayMs: 0,
        maxConsecutiveFailures: 2,
    });

    assert.equal(calls, 2);
    assert.equal(first.failed, 2);
    assert.equal(first.stopped, true);
    assert.equal(second.attempted, 0);
    assert.equal(second.stopped, true);

    recovered = true;
    const foreground = await walkingMap.hydrateSectionDetails([sections[0]], {
        foreground: true,
        concurrency: 1,
    });

    assert.equal(calls, 3);
    assert.equal(foreground.loaded, 1);
    assert.equal(walkingMap.sectionDetails.has(walkingMap.sectionDetailKey(sections[0])), true);
});

test('location detail hydration skips online and unscheduled sections', async () => {
    let calls = 0;
    const State = { term: '202608' };
    const walkingMap = loadObject('static/js/map.js', 'WalkingMap', {
        State,
        API: {
            async getDetails() {
                calls += 1;
                return { meeting_html: '' };
            },
        },
    });
    const meetingTimes = '[{"meet_day":1,"start_time":900,"end_time":950}]';

    const summary = await walkingMap.hydrateSectionDetails([
        { crn: 'online', meetingTimes, inst_mthd: 'Online' },
        { crn: 'unscheduled', meetingTimes: '' },
        { crn: 'campus', meetingTimes, inst_mthd: 'Face-to-Face' },
    ], { foreground: true });

    assert.equal(calls, 1);
    assert.equal(summary.loaded, 1);
});

test('walking map explains processed selections that have no campus meetings', () => {
    const source = fs.readFileSync('static/js/map.js', 'utf8');

    assert.match(source, /All selected classes were processed, but none has a scheduled campus meeting to map/);
    assert.match(source, /No two selected classes meet consecutively on the same day/);
});

test('route interface uses neutral travel language', () => {
    const source = fs.readFileSync('static/js/map.js', 'utf8');
    const schedulerSource = fs.readFileSync('static/js/scheduler.js', 'utf8');

    assert.match(source, /Routes Between Classes/);
    assert.doesNotMatch(source, /Travel-time estimates currently use pedestrian routing/);
    assert.doesNotMatch(source, /walking-map-note/);
    assert.match(source, /min route/);
    assert.doesNotMatch(source, />Walking Between Classes</);
    assert.match(schedulerSource, /Extra time after walking between classes/);
    assert.match(schedulerSource, /Choose 10 to arrive at least ten minutes early/);
    assert.doesNotMatch(schedulerSource, /Classes outside this range remain available/);
    assert.doesNotMatch(schedulerSource, /Schedules using these days remain valid/);
});

test('walking map resolves Storey schedule labels to the official building', () => {
    const walkingMap = loadObject('static/js/map.js', 'WalkingMap', {});
    walkingMap.buildings = JSON.parse(fs.readFileSync('static/data/campus_buildings.json', 'utf8')).buildings;

    const resolved = walkingMap.resolveBuilding('Storey Eng & Innovation Ctr 1400');

    assert.equal(resolved.kind, 'known');
    assert.equal(resolved.code, 'INNOVA');
});

test('walking map resolves Science and Technology Banner labels', () => {
    const walkingMap = loadObject('static/js/map.js', 'WalkingMap', {});
    walkingMap.buildings = JSON.parse(fs.readFileSync('static/data/campus_buildings.json', 'utf8')).buildings;

    const resolved = walkingMap.resolveBuilding('Science and Technology Bldg 352');

    assert.equal(resolved.kind, 'known');
    assert.equal(resolved.code, '1112GR');
});

test('walking map resolves abbreviated Callcott Banner labels', () => {
    const walkingMap = loadObject('static/js/map.js', 'WalkingMap', {});
    walkingMap.buildings = JSON.parse(fs.readFileSync('static/data/campus_buildings.json', 'utf8')).buildings;

    const resolved = walkingMap.resolveBuilding('Callcot Soc Sci Ctr 011');

    assert.equal(resolved.kind, 'known');
    assert.equal(resolved.code, 'CLLCTT');
});

test('selecting a walking transition highlights its route and zooms the map', () => {
    function routeCard(index) {
        const classes = new Set();
        const attributes = {};
        return {
            dataset: { transitionIndex: String(index) },
            classList: {
                toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value); },
                contains(value) { return classes.has(value); },
            },
            setAttribute(name, value) { attributes[name] = value; },
            attributes,
        };
    }

    function routeLayer() {
        return {
            styles: [],
            broughtForward: false,
            setStyle(style) { this.styles.push(style); },
            bringToFront() { this.broughtForward = true; },
        };
    }

    const cards = [routeCard(0), routeCard(1)];
    const layers = [routeLayer(), routeLayer()];
    let fittedBounds;
    const walkingMap = loadObject('static/js/map.js', 'WalkingMap', {});
    walkingMap.listElement = { querySelectorAll: () => cards };
    walkingMap._currentTransitions = [
        { geometry: [[1, 1], [2, 2]] },
        { geometry: [[3, 3], [4, 4]] },
    ];
    walkingMap._routeLayers = layers.map(layer => ({
        layer,
        baseStyle: { color: '#73000A', weight: 5 },
    }));
    walkingMap._map = { fitBounds(bounds) { fittedBounds = bounds; } };

    walkingMap.focusTransition(1);

    assert.equal(cards[0].classList.contains('is-selected'), false);
    assert.equal(cards[1].classList.contains('is-selected'), true);
    assert.equal(cards[1].attributes['aria-pressed'], 'true');
    assert.equal(layers[1].styles.at(-1).color, '#73000A');
    assert.equal(layers[1].styles.at(-1).weight, 8);
    assert.equal(layers[1].broughtForward, true);
    assert.deepEqual(fittedBounds, [[3, 3], [4, 4]]);
});

test('hovering a walking transition previews its route and restores the overview', () => {
    function routeCard(index) {
        const classes = new Set();
        const attributes = {};
        return {
            dataset: { transitionIndex: String(index) },
            classList: {
                toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value); },
                contains(value) { return classes.has(value); },
            },
            setAttribute(name, value) { attributes[name] = value; },
            attributes,
        };
    }

    function routeLayer() {
        return {
            styles: [],
            setStyle(style) { this.styles.push(style); },
            bringToFront() {},
        };
    }

    const cards = [routeCard(0), routeCard(1)];
    const layers = [routeLayer(), routeLayer()];
    const fittedBounds = [];
    const walkingMap = loadObject('static/js/map.js', 'WalkingMap', {});
    walkingMap.listElement = { querySelectorAll: () => cards };
    walkingMap._currentTransitions = [
        { geometry: [[1, 1], [2, 2]] },
        { geometry: [[3, 3], [4, 4]] },
    ];
    walkingMap._routeLayers = layers.map(layer => ({
        layer,
        baseStyle: { color: '#73000A', weight: 5 },
    }));
    walkingMap._overviewView = { kind: 'bounds', value: [[0, 0], [5, 5]] };
    walkingMap._map = { fitBounds(bounds) { fittedBounds.push(bounds); } };

    walkingMap.previewTransition(0);

    assert.equal(cards[0].classList.contains('is-previewed'), true);
    assert.equal(cards[0].classList.contains('is-selected'), false);
    assert.equal(cards[0].attributes['aria-pressed'], 'false');
    assert.deepEqual(fittedBounds.at(-1), [[1, 1], [2, 2]]);

    walkingMap.clearTransitionPreview(0);

    assert.equal(cards[0].classList.contains('is-previewed'), false);
    assert.deepEqual(fittedBounds.at(-1), [[0, 0], [5, 5]]);
});

test('leaving a hover preview returns to the clicked walking route', () => {
    function routeCard(index) {
        const classes = new Set();
        return {
            dataset: { transitionIndex: String(index) },
            classList: {
                toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value); },
                contains(value) { return classes.has(value); },
            },
            setAttribute() {},
        };
    }

    const cards = [routeCard(0), routeCard(1)];
    const fittedBounds = [];
    const walkingMap = loadObject('static/js/map.js', 'WalkingMap', {});
    walkingMap.listElement = { querySelectorAll: () => cards };
    walkingMap._currentTransitions = [
        { geometry: [[1, 1], [2, 2]] },
        { geometry: [[3, 3], [4, 4]] },
    ];
    walkingMap._routeLayers = [0, 1].map(() => ({
        layer: { setStyle() {}, bringToFront() {} },
        baseStyle: { color: '#73000A', weight: 5 },
    }));
    walkingMap._map = { fitBounds(bounds) { fittedBounds.push(bounds); } };

    walkingMap.focusTransition(1);
    walkingMap.previewTransition(0);
    walkingMap.clearTransitionPreview(0);

    assert.equal(cards[1].classList.contains('is-selected'), true);
    assert.equal(cards[0].classList.contains('is-previewed'), false);
    assert.deepEqual(fittedBounds.at(-1), [[3, 3], [4, 4]]);
});

test('walking transition cards wire hover and keyboard previews', () => {
    const source = fs.readFileSync('static/js/map.js', 'utf8');

    assert.match(source, /addEventListener\('mouseenter', \(\) => this\.previewTransition\(index\)\)/);
    assert.match(source, /this\.listElement\.addEventListener\('mouseleave'/);
    assert.doesNotMatch(source, /card\.addEventListener\('mouseleave'/);
    assert.match(source, /addEventListener\('focus', \(\) => this\.previewTransition\(index\)\)/);
    assert.match(source, /addEventListener\('blur', event =>/);
});

test('transition cards and map routes share the same colors', () => {
    const walkingMap = loadObject('static/js/map.js', 'WalkingMap', {});
    const mondayTransition = { from: { day: 0 } };
    const tuesdayTransition = { from: { day: 1 } };

    walkingMap.selectedDay = 'all';
    assert.equal(walkingMap.routeColor(mondayTransition), '#73000A');
    assert.equal(walkingMap.routeColor(tuesdayTransition), '#466A9F');
    walkingMap.selectedDay = 1;
    assert.equal(walkingMap.routeColor(tuesdayTransition), '#73000A');

    const source = fs.readFileSync('static/js/map.js', 'utf8');
    const styles = fs.readFileSync('static/css/map.css', 'utf8');
    assert.match(source, /--transition-color', this\.routeColor\(transition\)/);
    assert.match(source, /color: this\.routeColor\(transition\)/);
    assert.match(styles, /\.walking-transition\.has-route\s*{[^}]*border-left-color:\s*var\(--transition-color\)/s);
});

test('online and same-building transitions use disabled no-route cards', () => {
    const walkingMap = loadObject('static/js/map.js', 'WalkingMap', {});
    const building = { kind: 'known', code: 'TEST', lat: 1, lon: 2 };

    assert.equal(walkingMap.transitionStatus({ kind: 'online' }).className, 'neutral');
    assert.equal(walkingMap.transitionStatus({ kind: 'same' }).label, 'Same building');

    const source = fs.readFileSync('static/js/map.js', 'utf8');
    const styles = fs.readFileSync('static/css/map.css', 'utf8');
    assert.match(source, /transition\.kind === 'online' \|\| transition\.kind === 'same'/);
    assert.match(source, /card\.classList\.add\('no-route-needed'\)/);
    assert.match(styles, /\.walking-transition\.no-route-needed\s*{[^}]*background:\s*#ECECEC/s);
    return walkingMap.routeBetween(building, building).then(route => {
        assert.equal(route.kind, 'same');
        assert.equal(route.geometry, null);
    });
});

test('route cache keys include catalog revision and coordinates', async () => {
    let calls = 0;
    const walkingMap = loadObject('static/js/map.js', 'WalkingMap', {
        fetch: async () => {
            calls += 1;
            return {
                ok: true,
                async json() {
                    return {
                        routes: [{
                            distance: 500,
                            duration: 300,
                            geometry: { coordinates: [[-81, 34], [-81.01, 34.01]] },
                        }],
                    };
                },
            };
        },
    });
    const from = { kind: 'known', code: 'FROM', lat: 34, lon: -81 };
    const to = { kind: 'known', code: 'TO', lat: 34.01, lon: -81.01 };
    walkingMap.catalogRevision = 'catalog-a';

    await walkingMap.routeBetween(from, to);
    await walkingMap.routeBetween(from, to);
    await walkingMap.routeBetween({ ...from, lat: 34.0005 }, to);
    walkingMap.catalogRevision = 'catalog-b';
    await walkingMap.routeBetween(from, to);

    assert.equal(calls, 3);
});

test('route cache expires stale entries and evicts its oldest entry', () => {
    const walkingMap = loadObject('static/js/map.js', 'WalkingMap', {});
    walkingMap.ROUTE_CACHE_MAX_ENTRIES = 2;
    walkingMap.ROUTE_CACHE_TTL_MS = 60_000;

    walkingMap.saveRoute('first', { kind: 'routed' });
    walkingMap.saveRoute('second', { kind: 'routed' });
    walkingMap.saveRoute('third', { kind: 'estimated' });

    assert.equal(walkingMap.routeCache.size, 2);
    assert.equal(walkingMap.routeCache.has('first'), false);
    assert.equal(walkingMap.getCachedRoute('third').kind, 'estimated');

    walkingMap.routeCache.set('expired', {
        route: { kind: 'routed' },
        storedAt: Date.now() - 10,
        expiresAt: Date.now() - 1,
    });
    assert.equal(walkingMap.getCachedRoute('expired'), null);
    assert.equal(walkingMap.routeCache.has('expired'), false);
});

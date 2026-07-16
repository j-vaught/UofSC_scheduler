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

test('locked section helper explains that every generated schedule will use it', () => {
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

    assert.match(elements['selected-courses-list'].innerHTML, /Section 001 will be used in all schedules/);
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

    assert.equal(open.kind, 'open');
    assert.equal(open.text, '2 of 3 sections open');
    assert.equal(full.kind, 'full');
    assert.equal(full.text, 'All 2 sections full');
    assert.equal(unavailable.kind, 'unavailable');
    assert.equal(unavailable.text, 'Not offered');
});

test('browse results reserve course add actions for the details pane', () => {
    const source = fs.readFileSync('static/js/search.js', 'utf8');
    const styles = fs.readFileSync('static/css/style.css', 'utf8');

    assert.doesNotMatch(source, /class="btn-course-add/);
    assert.match(source, /class="course-header-main"/);
    assert.match(source, /class="course-availability \$\{availability\.kind\}"/);
    assert.match(source, /unavailable \? ' disabled' : ''/);
    assert.match(source, /unavailable \? 'NOT OFFERED THIS TERM'/);
    assert.match(styles, /\.course-header-main\s*{[^}]*text-overflow:\s*ellipsis;/s);
    assert.match(styles, /\.course-availability\.open[^}]*color:\s*#2e7d32/s);
    assert.match(styles, /\.course-availability\.full[^}]*color:\s*#c62828/s);
    assert.match(styles, /\.course-availability\.unavailable[^}]*color:\s*#5C5C5C/s);
});

test('browse section details add and lock the specific section', () => {
    const source = fs.readFileSync('static/js/search.js', 'utf8');

    assert.match(source, /ADD COURSE AND USE THIS SECTION/);
    assert.match(source, /USE THIS SECTION/);
    assert.match(source, /USE ANY OPEN SECTION/);
    assert.match(source, /State\.setSectionLock\(group\.code, locked \? null : section\.crn\)/);
    assert.match(source, /You can still use this full section for planning\./);
    assert.match(source, /this\._detailSectionData\[this\._detailSectionCrn\] = \{ details, faculty \}/);
    assert.match(source, /picker\.querySelectorAll\('\[data-detail-crn\]'\)[\s\S]*selectDetailSection\(button\.dataset\.detailCrn\)/);
    assert.match(source, /class="course-section-visuals"/);
    assert.match(source, /id="course-section-map"/);
    assert.match(source, /Registration notes for this section/);
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
    assert.match(optionsHeading, /id="btn-solve"/);
    assert.match(optionsHeading, /<div class="schedule-panel-heading">\s*<h3>Schedule Options<\/h3>\s*<\/div>\s*<div class="schedule-panel-actions">/);
    assert.ok(optionsHeading.indexOf('id="btn-solve"') < optionsHeading.indexOf('id="btn-schedule-preferences"'));
    assert.doesNotMatch(source, /id="btn-export-quick"/);
    assert.match(source, /class="schedule-selected-section"/);
    assert.match(styles, /#modal-overlay\s*{[^}]*z-index:\s*5000;/s);
    assert.match(styles, /#solver-section\s*{[^}]*display:\s*flex;[^}]*overflow:\s*hidden;/s);
    assert.match(styles, /#solver-container\s*{[^}]*flex:\s*1 1 auto;[^}]*overflow-y:\s*auto;/s);
    assert.match(styles, /\.schedule-panel-heading\s*{[^}]*position:\s*sticky;/s);
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
    assert.match(styles, /main\s*{[^}]*height:\s*calc\(100vh - 58px\);/s);
    assert.doesNotMatch(html, /UOFSC COURSE SCHEDULER/);
});

test('registration info unlocks for selected sections and links to the CRN cart', () => {
    const source = fs.readFileSync('static/js/scheduler.js', 'utf8');
    const html = fs.readFileSync('static/index.html', 'utf8');
    const styles = fs.readFileSync('static/css/style.css', 'utf8');

    assert.match(html, /id="btn-registration-info"[^>]*disabled>REGISTRATION INFO/);
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
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', { State: state });
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
    assert.match(results.innerHTML, /Search for a course to see results/);

    input.value = 'NO MATCH';
    scheduler.renderCourseSearchResults();
    assert.match(results.innerHTML, /No courses found for this search/);
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
    assert.match(source, /Offered in \$\{frequency\}% of recent terms/);
    assert.match(source, /Last offered \$\{offering\.last_offered_label\}/);
    assert.match(source, /const detailsPromise =/);
    assert.match(source, /await Promise\.allSettled\(\[API\.getCourseGrades\(group\.code\)\]\)/);
    assert.match(source, /detailsPromise\s*\.then\(details =>/);
    assert.match(api, /async getCourseGrades\(code\)/);
    assert.match(api, /async getFaculty\(term, crns\)/);
    assert.match(styles, /#modal\.course-quick-modal\s*{[^}]*max-width:\s*780px;/s);
    assert.match(styles, /\.quick-instructor-grid\s*{[^}]*grid-template-columns:\s*repeat\(2,/s);
    assert.match(styles, /\.quick-instructor-card small\s*{[^}]*font-size:\s*0\.7rem;/s);
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

test('schedule splitter keeps calendar and map within the available height', () => {
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {});

    const mapExpanded = scheduler.fitPanelSizes(100, 700);
    const calendarExpanded = scheduler.fitPanelSizes(900, 700);

    assert.equal(mapExpanded.workspace + mapExpanded.map, 700);
    assert.equal(calendarExpanded.workspace + calendarExpanded.map, 700);
    assert.equal(mapExpanded.workspace, 420);
    assert.equal(calendarExpanded.map, 260);
});

test('schedule splitter uses a safe default when initialized in a hidden tab', () => {
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {});

    assert.equal(scheduler.initialPanelHeight(null, 0), 620);
    assert.equal(scheduler.initialPanelHeight(0, 0), 620);
    assert.equal(scheduler.initialPanelHeight(540, 0), 540);
    assert.equal(scheduler.initialPanelHeight(null, 575), 575);
});

test('schedule splitter recalculates when the schedule tab becomes visible', () => {
    const source = fs.readFileSync('static/js/scheduler.js', 'utf8');

    assert.match(source, /addEventListener\('tab-changed'/);
    assert.match(source, /event\.detail\?\.tab === 'schedule'/);
    assert.match(source, /if \(available <= 0\) return;/);
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

test('schedule search shares browse CRN, range, partial, and semantic query behavior', async () => {
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

    search._doSemanticSearch = async () => ({
        results: [{ code: 'CSCE 550', title: 'Data Structures' }],
        expandedTerms: [],
    });
    const semantic = await search.searchLiveCourses('graph algorithms');
    assert.equal(semantic.semantic, true);
    assert.equal(semantic.results[0].crn, '10550');
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
    assert.match(source, /CSCE 140–150/);
    assert.match(fs.readFileSync('static/index.html', 'utf8'), /range \(CSCE 140–199\)/);
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
    assert.match(source, /const aiAssisted = document\.getElementById\('filter-ai-search'\)\?\.checked !== false/);
    assert.match(source, /requestIdleCallback\(preload, \{ timeout: 3500 \}\)/);
    assert.match(styles, /\.browse-empty \.browse-body\s*{\s*display:\s*none;/);
    assert.match(styles, /\.browse-results #semester-content\s*{\s*display:\s*none;/);
    assert.match(styles, /\.browse-detail #semester-content\s*{[^}]*display:\s*block;/s);
    assert.match(styles, /\.browse-results \.browse-search-examples,[\s\S]*\.browse-detail \.browse-search-examples\s*{\s*display:\s*none;/);
});

test('Browse filters open as a centered modal and applying closes them', () => {
    const html = fs.readFileSync('static/index.html', 'utf8');
    const source = fs.readFileSync('static/js/search.js', 'utf8');
    const styles = fs.readFileSync('static/css/style.css', 'utf8');

    assert.match(styles, /\.filter-backdrop\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*240;/s);
    assert.match(styles, /\.browse-search-shell > \.filter-panel\s*\{[^}]*left:\s*50%;[^}]*position:\s*fixed;[^}]*top:\s*50%;[^}]*transform:\s*translate\(-50%, -50%\);[^}]*width:\s*min\(720px,/s);
    assert.match(source, /filterBackdrop\?\.classList\.remove\('hidden'\)/);
    assert.match(source, /document\.getElementById\('btn-apply-filters'\)\?\.addEventListener\('click',[\s\S]*?this\.closeFilters\(\);/);
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
    assert.match(html, /data-search-example="CSCE 140–199"/);
    assert.match(html, /class="filter-sliders-icon"/);
    assert.match(html, /id="smart-model-loading-stage">Preparing AI-assisted search/);
    assert.doesNotMatch(html, /id="smart-search-status"/);
    assert.doesNotMatch(html, /id="smart-search-query-list"/);
    assert.doesNotMatch(html, /id="smart-search-aggregate"/);
    assert.match(source, /input\.disabled = active/);
    assert.match(source, /openRegularSearch\(term\)/);
    assert.match(source, /this\._relatedSearchOrigin = origin;[\s\S]*this\._directSearchOnce = true;[\s\S]*this\.doSearch\(\);/);
    assert.match(source, /class="semantic-search-term" data-regular-search-index/);
    assert.match(source, /const relatedBatches = await Promise\.all/);
    assert.match(source, /this\.applySectionFilters\(candidates, semanticFilters\)/);
    assert.match(source, /count: new Set\(matchingCodes\)\.size/);
    assert.match(source, /<strong>\$\{countLabel\}<\/strong>/);
    assert.match(source, /class="semantic-search-terms-toggle" aria-expanded="false"/);
    assert.match(source, /\$\{searchTerms\.length\} Related searches/);
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
});

test('Returning from a related search can restore the parent view from a short-lived cache', () => {
    const search = loadObject('static/js/search.js', 'Search', {});
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
});

test('AI-assisted search can be disabled and related searches remain direct', () => {
    const html = fs.readFileSync('static/index.html', 'utf8');
    const source = fs.readFileSync('static/js/search.js', 'utf8');

    assert.match(html, /id="filter-ai-search" type="checkbox" checked/);
    assert.match(source, /const useDirectSearch = !aiAssisted[\s\S]*Boolean\(this\._relatedSearchOrigin\)[\s\S]*this\._directSearchOnce[\s\S]*this\._semanticFallbackOnce/);
    assert.match(source, /if \(aiToggle\) aiToggle\.checked = true/);
    assert.match(source, /openRegularSearch\(term\)[\s\S]*this\._directSearchOnce = true/);
    assert.match(source, /writeSearchHistory\(rawInput,[\s\S]*origin: this\._relatedSearchOrigin/);
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
    assert.match(source, /getElementById\('keyword-input'\)\.addEventListener\('keydown',[\s\S]*if \(e\.key === 'Enter'\) this\.submitSearch\(\)/);
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
    assert.match(search, /params\.get\('tab'\) !== 'search' && !params\.has\('q'\)/);
    assert.match(search, /State\.term = term/);
    assert.match(search, /class="related-search-back"/);
    assert.match(search, /history\.state\?\.relatedSearch/);
    assert.match(fs.readFileSync('static/index.html', 'utf8'), /id="keyword-input" aria-label="Search courses"/);
    assert.match(styles, /\.search-clear\s*{[^}]*right:\s*7px;/s);
    assert.match(styles, /@media \(max-width: 700px\)[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) 44px 88px;/s);
    assert.match(styles, /@media \(max-width: 420px\)[\s\S]*--search-side-gap:\s*8px;/s);
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

    assert.match(styles, /\.browse-close-details\s*{[^}]*position:\s*sticky;/s);
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

test('Professor names use the first comma as the sole first and last name delimiter', () => {
    const grades = loadObject('static/js/grades.js', 'Grades', {});

    assert.equal(grades.displayProfessorName('KANAPALA, NEEMA'), 'NEEMA KANAPALA');
    assert.equal(grades.displayProfessorName('DE LA CRUZ, MARIA JOSE'), 'MARIA JOSE DE LA CRUZ');
    assert.equal(grades.displayProfessorName('Mary Ann Smith'), 'Mary Ann Smith');
});

test('Professor profiles use alphabetical GPA rows and a full-year connected timeline', () => {
    const source = fs.readFileSync('static/js/grades.js', 'utf8');
    const styles = fs.readFileSync('static/css/grades.css', 'utf8');
    const html = fs.readFileSync('static/index.html', 'utf8');

    assert.match(source, /localeCompare\(String\(right\.code \|\| ''\), undefined, \{ numeric: true \}\)/);
    assert.match(source, /class="professor-course-gpa-dot/);
    assert.doesNotMatch(source, /<i><b style="width:\$\{width\}%"><\/b><\/i>/);
    assert.match(source, /class="professor-primary-gpa"/);
    assert.match(source, /class="professor-year-segment \$\{direction\}"/);
    assert.match(source, /\$\{point\.year\}: \$\{this\.formatGpa\(point\.gpa\)\} GPA/);
    assert.match(source, /\(point\.year - firstYear\) \* 90 \/ yearSpan/);
    assert.match(source, /Teaching span in available records/);
    assert.match(source, /currentFacultyForCourse\(code\)/);
    assert.match(source, /return `\$\{term\}:\$\{code\}:\$\{crns\.join\(','\)\}`/);
    assert.match(source, /const facultyKey = this\.courseFacultyKey\(code\)[\s\S]*this\.courseFacultyKey\(code\) !== facultyKey/);
    assert.match(fs.readFileSync('static/js/search.js', 'utf8'), /Grades\.refreshCourseFaculty\(group\.code\)/);
    assert.match(styles, /\.professor-year-segment\.down/);
    assert.match(styles, /\.professor-year-point\s*{[^}]*border-radius:\s*50% !important;/s);
    assert.match(html, /update\(markup, options = \{\}\)/);
    assert.match(source, /AppModal\.update\(markup/);
    assert.match(source, /if \(response\.status === 404\)[\s\S]*this\.showUnmatchedProfessor\(context\.displayName \|\| 'Instructor', context\.email \|\| ''\)/);
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
    assert.match(markup, /top:6%">4\.0/);
    assert.match(markup, /top:94%">0\.0/);
    assert.match(markup, /class="professor-year-gridline" style="top:28%/);
    assert.doesNotMatch(markup, /grid-template-columns/);
});

test('Professor GPA timeline plots values below one instead of pinning them to one', () => {
    const grades = loadObject('static/js/grades.js', 'Grades', {});
    const markup = grades.professorYearMarkup([
        { academic_year: 2021, average_gpa: 0.625 },
    ]);

    assert.match(markup, /left:50%;top:80\.25%/);
    assert.match(markup, /2021, 0\.63 GPA/);
});

test('Resources derive official section, bookstore, syllabus, and bulletin destinations safely', () => {
    const source = fs.readFileSync('static/js/search.js', 'utf8');

    assert.match(source, /action\.protocol !== 'https:'/);
    assert.match(source, /action\.hostname !== 'sc\.bncollege\.com'/);
    assert.match(source, /\|\| action\.port/);
    assert.match(source, /\['catalogId', 'storeId', 'termMapping', 'courseXml'\]/);
    assert.match(source, /form\.rel = 'noopener noreferrer'/);
    assert.match(source, /details&srcdb=\$\{encodeURIComponent\(this\._detailTerm \|\| State\.term\)\}&crn=/);
    assert.match(source, /https:\/\/www\.sc\.edu\/syllabusarchive\//);
    assert.match(source, /academicbulletins\.sc\.edu\/undergraduate\/course-descriptions\/\$\{subject\}\//);
    assert.match(source, /academicbulletins\.sc\.edu\/graduate\/course-descriptions\/\$\{subject\}\//);
    assert.match(source, /https:\/\/sc\.edu\/about\/directory\//);
    assert.match(source, /'Course-wide links'/);
    assert.match(source, /primaryFaculty\?\.professor_id/);
    assert.doesNotMatch(source, /uscbookstore\.com/);
    assert.doesNotMatch(source, /Official course information and useful searches open in a new tab/);
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

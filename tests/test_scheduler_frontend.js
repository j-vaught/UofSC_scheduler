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
    const full = search.courseAvailability({ sections: [{ crn: '20001', stat: 'C' }] });
    const unavailable = search.courseAvailability({
        sections: [{ _isCatalog: true, meets: 'Not offered this term' }],
    });

    assert.equal(open.kind, 'open');
    assert.equal(open.text, '2 open');
    assert.equal(full.kind, 'full');
    assert.equal(full.text, 'All full');
    assert.equal(unavailable.kind, 'unavailable');
    assert.equal(unavailable.text, 'Not offered');
});

test('browse results reserve course add actions for the details pane', () => {
    const source = fs.readFileSync('static/js/search.js', 'utf8');
    const styles = fs.readFileSync('static/css/style.css', 'utf8');

    assert.doesNotMatch(source, /class="btn-course-add/);
    assert.match(source, /class="course-availability \$\{availability\.kind\}"/);
    assert.match(source, /id="btn-course-toggle"[^>]*disabled>NOT OFFERED THIS TERM/);
    assert.match(styles, /\.course-availability\.open[^}]*color:\s*#2e7d32/s);
    assert.match(styles, /\.course-availability\.full[^}]*color:\s*#c62828/s);
    assert.match(styles, /\.course-availability\.unavailable[^}]*color:\s*#5C5C5C/s);
});

test('browse filters separate primary and additional course choices', () => {
    const source = fs.readFileSync('static/index.html', 'utf8');

    assert.match(source, /id="filter-show-all"/);
    assert.doesNotMatch(source, /id="filter-current-term"/);
    assert.match(source, /id="filter-method"/);
    assert.match(source, /id="filter-carolina-core"/);
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
    state.minimumWalkingBuffer = 5;

    const preferences = state.getPreferences();

    assert.deepEqual(Array.from(preferences.avoided_days), [1, 3]);
    assert.equal(preferences.minimum_walking_buffer_minutes, 5);
    assert.equal(preferences.minimum_transition_minutes, undefined);
    assert.equal(preferences.preferred_maximum_walk_minutes, undefined);

    const source = fs.readFileSync('static/js/scheduler.js', 'utf8');
    assert.match(source, /class="schedule-preference-times"/);
    assert.match(source, /id="schedule-preferred-start"/);
    assert.match(source, /id="schedule-preferred-end"/);
    assert.match(source, /id="schedule-minimum-walking-buffer"/);
    assert.doesNotMatch(source, /id="schedule-minimum-buffer"/);
    assert.doesNotMatch(source, /id="schedule-preferred-maximum-walk"/);
    assert.match(source, /min="1"/);
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
    assert.doesNotMatch(fs.readFileSync('static/js/scheduler.js', 'utf8'), /Avoid-day and time choices improve ranking/);
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
    let submittedCriteria;
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {
        State: { term: '202608' },
        API: {
            async searchCourses(term, criteria) {
                submittedCriteria = criteria;
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

    assert.equal(submittedCriteria[0].field, 'subject');
    assert.equal(submittedCriteria[0].value, 'CSCE');
    assert.equal(groups.length, 2);
    assert.equal(groups[0].sections.length, 2);
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
    assert.match(schedulerSource, /Minutes remaining after travel/);
    assert.match(schedulerSource, /Accounts for travel between buildings using walking time/);
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
    assert.equal(layers[1].styles.at(-1).color, '#CC2E40');
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

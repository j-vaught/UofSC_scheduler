/*
 * Behaviour and source contracts for the schedule builder
 * (static/js/scheduler.js and its fenced feature under features/scheduler),
 * plus the calendar, day-pattern preferences and state hooks it drives.
 * This file kept its name; the search, map, grades, api, static-layout and
 * misc suites were split out of it by module-under-test.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const {
    loadObject, moduleSource, stylesheet,
    openingTag, tagAttributes,
} = require('./support/scheduler-harness.js');

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

    const source = moduleSource('scheduler');
    const styles = stylesheet();
    assert.match(source, /class="schedule-preference-times"/);
    assert.match(source, /id="schedule-preferred-start"/);
    assert.match(source, /id="schedule-preferred-end"/);
    assert.match(source, /id="btn-advanced-time-avoidance"/);
    assert.match(source, /id="schedule-advanced-calendar"/);
    assert.match(source, /buildAdvancedTimeAvoidance/);
    assert.match(source, /(?:deps\.state|State)\.avoidedTimeBlocks/);
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
    const styles = stylesheet();
    const optionsStart = source.indexOf('<section id="solver-section">');
    const optionsEnd = source.indexOf('<div id="solver-container">', optionsStart);
    const optionsHeading = source.slice(optionsStart, optionsEnd);

    assert.match(optionsHeading, /id="btn-schedule-preferences"/);
    // Accessible name and dialog role, checked as a set: reordering a button's
    // attributes changes nothing a screen reader sees, so the assertion must not
    // depend on their authoring order.
    const prefAttrs = tagAttributes(openingTag(optionsHeading, 'id="btn-schedule-preferences"'));
    assert.equal(prefAttrs['aria-label'], 'Schedule preferences');
    assert.equal(prefAttrs.title, 'Schedule preferences');
    assert.equal(prefAttrs['aria-haspopup'], 'dialog');
    assert.equal(prefAttrs['aria-controls'], 'modal');
    assert.match(optionsHeading, /id="btn-schedule-preferences"[\s\S]*?<span class="filter-sliders-icon" aria-hidden="true">/);
    assert.doesNotMatch(optionsHeading, />PREFERENCES<\/button>/);
    assert.match(optionsHeading, /id="btn-solve"/);
    const solveAttrs = tagAttributes(openingTag(optionsHeading, 'id="btn-solve"'));
    assert.equal(solveAttrs['aria-label'], 'Generate schedules');
    assert.equal(solveAttrs.title, 'Generate schedules');
    assert.match(optionsHeading, /class="schedule-action-label-wide" aria-hidden="true">GENERATE SCHEDULES/);
    assert.match(optionsHeading, /class="schedule-action-label-compact" aria-hidden="true">GENERATE/);
    const regAttrs = tagAttributes(openingTag(optionsHeading, 'id="btn-registration-info"'));
    assert.equal(regAttrs['aria-label'], 'Registration info');
    assert.equal(regAttrs.title, 'Registration info');
    assert.equal(regAttrs.disabled, true, 'registration info starts disabled');
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
    assert.doesNotMatch(moduleSource('scheduler'), /Avoid-day and time choices improve ranking/);
});

test('registration info unlocks for selected sections and links to the CRN cart', () => {
    const source = moduleSource('scheduler');
    const html = fs.readFileSync('static/index.html', 'utf8');
    const styles = stylesheet();

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
    assert.match(source, /data-registration-indicator/);
    assert.match(source, /registration-success-icon/);
    assert.match(source, /indicator\.hidden = false/);
    assert.match(source, /No registration warnings found/);
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
    assert.match(styles, /\.registration-status-icon\s*{[^}]*height:\s*18px;[^}]*width:\s*20px;/s);
    assert.match(styles, /\.registration-status-icon\[hidden\]\s*{[^}]*display:\s*none;/s);
    assert.match(styles, /\.registration-success-icon\s*{[^}]*color:\s*#2e7d32;/s);
    assert.match(styles, /\.registration-course-card\s*{\s*border:\s*1px solid #A2A2A2;\s*padding:/s);
    assert.doesNotMatch(styles, /\.registration-course-card\s*{[^}]*border-left:/s);
    assert.match(styles, /\.registration-requirements p\.attention\s*{[^}]*border-left:\s*4px solid #CC2E40;/s);
    assert.match(source, /requirementList\.closest\('\.registration-requirements'\)\.hidden = !requirements\.html;/);
    assert.match(source, /querySelectorAll\('\[data-registration-expand\]\[aria-expanded="true"\]'\)/);
    assert.match(source, /otherDetails\.hidden = true/);
});

test('registration info omits cross-listed course information', () => {
    const source = moduleSource('scheduler');

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
    const source = moduleSource('scheduler');
    const styles = stylesheet();

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
    const source = moduleSource('scheduler');
    const api = fs.readFileSync('static/js/api.js', 'utf8');
    const styles = stylesheet();

    assert.match(source, /courseCopy\.addEventListener\('click', \(\) => this\.openCourseQuickView\(group\)\)/);
    assert.match(source, /id="btn-quick-course-toggle"/);
    assert.match(source, /id="btn-quick-view-browse"/);
    assert.match(source, /const button = event\.currentTarget;/);
    assert.match(source, /button\.textContent = (?:deps\.state|State)\.isCourseSelected\(group\.code\) \? 'REMOVE' : 'ADD TO SCHEDULE';/);
    assert.match(source, /button\.className = (?:deps\.state|State)\.isCourseSelected\(group\.code\) \? 'btn-danger' : 'btn-green';/);
    assert.match(source, /quick-grade-strip/);
    assert.match(source, /quick-frequency-ring/);
    assert.match(source, /(?:deps\.api|API)\.getFaculty\((?:deps\.state|State)\.term, facultyCrns\)/);
    assert.match(source, /href="mailto:\$\{this\.escapeHtml\(instructor\.email\)\}"/);
    assert.match(source, /data-quick-instructor-index="\$\{index\}"/);
    assert.match(source, /VIEW DETAILS FOR SECTION \$\{this\.escapeHtml\(selectedSection\.section/);
    assert.match(source, /Offered in \$\{frequency\}% of recent terms/);
    assert.match(source, /Last offered \$\{offering\.last_offered_label\}/);
    assert.match(source, /const detailsPromise =/);
    assert.match(source, /const gradesPromise = (?:deps\.api|API)\.getCourseGrades\(group\.code\)/);
    assert.match(source, /this\.renderCourseQuickView\(\s*group,\s*\{\},\s*\{\},\s*\{\},\s*true,/s);
    assert.match(source, /gradesPromise\s*\.then\(result =>/);
    assert.match(source, /this\.updateQuickGrades\(gradeData\)/);
    assert.doesNotMatch(source, /await Promise\.allSettled\(\[(?:deps\.api|API)\.getCourseGrades\(group\.code\)\]\)/);
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
    const styles = stylesheet();

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
    assert.equal(scheduler.preferredPanelHeight(700, null, 575), 490);
    assert.equal(scheduler.preferredPanelHeight(700, undefined, 575), 490);
    assert.equal(scheduler.preferredPanelHeight(700, 0, 575), 0);
    assert.equal(scheduler.preferredPanelHeight(700, 1, 575), 700);
    assert.equal(scheduler.preferredPanelHeight(700, 0.5, 575), 350);
});

test('schedule splitter recalculates when the schedule tab becomes visible', () => {
    const source = moduleSource('scheduler');

    assert.match(source, /addEventListener\('tab-changed'/);
    assert.match(source, /event\.detail\?\.tab === 'schedule'/);
    assert.match(source, /if \(available <= 0\) return;/);
    assert.match(source, /addEventListener\('pointercancel', stop\)/);

    // The workspace split ratio is remembered and reapplied. Rather than pin the
    // persistence and recompute expressions (which a rename would break while the
    // behaviour is unchanged), drive the observable behaviour: saveVerticalSizes
    // writes the current ratio to storage, and preferredPanelHeight reapplies a
    // stored ratio to the available height proportionally.
    const stored = {};
    const workspaceEl = { getBoundingClientRect: () => ({ height: 360 }) };
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {
        document: {
            getElementById: () => null,
            querySelector: selector => (selector === '.schedule-workspace' ? workspaceEl : null),
        },
        localStorage: { getItem: () => null, setItem: (key, value) => { stored[key] = value; } },
    });
    scheduler._preferredWorkspaceRatio = 0.5;
    scheduler.saveVerticalSizes();
    const savedRatio = JSON.parse(stored['uofsc-schedule-split-v1']).workspaceRatio;
    assert.equal(savedRatio, 0.5, 'the split ratio is remembered across sessions');
    assert.equal(
        scheduler.preferredPanelHeight(700, savedRatio, 575), 350,
        'a stored ratio is reapplied to the available height',
    );
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

test('schedule course search paginates matches instead of discarding them', () => {
    const source = moduleSource('scheduler');

    assert.doesNotMatch(source, /Object\.values\(groups\)\.slice\(0, 30\)/);
    assert.match(source, /_searchPageSize:\s*30/);
    assert.match(source, /SHOW \$\{increment\} MORE/);
    assert.match(source, /(?:deps\.search|Search)\.searchLiveCourses\(query\)/);
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

/*
 * State restores a saved schedule before any module initialises, so by the time
 * Calendar.init() runs the sections may already be there and no change event is
 * ever coming. Subscribing was sufficient only while startup was always empty.
 * Without this the calendar sits blank over a schedule the student can see
 * listed in the sidebar, which reads as data loss.
 */
test('calendar paints an already-restored schedule at init', () => {
    const calendar = loadObject('static/js/calendar.js', 'Calendar', {
        State: { on() {} },
    });
    let renders = 0;
    calendar.buildGrid = () => {};
    calendar.render = () => { renders += 1; };
    calendar.init();
    assert.equal(renders, 1, 'init must render current state, not only subscribe');
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
    const source = moduleSource('scheduler');

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
    const source = moduleSource('scheduler');

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
    const source = moduleSource('scheduler');
    assert.doesNotMatch(source, /(?:deps\.api|API)\.prefetchCourseDetails/);
    assert.match(source, /background: true/);
    assert.match(source, /foreground: true/);
});

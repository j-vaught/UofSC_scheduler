/*
 * Behaviour and source contracts for the Browse/Search module
 * (static/js/search.js and its fenced feature under features/search).
 * Split out of test_scheduler_frontend.js by module-under-test.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const {
    loadObject, moduleSource, gradesSource, stylesheet, cssRule,
} = require('./support/scheduler-harness.js');

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
    const source = moduleSource('search');
    const styles = stylesheet();

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

test('browse section details add and lock the specific section', () => {
    const source = moduleSource('search');
    const notesStart = source.indexOf('sectionRegistrationNotes(details = null)');
    const notesEnd = source.indexOf('destroyDetailMap()');
    // Anchor both bounds: a rename on either makes the slice empty or unbounded,
    // and the part_of_term check below passes against nothing (fails open).
    assert.notEqual(notesStart, -1, 'sectionRegistrationNotes moved; this test is not reading it');
    assert.notEqual(notesEnd, -1, 'destroyDetailMap moved; the registration-notes slice is unbounded');
    const registrationNotes = source.slice(notesStart, notesEnd);

    assert.match(source, /ADD SECTION \$\{sectionLabel\} TO SCHEDULE/);
    assert.match(source, /LET SCHEDULER CHOOSE/);
    assert.match(source, /Use Section \$\{sectionLabel\} in every generated schedule/);
    assert.match(source, /(?:deps\.state|State)\.setSectionLock\(group\.code, locked \? null : section\.crn\)/);
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
    const source = moduleSource('search');
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

    const source = moduleSource('search');
    const styles = stylesheet();
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

/*
 * This test used to stub bulletinDetails() as returning a `carolinacore`
 * field, and passed for years. The real bulletin payload has no such field --
 * it carries code, title, hours, description and prerequisites -- so the
 * filter matched nothing in production for every one of its ten outcomes,
 * while the suite stayed green against a field the test had invented.
 *
 * A mock is only evidence if it returns what the real source returns. This one
 * now uses the Carolina Core catalogue shard, which is where the data has
 * actually lived all along.
 */
test('instructional method and Carolina Core filters use section and catalogue data', async () => {
    const search = loadObject('static/js/search.js', 'Search', {
        CarolinaCore: {
            async loadCatalog() {
                return {
                    courses: [
                        { code: 'ENGL 101', outcomes: ['CMW', 'INF'] },
                        { code: 'TEST 101', outcomes: ['SCI'] },
                    ],
                };
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

    // The other course's own outcome still selects it, so this is a filter
    // rather than a hard-coded pass for one course.
    const sciResults = await search.filterByCarolinaCore(results, 'SCI');
    assert.deepEqual(Array.from(sciResults, result => result.code), ['TEST 101']);
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
    /*
     * These previously passed `experiential`, `founding_documents` and
     * `graduation` fields. The bulletin payload has none of them, so the filter
     * matched nothing in production while this test stayed green against
     * fields it had invented -- the same failure as the Carolina Core mock.
     *
     * The strings below are the real shape, copied from live section details:
     * attributes arrive together in course_attr, space separated.
     */
    const GLD_SECTION = {
        course_attr: 'GLD: Global Learning (3GDG) GLD: Professional Engagement (3GDP) GSS: Global/Social Science (3GSS)',
    };
    assert.equal(search.matchesCourseAttribute(GLD_SECTION, 'gld-global'), true);
    assert.equal(search.matchesCourseAttribute(GLD_SECTION, 'gld-professional'), true);
    // Same payload, an attribute it does not carry: this is a filter, not a
    // pass-through for anything with a course_attr string.
    assert.equal(search.matchesCourseAttribute(GLD_SECTION, 'gld-community'), false);
    assert.equal(search.matchesCourseAttribute(GLD_SECTION, 'gld-research'), false);

    assert.equal(search.matchesCourseAttribute({ course_attr: 'CMW: Communication/Writing (3CMW)' }, 'gld-global'), false);
    assert.equal(search.matchesCourseAttribute({}, 'gld-global'), false, 'no attributes means no match');

    /*
     * ELO and Founding Documents keep their patterns, but no live section
     * carrying either was observed while fixing this, so these assert the
     * intended reading rather than confirmed upstream wording. If the filter
     * ever reports zero for them against real data, this is the thing to
     * re-check first.
     */
    assert.equal(search.matchesCourseAttribute({ course_attr: 'Experiential Learning Opportunity (3ELO)' }, 'elo'), true);
    assert.equal(search.matchesCourseAttribute({ course_attr: 'Founding Documents (3FND)' }, 'founding'), true);

    // A bare /research/ would match any prose containing the word, so the
    // research option is scoped to the GLD prefix.
    assert.equal(search.matchesCourseAttribute({ course_attr: 'Undergraduate Research Methods' }, 'gld-research'), false);
    assert.equal(search.matchesCourseAttribute({ course_attr: 'GLD: Research (3GDR)' }, 'gld-research'), true);
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

test('numeric course ranges are parsed before semantic search in Browse', () => {
    const source = moduleSource('search');
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
    const source = moduleSource('search');
    const styles = stylesheet();

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
    const source = moduleSource('search');
    const styles = stylesheet();

    // Extract each rule block, then match one property inside it: the filter
    // modal is a fixed, centred dialog capped at 720px. Reordering those
    // declarations changes nothing it renders, so the check must not depend on
    // property order.
    const backdrop = cssRule(styles, '.filter-backdrop');
    assert.ok(backdrop, 'the .filter-backdrop rule moved; this test is not reading it');
    assert.match(backdrop, /position:\s*fixed;/);
    assert.match(backdrop, /z-index:\s*2040;/);
    const panel = cssRule(styles, '#filter-panel');
    assert.ok(panel, 'the #filter-panel rule moved; this test is not reading it');
    assert.match(panel, /left:\s*50%;/);
    assert.match(panel, /top:\s*50%;/);
    assert.match(panel, /position:\s*fixed;/);
    assert.match(panel, /transform:\s*translate\(-50%, -50%\);/);
    assert.match(panel, /width:\s*min\(720px,/);
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
    const source = moduleSource('search');
    const styles = stylesheet();

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
    const gridStart = html.indexOf('<div class="search-syntax-grid">');
    const scopeStart = html.indexOf('<section class="course-scope-filter"');
    // Anchor both bounds: a rename on either end makes the slice empty or the
    // whole document, and the ordering checks below then compare -1 with -1 or
    // run over unrelated markup (fails open).
    assert.notEqual(gridStart, -1, 'the search-syntax grid moved; this test is not reading it');
    assert.notEqual(scopeStart, -1, 'the course-scope filter moved; the syntax slice is unbounded');
    const syntaxMarkup = html.slice(gridStart, scopeStart);
    orderedExamples.slice(1).forEach((example, index) => {
        assert.ok(syntaxMarkup.indexOf(orderedExamples[index]) < syntaxMarkup.indexOf(example));
    });
    const guideAt = html.indexOf('id="search-syntax-guide"');
    const scopeClassAt = html.indexOf('class="course-scope-filter"');
    // Anchor both: if the guide is removed its index is -1 and "-1 < positive"
    // passes even though the guide is gone (fails open).
    assert.notEqual(guideAt, -1, 'the search-syntax guide is gone; ordering cannot be checked');
    assert.notEqual(scopeClassAt, -1, 'the course-scope filter is gone; ordering cannot be checked');
    assert.ok(guideAt < scopeClassAt);
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
    // Clicking a related course records the origin, forces one direct search, and
    // runs it. The order of the two assignments is refactor noise, so assert the
    // three effects co-occur in the one handler rather than pinning their sequence.
    const originAt = source.indexOf('this._relatedSearchOrigin = origin');
    assert.notEqual(originAt, -1, 'the related-course click handler moved; this test is not reading it');
    const relatedHandler = source.slice(Math.max(0, originAt - 200), originAt + 200);
    assert.match(relatedHandler, /this\._directSearchOnce = true;/, 'a related click forces one direct search');
    assert.match(relatedHandler, /this\.doSearch\(\)/, 'a related click runs the search');
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
    const source = moduleSource('search');
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
    // A semantic-fallback search bypasses the view cache; a normal search may use
    // it. The read/write wiring lives in doSearch (not cheaply executable here),
    // so match the semantic core -- the signals that gate the cache -- rather than
    // the exact expression order. The cache's own store/restore mechanism is
    // executed above and below.
    const readAt = source.indexOf('restoreCachedSearch(searchCacheKey)) return;');
    assert.notEqual(readAt, -1, 'the cache-read guard moved; this test is not reading it');
    const cacheGuard = source.slice(Math.max(0, readAt - 120), readAt);
    assert.match(cacheGuard, /!bypassCache/, 'an explicit bypass skips the cache read');
    assert.match(cacheGuard, /!this\._semanticFallbackOnce/, 'a semantic fallback skips the cache read');
    assert.match(source, /doSearch\(\{ bypassCache: true \}\)/, 'a semantic fallback re-runs with the cache bypassed');
    assert.match(source, /this\._semanticFallbackOnce \? null : searchCacheKey/, 'a semantic fallback stores nothing in the cache');
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
    // Anchor both bounds: a reworded comment on either end makes the slice empty
    // or unbounded, and the "no catch(" check passes against nothing (fails open).
    assert.notEqual(catalogLiveStart, -1, 'the live cross-reference block moved; this test is not reading it');
    assert.notEqual(catalogLiveEnd, -1, 'the live cross-reference block is unbounded; the slice is wrong');
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

test('AI-assisted search can be disabled and related searches remain direct', () => {
    const html = fs.readFileSync('static/index.html', 'utf8');
    const source = moduleSource('search');

    assert.match(html, /id="filter-ai-search" type="checkbox" checked/);
    // Related-course clicks, a forced direct repeat, and a semantic fallback all
    // route to a direct search -- as does turning AI assistance off. Find the
    // decision that ORs these signals and assert each is present, independent of
    // their order in the || chain and of the local variable's name.
    const decision = (source.match(/const \w+\s*=\s*[^;]*;/g) || []).find(statement =>
        /!\s*aiAssisted/.test(statement)
        && statement.includes('this._relatedSearchOrigin')
        && statement.includes('this._directSearchOnce')
        && statement.includes('this._semanticFallbackOnce'));
    assert.ok(decision, 'direct search must consider AI-off, a related origin, a forced direct repeat, and a semantic fallback');
    assert.match(source, /if \(aiToggle\) aiToggle\.checked = true/);
    assert.match(source, /openRegularSearch\(term\)[\s\S]*this\._directSearchOnce = true/);
    assert.match(source, /writeSearchHistory\(searchQuery,[\s\S]*origin: this\._relatedSearchOrigin/);
    assert.match(source, /Meaning-based matching is unavailable\. Showing direct matches\./);
});

test('Browse uses one search field for direct and AI-assisted queries', () => {
    const html = fs.readFileSync('static/index.html', 'utf8');
    const source = moduleSource('search');
    const styles = stylesheet();

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
    const search = moduleSource('search');
    const tabs = fs.readFileSync('static/js/tabs.js', 'utf8');
    const styles = stylesheet();

    assert.match(tabs, /btn\.dataset\.tab === 'semester'[\s\S]*search-tab-reset-requested/);
    assert.match(tabs, /writeTabHistory\(tabName, historyMode\)/);
    assert.match(tabs, /url\.searchParams\.set\('tab', tabName\)/);
    assert.match(tabs, /window\.addEventListener\('popstate', \(\) => this\.restoreFromLocation\(\)\)/);
    assert.match(search, /resetToCleanSearch\(\{ historyMode: 'push' \}\)/);
    assert.match(search, /history\.pushState\(state, '', next\)/);
    assert.match(search, /window\.addEventListener\('popstate', \(\) => this\.restoreFromLocation\(\)\)/);
    assert.match(search, /url\.searchParams\.set\('q', query\)/);
    assert.match(search, /url\.searchParams\.set\('term', (?:deps\.state|State)\.term\)/);
    assert.match(search, /url\.searchParams\.set\('from', origin\)/);
    assert.match(search, /if \(topic\) url\.searchParams\.set\('topic', '1'\)/);
    assert.match(search, /this\._topicSearchMode = params\.get\('topic'\) === '1'/);
    assert.match(search, /params\.get\('tab'\) !== 'search' && !params\.has\('q'\)/);
    assert.match(search, /(?:deps\.state|State)\.term = term/);
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

test('Direct search ignores stale prerequisite completions and errors', () => {
    const source = moduleSource('search');
    const prereqLoad = source.indexOf('? await this.loadPrereqsForResults(results)');
    const render = source.indexOf('this.renderAndCacheSearch(', prereqLoad);
    const staleGuard = source.lastIndexOf('if (searchId !== this._searchId) return;', render);
    const catchStart = source.indexOf('} catch (err) {', render);

    assert.ok(prereqLoad > 0 && render > prereqLoad);
    assert.ok(staleGuard > prereqLoad && staleGuard < render);
    assert.match(source.slice(catchStart, catchStart + 180), /if \(searchId !== this\._searchId\) return;/);
});

test('Course detail fills its pane and uses visual section, grade, and history summaries', () => {
    const search = moduleSource('search');
    const grades = gradesSource();
    const history = fs.readFileSync('static/js/history.js', 'utf8');
    const styles = stylesheet();
    const gradeStyles = fs.readFileSync('static/css/grades.css', 'utf8');

    assert.match(styles, /\.course-detail-shell\s*{[^}]*max-width:\s*none;[^}]*width:\s*100%;/s);
    assert.match(search, /renderSectionCalendar\(section, details/);
    assert.match(search, /(?:deps\.walkingMap|WalkingMap)\.resolveBuilding/);
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

test('Static catalog fallbacks never claim that an unverified course is not offered', () => {
    const source = moduleSource('search');
    const styles = stylesheet();
    assert.match(source, /availability_unknown[\s\S]*Live availability unavailable/);
    assert.match(source, /Live section totals unavailable/);
    assert.match(source, /LIVE SECTIONS UNAVAILABLE/);
    assert.match(source, /details\?\.hours[\s\S]*group\.sections\?\.\[0\]\?\.hours/);
    assert.match(styles, /\.course-availability\.unknown[\s\S]*#466A9F/);
});

test('Smart model startup skips nonexistent local model probes', () => {
    const source = moduleSource('search');
    assert.match(source, /env\.allowLocalModels = false/);
});

test('Resources derive official section, bookstore, syllabus, and bulletin destinations safely', () => {
    const source = moduleSource('search');
    const styles = stylesheet();
    const search = loadObject('static/js/search.js', 'Search', { URL });

    assert.match(source, /action\.protocol !== 'https:'/);
    assert.match(source, /action\.hostname !== 'sc\.bncollege\.com'/);
    assert.match(source, /\|\| action\.port/);
    assert.match(source, /\['catalogId', 'storeId', 'termMapping', 'courseXml'\]/);
    assert.match(source, /form\.rel = 'noopener noreferrer'/);
    assert.match(source, /details&srcdb=\$\{encodeURIComponent\(this\._detailTerm \|\| (?:deps\.state|State)\.term\)\}&crn=/);
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

test('course meeting details decode registrar HTML entities before display', () => {
    const search = loadObject('static/js/search.js', 'Search', {});
    const parsed = search.parseMeetingHtml(
        '<div class="meet">W 1:10pm-2pm<span> in <a>Storey Eng &amp; Innovation Ctr 1400</a></span></div>',
    );

    assert.deepEqual(Array.from(parsed.times), ['W 1:10pm-2pm']);
    assert.deepEqual(Array.from(parsed.locations), ['Storey Eng & Innovation Ctr 1400']);
    assert.equal(search.stripHtml('Research &amp; Design'), 'Research & Design');
    assert.equal(search.stripHtml('&nbsp;A&nbsp;&nbsp;B&nbsp;'), 'A B');
    assert.equal(search.decodeHtmlEntities('Keep &#x110000; unchanged'), 'Keep &#x110000; unchanged');
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

    const crn1At = picker.innerHTML.indexOf('data-detail-crn="1"');
    const crn2At = picker.innerHTML.indexOf('data-detail-crn="2"');
    const crn10At = picker.innerHTML.indexOf('data-detail-crn="10"');
    // Anchor all three: a missing section gives index -1 and "-1 < positive"
    // passes even though that CRN never rendered (fails open).
    assert.notEqual(crn1At, -1, 'CRN 1 section is missing from the picker');
    assert.notEqual(crn2At, -1, 'CRN 2 section is missing from the picker');
    assert.notEqual(crn10At, -1, 'CRN 10 section is missing from the picker');
    assert.ok(crn1At < crn2At, 'CRN 1 must sort before CRN 2');
    assert.ok(crn2At < crn10At, 'CRN 2 must sort before CRN 10');
    assert.match(picker.innerHTML, /data-detail-crn="10" aria-pressed="true" tabindex="0"/);
    assert.match(picker.innerHTML, /data-detail-crn="1" aria-pressed="false" tabindex="-1"/);
});

test('Course identity and actions stay together in a sticky black header', () => {
    const html = fs.readFileSync('static/index.html', 'utf8');
    const source = moduleSource('search');
    const styles = stylesheet();

    assert.match(html, /class="course-detail-header-sticky"[\s\S]*id="browse-close-details"[\s\S]*id="tab-details"/);
    assert.match(html, /id="course-detail-description-wrap"/);
    assert.match(source, /class="course-detail-header-topline"[\s\S]*class="course-detail-header-controls"[\s\S]*class="course-detail-credit"/);
    assert.match(source, /id="btn-course-toggle"[\s\S]*id="btn-course-view-schedule"/);
    assert.match(source, /(?:deps\.tabs|Tabs)\.switchTo\('schedule'\)/);
    assert.match(source, /Section \$\{selectedSection\.section \|\| '—'\} · CRN \$\{selectedSection\.crn\}/);
    assert.match(styles, /\.course-detail-header-sticky\s*{[^}]*position:\s*sticky;[^}]*z-index:\s*1000;/s);
    assert.match(styles, /\.course-detail-header-sticky \.browse-close-details\s*{[^}]*position:\s*absolute;/s);
    assert.match(styles, /\.course-detail-tabs\s*{[^}]*position:\s*relative;/s);
    assert.match(styles, /\.course-detail-header-controls\s*{[^}]*overflow-x:\s*auto;/s);
    assert.match(styles, /\.course-detail-primary-actions\s*{[^}]*flex-wrap:\s*nowrap;/s);
});

test('Browse result cards lazily add descriptions and historical grades', () => {
    const source = moduleSource('search');
    const styles = stylesheet();

    assert.match(source, /new IntersectionObserver/);
    assert.match(source, /(?:deps\.api|API)\.getCourseGrades\(group\.code\)/);
    assert.match(source, /course-result-description/);
    assert.match(source, /historical GPA/);
    assert.match(styles, /\.course-result-description/);
    assert.match(styles, /\.course-result-grade/);
});

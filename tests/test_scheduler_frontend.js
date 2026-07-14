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
                    { crn: '10102', stat: 'A', meetingTimes: '[]' },
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

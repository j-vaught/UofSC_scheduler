/*
 * Behaviour and source contracts for the campus walking map
 * (static/js/map.js and its fenced feature under features/map).
 * Split out of test_scheduler_frontend.js by module-under-test.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const {
    loadObject, moduleSource, mapSource, mapFeature,
} = require('./support/scheduler-harness.js');

test('walking map defaults to the all-days view', () => {
    const walkingMap = loadObject('static/js/map.js', 'WalkingMap', {
        Features: { map: mapFeature },});

    assert.equal(walkingMap.selectedDay, 'all');
});

test('walking map includes weekend meetings and term-specific section details', () => {
    const State = { term: '202608' };
    const walkingMap = loadObject('static/js/map.js', 'WalkingMap', {
        Features: { map: mapFeature }, State });
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
        Features: { map: mapFeature },
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
        Features: { map: mapFeature },
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
        Features: { map: mapFeature },
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
    const source = mapSource();

    assert.match(source, /All selected classes were processed, but none has a scheduled campus meeting to map/);
    assert.match(source, /No two selected classes meet consecutively on the same day/);
});

test('route interface uses neutral travel language', () => {
    const source = mapSource();
    const schedulerSource = moduleSource('scheduler');

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
    const walkingMap = loadObject('static/js/map.js', 'WalkingMap', {
        Features: { map: mapFeature },});
    walkingMap.buildings = JSON.parse(fs.readFileSync('static/data/campus_buildings.json', 'utf8')).buildings;

    const resolved = walkingMap.resolveBuilding('Storey Eng & Innovation Ctr 1400');

    assert.equal(resolved.kind, 'known');
    assert.equal(resolved.code, 'INNOVA');
});

test('walking map resolves Science and Technology Banner labels', () => {
    const walkingMap = loadObject('static/js/map.js', 'WalkingMap', {
        Features: { map: mapFeature },});
    walkingMap.buildings = JSON.parse(fs.readFileSync('static/data/campus_buildings.json', 'utf8')).buildings;

    const resolved = walkingMap.resolveBuilding('Science and Technology Bldg 352');

    assert.equal(resolved.kind, 'known');
    assert.equal(resolved.code, '1112GR');
});

test('walking map resolves abbreviated Callcott Banner labels', () => {
    const walkingMap = loadObject('static/js/map.js', 'WalkingMap', {
        Features: { map: mapFeature },});
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
    const walkingMap = loadObject('static/js/map.js', 'WalkingMap', {
        Features: { map: mapFeature },});
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
    const walkingMap = loadObject('static/js/map.js', 'WalkingMap', {
        Features: { map: mapFeature },});
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
    const walkingMap = loadObject('static/js/map.js', 'WalkingMap', {
        Features: { map: mapFeature },});
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
    const source = mapSource();

    assert.match(source, /addEventListener\('mouseenter', \(\) => this\.previewTransition\(index\)\)/);
    assert.match(source, /this\.listElement\.addEventListener\('mouseleave'/);
    assert.doesNotMatch(source, /card\.addEventListener\('mouseleave'/);
    assert.match(source, /addEventListener\('focus', \(\) => this\.previewTransition\(index\)\)/);
    assert.match(source, /addEventListener\('blur', event =>/);
});

test('transition cards and map routes share the same colors', () => {
    const walkingMap = loadObject('static/js/map.js', 'WalkingMap', {
        Features: { map: mapFeature },});
    const mondayTransition = { from: { day: 0 } };
    const tuesdayTransition = { from: { day: 1 } };

    walkingMap.selectedDay = 'all';
    assert.equal(walkingMap.routeColor(mondayTransition), '#73000A');
    assert.equal(walkingMap.routeColor(tuesdayTransition), '#466A9F');
    walkingMap.selectedDay = 1;
    assert.equal(walkingMap.routeColor(tuesdayTransition), '#73000A');

    const source = mapSource();
    const styles = fs.readFileSync('static/css/map.css', 'utf8');
    assert.match(source, /--transition-color', this\.routeColor\(transition\)/);
    assert.match(source, /color: this\.routeColor\(transition\)/);
    assert.match(styles, /\.walking-transition\.has-route\s*{[^}]*border-left-color:\s*var\(--transition-color\)/s);
});

test('online and same-building transitions use disabled no-route cards', () => {
    const walkingMap = loadObject('static/js/map.js', 'WalkingMap', {
        Features: { map: mapFeature },});
    const building = { kind: 'known', code: 'TEST', lat: 1, lon: 2 };

    assert.equal(walkingMap.transitionStatus({ kind: 'online' }).className, 'neutral');
    assert.equal(walkingMap.transitionStatus({ kind: 'same' }).label, 'Same building');

    const source = mapSource();
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
        Features: { map: mapFeature },
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
    const walkingMap = loadObject('static/js/map.js', 'WalkingMap', {
        Features: { map: mapFeature },});
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

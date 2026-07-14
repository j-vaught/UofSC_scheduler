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

test('selected course groups remain available across searches', () => {
    const listeners = {};
    const state = {
        term: '202608',
        selectedSections: { 'TEST 101': { code: 'TEST 101', crn: '10101', meetingTimes: '[]' } },
        courseGroups: [{ code: 'TEST 101', sections: [{ crn: '10101' }, { crn: '10102' }] }],
        on(event, fn) { listeners[event] = fn; },
    };
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {
        State: state,
        document: { getElementById: () => ({ addEventListener() {} }) },
    });

    scheduler.init();
    state.courseGroups = [{ code: 'TEST 102', sections: [{ crn: '10201' }] }];
    state.selectedSections['TEST 102'] = { code: 'TEST 102', crn: '10201', meetingTimes: '[]' };
    listeners['sections-changed']();

    assert.deepEqual(
        Object.keys(scheduler._courseGroupCache).sort(),
        ['TEST 101', 'TEST 102'],
    );
    assert.equal(scheduler._courseGroupCache['TEST 101'].sections.length, 2);
});

test('preview renders a candidate without replacing selected sections', () => {
    const original = { 'TEST 101': { crn: '10101' } };
    let rendered;
    const state = {
        selectedSections: original,
        solverResults: [{ sections: { 'TEST 101': { crn: '10102' } } }],
    };
    const scheduler = loadObject('static/js/scheduler.js', 'Scheduler', {
        State: state,
        Calendar: { render() { rendered = state.selectedSections; } },
    });

    scheduler.previewSchedule(0);

    assert.equal(rendered['TEST 101'].crn, '10102');
    assert.strictEqual(state.selectedSections, original);
    assert.equal(state.selectedSections['TEST 101'].crn, '10101');
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

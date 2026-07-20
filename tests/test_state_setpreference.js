'use strict';

/*
 * State.setPreference(name, value, { event }) writes a preference field and
 * announces it in one call, replacing the "set the field, then
 * State.emit('preferences-changed') on the next line" pattern whose repeated
 * string literal failed silently on a typo. The default event is
 * 'preferences-changed'; { event: null } writes without announcing, which the
 * time-window inputs rely on.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const State = require('../static/js/state.js');

test('setPreference writes the field and announces preferences-changed by default', () => {
    let heard = 0;
    State.on('preferences-changed', () => { heard += 1; });

    const returned = State.setPreference('preferredStart', 1030);

    assert.equal(State.preferredStart, 1030, 'the field is written');
    assert.equal(returned, 1030, 'the written value is returned');
    assert.equal(heard, 1, 'preferences-changed fires exactly once');
});

test('setPreference with { event: null } writes without announcing', () => {
    let heard = 0;
    State.on('preferences-changed', () => { heard += 1; });

    State.setPreference('preferredEnd', 2000, { event: null });

    assert.equal(State.preferredEnd, 2000, 'the field is still written');
    assert.equal(heard, 0, 'a null event is silent, matching the time-window inputs');
});

test('setPreference can announce under a different event name', () => {
    let named = 0;
    let prefs = 0;
    State.on('degree-plan-updated', () => { named += 1; });
    State.on('preferences-changed', () => { prefs += 1; });

    State.setPreference('currentPlan', 'Plan Z', { event: 'degree-plan-updated' });

    assert.equal(State.currentPlan, 'Plan Z');
    assert.equal(named, 1, 'the named event fires');
    assert.equal(prefs, 0, 'the default event does not');
});

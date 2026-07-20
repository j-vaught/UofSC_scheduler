'use strict';

/*
 * The shared meeting-time parser (static/js/meeting-times.js), which replaced
 * four copies that had drifted into incompatible units under one name. The unit
 * is in the name now, and the two parsers keep the two behaviours their real
 * consumers depend on: parseHHMM discards a whole malformed list (the solver's
 * contract), parseMinutes keeps every row (the map's).
 *
 * The payloads mirror the real meetingTimes blob: a JSON array of
 * { meet_day, start_time, end_time } with HHMM integer times.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const MeetingTimes = require('../static/js/meeting-times.js');

const PAYLOAD = '[{"meet_day": 1, "start_time": 900, "end_time": 950},'
    + ' {"meet_day": 3, "start_time": 1330, "end_time": 1445}]';

test('parseHHMM returns start/end as HHMM integers', () => {
    assert.deepEqual(MeetingTimes.parseHHMM(PAYLOAD), [
        { day: 1, start: 900, end: 950 },
        { day: 3, start: 1330, end: 1445 },
    ]);
    // Accepts an already-parsed array as well as the JSON string.
    assert.deepEqual(MeetingTimes.parseHHMM(JSON.parse(PAYLOAD)), [
        { day: 1, start: 900, end: 950 },
        { day: 3, start: 1330, end: 1445 },
    ]);
});

test('parseHHMM discards the whole array on any bad or malformed entry', () => {
    // One unparseable row voids the list -- the solver must not schedule from a
    // half-understood meeting set.
    const oneBad = '[{"meet_day": 1, "start_time": 900, "end_time": 950},'
        + ' {"meet_day": "x", "start_time": 1000, "end_time": 1050}]';
    assert.deepEqual(MeetingTimes.parseHHMM(oneBad), []);
    assert.deepEqual(MeetingTimes.parseHHMM('{oops'), []);
    assert.deepEqual(MeetingTimes.parseHHMM(''), []);
    assert.deepEqual(MeetingTimes.parseHHMM(null), []);
    assert.deepEqual(MeetingTimes.parseHHMM('{"not": "an array"}'), []);
});

test('parseMinutes returns minutes past midnight and keeps every row', () => {
    assert.deepEqual(MeetingTimes.parseMinutes(PAYLOAD), [
        { day: 1, start: 9 * 60, end: 9 * 60 + 50 },
        { day: 3, start: 13 * 60 + 30, end: 14 * 60 + 45 },
    ]);
    // The map's contract: a malformed value flows through as NaN rather than
    // voiding the list. Keeping the row is deliberate -- the map simply does not
    // draw what it cannot place.
    const parsed = MeetingTimes.parseMinutes('[{"meet_day": 2, "start_time": "x", "end_time": 1050}]');
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].day, 2);
    assert.ok(Number.isNaN(parsed[0].start));
    assert.equal(parsed[0].end, 10 * 60 + 50);
    assert.deepEqual(MeetingTimes.parseMinutes('{oops'), []);
});

test('hhmmToMinutes converts and throws on a non-numeric value', () => {
    assert.equal(MeetingTimes.hhmmToMinutes(900), 540);
    assert.equal(MeetingTimes.hhmmToMinutes(1445), 14 * 60 + 45);
    assert.equal(MeetingTimes.hhmmToMinutes('1330'), 13 * 60 + 30);
    assert.throws(() => MeetingTimes.hhmmToMinutes('not a time'), TypeError);
    assert.throws(() => MeetingTimes.hhmmToMinutes(null), TypeError);
});

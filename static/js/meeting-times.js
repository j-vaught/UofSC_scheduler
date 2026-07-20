/*
 * The one place a section's meetingTimes blob is parsed.
 *
 * Four copies had grown apart, and worse, in incompatible units: the solver and
 * the calendar returned start/end as HHMM integers, the campus map returned
 * them as minutes past midnight, and all four shared the single name
 * parseMeetingTimes. A reader could not tell which unit a call site got.
 *
 * So the units are in the names now. parseHHMM() returns HHMM integers,
 * parseMinutes() returns minutes. hhmmToMinutes() converts between them.
 *
 * The two parsers differ in more than units, and the differences are
 * deliberate, preserved from the two consumers this module actually rewires:
 *
 *   parseHHMM  -- the solver's contract. Numeric coercion is strict
 *                 (Number + trunc), and a single malformed entry discards the
 *                 WHOLE array. A scheduler must never place a section whose
 *                 meeting times it cannot fully reason about; a half-parsed list
 *                 is more dangerous than none.
 *
 *   parseMinutes -- the campus map's contract. Coercion is loose (Number, no
 *                 validation) and every entry is kept, because the map only
 *                 draws what it can and a bad row simply does not render. The
 *                 map still carries its own copy today (it is a fenced feature
 *                 owned by another wave); this mirrors it exactly so it can adopt
 *                 this module without a behaviour change. See
 *                 static/js/features/map/index.js parseMeetingTimes / hhmmToMinutes.
 *
 * Dual export like keyspace.js: a browser global and a CommonJS module.
 */
(function initMeetingTimes(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.MeetingTimes = api;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';

    function integerValue(value) {
        if (value === null || value === undefined || value === '') return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
    }

    // HHMM (e.g. 1330) -> minutes since midnight. Throws on a non-numeric value,
    // matching the solver, which treats that as a programming error rather than
    // silently scheduling something at 00:00.
    function hhmmToMinutes(value) {
        const parsed = integerValue(value);
        if (parsed === null) throw new TypeError(`Invalid HHMM value: ${value}`);
        return Math.trunc(parsed / 100) * 60 + (parsed % 100);
    }

    function parseArray(raw) {
        if (!raw) return null;
        let parsed;
        try {
            parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch (error) {
            return null;
        }
        return Array.isArray(parsed) ? parsed : null;
    }

    function parseHHMM(raw) {
        const rows = parseArray(raw);
        if (!rows) return [];
        const meetings = [];
        for (const meeting of rows) {
            const day = integerValue(meeting?.meet_day);
            const start = integerValue(meeting?.start_time);
            const end = integerValue(meeting?.end_time);
            // Discard the whole array on any bad entry -- deliberate, not a
            // convenience. Do not "fix" this to skip the offending row.
            if (day === null || start === null || end === null) return [];
            meetings.push({ day, start, end });
        }
        return meetings;
    }

    // Loose, non-throwing HHMM -> minutes, kept private because it is the map's
    // conversion, not the solver's: Number instead of the strict integerValue,
    // and no throw, so a malformed value flows through as NaN exactly as the
    // map's own copy produces.
    function looseMinutes(value) {
        const time = Number(value);
        return Math.floor(time / 100) * 60 + (time % 100);
    }

    function parseMinutes(raw) {
        const rows = parseArray(raw);
        if (!rows) return [];
        return rows.map(meeting => ({
            day: Number(meeting.meet_day),
            start: looseMinutes(meeting.start_time),
            end: looseMinutes(meeting.end_time),
        }));
    }

    return { parseHHMM, parseMinutes, hhmmToMinutes };
}));

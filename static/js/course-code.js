/*
 * The one place a course code is turned into its canonical "SUBJ NUM" form.
 *
 * This logic had drifted into four copies with four different regexes -- 2-5
 * letters here, 2-8 there, 3-4 unanchored elsewhere -- so the same string could
 * normalise one way in State, another in the data store, and be rejected
 * outright in search. Shard keys are derived from the data-store spelling, so
 * that one is authoritative and the others move to it.
 *
 * Two entry points, because callers want two different things from a bad input.
 * normalize() is lenient: it canonicalises a real code and otherwise hands back
 * the cleaned text unchanged, which is what the data store needs -- it splits on
 * the space to find a subject shard and must not be handed an empty string it
 * would treat as a valid lookup. parse() is strict: a real code or the empty
 * string, which State and the degree wizard use as a validation gate (a record
 * whose code will not parse is dropped; typed input that will not parse is
 * refused).
 *
 * Dual export like keyspace.js: a classic-script global in the browser and a
 * CommonJS module under Node's test runner.
 */
(function initCourseCode(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.CourseCode = api;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';

    // Anchored on purpose: a course code is the whole string, not a fragment of
    // it. 2-8 letters and one-or-more digits are the data-store bounds, the
    // widest of the four originals, so nothing that used to normalise stops.
    const CODE_PATTERN = /^([A-Z]{2,8})\s*(\d+[A-Z]?)$/;

    function clean(value) {
        return String(value || '')
            .trim()
            .toUpperCase()
            .replace(/\s+/g, ' ');
    }

    function normalize(value) {
        return clean(value).replace(CODE_PATTERN, '$1 $2');
    }

    function parse(value) {
        const match = clean(value).match(CODE_PATTERN);
        return match ? `${match[1]} ${match[2]}` : '';
    }

    return { normalize, parse };
}));

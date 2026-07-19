/*
 * The Term value type.
 *
 * This is the only place a term string literal is constructed or picked apart.
 * Before this, the YYYYMM grammar was restated in the relay, in the offering
 * pipeline, and in prose, and the prose had already drifted -- it claimed 06 and
 * 07 were summer terms, which every implementation rejects. Parsing in one place
 * means a format change is one edit here plus whatever the contract says.
 */
(function initTerm(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root.UniversityDomain) root.UniversityDomain = {};
    root.UniversityDomain.Term = api;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';

    const PATTERN = /^\d{4}(?:01|05|08)$/;
    const SEASONS = Object.freeze({ '01': 'Spring', '05': 'Summer', '08': 'Fall' });

    function isValid(value) {
        return PATTERN.test(String(value ?? ''));
    }

    /* Returns null rather than throwing: callers receive terms from storage and
     * from URLs, where an invalid value is expected input, not a bug. */
    function parse(value) {
        const code = String(value ?? '');
        if (!isValid(code)) return null;
        const suffix = code.slice(4);
        return Object.freeze({
            code,
            year: Number(code.slice(0, 4)),
            season: SEASONS[suffix],
            seasonCode: suffix,
            label: `${SEASONS[suffix]} ${code.slice(0, 4)}`,
        });
    }

    function label(value) {
        const term = parse(value);
        return term ? term.label : String(value ?? '');
    }

    /* Ordering by code works because the format sorts chronologically, but
     * saying so here stops every caller from rediscovering it. */
    function compare(left, right) {
        return String(left ?? '').localeCompare(String(right ?? ''));
    }

    function seasons() {
        return { ...SEASONS };
    }

    return { PATTERN, isValid, parse, label, compare, seasons };
}));

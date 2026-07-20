/*
 * The FOSE codec. Upstream field names appear here and nowhere else.
 *
 * Decoding is the obvious half. Encoding matters just as much: the request
 * grammar is upstream vocabulary too, and building request bodies in the UI is
 * how `srcdb` and `criteria` leaked across the application in the first place.
 *
 * The grammar this implements is stated once in contracts/wire/fose-v1.json and
 * enforced by tests/test_wire_contract.js against the running relay.
 */
(function initFoseCodec(root, factory) {
    const domain = root.UniversityDomain || {};
    const Section = domain.Section
        || (typeof require === 'function' ? require('../domain/section.js') : null);
    const Term = domain.Term
        || (typeof require === 'function' ? require('../domain/term.js') : null);
    const api = factory(Section, Term);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root.UniversityWire) root.UniversityWire = {};
    root.UniversityWire.foseV1 = api;
}(typeof globalThis === 'object' ? globalThis : self, (Section, Term) => {
    'use strict';

    const ALLOWED_FIELDS = Object.freeze(['alias', 'course_attr', 'crn', 'keyword', 'stat', 'subject']);
    const MAX_CRITERIA = 6;
    const MAX_VALUE_LENGTH = 120;

    /* Encode a domain query into the upstream request body. Invalid input throws
     * here rather than being sent and refused with a 400 the user has to read. */
    function encodeSearch(query) {
        if (!Term.isValid(query?.term)) {
            throw new TypeError(`Not a term: ${query?.term}`);
        }
        const criteria = (query.criteria || []).map(criterion => {
            if (!ALLOWED_FIELDS.includes(criterion.field)) {
                throw new TypeError(`Field not accepted upstream: ${criterion.field}`);
            }
            const value = String(criterion.value ?? '');
            if (!value.length || value.length > MAX_VALUE_LENGTH) {
                throw new TypeError(`Criterion value must be 1-${MAX_VALUE_LENGTH} characters`);
            }
            return { field: criterion.field, value };
        });
        if (!criteria.length || criteria.length > MAX_CRITERIA) {
            throw new TypeError(`A search needs 1-${MAX_CRITERIA} criteria`);
        }
        if (criteria.every(criterion => criterion.field === 'stat')) {
            throw new TypeError('A status filter alone is not a search');
        }
        return { other: { srcdb: query.term }, criteria };
    }

    function encodeDetails(crn, term) {
        if (!/^\d{5}$/.test(String(crn ?? ''))) throw new TypeError(`Not a CRN: ${crn}`);
        if (!Term.isValid(term)) throw new TypeError(`Not a term: ${term}`);
        return { group: `crn:${crn}`, srcdb: term };
    }

    /* Decode one upstream row into a Section. Every upstream field name in the
     * application appears in this function. */
    function decodeSection(row, term) {
        return Section.createSection({
            crn: row.crn,
            code: row.code,
            title: row.title,
            sectionNumber: row.no,
            term: row.srcdb || term,
            instructor: row.instr,
            meetingTimes: row.meetingTimes,
            instructionalMethod: row.inst_mthd,
            scheduleType: row.schd,
            cancelled: row.isCancelled === 'Y' || row.isCancelled === true,
            seatsOpen: row.total,
        }, { source: Section.SOURCES.LIVE });
    }

    function decodeSearch(payload, term) {
        const rows = Array.isArray(payload?.results) ? payload.results : [];
        return rows.map(row => decodeSection(row, term));
    }

    /*
     * Decode while preserving the upstream row.
     *
     * The plan's sequencing: normalise on ingest so every reader gains the
     * domain fields at once, then migrate readers independently. A hard swap
     * would mean editing 44 read sites across search.js and scheduler.js in one
     * commit, which is the atomic change the critics warned about.
     *
     * So the result carries both: the original fields, unchanged, plus the
     * domain shape. New code reads `seatsOpen` and `availabilityKnown`; existing
     * code keeps working; and a reader can be moved over one at a time with the
     * suite green throughout. The upstream names disappear from the UI when the
     * last reader moves, not before.
     */
    function decodeSectionCompat(row, term) {
        const section = decodeSection(row, term);
        // Row last, deliberately. Spreading the domain shape over the upstream
        // one replaced fields whose representations differ -- meetingTimes
        // arrives as a JSON string upstream and as an array in the domain -- and
        // silently destroyed the value every existing reader depends on. A
        // compat layer adds; it must never overwrite.
        return { ...section, ...row };
    }

    function decodeSearchCompat(payload, term) {
        const rows = Array.isArray(payload?.results) ? payload.results : [];
        return { ...payload, results: rows.map(row => decodeSectionCompat(row, term)) };
    }

    return {
        ALLOWED_FIELDS,
        MAX_CRITERIA,
        MAX_VALUE_LENGTH,
        encodeSearch,
        encodeDetails,
        decodeSection,
        decodeSearch,
        decodeSectionCompat,
        decodeSearchCompat,
    };
}));

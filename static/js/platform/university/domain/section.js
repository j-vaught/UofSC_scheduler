/*
 * The Section domain type.
 *
 * createSection is the only constructor. That matters more than it looks: the
 * UI is a *producer* of the wire shape as well as a consumer, so grepping for
 * field reads misses the places that synthesise a section. Funnelling
 * construction through one function means a field rename has one edit site
 * rather than an unknown number.
 *
 * Provenance is required rather than optional. A section is either live from the
 * university, or from a published catalog release, and the difference decides
 * whether the interface may claim a seat count. Making it a required argument
 * stops "unknown" from being represented by an absent field that reads as false.
 */
(function initSection(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root.UniversityDomain) root.UniversityDomain = {};
    root.UniversityDomain.Section = api;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';

    const SOURCES = Object.freeze({ LIVE: 'live', CATALOG: 'catalog' });

    function toInteger(value) {
        // Upstream sends counts as decimal strings, sometimes with a trailing
        // ".0". Booleans coerce to 0/1 in JavaScript, so they are refused.
        if (typeof value === 'boolean' || value === null || value === undefined) return null;
        const text = String(value).replace(/\.0$/, '').trim();
        if (!/^-?\d+$/.test(text)) return null;
        return Number(text);
    }

    /* Upstream sends meetingTimes as a JSON *string*, not an array. Treating a
     * non-array as empty silently discarded every meeting time, which left the
     * solver unable to place any section at all. */
    function normaliseMeetingTimes(value) {
        if (Array.isArray(value)) return [...value];
        if (typeof value === 'string' && value.trim()) {
            try {
                const parsed = JSON.parse(value);
                return Array.isArray(parsed) ? parsed : [];
            } catch (error) {
                return [];
            }
        }
        return [];
    }

    function createSection(fields, provenance) {
        if (!provenance || !Object.values(SOURCES).includes(provenance.source)) {
            throw new TypeError(
                'createSection requires provenance {source: "live"|"catalog"}; '
                + 'without it the interface cannot tell a real seat count from an unknown one',
            );
        }
        const seatsOpen = toInteger(fields.seatsOpen);
        return Object.freeze({
            crn: String(fields.crn ?? ''),
            code: String(fields.code ?? ''),
            title: String(fields.title ?? ''),
            sectionNumber: String(fields.sectionNumber ?? ''),
            term: String(fields.term ?? ''),
            instructor: fields.instructor ? String(fields.instructor) : '',
            meetingTimes: normaliseMeetingTimes(fields.meetingTimes),
            instructionalMethod: fields.instructionalMethod ? String(fields.instructionalMethod) : '',
            scheduleType: fields.scheduleType ? String(fields.scheduleType) : '',
            cancelled: Boolean(fields.cancelled),
            seatsOpen,
            // The distinction the old shape blurred: a catalog section has no
            // seat information at all, which is not the same as zero seats.
            availabilityKnown: provenance.source === SOURCES.LIVE && seatsOpen !== null,
            source: provenance.source,
        });
    }

    function isOpen(section) {
        return section.availabilityKnown ? section.seatsOpen > 0 : null;
    }

    return { SOURCES, createSection, isOpen, toInteger, normaliseMeetingTimes };
}));

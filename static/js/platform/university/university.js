/*
 * The firewall facade.
 *
 * Everything outside this directory asks for courses in domain terms and gets
 * domain types back. Nothing outside sees a `srcdb`, a `criteria` array, or a
 * `total` that is really a seat count as a string.
 *
 * The payoff is the API-change story: when classes.sc.edu changes a field name,
 * the edit is in wire/fose-v1.js and the contract, and no UI file moves. That is
 * constraint 6, and it is only true while this stays the single crossing point.
 */
(function initUniversity(root, factory) {
    const wire = (root.UniversityWire || {}).foseV1
        || (typeof require === 'function' ? require('./wire/fose-v1.js') : null);
    const domain = root.UniversityDomain || {};
    const Term = domain.Term
        || (typeof require === 'function' ? require('./domain/term.js') : null);
    const api = factory(wire, Term);
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.University = api;
}(typeof globalThis === 'object' ? globalThis : self, (wire, Term) => {
    'use strict';

    function create({ transport }) {
        if (typeof transport !== 'function') {
            throw new TypeError('University needs a transport(path, body) function');
        }
        return {
            /* Search live sections. Takes a domain query, returns Sections. */
            async searchSections(query) {
                const body = wire.encodeSearch(query);
                const payload = await transport('/api/search', body);
                return wire.decodeSearch(payload, query.term);
            },

            async sectionDetails(crn, term) {
                const body = wire.encodeDetails(crn, term);
                return transport('/api/details', body);
            },

            /* Exposed so callers validate terms without importing the grammar. */
            isValidTerm: Term.isValid,
            parseTerm: Term.parse,
            termLabel: Term.label,
        };
    }

    return { create };
}));

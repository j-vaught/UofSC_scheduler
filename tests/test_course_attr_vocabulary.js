'use strict';

/*
 * The Carolina Core search vocabulary, checked against live upstream.
 *
 * course_attr is matched on an exact display string, and both ways of getting
 * it wrong are silent and opposite. An unrecognised criteria *field* makes
 * upstream ignore the criterion and answer with the entire term. An
 * unrecognised *value* for a recognised field answers with nothing. Neither is
 * an error, so a reworded label upstream turns the filter into either a no-op
 * or an empty result and nothing anywhere says so.
 *
 * That is not hypothetical. The search page's own dropdown reads "GFL: Global
 * Language"; the value that matches is "GFL: Global/Language (3GFL)". Taking
 * the wording from the dropdown produced zero results and looked exactly like
 * an outcome no section carries.
 *
 * This is the only test in the suite that talks to the network, so it is
 * opt-in: it skips unless CHECK_LIVE_UPSTREAM=1. Run it when changing the
 * vocabulary, and periodically -- a green offline suite cannot tell you the
 * university renamed an attribute.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const CarolinaCore = require('../static/js/carolina-core.js');

const LIVE = process.env.CHECK_LIVE_UPSTREAM === '1';
const TERM = process.env.CHECK_LIVE_TERM || '202608';
const UPSTREAM = 'https://classes.sc.edu/api/?page=fose&route=search';

async function search(criteria) {
    const response = await fetch(UPSTREAM, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ other: { srcdb: TERM }, criteria }),
    });
    assert.ok(response.ok, `upstream answered ${response.status}`);
    const payload = await response.json();
    return payload.results || [];
}

/* Offline: the shape of the vocabulary itself. */

test('every outcome the UI offers has a pinned search value', () => {
    const offered = Object.keys(CarolinaCore.labels);
    assert.equal(offered.length, 10);
    for (const outcome of offered) {
        const value = CarolinaCore.searchValue(outcome);
        assert.notEqual(value, '', `${outcome} has no upstream search value`);
        // "CODE: Label (3CODE)" -- the code appears twice, and a value missing
        // the parenthesised form is the shape that silently matches nothing.
        assert.match(value, new RegExp(`^${outcome}: .+ \\(3${outcome}\\)$`), value);
    }
});

test('an unknown outcome yields no search value rather than a wrong one', () => {
    for (const bad of ['', null, undefined, 'NOPE', 'arp ']) {
        assert.equal(CarolinaCore.searchValue(bad), bad === 'arp ' ? CarolinaCore.searchValues.ARP : '');
    }
});

test('the pinned values are not the search page dropdown wording', () => {
    // The one that caught this out. If someone "corrects" it to match the
    // dropdown, the GFL filter silently returns nothing.
    assert.equal(CarolinaCore.searchValue('GFL'), 'GFL: Global/Language (3GFL)');
    assert.notEqual(CarolinaCore.searchValue('GFL'), 'GFL: Global Language (3GFL)');
});

/* Live: does upstream still answer to each of these? */

test('every pinned value still matches sections upstream', { skip: !LIVE }, async () => {
    const empty = [];
    for (const [outcome, value] of Object.entries(CarolinaCore.searchValues)) {
        const results = await search([{ field: 'course_attr', value }]);
        if (results.length === 0) empty.push(`${outcome} (${value})`);
    }
    assert.deepEqual(
        empty,
        [],
        `these outcomes returned nothing, which means the wording changed upstream or `
        + `no section carries them in ${TERM}; check against live data before assuming the latter`,
    );
});

/*
 * The failure that makes the rest of this dangerous: upstream does not reject
 * a criteria field it does not know, it ignores it and answers with the whole
 * term. If course_attr is ever renamed, the filter stops filtering rather than
 * erroring, so this pins that course_attr is still recognised at all.
 */
test('course_attr is still a recognised criteria field', { skip: !LIVE }, async () => {
    const all = await search([{ field: 'subject', value: 'ENGL' }]);
    const filtered = await search([
        { field: 'subject', value: 'ENGL' },
        { field: 'course_attr', value: CarolinaCore.searchValue('CMW') },
    ]);
    assert.ok(filtered.length > 0, 'CMW should match some ENGL sections');
    assert.ok(
        filtered.length < all.length,
        'adding course_attr did not narrow the result set, so upstream is ignoring the field',
    );
});

test('a criterion upstream does not recognise would return everything', { skip: !LIVE }, async () => {
    // Documents the hazard rather than the fix: this is what a renamed field
    // looks like from here, and why the narrowing check above exists.
    const bogus = await search([{ field: 'definitely_not_a_field', value: 'x' }]);
    const engl = await search([{ field: 'subject', value: 'ENGL' }]);
    assert.ok(
        bogus.length > engl.length,
        'expected an unknown field to be ignored and return the whole term',
    );
});

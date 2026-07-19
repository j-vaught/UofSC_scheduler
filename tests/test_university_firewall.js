'use strict';

/*
 * The firewall's job is that upstream vocabulary stops here. These check the
 * property rather than the implementation: given a real captured payload, does
 * anything upstream-shaped survive the crossing, and does a field rename stay
 * contained?
 *
 * The fixture is a genuine relay response, not one written to make this pass.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Term = require('../static/js/platform/university/domain/term.js');
const Section = require('../static/js/platform/university/domain/section.js');
const codec = require('../static/js/platform/university/wire/fose-v1.js');
const University = require('../static/js/platform/university/university.js');

const ROOT = path.resolve(__dirname, '..');
const payload = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'tests/fixtures/fose_search_csce.json'), 'utf8'),
);
const contract = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'contracts/wire/fose-v1.json'), 'utf8'),
);

test('Term is the only thing that knows the term grammar', () => {
    for (const value of contract.types.term.valid) assert.equal(Term.isValid(value), true, value);
    for (const value of contract.types.term.invalid) assert.equal(Term.isValid(value), false, value);
    assert.deepEqual(Term.parse('202608'), {
        code: '202608', year: 2026, season: 'Fall', seasonCode: '08', label: 'Fall 2026',
    });
    assert.equal(Term.parse('202606'), null, 'an invalid term parses to null, not a guess');
});

test('decoding a real payload yields no upstream field names', () => {
    const sections = codec.decodeSearch(payload, '202608');
    assert.ok(sections.length > 0, 'the fixture should contain sections');

    // The names that leaked across the application before the firewall existed.
    const upstreamOnly = ['srcdb', 'no', 'total', 'instr', 'inst_mthd', 'schd',
        'isCancelled', 'mpkey', 'meets', 'meeting_name', 'hide', 'stat', 'key'];
    for (const section of sections) {
        for (const name of upstreamOnly) {
            assert.equal(
                Object.prototype.hasOwnProperty.call(section, name), false,
                `${name} crossed the firewall on ${section.code}`,
            );
        }
    }
});

test('a decoded section carries the domain shape', () => {
    const [section] = codec.decodeSearch(payload, '202608');
    for (const field of ['crn', 'code', 'title', 'sectionNumber', 'term', 'instructor',
        'meetingTimes', 'instructionalMethod', 'scheduleType', 'cancelled', 'seatsOpen',
        'availabilityKnown', 'source']) {
        assert.ok(field in section, `a Section should have ${field}`);
    }
    assert.equal(section.source, 'live');
    assert.equal(typeof section.crn, 'string');
});

test('seat counts arrive as decimal strings and become numbers', () => {
    // Upstream sends "9" and sometimes "9.0"; booleans must not coerce to 0/1.
    assert.equal(Section.toInteger('9'), 9);
    assert.equal(Section.toInteger('9.0'), 9);
    assert.equal(Section.toInteger(' 12 '), 12);
    assert.equal(Section.toInteger(true), null, 'a boolean is not a count');
    assert.equal(Section.toInteger(''), null);
    assert.equal(Section.toInteger(null), null);
});

test('provenance is required, so unknown availability cannot be mistaken for zero', () => {
    assert.throws(() => Section.createSection({ crn: '10868' }, undefined), /provenance/);
    assert.throws(() => Section.createSection({ crn: '10868' }, { source: 'guess' }), /provenance/);

    const live = Section.createSection({ crn: '1', seatsOpen: '0' }, { source: 'live' });
    const catalog = Section.createSection({ crn: '1' }, { source: 'catalog' });

    assert.equal(live.availabilityKnown, true);
    assert.equal(Section.isOpen(live), false, 'a live section with zero seats is closed');
    assert.equal(catalog.availabilityKnown, false);
    assert.equal(Section.isOpen(catalog), null, 'a catalog section is unknown, not closed');
});

test('requests are encoded here too, so the UI never builds upstream bodies', () => {
    const body = codec.encodeSearch({ term: '202608', criteria: [{ field: 'subject', value: 'CSCE' }] });
    assert.deepEqual(body, { other: { srcdb: '202608' }, criteria: [{ field: 'subject', value: 'CSCE' }] });

    assert.deepEqual(codec.encodeDetails('10868', '202608'), { group: 'crn:10868', srcdb: '202608' });
});

test('encoding refuses what the relay would refuse, before the round trip', () => {
    const rules = contract.routes['/api/search'].request.criteria;
    assert.throws(() => codec.encodeSearch({ term: '202606', criteria: [{ field: 'subject', value: 'X' }] }), /term/);
    assert.throws(() => codec.encodeSearch({ term: '202608', criteria: [{ field: 'instructor', value: 'Deng' }] }), /not accepted/);
    assert.throws(() => codec.encodeSearch({ term: '202608', criteria: [] }), /1-6 criteria/);
    assert.throws(() => codec.encodeSearch({ term: '202608', criteria: [{ field: 'stat', value: 'open' }] }), /alone is not a search/);
    assert.throws(
        () => codec.encodeSearch({ term: '202608', criteria: [{ field: 'keyword', value: 'x'.repeat(rules.value_max_length + 1) }] }),
        /1-120 characters/,
    );
    assert.throws(() => codec.encodeDetails('1086', '202608'), /Not a CRN/);
});

test('the codec agrees with the contract about what is allowed', () => {
    const rules = contract.routes['/api/search'].request.criteria;
    assert.deepEqual([...codec.ALLOWED_FIELDS].sort(), [...rules.allowed_fields].sort());
    assert.equal(codec.MAX_CRITERIA, rules.max_items);
    assert.equal(codec.MAX_VALUE_LENGTH, rules.value_max_length);
});

test('a field rename upstream is contained to the codec', () => {
    // Simulate classes.sc.edu renaming its seat count. Only the codec should
    // need editing; the domain type and every caller stay as they are.
    const renamed = { ...payload, results: payload.results.map(row => {
        const copy = { ...row, seats_remaining: row.total };
        delete copy.total;
        return copy;
    }) };
    const before = codec.decodeSearch(payload, '202608')[0];
    const after = codec.decodeSearch(renamed, '202608')[0];
    // The decode goes stale, which is the point: it fails in the codec, not in
    // a view three files away that silently renders undefined.
    assert.equal(before.availabilityKnown, true);
    assert.equal(after.availabilityKnown, false,
        'a rename shows up as unknown availability at the boundary, not as a wrong number downstream');
});

test('the facade returns domain types and never leaks the transport shape', async () => {
    const calls = [];
    const university = University.create({
        transport: async (route, body) => { calls.push({ route, body }); return payload; },
    });
    const sections = await university.searchSections({
        term: '202608', criteria: [{ field: 'subject', value: 'CSCE' }],
    });
    assert.equal(calls[0].route, '/api/search');
    assert.deepEqual(calls[0].body.other, { srcdb: '202608' });
    assert.ok(sections.length > 0);
    assert.equal(sections[0].source, 'live');
    assert.equal('srcdb' in sections[0], false);
});

test('the facade refuses a transport it cannot call', () => {
    assert.throws(() => University.create({}), /transport/);
});

test('api.js and the live client route requests through the codec', () => {
    // The firewall only holds while these are the encode sites. A hand-built
    // body reintroduces upstream vocabulary at a call site, which is the leak
    // this phase exists to close.
    for (const file of ['static/js/api.js', 'static/js/live-university-client.js']) {
        const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
        const searchFn = source.slice(source.indexOf('async searchCourses'), source.indexOf('async searchCourses') + 700);
        assert.match(searchFn, /encodeSearch/, `${file} should encode through the codec`);
        const detailsFn = source.slice(source.indexOf('async getDetails'), source.indexOf('async getDetails') + 700);
        assert.match(detailsFn, /encodeDetails/, `${file} should encode details through the codec`);
    }
});

test('the firewall loads before the modules that use it', () => {
    const html = fs.readFileSync(path.join(ROOT, 'static/index.html'), 'utf8');
    const at = src => html.indexOf(`src="${src}`);
    const term = at('/static/js/platform/university/domain/term.js');
    const section = at('/static/js/platform/university/domain/section.js');
    const codecTag = at('/static/js/platform/university/wire/fose-v1.js');
    const api = at('/static/js/api.js');
    const client = at('/static/js/live-university-client.js');

    assert.ok(term > 0 && section > 0 && codecTag > 0, 'the firewall must be loaded');
    assert.ok(term < codecTag, 'Term must load before the codec that uses it');
    assert.ok(section < codecTag, 'Section must load before the codec that uses it');
    assert.ok(codecTag < api, 'the codec must load before api.js');
    assert.ok(codecTag < client, 'the codec must load before the live client');
});

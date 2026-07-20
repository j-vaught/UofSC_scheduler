'use strict';

/*
 * The shared course-code normaliser (static/js/course-code.js), which replaced
 * four drifting copies. Two entry points with two contracts: normalize() is
 * lenient and keeps a non-code as cleaned text (the data store splits it to find
 * a shard and must not get ''), parse() is strict and returns '' for a non-code
 * (State and the degree wizard use that as a validation gate).
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const CourseCode = require('../static/js/course-code.js');

test('normalize canonicalises a real code and preserves the data-store contract', () => {
    // These two are pinned by test_data_store.js through data-store's own
    // normalizeCourseCode, which now delegates here; keep them identical.
    assert.equal(CourseCode.normalize('csce145'), 'CSCE 145');
    assert.equal(CourseCode.normalize(' MATH   141 '), 'MATH 141');
    assert.equal(CourseCode.normalize('ENGL 101'), 'ENGL 101');
});

test('normalize hands back cleaned text when the input is not a code', () => {
    // The lenient fallback: a non-code is cleaned (trimmed, upper-cased, spaces
    // collapsed) but not blanked, so a caller that splits on the space still
    // gets a subject token rather than an empty lookup.
    assert.equal(CourseCode.normalize('  physics for poets '), 'PHYSICS FOR POETS');
    assert.equal(CourseCode.normalize(''), '');
    assert.equal(CourseCode.normalize(null), '');
});

test('parse returns the canonical code or the empty string, never cleaned prose', () => {
    assert.equal(CourseCode.parse('csce145'), 'CSCE 145');
    assert.equal(CourseCode.parse(' math 141 '), 'MATH 141');
    assert.equal(CourseCode.parse('CSCE 145L'), 'CSCE 145L');
    // Not a code -> '' so a caller can treat it as invalid.
    assert.equal(CourseCode.parse('not a course'), '');
    assert.equal(CourseCode.parse('CSCE'), '');
    assert.equal(CourseCode.parse(''), '');
    assert.equal(CourseCode.parse(undefined), '');
});

test('the two entry points agree on real codes and diverge only on non-codes', () => {
    for (const code of ['CSCE 145', 'MATH 141', 'ENGL 101', 'BADM 371H']) {
        assert.equal(CourseCode.normalize(code), CourseCode.parse(code));
    }
    // A non-code is where they part: normalize keeps it, parse rejects it.
    assert.equal(CourseCode.normalize('HELLO'), 'HELLO');
    assert.equal(CourseCode.parse('HELLO'), '');
});

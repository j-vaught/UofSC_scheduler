'use strict';

/*
 * The rule these enforce: only a code in NOT_FOUND may render as "this does not
 * exist." Everything else must say something failed.
 *
 * This is not theoretical. grades.js rendered every thrown error as "No
 * Columbia grade history is available for this course", so a relay 502 told a
 * student their course has no grade data and they stopped looking.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const errors = require('../static/js/errors.js');
const { CODES, AppError, classify, toUserMessage, isAbsence } = errors;

test('only the not-found family may claim absence', () => {
    const absence = [CODES.NOT_FOUND, CODES.NO_GRADE_HISTORY, CODES.NO_OFFERING_HISTORY,
        CODES.TERM_NOT_PUBLISHED];
    const failure = [CODES.NETWORK, CODES.UPSTREAM, CODES.TIMEOUT, CODES.RATE_LIMITED,
        CODES.BLOCKED, CODES.INTEGRITY, CODES.STORAGE, CODES.MALFORMED, CODES.UNKNOWN];

    for (const code of absence) {
        assert.equal(new AppError(code).isNotFound, true, `${code} should count as absence`);
    }
    for (const code of failure) {
        assert.equal(new AppError(code).isNotFound, false, `${code} must NOT claim absence`);
    }
});

test('no failure message tells the student the thing does not exist', () => {
    const failure = [CODES.NETWORK, CODES.UPSTREAM, CODES.TIMEOUT, CODES.RATE_LIMITED,
        CODES.BLOCKED, CODES.INTEGRITY, CODES.MALFORMED, CODES.UNKNOWN];
    for (const code of failure) {
        const message = new AppError(code).message;
        assert.doesNotMatch(
            message,
            /\b(no|none|not recorded|does not exist|unavailable for this)\b/i,
            `${code} reads as absence: "${message}"`,
        );
    }
});

test('a relay failure is classified as failure, not absence', () => {
    // The exact case that misled students.
    const upstream = classify({ status: 502, message: 'Bad Gateway' });
    assert.equal(upstream.code, CODES.UPSTREAM);
    assert.equal(isAbsence(upstream), false);
    assert.match(toUserMessage(upstream), /did not respond/i);

    assert.equal(classify({ status: 429 }).code, CODES.RATE_LIMITED);
    assert.equal(classify({ status: 404 }).code, CODES.NOT_FOUND);
    assert.equal(isAbsence(classify({ status: 404 })), true);
});

test('a blocked or offline fetch is reported as network, not absence', () => {
    // A CSP block and an offline fetch both surface as a bare TypeError.
    const blocked = classify(new TypeError('Failed to fetch'));
    assert.equal(blocked.code, CODES.NETWORK);
    assert.equal(isAbsence(blocked), false);
});

test('an aborted request is a timeout', () => {
    const aborted = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    assert.equal(classify(aborted).code, CODES.TIMEOUT);
});

test('integrity, storage, and parse failures are distinguished', () => {
    assert.equal(classify(new Error('sha-256 mismatch')).code, CODES.INTEGRITY);
    assert.equal(classify(new Error('QuotaExceededError')).code, CODES.STORAGE);
    assert.equal(classify(new Error('Unexpected token < in JSON')).code, CODES.MALFORMED);
});

test('classification survives things that are not Errors', () => {
    for (const thrown of [undefined, null, 'a string', 42, {}]) {
        const classified = classify(thrown);
        assert.ok(classified instanceof AppError, `${String(thrown)} should classify`);
        assert.ok(classified.message.length > 0);
        assert.equal(classified.isNotFound, false, 'an unclassifiable throw must not claim absence');
    }
});

test('an unrecognised code degrades to unknown rather than an empty message', () => {
    const made_up = new AppError('NOT_A_REAL_CODE');
    assert.equal(made_up.code, CODES.UNKNOWN);
    assert.ok(made_up.message.length > 0);
});

test('grades.js no longer renders every failure as missing history', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'static/js/grades.js'), 'utf8',
    );
    const catchBlock = source.slice(source.indexOf('_courseLoadId) return;'));
    assert.doesNotMatch(
        catchBlock.slice(0, 400),
        /No Columbia grade history is available for this course/,
        'the catch must not hard-code absence for every failure',
    );
    assert.match(catchBlock.slice(0, 400), /AppErrors\.toUserMessage/);
});

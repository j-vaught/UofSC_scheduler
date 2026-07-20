'use strict';

/*
 * Startup used to be one unguarded sequence of init() calls. A throw in any of
 * them skipped every module after it, and nothing reported the failure, so the
 * page looked finished and did nothing. That is how a CSP-blocked script turned
 * every control on the site inert without a single console entry.
 *
 * These assert the shape that prevents it: each feature starts in isolation,
 * failures are collected rather than swallowed, and the surviving features still
 * run.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const boot = fs.readFileSync(path.join(ROOT, 'static/js/boot.js'), 'utf8');

test('every feature starts through the supervisor, not a bare call', () => {
    // A bare `Thing.init();` at statement position is the pattern that caused the
    // outage. Everything must go through startFeature so one throw is contained.
    const bare = [...boot.matchAll(/^\s{4}([A-Z]\w+)\.init\(\);/gm)].map(m => m[1]);
    assert.deepEqual(bare, [], `these init calls are unguarded: ${bare.join(', ')}`);

    /*
     * The thirteen repetitive startFeature lines became one loop over
     * BOOT_SEQUENCE, so counting call sites no longer counts features. What
     * matters is unchanged: every entry starts under supervision, and the loop
     * that walks them is itself a startFeature call.
     */
    const sequenceAt = boot.indexOf('const BOOT_SEQUENCE = [');
    assert.notEqual(sequenceAt, -1, 'the boot sequence moved; this test is not reading it');
    const sequence = boot.slice(sequenceAt, boot.indexOf('];', sequenceAt));
    const entries = [...sequence.matchAll(/\['([^']+)',\s*\(\)\s*=>\s*(\w+)\]/g)];
    assert.ok(entries.length >= 13, `expected the full boot sequence, found ${entries.length}`);

    assert.match(
        boot,
        /for \(const \[label, resolve\] of BOOT_SEQUENCE\) \{\s*startFeature\(/,
        'the sequence must be walked through startFeature, not called directly',
    );

    // Bespoke startups that are not simple init() calls stay explicit.
    const supervised = [...boot.matchAll(/startFeature\(/g)].length;
    assert.ok(supervised >= 4, `expected the bespoke startups supervised too, found ${supervised}`);
});

/*
 * Each entry resolves its module through a thunk rather than a globalThis
 * lookup. That is not style: these are classic scripts, so `const Foo` at the
 * top level is a lexical binding that never becomes a property of globalThis.
 * Five of the thirteen modules -- SiteNotices, Tabs, Calendar, WalkingMap,
 * Preferences -- never assign themselves to the global object, so a name-based
 * lookup would report five working features as broken.
 */
test('the boot sequence resolves modules by binding, not by globalThis name', () => {
    const sequenceAt = boot.indexOf('const BOOT_SEQUENCE = [');
    const sequence = boot.slice(sequenceAt, boot.indexOf('];', sequenceAt));

    assert.doesNotMatch(sequence, /globalThis\[/, 'a globalThis lookup misses lexically-declared modules');
    for (const global of ['SiteNotices', 'Tabs', 'Calendar', 'WalkingMap', 'Preferences']) {
        assert.match(
            sequence,
            new RegExp(`\\(\\)\\s*=>\\s*${global}\\b`),
            `${global} must be resolved by binding; it is never set on globalThis`,
        );
    }
});

test('a failing feature does not stop the ones after it', () => {
    const order = [];
    const failures = [];
    // Mirrors startFeature's contract: run, catch, record, keep going.
    function startFeature(name, start) {
        try { start(); order.push(name); return true; } catch (error) { failures.push(name); return false; }
    }

    startFeature('first', () => {});
    startFeature('broken', () => { throw new Error('init blew up'); });
    startFeature('third', () => {});
    startFeature('fourth', () => {});

    assert.deepEqual(order, ['first', 'third', 'fourth']);
    assert.deepEqual(failures, ['broken']);
});

test('boot collects failures and reports them rather than swallowing', () => {
    assert.match(boot, /BOOT_FAILURES/, 'failures must be collected');
    assert.match(boot, /function reportBootFailures/, 'failures must be reported to the user');
    assert.match(boot, /reportBootFailures\(\);/, 'the report must actually be invoked');
    assert.match(boot, /console\.error/, 'failures must reach the console for diagnosis');
});

test('uncaught errors, rejections, and CSP violations are surfaced', () => {
    assert.match(boot, /addEventListener\('error'/, 'uncaught errors must be logged');
    assert.match(boot, /addEventListener\('unhandledrejection'/, 'rejections must be logged');
    assert.match(
        boot,
        /addEventListener\('securitypolicyviolation'/,
        'a CSP block must announce itself; silent blocking is what made the outage invisible',
    );
});

test('the term selector is supervised, since it ran before AppModal existed', () => {
    const termIndex = boot.indexOf("getElementById('term-select')");
    assert.ok(termIndex > 0, 'term selector wiring should still exist');
    const preceding = boot.slice(0, termIndex);
    const lastSupervisor = preceding.lastIndexOf('startFeature(');
    const lastClose = preceding.lastIndexOf('\n}');
    assert.ok(
        lastSupervisor > lastClose,
        'the term selector must be inside a startFeature block, or a missing element takes the modal down with it',
    );
});

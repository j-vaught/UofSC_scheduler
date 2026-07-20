'use strict';

/*
 * No feature may existence-check an application global.
 *
 * The feature modules are fenced: they reach collaborators through an injected
 * `deps` object and must not touch ambient app globals directly. A guard of the
 * form `typeof SomeGlobal !== 'undefined'` breaks that fence in the most
 * invisible way possible. Inside a properly fenced module the app global is not
 * in scope, so the guard is ALWAYS false and the code it protects silently
 * never runs -- no error, no failing test, just a feature that quietly does
 * less than it reads like it does. This pattern turned up in 10 of the 10
 * feature extractions, always guarding a real `deps.*` call, so a single scan
 * is worth keeping.
 *
 * The scan uses the regex below deliberately. `[A-Z]\w*` matches only
 * capitalised identifiers, which is what an application global looks like
 * (Profile, State, API, Search, Calendar, WalkingMap, ...). The lowercase
 * platform and host names a module legitimately probes for -- `require`,
 * `module`, `globalThis`, `self`, `window`, `document`, `localStorage`,
 * `navigator` -- are lowercase, so the regex never sees them and they need no
 * allowlist. Keep the capital-letter constraint: widening it to any identifier
 * would flag every one of those legitimate host checks.
 *
 * Comments are stripped before scanning, so a comment that merely describes the
 * pattern (several files document it) is not mistaken for a use of it.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const FEATURES = path.join(ROOT, 'static/js/features');

// The house regex. Single-quoted 'undefined' matches the codebase's style.
const GUARD = /typeof\s+([A-Z]\w*)\s*[!=]==\s*'undefined'/g;

/*
 * Genuinely legitimate existence checks, allowed permanently.
 *
 *  - IntersectionObserver / ResizeObserver: platform feature-detection. These
 *    are browser APIs that genuinely may be absent, and the guarded path is a
 *    real fallback, not dead code.
 *  - module: a CommonJS host check (`typeof module === 'object'`). Lowercase, so
 *    the regex never matches it; listed only to document the intent.
 *  - <feature>Parts: each split feature exposes its sibling part files through a
 *    private registry namespace (DegreePlanParts, SchedulerParts, SearchParts)
 *    that the part files populate before index.js runs, with a `require()`
 *    fallback for Node. This is dual-environment module composition, not an
 *    app-global reach: the namespace is the feature's own, and the guarded path
 *    is taken in the browser, so it is not the always-false bug above.
 */
const ALLOWED = new Set([
    'module',
    'IntersectionObserver',
    'ResizeObserver',
    'DegreePlanParts',
    'SchedulerParts',
    'SearchParts',
]);

/*
 * Temporary exceptions for existing live bugs. Source fixes are out of scope
 * for this test suite, so each real offender is parked here, scoped to its file
 * and identifier, until the owning code is corrected.
 *
 * None outstanding. static/js/features/degree-plan/coursework.js used to gate
 * `deps.onCourseworkChanged()` behind `typeof Profile !== 'undefined'` in two
 * places; the guard was always false inside the fence, so the callback
 * silently never fired. Fixed by calling deps.onCourseworkChanged()
 * unconditionally -- see tests/test_feature_degree_plan.js for the
 * behavioural regression test.
 */
const FIXME = [];

// Strip block and line comments while preserving line numbers, so a hit reports
// where it actually is and a comment about the pattern is not counted as a use.
function stripComments(source) {
    const lines = source.split('\n');
    let inBlock = false;
    return lines.map(raw => {
        let line = raw;
        if (inBlock) {
            const end = line.indexOf('*/');
            if (end === -1) return '';
            line = line.slice(end + 2);
            inBlock = false;
        }
        line = line.replace(/\/\*[\s\S]*?\*\//g, '');
        const open = line.indexOf('/*');
        if (open !== -1) { inBlock = true; line = line.slice(0, open); }
        return line.replace(/\/\/.*$/, '');
    });
}

function featureFiles() {
    const found = [];
    const walk = dir => {
        for (const entry of fs.readdirSync(dir)) {
            const full = path.join(dir, entry);
            if (fs.statSync(full).isDirectory()) walk(full);
            else if (full.endsWith('.js')) found.push(full);
        }
    };
    walk(FEATURES);
    return found;
}

function scan() {
    const hits = [];
    for (const file of featureFiles()) {
        const rel = path.relative(ROOT, file).replace('static/js/', '');
        stripComments(fs.readFileSync(file, 'utf8')).forEach((line, index) => {
            let match;
            GUARD.lastIndex = 0;
            while ((match = GUARD.exec(line))) {
                hits.push({ file: rel, line: index + 1, identifier: match[1] });
            }
        });
    }
    return hits;
}

const isFixme = hit => FIXME.some(entry => hit.file === entry.file && hit.identifier === entry.identifier);

test('no feature existence-checks an application global outside the allowlist', () => {
    const offenders = scan().filter(hit => !ALLOWED.has(hit.identifier) && !isFixme(hit));
    assert.deepEqual(
        offenders, [],
        'ambient app-global guards found; a fenced feature must reach collaborators '
            + 'through deps, not `typeof X !== \'undefined\'` (always false in a fence):\n'
            + offenders.map(o => `  ${o.file}:${o.line}  typeof ${o.identifier}`).join('\n'),
    );
});

test('every temporary FIXME allowlist entry still matches a real hit', () => {
    // The FIXME list is a debt ledger, not a permanent allowlist. When the guarded
    // code is fixed its hit disappears and the corresponding entry becomes dead
    // weight, so fail here to prompt its removal.
    const hits = scan();
    for (const entry of FIXME) {
        assert.ok(
            hits.some(hit => hit.file === entry.file && hit.identifier === entry.identifier),
            `stale FIXME allowlist entry: ${entry.file} no longer guards ${entry.identifier}; remove it`,
        );
    }
});

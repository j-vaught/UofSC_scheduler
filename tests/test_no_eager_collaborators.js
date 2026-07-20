'use strict';

/*
 * Composition points must resolve collaborators at call time, not at parse time.
 *
 * These are classic scripts. `const Foo = ...` at the top level of one is a
 * lexical binding that does not exist until that script has run, so a
 * composition point that writes
 *
 *     collaborator: (typeof Foo !== 'undefined' && Foo.method) ? ... : undefined,
 *
 * evaluates that ternary while its own file is being parsed. If Foo's script tag
 * comes later in index.html the property freezes as undefined for the life of
 * the page, and the feature silently takes whatever fallback it has -- which
 * looks like real data, not like a failure.
 *
 * This has now happened three times in this codebase:
 *
 *   - `History` resolved to the DOM's built-in History constructor rather than
 *     the application module, because history.js had not run yet. A wrong value
 *     that no existence check rejects, since it is very much defined.
 *   - The boot sequence, where a globalThis lookup would have reported five
 *     working features as missing.
 *   - grades.js froze `instructorSummaries` as undefined because index.html
 *     loads grades.js seven lines before scheduler.js. Every course showed "No
 *     matched grade history" while the instructor profile showed the same person
 *     with a full grade record.
 *
 * A getter costs nothing and removes the dependence on markup order entirely.
 * The rule this enforces: inside an object literal being passed to a feature
 * factory, an app-global existence check must be inside a function body -- a
 * getter or an arrow -- never a bare property value.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const COMPOSITION_DIR = path.join(ROOT, 'static/js');

/*
 * `Features` is the one legitimate parse-time lookup: every composition point
 * resolves its own factory that way, and the feature's part files are always
 * loaded immediately before it by construction.
 */
const PARSE_TIME_ALLOWED = new Set(['Features']);

function compositionPoints() {
    return fs.readdirSync(COMPOSITION_DIR)
        .filter(name => name.endsWith('.js'))
        .map(name => path.join(COMPOSITION_DIR, name))
        .filter(file => /createsomething|create[A-Z]\w*Feature\(/.test(fs.readFileSync(file, 'utf8')));
}

function stripComments(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('composition points resolve collaborators lazily, not at parse time', () => {
    const offenders = [];

    for (const file of compositionPoints()) {
        const source = stripComments(fs.readFileSync(file, 'utf8'));
        const lines = source.split('\n');

        lines.forEach((line, index) => {
            // A property whose value tests an app global: `name: (typeof Foo ...`
            // A getter (`get name() {`) or an arrow (`name: () => ...`) is fine,
            // because the check then runs when the feature asks.
            const property = line.match(/^\s{4,}([a-zA-Z_]\w*)\s*:\s*\(?\s*typeof\s+([A-Z]\w*)\s*!==\s*'undefined'/);
            if (!property) return;
            const [, propertyName, globalName] = property;
            if (PARSE_TIME_ALLOWED.has(globalName)) return;
            offenders.push(
                `${path.relative(ROOT, file)}:${index + 1} — ${propertyName} resolves ${globalName} `
                + 'at parse time; make it a getter',
            );
        });
    }

    assert.deepEqual(
        offenders,
        [],
        `these freeze a collaborator before its script may have run:\n  ${offenders.join('\n  ')}`,
    );
});

/*
 * The scanner is only worth having if it would actually catch the shape it is
 * named for, so this feeds it the exact line that shipped broken.
 */
test('the scanner catches the pattern that shipped in grades.js', () => {
    const broken = [
        'const Grades = (() => {',
        '    return factory.createGradesFeature({',
        "        instructorSummaries: (typeof Scheduler !== 'undefined' && Scheduler.currentInstructorSummaries)",
        '            ? (group, data, faculty) => Scheduler.currentInstructorSummaries(group, data, faculty)',
        '            : undefined,',
        '    });',
        '})();',
    ].join('\n');

    const offending = broken.split('\n').filter(line => (
        /^\s{4,}([a-zA-Z_]\w*)\s*:\s*\(?\s*typeof\s+([A-Z]\w*)\s*!==\s*'undefined'/.test(line)
    ));
    assert.equal(offending.length, 1, 'the pattern the scanner looks for must match the real defect');

    const fixed = broken.replace(
        "        instructorSummaries: (typeof Scheduler",
        '        get instructorSummaries() { return (typeof Scheduler',
    );
    const stillOffending = fixed.split('\n').filter(line => (
        /^\s{4,}([a-zA-Z_]\w*)\s*:\s*\(?\s*typeof\s+([A-Z]\w*)\s*!==\s*'undefined'/.test(line)
    ));
    assert.deepEqual(stillOffending, [], 'a getter must satisfy the scanner');
});

'use strict';

/*
 * The site serves script-src 'self' with no 'unsafe-inline' and no nonce, so
 * any inline <script> in index.html is refused by the browser. That failure is
 * silent: nothing throws, nothing logs, every control is simply inert.
 *
 * This regression guards the pair. If a future edit adds an inline script, or
 * relaxes script-src to permit one, one of these fails.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'static/index.html'), 'utf8');
const worker = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
const serviceWorker = fs.readFileSync(path.join(ROOT, 'static/service-worker.js'), 'utf8');

function scriptSrcDirective(source) {
    const policy = source.match(/'Content-Security-Policy':\s*"([^"]+)"/);
    assert.ok(policy, 'the worker must declare a Content-Security-Policy');
    const directive = policy[1].split(';').map(part => part.trim()).find(part => part.startsWith('script-src'));
    assert.ok(directive, 'the policy must set script-src');
    return directive;
}

test('index.html contains no inline script blocks', () => {
    // <script> with no src attribute is an inline block.
    const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>/gi)].map(match => match[0]);
    assert.deepEqual(inline, [], `inline <script> blocks are blocked by CSP: ${inline.join(', ')}`);
});

test('index.html has no inline event handler attributes', () => {
    const handlers = [...html.matchAll(/\son(?:click|load|submit|change|input|error)\s*=/gi)].map(m => m[0].trim());
    assert.deepEqual(handlers, [], `inline handlers are blocked by the same policy: ${handlers.join(', ')}`);
});

test('script-src stays strict, so the ban above remains necessary and sufficient', () => {
    const directive = scriptSrcDirective(worker);
    assert.ok(!directive.includes("'unsafe-inline'"), `script-src must not allow inline: ${directive}`);
    assert.ok(!directive.includes("'unsafe-eval'"), `script-src must not allow eval: ${directive}`);
    assert.ok(directive.includes("'self'"), `script-src must allow same-origin files: ${directive}`);
});

test('every script index.html loads is same-origin and precached', () => {
    const sources = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/gi)].map(match => match[1]);
    assert.ok(sources.length > 20, `expected the full module list, found ${sources.length}`);

    const external = sources.filter(src => /^[a-z]+:\/\//i.test(src) || src.startsWith('//'));
    assert.deepEqual(external, [], `script-src 'self' forbids cross-origin scripts: ${external.join(', ')}`);

    const precached = new Set([...serviceWorker.matchAll(/'(\/static\/js\/[^']+)'/g)].map(match => match[1]));
    const missing = sources.map(src => src.split('?')[0]).filter(src => !precached.has(src));
    assert.deepEqual(missing, [], `scripts absent from SHELL_ASSETS fail a cold offline start: ${missing.join(', ')}`);
});

test('boot.js owns the startup sequence and tolerates either document state', () => {
    const boot = fs.readFileSync(path.join(ROOT, 'static/js/boot.js'), 'utf8');
    assert.match(boot, /function boot\(\)/, 'the startup sequence should be a named function');
    assert.match(boot, /readyState === 'loading'/, 'boot must check readyState before waiting on DOMContentLoaded');
    assert.match(boot, /addEventListener\('DOMContentLoaded', boot\)/, 'boot must still wait when parsing');
    assert.match(boot, /\bboot\(\);/, 'boot must run immediately when the document is already parsed');
    assert.match(html, /<script src="\/static\/js\/boot\.js"><\/script>/, 'index.html must load boot.js');
});

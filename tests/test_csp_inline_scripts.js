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

    /*
     * The shell list is derived from this markup at build time now, so the
     * property worth checking flipped: it is no longer "did someone remember to
     * add it", it is "does the worker still defer to the build". A literal
     * array pasted back into service-worker.js would silently reintroduce the
     * drift, because the build would substitute nothing and ship the stale list.
     */
    assert.match(
        serviceWorker,
        /const SHELL_ASSETS = __SHELL_ASSETS__;/,
        'service-worker.js must take its shell list from the build, not carry one',
    );
    assert.doesNotMatch(
        serviceWorker,
        /'\/static\/js\/[^']+'/,
        'a hand-maintained asset list has crept back into the service worker',
    );
});

test('boot.js owns the startup sequence and tolerates either document state', () => {
    const boot = fs.readFileSync(path.join(ROOT, 'static/js/boot.js'), 'utf8');
    assert.match(boot, /function boot\(\)/, 'the startup sequence should be a named function');
    assert.match(boot, /readyState === 'loading'/, 'boot must check readyState before waiting on DOMContentLoaded');
    assert.match(boot, /addEventListener\('DOMContentLoaded', boot\)/, 'boot must still wait when parsing');
    assert.match(boot, /\bboot\(\);/, 'boot must run immediately when the document is already parsed');
    assert.match(html, /<script src="\/static\/js\/boot\.js"><\/script>/, 'index.html must load boot.js');
});

/*
 * connect-src has to list every host the page actually reaches, and the two
 * copies of the policy have to agree. Semantic search was silently disabled
 * because model weights redirect from huggingface.co to *.hf.co, which was not
 * listed -- the browser blocked the download and search fell back to direct
 * matching with no error beyond a banner.
 */

function connectSrc(source) {
    const policy = source.match(/Content-Security-Policy'?:?\s*"?([^"\n]*connect-src[^";]*)/);
    assert.ok(policy, 'expected a policy containing connect-src');
    return policy[1].slice(policy[1].indexOf('connect-src'));
}

test('connect-src lists every host the application fetches from', () => {
    const directive = connectSrc(worker);
    const required = [
        "'self'",                            // relay routes and static release artifacts
        'https://academicbulletins.sc.edu',  // bulletin search, called cross-origin
        'https://cdn.jsdelivr.net',          // transformers.js runtime
        'https://huggingface.co',            // model metadata
        'https://*.hf.co',                   // model weights redirect here, not to huggingface.co
        'https://*.tile.openstreetmap.org',  // campus map tiles
    ];
    const missing = required.filter(host => !directive.includes(host));
    assert.deepEqual(missing, [], `connect-src is missing hosts the app uses: ${missing.join(', ')}`);
});

test('the worker policy and the _headers policy agree', () => {
    const builder = fs.readFileSync(path.join(ROOT, 'tools/build_static_site.py'), 'utf8');
    assert.equal(
        connectSrc(worker).trim(),
        connectSrc(builder).trim(),
        'the worker runs first and its headers win, so a divergent _headers entry is misleading',
    );
});

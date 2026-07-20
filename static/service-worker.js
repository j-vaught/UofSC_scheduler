/* Offline shell and immutable release caching for the static application. */
'use strict';

const BUILD_ID = '__STATIC_BUILD_ID__';
const SHELL_CACHE = `course-scheduler-shell-${BUILD_ID}`;
const MANIFEST_CACHE = 'course-scheduler-data-manifests-v1';
const ARTIFACT_CACHE_PREFIX = 'course-scheduler-data-artifacts-v1';
/*
 * Injected at build time from the script and stylesheet tags in index.html.
 *
 * This was a hand-maintained list, which meant adding a file to the page and
 * adding it to the offline shell were two separate edits with nothing tying
 * them together. Forgetting the second one produces a page that works online
 * and is quietly broken offline -- the hardest kind of gap to notice, because
 * every test and every normal load passes.
 *
 * index.html is the declaration now. Anything the page loads is precached
 * because it is on the page, not because someone remembered.
 *
 * SHELL_EXTRA covers the genuine exceptions: workers are fetched by script
 * rather than linked by a tag, so no markup mentions them.
 */
const SHELL_ASSETS = __SHELL_ASSETS__;

function isManifest(url) {
    return url.origin === self.location.origin
        && url.pathname === '/static/data/manifest.json';
}

function isImmutableArtifact(url) {
    return url.origin === self.location.origin
        && url.pathname.startsWith('/static/data/releases/');
}

function isShellAsset(url) {
    return url.origin === self.location.origin
        && (url.pathname.startsWith('/static/css/')
            || url.pathname.startsWith('/static/js/')
            || url.pathname === '/static/index.html');
}

function isSupportData(url) {
    return url.origin === self.location.origin
        && url.pathname.startsWith('/static/data/');
}

function artifactCacheName(url) {
    const marker = '/static/data/releases/';
    const releaseId = url.pathname.slice(url.pathname.indexOf(marker) + marker.length)
        .split('/')[0]
        .replace(/[^a-z0-9._-]+/gi, '-');
    return `${ARTIFACT_CACHE_PREFIX}-${releaseId || 'unknown'}`;
}

async function cacheResponse(cacheName, request, response) {
    if (response?.ok && response.type !== 'opaque') {
        const cache = await caches.open(cacheName);
        await cache.put(request, response.clone());
    }
    return response;
}

async function networkFirst(request, cacheName) {
    const cache = await caches.open(cacheName);
    try {
        const networkRequest = new Request(request, { cache: 'no-store' });
        const response = await fetch(networkRequest);
        return cacheResponse(cacheName, request, response);
    } catch (error) {
        const cached = await cache.match(request);
        if (cached) return cached;
        throw error;
    }
}

async function cacheFirst(request, cacheName) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);
    if (cached) return cached;
    return cacheResponse(cacheName, request, await fetch(request));
}

async function staleWhileRevalidate(request, cacheName) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);
    const update = fetch(request)
        .then(response => cacheResponse(cacheName, request, response))
        .catch(() => null);
    if (cached) return cached;
    const response = await update;
    if (response) return response;
    throw new Error('The requested shell asset is unavailable');
}

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(SHELL_CACHE);
        await cache.addAll(SHELL_ASSETS);
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names
            .filter(name => name.startsWith('course-scheduler-shell-') && name !== SHELL_CACHE)
            .map(name => caches.delete(name)));
        await self.clients.claim();
    })());
});

self.addEventListener('message', event => {
    if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
    if (event.data?.type === 'CLEAR_STATIC_DATA') {
        event.waitUntil(Promise.all([
            caches.delete(MANIFEST_CACHE),
            caches.keys().then(names => Promise.all(names
                .filter(name => name.startsWith(`${ARTIFACT_CACHE_PREFIX}-`))
                .map(name => caches.delete(name)))),
        ]));
    }
});

self.addEventListener('fetch', event => {
    const { request } = event;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);

    if (isManifest(url)) {
        event.respondWith(networkFirst(request, MANIFEST_CACHE));
        return;
    }
    if (isImmutableArtifact(url)) {
        event.respondWith(cacheFirst(request, artifactCacheName(url)));
        return;
    }
    if (request.mode === 'navigate' && url.origin === self.location.origin) {
        event.respondWith((async () => {
            try {
                const response = await fetch(request);
                return cacheResponse(SHELL_CACHE, '/', response);
            } catch (error) {
                const cache = await caches.open(SHELL_CACHE);
                return await cache.match('/') || await cache.match('/static/index.html');
            }
        })());
        return;
    }
    if (isShellAsset(url)) {
        event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
        return;
    }
    if (isSupportData(url)) {
        event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
    }
});

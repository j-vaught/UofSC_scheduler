/* Persistent access to immutable browser data releases. */
(function exposeStaticDataStore(global) {
    'use strict';

    const DEFAULT_MANIFEST_URL = '/static/data/manifest.json';
    const DEFAULT_MANIFEST_TTL = 5 * 60 * 1000;
    const DATABASE_VERSION = 1;

    // The canonical normaliser, shared with State and the scheduler. In the
    // browser it is a global; under Node's test runner (require present) it is
    // pulled in directly. Its lenient normalize() is what this store wants: a
    // non-code stays cleaned rather than becoming '', so a shard lookup gets
    // back exactly what it was handed.
    const CourseCode = global.CourseCode
        || (typeof require === 'function' ? require('./course-code.js') : null);

    function normalizeCourseCode(value) {
        return CourseCode.normalize(value);
    }

    function professorPrefix(value) {
        const identifier = String(value || '').trim().toLowerCase();
        const hash = identifier.startsWith('prof_') ? identifier.slice(5) : identifier;
        return /^[0-9a-f]/.test(hash) ? hash[0] : '';
    }

    function termLabel(value) {
        const term = String(value || '');
        const season = { '01': 'Spring', '05': 'Summer', '08': 'Fall' }[term.slice(4)]
            || term.slice(4);
        return `${season} ${term.slice(0, 4)}`.trim();
    }

    function nextAcademicTerm(value) {
        const term = String(value || '');
        if (!/^\d{6}$/.test(term)) return '';
        const year = Number(term.slice(0, 4));
        const suffix = term.slice(4);
        if (suffix === '01') return `${year}05`;
        if (suffix === '05') return `${year}08`;
        if (suffix === '08') return `${year + 1}01`;
        return '';
    }

    class StaticDataStore {
        constructor(options = {}) {
            const baseUrl = options.baseUrl
                || global.location?.href
                || 'http://localhost/';
            this.manifestUrl = new URL(
                options.manifestUrl || DEFAULT_MANIFEST_URL,
                baseUrl,
            ).href;
            this.fetchImpl = options.fetchImpl
                || (typeof global.fetch === 'function' ? global.fetch.bind(global) : null);
            this.cacheStorage = options.cacheStorage === undefined
                ? global.caches || null
                : options.cacheStorage;
            this.indexedDB = options.indexedDB === undefined
                ? global.indexedDB || null
                : options.indexedDB;
            this.cryptoImpl = options.cryptoImpl === undefined
                ? global.crypto || null
                : options.cryptoImpl;
            this.now = options.now || (() => Date.now());
            this.manifestMaxAgeMs = Number.isFinite(options.manifestMaxAgeMs)
                ? Math.max(0, options.manifestMaxAgeMs)
                : DEFAULT_MANIFEST_TTL;
            this.manifestCacheName = options.manifestCacheName
                || 'course-scheduler-data-manifests-v1';
            this.artifactCachePrefix = options.artifactCachePrefix
                || options.artifactCacheName
                || 'course-scheduler-data-artifacts-v1';
            this.databaseName = options.databaseName || 'course-scheduler-static-data-v1';
            this._manifestRecord = null;
            this._memoryArtifacts = new Map();
            this._inflight = new Map();
            this._databasePromise = null;
            this._indexedDBDisabled = !this.indexedDB;
        }

        async getManifest({ forceRefresh = false } = {}) {
            const memory = this._manifestRecord;
            if (!forceRefresh && memory
                && this.now() - memory.fetchedAt < this.manifestMaxAgeMs) {
                return memory.value;
            }

            const inflightKey = `manifest:${forceRefresh ? 'refresh' : 'normal'}`;
            if (this._inflight.has(inflightKey)) return this._inflight.get(inflightKey);
            const request = this._loadManifest({ forceRefresh });
            this._inflight.set(inflightKey, request);
            try {
                return await request;
            } finally {
                if (this._inflight.get(inflightKey) === request) {
                    this._inflight.delete(inflightKey);
                }
            }
        }

        async _loadManifest({ forceRefresh }) {
            let networkError = null;
            if (this.fetchImpl) {
                try {
                    const response = await this.fetchImpl(this.manifestUrl, {
                        cache: 'no-store',
                        headers: { Accept: 'application/json' },
                    });
                    if (!response?.ok) {
                        throw new Error(`Manifest request failed with status ${response?.status}`);
                    }
                    const text = await response.text();
                    const manifest = this._parseManifest(text);
                    const fetchedAt = this.now();
                    await this._putCachedResponse(
                        this.manifestCacheName,
                        this.manifestUrl,
                        this._responseFromText(text, response),
                    );
                    await this._idbPut({
                        key: `manifest:${this.manifestUrl}`,
                        kind: 'manifest',
                        fetchedAt,
                        value: manifest,
                    });
                    await this._activateRelease(manifest, fetchedAt);
                    return manifest;
                } catch (error) {
                    networkError = error;
                }
            }

            const cachedResponse = await this._matchCachedResponse(
                this.manifestCacheName,
                this.manifestUrl,
            );
            if (cachedResponse) {
                try {
                    const manifest = this._parseManifest(await cachedResponse.text());
                    await this._activateRelease(manifest, this.now());
                    return manifest;
                } catch (error) {
                    await this._deleteCachedResponse(this.manifestCacheName, this.manifestUrl);
                }
            }

            const stored = await this._idbGet(`manifest:${this.manifestUrl}`);
            if (stored?.value) {
                try {
                    this._validateManifest(stored.value);
                    await this._activateRelease(
                        stored.value,
                        Number(stored.fetchedAt) || this.now(),
                    );
                    return stored.value;
                } catch (error) {
                    // Ignore incompatible records from older application versions.
                }
            }

            if (this._manifestRecord?.value) return this._manifestRecord.value;
            const error = new Error('Static data manifest is unavailable');
            if (networkError) error.cause = networkError;
            throw error;
        }

        async getArtifact(logicalName, { forceRefresh = false } = {}) {
            const manifest = await this.getManifest({ forceRefresh: false });
            const descriptor = manifest.artifacts?.[logicalName];
            if (!descriptor) throw new Error(`Unknown static data artifact: ${logicalName}`);

            const memoryKey = `${manifest.release_id}:${logicalName}`;
            if (!forceRefresh && this._memoryArtifacts.has(memoryKey)) {
                return this._memoryArtifacts.get(memoryKey);
            }
            const inflightKey = `artifact:${memoryKey}:${forceRefresh ? 'refresh' : 'normal'}`;
            if (this._inflight.has(inflightKey)) return this._inflight.get(inflightKey);
            const request = this._loadArtifact({
                logicalName,
                descriptor,
                manifest,
                memoryKey,
                forceRefresh,
            });
            this._inflight.set(inflightKey, request);
            try {
                return await request;
            } finally {
                if (this._inflight.get(inflightKey) === request) {
                    this._inflight.delete(inflightKey);
                }
            }
        }

        async _loadArtifact({ logicalName, descriptor, manifest, memoryKey, forceRefresh }) {
            const artifactUrl = new URL(descriptor.url, new URL('.', this.manifestUrl)).href;
            const artifactCacheName = this._artifactCacheName(manifest.release_id);
            if (!forceRefresh) {
                const cachedResponse = await this._matchCachedResponse(
                    artifactCacheName,
                    artifactUrl,
                );
                if (cachedResponse) {
                    try {
                        const text = await cachedResponse.text();
                        await this._verifyArtifact(text, descriptor, logicalName);
                        const payload = JSON.parse(text);
                        this._memoryArtifacts.set(memoryKey, payload);
                        return payload;
                    } catch (error) {
                        await this._deleteCachedResponse(artifactCacheName, artifactUrl);
                    }
                }

                if (!this.cacheStorage) {
                    const stored = await this._idbGet(`artifact:${artifactUrl}`);
                    if (stored?.sha256 === descriptor.sha256 && stored.value !== undefined) {
                        this._memoryArtifacts.set(memoryKey, stored.value);
                        return stored.value;
                    }
                }
            }

            if (!this.fetchImpl) throw new Error(`Cannot fetch static data artifact: ${logicalName}`);
            const response = await this.fetchImpl(artifactUrl, {
                cache: forceRefresh ? 'reload' : 'force-cache',
                headers: { Accept: 'application/json' },
            });
            if (!response?.ok) {
                throw new Error(
                    `Static data artifact ${logicalName} failed with status ${response?.status}`,
                );
            }
            const text = await response.text();
            await this._verifyArtifact(text, descriptor, logicalName);
            let payload;
            try {
                payload = JSON.parse(text);
            } catch (error) {
                throw new Error(`Static data artifact ${logicalName} is not valid JSON`, {
                    cause: error,
                });
            }
            await this._putCachedResponse(
                artifactCacheName,
                artifactUrl,
                this._responseFromText(text, response),
            );
            const metadata = {
                key: `artifact-meta:${artifactUrl}`,
                kind: 'artifact-metadata',
                releaseId: manifest.release_id,
                logicalName,
                sha256: descriptor.sha256,
                bytes: descriptor.bytes,
                cachedAt: this.now(),
            };
            await this._idbPut(metadata);
            if (!this.cacheStorage) {
                await this._idbPut({
                    ...metadata,
                    key: `artifact:${artifactUrl}`,
                    kind: 'artifact',
                    value: payload,
                });
            }
            this._memoryArtifacts.set(memoryKey, payload);
            return payload;
        }

        async prefetch(logicalNames, { concurrency = 3, onProgress = null } = {}) {
            const queue = [...new Set(logicalNames || [])];
            const total = queue.length;
            let completed = 0;
            const results = {};
            const failures = {};
            const worker = async () => {
                while (queue.length) {
                    const name = queue.shift();
                    try {
                        results[name] = await this.getArtifact(name);
                    } catch (error) {
                        failures[name] = error;
                    }
                    completed += 1;
                    if (typeof onProgress === 'function') {
                        onProgress({ completed, total, name, failed: Boolean(failures[name]) });
                    }
                }
            };
            const count = Math.max(1, Math.min(Number(concurrency) || 1, total || 1));
            await Promise.all(Array.from({ length: count }, worker));
            return { results, failures, completed, total };
        }

        async getCourseGrades(courseCode) {
            const code = normalizeCourseCode(courseCode);
            const subject = code.split(' ')[0];
            if (!subject) return null;
            const shard = await this.getArtifact(`grades/courses/${subject}`);
            return shard.courses?.[code] || null;
        }

        async getProfessorGrades(identifier) {
            const prefix = professorPrefix(identifier);
            if (!prefix) return null;
            const shard = await this.getArtifact(`grades/professors/${prefix}`);
            return shard.professors?.[String(identifier || '').trim().toLowerCase()] || null;
        }

        async getOfferingHistory(courseCode) {
            const code = normalizeCourseCode(courseCode);
            const subject = code.split(' ')[0];
            if (!subject) return null;
            const shard = await this.getArtifact(`history/${subject}`);
            const record = shard.courses?.[code];
            if (!record) return null;
            const completeTerms = new Set(shard.coverage?.complete_terms || []);
            const terms = (record.terms || []).map(item => ({
                ...item,
                label: item.label || termLabel(item.term),
                available: true,
                complete: completeTerms.has(item.term),
            }));
            const knownTerms = new Set(terms.map(item => item.term));
            for (const incomplete of shard.coverage?.incomplete_terms || []) {
                const term = typeof incomplete === 'object' && incomplete !== null
                    ? String(incomplete.term || '')
                    : String(incomplete || '');
                const reason = typeof incomplete === 'object' && incomplete !== null
                    ? String(incomplete.reason || '')
                    : '';
                if (!term) continue;
                if (!knownTerms.has(term)) {
                    terms.push({
                        term,
                        label: termLabel(term),
                        available: false,
                        complete: false,
                        error: true,
                        error_reason: reason,
                    });
                }
            }
            terms.sort((left, right) => String(left.term).localeCompare(String(right.term)));
            const lastComplete = String(shard.coverage?.last_complete_term
                || [...completeTerms].sort().at(-1)
                || '');
            return {
                code,
                as_of_term: nextAcademicTerm(lastComplete),
                complete: !(shard.coverage?.incomplete_terms || []).length,
                total_terms: terms.length,
                offered_count: terms.filter(item => item.offered).length,
                terms,
            };
        }

        async refreshManifest() {
            return this.getManifest({ forceRefresh: true });
        }

        status() {
            return {
                releaseId: this._manifestRecord?.value?.release_id || null,
                manifestFetchedAt: this._manifestRecord?.fetchedAt || null,
                memoryArtifacts: this._memoryArtifacts.size,
                cacheStorage: Boolean(this.cacheStorage),
                indexedDB: !this._indexedDBDisabled,
            };
        }

        async clear() {
            this._manifestRecord = null;
            this._memoryArtifacts.clear();
            this._inflight.clear();
            if (this.cacheStorage) {
                const artifactCaches = await this._artifactCacheNames();
                await Promise.all([
                    this.cacheStorage.delete(this.manifestCacheName),
                    ...artifactCaches.map(name => this.cacheStorage.delete(name)),
                ]).catch(() => {});
            }
            const database = await this._openDatabase();
            if (database) {
                await new Promise(resolve => {
                    try {
                        const request = database
                            .transaction('records', 'readwrite')
                            .objectStore('records')
                            .clear();
                        request.onsuccess = () => resolve();
                        request.onerror = () => resolve();
                    } catch (error) {
                        resolve();
                    }
                });
            }
        }

        _parseManifest(text) {
            let manifest;
            try {
                manifest = JSON.parse(text);
            } catch (error) {
                throw new Error('Static data manifest is not valid JSON', { cause: error });
            }
            this._validateManifest(manifest);
            return manifest;
        }

        _validateManifest(manifest) {
            if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
                throw new Error('Static data manifest must be an object');
            }
            if (manifest.schema_version !== 1) {
                throw new Error(`Unsupported static data schema: ${manifest.schema_version}`);
            }
            if (!String(manifest.release_id || '').trim()) {
                throw new Error('Static data manifest has no release identifier');
            }
            if (!manifest.artifacts || typeof manifest.artifacts !== 'object') {
                throw new Error('Static data manifest has no artifacts');
            }
            for (const [name, descriptor] of Object.entries(manifest.artifacts)) {
                if (!descriptor || typeof descriptor.url !== 'string'
                    || !/^[0-9a-f]{64}$/i.test(String(descriptor.sha256 || ''))
                    || !Number.isFinite(Number(descriptor.bytes))) {
                    throw new Error(`Static data manifest contains an invalid artifact: ${name}`);
                }
            }
        }

        async _verifyArtifact(text, descriptor, logicalName) {
            const bytes = new TextEncoder().encode(text);
            if (Number(descriptor.bytes) !== bytes.byteLength) {
                throw new Error(`Static data artifact ${logicalName} has an invalid byte length`);
            }
            const subtle = this.cryptoImpl?.subtle;
            if (!subtle?.digest) {
                throw new Error('Static data integrity validation is unavailable');
            }
            const digest = await subtle.digest('SHA-256', bytes);
            const actual = [...new Uint8Array(digest)]
                .map(value => value.toString(16).padStart(2, '0'))
                .join('');
            if (actual !== String(descriptor.sha256).toLowerCase()) {
                throw new Error(`Static data artifact ${logicalName} failed integrity validation`);
            }
        }

        _responseFromText(text, sourceResponse) {
            if (typeof global.Response !== 'function') return null;
            const headers = new global.Headers(sourceResponse?.headers || {});
            headers.set('Content-Type', 'application/json; charset=utf-8');
            return new global.Response(text, { status: 200, headers });
        }

        async _matchCachedResponse(cacheName, url) {
            if (!this.cacheStorage) return null;
            try {
                const cache = await this.cacheStorage.open(cacheName);
                return await cache.match(url);
            } catch (error) {
                return null;
            }
        }

        async _putCachedResponse(cacheName, url, response) {
            if (!this.cacheStorage || !response) return;
            try {
                const cache = await this.cacheStorage.open(cacheName);
                await cache.put(url, response);
            } catch (error) {
                // Private browsing and storage quotas can disable persistent caches.
            }
        }

        async _deleteCachedResponse(cacheName, url) {
            if (!this.cacheStorage) return;
            try {
                const cache = await this.cacheStorage.open(cacheName);
                await cache.delete(url);
            } catch (error) {
                // Cache deletion is best effort.
            }
        }

        _artifactCacheName(releaseId) {
            const safeId = String(releaseId || 'unknown').replace(/[^a-z0-9._-]+/gi, '-');
            return `${this.artifactCachePrefix}-${safeId}`;
        }

        async _artifactCacheNames() {
            if (!this.cacheStorage?.keys) return [];
            try {
                return (await this.cacheStorage.keys())
                    .filter(name => name.startsWith(`${this.artifactCachePrefix}-`));
            } catch (error) {
                return [];
            }
        }

        async _activateRelease(manifest, fetchedAt) {
            const releaseId = String(manifest.release_id);
            const memoryRelease = this._manifestRecord?.value?.release_id || null;
            const storedState = await this._idbGet('release-state');
            const storedCurrent = storedState?.current || null;
            const previous = releaseId === storedCurrent
                ? storedState?.previous || null
                : storedCurrent || memoryRelease || storedState?.previous || null;
            this._manifestRecord = { value: manifest, fetchedAt };
            await this._idbPut({
                key: 'release-state',
                kind: 'release-state',
                current: releaseId,
                previous: previous === releaseId ? null : previous,
                updatedAt: fetchedAt,
            });
            if (!this.cacheStorage) return;
            const keep = new Set([
                this._artifactCacheName(releaseId),
                previous ? this._artifactCacheName(previous) : null,
            ].filter(Boolean));
            const names = await this._artifactCacheNames();
            await Promise.all(names
                .filter(name => !keep.has(name))
                .map(name => this.cacheStorage.delete(name)))
                .catch(() => {});
        }

        async _openDatabase() {
            if (this._indexedDBDisabled) return null;
            if (this._databasePromise) return this._databasePromise;
            this._databasePromise = new Promise(resolve => {
                let request;
                try {
                    request = this.indexedDB.open(this.databaseName, DATABASE_VERSION);
                } catch (error) {
                    this._indexedDBDisabled = true;
                    resolve(null);
                    return;
                }
                request.onupgradeneeded = () => {
                    if (!request.result.objectStoreNames.contains('records')) {
                        request.result.createObjectStore('records', { keyPath: 'key' });
                    }
                };
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => {
                    this._indexedDBDisabled = true;
                    resolve(null);
                };
                request.onblocked = () => {
                    this._indexedDBDisabled = true;
                    resolve(null);
                };
            });
            return this._databasePromise;
        }

        async _idbGet(key) {
            const database = await this._openDatabase();
            if (!database) return null;
            return new Promise(resolve => {
                try {
                    const request = database
                        .transaction('records', 'readonly')
                        .objectStore('records')
                        .get(key);
                    request.onsuccess = () => resolve(request.result || null);
                    request.onerror = () => resolve(null);
                } catch (error) {
                    resolve(null);
                }
            });
        }

        async _idbPut(value) {
            const database = await this._openDatabase();
            if (!database) return;
            await new Promise(resolve => {
                try {
                    const request = database
                        .transaction('records', 'readwrite')
                        .objectStore('records')
                        .put(value);
                    request.onsuccess = () => resolve();
                    request.onerror = () => resolve();
                } catch (error) {
                    resolve();
                }
            });
        }
    }

    const exports = {
        StaticDataStore,
        normalizeCourseCode,
        professorPrefix,
        termLabel,
        nextAcademicTerm,
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = exports;
    global.StaticDataStore = StaticDataStore;
    if (!global.CourseDataStore) global.CourseDataStore = new StaticDataStore();
}(typeof globalThis !== 'undefined' ? globalThis : this));

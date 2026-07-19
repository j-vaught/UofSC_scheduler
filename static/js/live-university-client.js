/* Bounded same-origin access to live University course data. */
(function exposeLiveUniversityClient(global, factory) {
    'use strict';

    const exports = factory(global);
    if (typeof module !== 'undefined' && module.exports) module.exports = exports;
    global.LiveUniversityClient = exports.LiveUniversityClient;
    global.UniversityRequestError = exports.UniversityRequestError;
    global.UniversityAccessBlockedError = exports.UniversityAccessBlockedError;
}(typeof globalThis !== 'undefined' ? globalThis : this, global => {
    'use strict';

    const DEFAULT_ENDPOINTS = Object.freeze({
        courseSearch: '/api/search',
        courseDetails: '/api/details',
        bulletinSearch: 'https://academicbulletins.sc.edu/course-search/api/?page=fose&route=search',
        bulletinDetails: 'https://academicbulletins.sc.edu/course-search/api/?page=fose&route=details',
        faculty: '/api/faculty',
    });

    const DEFAULT_TTLS = Object.freeze({
        courseSearch: 5 * 60 * 1000,
        courseDetails: 5 * 60 * 1000,
        bulletinSearch: 24 * 60 * 60 * 1000,
        bulletinDetails: 24 * 60 * 60 * 1000,
        faculty: 24 * 60 * 60 * 1000,
    });

    function stableValue(value) {
        if (Array.isArray(value)) return value.map(stableValue);
        if (value && typeof value === 'object') {
            return Object.fromEntries(
                Object.keys(value).sort().map(key => [key, stableValue(value[key])]),
            );
        }
        return value;
    }

    // A relative endpoint is same-origin by definition. An absolute one only
    // counts when its origin matches ours; if we cannot determine our own
    // origin, treat it as cross-origin, since that is the safer default.
    function isSameOriginUrl(endpoint, origin) {
        if (typeof endpoint !== 'string' || endpoint === '') return false;
        const isAbsolute = endpoint.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(endpoint);
        if (!isAbsolute) return true;
        if (!origin) return false;
        try {
            return new URL(endpoint, origin).origin === origin;
        } catch (error) {
            return false;
        }
    }

    function abortError(message = 'Request was cancelled') {
        const error = new Error(message);
        error.name = 'AbortError';
        return error;
    }

    class UniversityRequestError extends Error {
        constructor(message, options = {}) {
            super(message, options.cause ? { cause: options.cause } : undefined);
            this.name = 'UniversityRequestError';
            this.code = options.code || 'UNIVERSITY_REQUEST_FAILED';
            this.status = Number.isFinite(options.status) ? options.status : null;
            this.endpoint = options.endpoint || '';
            this.retriable = Boolean(options.retriable);
            this.corsBlocked = Boolean(options.corsBlocked);
        }
    }

    class UniversityAccessBlockedError extends UniversityRequestError {
        constructor(endpoint, cause = null, corsBlocked = true) {
            super(
                'Live University data is temporarily unavailable. The site relay, network, or '
                + 'upstream service did not complete the request.',
                {
                    code: 'DIRECT_ACCESS_BLOCKED',
                    endpoint,
                    cause,
                    corsBlocked,
                    retriable: false,
                },
            );
            this.name = 'UniversityAccessBlockedError';
        }
    }

    class RequestLimiter {
        constructor(limit) {
            this.limit = Math.max(1, Number(limit) || 1);
            this.active = 0;
            this.queue = [];
        }

        acquire(signal = null) {
            if (signal?.aborted) return Promise.reject(abortError());
            return new Promise((resolve, reject) => {
                const entry = { resolve, reject, signal, onAbort: null };
                entry.onAbort = () => {
                    const index = this.queue.indexOf(entry);
                    if (index >= 0) this.queue.splice(index, 1);
                    reject(abortError());
                };
                signal?.addEventListener?.('abort', entry.onAbort, { once: true });
                this.queue.push(entry);
                this._drain();
            });
        }

        _drain() {
            while (this.active < this.limit && this.queue.length) {
                const entry = this.queue.shift();
                entry.signal?.removeEventListener?.('abort', entry.onAbort);
                if (entry.signal?.aborted) {
                    entry.reject(abortError());
                    continue;
                }
                this.active += 1;
                let released = false;
                entry.resolve(() => {
                    if (released) return;
                    released = true;
                    this.active -= 1;
                    this._drain();
                });
            }
        }
    }

    class LiveUniversityClient {
        constructor(options = {}) {
            this.endpoints = { ...DEFAULT_ENDPOINTS, ...(options.endpoints || {}) };
            this.ttls = { ...DEFAULT_TTLS, ...(options.ttls || {}) };
            this.fetchImpl = options.fetchImpl
                || (typeof global.fetch === 'function' ? global.fetch.bind(global) : null);
            this.timeoutMs = Math.max(1, Number(options.timeoutMs) || 15_000);
            this.retries = Math.max(0, Number(options.retries) || 0);
            this.retryBaseMs = Math.max(0, Number(options.retryBaseMs) || 250);
            this.now = options.now || (() => Date.now());
            this.sleep = options.sleep || (duration => new Promise(resolve => {
                global.setTimeout(resolve, duration);
            }));
            this.origin = options.origin || global.location?.origin || '';
            this.limiter = new RequestLimiter(options.maxConcurrency || 4);
            this.cache = new Map();
            this.inflight = new Map();
            this.cacheMaxEntries = Math.max(10, Number(options.cacheMaxEntries) || 250);
        }

        async searchCourses(term, criteria, options = {}) {
            return this.request('courseSearch', {
                other: { srcdb: String(term || '') },
                criteria: criteria || [],
            }, options);
        }

        async getDetails(crn, term, options = {}) {
            return this.request('courseDetails', {
                group: `crn:${crn}`,
                srcdb: String(term || ''),
            }, options);
        }

        async bulletinSearch(subject, srcdb = '2026', options = {}) {
            const criteria = subject
                ? [{ field: 'subject', value: String(subject).toUpperCase() }]
                : [];
            return this.request('bulletinSearch', {
                other: { srcdb: String(srcdb || '2026') },
                criteria,
            }, options);
        }

        async bulletinDetails(key, srcdb = '2026', options = {}) {
            return this.request('bulletinDetails', {
                group: `key:${key}`,
                srcdb: String(srcdb || '2026'),
            }, options);
        }

        async faculty(term, crns, options = {}) {
            const values = Array.isArray(crns) ? crns : [crns];
            return this.request('faculty', {
                term: String(term || ''),
                crns: [...new Set(values.map(String).filter(Boolean))],
            }, options);
        }

        async request(kind, body, options = {}) {
            const endpoint = options.url || this.endpoints[kind];
            if (!endpoint) {
                throw new UniversityRequestError(`No endpoint is configured for ${kind}`, {
                    code: 'ENDPOINT_NOT_CONFIGURED',
                });
            }
            const method = options.method || 'POST';
            const cacheTtl = Number.isFinite(options.cacheTtl)
                ? Math.max(0, options.cacheTtl)
                : Math.max(0, Number(this.ttls[kind]) || 0);
            const key = `${method}:${endpoint}:${JSON.stringify(stableValue(body))}`;
            if (!options.forceRefresh && cacheTtl > 0) {
                const cached = this._cached(key);
                if (cached !== null) return cached;
            }
            const requestKey = `${key}:refresh=${options.forceRefresh ? 1 : 0}`;
            if (this.inflight.has(requestKey)) return this.inflight.get(requestKey);
            const request = this._requestWithRetries({
                endpoint,
                body,
                method,
                signal: options.signal || null,
                retries: Number.isFinite(options.retries) ? options.retries : this.retries,
            }).then(data => {
                if (!options.forceRefresh && cacheTtl > 0) this._store(key, data, cacheTtl);
                return data;
            });
            this.inflight.set(requestKey, request);
            try {
                return await request;
            } finally {
                if (this.inflight.get(requestKey) === request) this.inflight.delete(requestKey);
            }
        }

        async _requestWithRetries(options) {
            const attempts = Math.max(1, Number(options.retries) + 1);
            let lastError;
            for (let attempt = 0; attempt < attempts; attempt += 1) {
                try {
                    return await this._requestOnce(options);
                } catch (error) {
                    lastError = error;
                    if (error?.name === 'AbortError' || !error?.retriable || attempt + 1 >= attempts) {
                        throw error;
                    }
                    await this.sleep(this.retryBaseMs * (2 ** attempt));
                }
            }
            throw lastError;
        }

        async _requestOnce({ endpoint, body, method, signal }) {
            if (!this.fetchImpl) {
                throw new UniversityRequestError('Browser fetch is unavailable', {
                    code: 'FETCH_UNAVAILABLE',
                    endpoint,
                });
            }
            const release = await this.limiter.acquire(signal);
            const controller = typeof global.AbortController === 'function'
                ? new global.AbortController()
                : null;
            let timedOut = false;
            const forwardAbort = () => controller?.abort(signal?.reason);
            signal?.addEventListener?.('abort', forwardAbort, { once: true });
            const timer = global.setTimeout?.(() => {
                timedOut = true;
                controller?.abort();
            }, this.timeoutMs);
            try {
                const headers = { Accept: 'application/json' };
                const fetchOptions = {
                    method,
                    headers,
                    signal: controller?.signal || signal || undefined,
                    // Credentials only make sense for the same-origin relay. Sending
                    // them cross-origin obliges the upstream to answer with both
                    // Access-Control-Allow-Credentials and a specific origin; a
                    // wildcard makes the browser reject the response outright, which
                    // would silently degrade bulletin lookups to the static catalog.
                    credentials: isSameOriginUrl(endpoint, this.origin) ? 'include' : 'omit',
                    mode: 'cors',
                    cache: 'no-store',
                };
                if (method !== 'GET' && body !== null && body !== undefined) {
                    headers['Content-Type'] = 'application/json';
                    fetchOptions.body = JSON.stringify(body);
                }
                let response;
                try {
                    response = await this.fetchImpl(endpoint, fetchOptions);
                } catch (error) {
                    if (signal?.aborted) throw abortError();
                    if (timedOut || error?.name === 'TimeoutError') {
                        throw new UniversityRequestError('The University data request timed out', {
                            code: 'UPSTREAM_TIMEOUT',
                            endpoint,
                            cause: error,
                            retriable: true,
                        });
                    }
                    if (error?.name === 'AbortError') throw abortError();
                    throw new UniversityAccessBlockedError(
                        endpoint,
                        error,
                        this._isCrossOrigin(endpoint),
                    );
                }
                if (!response?.ok) {
                    const status = Number(response?.status) || 0;
                    throw new UniversityRequestError(
                        `University request failed with status ${status || 'unknown'}`,
                        {
                            code: 'UPSTREAM_HTTP_ERROR',
                            status,
                            endpoint,
                            retriable: status === 408 || status === 425 || status === 429 || status >= 500,
                        },
                    );
                }
                let data;
                try {
                    if (typeof response.text === 'function') {
                        const text = await response.text();
                        data = text ? JSON.parse(text) : {};
                    } else {
                        data = await response.json();
                    }
                } catch (error) {
                    throw new UniversityRequestError('University response was not valid JSON', {
                        code: 'INVALID_UPSTREAM_RESPONSE',
                        endpoint,
                        cause: error,
                    });
                }
                if (data && typeof data === 'object' && data.error) {
                    throw new UniversityRequestError(String(data.error), {
                        code: 'UPSTREAM_ERROR_PAYLOAD',
                        endpoint,
                    });
                }
                return data;
            } finally {
                if (timer !== undefined) global.clearTimeout?.(timer);
                signal?.removeEventListener?.('abort', forwardAbort);
                release();
            }
        }

        _isCrossOrigin(endpoint) {
            if (!this.origin) return true;
            try {
                return new URL(endpoint, this.origin).origin !== this.origin;
            } catch (error) {
                return true;
            }
        }

        _cached(key) {
            const entry = this.cache.get(key);
            if (!entry) return null;
            if (this.now() >= entry.expiresAt) {
                this.cache.delete(key);
                return null;
            }
            this.cache.delete(key);
            this.cache.set(key, entry);
            return entry.data;
        }

        _store(key, data, ttl) {
            this.cache.delete(key);
            this.cache.set(key, { data, expiresAt: this.now() + ttl });
            while (this.cache.size > this.cacheMaxEntries) {
                this.cache.delete(this.cache.keys().next().value);
            }
        }

        clearCache() {
            this.cache.clear();
        }
    }

    return Object.freeze({
        LiveUniversityClient,
        UniversityRequestError,
        UniversityAccessBlockedError,
        DEFAULT_ENDPOINTS,
        DEFAULT_TTLS,
    });
}));

const SECURITY_HEADERS = Object.freeze({
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data: https://*.tile.openstreetmap.org; connect-src 'self' https://academicbulletins.sc.edu https://cdn.jsdelivr.net https://unpkg.com https://huggingface.co https://*.huggingface.co https://*.hf.co https://*.openstreetmap.de https://*.tile.openstreetmap.org; worker-src 'self' blob:; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
});

const RELAY_ROUTES = Object.freeze({
    '/api/search': Object.freeze({
        upstream: 'https://classes.sc.edu/api/?page=fose&route=search',
        kind: 'search',
    }),
    '/api/details': Object.freeze({
        upstream: 'https://classes.sc.edu/api/?page=fose&route=details',
        kind: 'details',
    }),
    '/api/faculty': Object.freeze({
        kind: 'faculty',
    }),
});

const SEARCH_FIELDS = new Set(['alias', 'course_attr', 'crn', 'keyword', 'stat', 'subject']);
const BANNER_BASE = 'https://banner.onecarolina.sc.edu/StudentRegistrationSsb/ssb';
const MAX_FACULTY_CRNS = 12;
const MAX_FACULTY_CONCURRENCY = 4;
const MAX_RELAY_BODY_BYTES = 16 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;

function cachePolicy(pathname) {
    if (pathname === '/service-worker.js' || pathname === '/static/data/manifest.json') {
        return 'no-cache, max-age=0, must-revalidate';
    }
    if (pathname.startsWith('/static/data/releases/')) {
        return 'public, max-age=31536000, immutable';
    }
    if (pathname.startsWith('/static/')) return 'public, max-age=3600';
    return 'no-cache, max-age=0, must-revalidate';
}

function withHeaders(response, pathname) {
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
    headers.set('Cache-Control', cachePolicy(pathname));
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

function jsonResponse(payload, status, pathname, extraHeaders = {}) {
    return withHeaders(new Response(JSON.stringify(payload), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            ...extraHeaders,
        },
    }), pathname);
}

function validTerm(value) {
    return /^\d{4}(?:01|05|08)$/.test(String(value || ''));
}

function validateSearchPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    if (Object.keys(payload).some(key => !['other', 'criteria'].includes(key))) return false;
    if (!payload.other || typeof payload.other !== 'object' || Array.isArray(payload.other)) {
        return false;
    }
    if (Object.keys(payload.other).some(key => key !== 'srcdb')) return false;
    if (!validTerm(payload.other.srcdb)) return false;
    if (!Array.isArray(payload.criteria)
        || payload.criteria.length < 1
        || payload.criteria.length > 6) return false;
    const fields = new Set();
    for (const criterion of payload.criteria) {
        if (!criterion || typeof criterion !== 'object' || Array.isArray(criterion)) return false;
        if (Object.keys(criterion).some(key => !['field', 'value'].includes(key))) return false;
        const field = String(criterion.field || '');
        if (!SEARCH_FIELDS.has(field) || fields.has(field)) return false;
        if (typeof criterion.value !== 'string'
            || criterion.value.length < 1
            || criterion.value.length > 120) return false;
        fields.add(field);
    }
    return payload.criteria.some(criterion => criterion.field !== 'stat');
}

function validateDetailsPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    if (Object.keys(payload).some(key => !['group', 'srcdb'].includes(key))) return false;
    if (!validTerm(payload.srcdb)) return false;
    const group = String(payload.group || '');
    return /^crn:\d{5}$/.test(group);
}

function validateFacultyPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    if (Object.keys(payload).some(key => !['term', 'crns'].includes(key))) return false;
    if (!validTerm(payload.term)) return false;
    if (!Array.isArray(payload.crns)
        || payload.crns.length < 1
        || payload.crns.length > MAX_FACULTY_CRNS) return false;
    const values = payload.crns.map(value => String(value || ''));
    return values.every(value => /^\d{5}$/.test(value))
        && new Set(values).size === values.length;
}

async function parseRelayBody(request, route, pathname) {
    const contentType = String(request.headers.get('content-type') || '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
        return { error: jsonResponse({ error: 'Expected a JSON request body' }, 415, pathname) };
    }
    const declaredLength = Number(request.headers.get('content-length') || 0);
    if (declaredLength > MAX_RELAY_BODY_BYTES) {
        return { error: jsonResponse({ error: 'Request body is too large' }, 413, pathname) };
    }
    let text;
    try {
        text = await request.text();
    } catch (error) {
        return { error: jsonResponse({ error: 'Could not read request body' }, 400, pathname) };
    }
    if (new TextEncoder().encode(text).byteLength > MAX_RELAY_BODY_BYTES) {
        return { error: jsonResponse({ error: 'Request body is too large' }, 413, pathname) };
    }
    let payload;
    try {
        payload = JSON.parse(text);
    } catch (error) {
        return { error: jsonResponse({ error: 'Request body is not valid JSON' }, 400, pathname) };
    }
    const valid = route.kind === 'search'
        ? validateSearchPayload(payload)
        : route.kind === 'details'
            ? validateDetailsPayload(payload)
            : validateFacultyPayload(payload);
    if (!valid) {
        return { error: jsonResponse({ error: 'Request body is invalid for this operation' }, 400, pathname) };
    }
    return { payload, text };
}

async function readJsonResponse(response, maxBytes) {
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
        const error = new Error('Upstream response was not JSON');
        error.code = 'INVALID_UPSTREAM_CONTENT_TYPE';
        throw error;
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > maxBytes) {
        const error = new Error('Upstream response was too large');
        error.code = 'UPSTREAM_RESPONSE_TOO_LARGE';
        throw error;
    }
    const text = new TextDecoder().decode(bytes);
    try {
        return text ? JSON.parse(text) : {};
    } catch (cause) {
        const error = new Error('Upstream response was not valid JSON', { cause });
        error.code = 'INVALID_UPSTREAM_RESPONSE';
        throw error;
    }
}

async function fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function publicInstructorId(value) {
    const bytes = new TextEncoder().encode(`uofsc-scheduler:${String(value).toLowerCase()}`);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return `prof_${[...new Uint8Array(digest)]
        .map(part => part.toString(16).padStart(2, '0')).join('').slice(0, 16)}`;
}

function facultyPrimary(value) {
    if (typeof value === 'boolean') return value;
    return ['true', 'yes', 'y', '1'].includes(String(value || '').trim().toLowerCase());
}

function facultyEmail(value) {
    const email = String(value || '').trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

async function relayFaculty(payload, pathname) {
    const responses = [];
    for (let start = 0; start < payload.crns.length; start += MAX_FACULTY_CONCURRENCY) {
        const batch = payload.crns.slice(start, start + MAX_FACULTY_CONCURRENCY);
        responses.push(...await Promise.all(batch.map(async crn => {
            const endpoint = new URL(`${BANNER_BASE}/searchResults/getFacultyMeetingTimes`);
            endpoint.searchParams.set('term', payload.term);
            endpoint.searchParams.set('courseReferenceNumber', crn);
            endpoint.searchParams.set('mepCode', 'COL');
            const response = await fetchWithTimeout(endpoint.href, {
                method: 'GET',
                headers: { Accept: 'application/json' },
            });
            if (!response.ok) {
                const error = new Error(`Faculty provider returned status ${response.status}`);
                error.code = 'FACULTY_UPSTREAM_HTTP_ERROR';
                throw error;
            }
            const data = await readJsonResponse(response, 256 * 1024);
            if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.fmt)) {
                const error = new Error('Faculty provider returned an unexpected response');
                error.code = 'INVALID_FACULTY_RESPONSE';
                throw error;
            }
            return { crn, data };
        })));
    }
    const faculty = [];
    const seen = new Set();
    for (const { crn, data } of responses) {
        for (const meeting of data.fmt) {
            for (const member of meeting?.faculty || []) {
                const name = String(member?.displayName || member?.name || '').trim();
                const email = facultyEmail(member?.emailAddress || member?.email);
                const bannerId = String(member?.bannerId || '').trim().toUpperCase().replace(/\.0$/, '');
                const identity = bannerId || email || name.toLowerCase();
                const key = `${crn}:${identity}`;
                if (!name || !identity || seen.has(key)) continue;
                seen.add(key);
                faculty.push({
                    crn,
                    name,
                    email,
                    primary: facultyPrimary(member?.primaryIndicator ?? member?.primary),
                    professor_id: bannerId ? await publicInstructorId(bannerId) : '',
                    identity_source: bannerId ? 'faculty_id' : '',
                });
            }
        }
    }
    return jsonResponse({ faculty }, 200, pathname, {
        'Cache-Control': 'no-store, max-age=0',
        'X-Scheduler-Relay': 'sites-worker',
    });
}

async function relayRequest(request, url, route) {
    if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405, url.pathname, {
            Allow: 'POST',
        });
    }
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) {
        return jsonResponse({ error: 'Cross-origin relay requests are not allowed' }, 403, url.pathname);
    }
    if (request.headers.get('sec-fetch-site') === 'cross-site') {
        return jsonResponse({ error: 'Cross-origin relay requests are not allowed' }, 403, url.pathname);
    }
    const parsed = await parseRelayBody(request, route, url.pathname);
    if (parsed.error) return parsed.error;
    try {
        if (route.kind === 'faculty') {
            return await relayFaculty(parsed.payload, url.pathname);
        }
        const response = await fetchWithTimeout(route.upstream, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: parsed.text,
        });
        if (!response.ok) {
            return jsonResponse({
                error: 'Live data provider returned an error',
                upstream_status: response.status,
            }, response.status === 429 ? 429 : 502, url.pathname);
        }
        const maxBytes = route.kind === 'search' ? 1024 * 1024 : 256 * 1024;
        const data = await readJsonResponse(response, maxBytes);
        if (data && typeof data === 'object' && data.error) {
            return jsonResponse({ error: String(data.error) }, 502, url.pathname);
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)
            || (route.kind === 'search' && !Array.isArray(data.results))) {
            return jsonResponse({ error: 'Live data provider returned an unexpected response' }, 502, url.pathname);
        }
        return jsonResponse(data, 200, url.pathname, {
            'Cache-Control': 'no-store, max-age=0',
            'X-Scheduler-Relay': 'sites-worker',
        });
    } catch (error) {
        console.error('Live relay upstream failure', {
            route: url.pathname,
            name: String(error?.name || 'Error'),
            message: String(error?.message || 'Unknown error').slice(0, 300),
        });
        const timedOut = error?.name === 'AbortError';
        return jsonResponse({
            error: timedOut ? 'Live data request timed out' : 'Live data request failed',
            code: timedOut ? 'UPSTREAM_TIMEOUT' : String(error?.code || 'UPSTREAM_FAILED'),
        }, timedOut ? 504 : 502, url.pathname);
    }
}

const worker = {
    async fetch(request, env) {
        const url = new URL(request.url);
        const relayRoute = RELAY_ROUTES[url.pathname];
        if (relayRoute) return relayRequest(request, url, relayRoute);
        if (!['GET', 'HEAD'].includes(request.method)) {
            return withHeaders(new Response('Method not allowed', {
                status: 405,
                headers: { Allow: 'GET, HEAD' },
            }), url.pathname);
        }
        let response = await env.ASSETS.fetch(request);
        const acceptsHtml = request.headers.get('accept')?.includes('text/html');
        const isApplicationPath = !url.pathname.startsWith('/static/')
            && url.pathname !== '/service-worker.js'
            && !url.pathname.split('/').pop()?.includes('.');
        if (response.status === 404 && request.method === 'GET' && acceptsHtml && isApplicationPath) {
            response = await env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
        }
        return withHeaders(response, url.pathname);
    },
};

export default worker;

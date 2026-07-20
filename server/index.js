const SECURITY_HEADERS = Object.freeze({
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data: https://*.tile.openstreetmap.org; connect-src 'self' https://academicbulletins.sc.edu https://cdn.jsdelivr.net https://unpkg.com https://huggingface.co https://*.huggingface.co https://*.hf.co https://*.openstreetmap.de https://*.tile.openstreetmap.org; worker-src 'self' blob:; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
});

// >>> BEGIN generated from contracts/wire/fose-v1.json by scripts/sync_wire_contract.py
// The whole wire contract is embedded so the relay validates against the
// document itself rather than a hand-copied subset of it. The deployed
// worker stays a single dependency-free file because the contract is here
// at sync time, not fetched at runtime. Regenerate with
// scripts/sync_wire_contract.py; never edit below by hand.
const CONTRACT = Object.freeze(/* generated */ {
    'contract': 'fose-v1',
    'description': 'Request grammar for the three relay routes. Single source of truth for the relay\'s body validators, the browser\'s request encoders, and the Python pipeline. Upstream vocabulary appears here and nowhere else, so an upstream change is one edit followed by mechanical updates in the consumers rather than a search across the tree.',
    'generated_from': 'server/index.js, verified 2026-07-19',
    'field_notes': {
        'course_attr': 'Section attribute, matched on the exact upstream display string such as "ARP: Analytical Reasoning (3ARP)". Upstream ignores unrecognised criteria fields and answers with the whole term rather than an error, and answers an unrecognised value with zero results, so both spelling mistakes fail silently in opposite directions. The vocabulary is pinned in static/js/carolina-core.js and guarded by tests/test_course_attr_vocabulary.js.',
    },
    'limits': {
        'max_body_bytes': 16384,
        'upstream_timeout_ms': 10000,
        'max_faculty_crns': 12,
        'max_faculty_concurrency': 4,
    },
    'types': {
        'term': {
            'pattern': '^\\d{4}(?:01|05|08)$',
            'description': 'YYYYMM. 01 spring, 05 summer, 08 fall. No other suffix is a term anywhere in this system; 06 and 07 appear in older capture notes and are rejected.',
            'valid': ['202601', '202605', '202608'],
            'invalid': ['202606', '202612', '2026', '999999', ''],
        },
        'crn': {
            'pattern': '^\\d{5}$',
            'description': 'Exactly five digits.',
            'valid': ['10868', '00001'],
            'invalid': ['1086', '108680', 'abcde', ''],
        },
        'detail_group': {
            'pattern': '^crn:\\d{5}$',
            'valid': ['crn:10868'],
            'invalid': ['crn:1086', '10868', 'crn:abcde'],
        },
    },
    'routes': {
        '/api/search': {
            'method': 'POST',
            'upstream': 'https://classes.sc.edu/api/?page=fose&route=search',
            'request': {
                'exact_keys': ['other', 'criteria'],
                'other': {
                    'exact_keys': ['srcdb'],
                    'srcdb': 'term',
                },
                'criteria': {
                    'min_items': 1,
                    'max_items': 6,
                    'item_exact_keys': ['field', 'value'],
                    'allowed_fields': ['alias', 'course_attr', 'crn', 'keyword', 'stat', 'subject'],
                    'fields_may_repeat': false,
                    'value_min_length': 1,
                    'value_max_length': 120,
                    'requires_non_stat_criterion': true,
                },
            },
            'response': {
                'must_contain_array': 'results',
                'max_bytes': 1048576,
            },
        },
        '/api/details': {
            'method': 'POST',
            'upstream': 'https://classes.sc.edu/api/?page=fose&route=details',
            'request': {
                'exact_keys': ['group', 'srcdb'],
                'group': 'detail_group',
                'srcdb': 'term',
            },
            'response': {
                'max_bytes': 262144,
            },
        },
        '/api/faculty': {
            'method': 'POST',
            'upstream': 'banner:searchResults/getFacultyMeetingTimes',
            'description': 'Synthesized server-side per CRN rather than proxied. getFacultyMeetingTimes is the one Banner JSON endpoint that answers without a session cookie.',
            'request': {
                'exact_keys': ['term', 'crns'],
                'term': 'term',
                'crns': {
                    'min_items': 1,
                    'max_items': 12,
                    'unique': true,
                    'item_type': 'crn',
                },
            },
            'response': {
                'max_bytes': 262144,
            },
        },
    },
    'rejections': {
        'wrong_method': 405,
        'wrong_content_type': 415,
        'cross_origin': 403,
        'body_too_large': 413,
        'invalid_body': 400,
        'upstream_timeout': 504,
        'upstream_failure': 502,
    },
});
// Named limits mirror CONTRACT.limits so a timeout or a byte cap reads
// clearly at its call site while the contract stays their only source.
const MAX_RELAY_BODY_BYTES = 16384;
const UPSTREAM_TIMEOUT_MS = 10000;
const MAX_FACULTY_CRNS = 12;
const MAX_FACULTY_CONCURRENCY = 4;
// <<< END generated

// The scalar grammars (term, crn, detail_group) appear once in the contract, so
// they are compiled a single time here. A validator then reads the contract
// rather than restating a pattern, and an upstream change to a grammar needs no
// edit outside contracts/wire/fose-v1.json.
const COMPILED_TYPES = Object.freeze(Object.fromEntries(
    Object.entries(CONTRACT.types).map(([name, spec]) => [name, new RegExp(spec.pattern)]),
));

const BANNER_BASE = 'https://banner.onecarolina.sc.edu/StudentRegistrationSsb/ssb';

// The relay dispatches on a short internal label rather than re-deriving the
// path each request. search and details are proxied to a fixed upstream while
// faculty is synthesized per CRN, so the label decides which branch runs. The
// upstream, the request grammar and the response caps are all read from the
// contract, so this table adds no facts the contract does not already state.
function resolveRoute(pathname) {
    const route = CONTRACT.routes[pathname];
    return Object.freeze({
        kind: pathname.slice(pathname.lastIndexOf('/') + 1),
        upstream: route.upstream,
        request: route.request,
        response: route.response,
    });
}

// The route keys are spelled out here, at four-space indentation, so the
// contract's route list and the relay's are checked against each other verbatim
// by tests/test_wire_contract.js rather than trusted to stay equal.
const RELAY_ROUTES = Object.freeze({
    '/api/search': resolveRoute('/api/search'),
    '/api/details': resolveRoute('/api/details'),
    '/api/faculty': resolveRoute('/api/faculty'),
});

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

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// A value matches a named grammar exactly when the contract's pattern accepts
// the whole string. The empty string stands in for missing so that an absent
// field fails the same way an ill-formed one does.
function matchesType(value, typeName) {
    return COMPILED_TYPES[typeName].test(String(value || ''));
}

// Every relay body is an object with an exact set of keys, and the contract's
// request grammar for the route says which keys and what each one must be. This
// walks that grammar rather than hard-coding any one route's shape, so the three
// routes share one validator and a contract change is the only change needed.
function validateBody(payload, spec) {
    if (!isPlainObject(payload)) return false;
    if (Object.keys(payload).some(key => !spec.exact_keys.includes(key))) return false;
    return spec.exact_keys.every(key => validateField(payload[key], spec[key]));
}

function validateField(value, fieldSpec) {
    // A string names one of the scalar grammars. An object either nests another
    // exact-keys grammar (as other does around srcdb) or describes a list.
    if (typeof fieldSpec === 'string') return matchesType(value, fieldSpec);
    if (Array.isArray(fieldSpec.exact_keys)) return validateBody(value, fieldSpec);
    return validateList(value, fieldSpec);
}

function validateList(value, spec) {
    if (!Array.isArray(value)) return false;
    if (value.length < spec.min_items || value.length > spec.max_items) return false;

    if (typeof spec.item_type === 'string') {
        // A flat list of scalars, such as the faculty CRNs. unique forbids
        // repeats so a caller cannot pad a batch with the same number.
        const values = value.map(item => String(item || ''));
        if (!values.every(item => matchesType(item, spec.item_type))) return false;
        return !spec.unique || new Set(values).size === values.length;
    }

    // Otherwise a list of {field, value} search criteria checked against the
    // allowlist, with an optional no-repeats rule and per-value length bounds.
    const allowed = new Set(spec.allowed_fields);
    const seen = new Set();
    for (const item of value) {
        if (!isPlainObject(item)) return false;
        if (Object.keys(item).some(key => !spec.item_exact_keys.includes(key))) return false;
        const field = String(item.field || '');
        if (!allowed.has(field)) return false;
        if (!spec.fields_may_repeat && seen.has(field)) return false;
        if (typeof item.value !== 'string'
            || item.value.length < spec.value_min_length
            || item.value.length > spec.value_max_length) return false;
        seen.add(field);
    }
    // The availability filter alone answers with the whole term, so at least one
    // substantive criterion is required when the contract asks for it.
    if (spec.requires_non_stat_criterion) return value.some(item => item.field !== 'stat');
    return true;
}

async function parseRelayBody(request, route, pathname) {
    const contentType = String(request.headers.get('content-type') || '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
        return { error: jsonResponse({ error: 'Expected a JSON request body' }, CONTRACT.rejections.wrong_content_type, pathname) };
    }
    const declaredLength = Number(request.headers.get('content-length') || 0);
    if (declaredLength > MAX_RELAY_BODY_BYTES) {
        return { error: jsonResponse({ error: 'Request body is too large' }, CONTRACT.rejections.body_too_large, pathname) };
    }
    let text;
    try {
        text = await request.text();
    } catch (error) {
        return { error: jsonResponse({ error: 'Could not read request body' }, CONTRACT.rejections.invalid_body, pathname) };
    }
    if (new TextEncoder().encode(text).byteLength > MAX_RELAY_BODY_BYTES) {
        return { error: jsonResponse({ error: 'Request body is too large' }, CONTRACT.rejections.body_too_large, pathname) };
    }
    let payload;
    try {
        payload = JSON.parse(text);
    } catch (error) {
        return { error: jsonResponse({ error: 'Request body is not valid JSON' }, CONTRACT.rejections.invalid_body, pathname) };
    }
    if (!validateBody(payload, route.request)) {
        return { error: jsonResponse({ error: 'Request body is invalid for this operation' }, CONTRACT.rejections.invalid_body, pathname) };
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

async function relayFaculty(payload, route, pathname) {
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
            const data = await readJsonResponse(response, route.response.max_bytes);
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
        return jsonResponse({ error: 'Method not allowed' }, CONTRACT.rejections.wrong_method, url.pathname, {
            Allow: 'POST',
        });
    }
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) {
        return jsonResponse({ error: 'Cross-origin relay requests are not allowed' }, CONTRACT.rejections.cross_origin, url.pathname);
    }
    if (request.headers.get('sec-fetch-site') === 'cross-site') {
        return jsonResponse({ error: 'Cross-origin relay requests are not allowed' }, CONTRACT.rejections.cross_origin, url.pathname);
    }
    const parsed = await parseRelayBody(request, route, url.pathname);
    if (parsed.error) return parsed.error;
    try {
        if (route.kind === 'faculty') {
            return await relayFaculty(parsed.payload, route, url.pathname);
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
            }, response.status === 429 ? 429 : CONTRACT.rejections.upstream_failure, url.pathname);
        }
        const data = await readJsonResponse(response, route.response.max_bytes);
        if (data && typeof data === 'object' && data.error) {
            return jsonResponse({ error: String(data.error) }, CONTRACT.rejections.upstream_failure, url.pathname);
        }
        // The contract names the array a good response must carry (results, for
        // search) and the rest of the shape check is generic. A non-object, an
        // array, or a missing named array all mean the upstream did not answer
        // the way the contract promises, which is an upstream failure rather
        // than a client error, so it maps to the contract's upstream_failure.
        if (!isPlainObject(data)
            || (route.response.must_contain_array
                && !Array.isArray(data[route.response.must_contain_array]))) {
            return jsonResponse({ error: 'Live data provider returned an unexpected response' }, CONTRACT.rejections.upstream_failure, url.pathname);
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
        }, timedOut ? CONTRACT.rejections.upstream_timeout : CONTRACT.rejections.upstream_failure, url.pathname);
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

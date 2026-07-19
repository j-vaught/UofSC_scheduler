/*
 * Local host for the relay worker.
 *
 * index.js is written for a Cloudflare-style runtime: it exports a default
 * object with fetch(request, env), and reaches static files through an
 * env.ASSETS binding. This file supplies both so the same worker source can be
 * exercised on plain Node, without a deploy and without wrangler.
 *
 *   node server/dev-server.js [--port 8787] [--assets dist/client]
 *
 * Requests to /api/* run through the real relay, including every validation
 * rule and the live upstream call. Everything else is served from the assets
 * directory with an SPA fallback, matching the deployed behavior.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
    const options = { port: 8787, assets: path.join(ROOT, 'dist/client') };
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === '--port') options.port = Number(argv[index + 1]);
        if (argv[index] === '--assets') options.assets = path.resolve(argv[index + 1]);
    }
    return options;
}

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
};

/* Stand-in for the Cloudflare ASSETS binding. */
function createAssets(assetsDir) {
    return {
        async fetch(request) {
            const url = new URL(request.url);
            const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
            const candidate = path.resolve(assetsDir, relative || 'index.html');
            // Refuse anything that escapes the assets directory.
            if (!candidate.startsWith(path.resolve(assetsDir))) {
                return new Response('Forbidden', { status: 403 });
            }
            if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
                return new Response('Not Found', { status: 404 });
            }
            return new Response(fs.readFileSync(candidate), {
                status: 200,
                headers: {
                    'Content-Type': CONTENT_TYPES[path.extname(candidate)] || 'application/octet-stream',
                    // Local iteration only. Without this the browser serves a cached
                    // copy of a file you just edited and rebuilt, which is
                    // indistinguishable from the fix not working. Production sets
                    // immutable caching on hashed release artifacts instead.
                    'Cache-Control': 'no-store, max-age=0, must-revalidate',
                },
            });
        },
    };
}

async function toRequest(nodeRequest, origin) {
    const chunks = [];
    for await (const chunk of nodeRequest) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    return new Request(new URL(nodeRequest.url, origin), {
        method: nodeRequest.method,
        headers: nodeRequest.headers,
        body: ['GET', 'HEAD'].includes(nodeRequest.method) ? undefined : body,
    });
}

async function writeResponse(response, nodeResponse) {
    const headers = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    nodeResponse.writeHead(response.status, headers);
    const buffer = Buffer.from(await response.arrayBuffer());
    nodeResponse.end(buffer);
}

const options = parseArgs(process.argv.slice(2));

if (!fs.existsSync(options.assets)) {
    console.error(`Assets directory not found: ${options.assets}`);
    console.error('Build it first: uv run python scripts/build_static_site.py --allow-representative');
    process.exit(1);
}

const { default: worker } = await import('./index.js');
const env = { ASSETS: createAssets(options.assets) };

const server = http.createServer(async (nodeRequest, nodeResponse) => {
    const origin = `http://127.0.0.1:${options.port}`;
    try {
        const request = await toRequest(nodeRequest, origin);
        const response = await worker.fetch(request, env, {});
        await writeResponse(response, nodeResponse);
        console.log(`${nodeRequest.method} ${nodeRequest.url} -> ${response.status}`);
    } catch (error) {
        console.error(`${nodeRequest.method} ${nodeRequest.url} -> 500`, error);
        nodeResponse.writeHead(500, { 'Content-Type': 'text/plain' });
        nodeResponse.end('Dev server error');
    }
});

server.listen(options.port, '127.0.0.1', () => {
    console.log(`Relay worker on http://127.0.0.1:${options.port}`);
    console.log(`Serving assets from ${options.assets}`);
});

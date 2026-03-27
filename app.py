#!/usr/bin/env python3
"""UofSC Course Scheduler — local server with API proxy and solver."""

import http.server
import socketserver
import json
import urllib.request
import urllib.error
import os
import time
import re
from urllib.parse import urlparse

import cache

PORT = 8765
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static')

CLASSES_API = 'https://classes.sc.edu/api/?page=fose&route='
BULLETIN_API = 'https://academicbulletins.sc.edu/course-search/api/?page=fose&route='

TERM_CODES = [
    '202308', '202401', '202405', '202408',
    '202501', '202505', '202508',
    '202601', '202605', '202608',
]

MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
}


def proxy_request(upstream_url, body_bytes, ttl=300):
    key = cache.make_key(upstream_url, body_bytes.decode())
    cached = cache.get(key)
    if cached:
        return cached

    req = urllib.request.Request(
        upstream_url,
        data=body_bytes,
        headers={'Content-Type': 'application/json', 'Accept': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = resp.read()
        cache.put(key, data, ttl)
        return data
    except urllib.error.HTTPError as e:
        return json.dumps({'error': str(e), 'code': e.code}).encode()
    except Exception as e:
        return json.dumps({'error': str(e)}).encode()


def handle_history(body):
    params = json.loads(body)
    course_code = params.get('code', '')
    subject = course_code.split()[0] if ' ' in course_code else course_code

    results = {}
    for term in TERM_CODES:
        payload = json.dumps({
            'other': {'srcdb': term},
            'criteria': [{'field': 'subject', 'value': subject}],
        }).encode()
        data = proxy_request(CLASSES_API + 'search', payload, ttl=86400)
        try:
            parsed = json.loads(data)
            matches = [
                r for r in parsed.get('results', [])
                if r.get('code', '') == course_code and r.get('section', '').startswith('0')
            ]
            if matches:
                instructors = list(set(r.get('instr', 'Staff') for r in matches))
                times = list(set(r.get('meets', 'TBA') for r in matches))
                results[term] = {
                    'offered': True,
                    'sections': len(matches),
                    'instructors': instructors,
                    'times': times,
                }
            else:
                results[term] = {'offered': False}
        except json.JSONDecodeError:
            results[term] = {'offered': False, 'error': 'parse_error'}
        time.sleep(0.2)

    term_names = {
        '01': 'Spring', '05': 'Summer', '08': 'Fall',
    }
    summary = []
    for t in TERM_CODES:
        year = t[:4]
        sem = term_names.get(t[4:], t[4:])
        summary.append({
            'term': t,
            'label': f'{sem} {year}',
            **results.get(t, {'offered': False}),
        })

    offered_count = sum(1 for s in summary if s.get('offered'))
    return json.dumps({
        'code': course_code,
        'total_terms': len(TERM_CODES),
        'offered_count': offered_count,
        'terms': summary,
    }).encode()


class Handler(http.server.BaseHTTPRequestHandler):

    def log_message(self, format, *args):
        pass  # suppress default logging

    def _send_json(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        if isinstance(data, str):
            data = data.encode()
        self.wfile.write(data)

    def _send_file(self, filepath):
        if not os.path.isfile(filepath):
            self.send_error(404)
            return
        ext = os.path.splitext(filepath)[1].lower()
        mime = MIME_TYPES.get(ext, 'application/octet-stream')
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.end_headers()
        with open(filepath, 'rb') as f:
            self.wfile.write(f.read())

    def _read_body(self):
        length = int(self.headers.get('Content-Length', 0))
        return self.rfile.read(length) if length > 0 else b'{}'

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/':
            self._send_file(os.path.join(STATIC_DIR, 'index.html'))
        elif path.startswith('/static/'):
            rel = path[len('/static/'):]
            self._send_file(os.path.join(STATIC_DIR, rel))
        elif path == '/api/subjects':
            self._send_json(json.dumps(SUBJECTS))
        else:
            self.send_error(404)

    def do_POST(self):
        path = self.path.split('?')[0]
        body = self._read_body()

        if path == '/api/search':
            data = proxy_request(CLASSES_API + 'search', body, ttl=300)
            self._send_json(data)

        elif path == '/api/details':
            data = proxy_request(CLASSES_API + 'details', body, ttl=300)
            self._send_json(data)

        elif path == '/api/bulletin/search':
            data = proxy_request(BULLETIN_API + 'search', body, ttl=86400)
            self._send_json(data)

        elif path == '/api/bulletin/details':
            data = proxy_request(BULLETIN_API + 'details', body, ttl=86400)
            self._send_json(data)

        elif path == '/api/history':
            data = handle_history(body)
            self._send_json(data)

        elif path == '/api/solve':
            from scheduler import solve
            params = json.loads(body)
            result = solve(params)
            self._send_json(json.dumps(result))

        else:
            self._send_json('{"error":"unknown route"}', 404)


SUBJECTS = [
    "ACCT","AESP","AFAM","ANES","ANTH","ARAB","ARTE","ARTH","ARTS","ASLG",
    "ASNR","ASTR","ATEP","BADM","BIOL","BIOS","BMEN","BMSC","CHEM","CHIN",
    "CLAS","COLA","COMD","COMM","CPLT","CRJU","CSCE","CYBR","DANC","DMED",
    "DMSB","ECHE","ECIV","ECON","EDAD","EDCE","EDCS","EDEC","EDEL","EDET",
    "EDEX","EDFI","EDHE","EDLP","EDML","EDPY","EDRD","EDRM","EDSE","EDTE",
    "EDUC","ELCT","EMCH","EMED","ENCP","ENFS","ENGL","ENHS","ENTR","ENVR",
    "EPID","EURO","EXSC","FAME","FAMS","FINA","FORL","FPMD","FREN","GENE",
    "GEOG","GEOL","GERM","GLST","GMED","GRAD","GREK","HEBR","HGEN","HIST",
    "HPEB","HRSM","HRTM","HSPM","HTMT","IBUS","ICOM","IDST","INDE","INTL",
    "ISCI","ITAL","ITEC","JAPA","JOUR","JSTU","KORE","LASP","LATN","LAWG",
    "LAWH","LAWS","LING","MART","MATH","MBAD","MBIM","MCBA","MEDI","MGMT",
    "MGSC","MKTG","MSCI","MUED","MUSC","MUSM","NEUR","NPSY","NSCI","NURS",
    "OBGY","OPTH","ORSU","PALM","PAMB","PATH","PCAM","PEDI","PEDU","PHAR",
    "PHIL","PHMY","PHPH","PHYS","PHYT","PMDR","PNDI","POLI","PORT","PSYC",
    "PUBH","RADI","RCON","RELG","RETL","RUSS","SAEL","SCHC","SOCY","SOST",
    "SOWK","SPAN","SPCH","SPTE","STAT","SURG","SVAD","THEA","UNIV","WGST",
]


class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == '__main__':
    print(f'UofSC Course Scheduler running at http://127.0.0.1:{PORT}')
    server = ThreadedHTTPServer(('127.0.0.1', PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nShutting down.')
        server.shutdown()

#!/usr/bin/env python3
"""UofSC Course Scheduler — local server with API proxy and solver."""

import http.server
import socketserver
import concurrent.futures
import json
import urllib.request
import urllib.error
import os
import re
import time

import cache
import transcript as transcript_mod
import planner as planner_mod
import offering_analyzer
import grade_analytics

PORT = 8765
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

LIVE_CACHE_TTL = 300
HISTORY_CACHE_TTL = 30 * 24 * 60 * 60
HISTORY_CACHE_VERSION = 2

CLASSES_API = "https://classes.sc.edu/api/?page=fose&route="
BULLETIN_API = "https://academicbulletins.sc.edu/course-search/api/?page=fose&route="

TERM_CODES = [
    "202308",
    "202401",
    "202405",
    "202408",
    "202501",
    "202505",
    "202508",
    "202601",
    "202605",
    "202608",
    "202701",
    "202705",
    "202708",
    "202801",
    "202805",
    "202808",
    "202901",
    "202905",
    "202908",
]

MIME_TYPES = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


def proxy_request(
    upstream_url,
    body_bytes,
    ttl=LIVE_CACHE_TTL,
    force_refresh=False,
):
    key = cache.make_key(upstream_url, body_bytes.decode())
    cached = None if force_refresh else cache.get(key)
    if cached:
        return cached

    req = urllib.request.Request(
        upstream_url,
        data=body_bytes,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = resp.read()
        try:
            parsed = json.loads(data)
        except (json.JSONDecodeError, TypeError, UnicodeDecodeError):
            parsed = None
        if parsed is not None and not (isinstance(parsed, dict) and parsed.get("error")):
            cache.put(key, data, ttl)
        return data
    except urllib.error.HTTPError as e:
        return json.dumps({"error": str(e), "code": e.code}).encode()
    except Exception as e:
        return json.dumps({"error": str(e)}).encode()


def _history_cache_key(course_code, as_of_term, terms):
    cache_spec = json.dumps(
        {
            "version": HISTORY_CACHE_VERSION,
            "code": course_code,
            "as_of_term": as_of_term,
            "terms": terms,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return cache.make_key(f"course-history-v{HISTORY_CACHE_VERSION}", cache_spec)


def _upstream_payload(data):
    try:
        payload = json.loads(data)
    except (json.JSONDecodeError, TypeError, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict) or payload.get("error"):
        return None
    return payload


def _history_term_label(term):
    term_names = {
        "01": "Spring",
        "05": "Summer",
        "08": "Fall",
    }
    return f"{term_names.get(term[4:], term[4:])} {term[:4]}"


def _emit_history_progress(progress, phase, completed, total, term, **details):
    if progress is None:
        return
    progress(
        {
            "type": "progress",
            "phase": phase,
            "completed": completed,
            "total": total,
            "term": term,
            "label": _history_term_label(term),
            **details,
        }
    )


def handle_history(body, progress=None):
    params = json.loads(body)
    course_code = " ".join(str(params.get("code", "")).upper().split())
    if not course_code or " " not in course_code:
        return json.dumps({"error": "invalid course code"}).encode()

    subject = course_code.split()[0]
    as_of_term = offering_analyzer.current_academic_term()
    history_terms = [term for term in TERM_CODES if term < as_of_term]
    history_cache_key = _history_cache_key(course_code, as_of_term, history_terms)
    cached = cache.get(history_cache_key)
    if cached:
        return cached

    results: dict[str, dict[str, object]] = {}
    complete = True
    total_terms = len(history_terms)
    for term_index, term in enumerate(history_terms):
        _emit_history_progress(progress, "terms", term_index, total_terms, term)
        payload = json.dumps(
            {
                "other": {"srcdb": term},
                "criteria": [{"field": "subject", "value": subject}],
            }
        ).encode()
        data = proxy_request(
            CLASSES_API + "search",
            payload,
            ttl=HISTORY_CACHE_TTL,
        )
        parsed = _upstream_payload(data)
        rows = parsed.get("results") if parsed is not None else None
        if not isinstance(rows, list):
            complete = False
            results[term] = {
                "available": False,
                "complete": False,
                "error": True,
            }
            _emit_history_progress(progress, "terms", term_index + 1, total_terms, term)
            time.sleep(0.2)
            continue

        matches = [
            row
            for row in rows
            if " ".join(str(row.get("code", "")).upper().split()) == course_code
            and not row.get("isCancelled")
        ]
        if matches:
            instructors = sorted(set(row.get("instr", "Staff") for row in matches))
            times = sorted(set(row.get("meets", "TBA") for row in matches))
            enrollment = 0
            capacity = 0
            enrollment_sections = 0
            enrollment_error = False
            for section_index, section in enumerate(matches, start=1):
                detail_payload = json.dumps(
                    {
                        "group": f"crn:{section.get('crn', '')}",
                        "srcdb": term,
                    }
                ).encode()
                detail_data = proxy_request(
                    CLASSES_API + "details",
                    detail_payload,
                    ttl=HISTORY_CACHE_TTL,
                )
                details = _upstream_payload(detail_data)
                if details is None:
                    complete = False
                    enrollment_error = True
                else:
                    seats_html = details.get("seats", "")
                    maximum = re.search(r"seats_max[^>]*>(\d+)", seats_html)
                    available = re.search(r"seats_avail[^>]*>(\d+)", seats_html)
                    if maximum and available:
                        section_capacity = int(maximum.group(1))
                        capacity += section_capacity
                        enrollment += max(0, section_capacity - int(available.group(1)))
                        enrollment_sections += 1
                _emit_history_progress(
                    progress,
                    "enrollment",
                    term_index,
                    total_terms,
                    term,
                    section=section_index,
                    section_total=len(matches),
                )

            results[term] = {
                "available": True,
                "complete": True,
                "offered": True,
                "sections": len(matches),
                "instructors": instructors,
                "times": times,
            }
            if enrollment_error:
                results[term]["enrollment_error"] = True
            elif enrollment_sections:
                results[term].update(
                    {
                        "enrollment": enrollment,
                        "capacity": capacity,
                        "enrollment_sections": enrollment_sections,
                    }
                )
        else:
            results[term] = {
                "available": True,
                "complete": True,
                "offered": False,
            }
        _emit_history_progress(progress, "terms", term_index + 1, total_terms, term)
        time.sleep(0.2)

    summary = []
    for term in history_terms:
        summary.append(
            {
                "term": term,
                "label": _history_term_label(term),
                **results[term],
            }
        )

    response = json.dumps(
        {
            "code": course_code,
            "as_of_term": as_of_term,
            "complete": complete,
            "total_terms": len(history_terms),
            "offered_count": sum(1 for term in summary if term.get("offered")),
            "terms": summary,
        }
    ).encode()
    if complete:
        cache.put(history_cache_key, response, ttl=HISTORY_CACHE_TTL)
    return response


def handle_faculty(body):
    """Return current-term full instructor identities for selected sections."""
    params = json.loads(body)
    term = str(params.get("term", ""))
    crns = list(dict.fromkeys(str(crn) for crn in params.get("crns", [])))[:12]
    if not re.fullmatch(r"\d{6}", term) or any(not re.fullmatch(r"\d+", crn) for crn in crns):
        return json.dumps({"error": "invalid term or CRN", "faculty": []}).encode()

    def fetch_one(crn):
        cache_key = cache.make_key("current-faculty", f"{term}:{crn}")
        cached = cache.get(cache_key)
        if cached:
            members = json.loads(cached)
        else:
            from grade_pipeline import fetch_faculty

            _, _, members = fetch_faculty((term, crn))
            cache.put(cache_key, json.dumps(members).encode(), ttl=86400)
        from grade_pipeline import public_instructor_id

        return [
            {
                "crn": crn,
                "name": member.get("name", ""),
                "email": member.get("email", ""),
                "primary": bool(member.get("primary")),
                "professor_id": public_instructor_id(member),
            }
            for member in members
            if member.get("name")
        ]

    records = []
    if crns:
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(4, len(crns))) as executor:
            for result in executor.map(fetch_one, crns):
                records.extend(result)
    return json.dumps({"faculty": records}).encode()


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # suppress default logging

    def _send_json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        if isinstance(data, str):
            data = data.encode()
        self.wfile.write(data)

    def _send_history_stream(self, body):
        connected = True
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
        except (OSError, ValueError):
            connected = False

        def write_event(event):
            nonlocal connected
            if not connected:
                return
            try:
                self.wfile.write(json.dumps(event, separators=(",", ":")).encode() + b"\n")
                self.wfile.flush()
            except (OSError, ValueError):
                connected = False

        data = handle_history(body, progress=write_event)
        write_event({"type": "result", "data": json.loads(data)})

    def _send_file(self, filepath):
        resolved = os.path.realpath(filepath)
        static_root = os.path.realpath(STATIC_DIR)
        if os.path.commonpath([resolved, static_root]) != static_root or not os.path.isfile(
            resolved
        ):
            self.send_error(404)
            return
        ext = os.path.splitext(resolved)[1].lower()
        mime = MIME_TYPES.get(ext, "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.end_headers()
        with open(resolved, "rb") as f:
            self.wfile.write(f.read())

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(length) if length > 0 else b"{}"

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type, X-UofSC-Refresh-Live",
        )
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/":
            self._send_file(os.path.join(STATIC_DIR, "index.html"))
        elif path.startswith("/static/"):
            rel = path[len("/static/") :]
            self._send_file(os.path.join(STATIC_DIR, rel))
        elif path == "/api/subjects":
            self._send_json(json.dumps(SUBJECTS))
        elif path == "/api/major-maps":
            maps = planner_mod.list_major_maps()
            self._send_json(json.dumps(maps))
        elif path == "/api/grade-meta":
            self._send_json(json.dumps(grade_analytics.metadata()))
        else:
            self.send_error(404)

    def do_POST(self):
        path = self.path.split("?")[0]
        body = self._read_body()
        refresh_live = self.headers.get("X-UofSC-Refresh-Live") == "1"

        if path == "/api/search":
            data = proxy_request(
                CLASSES_API + "search",
                body,
                ttl=LIVE_CACHE_TTL,
                force_refresh=refresh_live,
            )
            self._send_json(data)

        elif path == "/api/details":
            data = proxy_request(
                CLASSES_API + "details",
                body,
                ttl=LIVE_CACHE_TTL,
                force_refresh=refresh_live,
            )
            self._send_json(data)

        elif path == "/api/bulletin/search":
            data = proxy_request(BULLETIN_API + "search", body, ttl=86400)
            self._send_json(data)

        elif path == "/api/bulletin/details":
            data = proxy_request(BULLETIN_API + "details", body, ttl=86400)
            self._send_json(data)

        elif path == "/api/history":
            data = handle_history(body)
            self._send_json(data)

        elif path == "/api/history-stream":
            self._send_history_stream(body)

        elif path == "/api/solve":
            from scheduler import solve

            params = json.loads(body)
            result = solve(params)
            self._send_json(json.dumps(result))

        elif path == "/api/parse-transcript":
            params = json.loads(body)
            if "csv" in params:
                courses = transcript_mod.parse_csv(params["csv"])
            elif "text" in params:
                codes = transcript_mod.parse_text(params["text"])
                courses = [
                    {"code": c, "grade": None, "credits": None, "semester": None} for c in codes
                ]
            else:
                courses = []
            self._send_json(json.dumps({"courses": courses}))

        elif path == "/api/major-map":
            params = json.loads(body)
            map_id = params.get("id", "")
            major_map = planner_mod.load_major_map(map_id)
            if major_map:
                self._send_json(json.dumps(major_map))
            else:
                self._send_json('{"error":"major map not found"}', 404)

        elif path == "/api/degree-plan":
            params = json.loads(body)
            map_id = params.get("map_id", "")
            major_map = planner_mod.load_major_map(map_id)
            if not major_map:
                self._send_json('{"error":"major map not found"}', 404)
            else:
                result = planner_mod.plan_degree(
                    major_map=major_map,
                    completed_codes=params.get("completed", []),
                    mode=params.get("mode", "full_time"),
                    pins=params.get("pins", {}),
                    start_term=params.get("start_term", "202608"),
                    include_summer=params.get("include_summer", False),
                    custom_credits=params.get("custom_credits"),
                    concentration=params.get("concentration", "general"),
                    offering_history=params.get("offering_history"),
                )
                self._send_json(json.dumps(result))

        elif path == "/api/offering-analysis":
            params = json.loads(body)
            course_code = params.get("code", "")
            # Fetch history first, then analyze
            history_body = json.dumps({"code": course_code}).encode()
            history_data = json.loads(handle_history(history_body))
            current_term = params.get("current_term", "202608")
            summary = offering_analyzer.get_offering_summary(history_data, current_term)
            self._send_json(json.dumps(summary))

        elif path == "/api/course-grades":
            params = json.loads(body)
            result = grade_analytics.course(params.get("code", ""))
            if result is None:
                self._send_json('{"error":"course grade history not found"}', 404)
            else:
                self._send_json(json.dumps(result))

        elif path == "/api/faculty":
            try:
                self._send_json(handle_faculty(body))
            except Exception:
                self._send_json('{"error":"faculty lookup unavailable","faculty":[]}', 502)

        elif path == "/api/professor-grades":
            params = json.loads(body)
            result = grade_analytics.professor(params.get("id", ""))
            if result is None:
                self._send_json('{"error":"professor grade history not found"}', 404)
            else:
                self._send_json(json.dumps(result))

        else:
            self._send_json('{"error":"unknown route"}', 404)


SUBJECTS = [
    "ACCT",
    "AESP",
    "AFAM",
    "ANES",
    "ANTH",
    "ARAB",
    "ARTE",
    "ARTH",
    "ARTS",
    "ASLG",
    "ASNR",
    "ASTR",
    "ATEP",
    "BADM",
    "BIOL",
    "BIOS",
    "BMEN",
    "BMSC",
    "CHEM",
    "CHIN",
    "CLAS",
    "COLA",
    "COMD",
    "COMM",
    "CPLT",
    "CRJU",
    "CSCE",
    "CYBR",
    "DANC",
    "DMED",
    "DMSB",
    "ECHE",
    "ECIV",
    "ECON",
    "EDAD",
    "EDCE",
    "EDCS",
    "EDEC",
    "EDEL",
    "EDET",
    "EDEX",
    "EDFI",
    "EDHE",
    "EDLP",
    "EDML",
    "EDPY",
    "EDRD",
    "EDRM",
    "EDSE",
    "EDTE",
    "EDUC",
    "ELCT",
    "EMCH",
    "EMED",
    "ENCP",
    "ENFS",
    "ENGL",
    "ENHS",
    "ENTR",
    "ENVR",
    "EPID",
    "EURO",
    "EXSC",
    "FAME",
    "FAMS",
    "FINA",
    "FORL",
    "FPMD",
    "FREN",
    "GENE",
    "GEOG",
    "GEOL",
    "GERM",
    "GLST",
    "GMED",
    "GRAD",
    "GREK",
    "HEBR",
    "HGEN",
    "HIST",
    "HPEB",
    "HRSM",
    "HRTM",
    "HSPM",
    "HTMT",
    "IBUS",
    "ICOM",
    "IDST",
    "INDE",
    "INTL",
    "ISCI",
    "ITAL",
    "ITEC",
    "JAPA",
    "JOUR",
    "JSTU",
    "KORE",
    "LASP",
    "LATN",
    "LAWG",
    "LAWH",
    "LAWS",
    "LING",
    "MART",
    "MATH",
    "MBAD",
    "MBIM",
    "MCBA",
    "MEDI",
    "MGMT",
    "MGSC",
    "MKTG",
    "MSCI",
    "MUED",
    "MUSC",
    "MUSM",
    "NEUR",
    "NPSY",
    "NSCI",
    "NURS",
    "OBGY",
    "OPTH",
    "ORSU",
    "PALM",
    "PAMB",
    "PATH",
    "PCAM",
    "PEDI",
    "PEDU",
    "PHAR",
    "PHIL",
    "PHMY",
    "PHPH",
    "PHYS",
    "PHYT",
    "PMDR",
    "PNDI",
    "POLI",
    "PORT",
    "PSYC",
    "PUBH",
    "RADI",
    "RCON",
    "RELG",
    "RETL",
    "RUSS",
    "SAEL",
    "SCHC",
    "SOCY",
    "SOST",
    "SOWK",
    "SPAN",
    "SPCH",
    "SPTE",
    "STAT",
    "SURG",
    "SVAD",
    "THEA",
    "UNIV",
    "WGST",
]


class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    print(f"UofSC Course Scheduler running at http://127.0.0.1:{PORT}")
    server = ThreadedHTTPServer(("127.0.0.1", PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.shutdown()

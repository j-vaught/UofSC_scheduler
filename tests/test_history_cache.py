import json
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

import app


class _Response:
    def __init__(self, body: bytes):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self) -> bytes:
        return self.body


def test_proxy_request_caches_only_successful_json(monkeypatch):
    responses = iter(
        [
            b'{"error":"upstream unavailable"}',
            b"not-json",
            b'{"results":[]}',
        ]
    )
    writes = []
    monkeypatch.setattr(app.cache, "get", lambda _key: None)
    monkeypatch.setattr(app.cache, "put", lambda *args, **kwargs: writes.append((args, kwargs)))
    monkeypatch.setattr(
        app.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: _Response(next(responses)),
    )

    for _ in range(3):
        app.proxy_request("https://example.test/search", b"{}", ttl=123)

    assert len(writes) == 1
    assert writes[0][0][1] == b'{"results":[]}'
    assert writes[0][0][2] == 123


def test_proxy_force_refresh_bypasses_read_and_replaces_cache(monkeypatch):
    reads = []
    writes = []
    monkeypatch.setattr(
        app.cache,
        "get",
        lambda key: reads.append(key) or b'{"results":["cached"]}',
    )
    monkeypatch.setattr(app.cache, "put", lambda *args: writes.append(args))
    monkeypatch.setattr(
        app.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: _Response(b'{"results":["fresh"]}'),
    )

    result = app.proxy_request(
        "https://example.test/search",
        b"{}",
        ttl=123,
        force_refresh=True,
    )

    assert result == b'{"results":["fresh"]}'
    assert reads == []
    assert len(writes) == 1
    assert writes[0][1:] == (b'{"results":["fresh"]}', 123)


def test_proxy_returns_valid_upstream_response_when_cache_fails(monkeypatch):
    def cache_failure(*_args, **_kwargs):
        raise RuntimeError("cache unavailable")

    monkeypatch.setattr(app.cache, "get", cache_failure)
    monkeypatch.setattr(app.cache, "put", cache_failure)
    monkeypatch.setattr(
        app.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: _Response(b'{"results":["fresh"]}'),
    )

    result = app.proxy_request("https://example.test/search", b"{}", ttl=123)

    assert result == b'{"results":["fresh"]}'


def test_history_cache_uses_completed_terms_and_sixty_day_ttl(monkeypatch):
    stored = {}
    writes = []
    upstream_calls = []

    monkeypatch.setattr(app, "TERM_CODES", ["202401", "202405", "202408"])
    monkeypatch.setattr(app.offering_analyzer, "current_academic_term", lambda: "202405")
    monkeypatch.setattr(app.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(app.cache, "get", lambda key: stored.get(key))

    def cache_put(key, data, ttl):
        writes.append((key, data, ttl))
        stored[key] = data

    monkeypatch.setattr(app.cache, "put", cache_put)

    def proxy_request(url, body, ttl):
        payload = json.loads(body)
        upstream_calls.append((url, payload, ttl))
        if url.endswith("search"):
            return json.dumps(
                {
                    "results": [
                        {
                            "code": "CSCE 145",
                            "crn": "12345",
                            "instr": "Kanapala",
                            "meets": "MW 8:30a-9:20a",
                        }
                    ]
                }
            ).encode()
        return b'{"seats":"<span class=\\"seats_max\\">30</span><span class=\\"seats_avail\\">5</span>"}'

    monkeypatch.setattr(app, "proxy_request", proxy_request)

    first = json.loads(app.handle_history(b'{"code":" csce   145 "}'))
    second = json.loads(app.handle_history(b'{"code":"CSCE 145"}'))

    assert first == second
    assert first["code"] == "CSCE 145"
    assert first["as_of_term"] == "202405"
    assert first["complete"] is True
    assert first["total_terms"] == 1
    assert first["terms"] == [
        {
            "term": "202401",
            "label": "Spring 2024",
            "available": True,
            "complete": True,
            "offered": True,
            "sections": 1,
            "instructors": ["Kanapala"],
            "times": ["MW 8:30a-9:20a"],
            "enrollment": 25,
            "capacity": 30,
            "enrollment_sections": 1,
        }
    ]
    assert len(upstream_calls) == 2
    assert {call[1].get("srcdb") or call[1]["other"]["srcdb"] for call in upstream_calls} == {
        "202401"
    }
    assert all(call[2] == app.HISTORY_CACHE_TTL for call in upstream_calls)
    assert len(writes) == 2
    assert all(write[2] == 5_184_000 for write in writes)


def test_history_cache_key_includes_boundary_and_exact_term_list(monkeypatch):
    calls = []

    def make_key(namespace, body):
        calls.append((namespace, json.loads(body)))
        return f"key-{len(calls)}"

    monkeypatch.setattr(app.cache, "make_key", make_key)

    first = app._history_cache_key("CSCE 145", "202405", ["202401"])
    second = app._history_cache_key("CSCE 145", "202408", ["202401", "202405"])

    assert first != second
    assert calls[0] == (
        "course-history-v3",
        {
            "version": 3,
            "code": "CSCE 145",
            "as_of_term": "202405",
            "terms": ["202401"],
        },
    )
    assert calls[1][1]["terms"] == ["202401", "202405"]


def test_many_sections_use_one_banner_enrollment_summary_instead_of_detail_calls(
    monkeypatch,
):
    events = []
    calls = []
    enrollment_calls = []
    monkeypatch.setattr(app, "TERM_CODES", ["202401", "202405"])
    monkeypatch.setattr(app.offering_analyzer, "current_academic_term", lambda: "202405")
    monkeypatch.setattr(app.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(app.cache, "get", lambda _key: None)
    monkeypatch.setattr(app.cache, "put", lambda *_args, **_kwargs: None)

    def proxy_request(url, body, ttl):
        calls.append((url, json.loads(body), ttl))
        assert url.endswith("search")
        return json.dumps(
            {"results": [{"code": "CSCE 145", "crn": str(10000 + index)} for index in range(5)]}
        ).encode()

    def fetch_enrollment(_session, code, term, crns):
        enrollment_calls.append((code, term, crns))
        return {"enrollment": 91, "capacity": 125, "enrollment_sections": 5}

    monkeypatch.setattr(app, "proxy_request", proxy_request)
    monkeypatch.setattr(app, "_fetch_banner_enrollment", fetch_enrollment)

    result = json.loads(app.handle_history(b'{"code":"CSCE 145"}', progress=events.append))

    assert len(calls) == 1
    assert enrollment_calls == [
        ("CSCE 145", "202401", ["10000", "10001", "10002", "10003", "10004"])
    ]
    assert result["terms"][0]["enrollment"] == 91
    assert result["terms"][0]["capacity"] == 125
    summary_events = [event for event in events if event.get("mode") == "summary"]
    assert [event["section"] for event in summary_events] == [0, 5]


def test_banner_summary_failure_opens_circuit_for_remaining_history_build(monkeypatch):
    summary_calls = []
    upstream_calls = []
    monkeypatch.setattr(app, "TERM_CODES", ["202401", "202405", "202408"])
    monkeypatch.setattr(app.offering_analyzer, "current_academic_term", lambda: "202408")
    monkeypatch.setattr(app.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(app.cache, "get", lambda _key: None)
    monkeypatch.setattr(app.cache, "put", lambda *_args, **_kwargs: None)

    def proxy_request(url, body, ttl):
        payload = json.loads(body)
        upstream_calls.append((url, payload, ttl))
        if url.endswith("search"):
            return json.dumps(
                {
                    "results": [
                        {
                            "code": "CSCE 145",
                            "crn": f"{payload['other']['srcdb']}{index}",
                        }
                        for index in range(5)
                    ]
                }
            ).encode()
        return b'{"seats":"<span class=\\"seats_max\\">30</span><span class=\\"seats_avail\\">5</span>"}'

    def failed_summary(_session, code, term, crns):
        summary_calls.append((code, term, crns))
        return None

    monkeypatch.setattr(app, "proxy_request", proxy_request)
    monkeypatch.setattr(app, "_fetch_banner_enrollment", failed_summary)

    result = json.loads(app.handle_history(b'{"code":"CSCE 145"}'))

    assert result["complete"] is True
    assert len(summary_calls) == 1
    assert summary_calls[0][1] == "202401"
    assert len([call for call in upstream_calls if call[0].endswith("details")]) == 10


def test_banner_enrollment_summary_uses_two_requests_and_caches_exact_totals(monkeypatch):
    writes = []
    monkeypatch.setattr(app.cache, "get", lambda _key: None)
    monkeypatch.setattr(app.cache, "put", lambda *args, **kwargs: writes.append((args, kwargs)))

    class Response:
        def __init__(self, payload=None):
            self.payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self.payload

    class Session:
        def __init__(self):
            self.calls = []

        def post(self, url, **kwargs):
            self.calls.append(("POST", url, kwargs))
            return Response()

        def get(self, url, **kwargs):
            self.calls.append(("GET", url, kwargs))
            return Response(
                {
                    "data": [
                        {
                            "courseReferenceNumber": "10001",
                            "enrollment": 20,
                            "maximumEnrollment": 25,
                        },
                        {
                            "courseReferenceNumber": "10002",
                            "enrollment": 22,
                            "maximumEnrollment": 30,
                        },
                    ]
                }
            )

    session = Session()
    result = app._fetch_banner_enrollment(
        session,
        "CSCE 145",
        "202501",
        ["10001", "10002"],
    )

    assert result == {"enrollment": 42, "capacity": 55, "enrollment_sections": 2}
    assert [call[0] for call in session.calls] == ["POST", "GET"]
    assert session.calls[1][2]["params"]["txt_courseNumber"] == "145"
    assert writes[0][0][2] == app.HISTORY_CACHE_TTL


def test_concurrent_proxy_requests_share_one_upstream_call(monkeypatch):
    calls = []
    monkeypatch.setattr(app.cache, "get", lambda _key: None)
    monkeypatch.setattr(app.cache, "put", lambda *_args, **_kwargs: None)

    def urlopen(*_args, **_kwargs):
        calls.append(True)
        time.sleep(0.05)
        return _Response(b'{"results":["shared"]}')

    monkeypatch.setattr(app.urllib.request, "urlopen", urlopen)
    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(
            executor.map(
                lambda _index: app.proxy_request("https://example.test/search", b"{}"),
                range(2),
            )
        )

    assert responses == [b'{"results":["shared"]}'] * 2
    assert len(calls) == 1


def test_history_progress_reports_completed_terms_and_section_details(monkeypatch):
    events = []
    monkeypatch.setattr(app, "TERM_CODES", ["202401", "202405", "202408"])
    monkeypatch.setattr(app.offering_analyzer, "current_academic_term", lambda: "202408")
    monkeypatch.setattr(app.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(app.cache, "get", lambda _key: None)
    monkeypatch.setattr(app.cache, "put", lambda *_args, **_kwargs: None)

    def proxy_request(url, body, ttl):
        assert ttl == app.HISTORY_CACHE_TTL
        payload = json.loads(body)
        if url.endswith("details"):
            return b'{"seats":"<span class=\\"seats_max\\">30</span><span class=\\"seats_avail\\">5</span>"}'
        if payload["other"]["srcdb"] == "202401":
            return json.dumps(
                {
                    "results": [
                        {"code": "CSCE 145", "crn": "10001"},
                        {"code": "CSCE 145", "crn": "10002"},
                    ]
                }
            ).encode()
        return b'{"results":[]}'

    monkeypatch.setattr(app, "proxy_request", proxy_request)

    result = json.loads(app.handle_history(b'{"code":"CSCE 145"}', progress=events.append))

    assert result["total_terms"] == 2
    assert [event["completed"] for event in events] == [0, 0, 0, 1, 1, 2]
    assert [event["completed"] for event in events] == sorted(
        event["completed"] for event in events
    )
    assert events[0] == {
        "type": "progress",
        "phase": "terms",
        "completed": 0,
        "total": 2,
        "term": "202401",
        "label": "Spring 2024",
    }
    assert [event for event in events if event["phase"] == "enrollment"] == [
        {
            "type": "progress",
            "phase": "enrollment",
            "completed": 0,
            "total": 2,
            "term": "202401",
            "label": "Spring 2024",
            "section": 1,
            "section_total": 2,
        },
        {
            "type": "progress",
            "phase": "enrollment",
            "completed": 0,
            "total": 2,
            "term": "202401",
            "label": "Spring 2024",
            "section": 2,
            "section_total": 2,
        },
    ]
    assert events[-1]["completed"] == events[-1]["total"] == 2


def test_history_cache_hit_emits_no_progress(monkeypatch):
    cached = b'{"code":"CSCE 145","complete":true,"terms":[]}'
    monkeypatch.setattr(app, "TERM_CODES", ["202401", "202405"])
    monkeypatch.setattr(app.offering_analyzer, "current_academic_term", lambda: "202405")
    monkeypatch.setattr(app.cache, "get", lambda _key: cached)
    monkeypatch.setattr(
        app,
        "proxy_request",
        lambda *_args, **_kwargs: pytest.fail("cache hit should not call upstream"),
    )
    events = []

    result = app.handle_history(b'{"code":"CSCE 145"}', progress=events.append)

    assert result == cached
    assert events == []


def test_unexpected_history_error_is_structured_and_releases_waiters(monkeypatch):
    started = app.threading.Event()
    release = app.threading.Event()
    monkeypatch.setattr(app, "TERM_CODES", ["202401", "202405"])
    monkeypatch.setattr(app.offering_analyzer, "current_academic_term", lambda: "202405")
    monkeypatch.setattr(app.cache, "get", lambda _key: None)

    def fail_build(*_args, **_kwargs):
        started.set()
        release.wait(timeout=1)
        raise RuntimeError("unexpected failure")

    monkeypatch.setattr(app, "_build_history", fail_build)

    with ThreadPoolExecutor(max_workers=2) as executor:
        owner = executor.submit(app.handle_history, b'{"code":"CSCE 145"}')
        assert started.wait(timeout=1)
        waiter = executor.submit(app.handle_history, b'{"code":"CSCE 145"}')
        time.sleep(0.02)
        release.set()
        responses = [json.loads(owner.result()), json.loads(waiter.result())]

    assert responses[0] == responses[1]
    assert responses[0] == {
        "error": "offering history unavailable",
        "code": "CSCE 145",
        "as_of_term": "202405",
        "complete": False,
        "total_terms": 1,
        "terms": [],
    }
    assert app._INFLIGHT == {}


def test_static_cache_policy_keeps_shell_fresh_and_heavy_data_long_lived():
    def static_path(relative):
        return str(app.STATIC_DIR + "/" + relative)

    assert app._static_cache_control(static_path("index.html")) == "no-cache"
    assert app._static_cache_control(static_path("js/search.js")) == (
        "public, max-age=300, must-revalidate"
    )
    assert app._static_cache_control(static_path("css/style.css")) == (
        "public, max-age=300, must-revalidate"
    )
    assert app._static_cache_control(static_path("data/site_notices.json")) == "no-cache"
    assert app._static_cache_control(static_path("data/course_embeddings.json")) == (
        "public, max-age=2592000, immutable"
    )


def test_failed_term_still_advances_loading_progress(monkeypatch):
    events = []
    monkeypatch.setattr(app, "TERM_CODES", ["202401", "202405"])
    monkeypatch.setattr(app.offering_analyzer, "current_academic_term", lambda: "202405")
    monkeypatch.setattr(app.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(app.cache, "get", lambda _key: None)
    monkeypatch.setattr(app.cache, "put", lambda *_args, **_kwargs: None)

    def proxy_request(url, _body, ttl):
        assert ttl == app.HISTORY_CACHE_TTL
        if url.endswith("search"):
            return b'{"results":[{"code":"CSCE 145","crn":"10001"}]}'
        return b'{"error":"temporary failure"}'

    monkeypatch.setattr(app, "proxy_request", proxy_request)

    result = json.loads(app.handle_history(b'{"code":"CSCE 145"}', progress=events.append))

    assert result["complete"] is False
    assert events
    assert events[-1]["completed"] == events[-1]["total"] == 1


@pytest.mark.parametrize("failure_at", ["search", "details"])
def test_partial_history_is_returned_but_not_cached(monkeypatch, failure_at):
    writes = []
    calls = []
    monkeypatch.setattr(app, "TERM_CODES", ["202401", "202405"])
    monkeypatch.setattr(app.offering_analyzer, "current_academic_term", lambda: "202405")
    monkeypatch.setattr(app.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(app.cache, "get", lambda _key: None)
    monkeypatch.setattr(app.cache, "put", lambda *args, **kwargs: writes.append((args, kwargs)))

    def proxy_request(url, _body, ttl):
        calls.append((url, ttl))
        if url.endswith("search"):
            if failure_at == "search":
                return b'{"error":"temporary failure"}'
            return b'{"results":[{"code":"CSCE 145","crn":"12345"}]}'
        return b'{"error":"temporary failure"}'

    monkeypatch.setattr(app, "proxy_request", proxy_request)

    first = json.loads(app.handle_history(b'{"code":"CSCE 145"}'))
    second = json.loads(app.handle_history(b'{"code":"CSCE 145"}'))

    assert first == second
    assert first["complete"] is False
    assert writes == []
    assert len(calls) == (2 if failure_at == "search" else 4)
    term = first["terms"][0]
    if failure_at == "search":
        assert term["available"] is False
        assert term["error"] is True
        assert "offered" not in term
    else:
        assert term["offered"] is True
        assert term["complete"] is True
        assert term["enrollment_error"] is True


@pytest.mark.parametrize("path", ["/api/search", "/api/details"])
@pytest.mark.parametrize(
    ("refresh_header", "expected_refresh"),
    [(None, False), ("0", False), ("1", True)],
)
def test_live_search_and_details_keep_five_minute_ttl(
    monkeypatch,
    path,
    refresh_header,
    expected_refresh,
):
    calls = []
    handler = app.Handler.__new__(app.Handler)
    handler.path = path
    handler.headers = {}
    if refresh_header is not None:
        handler.headers["X-UofSC-Refresh-Live"] = refresh_header
    handler._read_body = lambda: b"{}"
    handler._send_json = lambda *_args, **_kwargs: None

    def proxy_request(url, body, ttl, force_refresh=False):
        calls.append((url, body, ttl, force_refresh))
        return b"{}"

    monkeypatch.setattr(
        app,
        "proxy_request",
        proxy_request,
    )

    handler.do_POST()

    assert len(calls) == 1
    assert calls[0][2] == app.LIVE_CACHE_TTL == 300
    assert calls[0][3] is expected_refresh


def test_history_route_ignores_live_refresh_header(monkeypatch):
    calls = []
    responses = []
    handler = app.Handler.__new__(app.Handler)
    handler.path = "/api/history"
    handler.headers = {"X-UofSC-Refresh-Live": "1"}
    handler._read_body = lambda: b'{"code":"CSCE 145"}'
    handler._send_json = lambda data, *_args, **_kwargs: responses.append(data)
    monkeypatch.setattr(
        app,
        "handle_history",
        lambda body: calls.append(body) or b'{"complete":true}',
    )

    handler.do_POST()

    assert calls == [b'{"code":"CSCE 145"}']
    assert responses == [b'{"complete":true}']


class _StreamWriter:
    def __init__(self, fail_after=None):
        self.chunks = []
        self.fail_after = fail_after
        self.flushes = 0

    def write(self, data):
        if self.fail_after is not None and len(self.chunks) >= self.fail_after:
            raise BrokenPipeError("client disconnected")
        self.chunks.append(data)

    def flush(self):
        self.flushes += 1


def _history_stream_handler(writer):
    handler = app.Handler.__new__(app.Handler)
    handler.path = "/api/history-stream"
    handler.headers = {}
    handler._read_body = lambda: b'{"code":"CSCE 145"}'
    handler.wfile = writer
    handler.statuses = []
    handler.response_headers = []
    handler.send_response = handler.statuses.append
    handler.send_header = lambda key, value: handler.response_headers.append((key, value))
    handler.end_headers = lambda: None
    return handler


def test_history_stream_route_ends_with_exactly_one_result_event(monkeypatch):
    writer = _StreamWriter()
    handler = _history_stream_handler(writer)

    def handle_history(body, progress=None):
        assert body == b'{"code":"CSCE 145"}'
        assert progress is not None
        progress(
            {
                "type": "progress",
                "phase": "terms",
                "completed": 1,
                "total": 2,
                "term": "202401",
                "label": "Spring 2024",
            }
        )
        return b'{"code":"CSCE 145","complete":true,"terms":[]}'

    monkeypatch.setattr(app, "handle_history", handle_history)

    handler.do_POST()

    events = [json.loads(chunk) for chunk in writer.chunks]
    assert handler.statuses == [200]
    assert ("Content-Type", "application/x-ndjson") in handler.response_headers
    assert writer.flushes == len(events)
    assert events[-1] == {
        "type": "result",
        "data": {"code": "CSCE 145", "complete": True, "terms": []},
    }
    assert sum(event["type"] == "result" for event in events) == 1


def test_history_stream_disconnect_does_not_interrupt_history_work(monkeypatch):
    writer = _StreamWriter(fail_after=1)
    handler = _history_stream_handler(writer)
    work_finished = []

    def handle_history(_body, progress=None):
        assert progress is not None
        event = {
            "type": "progress",
            "phase": "terms",
            "completed": 0,
            "total": 1,
            "term": "202401",
            "label": "Spring 2024",
        }
        progress(event)
        progress({**event, "completed": 1})
        work_finished.append(True)
        return b'{"complete":true}'

    monkeypatch.setattr(app, "handle_history", handle_history)

    handler.do_POST()

    assert work_finished == [True]
    assert len(writer.chunks) == 1

import json

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


def test_history_cache_uses_completed_terms_and_thirty_day_ttl(monkeypatch):
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
    assert len(writes) == 1
    assert writes[0][2] == 2_592_000


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
        "course-history-v2",
        {
            "version": 2,
            "code": "CSCE 145",
            "as_of_term": "202405",
            "terms": ["202401"],
        },
    )
    assert calls[1][1]["terms"] == ["202401", "202405"]


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

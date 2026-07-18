from __future__ import annotations

import json
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

import pytest
import requests

from scripts.pull_banner_term_sections import (
    BannerPullError,
    PAGE_SIZE,
    SECTION_FIELDS,
    PullResult,
    fetch_term_envelope,
    load_complete_envelope,
    pull_terms,
)


class FakeResponse:
    def __init__(self, payload: Any = None, *, error: Exception | None = None):
        self.payload = payload
        self.error = error

    def raise_for_status(self) -> None:
        if self.error:
            raise self.error

    def json(self) -> Any:
        return self.payload


def banner_row(index: int, *, campus: str = "USC Columbia") -> dict[str, Any]:
    return {
        "subject": "csce",
        "courseNumber": str(100 + index),
        "courseTitle": f" Course {index} ",
        "enrollment": str(index % 30),
        "maximumEnrollment": 30,
        "courseReferenceNumber": str(10_000 + index),
        "campusDescription": campus,
        "sequenceNumber": "001",
        "faculty": [{"displayName": "Private, Person"}],
        # Banner can report a separate instructional site inside meeting metadata.
        # The section-level campus is authoritative for the campus-filtered result.
        "meetingsFaculty": [
            {
                "meetingTime": {
                    "campus": "LAN",
                    "campusDescription": "USC Lancaster",
                }
            }
        ],
    }


class FakeSession:
    def __init__(self, pages: dict[int, Any]):
        self.pages = {
            offset: deque(value if isinstance(value, list) else [value])
            for offset, value in pages.items()
        }
        self.headers: dict[str, str] = {}
        self.posts: list[tuple[str, dict[str, Any]]] = []
        self.gets: list[tuple[str, dict[str, Any]]] = []
        self.closed = False

    def post(self, url: str, **kwargs: Any) -> FakeResponse:
        self.posts.append((url, kwargs))
        return FakeResponse({"fwdURL": "/classSearch/classSearch"})

    def get(self, url: str, **kwargs: Any) -> FakeResponse:
        self.gets.append((url, kwargs))
        value = self.pages[kwargs["params"]["pageOffset"]].popleft()
        if isinstance(value, Exception):
            raise value
        return FakeResponse(value)

    def close(self) -> None:
        self.closed = True


def page(total: int, rows: list[dict[str, Any]], *, offset: int = 0) -> dict[str, Any]:
    return {
        "success": True,
        "totalCount": total,
        "pageOffset": offset,
        "pageMaxSize": PAGE_SIZE,
        "sectionsFetchedCount": total,
        "data": rows,
    }


def test_fetches_all_pages_in_one_term_session_and_keeps_only_history_fields() -> None:
    rows = [banner_row(index) for index in range(PAGE_SIZE + 1)]
    session = FakeSession(
        {
            0: page(len(rows), rows[:PAGE_SIZE]),
            PAGE_SIZE: page(len(rows), rows[PAGE_SIZE:], offset=PAGE_SIZE),
        }
    )
    factory_calls = []

    def factory() -> FakeSession:
        factory_calls.append(True)
        return session

    envelope = fetch_term_envelope("202408", session_factory=factory, sleep=lambda _: None)

    assert len(factory_calls) == 1
    assert session.closed is True
    assert session.posts[0][1]["data"]["mepCode"] == "COL"
    assert [call[1]["params"]["pageOffset"] for call in session.gets] == [0, PAGE_SIZE]
    assert all(call[1]["params"]["pageMaxSize"] == 500 for call in session.gets)
    assert all(call[1]["params"]["txt_campus"] == "COL" for call in session.gets)
    assert envelope["term"] == "202408"
    assert envelope["complete"] is True
    assert envelope["campus"] == "COL"
    assert len(envelope["sections"]) == PAGE_SIZE + 1
    assert set(envelope["sections"][0]) == set(SECTION_FIELDS)
    assert envelope["sections"][0] == {
        "subject": "CSCE",
        "courseNumber": "100",
        "courseTitle": "Course 0",
        "enrollment": 0,
        "maximumEnrollment": 30,
        "courseReferenceNumber": "10000",
    }


def test_page_request_retries_with_exponential_backoff() -> None:
    session = FakeSession(
        {
            0: [
                requests.ConnectionError("temporary"),
                page(1, [banner_row(0)]),
            ]
        }
    )
    delays = []

    envelope = fetch_term_envelope(
        "202401",
        retries=2,
        backoff_seconds=0.25,
        session_factory=lambda: session,
        sleep=delays.append,
    )

    assert len(envelope["sections"]) == 1
    assert delays == [0.25]
    assert len(session.gets) == 2


@pytest.mark.parametrize(
    ("pages", "message"),
    [
        ({0: page(2, [banner_row(0)])}, "returned 1 of 2 rows"),
        (
            {
                0: page(PAGE_SIZE + 1, [banner_row(index) for index in range(PAGE_SIZE)]),
                PAGE_SIZE: page(PAGE_SIZE + 2, [banner_row(PAGE_SIZE)], offset=PAGE_SIZE),
            },
            "totalCount changed",
        ),
    ],
)
def test_rejects_incomplete_or_moving_pagination(pages: dict[int, Any], message: str) -> None:
    session = FakeSession(pages)

    with pytest.raises(BannerPullError) as error:
        fetch_term_envelope(
            "202408", retries=0, session_factory=lambda: session, sleep=lambda _: None
        )

    assert message in str(error.value.__cause__ or error.value)


def test_rejects_rows_from_a_different_campus() -> None:
    session = FakeSession({0: page(1, [banner_row(0, campus="USC Aiken")])})

    with pytest.raises(BannerPullError, match="campus description"):
        fetch_term_envelope(
            "202408", retries=0, session_factory=lambda: session, sleep=lambda _: None
        )


def test_rejects_a_row_from_a_different_term() -> None:
    row = banner_row(0)
    row["term"] = "202401"
    session = FakeSession({0: page(1, [row])})

    with pytest.raises(BannerPullError, match="row for term 202401"):
        fetch_term_envelope(
            "202408", retries=0, session_factory=lambda: session, sleep=lambda _: None
        )


def test_resume_skips_complete_normalized_envelope(tmp_path: Path) -> None:
    output = tmp_path / "terms"
    output.mkdir()
    existing = {
        "term": "202401",
        "complete": True,
        "campus": "COL",
        "sections": [
            {
                "subject": "CSCE",
                "courseNumber": "145",
                "courseTitle": "Algorithmic Design I",
                "enrollment": 20,
                "maximumEnrollment": 25,
                "courseReferenceNumber": "10001",
            }
        ],
    }
    path = output / "202401.json"
    path.write_text(json.dumps(existing), encoding="utf-8")

    def fail_factory() -> FakeSession:
        raise AssertionError("a resumed term must not create a session")

    results = pull_terms(["202401"], output, session_factory=fail_factory)

    assert results == [PullResult(term="202401", path=path, sections=1, resumed=True)]
    assert json.loads(path.read_text(encoding="utf-8")) == existing


def test_resume_rejects_noncanonical_enrollment_values(tmp_path: Path) -> None:
    path = tmp_path / "202401.json"
    path.write_text(
        json.dumps(
            {
                "term": "202401",
                "complete": True,
                "campus": "COL",
                "sections": [
                    {
                        "subject": "CSCE",
                        "courseNumber": "145",
                        "courseTitle": "Algorithmic Design I",
                        "enrollment": "20",
                        "maximumEnrollment": 25,
                        "courseReferenceNumber": "10001",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(BannerPullError, match="non-normalized enrollment"):
        load_complete_envelope(path, term="202401", campus="COL")


def test_pull_terms_limits_parallel_term_sessions_to_two(tmp_path: Path) -> None:
    lock = threading.Lock()
    release = threading.Event()
    active = 0
    peak = 0

    class BlockingSession:
        def __init__(self) -> None:
            self.headers: dict[str, str] = {}

        def post(self, url: str, **kwargs: Any) -> FakeResponse:
            del url, kwargs
            return FakeResponse({})

        def get(self, url: str, **kwargs: Any) -> FakeResponse:
            nonlocal active, peak
            del url, kwargs
            with lock:
                active += 1
                peak = max(peak, active)
                if active == 2:
                    release.set()
            assert release.wait(timeout=2)
            time.sleep(0.02)
            with lock:
                active -= 1
            return FakeResponse(page(0, []))

        def close(self) -> None:
            return None

    results = pull_terms(
        ["202401", "202405", "202408"],
        tmp_path,
        session_factory=BlockingSession,
        sleep=lambda _: None,
    )

    assert peak == 2
    assert [result.term for result in results] == ["202401", "202405", "202408"]
    assert all(result.resumed is False for result in results)
    assert all(json.loads(result.path.read_text())["complete"] is True for result in results)

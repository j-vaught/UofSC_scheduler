#!/usr/bin/env python3
"""Download complete Banner term snapshots for the offering-history build."""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import sys
import tempfile
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, TypeVar

import requests

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.build_offering_history import TERM_RE, normalize_code
from scripts.static_release import comma_values


BANNER_BASE = "https://banner.onecarolina.sc.edu/StudentRegistrationSsb/ssb"
PAGE_SIZE = 500
DEFAULT_WORKERS = 2
DEFAULT_RETRIES = 3
DEFAULT_BACKOFF_SECONDS = 0.5
DEFAULT_TIMEOUT_SECONDS = 60.0
SECTION_FIELDS = (
    "subject",
    "courseNumber",
    "courseTitle",
    "enrollment",
    "maximumEnrollment",
    "courseReferenceNumber",
)
KNOWN_CAMPUS_DESCRIPTIONS = {
    "COL": frozenset({"COL", "COLUMBIA", "USC COLUMBIA"}),
}


class BannerPullError(RuntimeError):
    """Raised when a term cannot be proven complete and campus-correct."""


class ResponseLike(Protocol):
    def raise_for_status(self) -> None: ...

    def json(self) -> Any: ...


class SessionLike(Protocol):
    headers: Any

    def post(self, url: str, **kwargs: Any) -> ResponseLike: ...

    def get(self, url: str, **kwargs: Any) -> ResponseLike: ...

    def close(self) -> None: ...


@dataclass(frozen=True)
class PullResult:
    """The destination and disposition of one requested term."""

    term: str
    path: Path
    sections: int
    resumed: bool


T = TypeVar("T")


def _validate_term(term: str) -> str:
    normalized = str(term).strip()
    if not TERM_RE.fullmatch(normalized):
        raise ValueError(f"Invalid academic term code: {term!r}")
    return normalized


def _validate_campus(campus: str) -> str:
    normalized = normalize_code(campus)
    if not normalized:
        raise ValueError("Campus code is required")
    if normalized not in KNOWN_CAMPUS_DESCRIPTIONS:
        raise ValueError(f"Unsupported campus code: {campus!r}")
    return normalized


def _retry(
    operation: Callable[[], T],
    *,
    label: str,
    retries: int,
    backoff_seconds: float,
    sleep: Callable[[float], None],
) -> T:
    if retries < 0:
        raise ValueError("retries must be zero or greater")
    if backoff_seconds < 0:
        raise ValueError("backoff_seconds must be zero or greater")
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        try:
            return operation()
        except (requests.RequestException, ValueError, BannerPullError) as error:
            last_error = error
            if attempt == retries:
                break
            sleep(backoff_seconds * (2**attempt))
    raise BannerPullError(f"{label} failed after {retries + 1} attempts") from last_error


def _response_json(response: ResponseLike) -> dict[str, Any]:
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        raise BannerPullError("Banner returned a non-object JSON response")
    return payload


def _parse_count(value: Any, *, field: str) -> int:
    if isinstance(value, bool):
        raise BannerPullError(f"Banner {field} must be a non-negative integer")
    try:
        count = int(value)
    except (TypeError, ValueError) as error:
        raise BannerPullError(f"Banner {field} must be a non-negative integer") from error
    if count < 0 or str(value).strip() not in {str(count), f"{count}.0"}:
        raise BannerPullError(f"Banner {field} must be a non-negative integer")
    return count


def _parse_page(
    payload: Mapping[str, Any],
    *,
    term: str,
    offset: int,
    expected_total: int | None,
) -> tuple[int, list[dict[str, Any]]]:
    if payload.get("success") is not True:
        raise BannerPullError(f"Banner reported an unsuccessful response for term {term}")
    total = _parse_count(payload.get("totalCount"), field="totalCount")
    response_offset = _parse_count(payload.get("pageOffset"), field="pageOffset")
    response_page_size = _parse_count(payload.get("pageMaxSize"), field="pageMaxSize")
    if response_offset != offset:
        raise BannerPullError(
            f"Term {term} returned page offset {response_offset}; expected {offset}"
        )
    if response_page_size != PAGE_SIZE:
        raise BannerPullError(
            f"Term {term} returned page size {response_page_size}; expected {PAGE_SIZE}"
        )
    if expected_total is not None and total != expected_total:
        raise BannerPullError(
            f"Term {term} totalCount changed from {expected_total} to {total} during download"
        )
    data = payload.get("data")
    if not isinstance(data, list) or any(not isinstance(row, dict) for row in data):
        raise BannerPullError(f"Term {term} page at offset {offset} has invalid data")
    expected_rows = min(PAGE_SIZE, max(0, total - offset))
    if len(data) != expected_rows:
        raise BannerPullError(
            f"Term {term} page at offset {offset} returned {len(data)} of {expected_rows} rows"
        )
    fetched_count = payload.get("sectionsFetchedCount")
    if (
        fetched_count is not None
        and _parse_count(fetched_count, field="sectionsFetchedCount") != total
    ):
        raise BannerPullError(f"Term {term} sectionsFetchedCount does not match totalCount {total}")
    return total, data


def _request_page(
    session: SessionLike,
    term: str,
    offset: int,
    *,
    campus: str,
    expected_total: int | None,
    retries: int,
    backoff_seconds: float,
    timeout_seconds: float,
    sleep: Callable[[float], None],
) -> tuple[int, list[dict[str, Any]]]:
    def request() -> tuple[int, list[dict[str, Any]]]:
        response = session.get(
            f"{BANNER_BASE}/searchResults/searchResults",
            params={
                "txt_term": term,
                "txt_campus": campus,
                "pageOffset": offset,
                "pageMaxSize": PAGE_SIZE,
            },
            timeout=timeout_seconds,
        )
        return _parse_page(
            _response_json(response),
            term=term,
            offset=offset,
            expected_total=expected_total,
        )

    return _retry(
        request,
        label=f"Term {term} page at offset {offset}",
        retries=retries,
        backoff_seconds=backoff_seconds,
        sleep=sleep,
    )


def _establish_term(
    session: SessionLike,
    term: str,
    campus: str,
    *,
    retries: int,
    backoff_seconds: float,
    timeout_seconds: float,
    sleep: Callable[[float], None],
) -> None:
    def request() -> None:
        response = session.post(
            f"{BANNER_BASE}/term/search?mode=search",
            data={
                "term": term,
                "studyPath": "",
                "studyPathText": "",
                "startDatepicker": "",
                "endDatepicker": "",
                "mepCode": campus,
            },
            timeout=timeout_seconds,
        )
        response.raise_for_status()

    _retry(
        request,
        label=f"Term {term} session setup",
        retries=retries,
        backoff_seconds=backoff_seconds,
        sleep=sleep,
    )


def _row_campus_values(row: Mapping[str, Any]) -> tuple[set[str], set[str]]:
    codes = {
        normalize_code(row.get(key))
        for key in ("campus", "campusCode")
        if normalize_code(row.get(key))
    }
    descriptions = {
        normalize_code(row.get(key))
        for key in ("campusDescription",)
        if normalize_code(row.get(key))
    }
    return codes, descriptions


def _validate_row_campus(row: Mapping[str, Any], *, campus: str, term: str) -> None:
    codes, descriptions = _row_campus_values(row)
    if codes and codes != {campus}:
        raise BannerPullError(
            f"Term {term} contains campus code(s) {', '.join(sorted(codes))}; expected {campus}"
        )
    known_descriptions = KNOWN_CAMPUS_DESCRIPTIONS.get(campus)
    if known_descriptions and descriptions and not descriptions <= known_descriptions:
        raise BannerPullError(
            f"Term {term} contains campus description(s) "
            f"{', '.join(sorted(descriptions))}; expected {campus}"
        )
    if not codes and not descriptions:
        raise BannerPullError(f"Term {term} contains a row with no campus information")
    if not codes and known_descriptions and not descriptions <= known_descriptions:
        raise BannerPullError(f"Term {term} contains a row outside campus {campus}")


def _required_text(row: Mapping[str, Any], key: str, *, term: str) -> str:
    value = str(row.get(key) or "").strip()
    if not value:
        raise BannerPullError(f"Term {term} contains a row without {key}")
    return value


def _optional_nonnegative_int(value: Any, *, field: str, term: str) -> int | None:
    if value in (None, ""):
        return None
    if isinstance(value, bool):
        raise BannerPullError(f"Term {term} has invalid {field}: {value!r}")
    try:
        number = int(value)
    except (TypeError, ValueError) as error:
        raise BannerPullError(f"Term {term} has invalid {field}: {value!r}") from error
    if number < 0 or str(value).strip() not in {str(number), f"{number}.0"}:
        raise BannerPullError(f"Term {term} has invalid {field}: {value!r}")
    return number


def normalize_section(row: Mapping[str, Any], *, term: str, campus: str) -> dict[str, Any]:
    """Keep only fields consumed by the offering-history builder."""
    _validate_row_campus(row, campus=campus, term=term)
    row_term = str(row.get("term") or "").strip()
    if row_term and row_term != term:
        raise BannerPullError(f"Term {term} contains a row for term {row_term}")
    return {
        "subject": normalize_code(_required_text(row, "subject", term=term)),
        "courseNumber": _required_text(row, "courseNumber", term=term),
        "courseTitle": str(row.get("courseTitle") or "").strip(),
        "enrollment": _optional_nonnegative_int(
            row.get("enrollment"), field="enrollment", term=term
        ),
        "maximumEnrollment": _optional_nonnegative_int(
            row.get("maximumEnrollment"), field="maximumEnrollment", term=term
        ),
        "courseReferenceNumber": _required_text(row, "courseReferenceNumber", term=term),
    }


def fetch_term_envelope(
    term: str,
    *,
    campus: str = "COL",
    retries: int = DEFAULT_RETRIES,
    backoff_seconds: float = DEFAULT_BACKOFF_SECONDS,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    session_factory: Callable[[], SessionLike] = requests.Session,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    """Fetch and validate every result page for one completed academic term."""
    normalized_term = _validate_term(term)
    normalized_campus = _validate_campus(campus)
    session = session_factory()
    try:
        headers = getattr(session, "headers", None)
        if headers is not None and hasattr(headers, "update"):
            headers.update({"User-Agent": "Mozilla/5.0 UofSC-Scheduler-Data/1.0"})
        _establish_term(
            session,
            normalized_term,
            normalized_campus,
            retries=retries,
            backoff_seconds=backoff_seconds,
            timeout_seconds=timeout_seconds,
            sleep=sleep,
        )
        total, first_rows = _request_page(
            session,
            normalized_term,
            0,
            campus=normalized_campus,
            expected_total=None,
            retries=retries,
            backoff_seconds=backoff_seconds,
            timeout_seconds=timeout_seconds,
            sleep=sleep,
        )
        rows = list(first_rows)
        for offset in range(PAGE_SIZE, total, PAGE_SIZE):
            _, page_rows = _request_page(
                session,
                normalized_term,
                offset,
                campus=normalized_campus,
                expected_total=total,
                retries=retries,
                backoff_seconds=backoff_seconds,
                timeout_seconds=timeout_seconds,
                sleep=sleep,
            )
            rows.extend(page_rows)
    finally:
        session.close()

    if len(rows) != total:
        raise BannerPullError(
            f"Term {normalized_term} returned {len(rows)} rows but declared {total}"
        )
    sections = [
        normalize_section(row, term=normalized_term, campus=normalized_campus) for row in rows
    ]
    crns = [section["courseReferenceNumber"] for section in sections]
    if len(set(crns)) != total:
        raise BannerPullError(
            f"Term {normalized_term} contains duplicate courseReferenceNumber values"
        )
    return {
        "term": normalized_term,
        "complete": True,
        "campus": normalized_campus,
        "sections": sections,
    }


def _validate_normalized_envelope(
    payload: Any,
    *,
    term: str,
    campus: str,
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise BannerPullError(f"Saved term {term} is not a JSON object")
    if str(payload.get("term") or "") != term:
        raise BannerPullError(f"Saved term file for {term} declares {payload.get('term')!r}")
    saved_campus = _validate_campus(str(payload.get("campus") or ""))
    if saved_campus != campus:
        raise BannerPullError(f"Saved term {term} is for campus {saved_campus}, expected {campus}")
    if payload.get("complete") is not True:
        raise BannerPullError(f"Saved term {term} is not declared complete")
    sections = payload.get("sections")
    if not isinstance(sections, list):
        raise BannerPullError(f"Saved term {term} sections must be a list")
    expected_fields = set(SECTION_FIELDS)
    crns: set[str] = set()
    for index, section in enumerate(sections):
        if not isinstance(section, dict) or set(section) != expected_fields:
            raise BannerPullError(f"Saved term {term} section {index} is not a normalized section")
        subject = normalize_code(section.get("subject"))
        course_number = str(section.get("courseNumber") or "").strip()
        title = str(section.get("courseTitle") or "").strip()
        crn = str(section.get("courseReferenceNumber") or "").strip()
        if (
            not subject
            or subject != section.get("subject")
            or not course_number
            or course_number != section.get("courseNumber")
            or title != section.get("courseTitle")
            or not crn
            or crn != section.get("courseReferenceNumber")
        ):
            raise BannerPullError(f"Saved term {term} section {index} is not normalized")
        for field in ("enrollment", "maximumEnrollment"):
            value = section.get(field)
            if value is not None and (
                isinstance(value, bool) or not isinstance(value, int) or value < 0
            ):
                raise BannerPullError(
                    f"Saved term {term} section {index} has non-normalized {field}"
                )
        if crn in crns:
            raise BannerPullError(f"Saved term {term} contains duplicate CRN {crn}")
        crns.add(crn)
    return payload


def load_complete_envelope(path: Path, *, term: str, campus: str) -> dict[str, Any] | None:
    """Return a resumable complete envelope, or None for an absent/incomplete file."""
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if isinstance(payload, dict) and payload.get("complete") is not True:
        return None
    return _validate_normalized_envelope(payload, term=term, campus=campus)


def write_envelope_atomic(path: Path, envelope: Mapping[str, Any]) -> None:
    """Write a complete term only after validation and an atomic replacement."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(envelope, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def pull_terms(
    terms: Iterable[str],
    output_dir: Path,
    *,
    campus: str = "COL",
    workers: int = DEFAULT_WORKERS,
    retries: int = DEFAULT_RETRIES,
    backoff_seconds: float = DEFAULT_BACKOFF_SECONDS,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    force: bool = False,
    session_factory: Callable[[], SessionLike] = requests.Session,
    sleep: Callable[[float], None] = time.sleep,
) -> list[PullResult]:
    """Pull terms concurrently while keeping each term inside one session."""
    normalized_terms = sorted({_validate_term(term) for term in terms})
    if not normalized_terms:
        raise ValueError("At least one term is required")
    normalized_campus = _validate_campus(campus)
    if workers < 1:
        raise ValueError("workers must be at least one")
    output_dir.mkdir(parents=True, exist_ok=True)

    results: dict[str, PullResult] = {}
    pending: list[str] = []
    for term in normalized_terms:
        path = output_dir / f"{term}.json"
        envelope = (
            None if force else load_complete_envelope(path, term=term, campus=normalized_campus)
        )
        if envelope is None:
            pending.append(term)
            continue
        results[term] = PullResult(
            term=term,
            path=path,
            sections=len(envelope["sections"]),
            resumed=True,
        )

    def pull(term: str) -> PullResult:
        envelope = fetch_term_envelope(
            term,
            campus=normalized_campus,
            retries=retries,
            backoff_seconds=backoff_seconds,
            timeout_seconds=timeout_seconds,
            session_factory=session_factory,
            sleep=sleep,
        )
        path = output_dir / f"{term}.json"
        write_envelope_atomic(path, envelope)
        return PullResult(
            term=term,
            path=path,
            sections=len(envelope["sections"]),
            resumed=False,
        )

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        future_terms = {executor.submit(pull, term): term for term in pending}
        for future in concurrent.futures.as_completed(future_terms):
            term = future_terms[future]
            try:
                results[term] = future.result()
            except Exception as error:
                for other in future_terms:
                    other.cancel()
                raise BannerPullError(f"Unable to complete term {term}") from error
    return [results[term] for term in normalized_terms]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--term",
        "--terms",
        action="append",
        required=True,
        help="Completed term code; repeat or separate values with commas or spaces.",
    )
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--campus", default="COL")
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
    parser.add_argument("--retries", type=int, default=DEFAULT_RETRIES)
    parser.add_argument("--backoff-seconds", type=float, default=DEFAULT_BACKOFF_SECONDS)
    parser.add_argument("--timeout-seconds", type=float, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    results = pull_terms(
        comma_values(args.term),
        args.output_dir,
        campus=args.campus,
        workers=args.workers,
        retries=args.retries,
        backoff_seconds=args.backoff_seconds,
        timeout_seconds=args.timeout_seconds,
        force=args.force,
    )
    for result in results:
        disposition = "resumed" if result.resumed else "downloaded"
        print(
            f"{result.term}: {disposition} {result.sections} sections -> {result.path}",
            flush=True,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())

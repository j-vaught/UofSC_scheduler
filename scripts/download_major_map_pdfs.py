#!/usr/bin/env python3
"""Download and verify every official major-map PDF referenced by imported data."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import tempfile
import threading
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterable

import requests


DEFAULT_INPUT_DIR = Path("data/curated/major_maps")
DEFAULT_OUTPUT_DIR = Path("data/raw/major_map_pdfs")
USER_AGENT = "USC-Course-Scheduler-Major-Map-Archive/1.0"
_THREAD_LOCAL = threading.local()


@dataclass(frozen=True)
class MapSource:
    map_id: str
    catalog_year: str
    major: str
    program: str
    concentration: str | None
    source_url: str
    expected_sha256: str | None
    expected_page_count: int | None

    @property
    def relative_path(self) -> Path:
        return Path(self.catalog_year) / f"{self.map_id}.pdf"


def _first_text(*values: object) -> str | None:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def discover_sources(input_dir: Path, years: set[str] | None = None) -> list[MapSource]:
    """Read the imported map inventory and return deterministic source records."""
    records: list[MapSource] = []
    for path in sorted(input_dir.glob("*/*.json")):
        payload = json.loads(path.read_text(encoding="utf-8"))
        catalog_year = str(payload.get("catalog_year") or path.parent.name)
        if years and catalog_year not in years:
            continue
        source = payload.get("source") or {}
        sources = payload.get("sources") or {}
        source_url = _first_text(
            source.get("url"), sources.get("pdf_url"), payload.get("source_url")
        )
        if not source_url:
            continue
        concentrations = payload.get("concentrations") or {}
        concentration = _first_text(
            payload.get("concentration"),
            concentrations.get("selected") if isinstance(concentrations, dict) else None,
        )
        records.append(
            MapSource(
                map_id=str(payload["id"]),
                catalog_year=catalog_year,
                major=str(payload.get("major") or ""),
                program=str(payload.get("program") or ""),
                concentration=concentration,
                source_url=source_url,
                expected_sha256=_first_text(source.get("sha256")),
                expected_page_count=(
                    int(source["page_count"]) if source.get("page_count") is not None else None
                ),
            )
        )
    return records


def _session() -> requests.Session:
    session = getattr(_THREAD_LOCAL, "session", None)
    if session is None:
        session = requests.Session()
        session.headers["User-Agent"] = USER_AGENT
        _THREAD_LOCAL.session = session
    return session


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _validate_pdf(data: bytes) -> None:
    if not data.startswith(b"%PDF-"):
        raise ValueError("response is not a PDF")
    if b"%%EOF" not in data[-4096:]:
        raise ValueError("PDF does not contain a trailing EOF marker")


def _page_count(path: Path) -> int | None:
    try:
        process = subprocess.run(
            ["pdfinfo", str(path)],
            check=False,
            capture_output=True,
            text=True,
            timeout=20,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if process.returncode != 0:
        return None
    for line in process.stdout.splitlines():
        if line.startswith("Pages:"):
            return int(line.split(":", 1)[1].strip())
    return None


def _write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        handle.write(data)
        temporary = Path(handle.name)
    os.replace(temporary, path)


def _download_url(url: str, timeout: float) -> bytes:
    response = _session().get(url, timeout=timeout)
    response.raise_for_status()
    data = response.content
    _validate_pdf(data)
    return data


def _archive_url(
    url: str,
    records: list[MapSource],
    output_dir: Path,
    timeout: float,
    force: bool,
) -> list[dict[str, Any]]:
    existing_data: bytes | None = None
    if not force:
        candidate_paths = [output_dir / record.relative_path for record in records]
        for candidate in candidate_paths:
            if not candidate.exists():
                continue
            try:
                data = candidate.read_bytes()
                _validate_pdf(data)
            except (OSError, ValueError):
                continue
            existing_data = data
            break
    data = existing_data if existing_data is not None else _download_url(url, timeout)
    digest = _sha256(data)
    entries: list[dict[str, Any]] = []
    for record in records:
        destination = output_dir / record.relative_path
        if force or not destination.exists() or _sha256(destination.read_bytes()) != digest:
            _write_atomic(destination, data)
        actual_page_count = _page_count(destination)
        entries.append(
            {
                "map_id": record.map_id,
                "catalog_year": record.catalog_year,
                "major": record.major,
                "program": record.program,
                "concentration": record.concentration,
                "source_url": record.source_url,
                "local_path": destination.as_posix(),
                "sha256": digest,
                "byte_size": len(data),
                "page_count": actual_page_count,
                "expected_sha256": record.expected_sha256,
                "matches_imported_hash": (
                    record.expected_sha256 is None or record.expected_sha256 == digest
                ),
                "expected_page_count": record.expected_page_count,
                "matches_imported_page_count": (
                    record.expected_page_count is None
                    or actual_page_count is None
                    or record.expected_page_count == actual_page_count
                ),
            }
        )
    return entries


def archive_sources(
    records: Iterable[MapSource],
    output_dir: Path,
    *,
    workers: int,
    timeout: float,
    force: bool,
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """Download unique URLs concurrently and materialize one verified PDF per map."""
    grouped: dict[str, list[MapSource]] = defaultdict(list)
    for record in records:
        grouped[record.source_url].append(record)
    archived: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        future_to_url = {
            pool.submit(_archive_url, url, grouped[url], output_dir, timeout, force): url
            for url in sorted(grouped)
        }
        for future in as_completed(future_to_url):
            url = future_to_url[future]
            try:
                archived.extend(future.result())
            except (OSError, ValueError, requests.RequestException) as error:
                for record in grouped[url]:
                    failures.append(
                        {
                            "map_id": record.map_id,
                            "catalog_year": record.catalog_year,
                            "source_url": url,
                            "error": str(error),
                        }
                    )
    return sorted(archived, key=lambda item: (item["catalog_year"], item["map_id"])), sorted(
        failures, key=lambda item: (item["catalog_year"], item["map_id"])
    )


def _parse_years(values: list[str]) -> set[str]:
    return {year.strip() for value in values for year in value.split(",") if year.strip()}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", type=Path, default=DEFAULT_INPUT_DIR)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--years", nargs="*", default=[])
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--timeout", type=float, default=45)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    years = _parse_years(args.years)
    records = discover_sources(args.input_dir, years or None)
    archived, failures = archive_sources(
        records,
        args.output_dir,
        workers=args.workers,
        timeout=args.timeout,
        force=args.force,
    )
    unique_hashes = {entry["sha256"] for entry in archived}
    manifest = {
        "schema_version": 1,
        "generated_at": datetime.now(UTC).isoformat(),
        "source_inventory": args.input_dir.as_posix(),
        "map_count_expected": len(records),
        "map_count_archived": len(archived),
        "unique_source_urls": len({record.source_url for record in records}),
        "unique_pdf_hashes": len(unique_hashes),
        "catalog_years": sorted({record.catalog_year for record in records}),
        "hash_mismatches": sum(not entry["matches_imported_hash"] for entry in archived),
        "page_count_mismatches": sum(
            not entry["matches_imported_page_count"] for entry in archived
        ),
        "maps": archived,
        "failures": failures,
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = args.output_dir / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(
        f"Archived {len(archived)}/{len(records)} maps from "
        f"{manifest['unique_source_urls']} unique URLs; {len(failures)} failures."
    )
    return 1 if failures or len(archived) != len(records) else 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Build the browser-readable Carolina Core course catalog."""

from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from datetime import UTC, datetime
from html.parser import HTMLParser
from pathlib import Path
from typing import TypedDict

import requests


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = "https://academicbulletins.sc.edu/undergraduate/carolina-core-courses/"
DEFAULT_OUTPUT = ROOT / "static" / "data" / "carolina_core_courses.json"
CORE_CODES = {"AIU", "ARP", "CMS", "CMW", "GFL", "GHS", "GSS", "INF", "SCI", "VSR"}


class CoreCourse(TypedDict):
    code: str
    title: str
    outcomes: list[str]
    college: str
    overlay: bool
    effective_term: str


class CoreCatalog(TypedDict):
    schema_version: int
    kind: str
    catalog_year: str
    generated_at: str
    source_url: str
    counts: dict[str, int]
    courses: list[CoreCourse]


class CarolinaCoreTableParser(HTMLParser):
    """Extract rows from the bulletin's foundational-course table."""

    def __init__(self) -> None:
        super().__init__()
        self.in_table = False
        self.table_depth = 0
        self.row: list[str] | None = None
        self.cell: list[str] | None = None
        self.rows: list[list[str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        classes = set((values.get("class") or "").split())
        if tag == "table" and "sc_sccarolinatable" in classes:
            self.in_table = True
            self.table_depth = 1
            return
        if not self.in_table:
            return
        if tag == "table":
            self.table_depth += 1
        elif tag == "tr":
            self.row = []
        elif tag in {"td", "th"} and self.row is not None:
            self.cell = []

    def handle_data(self, data: str) -> None:
        if self.in_table and self.cell is not None:
            self.cell.append(data)

    def handle_endtag(self, tag: str) -> None:
        if not self.in_table:
            return
        if tag in {"td", "th"} and self.cell is not None:
            assert self.row is not None
            self.row.append(" ".join(" ".join(self.cell).split()))
            self.cell = None
        elif tag == "tr" and self.row is not None:
            self.rows.append(self.row)
            self.row = None
        elif tag == "table":
            self.table_depth -= 1
            if self.table_depth == 0:
                self.in_table = False


def _without_heading(value: str, heading: str) -> str:
    return re.sub(rf"^{re.escape(heading)}\s*", "", value, count=1, flags=re.IGNORECASE).strip()


def parse_catalog(html: str, *, source_url: str = DEFAULT_SOURCE) -> CoreCatalog:
    parser = CarolinaCoreTableParser()
    parser.feed(html)
    if len(parser.rows) < 2:
        raise ValueError("The bulletin did not contain a Carolina Core course table")

    by_course: dict[str, CoreCourse] = {}
    for row in parser.rows[1:]:
        if len(row) < 6:
            continue
        code = _without_heading(row[0], "Course").replace("\xa0", " ")
        code = re.sub(r"\s+", " ", code).upper()
        title = _without_heading(row[1], "Title")
        outcome = _without_heading(row[2], "Learning Outcome(s)").upper()
        college = _without_heading(row[3], "College")
        overlay = "overlay eligible" in row[4].lower()
        effective_term = _without_heading(row[5], "Effective Term")
        if not re.fullmatch(r"[A-Z]{2,8}\s+\d{2,4}[A-Z]?", code) or outcome not in CORE_CODES:
            continue
        course = by_course.setdefault(
            code,
            {
                "code": code,
                "title": title,
                "outcomes": [],
                "college": college,
                "overlay": False,
                "effective_term": effective_term,
            },
        )
        outcomes = course["outcomes"]
        if outcome not in outcomes:
            outcomes.append(outcome)
        course["overlay"] = bool(course["overlay"] or overlay)

    courses = sorted(by_course.values(), key=lambda course: str(course["code"]))
    for course in courses:
        course["outcomes"] = sorted(course["outcomes"])

    counts: defaultdict[str, int] = defaultdict(int)
    for course in courses:
        for outcome in course["outcomes"]:
            counts[str(outcome)] += 1

    return {
        "schema_version": 1,
        "kind": "carolina_core_catalog",
        "catalog_year": "2026-2027",
        "generated_at": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "source_url": source_url,
        "counts": dict(sorted(counts.items())),
        "courses": courses,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default=DEFAULT_SOURCE)
    parser.add_argument("--input-html", type=Path)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    if args.input_html:
        html = args.input_html.read_text(encoding="utf-8")
    else:
        response = requests.get(args.source, timeout=30)
        response.raise_for_status()
        html = response.text

    catalog = parse_catalog(html, source_url=args.source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(catalog, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {len(catalog['courses'])} Carolina Core courses to {args.output}")


if __name__ == "__main__":
    main()

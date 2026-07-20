#!/usr/bin/env python3
"""Import official USC major-map repository records into reviewable JSON.

The importer deliberately preserves the source wording. It extracts explicit
course codes and choices, but it does not invent course equivalents or turn a
free-form requirement into a specific course.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Iterable, cast
from urllib.parse import urljoin

import requests

from scripts.normalize_major_maps import normalize_components


DEFAULT_REPOSITORY_URL = (
    "https://sc.edu/about/offices_and_divisions/advising/advisor_toolbox/majormaps.php"
)
SCHEMA_VERSION = 1
COURSE_RE = re.compile(r"\b([A-Z]{2,5})\s*[- ]?\s*(\d{3}[A-Z]?)\b")
YEAR_RE = re.compile(r"\b(20\d{2})\s*[-–]\s*(20\d{2})\b")
SEMESTER_RE = re.compile(
    r"^\s*Semester\s+(One|Two|Three|Four|Five|Six|Seven|Eight)"
    r"\s*\(?\s*(\d+(?:\s*[-–]\s*\d+)?)\s*Credit Hours?\s*\)?",
    re.IGNORECASE,
)
SEMESTER_NUMBERS = {
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
}
# Some plans carry a block of rows that is not one of the eight numbered
# semesters: a summer session ("Summer (6 Credit Hours)"), an internship
# window ("Summer After Junior Year (6 Credit Hours)"), or a flexible slot
# ("Take during Semester Three or Four (0-2 Hours)", "Take during any
# semester (0-6 Credit Hours)"). These headers use the same "(<hours>
# [Credit] Hours)" convention as a real semester header but never say
# "Semester <word>", so SEMESTER_RE never matches them. Anchoring on a
# closed set of trigger words (rather than "any text before a parenthesised
# hours count") is deliberate: that broader shape also matches footnote
# sub-bullets like "a. Thematic Courses (3 hours): ...", and treating those
# as new sections would fabricate dozens of bogus semesters.
NON_SEMESTER_SECTION_RE = re.compile(
    r"^\s*(?P<label>(?:Summer|Winter|Take\s+during)\b[^()\n]*?)"
    r"\s*\(\s*(?P<hours>\d+(?:\s*[-–]\s*\d+)?)\s*(?:Credit\s+)?Hours?\s*\)",
    re.IGNORECASE,
)
REQUIREMENT_CODE_RE = re.compile(
    r"\b(?:CC(?:-(?:AIU|ARP|CMS|CMW|GFL|GHS|GSS|INF|INT|SCI|VSR))?|CR|MR|PR)\b"
)
# A trailing \b cannot match after "+" or "-": both are non-word characters,
# and they are always followed by whitespace (also non-word) in the grade
# column, so there is no word/non-word transition there for \b to find. The
# engine backtracks, the optional modifier is discarded, and "C+"/"B-" are
# silently stored as the weaker "C"/"B" -- confidently wrong advice for a
# degree planner deciding whether a completed course satisfies a
# requirement. Anchor on the grade column's real shape instead: a letter
# grade is always followed by whitespace or the end of the (already-sliced)
# grade zone, never by another word character.
MINIMUM_GRADE_RE = re.compile(r"\b([A-DF][+-]?)(?=\s|$)")
# COURSE_RE has no way to distinguish a registrar subject code (MATH, ENGL,
# CSCE, ...) from an ordinary English word that happens to sit directly in
# front of a three-digit number in prerequisite prose that bled into the
# title text -- e.g. "...C or better in MATH 106 or 146" yields a bare "OR
# 146" match, "cross-listed STAT 511" yields "CROSS 511", "General Chemistry
# II" followed by a wrapped "111" yields "II 111". An audit of every
# course_codes value produced across the curated corpus (all catalog years)
# found these words are the only collisions: every subject code the
# registrar actually uses (all 4-5 letters in the corpus) survives untouched.
_NON_SUBJECT_WORDS = frozenset(
    {
        # Conjunctions/prepositions that land directly before a course number
        # once prerequisite prose wraps into the title ("...I or 146").
        "OR",
        "AND",
        "NOR",
        "BUT",
        "FOR",
        "YET",
        "SO",
        "IN",
        "ON",
        "AT",
        "TO",
        "OF",
        "BY",
        "AS",
        "IF",
        "BE",
        # Determiners/quantifiers and number words ("any 200-level", "two
        # 500-level", "cross-listed").
        "THE",
        "ANY",
        "ALL",
        "ONE",
        "TWO",
        "SIX",
        "TEN",
        "CROSS",
        # Multi-letter Roman numerals used as a course-title suffix
        # ("General Chemistry II"), confirmed to leak into "II 111" when the
        # next column wraps. COURSE_RE requires 2-5 letters, so single-letter
        # numerals (I, V, X) can never match and are omitted here.
        "II",
        "III",
        "IV",
        "VI",
        "VII",
        "VIII",
        "IX",
        # Scheduling/administrative prose confirmed in the audit ("offered
        # fall odd", "a view of the River", "Physics I Lab", "CC-INT").
        "FALL",
        "SPRING",
        "ODD",
        "EVEN",
        "ONLY",
        "LAB",
        "RIVER",
        "INT",
    }
)


def _extract_course_codes(text: str) -> list[str]:
    """Find explicit "SUBJECT ###" course codes, dropping English-word collisions."""
    codes = [
        f"{subject} {number}"
        for subject, number in COURSE_RE.findall(text.upper())
        if subject not in _NON_SUBJECT_WORDS
    ]
    return list(dict.fromkeys(codes))


def _clean(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(value).replace("\xa0", " ")).strip()


def _stable_id(prefix: str, *parts: object) -> str:
    canonical = "\x1f".join(_clean(str(part)).casefold() for part in parts)
    return f"{prefix}_{hashlib.sha256(canonical.encode()).hexdigest()[:16]}"


@dataclass
class RepositoryEntry:
    bulletin_year: str
    college: str
    department: str
    degree: str
    major: str
    pdf_url: str | None
    faculty_approver: str
    keywords: str
    repository_url: str
    warnings: list[str] = field(default_factory=list)
    plan_format: str = "four_year"

    @property
    def id(self) -> str:
        return _stable_id(
            "map",
            self.bulletin_year,
            self.college,
            self.department,
            self.degree,
            self.major,
            self.plan_format,
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "bulletin_year": self.bulletin_year,
            "college": self.college,
            "department": self.department,
            "degree": self.degree,
            "major": self.major,
            "pdf_url": self.pdf_url,
            "faculty_approver": self.faculty_approver,
            "keywords": self.keywords,
            "repository_url": self.repository_url,
            "plan_format": self.plan_format,
            "confidence": "high"
            if self.pdf_url and YEAR_RE.fullmatch(self.bulletin_year)
            else "low",
            "warnings": self.warnings,
        }


class _RepositoryTableParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.in_table = False
        self.in_row = False
        self.in_cell = False
        self.is_header_cell = False
        self.cell_text: list[str] = []
        self.cell_href: str | None = None
        self.current_row: list[tuple[str, str | None, bool]] = []
        self.rows: list[list[tuple[str, str | None, bool]]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag == "table" and "display" in (attributes.get("class") or "").split():
            self.in_table = True
        elif self.in_table and tag == "tr":
            self.in_row = True
            self.current_row = []
        elif self.in_row and tag in {"td", "th"}:
            self.in_cell = True
            self.is_header_cell = tag == "th"
            self.cell_text = []
            self.cell_href = None
        elif self.in_cell and tag == "a" and attributes.get("href"):
            self.cell_href = attributes["href"]
        elif self.in_cell and tag == "br":
            self.cell_text.append(" ")

    def handle_data(self, data: str) -> None:
        if self.in_cell:
            self.cell_text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if self.in_cell and tag in {"td", "th"}:
            self.current_row.append(
                (_clean("".join(self.cell_text)), self.cell_href, self.is_header_cell)
            )
            self.in_cell = False
        elif self.in_row and tag == "tr":
            if self.current_row:
                self.rows.append(self.current_row)
            self.in_row = False
        elif self.in_table and tag == "table":
            self.in_table = False


def parse_repository_html(
    source: str, repository_url: str = DEFAULT_REPOSITORY_URL
) -> list[RepositoryEntry]:
    """Parse repository metadata without relying on presentation-only markup."""
    parser = _RepositoryTableParser()
    parser.feed(source)
    entries: list[RepositoryEntry] = []
    for row in parser.rows:
        if row and all(cell[2] for cell in row):
            continue
        if len(row) < 7:
            continue
        values = [cell[0] for cell in row]
        pdf_href = row[5][1]
        warnings: list[str] = []
        year = values[0]
        if not YEAR_RE.fullmatch(year):
            warnings.append("invalid_bulletin_year")
        if not pdf_href:
            warnings.append("missing_pdf_url")
        if not values[4]:
            warnings.append("missing_major_name")
        entries.append(
            RepositoryEntry(
                bulletin_year=year,
                college=values[1],
                department=values[2],
                degree=values[3],
                major=values[4],
                pdf_url=urljoin(repository_url, pdf_href) if pdf_href else None,
                faculty_approver=values[6],
                keywords=values[7] if len(values) > 7 else "",
                repository_url=repository_url,
                warnings=warnings,
                plan_format=(
                    "accelerated"
                    if "3-yr" in values[5].casefold() or "accelerated" in values[5].casefold()
                    else "four_year"
                ),
            )
        )
    return entries


def extract_pdf_text(pdf: bytes, *, pdftotext: str = "pdftotext") -> str:
    """Extract layout-preserving PDF text with the system Poppler binary."""
    if not pdf.startswith(b"%PDF"):
        raise ValueError("Major-map document is not a PDF")
    with tempfile.TemporaryDirectory(prefix="major-map-") as directory:
        pdf_path = Path(directory) / "source.pdf"
        text_path = Path(directory) / "source.txt"
        pdf_path.write_bytes(pdf)
        try:
            process = subprocess.run(
                [pdftotext, "-layout", str(pdf_path), str(text_path)],
                check=False,
                capture_output=True,
                text=True,
                timeout=60,
            )
        except FileNotFoundError as error:
            raise RuntimeError("pdftotext is required to import major-map PDFs") from error
        if process.returncode != 0:
            detail = _clean(process.stderr) or "unknown extraction error"
            raise RuntimeError(f"Could not extract major-map PDF text: {detail}")
        return text_path.read_text(encoding="utf-8", errors="replace")


def extract_pdf_bbox(pdf: bytes, *, pdftotext: str = "pdftotext") -> str:
    """Extract Poppler's word-level page coordinates from a major-map PDF."""
    if not pdf.startswith(b"%PDF"):
        raise ValueError("Major-map document is not a PDF")
    with tempfile.TemporaryDirectory(prefix="major-map-bbox-") as directory:
        pdf_path = Path(directory) / "source.pdf"
        bbox_path = Path(directory) / "source.html"
        pdf_path.write_bytes(pdf)
        try:
            process = subprocess.run(
                [pdftotext, "-bbox-layout", str(pdf_path), str(bbox_path)],
                check=False,
                capture_output=True,
                text=True,
                timeout=60,
            )
        except FileNotFoundError as error:
            raise RuntimeError("pdftotext is required to import major-map PDFs") from error
        if process.returncode != 0:
            detail = _clean(process.stderr) or "unknown extraction error"
            raise RuntimeError(f"Could not extract major-map PDF coordinates: {detail}")
        return bbox_path.read_text(encoding="utf-8", errors="replace")


@dataclass(frozen=True)
class _PdfWord:
    page: int
    text: str
    x_min: float
    y_min: float
    x_max: float
    y_max: float

    @property
    def y_center(self) -> float:
        return (self.y_min + self.y_max) / 2


def _bbox_words(source: str) -> list[list[_PdfWord]]:
    """Read pdftotext bbox XHTML without depending on presentation flow order."""
    try:
        root = ET.fromstring(source)
    except ET.ParseError as error:
        raise ValueError(f"Major-map coordinate extraction is invalid XHTML: {error}") from error
    pages: list[list[_PdfWord]] = []
    for page_number, page in enumerate(root.iterfind(".//{*}page"), start=1):
        words: list[_PdfWord] = []
        for node in page.iterfind(".//{*}word"):
            text = _clean("".join(node.itertext()))
            if not text:
                continue
            try:
                words.append(
                    _PdfWord(
                        page=page_number,
                        text=text,
                        x_min=float(node.attrib["xMin"]),
                        y_min=float(node.attrib["yMin"]),
                        x_max=float(node.attrib["xMax"]),
                        y_max=float(node.attrib["yMax"]),
                    )
                )
            except (KeyError, ValueError) as error:
                raise ValueError(
                    "Major-map coordinate word is missing a numeric bounding box"
                ) from error
        pages.append(words)
    if not pages or not any(pages):
        raise ValueError("Major-map coordinate extraction contains no words")
    return pages


def _group_positioned_lines(
    words: list[_PdfWord], *, tolerance: float = 2.1
) -> list[list[_PdfWord]]:
    """Group words by baseline while keeping superscripts with their printed line."""
    lines: list[list[_PdfWord]] = []
    centers: list[float] = []
    for word in sorted(words, key=lambda item: (item.y_center, item.x_min)):
        best_index: int | None = None
        best_distance = tolerance
        for index in range(max(0, len(lines) - 3), len(lines)):
            distance = abs(word.y_center - centers[index])
            if distance <= best_distance:
                best_index = index
                best_distance = distance
        if best_index is None:
            lines.append([word])
            centers.append(word.y_center)
        else:
            lines[best_index].append(word)
            centers[best_index] = sum(item.y_center for item in lines[best_index]) / len(
                lines[best_index]
            )
    for line in lines:
        line.sort(key=lambda item: item.x_min)
    return lines


def _positioned_text(pages: list[list[_PdfWord]]) -> str:
    page_text: list[str] = []
    for words in pages:
        page_text.append(
            "\n".join(
                _clean(" ".join(word.text for word in line))
                for line in _group_positioned_lines(words)
            )
        )
    return "\n\f\n".join(page_text)


def _metadata(text: str, entry: RepositoryEntry) -> tuple[dict[str, Any], list[str]]:
    warnings: list[str] = []
    major_match = re.search(r"Major Map:\s*([^\n\r]+)", text, re.IGNORECASE)
    bulletin_match = re.search(r"Bulletin Year:\s*(20\d{2}\s*[-–]\s*20\d{2})", text, re.IGNORECASE)
    degree_match = re.search(r"\b(Bachelor of [^\n\r]+\([^\n\r()]+\))", text, re.IGNORECASE)
    graduation = re.search(
        r"Graduation Requirements Summary(?P<body>.*?)(?:\n\s*1\.|Program Notes:)",
        text,
        re.IGNORECASE | re.DOTALL,
    )
    minimum_hours: int | None = None
    institutional_gpa: float | None = None
    if graduation:
        numbers = re.findall(r"(?<!\d)(\d{2,3})(?:\s|$)", graduation.group("body"))
        if numbers:
            minimum_hours = int(numbers[0])
        gpas = re.findall(r"\b([234]\.\d{2,3})\b", graduation.group("body"))
        if gpas:
            institutional_gpa = float(gpas[-1])
    pdf_major = _clean(major_match.group(1)) if major_match else ""
    pdf_year = _clean(bulletin_match.group(1)).replace("–", "-") if bulletin_match else ""
    if not pdf_major:
        warnings.append("pdf_major_name_not_found")
    elif (
        entry.major
        and pdf_major.casefold() not in entry.major.casefold()
        and entry.major.casefold() not in pdf_major.casefold()
    ):
        warnings.append("repository_pdf_major_mismatch")
    if not pdf_year:
        warnings.append("pdf_bulletin_year_not_found")
    elif entry.bulletin_year and pdf_year != entry.bulletin_year:
        warnings.append("repository_pdf_year_mismatch")
    return (
        {
            "name": pdf_major or entry.major,
            "degree": _clean(degree_match.group(1)) if degree_match else entry.degree,
            "bulletin_year": pdf_year or entry.bulletin_year,
            "college": entry.college,
            "department": entry.department,
            "faculty_approver": entry.faculty_approver,
            "minimum_total_hours": minimum_hours,
            "minimum_institutional_gpa": institutional_gpa,
        },
        warnings,
    )


def _credit_value(value: str) -> int | list[int]:
    values = [int(item) for item in re.findall(r"\d+", value)]
    return values[0] if len(values) == 1 else [min(values), max(values)]


_ROW_RE = re.compile(
    r"^\s*(?P<critical>!\s*)?(?P<title>\S.*?)\s{2,}(?P<credits>\d+(?:\s*[-–]\s*\d+)?)"
    r"(?:\s{2,}(?P<remaining>.*))?$"
)
_ROW_TIGHT_GAP_RE = re.compile(
    r"^\s*(?P<critical>!\s*)?(?P<title>\S.*?)\s(?P<credits>\d+(?:\s*[-–]\s*\d+)?)"
    r"\s{2,}(?P<remaining>.*)$"
)


def _looks_like_trailing_columns(remaining: str) -> bool:
    """True when `remaining` reads like a grade/requirement-code column, not prose."""
    if REQUIREMENT_CODE_RE.search(remaining.upper()):
        return True
    return bool(re.match(r"^[A-DF][+-]?(?:\s{2,}|$)", remaining))


# No single USC undergraduate course row is worth more than this many credit
# hours. `-layout` sometimes wraps the far-right prerequisite column's own
# course number (e.g. "...PHYS 201 or\n211") onto the same visual line as a
# truncated title fragment, which otherwise reads exactly like a row:
# "<fragment>  <huge gap>  <number>". Real credit-hours values across the
# curated corpus top out at 15; every value at or above 130 traces to this
# exact kind of column bleed (a wrapped course number, not a credit value).
_MAX_PLAUSIBLE_CREDIT_HOURS = 18


def _row_credit_hours_implausible(credits_text: str) -> bool:
    """True when a matched "credits" group is too large to be a real value."""
    value = _credit_value(credits_text)
    peak = max(value) if isinstance(value, list) else value
    return peak > _MAX_PLAUSIBLE_CREDIT_HOURS


def _row_from_line(line: str, semester: int, sequence: int) -> dict[str, Any] | None:
    # Major maps are columnar. Two or more spaces separate title, credits, grade/GPA,
    # requirement code, and prerequisite columns in the layout-preserving text.
    stripped_line = line.rstrip()
    match = _ROW_RE.match(stripped_line)
    if not match:
        # pdftotext -layout occasionally leaves only a single space between
        # the title and the credit-hours column when the title text runs
        # right up to the column boundary. The strict rule above then finds
        # no match and the whole row would silently vanish. Recover it, but
        # only when what follows the lone digit run still reads like the
        # grade/requirement columns that always trail a real credit-hours
        # value -- otherwise a course number embedded in the title itself
        # (e.g. "ENGL 101 ...") could be mistaken for the credits field.
        tight_match = _ROW_TIGHT_GAP_RE.match(stripped_line)
        if tight_match and _looks_like_trailing_columns(tight_match.group("remaining")):
            match = tight_match
    if not match:
        return None
    if _row_credit_hours_implausible(match.group("credits")):
        # Not a row at all -- see _MAX_PLAUSIBLE_CREDIT_HOURS above.
        # _is_title_continuation re-checks this same shape so the fragment
        # is folded back into the still-open item instead of being emitted
        # as a phantom row (or vanishing without a trace).
        return None
    title = _clean(match.group("title"))
    if not title or title.lower().startswith(("credit ", "minimum ")):
        return None
    remaining = _clean(match.group("remaining") or "")
    course_codes = _extract_course_codes(title)
    explicit_choice = bool(re.search(r"\b(?:or|choose|select)\b", title, re.IGNORECASE))
    warnings: list[str] = []
    illustrative_code = bool(
        course_codes
        and re.search(r"\b(?:elective|recommended|requirement)\b", title, re.IGNORECASE)
    )
    if len(course_codes) > 1 and not explicit_choice:
        warnings.append("multiple_course_codes_without_explicit_choice")
    if not course_codes:
        warnings.append("non_specific_requirement_requires_validation")
    if illustrative_code:
        relation = "requirement"
        warnings.append("course_mentioned_as_example_not_required")
    elif explicit_choice:
        relation = "choose_one"
    elif len(course_codes) == 1:
        relation = "required"
    else:
        relation = "requirement"
    requirement_codes = list(dict.fromkeys(REQUIREMENT_CODE_RE.findall(remaining.upper())))
    first_requirement_code = REQUIREMENT_CODE_RE.search(remaining.upper())
    grade_zone = (
        remaining[: first_requirement_code.start()] if first_requirement_code else remaining
    )
    grade_match = MINIMUM_GRADE_RE.search(grade_zone)
    confidence = "high" if len(course_codes) == 1 and not warnings else "medium"
    if warnings and (not course_codes or illustrative_code):
        confidence = "low"
    item = {
        "id": _stable_id("req", semester, sequence, title, match.group("credits")),
        "sequence": sequence,
        "title": title,
        "course_codes": course_codes,
        "relation": relation,
        "credit_hours": _credit_value(match.group("credits")),
        "critical": bool(match.group("critical")),
        "minimum_grade": grade_match.group(1) if grade_match else None,
        "requirement_codes": requirement_codes,
        "source_text": _clean(line),
        "confidence": confidence,
        "warnings": warnings,
    }
    return item


def _is_title_continuation(item: dict[str, Any], line: str) -> bool:
    stripped = line.strip()
    if len(line) - len(line.lstrip()) > 40:
        return False
    if re.match(r"^\(?or\s+[A-Z]{2,5}\s+\d{3}", stripped, re.IGNORECASE):
        return True
    if re.search(r"\(or\s+[A-Z]{2,5}\s+\d{3}", stripped, re.IGNORECASE):
        return True
    # The PDF sometimes wraps a "(or CODE ###)" alternative right after the
    # open paren, so "(or" ends one line and the code starts the next, e.g.
    # title "...Engr. (or" / continuation "ENCP 101) fall only". Neither
    # pattern above matches because "(or" and the code never share a line,
    # so the alternative -- and any trailing text like "fall only" -- was
    # silently dropped.
    if item["title"].casefold().endswith("(or") and re.match(
        r"^[A-Z]{2,5}\s*[- ]?\s*\d{3}[A-Z]?\)", stripped, re.IGNORECASE
    ):
        return True
    if item["title"].endswith("-") and bool(_extract_course_codes(stripped)):
        return True
    # A line can look exactly like a brand-new row (title + gap + digits)
    # while actually being the tail of THIS row wrapping into the far-right
    # prerequisite column, e.g. "Communities" / "441" continuing "...SOWK\n
    # 441", or "School10 (Spring only)" / "370" continuing a title that
    # itself wrapped mid-word. _row_from_line already refuses to emit these
    # as rows (see _MAX_PLAUSIBLE_CREDIT_HOURS); recognise the same shape
    # here so the fragment is folded back into the open item instead of
    # disappearing without a trace. The indent check above still screens out
    # deep column bleed (e.g. a lone requirement-code fragment like "INT")
    # that has no business being appended to a title.
    row_shaped = _ROW_RE.match(line.rstrip()) or _ROW_TIGHT_GAP_RE.match(line.rstrip())
    if row_shaped and _row_credit_hours_implausible(row_shaped.group("credits")):
        return True
    return False


def _append_continuation(item: dict[str, Any], line: str) -> None:
    continuation = _clean(line)
    if not continuation:
        return
    # Only retain meaningful alternative/title continuations. Prerequisite prose is
    # preserved in source_text but never promoted into an inferred requirement.
    title_fragment = continuation
    row_shaped = _ROW_RE.match(line.rstrip()) or _ROW_TIGHT_GAP_RE.match(line.rstrip())
    if row_shaped and _row_credit_hours_implausible(row_shaped.group("credits")):
        # The trailing digits are a wrapped fragment from the far-right
        # prerequisite column (see _MAX_PLAUSIBLE_CREDIT_HOURS), not part of
        # the title -- keep them out of the title text. The unedited line is
        # still preserved below in source_text.
        title_fragment = _clean(row_shaped.group("title"))
    item["title"] = _clean(f"{item['title']} {title_fragment}")
    codes = _extract_course_codes(title_fragment)
    item["course_codes"] = list(dict.fromkeys([*item["course_codes"], *codes]))
    if re.search(r"(?:^|\()or\s+[A-Z]{2,5}\s+\d{3}", title_fragment, re.IGNORECASE) or re.match(
        r"^[A-Z]{2,5}\s*[- ]?\s*\d{3}[A-Z]?\)", title_fragment, re.IGNORECASE
    ):
        item["relation"] = "choose_one"
    item["confidence"] = "medium"
    item["source_text"] = _clean(f"{item['source_text']} {continuation}")


@dataclass(frozen=True)
class _TableColumns:
    title_left: float
    credit_left: float
    minimum_grade_left: float
    major_gpa_left: float


def _page_table_columns(words: list[_PdfWord]) -> _TableColumns | None:
    """Locate table columns from the printed header nearest `Prerequisites`."""
    prerequisite_headers = [word for word in words if word.text.casefold() == "prerequisites"]
    for prerequisite in prerequisite_headers:
        nearby = [word for word in words if abs(word.y_center - prerequisite.y_center) <= 13]

        def header(label: str) -> _PdfWord | None:
            matches = [word for word in nearby if word.text.casefold() == label.casefold()]
            return min(
                matches, key=lambda word: abs(word.y_center - prerequisite.y_center), default=None
            )

        credit = header("Credit")
        minimum = header("Min.")
        major = header("Major")
        critical = header("Critical")
        if credit and minimum and major and critical:
            return _TableColumns(
                title_left=critical.x_max + 1,
                credit_left=credit.x_min - 3,
                minimum_grade_left=minimum.x_min - 3,
                major_gpa_left=major.x_min - 3,
            )
    return None


def _text_for_words(words: list[_PdfWord]) -> str:
    return _clean(
        " ".join(
            _clean(" ".join(word.text for word in line)) for line in _group_positioned_lines(words)
        )
    )


def _coordinate_item(
    words: list[_PdfWord],
    *,
    columns: _TableColumns,
    semester: int,
    sequence: int,
    credit_word: _PdfWord,
) -> dict[str, Any] | None:
    title_words = [word for word in words if columns.title_left <= word.x_min < columns.credit_left]
    title = _text_for_words(title_words)
    if not title or title.casefold().startswith(("credit ", "minimum ")):
        return None
    source_text = _text_for_words(words)
    course_codes = _extract_course_codes(title)
    explicit_choice = bool(re.search(r"\b(?:or|choose|select)\b", title, re.IGNORECASE))
    illustrative_code = bool(
        course_codes
        and re.search(r"\b(?:elective|recommended|requirement)\b", title, re.IGNORECASE)
    )
    warnings: list[str] = []
    if len(course_codes) > 1 and not explicit_choice:
        warnings.append("multiple_course_codes_without_explicit_choice")
    if not course_codes:
        warnings.append("non_specific_requirement_requires_validation")
    if explicit_choice and len(course_codes) < 2:
        warnings.append("choose_one_options_require_validation")
    if illustrative_code:
        relation = "requirement"
        warnings.append("course_mentioned_as_example_not_required")
    elif explicit_choice:
        relation = "choose_one"
    elif len(course_codes) == 1:
        relation = "required"
    else:
        relation = "requirement"
    requirement_codes = list(dict.fromkeys(REQUIREMENT_CODE_RE.findall(source_text.upper())))
    minimum_grade_words = [
        word for word in words if columns.minimum_grade_left <= word.x_min < columns.major_gpa_left
    ]
    grade_match = MINIMUM_GRADE_RE.search(_text_for_words(minimum_grade_words))
    confidence = "high" if len(course_codes) == 1 and not warnings else "medium"
    if warnings and (not course_codes or illustrative_code):
        confidence = "low"
    bbox = [
        round(min(word.x_min for word in words), 3),
        round(min(word.y_min for word in words), 3),
        round(max(word.x_max for word in words), 3),
        round(max(word.y_max for word in words), 3),
    ]
    provenance = {
        "page": credit_word.page,
        "bbox": bbox,
        "source_text": source_text,
        "ambiguity_flags": list(warnings),
    }
    return {
        "id": _stable_id("req", semester, sequence, title, credit_word.text),
        "sequence": sequence,
        "title": title,
        "course_codes": course_codes,
        "relation": relation,
        "credit_hours": _credit_value(credit_word.text),
        "critical": any(word.text == "!" and word.x_max <= columns.title_left for word in words),
        "minimum_grade": grade_match.group(1) if grade_match else None,
        "requirement_codes": requirement_codes,
        "source_text": source_text,
        "source_page": credit_word.page,
        "source_bbox": bbox,
        "provenance": provenance,
        "confidence": confidence,
        "warnings": warnings,
    }


def parse_major_map_bbox(source: str, entry: RepositoryEntry) -> dict[str, Any]:
    """Parse one coordinate-aware Poppler XHTML extraction into a program map."""
    pages = _bbox_words(source)
    metadata, warnings = _metadata(_positioned_text(pages), entry)
    semesters: list[dict[str, Any]] = []
    for page_words in pages:
        columns = _page_table_columns(page_words)
        if columns is None:
            continue
        lines = _group_positioned_lines(page_words)
        semester_headers: list[tuple[int, re.Match[str], list[_PdfWord]]] = []
        for line_index, line in enumerate(lines):
            match = SEMESTER_RE.match(_clean(" ".join(word.text for word in line)))
            if match:
                semester_headers.append((line_index, match, line))
        for header_index, (line_index, semester_match, header_line) in enumerate(semester_headers):
            number = SEMESTER_NUMBERS[semester_match.group(1).lower()]
            next_line_index = (
                semester_headers[header_index + 1][0]
                if header_index + 1 < len(semester_headers)
                else len(lines)
            )
            region_lines = lines[line_index + 1 : next_line_index]
            region_words = [word for line in region_lines for word in line]
            credit_words = sorted(
                (
                    word
                    for word in region_words
                    if columns.credit_left <= word.x_min < columns.minimum_grade_left
                    and re.fullmatch(r"\d+(?:\s*[-–]\s*\d+)?", word.text)
                ),
                key=lambda word: word.y_center,
            )
            semester = {
                "number": number,
                "label": f"Semester {semester_match.group(1).title()}",
                "planned_credit_hours": _credit_value(semester_match.group(2)),
                "requirements": [],
            }
            header_bottom = max(word.y_max for word in header_line)
            for credit_index, credit_word in enumerate(credit_words):
                start_y = max(header_bottom, credit_word.y_center - 3)
                end_y = (
                    credit_words[credit_index + 1].y_center - 3
                    if credit_index + 1 < len(credit_words)
                    else max((word.y_max for word in region_words), default=start_y) + 1
                )
                row_words = [word for word in region_words if start_y <= word.y_center < end_y]
                item = _coordinate_item(
                    row_words,
                    columns=columns,
                    semester=number,
                    sequence=len(semester["requirements"]) + 1,
                    credit_word=credit_word,
                )
                if item:
                    semester["requirements"].append(item)
            semesters.append(semester)
    return _build_map_document(metadata, warnings, semesters, entry)


def parse_major_map_text(text: str, entry: RepositoryEntry) -> dict[str, Any]:
    """Parse one layout-preserving PDF text document into a reviewable program map."""
    metadata, warnings = _metadata(text, entry)
    lines = text.replace("\f", "\n").splitlines()
    semesters: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    last_item: dict[str, Any] | None = None
    non_semester_section_count = 0
    for line in lines:
        semester_match = SEMESTER_RE.match(line)
        if semester_match:
            number = SEMESTER_NUMBERS[semester_match.group(1).lower()]
            current = {
                "number": number,
                "label": f"Semester {semester_match.group(1).title()}",
                "planned_credit_hours": _credit_value(semester_match.group(2)),
                "requirements": [],
            }
            semesters.append(current)
            last_item = None
            continue
        section_match = NON_SEMESTER_SECTION_RE.match(line)
        if section_match:
            # A recognisable section header that isn't "Semester <N>" (a
            # summer session, an internship window, a flexible elective
            # slot). Without this branch the header matches nothing, `current`
            # stays whatever it was, and every row here silently accumulates
            # into the wrong -- and possibly already-closed -- semester
            # bucket (e.g. a summer internship landing in "Semester Eight").
            # Number it past the highest real semester number (1-8) so it
            # can never collide with one, keep the original header wording
            # as the label (rather than inventing "Semester Nine"), and flag
            # the document for review since this plan doesn't fit the
            # standard 8-semester shape the rest of the pipeline assumes.
            non_semester_section_count += 1
            current = {
                "number": 8 + non_semester_section_count,
                "label": _clean(line),
                "planned_credit_hours": _credit_value(section_match.group("hours")),
                "requirements": [],
            }
            semesters.append(current)
            last_item = None
            warnings.append("non_standard_semester_section")
            continue
        if current is None:
            continue
        if re.match(
            r"^\s*(Graduation Requirements Summary|Program Notes:|University Requirements:)",
            line,
            re.IGNORECASE,
        ):
            current = None
            last_item = None
            continue
        item = _row_from_line(line, current["number"], len(current["requirements"]) + 1)
        if item:
            current["requirements"].append(item)
            last_item = item
        elif last_item and _is_title_continuation(last_item, line):
            _append_continuation(last_item, line)

    return _build_map_document(metadata, warnings, semesters, entry)


def _build_map_document(
    metadata: dict[str, Any],
    warnings: list[str],
    semesters: list[dict[str, Any]],
    entry: RepositoryEntry,
) -> dict[str, Any]:
    normalization_findings = normalize_components(metadata, semesters)
    normalization_warnings = [
        finding.code for finding in normalization_findings if finding.severity == "warning"
    ]
    numbers = [semester["number"] for semester in semesters]
    if numbers != list(range(1, len(numbers) + 1)) or len(numbers) < 2:
        warnings.append("semester_sequence_is_not_contiguous")
    if len(numbers) != 8:
        warnings.append("expected_exactly_eight_ordered_semesters")
    if any(not semester["requirements"] for semester in semesters):
        warnings.append("one_or_more_semesters_have_no_requirements")
    requirement_count = sum(len(semester["requirements"]) for semester in semesters)
    low_confidence_count = sum(
        item["confidence"] == "low" for semester in semesters for item in semester["requirements"]
    )
    if requirement_count == 0:
        warnings.append("no_course_rows_extracted")
    document_confidence = "high"
    if warnings or low_confidence_count:
        document_confidence = "medium"
    if requirement_count == 0 or len(semesters) < 2:
        document_confidence = "low"
    runtime = _runtime_fields(metadata, semesters)
    return {
        "schema_version": SCHEMA_VERSION,
        "id": entry.id,
        "program_family_id": _stable_id(
            "program",
            metadata["college"],
            metadata["department"],
            metadata["degree"],
            metadata["name"],
        ),
        "plan_format": entry.plan_format,
        **runtime,
        "parsed_metadata": metadata,
        "semester_plan": semesters,
        "source": {
            "url": entry.pdf_url,
            "repository_url": entry.repository_url,
        },
        "sources": {
            "repository_url": entry.repository_url,
            "pdf_url": entry.pdf_url,
        },
        "confidence": document_confidence,
        "warnings": list(dict.fromkeys([*entry.warnings, *warnings, *normalization_warnings])),
        "normalization": {
            "schema_version": 1,
            "changes": sum(finding.severity == "change" for finding in normalization_findings),
            "warnings": len(normalization_warnings),
            "findings": [finding.as_dict() for finding in normalization_findings],
        },
        "validation": {
            "semester_count": len(semesters),
            "requirement_count": requirement_count,
            "low_confidence_requirement_count": low_confidence_count,
            "requires_review": bool(warnings or normalization_warnings or low_confidence_count),
        },
    }


def _category(item: dict[str, Any]) -> str:
    codes = set(item.get("requirement_codes") or [])
    if "MR" in codes:
        return "major_courses"
    if "CR" in codes:
        return "college_requirements"
    if "PR" in codes:
        return "program_requirements"
    if any(code == "CC" or code.startswith("CC-") for code in codes):
        return "carolina_core"
    return "other_requirements"


def _runtime_fields(metadata: dict[str, Any], semesters: list[dict[str, Any]]) -> dict[str, Any]:
    """Build the conservative subset consumed by the existing degree planner."""
    required: list[dict[str, Any]] = []
    groups: list[dict[str, Any]] = []
    seen_required: set[str] = set()
    for semester in semesters:
        semester_number = int(semester["number"])
        typical_year = (semester_number + 1) // 2
        typical_semester = "Fall" if semester_number % 2 else "Spring"
        for item in semester["requirements"]:
            codes = item["course_codes"]
            category = _category(item)
            credits = item["credit_hours"]
            if item["relation"] == "required" and len(codes) == 1 and codes[0] not in seen_required:
                seen_required.add(codes[0])
                title = re.sub(
                    rf"^{re.escape(codes[0])}\s*", "", item["title"], flags=re.IGNORECASE
                )
                record: dict[str, Any] = {
                    "code": codes[0],
                    "title": title,
                    "credits": credits if isinstance(credits, int) else min(credits),
                    "typical_year": typical_year,
                    "typical_semester": typical_semester,
                    "prerequisites": [],
                    "corequisites": [],
                    "category": category,
                    "source_requirement_id": item["id"],
                }
                if item.get("minimum_grade"):
                    record["min_grade"] = item["minimum_grade"]
                cc_codes = [
                    code.removeprefix("CC-")
                    for code in item["requirement_codes"]
                    if code.startswith("CC-")
                ]
                if cc_codes:
                    record["carolina_core"] = cc_codes[0]
                required.append(record)
            elif item["relation"] == "choose_one" and len(codes) > 1:
                groups.append(
                    {
                        "id": item["id"],
                        "label": item["title"],
                        "pick": 1,
                        "credits_each": credits if isinstance(credits, int) else min(credits),
                        "credits_required": credits if isinstance(credits, int) else min(credits),
                        "category": category,
                        "options": codes,
                        "source_requirement_id": item["id"],
                    }
                )
            else:
                groups.append(
                    {
                        "id": item["id"],
                        "label": item["title"],
                        "pick": 1,
                        "credits_required": credits if isinstance(credits, int) else min(credits),
                        "category": category,
                        "options": [],
                        "informational": True,
                        "requires_review": True,
                        "source_requirement_id": item["id"],
                    }
                )
    return {
        "major": metadata["name"],
        "program": metadata["degree"],
        "college": metadata["college"],
        "department": metadata["department"],
        "catalog_year": metadata["bulletin_year"],
        "total_credits_required": metadata["minimum_total_hours"],
        "required_courses": required,
        "elective_groups": groups,
        "category_labels": {
            "major_courses": "Major Courses",
            "college_requirements": "College Requirements",
            "program_requirements": "Program Requirements",
            "carolina_core": "Carolina Core",
            "other_requirements": "Other Requirements",
        },
        "concentrations": {},
    }


def validate_map(document: dict[str, Any]) -> list[str]:
    """Return blocking validation errors. Warnings remain non-blocking review data."""
    errors: list[str] = []
    if not document.get("major"):
        errors.append("Program name is required")
    if not YEAR_RE.fullmatch(str(document.get("catalog_year") or "")):
        errors.append("A valid bulletin year is required")
    if not isinstance(document.get("total_credits_required"), int):
        document["warnings"] = list(
            dict.fromkeys([*document.get("warnings", []), "minimum_total_degree_hours_not_found"])
        )
    semesters = document.get("semester_plan") or []
    numbers = [semester.get("number") for semester in semesters]
    if len(numbers) < 2 or numbers != list(range(1, len(numbers) + 1)):
        document["warnings"] = list(
            dict.fromkeys([*document.get("warnings", []), "semester_plan_requires_manual_review"])
        )
    if not document.get("sources", {}).get("pdf_url"):
        errors.append("Official PDF source URL is required")
    return errors


def _first(record: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = record.get(key)
        if value not in (None, ""):
            return value
    return None


def load_inventory(
    path: Path, *, repository_url: str = DEFAULT_REPOSITORY_URL
) -> list[tuple[RepositoryEntry, dict[str, Any]]]:
    """Load a downloaded inventory while accepting common envelope and field aliases."""
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, dict):
        records = _first(payload, "maps", "items", "records")
        inventory_repository = str(
            _first(
                payload,
                "repository_url",
                "official_repository_url",
                "source_url",
                "source",
            )
            or repository_url
        )
        inventory_year = _clean(str(_first(payload, "bulletin_year", "catalog_year") or ""))
    else:
        records = payload
        inventory_repository = repository_url
        inventory_year = ""
    if not isinstance(records, list):
        raise ValueError("Inventory must be a list or contain maps, items, or records")
    result: list[tuple[RepositoryEntry, dict[str, Any]]] = []
    for index, record_value in enumerate(records):
        if not isinstance(record_value, dict):
            raise ValueError(f"Inventory record {index} must be an object")
        record = cast(dict[str, Any], record_value)
        year = _clean(
            str(_first(record, "bulletin_year", "catalog_year", "year") or inventory_year)
        )
        source_filename = str(
            _first(record, "pdf_filename", "filename", "document_label", "link_title") or ""
        ).casefold()
        record_keywords = _clean(str(_first(record, "keywords", "tags") or ""))
        plan_format = (
            "accelerated"
            if "asp" in record_keywords.casefold()
            or "3yr" in source_filename
            or "3-yr" in source_filename
            or "accelerated" in source_filename
            else "four_year"
        )
        entry = RepositoryEntry(
            bulletin_year=year,
            college=_clean(str(_first(record, "college", "college_school", "school") or "")),
            department=_clean(str(_first(record, "department", "dept") or "")),
            degree=_clean(str(_first(record, "degree", "program") or "")),
            major=_clean(
                str(
                    _first(
                        record,
                        "major",
                        "major_concentration",
                        "major_name",
                        "name",
                        "title",
                    )
                    or ""
                )
            ),
            pdf_url=str(
                _first(record, "pdf_url", "source_pdf_url", "source_url", "url", "href") or ""
            )
            or None,
            faculty_approver=_clean(str(_first(record, "faculty_approver", "approver") or "")),
            keywords=record_keywords,
            repository_url=str(_first(record, "repository_url") or inventory_repository),
            plan_format=plan_format,
        )
        if not YEAR_RE.fullmatch(year):
            entry.warnings.append("invalid_bulletin_year")
        if not entry.pdf_url:
            entry.warnings.append("missing_pdf_url")
        result.append((entry, record))
    return result


def import_inventory(
    inventory_path: Path,
    *,
    text_root: Path | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Convert previously downloaded PDF text or PDFs without network access."""
    root = text_root or inventory_path.parent
    documents: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    for entry, record in load_inventory(inventory_path):
        source_path_value = _first(
            record,
            "text_path",
            "extracted_text_path",
            "local_text_path",
            "pdf_text_path",
            "local_pdf_path",
            "pdf_path",
            "path",
        )
        if not source_path_value:
            failures.append({"id": entry.id, "reason": "missing_local_source_path"})
            continue
        source_path = Path(str(source_path_value))
        if not source_path.is_absolute():
            source_path = root / source_path
        try:
            if source_path.suffix.casefold() == ".pdf":
                document = parse_major_map_bbox(extract_pdf_bbox(source_path.read_bytes()), entry)
                import_method = "coordinate_aware_pdf_text"
            else:
                text = source_path.read_text(encoding="utf-8", errors="replace")
                document = parse_major_map_text(text, entry)
                import_method = "layout_preserving_pdf_text"
            source = document["source"]
            source["sha256"] = _first(record, "sha256", "pdf_sha256")
            source["page_count"] = _first(record, "page_count", "pages")
            source["retrieved_at"] = _first(record, "retrieved_at", "downloaded_at", "generated_at")
            document["source_url"] = entry.pdf_url
            document["import_metadata"] = {
                "method": import_method,
                "requires_review": document["validation"]["requires_review"],
            }
            errors = validate_map(document)
            if errors:
                failures.append({"id": entry.id, "reason": "validation_failed", "errors": errors})
            else:
                documents.append(document)
        except (OSError, RuntimeError, ValueError) as error:
            failures.append({"id": entry.id, "reason": type(error).__name__, "error": str(error)})
    return documents, failures


def write_import(
    documents: list[dict[str, Any]],
    failures: list[dict[str, Any]],
    output_dir: Path,
    *,
    report_path: Path | None = None,
) -> None:
    """Write one runtime map per repository row and a deterministic review report."""
    output_dir.mkdir(parents=True, exist_ok=True)
    reviews: list[dict[str, Any]] = []
    for document in sorted(documents, key=lambda item: item["id"]):
        year = str(document["catalog_year"])
        destination = output_dir / year / f"{document['id']}.json"
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(
            json.dumps(document, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        if document["validation"]["requires_review"]:
            reviews.append(
                {
                    "id": document["id"],
                    "catalog_year": year,
                    "major": document["major"],
                    "warnings": document["warnings"],
                    "low_confidence_requirement_count": document["validation"][
                        "low_confidence_requirement_count"
                    ],
                    "pdf_url": document["sources"]["pdf_url"],
                }
            )
    report = {
        "schema_version": SCHEMA_VERSION,
        "imported": len(documents),
        "requires_review": len(reviews),
        "reviews": reviews,
        "failures": failures,
    }
    destination = report_path or output_dir.parent / f"{output_dir.name}-review-report.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _download(session: requests.Session, url: str, *, timeout: float) -> bytes:
    response = session.get(url, timeout=timeout)
    response.raise_for_status()
    return response.content


def import_repository(
    repository_url: str,
    *,
    years: set[str] | None = None,
    limit: int | None = None,
    timeout: float = 30,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Download selected repository PDFs and return valid maps plus failures."""
    session = requests.Session()
    session.headers["User-Agent"] = "USC-Course-Scheduler-Major-Map-Importer/1.0"
    repository_html = _download(session, repository_url, timeout=timeout).decode(
        "utf-8", errors="replace"
    )
    entries = parse_repository_html(repository_html, repository_url)
    selected = [entry for entry in entries if not years or entry.bulletin_year in years]
    if limit is not None:
        selected = selected[:limit]
    documents: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    for entry in selected:
        if not entry.pdf_url:
            failures.append({"id": entry.id, "reason": "missing_pdf_url", **entry.as_dict()})
            continue
        try:
            pdf = _download(session, entry.pdf_url, timeout=timeout)
            document = parse_major_map_text(extract_pdf_text(pdf), entry)
            errors = validate_map(document)
            if errors:
                failures.append({"id": entry.id, "reason": "validation_failed", "errors": errors})
            else:
                documents.append(document)
        except (requests.RequestException, RuntimeError, ValueError) as error:
            failures.append(
                {
                    "id": entry.id,
                    "pdf_url": entry.pdf_url,
                    "reason": type(error).__name__,
                    "error": str(error),
                }
            )
    return documents, failures


def _years(values: Iterable[str]) -> set[str]:
    result: set[str] = set()
    for value in values:
        for year in value.split(","):
            year = year.strip()
            if not YEAR_RE.fullmatch(year):
                raise argparse.ArgumentTypeError(f"Invalid bulletin year: {year}")
            result.add(year)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository-url", default=DEFAULT_REPOSITORY_URL)
    parser.add_argument("--inventory", type=Path)
    parser.add_argument("--text-root", type=Path)
    parser.add_argument("--years", nargs="*", default=[])
    parser.add_argument("--limit", type=int)
    parser.add_argument("--timeout", type=float, default=30)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--review-report", type=Path)
    args = parser.parse_args()
    years = _years(args.years) if args.years else None
    if args.inventory:
        documents, failures = import_inventory(args.inventory, text_root=args.text_root)
        if years:
            documents = [document for document in documents if document["catalog_year"] in years]
    else:
        documents, failures = import_repository(
            args.repository_url,
            years=years,
            limit=args.limit,
            timeout=args.timeout,
        )
    write_import(documents, failures, args.output_dir, report_path=args.review_report)
    print(f"Imported {len(documents)} major maps; {len(failures)} failures")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Validate locally imported major maps and emit an auditable JSON report."""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from collections.abc import Mapping
from typing import Any, Iterable, cast
from urllib.parse import urlparse


MAP_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
CATALOG_YEAR_RE = re.compile(r"^(\d{4})-(\d{4})$")
COURSE_CODE_RE = re.compile(r"^[A-Z]{2,8}\s+[A-Z0-9]{3,5}$")
VALID_SEASONS = {"fall", "spring", "summer", "winter"}
REQUIRED_FIELDS = (
    "id",
    "program",
    "major",
    "college",
    "catalog_year",
    "total_credits_required",
    "required_courses",
    "elective_groups",
)
SEQUENCE_KEYS = ("semester_sequence", "semester_plan", "semesters")
COURSE_LIST_KEYS = (
    "options",
    "extra_required",
    "extra_options",
    "prerequisites",
    "corequisites",
    "course_codes",
)
AUDIT_METADATA_KEYS = {"materialization", "normalization"}
FOOTNOTE_ARTIFACT_RE = re.compile(
    r"(?:\b(?:requirement|req\.?|elective|course|language|history|ensemble|core)\s*\d+\b|"
    r"\b\d+\s+\d{3}\);)",
    re.IGNORECASE,
)
ALTERNATIVE_LABEL_RE = re.compile(r"\b(?:choose|select)\b|\s+or\s+", re.IGNORECASE)


@dataclass(slots=True)
class Finding:
    severity: str
    code: str
    message: str
    path: str = "$"

    def as_dict(self) -> dict[str, str]:
        return {
            "severity": self.severity,
            "code": self.code,
            "message": self.message,
            "path": self.path,
        }


@dataclass(slots=True)
class MapAudit:
    file: str
    map_id: str = ""
    findings: list[Finding] = field(default_factory=list)
    course_codes_checked: int = 0
    catalog_matches: int = 0
    catalog_missing: int = 0

    def add(self, severity: str, code: str, message: str, path: str = "$") -> None:
        self.findings.append(Finding(severity, code, message, path))

    def count(self, severity: str) -> int:
        return sum(item.severity == severity for item in self.findings)

    def as_dict(self) -> dict[str, Any]:
        decision = (
            "quarantine"
            if self.count("error")
            else "review"
            if self.count("warning")
            else "publish"
        )
        return {
            "file": self.file,
            "id": self.map_id,
            "status": "invalid"
            if self.count("error")
            else "valid_with_warnings"
            if self.count("warning")
            else "valid",
            "gate": {
                "decision": decision,
                "publishable": decision == "publish",
                "review_required": decision == "review",
                "quarantined": decision == "quarantine",
                "blocking_codes": sorted(
                    {item.code for item in self.findings if item.severity == "error"}
                ),
            },
            "counts": {
                "errors": self.count("error"),
                "warnings": self.count("warning"),
                "info": self.count("info"),
                "course_codes_checked": self.course_codes_checked,
                "catalog_matches": self.catalog_matches,
                "catalog_missing": self.catalog_missing,
            },
            "findings": [finding.as_dict() for finding in self.findings],
        }


def _is_blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _normal_code(value: Any) -> str:
    return " ".join(str(value).upper().split())


def _credit_range(value: Any) -> tuple[float, float] | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        amount = float(value)
        return amount, amount
    if (
        isinstance(value, list)
        and len(value) == 2
        and all(isinstance(item, (int, float)) and not isinstance(item, bool) for item in value)
    ):
        low, high = sorted(float(item) for item in value)
        return low, high
    return None


def _catalog_credit_range(value: Any) -> tuple[float, float] | None:
    if not isinstance(value, str):
        return None
    match = re.search(r"(\d+(?:\.\d+)?)\s*(?:-|–|to)?\s*(\d+(?:\.\d+)?)?\s+Credits?", value)
    if not match:
        return None
    low = float(match.group(1))
    high = float(match.group(2) or match.group(1))
    return min(low, high), max(low, high)


def _iter_course_values(value: Any, path: str = "$") -> Iterable[tuple[str, str]]:
    """Yield course-code values from the supported map structures."""
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}"
            if key in AUDIT_METADATA_KEYS:
                continue
            if key == "code" and isinstance(child, str):
                yield child_path, child
            elif key in COURSE_LIST_KEYS and isinstance(child, list):
                for index, item in enumerate(child):
                    item_path = f"{child_path}[{index}]"
                    if isinstance(item, str):
                        yield item_path, item
                    elif isinstance(item, dict):
                        yield from _iter_course_values(item, item_path)
            else:
                yield from _iter_course_values(child, child_path)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from _iter_course_values(child, f"{path}[{index}]")


def _sequence_rows(payload: dict[str, Any]) -> Iterable[tuple[str, dict[str, Any]]]:
    for key in SEQUENCE_KEYS:
        sequence = payload.get(key)
        if isinstance(sequence, list):
            for semester_index, semester in enumerate(sequence):
                if not isinstance(semester, dict):
                    continue
                courses = semester.get(
                    "courses", semester.get("requirements", semester.get("rows", []))
                )
                if isinstance(courses, list):
                    for row_index, row in enumerate(courses):
                        if isinstance(row, dict):
                            yield f"$.{key}[{semester_index}].courses[{row_index}]", row


def _parse_semester(item: Mapping[str, Any]) -> tuple[int | None, str | None]:
    number = item.get("number", item.get("semester"))
    if number is not None:
        try:
            ordinal = int(number)
        except (TypeError, ValueError):
            return None, None
        return (ordinal + 1) // 2, "fall" if ordinal % 2 else "spring"
    year = item.get("year", item.get("typical_year"))
    season = item.get("term", item.get("season", item.get("typical_semester")))
    try:
        year_value = int(year) if year is not None else None
    except (TypeError, ValueError):
        year_value = None
    season_value = str(season).strip().lower() if season is not None else None
    return year_value, season_value


def _validate_semesters(payload: dict[str, Any], audit: MapAudit) -> None:
    order = {"fall": 0, "winter": 1, "spring": 2, "summer": 3}
    for key in SEQUENCE_KEYS:
        sequence = payload.get(key)
        if sequence is None:
            continue
        if not isinstance(sequence, list):
            audit.add("error", "semester.invalid_type", f"{key} must be a list.", f"$.{key}")
            continue
        previous: tuple[int, int] | None = None
        ordinals: list[int] = []
        for index, semester in enumerate(sequence):
            path = f"$.{key}[{index}]"
            if not isinstance(semester, dict):
                audit.add(
                    "error", "semester.invalid_row", "Semester entries must be objects.", path
                )
                continue
            ordinal = semester.get("number", semester.get("semester"))
            year, season = _parse_semester(cast(Mapping[str, Any], semester))
            if ordinal is not None:
                try:
                    ordinal_value = int(str(ordinal))
                except (TypeError, ValueError):
                    ordinal_value = 0
                if not 1 <= ordinal_value <= 16:
                    audit.add(
                        "error",
                        "semester.invalid_number",
                        "Semester number must be 1 through 16.",
                        path,
                    )
                else:
                    ordinals.append(ordinal_value)
            if year is None or not 1 <= year <= 8:
                audit.add(
                    "error", "semester.invalid_year", "Semester year must be 1 through 8.", path
                )
            if season not in VALID_SEASONS:
                audit.add(
                    "error",
                    "semester.invalid_season",
                    "Semester must identify Fall, Spring, Summer, or Winter.",
                    path,
                )
            if year is not None and season in order:
                current = (year, order[season])
                if previous is not None and current <= previous:
                    audit.add(
                        "error",
                        "semester.out_of_sequence",
                        "Semester entries must be in chronological order without duplicates.",
                        path,
                    )
                previous = current
        if ordinals and ordinals != list(range(1, len(ordinals) + 1)):
            audit.add(
                "error",
                "semester.non_contiguous",
                "Numbered semesters must begin at 1 and remain contiguous.",
                f"$.{key}",
            )

    required_courses = payload.get("required_courses", [])
    placements: dict[str, tuple[int, int]] = {}
    for course in required_courses:
        if not isinstance(course, dict):
            continue
        year, season = _parse_semester(course)
        if year is None or season not in order:
            continue
        code = _normal_code(course.get("code", ""))
        placements[code] = (year, order[season])
    for index, course in enumerate(required_courses):
        if not isinstance(course, dict):
            continue
        code = _normal_code(course.get("code", ""))
        if code not in placements:
            continue
        for prerequisite in course.get("prerequisites", []):
            prereq_code = _normal_code(prerequisite)
            if prereq_code in placements and placements[prereq_code] >= placements[code]:
                audit.add(
                    "warning",
                    "semester.prerequisite_order",
                    f"{prereq_code} is not scheduled before {code}.",
                    f"$.required_courses[{index}]",
                )


def _validate_duplicate_rows(payload: dict[str, Any], audit: MapAudit) -> None:
    required = payload.get("required_courses", [])
    if isinstance(required, list):
        codes = [
            _normal_code(row.get("code", ""))
            for row in required
            if isinstance(row, dict) and row.get("code")
        ]
        for code, count in sorted(Counter(codes).items()):
            if count > 1:
                audit.add(
                    "error",
                    "row.duplicate_required_course",
                    f"Required course {code} appears {count} times.",
                    "$.required_courses",
                )

    signatures: Counter[tuple[str, str]] = Counter()
    signature_paths: dict[tuple[str, str], str] = {}
    for path, row in _sequence_rows(payload):
        semester_path = re.split(r"\.(?:courses|requirements|rows)\[", path, maxsplit=1)[0]
        meaningful = {
            key: value
            for key, value in row.items()
            if key not in {"id", "sequence", "source_text", "confidence", "warnings"}
        }
        signature = json.dumps(meaningful, sort_keys=True, separators=(",", ":"))
        keyed_signature = (semester_path, signature)
        signatures[keyed_signature] += 1
        signature_paths.setdefault(keyed_signature, path)
    for signature, count in signatures.items():
        if count > 1:
            audit.add(
                "error",
                "row.duplicate_semester_row",
                f"An identical semester row appears {count} times.",
                signature_paths[signature],
            )


def _validate_alternative_groups(payload: dict[str, Any], audit: MapAudit) -> None:
    groups = payload.get("elective_groups", [])
    if not isinstance(groups, list):
        return
    for index, group in enumerate(groups):
        if not isinstance(group, dict):
            continue
        path = f"$.elective_groups[{index}]"
        options = group.get("options", [])
        pick = group.get("pick", 1)
        informational = bool(group.get("informational") or group.get("requires_review"))
        if not isinstance(options, list):
            audit.add(
                "error",
                "alternative.invalid_options",
                "Alternative-group options must be a list.",
                f"{path}.options",
            )
            continue
        normalized = [_normal_code(option) for option in options if isinstance(option, str)]
        duplicates = sorted(code for code, count in Counter(normalized).items() if count > 1)
        if duplicates:
            audit.add(
                "error",
                "alternative.duplicate_options",
                f"Alternative group repeats option(s): {', '.join(duplicates)}.",
                f"{path}.options",
            )
        if not isinstance(pick, int) or isinstance(pick, bool) or pick <= 0:
            audit.add(
                "error",
                "alternative.invalid_pick",
                "Alternative-group pick must be a positive integer.",
                f"{path}.pick",
            )
        elif options and pick > len(set(normalized)):
            audit.add(
                "error",
                "alternative.pick_exceeds_options",
                f"Alternative group requires {pick} selections from only "
                f"{len(set(normalized))} unique options.",
                f"{path}.pick",
            )
        label = str(group.get("label") or "")
        if ALTERNATIVE_LABEL_RE.search(label) and not options:
            audit.add(
                "warning" if informational else "error",
                "alternative.unresolved_label",
                "Requirement wording describes a choice, but no structured options were extracted.",
                path,
            )
        if len(options) == 1 and not informational:
            audit.add(
                "warning",
                "alternative.single_option",
                "Alternative group has only one option; confirm that PDF choices were not lost.",
                f"{path}.options",
            )


def _validate_extraction_artifacts(payload: dict[str, Any], audit: MapAudit) -> None:
    def visit(value: Any, path: str, key: str = "") -> None:
        if isinstance(value, dict):
            for child_key, child in value.items():
                visit(child, f"{path}.{child_key}", child_key)
        elif isinstance(value, list):
            for index, child in enumerate(value):
                visit(child, f"{path}[{index}]", key)
        elif key in {"label", "title", "name", "source_text"} and isinstance(value, str):
            if FOOTNOTE_ARTIFACT_RE.search(value):
                audit.add(
                    "warning",
                    "extraction.footnote_artifact",
                    f"Possible PDF footnote marker remains in {value!r}.",
                    path,
                )

    visit(payload, "$")


def _validate_program_metadata(payload: dict[str, Any], audit: MapAudit) -> None:
    concentrations = payload.get("concentrations")
    if concentrations is not None and not isinstance(concentrations, (dict, list)):
        audit.add(
            "error",
            "program.invalid_concentrations",
            "Concentrations must be an object or list.",
            "$.concentrations",
        )
    major = str(payload.get("major") or "").strip()
    program = str(payload.get("program") or "").strip()
    if re.search(r"\bconcentration\b", major, re.IGNORECASE) and not concentrations:
        audit.add(
            "warning",
            "program.concentration_unstructured",
            "The major name mentions a concentration, but no structured concentration is recorded.",
            "$.concentrations",
        )
    parsed = payload.get("parsed_metadata")
    if not isinstance(parsed, dict):
        return
    checks = (
        ("name", major, "major"),
        ("degree", program, "program"),
        ("college", str(payload.get("college") or "").strip(), "college"),
        ("bulletin_year", str(payload.get("catalog_year") or "").strip(), "catalog_year"),
    )
    for metadata_key, declared, declared_key in checks:
        source_value = str(parsed.get(metadata_key) or "").strip()
        if source_value and declared and source_value.casefold() != declared.casefold():
            audit.add(
                "error",
                "program.metadata_mismatch",
                f"Declared {declared_key} {declared!r} conflicts with source metadata "
                f"{source_value!r}.",
                f"$.{declared_key}",
            )
    minimum_hours = parsed.get("minimum_total_hours")
    total = payload.get("total_credits_required")
    if (
        isinstance(minimum_hours, (int, float))
        and not isinstance(minimum_hours, bool)
        and isinstance(total, (int, float))
        and not isinstance(total, bool)
        and abs(float(minimum_hours) - float(total)) > 0.01
    ):
        audit.add(
            "error",
            "credits.official_total_mismatch",
            f"Declared total {float(total):g} conflicts with the official minimum "
            f"{float(minimum_hours):g} in source metadata.",
            "$.total_credits_required",
        )


def _validate_course_credit_consistency(
    payload: dict[str, Any],
    audit: MapAudit,
    catalog_courses: Mapping[str, Mapping[str, Any]] | None = None,
) -> None:
    occurrences: dict[str, list[tuple[str, tuple[float, float]]]] = defaultdict(list)

    def visit(value: Any, path: str) -> None:
        if isinstance(value, dict):
            code = _normal_code(value.get("code", ""))
            credits = _credit_range(
                value.get("credits", value.get("credit_hours", value.get("credits_each")))
            )
            if COURSE_CODE_RE.fullmatch(code) and credits is not None:
                occurrences[code].append((path, credits))
            for key, child in value.items():
                visit(child, f"{path}.{key}")
        elif isinstance(value, list):
            for index, child in enumerate(value):
                visit(child, f"{path}[{index}]")

    visit(payload, "$")
    for code, entries in sorted(occurrences.items()):
        low = max(interval[0] for _, interval in entries)
        high = min(interval[1] for _, interval in entries)
        if low > high:
            rendered = ", ".join(
                f"{interval[0]:g}"
                if interval[0] == interval[1]
                else f"{interval[0]:g}–{interval[1]:g}"
                for _, interval in entries
            )
            audit.add(
                "error",
                "credits.course_conflict",
                f"{code} has conflicting credit values across the map: {rendered}.",
                entries[0][0],
            )
        if not catalog_courses or code not in catalog_courses:
            continue
        catalog_range = _catalog_credit_range(catalog_courses[code].get("hours"))
        if catalog_range is None:
            continue
        for entry_path, interval in entries:
            if interval[1] < catalog_range[0] or interval[0] > catalog_range[1]:
                audit.add(
                    "warning",
                    "credits.catalog_mismatch",
                    f"{code} is {interval[0]:g}–{interval[1]:g} credits in the map but "
                    f"{catalog_range[0]:g}–{catalog_range[1]:g} in the catalog.",
                    entry_path,
                )
                break


def _iter_source_urls(payload: dict[str, Any]) -> Iterable[tuple[str, Any]]:
    source = payload.get("source")
    if isinstance(source, dict):
        yield "$.source.url", source.get("url")
    elif source is not None:
        yield "$.source", None
    for key in ("source_url", "source_urls"):
        value = payload.get(key)
        if isinstance(value, list):
            for index, url in enumerate(value):
                yield f"$.{key}[{index}]", url
        elif value is not None:
            yield f"$.{key}", value
    sources = payload.get("sources")
    if isinstance(sources, list):
        for index, source in enumerate(sources):
            if isinstance(source, str):
                yield f"$.sources[{index}]", source
            elif isinstance(source, dict):
                yield f"$.sources[{index}].url", source.get("url")
    elif isinstance(sources, dict):
        for key, source in sources.items():
            if isinstance(source, str):
                yield f"$.sources.{key}", source
            elif isinstance(source, dict):
                yield f"$.sources.{key}.url", source.get("url")


def _validate_sources(payload: dict[str, Any], audit: MapAudit) -> None:
    source = payload.get("source")
    if source is not None and not isinstance(source, dict):
        audit.add("error", "source.invalid_type", "Source must be an object.", "$.source")
    elif isinstance(source, dict):
        sha256 = source.get("sha256")
        if sha256 is not None and (
            not isinstance(sha256, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", sha256)
        ):
            audit.add(
                "error",
                "source.invalid_sha256",
                "Source SHA-256 must contain 64 hexadecimal characters.",
                "$.source.sha256",
            )
        page_count = source.get("page_count")
        if page_count is not None and (
            not isinstance(page_count, int) or isinstance(page_count, bool) or page_count <= 0
        ):
            audit.add(
                "error",
                "source.invalid_page_count",
                "Source page count must be a positive integer.",
                "$.source.page_count",
            )
        retrieved_at = source.get("retrieved_at")
        if retrieved_at is not None:
            try:
                datetime.fromisoformat(str(retrieved_at).replace("Z", "+00:00"))
            except ValueError:
                audit.add(
                    "error",
                    "source.invalid_retrieved_at",
                    "Source retrieval time must be an ISO 8601 timestamp.",
                    "$.source.retrieved_at",
                )
    urls = list(_iter_source_urls(payload))
    if not urls:
        audit.add(
            "warning",
            "source.missing",
            "No source URL is recorded for independent review.",
        )
        return
    normalized = []
    for path, value in urls:
        if not isinstance(value, str) or not value.strip():
            audit.add("error", "source.invalid_url", "Source URL is empty or not text.", path)
            continue
        parsed = urlparse(value.strip())
        if parsed.scheme != "https" or not parsed.netloc:
            audit.add(
                "error", "source.invalid_url", "Source URL must be an absolute HTTPS URL.", path
            )
        normalized.append(value.strip())
    for url, count in Counter(normalized).items():
        if count > 1:
            audit.add(
                "warning", "source.duplicate_url", f"Source URL is listed {count} times: {url}"
            )
    if isinstance(payload.get("import_metadata"), dict):
        if not isinstance(source, dict):
            audit.add(
                "error",
                "source.import_provenance_missing",
                "Imported maps must record an official source URL and PDF checksum.",
                "$.source",
            )
            return
        blocking_missing = [key for key in ("url", "sha256") if _is_blank(source.get(key))]
        if blocking_missing:
            audit.add(
                "error",
                "source.import_provenance_missing",
                f"Imported map source metadata is missing: {', '.join(blocking_missing)}.",
                "$.source",
            )
        for key, description in (
            ("page_count", "PDF page count"),
            ("retrieved_at", "source retrieval time"),
        ):
            if _is_blank(source.get(key)):
                audit.add(
                    "warning",
                    "source.import_metadata_incomplete",
                    f"Imported map does not record its {description}.",
                    f"$.source.{key}",
                )


def _validate_confidence_record(record: Mapping[str, Any], audit: MapAudit, path: str) -> None:
    confidence = record.get("confidence")
    warnings = record.get("warnings")
    confidence_path = f"{path}.confidence"
    warnings_path = f"{path}.warnings"
    numeric_confidence: float | None = None
    if confidence is not None:
        if isinstance(confidence, (int, float)) and not isinstance(confidence, bool):
            numeric_confidence = float(confidence)
            if not 0 <= numeric_confidence <= 1:
                audit.add(
                    "error",
                    "confidence.out_of_range",
                    "Confidence must be between 0 and 1.",
                    confidence_path,
                )
        elif isinstance(confidence, str) and confidence.lower() not in {"low", "medium", "high"}:
            audit.add(
                "error",
                "confidence.invalid_value",
                "Confidence text must be low, medium, or high.",
                confidence_path,
            )
        elif not isinstance(confidence, str):
            audit.add(
                "error",
                "confidence.invalid_type",
                "Confidence must be a number or low, medium, or high.",
                confidence_path,
            )
    if warnings is not None and not isinstance(warnings, list):
        audit.add("error", "warnings.invalid_type", "Warnings must be a list.", warnings_path)
    elif isinstance(warnings, list):
        for index, warning in enumerate(warnings):
            if (
                not isinstance(warning, (str, dict))
                or _is_blank(warning)
                or isinstance(warning, dict)
                and not warning
            ):
                audit.add(
                    "error",
                    "warnings.invalid_entry",
                    "Warning entries must be non-empty text or objects.",
                    f"{warnings_path}[{index}]",
                )
    low = numeric_confidence is not None and numeric_confidence < 0.75
    low = low or isinstance(confidence, str) and confidence.lower() == "low"
    if low and not warnings:
        audit.add(
            "warning",
            "confidence.low_without_warning",
            "Low-confidence extraction should explain what requires review.",
            warnings_path,
        )


def _validate_confidence(payload: dict[str, Any], audit: MapAudit) -> None:
    confidence = payload.get("confidence")
    provenance_present = any(
        key in payload
        for key in (
            "source",
            "source_url",
            "source_urls",
            "sources",
            "extracted_at",
            "imported_at",
        )
    )
    if provenance_present and confidence is None:
        audit.add(
            "warning",
            "confidence.missing",
            "Imported map has source metadata but no extraction confidence.",
            "$.confidence",
        )
    _validate_confidence_record(payload, audit, "$")

    def visit(value: Any, path: str) -> None:
        if isinstance(value, dict):
            if path != "$" and ("confidence" in value or "warnings" in value):
                _validate_confidence_record(cast(Mapping[str, Any], value), audit, path)
            for key, child in value.items():
                if key in AUDIT_METADATA_KEYS:
                    continue
                visit(child, f"{path}.{key}")
        elif isinstance(value, list):
            for index, child in enumerate(value):
                visit(child, f"{path}[{index}]")

    visit(payload, "$")


def _validate_credit_totals(payload: dict[str, Any], audit: MapAudit) -> None:
    total = payload.get("total_credits_required")
    if not isinstance(total, (int, float)) or isinstance(total, bool) or total <= 0:
        audit.add(
            "error",
            "credits.invalid_total",
            "Total required credits must be a positive number.",
            "$.total_credits_required",
        )
        return
    if total < 30 or total > 300:
        audit.add(
            "warning",
            "credits.unusual_total",
            f"Total required credits ({total:g}) is outside the expected 30–300 range.",
            "$.total_credits_required",
        )
    required_known = 0.0
    for index, course in enumerate(payload.get("required_courses", [])):
        if not isinstance(course, dict):
            continue
        credits = course.get("credits")
        if not isinstance(credits, (int, float)) or isinstance(credits, bool) or credits <= 0:
            audit.add(
                "error",
                "credits.invalid_course",
                "Required-course credits must be a positive number.",
                f"$.required_courses[{index}].credits",
            )
        else:
            required_known += float(credits)
    elective_known = 0.0
    for index, group in enumerate(payload.get("elective_groups", [])):
        if not isinstance(group, dict):
            continue
        credits = group.get("credits_required")
        if credits is not None:
            if not isinstance(credits, (int, float)) or isinstance(credits, bool) or credits < 0:
                audit.add(
                    "error",
                    "credits.invalid_elective_group",
                    "Elective-group required credits must be a non-negative number.",
                    f"$.elective_groups[{index}].credits_required",
                )
            else:
                elective_known += float(credits)
    if required_known > float(total) + 0.01:
        audit.add(
            "error",
            "credits.requirements_exceed_total",
            f"Required-course credits ({required_known:g}) exceed the declared total "
            f"({float(total):g}).",
            "$.total_credits_required",
        )
    elif required_known + elective_known > float(total) + 0.01:
        audit.add(
            "warning",
            "credits.possible_double_count",
            f"Course and elective requirements total {required_known + elective_known:g} credits, "
            f"above the declared {float(total):g}; confirm intentional double-counting.",
            "$.total_credits_required",
        )

    planned_min = 0.0
    planned_max = 0.0
    planned_count = 0
    for key in SEQUENCE_KEYS:
        sequence = payload.get(key)
        if not isinstance(sequence, list):
            continue
        for semester in sequence:
            if not isinstance(semester, dict):
                continue
            planned = semester.get(
                "planned_credit_hours",
                semester.get("credits", semester.get("credit_hours")),
            )
            if isinstance(planned, (int, float)) and not isinstance(planned, bool):
                planned_min += float(planned)
                planned_max += float(planned)
                planned_count += 1
            elif (
                isinstance(planned, list)
                and len(planned) == 2
                and all(
                    isinstance(value, (int, float)) and not isinstance(value, bool)
                    for value in planned
                )
            ):
                planned_min += float(min(planned))
                planned_max += float(max(planned))
                planned_count += 1
        break
    if planned_count and not planned_min <= float(total) <= planned_max:
        rendered = (
            f"{planned_min:g}" if planned_min == planned_max else f"{planned_min:g}–{planned_max:g}"
        )
        audit.add(
            "warning",
            "credits.semester_plan_mismatch",
            f"Semester-plan credits total {rendered}, not the declared {float(total):g}.",
            "$.total_credits_required",
        )


def _validate_required_fields(payload: dict[str, Any], audit: MapAudit) -> None:
    for key in REQUIRED_FIELDS:
        if key not in payload or _is_blank(payload.get(key)):
            audit.add("error", "field.missing", f"Required field {key!r} is missing.", f"$.{key}")
    for key in ("required_courses", "elective_groups"):
        if key in payload and not isinstance(payload[key], list):
            audit.add("error", "field.invalid_type", f"{key} must be a list.", f"$.{key}")
    required_courses = payload.get("required_courses", [])
    if isinstance(required_courses, list):
        for index, course in enumerate(required_courses):
            path = f"$.required_courses[{index}]"
            if not isinstance(course, dict):
                audit.add("error", "row.invalid_type", "Required courses must be objects.", path)
                continue
            for key in ("code", "title", "credits"):
                if key not in course or _is_blank(course.get(key)):
                    audit.add(
                        "error",
                        "field.missing",
                        f"Required-course field {key!r} is missing.",
                        f"{path}.{key}",
                    )
    elective_groups = payload.get("elective_groups", [])
    if isinstance(elective_groups, list):
        group_ids: list[str] = []
        for index, group in enumerate(elective_groups):
            path = f"$.elective_groups[{index}]"
            if not isinstance(group, dict):
                audit.add("error", "row.invalid_type", "Elective groups must be objects.", path)
                continue
            for key in ("id", "label", "credits_required"):
                if key not in group or _is_blank(group.get(key)):
                    audit.add(
                        "error",
                        "field.missing",
                        f"Elective-group field {key!r} is missing.",
                        f"{path}.{key}",
                    )
            group_id = group.get("id")
            if group_id:
                group_ids.append(str(group_id))
        for group_id, count in Counter(group_ids).items():
            if count > 1:
                audit.add(
                    "error",
                    "id.duplicate_elective_group",
                    f"Elective-group ID {group_id!r} appears {count} times.",
                    "$.elective_groups",
                )


def _validate_identity(payload: dict[str, Any], file_path: Path, audit: MapAudit) -> None:
    map_id = str(payload.get("id", "")).strip()
    audit.map_id = map_id
    if map_id and not MAP_ID_RE.fullmatch(map_id):
        audit.add(
            "error", "id.invalid", "Map ID must use lowercase letters, numbers, _ or -.", "$.id"
        )
    if map_id and file_path.stem != map_id:
        audit.add(
            "warning",
            "id.filename_mismatch",
            f"Map ID {map_id!r} does not match filename {file_path.stem!r}.",
            "$.id",
        )
    catalog_year = payload.get("catalog_year")
    if isinstance(catalog_year, str):
        match = CATALOG_YEAR_RE.fullmatch(catalog_year.strip())
        if not match or int(match.group(2)) != int(match.group(1)) + 1:
            audit.add(
                "error",
                "catalog_year.invalid",
                "Catalog year must use consecutive YYYY-YYYY years.",
                "$.catalog_year",
            )
    elif catalog_year is not None:
        audit.add(
            "error",
            "catalog_year.invalid",
            "Catalog year must be text in YYYY-YYYY form.",
            "$.catalog_year",
        )


def load_current_catalog_records(
    static_data_dir: Path,
) -> tuple[dict[str, Mapping[str, Any]], str | None]:
    """Load course records from the catalog release selected by the static manifest."""
    manifest_path = static_data_dir / "manifest.json"
    paths: list[Path] = []
    release_id: str | None = None
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            release_id = str(manifest.get("release_id") or "") or None
            for key, artifact in manifest.get("artifacts", {}).items():
                if key.startswith("catalog/courses/") and isinstance(artifact, dict):
                    relative = artifact.get("url")
                    if isinstance(relative, str):
                        paths.append(static_data_dir / relative)
        except (OSError, json.JSONDecodeError):
            paths = []
    if not paths:
        paths = sorted(static_data_dir.glob("releases/*/catalog/courses/courses-*.json"))
    records: dict[str, Mapping[str, Any]] = {}
    for path in paths:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        courses = payload.get("courses", {}) if isinstance(payload, dict) else {}
        if isinstance(courses, dict):
            for code, course in courses.items():
                if isinstance(course, dict):
                    records[_normal_code(code)] = cast(Mapping[str, Any], course)
        elif isinstance(courses, list):
            for course in courses:
                if isinstance(course, dict) and course.get("code"):
                    records[_normal_code(course["code"])] = cast(Mapping[str, Any], course)
    return records, release_id


def load_current_catalog(static_data_dir: Path) -> tuple[set[str], str | None]:
    """Load course codes from the catalog release selected by the static manifest."""
    records, release_id = load_current_catalog_records(static_data_dir)
    return set(records), release_id


def validate_map(
    path: Path,
    catalog_codes: set[str] | None = None,
    catalog_courses: Mapping[str, Mapping[str, Any]] | None = None,
) -> MapAudit:
    audit = MapAudit(file=str(path))
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        audit.add("error", "json.invalid", f"Invalid JSON at line {exc.lineno}: {exc.msg}")
        return audit
    except OSError as exc:
        audit.add("error", "file.unreadable", str(exc))
        return audit
    if not isinstance(payload, dict):
        audit.add("error", "json.invalid_root", "Major map must contain a JSON object.")
        return audit

    _validate_required_fields(payload, audit)
    _validate_identity(payload, path, audit)
    _validate_credit_totals(payload, audit)
    _validate_semesters(payload, audit)
    _validate_duplicate_rows(payload, audit)
    _validate_alternative_groups(payload, audit)
    _validate_extraction_artifacts(payload, audit)
    _validate_program_metadata(payload, audit)
    _validate_course_credit_consistency(payload, audit, catalog_courses)
    _validate_sources(payload, audit)
    _validate_confidence(payload, audit)

    seen_codes: dict[str, list[str]] = {}
    for code_path, raw_code in _iter_course_values(payload):
        code = _normal_code(raw_code)
        if not COURSE_CODE_RE.fullmatch(code):
            audit.add(
                "error",
                "course.invalid_code",
                f"Invalid course code {raw_code!r}.",
                code_path,
            )
            continue
        seen_codes.setdefault(code, []).append(code_path)
    audit.course_codes_checked = len(seen_codes)
    if catalog_codes:
        for code, paths in sorted(seen_codes.items()):
            if code in catalog_codes:
                audit.catalog_matches += 1
            else:
                audit.catalog_missing += 1
                audit.add(
                    "warning",
                    "catalog.course_missing",
                    f"{code} is not present in the current static catalog.",
                    paths[0],
                )
    if isinstance(payload.get("import_metadata"), dict):
        reviewable_extraction_codes = {
            "credits.invalid_course",
            "credits.invalid_total",
            "credits.course_conflict",
            "credits.requirements_exceed_total",
            "field.missing",
            "id.duplicate_elective_group",
            "row.duplicate_semester_row",
            "semester.non_contiguous",
            "semester.out_of_sequence",
        }
        for finding in audit.findings:
            if finding.severity == "error" and finding.code in reviewable_extraction_codes:
                finding.severity = "warning"
    return audit


def validate_directory(
    maps_dir: Path,
    *,
    static_data_dir: Path | None = None,
) -> dict[str, Any]:
    catalog_codes: set[str] = set()
    catalog_courses: dict[str, Mapping[str, Any]] = {}
    catalog_release: str | None = None
    if static_data_dir is not None:
        catalog_courses, catalog_release = load_current_catalog_records(static_data_dir)
        catalog_codes = set(catalog_courses)
    paths = sorted(maps_dir.rglob("*.json"))
    audits = [validate_map(path, catalog_codes or None, catalog_courses or None) for path in paths]
    ids = Counter(audit.map_id for audit in audits if audit.map_id)
    for map_id, count in ids.items():
        if count > 1:
            for audit in audits:
                if audit.map_id == map_id:
                    audit.add(
                        "error",
                        "id.duplicate",
                        f"Map ID {map_id!r} appears in {count} files.",
                        "$.id",
                    )
    global_findings: list[Finding] = []
    if not paths:
        global_findings.append(
            Finding("error", "directory.no_maps", "No major-map JSON files were found.", "$")
        )
    totals = {
        "maps": len(audits),
        "valid": sum(not audit.count("error") for audit in audits),
        "invalid": sum(bool(audit.count("error")) for audit in audits),
        "errors": sum(audit.count("error") for audit in audits)
        + sum(item.severity == "error" for item in global_findings),
        "warnings": sum(audit.count("warning") for audit in audits),
        "info": sum(audit.count("info") for audit in audits),
        "course_codes_checked": sum(audit.course_codes_checked for audit in audits),
        "catalog_matches": sum(audit.catalog_matches for audit in audits),
        "catalog_missing": sum(audit.catalog_missing for audit in audits),
        "publish": sum(not audit.count("error") and not audit.count("warning") for audit in audits),
        "review": sum(
            not audit.count("error") and bool(audit.count("warning")) for audit in audits
        ),
        "quarantine": sum(bool(audit.count("error")) for audit in audits),
    }
    return {
        "schema_version": 1,
        "generated_at": datetime.now(UTC).isoformat(),
        "maps_directory": str(maps_dir),
        "catalog": {
            "available": bool(catalog_codes),
            "release_id": catalog_release,
            "course_count": len(catalog_codes),
        },
        "findings": [finding.as_dict() for finding in global_findings],
        "summary": totals,
        "gate": {
            "publish_ids": [
                audit.map_id
                for audit in audits
                if not audit.count("error") and not audit.count("warning")
            ],
            "review_ids": [
                audit.map_id
                for audit in audits
                if not audit.count("error") and audit.count("warning")
            ],
            "quarantine_ids": [audit.map_id for audit in audits if audit.count("error")],
        },
        "maps": [audit.as_dict() for audit in audits],
    }


def summary_text(report: dict[str, Any]) -> str:
    summary = report["summary"]
    catalog = report["catalog"]
    catalog_text = (
        f"; catalog {summary['catalog_matches']}/{summary['course_codes_checked']} matched"
        if catalog["available"]
        else "; catalog unavailable"
    )
    return (
        f"Major maps: {summary['maps']} checked, {summary['invalid']} invalid, "
        f"{summary['errors']} errors, {summary['warnings']} warnings{catalog_text}."
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--maps-dir", type=Path, default=Path("data/curated/major_maps"))
    parser.add_argument("--static-data-dir", type=Path, default=Path("static/data"))
    parser.add_argument(
        "--json-output",
        type=Path,
        help="Write the machine-readable report here. Use - for standard output.",
    )
    parser.add_argument(
        "--strict-warnings",
        action="store_true",
        help="Return a failing status when warnings are present.",
    )
    args = parser.parse_args(argv)
    report = validate_directory(args.maps_dir, static_data_dir=args.static_data_dir)
    serialized = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.json_output == Path("-"):
        sys.stdout.write(serialized)
        print(summary_text(report), file=sys.stderr)
    else:
        if args.json_output is not None:
            args.json_output.parent.mkdir(parents=True, exist_ok=True)
            args.json_output.write_text(serialized, encoding="utf-8")
        print(summary_text(report))
    summary = report["summary"]
    return int(bool(summary["errors"] or (args.strict_warnings and summary["warnings"])))


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Normalize high-confidence major-map extraction artifacts and audit ambiguity.

The normalizer is deliberately conservative. Every automatic change records its
before and after values, while potentially meaningful duplicates and unusual
credit ranges remain unchanged and are reported for review.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, cast


GENERIC_LABEL_RE = re.compile(
    r"\b(?:requirement|elective|course|language|history|ensemble|cognate|minor|"
    r"concentration|capstone|practicum|internship|portfolio)\b",
    re.IGNORECASE,
)
FOOTNOTE_SUFFIX_RE = re.compile(r"(?P<label>.*?[A-Za-z)])\s*(?P<note>[3-9]|1[0-3])$")
LEADING_OR_RE = re.compile(r"^\s*(?:\(?\s*)?or\s+", re.IGNORECASE)
COURSE_OR_COURSE_RE = re.compile(
    r"\b[A-Z]{2,8}\s+\d{3}[A-Z]?\b.*?\bor\b.*?\b[A-Z]{2,8}\s+\d{3}[A-Z]?\b",
    re.IGNORECASE,
)
AMBIGUOUS_ALTERNATIVE_RE = re.compile(
    r"\b(?:cross[- ]?listed|placement|consent|prerequisite)\b", re.IGNORECASE
)
PROGRAM_SEPARATOR_RE = re.compile(r"\s+[\-–—]\s+")


@dataclass(frozen=True, slots=True)
class Finding:
    severity: str
    code: str
    path: str
    message: str
    before: Any = None
    after: Any = None

    def as_dict(self) -> dict[str, Any]:
        result = {
            "severity": self.severity,
            "code": self.code,
            "path": self.path,
            "message": self.message,
        }
        if self.before is not None:
            result["before"] = self.before
        if self.after is not None:
            result["after"] = self.after
        return result


def _append_warning(item: dict[str, Any], code: str) -> None:
    item["warnings"] = list(dict.fromkeys([*(item.get("warnings") or []), code]))


def _lower_confidence(item: dict[str, Any], level: str = "low") -> None:
    order = {"high": 2, "medium": 1, "low": 0}
    current = str(item.get("confidence") or "high")
    if order.get(level, 0) < order.get(current, 2):
        item["confidence"] = level


def _same_credit_value(first: Any, second: Any) -> bool:
    return first == second


def _normalize_program_name(metadata: dict[str, Any], findings: list[Finding]) -> None:
    major = str(metadata.get("name") or "").strip()
    program = str(metadata.get("degree") or "").strip()
    if not major or not program:
        return
    pieces = PROGRAM_SEPARATOR_RE.split(major, maxsplit=1)
    if len(pieces) == 2 and pieces[1].casefold() == program.casefold():
        metadata["name"] = pieces[0].strip()
        findings.append(
            Finding(
                "change",
                "program.duplicate_degree_suffix_removed",
                "$.parsed_metadata.name",
                "Removed a degree suffix duplicated in the program field.",
                major,
                metadata["name"],
            )
        )


def _normalize_title(item: dict[str, Any], path: str, findings: list[Finding]) -> None:
    title = str(item.get("title") or "").strip()
    match = FOOTNOTE_SUFFIX_RE.fullmatch(title)
    if not match:
        return
    if item.get("course_codes") or not GENERIC_LABEL_RE.search(match.group("label")):
        _append_warning(item, "possible_footnote_suffix_requires_review")
        _lower_confidence(item, "medium")
        findings.append(
            Finding(
                "warning",
                "title.possible_footnote_suffix",
                f"{path}.title",
                "A numeric suffix may be a PDF footnote, but the title is not safe to alter.",
                title,
            )
        )
        return
    cleaned = match.group("label").rstrip()
    item["title"] = cleaned
    item.setdefault("provenance", {})["original_title"] = title
    item["provenance"]["footnote_marker"] = int(match.group("note"))
    findings.append(
        Finding(
            "change",
            "title.footnote_suffix_removed",
            f"{path}.title",
            "Removed a high-confidence footnote suffix from a generic requirement label.",
            title,
            cleaned,
        )
    )


def _normalize_credit(item: dict[str, Any], path: str, findings: list[Finding]) -> None:
    value = item.get("credit_hours")
    if isinstance(value, list):
        if len(value) != 2 or not all(isinstance(part, int) for part in value):
            _append_warning(item, "malformed_credit_range_requires_review")
            _lower_confidence(item)
            findings.append(
                Finding(
                    "warning",
                    "credits.malformed_range",
                    f"{path}.credit_hours",
                    "Credit range is not a two-integer interval.",
                    value,
                )
            )
            return
        low, high = value
        if low > high:
            item["credit_hours"] = [high, low]
            findings.append(
                Finding(
                    "change",
                    "credits.reversed_range_reordered",
                    f"{path}.credit_hours",
                    "Reordered a reversed credit range.",
                    value,
                    item["credit_hours"],
                )
            )
            low, high = high, low
        if low == high:
            item["credit_hours"] = low
            findings.append(
                Finding(
                    "change",
                    "credits.equal_range_collapsed",
                    f"{path}.credit_hours",
                    "Collapsed an equal credit range to one value.",
                    value,
                    low,
                )
            )
            return
        if low == 0 or high - low > 3 or high > 12:
            _append_warning(item, "unusual_credit_range_requires_review")
            _lower_confidence(item, "medium")
            findings.append(
                Finding(
                    "warning",
                    "credits.unusual_range",
                    f"{path}.credit_hours",
                    "Credit range is plausible but unusual and was preserved for review.",
                    value,
                )
            )
    elif not isinstance(value, int) or value < 0 or value > 18:
        _append_warning(item, "invalid_credit_value_requires_review")
        _lower_confidence(item)
        findings.append(
            Finding(
                "warning",
                "credits.invalid_value",
                f"{path}.credit_hours",
                "Credit value is outside the supported range and was preserved for review.",
                value,
            )
        )


def _merge_explicit_continuations(
    requirements: list[dict[str, Any]], semester_path: str, findings: list[Finding]
) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for index, item in enumerate(requirements):
        path = f"{semester_path}.requirements[{index}]"
        title = str(item.get("title") or "")
        if LEADING_OR_RE.match(title) and normalized:
            previous = normalized[-1]
            if _same_credit_value(previous.get("credit_hours"), item.get("credit_hours")):
                previous_title = str(previous.get("title") or "")
                alternative = LEADING_OR_RE.sub("", title, count=1).strip()
                previous["title"] = f"{previous_title} or {alternative}"
                previous["course_codes"] = list(
                    dict.fromkeys(
                        [*(previous.get("course_codes") or []), *(item.get("course_codes") or [])]
                    )
                )
                previous["relation"] = "choose_one"
                previous["source_text"] = " | ".join(
                    part for part in [previous.get("source_text"), item.get("source_text")] if part
                )
                provenance = previous.setdefault("provenance", {})
                provenance["merged_requirement_ids"] = list(
                    dict.fromkeys(
                        [
                            *(provenance.get("merged_requirement_ids") or [previous.get("id")]),
                            item.get("id"),
                        ]
                    )
                )
                provenance["alternative_labels"] = list(
                    dict.fromkeys([*(provenance.get("alternative_labels") or []), alternative])
                )
                _lower_confidence(previous, "medium")
                findings.append(
                    Finding(
                        "change",
                        "alternative.leading_or_merged",
                        path,
                        "Merged an explicit leading-or continuation into the preceding requirement.",
                        title,
                        previous["title"],
                    )
                )
                continue
            _append_warning(item, "alternative_credit_mismatch_requires_review")
            _lower_confidence(item)
            findings.append(
                Finding(
                    "warning",
                    "alternative.credit_mismatch",
                    path,
                    "A leading-or row has different credits from the preceding row and was preserved.",
                    title,
                )
            )
        normalized.append(item)
    return normalized


def _normalize_inline_alternative(item: dict[str, Any], path: str, findings: list[Finding]) -> None:
    title = str(item.get("title") or "")
    codes = item.get("course_codes") or []
    if (
        len(codes) > 1
        and item.get("relation") != "choose_one"
        and COURSE_OR_COURSE_RE.search(title)
        and not AMBIGUOUS_ALTERNATIVE_RE.search(title)
    ):
        before = item.get("relation")
        item["relation"] = "choose_one"
        findings.append(
            Finding(
                "change",
                "alternative.inline_courses_normalized",
                f"{path}.relation",
                "Classified an explicit course-or-course expression as a choose-one requirement.",
                before,
                "choose_one",
            )
        )


def _flag_duplicate_generics(
    requirements: list[dict[str, Any]], semester_path: str, findings: list[Finding]
) -> None:
    keys = Counter(
        (
            str(item.get("title") or "").casefold(),
            json.dumps(item.get("credit_hours"), sort_keys=True),
        )
        for item in requirements
        if not item.get("course_codes")
    )
    for index, item in enumerate(requirements):
        key = (
            str(item.get("title") or "").casefold(),
            json.dumps(item.get("credit_hours"), sort_keys=True),
        )
        if not item.get("course_codes") and keys[key] > 1:
            _append_warning(item, "possible_duplicate_generic_requirement")
            _lower_confidence(item, "medium")
            findings.append(
                Finding(
                    "warning",
                    "requirement.possible_duplicate_generic",
                    f"{semester_path}.requirements[{index}]",
                    "Repeated generic requirements may be separate credit slots and were preserved.",
                    item.get("title"),
                )
            )


def normalize_components(
    metadata: dict[str, Any], semesters: list[dict[str, Any]]
) -> list[Finding]:
    """Normalize parsed metadata and semester rows in place."""
    findings: list[Finding] = []
    _normalize_program_name(metadata, findings)
    for semester_index, semester in enumerate(semesters):
        semester_path = f"$.semester_plan[{semester_index}]"
        requirements = semester.get("requirements")
        if not isinstance(requirements, list):
            continue
        for index, item in enumerate(requirements):
            if not isinstance(item, dict):
                continue
            item = cast(dict[str, Any], item)
            path = f"{semester_path}.requirements[{index}]"
            _normalize_title(item, path, findings)
            _normalize_credit(item, path, findings)
            _normalize_inline_alternative(item, path, findings)
        normalized = _merge_explicit_continuations(requirements, semester_path, findings)
        semester["requirements"] = normalized
        _flag_duplicate_generics(normalized, semester_path, findings)
    return findings


def normalize_document(
    document: dict[str, Any],
    *,
    runtime_builder: Callable[[dict[str, Any], list[dict[str, Any]]], dict[str, Any]] | None = None,
) -> tuple[dict[str, Any], list[Finding]]:
    """Return a normalized copy of one imported map and its complete audit trail."""
    result = copy.deepcopy(document)
    metadata = result.get("parsed_metadata")
    semesters = result.get("semester_plan")
    if not isinstance(metadata, dict) or not isinstance(semesters, list):
        finding = Finding(
            "error",
            "document.unsupported_shape",
            "$",
            "Imported map must include parsed_metadata and semester_plan.",
        )
        return result, [finding]
    findings = normalize_components(metadata, semesters)
    if runtime_builder is not None:
        result.update(runtime_builder(metadata, semesters))
    result["normalization"] = {
        "schema_version": 1,
        "changes": sum(finding.severity == "change" for finding in findings),
        "warnings": sum(finding.severity == "warning" for finding in findings),
        "findings": [finding.as_dict() for finding in findings],
    }
    return result, findings


def audit_directory(input_dir: Path) -> dict[str, Any]:
    """Dry-run normalization over imported JSON without modifying source files."""
    files = sorted(input_dir.glob("**/*.json"))
    records: list[dict[str, Any]] = []
    code_counts: Counter[str] = Counter()
    for path in files:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            _, findings = normalize_document(payload)
        except (OSError, json.JSONDecodeError) as error:
            findings = [Finding("error", "document.unreadable", "$", str(error))]
        code_counts.update(finding.code for finding in findings)
        if findings:
            records.append(
                {
                    "file": str(path),
                    "changes": sum(item.severity == "change" for item in findings),
                    "warnings": sum(item.severity == "warning" for item in findings),
                    "errors": sum(item.severity == "error" for item in findings),
                    "findings": [item.as_dict() for item in findings],
                }
            )
    return {
        "schema_version": 1,
        "mode": "dry_run",
        "files_scanned": len(files),
        "files_with_findings": len(records),
        "finding_counts": dict(sorted(code_counts.items())),
        "records": records,
    }


def _resolved(path: Path) -> Path:
    return path.expanduser().resolve()


def _assert_disjoint_directories(input_dir: Path, output_dir: Path) -> None:
    source = _resolved(input_dir)
    destination = _resolved(output_dir)
    if source == destination or source in destination.parents or destination in source.parents:
        raise ValueError("Input and output directories must be separate, non-nested locations")


def _default_runtime_builder(
    metadata: dict[str, Any], semesters: list[dict[str, Any]]
) -> dict[str, Any]:
    # Imported lazily because the importer itself uses this normalization module.
    try:
        from scripts.import_major_maps import _runtime_fields
    except ModuleNotFoundError:
        from import_major_maps import _runtime_fields

    return _runtime_fields(metadata, semesters)


def materialize_directory(
    input_dir: Path,
    output_dir: Path,
    *,
    allow_output_overwrite: bool = False,
    runtime_builder: Callable[[dict[str, Any], list[dict[str, Any]]], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Write normalized copies to a disjoint output tree with per-file audit data."""
    _assert_disjoint_directories(input_dir, output_dir)
    source_root = _resolved(input_dir)
    destination_root = _resolved(output_dir)
    builder = runtime_builder or _default_runtime_builder
    files = sorted(source_root.glob("**/*.json"))
    records: list[dict[str, Any]] = []
    code_counts: Counter[str] = Counter()
    written = 0
    failed = 0
    for source_path in files:
        relative_path = source_path.relative_to(source_root)
        destination_path = destination_root / relative_path
        try:
            source_bytes = source_path.read_bytes()
            payload = json.loads(source_bytes)
            normalized, findings = normalize_document(payload, runtime_builder=builder)
            destination_path.parent.mkdir(parents=True, exist_ok=True)
            if destination_path.exists() and not allow_output_overwrite:
                raise FileExistsError(f"Output already exists: {destination_path}")
            normalized["materialization"] = {
                "schema_version": 1,
                "source_file": str(relative_path),
                "source_sha256": hashlib.sha256(source_bytes).hexdigest(),
                "changes": sum(item.severity == "change" for item in findings),
                "warnings": sum(item.severity == "warning" for item in findings),
                "errors": sum(item.severity == "error" for item in findings),
            }
            destination_path.write_text(
                json.dumps(normalized, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            written += 1
            status = "written"
        except (OSError, json.JSONDecodeError, TypeError, ValueError) as error:
            findings = [Finding("error", "document.materialization_failed", "$", str(error))]
            failed += 1
            status = "failed"
        code_counts.update(item.code for item in findings)
        records.append(
            {
                "source_file": str(relative_path),
                "output_file": str(relative_path),
                "status": status,
                "changes": sum(item.severity == "change" for item in findings),
                "warnings": sum(item.severity == "warning" for item in findings),
                "errors": sum(item.severity == "error" for item in findings),
                "findings": [item.as_dict() for item in findings],
            }
        )
    return {
        "schema_version": 1,
        "mode": "materialize",
        "input_dir": str(source_root),
        "output_dir": str(destination_root),
        "files_scanned": len(files),
        "files_written": written,
        "files_failed": failed,
        "finding_counts": dict(sorted(code_counts.items())),
        "records": records,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", type=Path, default=Path("data/maps/imported"))
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument(
        "--allow-output-overwrite",
        action="store_true",
        help="Replace files in the separate output tree; source files remain protected.",
    )
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    if args.output_dir:
        report = materialize_directory(
            args.input_dir,
            args.output_dir,
            allow_output_overwrite=args.allow_output_overwrite,
        )
    else:
        report = audit_directory(args.input_dir)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if report["mode"] == "materialize":
        print(
            f"Materialized {report['files_written']} of {report['files_scanned']} maps; "
            f"{report['files_failed']} failed"
        )
        return 1 if report["files_failed"] else 0
    print(
        f"Audited {report['files_scanned']} maps; "
        f"{report['files_with_findings']} contain normalization findings"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

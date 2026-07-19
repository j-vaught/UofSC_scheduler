"""Materialize imported major-map rows into the evidence-backed output schema."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = ROOT / "schemas/major_map_llm_v1.schema.json"
MANIFEST_PATH = ROOT / "data/maps/source_pdfs/manifest.json"
IMPORTED_ROOT = ROOT / "data/maps/imported"
OUTPUT_ROOT = ROOT / "data/maps/llm_output"

COURSE_RE = re.compile(r"^([A-Z]{2,5})\s+([0-9]{3}[A-Z]?)$")
FOOTNOTE_RE = re.compile(r"(?:[a-z)]|Requirement|Elective|Course)([0-9]{1,2})$")


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _credit_range(value: object) -> dict[str, float | int | None]:
    if isinstance(value, list) and len(value) >= 2:
        minimum = value[0] if isinstance(value[0], (int, float)) else None
        maximum = value[1] if isinstance(value[1], (int, float)) else None
        return {"minimum": minimum, "maximum": maximum}
    if isinstance(value, (int, float)):
        return {"minimum": value, "maximum": value}
    return {"minimum": None, "maximum": None}


def _pdf_pages(pdf_path: Path) -> list[str]:
    result = subprocess.run(
        ["pdftotext", "-layout", str(pdf_path), "-"],
        check=True,
        capture_output=True,
        text=True,
    )
    pages = result.stdout.split("\f")
    if pages and not pages[-1].strip():
        pages.pop()
    return pages


def _normalized_words(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", text.casefold()))


def _evidence_page(text: str, pages: list[str]) -> int:
    compact = " ".join(text.split()).casefold()
    for index, page in enumerate(pages):
        if compact in " ".join(page.split()).casefold():
            return index + 1
    words = _normalized_words(text)
    scores = [len(words & _normalized_words(page)) for page in pages]
    return scores.index(max(scores)) + 1 if scores else 1


def _evidence(text: str, region: str | None, pages: list[str]) -> list[dict[str, Any]]:
    quote = " ".join(str(text or "").split())
    if not quote:
        raise ValueError("Evidence text cannot be empty")
    return [{"page": _evidence_page(quote, pages), "quote": quote, "region": region}]


def _footnotes(pages: list[str]) -> list[dict[str, Any]]:
    """Extract numbered PDF footnotes, preserving wrapped continuation lines."""
    text = "\n".join(pages)
    section = text.split("Graduation Requirements Summary", 1)[-1]
    section = section.split("Program Notes:", 1)[0]
    notes: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for raw in section.splitlines():
        line = " ".join(raw.split()).strip()
        match = re.match(r"^(\d+)\.\s+(.*)$", line)
        if match:
            if current:
                notes.append(current)
            current = {"number": int(match.group(1)), "text": match.group(2)}
        elif current and line:
            current["text"] += " " + line
    if current:
        notes.append(current)
    # Keep numbering deterministic when PDFs repeat markers across wrapped columns.
    result = []
    for index, note in enumerate(notes, 1):
        text_value = f"{index}. {note['text']}"
        result.append(
            {
                "marker": str(index),
                "text": text_value,
                "applies_to": [],
                "evidence": _evidence(text_value, "footnotes", pages),
            }
        )
    return result


def _course_rule(code: str) -> dict[str, str] | None:
    match = COURSE_RE.fullmatch(code.strip().upper())
    if not match:
        return None
    return {"type": "course", "subject": match.group(1), "number": match.group(2)}


def _rule(requirement: dict[str, Any]) -> dict[str, Any]:
    text = str(requirement.get("source_text") or requirement.get("title") or "").strip()
    label = str(requirement.get("title") or text).strip()
    relation = str(requirement.get("relation") or "").casefold()
    courses = [
        rule
        for code in requirement.get("course_codes", [])
        if (rule := _course_rule(str(code))) is not None
    ]

    if relation in {"choose_one", "one_of"} and courses:
        return {
            "type": "unresolved",
            "text": text,
            "reason": "Source presents alternative courses.",
        }
    if relation in {"all_of", "corequisite", "co_requisite"} and courses:
        return {"type": "all_of", "items": courses}
    if len(courses) == 1 and relation not in {"choose_one", "one_of", "any_of"}:
        return courses[0]
    if len(courses) > 1:
        return {"type": "unresolved", "text": text, "reason": "Source presents multiple courses."}

    codes = [str(code) for code in requirement.get("requirement_codes", []) if str(code)]
    if codes and any(token in label.casefold() for token in ("carolina core", "core requirement")):
        return {"type": "attribute", "code": codes[0], "label": label}
    if "elective" in label.casefold():
        return {
            "type": "elective",
            "label": label,
            "subject_filters": [],
            "number_filter": None,
        }
    return {
        "type": "unresolved",
        "text": text,
        "reason": "The source row does not define a uniquely normalizable course rule.",
    }


def _review_flags(requirement: dict[str, Any], rule: dict[str, Any]) -> list[str]:
    flags: set[str] = set()
    warnings = " ".join(str(item) for item in requirement.get("warnings", [])).casefold()
    relation = str(requirement.get("relation") or "").casefold()
    label = str(requirement.get("title") or "")
    if rule["type"] == "unresolved":
        flags.add("missing_context")
    if relation in {"choose_one", "one_of", "any_of"} and rule["type"] == "unresolved":
        flags.add("ambiguous_logic")
    if rule["type"] == "elective":
        flags.add("unresolved_elective_definition")
    if FOOTNOTE_RE.search(label):
        flags.add("footnote_dependency")
    if "ocr" in warnings or "parse" in warnings:
        flags.add("possible_ocr_error")
    if "credit" in warnings:
        flags.add("credit_value_uncertain")
    return sorted(flags)


def _confidence(value: object, has_flags: bool) -> float:
    if isinstance(value, (int, float)):
        result = float(value)
    else:
        result = {"high": 0.95, "medium": 0.8, "low": 0.6}.get(str(value).casefold(), 0.7)
    return min(result, 0.89) if has_flags else result


def _term_and_year(number: int, label: str) -> tuple[str, int | None]:
    lowered = label.casefold()
    if "summer" in lowered:
        return "summer", max(1, (number + 1) // 2)
    if "fall" in lowered:
        return "fall", max(1, (number + 1) // 2)
    if "spring" in lowered:
        return "spring", max(1, (number + 1) // 2)
    return ("fall" if number % 2 else "spring"), (number + 1) // 2


def _format(value: object) -> str:
    normalized = str(value or "").casefold().replace("-", "_")
    return (
        normalized if normalized in {"four_year", "accelerated", "transfer", "other"} else "other"
    )


def _degree_parts(program: object) -> tuple[str | None, str | None]:
    value = str(program or "").strip()
    if not value:
        return None, None
    match = re.search(r"\(([^()]+)\)\s*$", value)
    return value, match.group(1) if match else None


def _concentrations(
    record: dict[str, Any], manifest_row: dict[str, Any], pages: list[str]
) -> list[dict[str, Any]]:
    names: list[str] = []
    manifest_name = manifest_row.get("concentration")
    if isinstance(manifest_name, str) and manifest_name.strip():
        names.append(manifest_name.strip())
    raw = record.get("concentrations")
    if isinstance(raw, dict):
        names.extend(str(name).strip() for name in raw if str(name).strip())
    elif isinstance(raw, list):
        names.extend(str(name).strip() for name in raw if str(name).strip())
    return [
        {"name": name, "explicit": True, "evidence": _evidence(name, "header", pages)}
        for name in dict.fromkeys(names)
    ]


def materialize(
    record: dict[str, Any], manifest_row: dict[str, Any], pages: list[str]
) -> dict[str, Any]:
    semesters: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []
    for semester_index, semester in enumerate(record.get("semester_plan", []), start=1):
        number = int(semester.get("number") or semester_index)
        label = str(semester.get("label") or f"Semester {number}")
        term, academic_year = _term_and_year(number, label)
        requirements: list[dict[str, Any]] = []
        for sequence, source_row in enumerate(semester.get("requirements", []), start=1):
            source_text = str(
                source_row.get("source_text") or source_row.get("title") or ""
            ).strip()
            label_text = str(source_row.get("title") or source_text).strip()
            if not source_text or not label_text:
                raise ValueError(f"{manifest_row['map_id']} has an empty requirement row")
            rule = _rule(source_row)
            flags = _review_flags(source_row, rule)
            requirement = {
                "id": f"semester-{number}-requirement-{sequence}",
                "sequence": sequence,
                "label": label_text,
                "source_text": source_text,
                "credits": _credit_range(source_row.get("credit_hours")),
                "critical": source_row.get("critical"),
                "minimum_grade": source_row.get("minimum_grade"),
                "requirement_codes": [
                    str(code) for code in source_row.get("requirement_codes", []) if str(code)
                ],
                "rule": rule,
                "evidence": _evidence(source_text, label, pages),
                "confidence": _confidence(source_row.get("confidence"), bool(flags)),
                "review_flags": flags,
            }
            requirements.append(requirement)
        if not requirements:
            issues.append(
                {
                    "severity": "error",
                    "code": "empty_semester",
                    "message": f"{label} contains no extracted requirement rows.",
                    "evidence": _evidence(label, label, pages),
                }
            )
        semesters.append(
            {
                "number": number,
                "label": label,
                "academic_year": academic_year,
                "term": term,
                "credits": _credit_range(semester.get("planned_credit_hours")),
                "requirements": requirements,
            }
        )

    if not semesters:
        issues.append(
            {
                "severity": "error",
                "code": "no_semester_plan",
                "message": "No semester plan was extracted from the source PDF.",
                "evidence": _evidence(
                    str(record.get("major") or manifest_row["major"]), "header", pages
                ),
            }
        )
        semesters = [
            {
                "number": 1,
                "label": "Plan extraction unavailable",
                "academic_year": None,
                "term": "unspecified",
                "credits": {"minimum": None, "maximum": None},
                "requirements": [],
            }
        ]

    major = str(record.get("major") or manifest_row["major"])
    degree_name, degree_abbreviation = _degree_parts(
        record.get("program") or manifest_row.get("program")
    )
    has_requirement_flags = any(
        requirement["review_flags"]
        for semester in semesters
        for requirement in semester["requirements"]
    )
    if record.get("warnings"):
        issues.append(
            {
                "severity": "warning",
                "code": "source_import_warning",
                "message": "The deterministic source import reported warnings requiring review.",
                "evidence": _evidence(major, "header", pages),
            }
        )
    status = (
        "blocked"
        if any(issue["severity"] == "error" for issue in issues)
        else ("needs_review" if issues or has_requirement_flags else "ready")
    )
    output = {
        "schema_version": "major-map-llm-v1",
        "map_id": manifest_row["map_id"],
        "source": {
            "pdf_path": manifest_row["local_path"],
            "pdf_url": manifest_row["source_url"],
            "sha256": manifest_row["sha256"],
            "page_count": manifest_row["page_count"],
            "catalog_year": manifest_row["catalog_year"],
        },
        "program": {
            "major": major,
            "degree_name": degree_name,
            "degree_abbreviation": degree_abbreviation,
            "college": record.get("college"),
            "department": record.get("department"),
            "total_credits": _credit_range(record.get("total_credits_required")),
            "concentrations": _concentrations(record, manifest_row, pages),
            "evidence": _evidence(major, "header", pages),
        },
        "plan": {"format": _format(record.get("plan_format")), "semesters": semesters},
        "requirements_outside_plan": [],
        "footnotes": _footnotes(pages),
        "review": {
            "status": status,
            "confidence": 0.6
            if status == "blocked"
            else (0.8 if status == "needs_review" else 0.95),
            "issues": issues,
            "summary": (
                "The source requires review for unresolved or generic curriculum rules."
                if status != "ready"
                else "The structured extraction is complete and internally consistent."
            ),
        },
    }
    Draft202012Validator(_load_json(SCHEMA_PATH)).validate(output)
    return output


def _atomic_write(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary_name = tempfile.mkstemp(
        dir=path.parent, prefix=f"{path.name}.", suffix=".tmp"
    )
    os.close(handle)
    temporary_path = Path(temporary_name)
    try:
        temporary_path.write_text(
            json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", type=int, default=0)
    parser.add_argument("--end", type=int)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    manifest = _load_json(MANIFEST_PATH)["maps"]
    end = args.end if args.end is not None else len(manifest)
    if args.start < 0 or end < args.start or end > len(manifest):
        parser.error(f"range must be within 0..{len(manifest)}")

    for index, manifest_row in enumerate(manifest[args.start : end], start=args.start):
        source_path = (
            IMPORTED_ROOT / manifest_row["catalog_year"] / f"{manifest_row['map_id']}.json"
        )
        output_path = OUTPUT_ROOT / manifest_row["catalog_year"] / f"{manifest_row['map_id']}.json"
        if output_path.exists() and not args.force:
            continue
        pdf_path = ROOT / manifest_row["local_path"]
        if hashlib.sha256(pdf_path.read_bytes()).hexdigest() != manifest_row["sha256"]:
            raise ValueError(f"checksum mismatch for {manifest_row['map_id']}")
        output = materialize(_load_json(source_path), manifest_row, _pdf_pages(pdf_path))
        _atomic_write(output_path, output)
        print(f"{index}: {manifest_row['map_id']}")


if __name__ == "__main__":
    main()

"""Normalize manually extracted major-map records to the canonical JSON schema."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = json.loads((ROOT / "schemas/major_map_llm_v1.schema.json").read_text())
OUTPUT_ROOT = ROOT / "data/maps/llm_output"
MANIFEST_PATH = ROOT / "data/maps/source_pdfs/manifest.json"
RULE_VALIDATOR = Draft202012Validator({"$ref": "#/$defs/rule", "$defs": SCHEMA["$defs"]})
DOCUMENT_VALIDATOR = Draft202012Validator(SCHEMA)


def _unresolved(requirement: dict[str, Any]) -> dict[str, str]:
    text = str(
        requirement.get("source_text")
        or requirement.get("label")
        or requirement.get("rule", {}).get("text")
        or "Unresolved source requirement"
    ).strip()
    return {
        "type": "unresolved",
        "text": text,
        "reason": "The manually extracted source row requires semantic review.",
    }


def normalize_document(document: dict[str, Any], manifest_row: dict[str, Any]) -> bool:
    changed = False
    expected_source = {
        "pdf_path": manifest_row["local_path"],
        "pdf_url": manifest_row["source_url"],
        "sha256": manifest_row["sha256"],
        "page_count": manifest_row["page_count"],
        "catalog_year": manifest_row["catalog_year"],
    }
    if document.get("source") != expected_source:
        document["source"] = expected_source
        changed = True
    plan = document["plan"]
    if plan.get("format") not in {"four_year", "accelerated", "transfer", "other"}:
        plan["format"] = "accelerated"
        changed = True

    review = document["review"]
    if review.get("status") not in {"ready", "needs_review", "blocked"}:
        review["status"] = "needs_review"
        review["confidence"] = min(float(review.get("confidence", 0.8)), 0.8)
        changed = True

    populated_semesters = [
        semester for semester in plan["semesters"] if semester.get("requirements")
    ]
    if populated_semesters != plan["semesters"]:
        plan["semesters"] = populated_semesters
        review["status"] = "needs_review"
        review["confidence"] = min(float(review.get("confidence", 0.8)), 0.7)
        changed = True

    for semester_number, semester in enumerate(plan["semesters"], start=1):
        if semester.get("number") != semester_number:
            semester["number"] = semester_number
            changed = True
        academic_year = semester.get("academic_year")
        if academic_year is not None and not isinstance(academic_year, int):
            semester["academic_year"] = (int(semester["number"]) + 1) // 2
            changed = True
        for requirement_number, requirement in enumerate(semester["requirements"], start=1):
            expected_id = f"semester-{semester_number}-requirement-{requirement_number}"
            if requirement.get("id") != expected_id:
                requirement["id"] = expected_id
                changed = True
            if requirement.get("sequence") != requirement_number:
                requirement["sequence"] = requirement_number
                changed = True
            defaults: dict[str, Any] = {
                "critical": None,
                "minimum_grade": None,
                "requirement_codes": [],
                "confidence": 0.8,
                "review_flags": [],
            }
            for key, value in defaults.items():
                if key not in requirement:
                    requirement[key] = value
                    changed = True
            if list(RULE_VALIDATOR.iter_errors(requirement.get("rule"))):
                requirement["rule"] = _unresolved(requirement)
                flags = set(requirement.get("review_flags", []))
                flags.add("missing_context")
                requirement["review_flags"] = sorted(flags)
                requirement["confidence"] = min(float(requirement.get("confidence", 0.8)), 0.8)
                changed = True

    for outside_index, requirement in enumerate(
        document.get("requirements_outside_plan", []), start=1
    ):
        if "source_text" not in requirement:
            requirement["source_text"] = str(
                requirement.get("text") or requirement.get("label") or "Outside-plan requirement"
            )
            changed = True
        if "label" not in requirement:
            requirement["label"] = requirement["source_text"]
            changed = True
        if "credits" not in requirement:
            requirement["credits"] = {"minimum": None, "maximum": None}
            changed = True
        if "evidence" not in requirement:
            requirement["evidence"] = document["program"].get("evidence", [])[:1]
            changed = True
        if "text" in requirement:
            requirement.pop("text")
            changed = True
        expected_id = f"outside-requirement-{outside_index}"
        if requirement.get("id") != expected_id:
            requirement["id"] = expected_id
            changed = True
        if requirement.get("sequence") != outside_index:
            requirement["sequence"] = outside_index
            changed = True
        defaults = {
            "critical": None,
            "minimum_grade": None,
            "requirement_codes": [],
            "confidence": 0.8,
            "review_flags": [],
        }
        for key, value in defaults.items():
            if key not in requirement:
                requirement[key] = value
                changed = True
        if list(RULE_VALIDATOR.iter_errors(requirement.get("rule"))):
            requirement["rule"] = _unresolved(requirement)
            flags = set(requirement.get("review_flags", []))
            flags.add("missing_context")
            requirement["review_flags"] = sorted(flags)
            changed = True

    for index, footnote in enumerate(document.get("footnotes", []), start=1):
        if not isinstance(footnote, dict):
            continue
        for extra_key in set(footnote) - {"marker", "text", "applies_to", "evidence"}:
            footnote.pop(extra_key)
            changed = True
        if not footnote.get("marker"):
            footnote["marker"] = str(index)
            changed = True
        if "applies_to" not in footnote:
            footnote["applies_to"] = []
            changed = True
        if not footnote.get("evidence"):
            program_evidence = document["program"].get("evidence", [])
            if program_evidence:
                footnote["evidence"] = [program_evidence[0]]
                changed = True

    return changed


def main() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))["maps"]
    manifest_by_id = {row["map_id"]: row for row in manifest}
    changed_count = 0
    for path in sorted(OUTPUT_ROOT.glob("*/*.json")):
        document = json.loads(path.read_text(encoding="utf-8"))
        if normalize_document(document, manifest_by_id[document["map_id"]]):
            path.write_text(
                json.dumps(document, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            changed_count += 1
        errors = sorted(DOCUMENT_VALIDATOR.iter_errors(document), key=lambda item: list(item.path))
        if errors:
            raise ValueError(f"{path}: {errors[0].message}")
    print(f"Normalized {changed_count} of 1295 major-map outputs.")


if __name__ == "__main__":
    main()

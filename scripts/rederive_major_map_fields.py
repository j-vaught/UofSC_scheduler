#!/usr/bin/env python3
"""Recompute derived fields in curated major maps from their semester_plan.

Curated major maps store derived fields that must stay consistent with the
semester_plan: required_courses, elective_groups, validation counts
(requirement_count, low_confidence_requirement_count, semester_count), and the
warnings array entry "expected_exactly_eight_ordered_semesters". This script
recomputes them from the source of truth (semester_plan) and reports any drift.

The script supports two modes: --check (verify, no changes, exit non-zero if
any maps differ) and apply (recompute and rewrite). Both modes report which maps
changed and how many fields were affected.

Re-derivation is a fixed point: running it repeatedly on the same data produces
byte-identical output.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.import_major_maps import _runtime_fields


def load_map(path: Path) -> dict[str, Any]:
    """Load a major map JSON file."""
    return json.loads(path.read_text(encoding="utf-8"))


def save_map(path: Path, data: dict[str, Any]) -> None:
    """Save a major map JSON file with consistent formatting."""
    path.write_text(
        json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def rederive_fields(data: dict[str, Any]) -> dict[str, Any]:
    """Compute derived fields from semester_plan. Returns updated dict."""
    metadata = {
        "name": data.get("major"),
        "degree": data.get("program"),
        "college": data.get("college"),
        "department": data.get("department"),
        "bulletin_year": data.get("catalog_year"),
        "minimum_total_hours": data.get("total_credits_required"),
    }
    semesters = data.get("semester_plan") or []

    # Compute required_courses and elective_groups from semester_plan
    runtime = _runtime_fields(metadata, semesters)

    data["required_courses"] = runtime["required_courses"]
    data["elective_groups"] = runtime["elective_groups"]

    # Compute validation counts and semester_count
    if isinstance(data.get("validation"), dict):
        data["validation"]["requirement_count"] = sum(
            len(s.get("requirements") or []) for s in semesters
        )
        data["validation"]["low_confidence_requirement_count"] = sum(
            1
            for s in semesters
            for i in s.get("requirements") or []
            if i.get("confidence") == "low"
        )
        data["validation"]["semester_count"] = len(semesters)

    # Recompute the "expected_exactly_eight_ordered_semesters" warning.
    # This is derived from semester_plan structure: if the plan has != 8
    # semesters, the warning should be present; otherwise it should be absent.
    # Preserve all other warnings.
    warnings = data.get("warnings") or []
    warnings = [w for w in warnings if w != "expected_exactly_eight_ordered_semesters"]
    if len(semesters) != 8:
        warnings.append("expected_exactly_eight_ordered_semesters")
    data["warnings"] = list(dict.fromkeys(warnings))  # Deduplicate while preserving order

    return data


def compute_diff(old: dict[str, Any], new: dict[str, Any]) -> dict[str, Any]:
    """Identify which derived fields changed. Returns dict of changed field names."""
    changed = {}
    for key in ("required_courses", "elective_groups"):
        if old.get(key) != new.get(key):
            changed[key] = True
    # Check validation fields
    old_val = old.get("validation") or {}
    new_val = new.get("validation") or {}
    for val_key in (
        "requirement_count",
        "low_confidence_requirement_count",
        "semester_count",
    ):
        if old_val.get(val_key) != new_val.get(val_key):
            changed[f"validation.{val_key}"] = True
    # Check warnings array
    if old.get("warnings") != new.get("warnings"):
        changed["warnings"] = True
    return changed


def process_maps(maps_dir: Path, check_only: bool = False) -> tuple[list[str], list[str]]:
    """Process all major maps in maps_dir. Returns (changed_maps, error_maps)."""
    changed_maps = []
    error_maps = []

    for map_path in sorted(maps_dir.rglob("*.json")):
        try:
            original = load_map(map_path)
            rederived = json.loads(json.dumps(original))  # Deep copy
            rederived = rederive_fields(rederived)

            diff = compute_diff(original, rederived)
            if diff:
                changed_maps.append(f"{map_path.name}: {', '.join(sorted(diff.keys()))}")
                if not check_only:
                    save_map(map_path, rederived)
        except Exception as e:
            error_maps.append(f"{map_path.name}: {e}")

    return changed_maps, error_maps


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--maps-dir",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "data" / "curated" / "major_maps",
        help="Directory containing major map JSON files (default: data/curated/major_maps)",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Check mode: report drift but do not modify files; exit non-zero if any maps differ",
    )
    args = parser.parse_args()

    if not args.maps_dir.is_dir():
        print(f"Error: maps directory not found: {args.maps_dir}", file=sys.stderr)
        return 1

    changed, errors = process_maps(args.maps_dir, check_only=args.check)

    # Finding nothing is a failure, not a clean bill of health.
    #
    # This searched one directory deep while the default --maps-dir holds only
    # per-year subdirectories, so the default invocation examined zero files and
    # printed "No drift detected". A checker that cannot find its inputs must say
    # so: reporting success for work it did not do is worse than not running,
    # because it is indistinguishable from a real pass.
    total_maps = len(list(args.maps_dir.rglob("*.json")))
    if total_maps == 0:
        print(f"Error: no major maps found under {args.maps_dir}", file=sys.stderr)
        return 1
    print(f"Processed {total_maps} maps")

    if changed:
        print(f"\n{len(changed)} map(s) require re-derivation:")
        for item in changed:
            print(f"  {item}")

    if errors:
        print(f"\n{len(errors)} map(s) encountered errors:", file=sys.stderr)
        for item in errors:
            print(f"  {item}", file=sys.stderr)
        return 1

    if not changed:
        print("No drift detected; all derived fields are consistent.")
        return 0

    if args.check:
        print("\nRunning in --check mode; no files were modified.")
        return 1  # Non-zero exit to signal drift

    print("\nDerived fields updated.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

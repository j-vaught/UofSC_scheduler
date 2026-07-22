"""Validate key:value major-map extractions against closed vocabularies.

Usage: uv run python tools/llm_import/validate_extraction.py <out_dir> <truth_dir>

Checks, per map:
  1. every Course: code exists in the catalog (trailing qualifiers ignored)
  2. every Code: token is a legend code (slash-joins of legend codes allowed)
  3. Req: numbers are consecutive within each semester
  4. Course blocks carry no Credits:; Slot blocks carry exactly one
  5. per-semester reconciliation: catalog hours for course blocks (min/max over
     alternatives) + printed credits for slot blocks must overlap the header range
  6. row count vs the hand-made truth transcription
"""

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def _load_catalog():
    data = json.load(open(REPO / "data/generated/course_data.json"))
    return {c["code"]: str(c.get("hours") or "") for c in data}


CATALOG = _load_catalog()
LEGEND = {
    "CC-CMW",
    "CC-ARP",
    "CC-SCI",
    "CC-GFL",
    "CC-GHS",
    "CC-GSS",
    "CC-AIU",
    "CC-CMS",
    "CC-INF",
    "CC-VSR",
    "CC-INT",
    "CC",
    "PR",
    "MR",
    "CR",
}
KEYS = {
    "Semester",
    "Credits",
    "Req",
    "Course",
    "Slot",
    "Grade",
    "Code",
    "Level",
    "Offered",
    "Qual",
    "Summary",
    "Total",
    "Major",
    "College",
    "Core",
    "GPA",
    "Note",
    "Hours",
    "From",
    "Rule",
    "Text",
}
COURSE_RE = re.compile(r"^([A-Z]{3,4} \d{3}[A-Z]?)\b")


def catalog_lookup(code):
    """Exact match, else the family of lettered variants (MUSC 111 -> 111A..G)."""
    if code in CATALOG:
        return [CATALOG[code]]
    fam = [v for k, v in CATALOG.items() if k.startswith(code) and k[len(code) :].isalpha()]
    return fam


def hours_range(code):
    nums = [float(x) for e in catalog_lookup(code) for x in re.findall(r"\d+(?:\.\d+)?", e)]
    return (min(nums), max(nums)) if nums else None


def txt_range(t):
    nums = [float(x) for x in re.findall(r"\d+(?:\.\d+)?", t or "")]
    return (min(nums), max(nums)) if nums else None


def parse(text):
    semesters, notes, summary = [], [], {}
    sem = None
    block = None
    section = "sem"
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            block = None
            continue
        m = re.match(r"^([A-Za-z]+):\s*(.*)$", line)
        if not m:
            continue
        key, val = m.group(1), m.group(2)
        if key == "Semester":
            sem = {"name": val, "credits": None, "blocks": []}
            semesters.append(sem)
            section = "sem"
        elif key == "Summary":
            section = "summary"
        elif key == "Note":
            block = {"note": val, "courses": [], "lines": []}
            notes.append(block)
            section = "note"
        elif section == "summary":
            summary[key] = val
        elif key == "Req" and sem:
            section = "sem"
            block = {"req": val, "courses": [], "slots": [], "fields": {}}
            sem["blocks"].append(block)
        elif section == "note" and block is not None:
            if key == "Course":
                block["courses"].append(val)
            block["lines"].append((key, val))
        elif key == "Credits" and sem and block is None:
            sem["credits"] = val
        elif block is not None:
            if key == "Course":
                block["courses"].append(val)
            elif key == "Slot":
                block["slots"].append(val)
            else:
                block["fields"][key] = val
    return semesters, summary, notes


def validate(text, truth=None):
    errs, warns = [], []
    for raw in text.splitlines():
        m = re.match(r"^\s*([A-Za-z]+):", raw)
        if m and m.group(1) not in KEYS:
            errs.append(f"unknown key {m.group(1)!r}")
    semesters, summary, notes = parse(text)

    for sem in semesters:
        nums = []
        for b in sem["blocks"]:
            m = re.match(r"(\d+)", str(b["req"]))
            if m:
                nums.append(int(m.group(1)))
        if nums != list(range(1, len(nums) + 1)):
            errs.append(f"{sem['name']}: Req numbering {nums}")
        lo = hi = 0.0
        for b in sem["blocks"]:
            if b["courses"] and not b["slots"] and "Credits" in b["fields"]:
                warns.append(
                    f"{sem['name']} req {b['req']}: Credits on a Course block (catalog wins)"
                )
            if b["slots"] and not b["courses"] and "Credits" not in b["fields"]:
                errs.append(f"{sem['name']} req {b['req']}: Slot block missing Credits")
            ranges = []
            for c in b["courses"]:
                code_m = COURSE_RE.match(c)
                if not code_m or not catalog_lookup(code_m.group(1)):
                    errs.append(f"{sem['name']} req {b['req']}: unknown course {c!r}")
                else:
                    r = hours_range(code_m.group(1))
                    if r:
                        ranges.append(r)
            # mixed blocks: printed credits stand in for the slot alternatives
            if b["slots"] and "Credits" in b["fields"]:
                r = txt_range(b["fields"]["Credits"])
                if r:
                    ranges.append(r)
            if ranges:
                lo += min(r[0] for r in ranges)
                hi += max(r[1] for r in ranges)
            elif "Credits" in b["fields"]:
                r = txt_range(b["fields"]["Credits"])
                if r:
                    lo += r[0]
                    hi += r[1]
            for tok in re.split(r"[\s,]+", b["fields"].get("Code", "")):
                for sub in tok.split("/"):
                    # accelerated maps print bare codes (CMW == CC-CMW)
                    if sub and sub not in LEGEND and f"CC-{sub}" not in LEGEND:
                        errs.append(f"{sem['name']} req {b['req']}: unknown code {sub!r}")
        declared = txt_range(sem["credits"])
        if declared:
            if hi < declared[0] or lo > declared[1]:
                errs.append(f"{sem['name']}: computed {lo:g}-{hi:g} vs declared {sem['credits']}")

    for n in notes:
        for c in n["courses"]:
            code_m = COURSE_RE.match(c)
            if not code_m or not catalog_lookup(code_m.group(1)):
                errs.append(f"note {n['note']}: unknown course {c!r}")

    counts = {
        "semesters": len(semesters),
        "rows": sum(len(s["blocks"]) for s in semesters),
        "notes": len(notes),
        "summary": len(summary),
    }
    if truth:
        counts["truth_semesters"] = len(truth["sections"])
        counts["truth_rows"] = sum(len(s["rows"]) for s in truth["sections"])
    return errs, warns, counts


def main(out_dir, truth_dir):
    out_dir, truth_dir = Path(out_dir), Path(truth_dir)
    total_errs = 0
    for f in sorted(out_dir.glob("*.txt")):
        truth_f = truth_dir / f"{f.stem}.json"
        truth = json.loads(truth_f.read_text()) if truth_f.exists() else None
        errs, warns, counts = validate(f.read_text(), truth)
        total_errs += len(errs)
        row_note = ""
        if "truth_rows" in counts:
            row_note = (
                f"  sem {counts['semesters']}/{counts['truth_semesters']}"
                f"  rows {counts['rows']}/{counts['truth_rows']}"
            )
        print(
            f"{f.stem:18} errors {len(errs):2} warns {len(warns):2}{row_note}  notes {counts['notes']}"
        )
        for e in errs:
            print(f"    ! {e}")
    print(f"\ntotal errors: {total_errs}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])

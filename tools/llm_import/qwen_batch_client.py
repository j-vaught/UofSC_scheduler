"""Batch extraction of OCR major maps into the key:value import format.

Sends each OCR file to a local vLLM server (Qwen3-32B, thinking disabled)
with a worked-example prompt chosen by input shape: HTML tables use the
standard-plan example, markdown prose uses the accelerated-plan example.

Usage: python3 qwen_batch_client.py [ocr_dir] [out_dir]
"""

import time
from pathlib import Path
import requests

import sys

RAW = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("tools/llm_import/bench/ocr")
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("tools/llm_import/bench/out")
URL = "http://localhost:8801/v1/chat/completions"
MODEL = "Qwen/Qwen3-32B-FP8"

IDS = sorted(p.stem for p in RAW.glob("*.md"))

RULES = """Rules:
- One Req block per table row; numbering restarts at 1 each semester; blank line between blocks.
- Course lines: real catalog codes (SUBJ NUM) only, one line per "or" alternative. Never write credits or titles on Course blocks -- credits are looked up later.
- A row (or an "or" alternative) whose text is not a course code is a Slot line. Copy its label, keep footnote digits as ^n. Any block containing a Slot line keeps the printed credits as a Credits line.
- Grade and Code exactly as printed; omit absent fields. Code holds ONLY requirement codes (CC-CMW, PR, MR, CMW) -- never words. Offered: fall/spring/summer when the row says "fall only" etc.
- Summer terms are semesters too: "Semester: Summer".
- Ignore prerequisites text completely. Skip progression standards, disclaimers, and description paragraphs.
- Use ONLY these keys: Semester, Credits, Req, Course, Slot, Grade, Code, Level, Offered, Qual, Summary, Total, Major, College, Core, GPA, Note, Hours, From, Rule.
- Include every table row. Exclude the code legend. Skip notes that name no courses. Copy only what the page states -- never invent courses or rules.

OCR text to convert:

"""

TABLE_PROMPT = (
    """Convert the OCR text of a university major-map PDF into plain text, exactly as this worked example does. Output only the converted text.

Example OCR input:
<tr><td colspan=8>Semester One (15 Credit Hours)</td></tr>
<tr><td></td><td>ENGL 101 Critical Reading and Composition</td><td>3</td><td>C</td><td></td><td>CC-CMW</td><td>C or better in ENGL 100</td></tr>
<tr><td>!</td><td>MATH 122 Calculus or MATH 141 Calculus I</td><td>3-4</td><td>C</td><td></td><td>CC-ARP</td><td>C or better in MATH 111 or 115 or placement</td></tr>
<tr><td></td><td>BIOL 460 Genetics fall only</td><td>3</td><td>C</td><td>*</td><td>MR</td><td>BIOL 302</td></tr>
<tr><td></td><td>MUSC 354 Music Theory or Music Elective $ ^3 $</td><td>3</td><td>C</td><td></td><td>MR</td><td></td></tr>
<tr><td></td><td>Carolina Core GFL $ ^4 $ or Elective $ ^7 $</td><td>3</td><td></td><td></td><td>CC/PR</td><td></td></tr>
<tr><td></td><td>History Elective $ ^7 $ (300-level or above)</td><td>3</td><td></td><td></td><td>PR</td><td></td></tr>

Graduation Requirements Summary: 120 | 24 | 52-64 | 32-44 | 2.000

Progression Standards: Students must maintain a 2.5 GPA to continue in the program.

4. The Carolina Core provides the common core of knowledge for all students.
6. Major Electives (9 hours): any CSCE course 500 or higher.
7. Electives: choose from HIST 101, 102, 340.

Example output:
Semester: One
Credits: 15

Req: 1
Course: ENGL 101
Grade: C
Code: CC-CMW

Req: 2
Course: MATH 122
Course: MATH 141
Grade: C
Code: CC-ARP

Req: 3
Course: BIOL 460
Grade: C
Code: MR
Offered: fall

Req: 4
Course: MUSC 354
Slot: Music Elective ^3
Credits: 3
Grade: C
Code: MR

Req: 5
Slot: Carolina Core GFL ^4
Slot: Elective ^7
Credits: 3
Code: CC/PR

Req: 6
Slot: History Elective ^7
Credits: 3
Code: PR
Level: 300+

Summary:
Total: 120
Major: 24
College: 52-64
Core: 32-44
GPA: 2.000

Note: 6
Slot: Major Elective
Hours: 9
From: CSCE 500+

Note: 7
Slot: Elective
Course: HIST 101
Course: HIST 102
Course: HIST 340

"""
    + RULES
)

PROSE_PROMPT = (
    """Convert the OCR text of an accelerated university major-map PDF into plain text, exactly as this worked example does. Output only the converted text.

Example OCR input:
## Fall (17-18 hours)

- ENGL 101 Critical Reading and Composition (3, CMW) - C or better required
- MATH 122 (3) or MATH 141 (4) (ARP)
- BIOL 101 and BIOL 101L Biological Principles I (4, SCI)
- Required Major course: CRJU 101 The American Criminal Justice System (3)
- Fine Arts or Humanities course (3)

## Spring (17-18 hours)

- ENGL 102 Rhetoric and Composition (3, CMW, INF)
- Cognate or Minor course (3)

Example output:
Semester: Fall
Credits: 17-18

Req: 1
Course: ENGL 101
Grade: C
Code: CMW

Req: 2
Course: MATH 122
Course: MATH 141
Code: ARP

Req: 3
Course: BIOL 101
Course: BIOL 101L
Code: SCI

Req: 4
Course: CRJU 101

Req: 5
Slot: Fine Arts or Humanities course
Credits: 3

Semester: Spring
Credits: 17-18

Req: 1
Course: ENGL 102
Code: CMW INF

Req: 2
Slot: Cognate or Minor course
Credits: 3

"""
    + RULES
)


def ask(prompt: str, text: str) -> str:
    body = {
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt + text}],
        "max_tokens": 8000,
        "temperature": 0.0,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    r = requests.post(URL, json=body, timeout=900)
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for tid in IDS:
        t0 = time.time()
        try:
            text = (RAW / f"{tid}.md").read_text()
            prompt = TABLE_PROMPT if "<table" in text or "<tr>" in text else PROSE_PROMPT
            reply = ask(prompt, text)
            (OUT / f"{tid}.txt").write_text(reply)
            kind = "table" if prompt is TABLE_PROMPT else "prose"
            print(f"  {tid:16} {kind}  {len(reply):6} chars  {time.time() - t0:5.1f}s", flush=True)
        except Exception as e:
            print(f"  {tid:16} ERROR {str(e)[:120]}", flush=True)


if __name__ == "__main__":
    main()

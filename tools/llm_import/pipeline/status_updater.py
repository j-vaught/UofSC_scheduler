"""Refreshes ~/pipeline/STATUS.txt at a regular interval.

python3 status_updater.py            # loop forever, refresh every 20s
python3 status_updater.py --once      # single pass then exit (used by
                                       # run_all.sh for the final snapshot)
"""

from __future__ import annotations

import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

REFRESH_SECS = float(os.environ.get("STATUS_REFRESH_SECS", "20"))

# run_all.sh writes pids/slots.txt ("tag|label" per line) with whatever GPU
# server slots it actually configured for this run, so this stays correct
# even if GPU/port env overrides change the defaults. Fall back to the
# documented defaults if the manifest isn't there yet (updater started
# before run_all.sh got that far).
DEFAULT_SLOTS = [("gpu1", "GPU1"), ("gpu3", "GPU3"), ("gpu2b", "GPU2 (3rd, post-OCR)")]


def load_slots() -> list[tuple[str, str]]:
    manifest = common.PIDS_DIR / "slots.txt"
    try:
        lines = manifest.read_text().splitlines()
    except OSError:
        return DEFAULT_SLOTS
    slots = []
    for line in lines:
        line = line.strip()
        if not line or "|" not in line:
            continue
        tag, label = line.split("|", 1)
        slots.append((tag, label))
    return slots or DEFAULT_SLOTS


def server_line(tag: str, label: str) -> str:
    pid_file = common.PIDS_DIR / f"vllm_{tag}.pid"
    log_file = common.LOGS_DIR / f"vllm_{tag}.log"
    wpid_file = common.PIDS_DIR / f"worker_{tag}.pid"

    pid = common.read_pid_file(pid_file)
    if pid is None:
        return f"  {label:24} not started"

    alive = common.is_pid_alive(pid)
    ready = False
    if log_file.exists():
        try:
            ready = "Application startup complete" in log_file.read_text()
        except OSError:
            ready = False

    if not alive:
        state = "DEAD (see log)"
    elif ready:
        state = "READY"
    else:
        state = "STARTING"

    wpid = common.read_pid_file(wpid_file)
    wstate = ""
    if wpid is not None:
        wstate = f"  worker pid={wpid} ({'alive' if common.is_pid_alive(wpid) else 'exited'})"

    return f"  {label:24} {state:16} server pid={pid}{wstate}"


def render() -> str:
    total = len(list(common.PDF_DIR.glob("*.pdf")))
    ocr_done = len(list(common.RAW_DIR.glob("*.md")))
    json_done = len(list(common.OUT_DIR.glob("*.json")))
    failed = len(list(common.FAILED_DIR.glob("*.txt")))

    def pct(n: int) -> str:
        return f"{100 * n / total:5.1f}%" if total else "  n/a"

    stage_a_pid = common.read_pid_file(common.PIDS_DIR / "stage_a.pid")
    if stage_a_pid is None:
        stage_a_state = "not started"
    elif common.OCR_DONE_SENTINEL.exists():
        stage_a_state = "DONE (GPU freed)"
    elif common.is_pid_alive(stage_a_pid):
        stage_a_state = f"RUNNING pid={stage_a_pid}"
    else:
        stage_a_state = "EXITED (check logs/stage_a.log)"

    lines = [
        "=== pdf -> json pipeline status ===",
        f"updated: {time.strftime('%Y-%m-%d %H:%M:%S')}",
        f"pipeline dir: {common.PIPELINE_DIR}",
        "",
        f"pdfs total:      {total}",
        f"ocr done (raw):  {ocr_done:5d}  ({pct(ocr_done)})",
        f"json done (out): {json_done:5d}  ({pct(json_done)})",
        f"failed:          {failed:5d}",
        "",
        "--- stage A (OCR) ---",
        f"  {stage_a_state}",
        "",
        "--- stage B servers/workers ---",
    ]
    for tag, label in load_slots():
        lines.append(server_line(tag, label))

    if failed:
        lines += ["", "--- failed maps (first line of each error) ---"]
        for f in sorted(common.FAILED_DIR.glob("*.txt")):
            try:
                first = f.read_text().splitlines()
                first_err = next(
                    (ln for ln in first if ln.startswith("error:")), first[0] if first else ""
                )
            except OSError:
                first_err = "(could not read)"
            lines.append(f"  {f.stem}: {first_err}")

    done = total > 0 and (json_done + failed) >= total and common.OCR_DONE_SENTINEL.exists()
    lines += ["", "RUN COMPLETE" if done else "run in progress..."]
    return "\n".join(lines) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true")
    args = ap.parse_args()

    common.ensure_dirs()
    while True:
        common.atomic_write_text(common.STATUS_FILE, render())
        if args.once:
            return
        time.sleep(REFRESH_SECS)


if __name__ == "__main__":
    main()

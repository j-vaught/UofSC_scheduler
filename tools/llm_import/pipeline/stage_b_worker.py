"""Stage B worker: pull OCR markdown, structure it via a local vLLM server.

Run under the parser-bench venv, one process per vLLM server:

    ~/parser-bench/.venv/bin/python3 stage_b_worker.py --port 8901 --tag gpu1

Reuses ~/parser-bench/qwen3_reason_client.py's PROMPT, extract_json(), and
ask() (same request shape: max_tokens 16000, temperature 0.0, POST to
/v1/chat/completions) unmodified -- only the target URL's port is swapped
per-process so multiple servers can be used concurrently.

Resumable and safe for multiple concurrent workers: claims each stem
atomically via common.claim() before touching it. Polls raw/ continuously
(does not snapshot the list once) since Stage A may still be producing new
files. Exits once Stage A's done-sentinel exists and there is truly no more
pending work left (double-checked to avoid a race at the boundary).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

sys.path.insert(0, os.path.expanduser("~/parser-bench"))
import qwen3_reason_client as ref  # noqa: E402  (PROMPT, extract_json, ask)

POLL_SECS = float(os.environ.get("B_POLL_SECS", "5"))


def log(tag: str, msg: str) -> None:
    print(f"[worker-{tag} {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def pending_stems() -> list[str]:
    out = []
    for md in sorted(common.RAW_DIR.glob("*.md")):
        stem = md.stem
        if (common.OUT_DIR / f"{stem}.json").exists():
            continue
        if (common.FAILED_DIR / f"{stem}.txt").exists():
            continue
        out.append(stem)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--tag", default="worker")
    args = ap.parse_args()

    common.ensure_dirs()
    ref.URL = f"http://localhost:{args.port}/v1/chat/completions"
    log(args.tag, f"starting; PIPELINE_DIR={common.PIPELINE_DIR}; URL={ref.URL}")

    while True:
        work = pending_stems()
        if not work:
            if common.OCR_DONE_SENTINEL.exists():
                # Double-check right before exiting to dodge the race where
                # Stage A finishes a file the instant we observed the
                # sentinel.
                if not pending_stems():
                    log(args.tag, "OCR done and no pending work left -- exiting")
                    return
            time.sleep(POLL_SECS)
            continue

        for stem in work:
            if not common.claim(stem, "json"):
                continue
            out_path = common.OUT_DIR / f"{stem}.json"
            if out_path.exists():
                continue  # finished by a previous (now-stale) claim holder

            t0 = time.time()
            try:
                text = (common.RAW_DIR / f"{stem}.md").read_text()
                reply = ref.ask(text)
                parsed = ref.extract_json(reply)
                if parsed is None:
                    raise ValueError("model reply did not contain parseable JSON")
                common.atomic_write_text(out_path, json.dumps(parsed, indent=2))
                log(args.tag, f"{stem}: ok in {time.time() - t0:.1f}s")
            except Exception as e:  # noqa: BLE001 - isolate per-map failures
                common.write_failure(stem, "llm", e)
                log(args.tag, f"{stem}: FAILED ({e})")


if __name__ == "__main__":
    main()

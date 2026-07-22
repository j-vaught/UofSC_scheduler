"""Shared helpers for the OCR -> LLM-structuring batch pipeline.

Every path is rooted at $PIPELINE_DIR (default: ~/pipeline), so the exact
same code can be pointed at a scratch directory for a dry-run test without
touching the real input/output trees.
"""

from __future__ import annotations

import contextlib
import os
import time
import traceback
from pathlib import Path

PIPELINE_DIR = Path(os.environ.get("PIPELINE_DIR", os.path.expanduser("~/pipeline"))).resolve()

PDF_DIR = PIPELINE_DIR / "pdfs"
RAW_DIR = PIPELINE_DIR / "raw"
OUT_DIR = PIPELINE_DIR / "out"
CLAIMS_DIR = PIPELINE_DIR / "claims"
FAILED_DIR = PIPELINE_DIR / "failed"
LOGS_DIR = PIPELINE_DIR / "logs"
PIDS_DIR = PIPELINE_DIR / "pids"
STATUS_FILE = PIPELINE_DIR / "STATUS.txt"
OCR_DONE_SENTINEL = PIPELINE_DIR / ".ocr_done"

STALE_CLAIM_SECS = 30 * 60  # 30 minutes


def ensure_dirs() -> None:
    for d in (PDF_DIR, RAW_DIR, OUT_DIR, CLAIMS_DIR, FAILED_DIR, LOGS_DIR, PIDS_DIR):
        d.mkdir(parents=True, exist_ok=True)


def all_stems() -> list[str]:
    return sorted(p.stem for p in PDF_DIR.glob("*.pdf"))


def claim(stem: str, stage: str) -> bool:
    """Atomically claim ``stem`` for ``stage`` ('ocr' or 'json').

    True  -> claim acquired (fresh, or reclaimed from a stale >30min lock).
    False -> another worker already holds a live claim; caller should skip.
    """
    lock = CLAIMS_DIR / f"{stage}_{stem}.lock"
    try:
        fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, f"{os.getpid()} {time.time()}\n".encode())
        os.close(fd)
        return True
    except FileExistsError:
        pass

    try:
        age = time.time() - lock.stat().st_mtime
    except FileNotFoundError:
        # Someone else's claim vanished between our open() failing and the
        # stat() -- most likely it just finished. Retry once from scratch.
        return claim(stem, stage)

    if age <= STALE_CLAIM_SECS:
        return False

    # Stale claim (>30 min, no output yet observed by the caller) -- reclaim.
    # If we lose a race to another worker doing the same thing, our O_EXCL
    # below simply fails and we report False, which is safe.
    with contextlib.suppress(FileNotFoundError):
        lock.unlink()
    try:
        fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, f"{os.getpid()} {time.time()}\n".encode())
        os.close(fd)
        return True
    except FileExistsError:
        return False


def atomic_write_text(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + f".tmp{os.getpid()}")
    tmp.write_text(text)
    os.replace(tmp, path)


def write_failure(stem: str, stage: str, exc: BaseException) -> None:
    atomic_write_text(
        FAILED_DIR / f"{stem}.txt",
        f"stage: {stage}\n"
        f"time: {time.strftime('%Y-%m-%d %H:%M:%S')}\n"
        f"error: {exc}\n\n"
        f"{traceback.format_exc()}\n",
    )


def is_pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, PermissionError):
        return False
    except OSError:
        return False
    return True


def read_pid_file(path: Path) -> int | None:
    try:
        return int(path.read_text().strip().split()[0])
    except (FileNotFoundError, ValueError, IndexError):
        return None

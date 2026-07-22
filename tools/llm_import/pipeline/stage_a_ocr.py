"""Stage A: OCR every PDF in pdfs/ into raw/<stem>.md with PaddleOCR-VL.

Run under the paddle-bench venv, pinned to one GPU by the caller:

    CUDA_VISIBLE_DEVICES=<gpu> ~/paddle-bench/.venv/bin/python3 stage_a_ocr.py

Resumable: skips any stem that already has raw/<stem>.md or failed/<stem>.txt.
Polls pdfs/ continuously (does not snapshot the list once) so it also picks
up PDFs that land after this process started. Writes ~/pipeline/.ocr_done
once it has gone idle (no pending work) for OCR_IDLE_EXIT_SECS, then exits so
Stage B can reclaim this GPU for a third worker. If more PDFs show up after
that point, simply re-run run_all.sh -- it is a no-op for finished work and
will restart Stage A for whatever is new.
"""

from __future__ import annotations

import os
import sys
import time

import fitz  # PyMuPDF

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

POLL_SECS = float(os.environ.get("OCR_POLL_SECS", "5"))
IDLE_EXIT_SECS = float(os.environ.get("OCR_IDLE_EXIT_SECS", "300"))
DPI = 200


def log(msg: str) -> None:
    print(f"[stage_a {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def ocr_pdf(pipe, pdf_path) -> str:
    doc = fitz.open(pdf_path)
    md = ""
    try:
        for i, page in enumerate(doc):
            png_path = f"/tmp/_pg_{os.path.basename(pdf_path)}_{i}_{os.getpid()}.png"
            page.get_pixmap(dpi=DPI).save(png_path)
            try:
                for res in pipe.predict(png_path):
                    m = res.markdown
                    text = m.get("markdown_texts") if isinstance(m, dict) else str(m)
                    md += (text or "") + "\n\n"
            finally:
                try:
                    os.remove(png_path)
                except OSError:
                    pass
    finally:
        doc.close()
    return md


def pending_stems() -> list[str]:
    out = []
    for stem in common.all_stems():
        if (common.RAW_DIR / f"{stem}.md").exists():
            continue
        if (common.FAILED_DIR / f"{stem}.txt").exists():
            continue
        out.append(stem)
    return out


def main() -> None:
    common.ensure_dirs()
    common.OCR_DONE_SENTINEL.unlink(missing_ok=True)

    pipe = None  # constructed lazily, once, on first real work
    idle_since: float | None = None

    log(f"starting; PIPELINE_DIR={common.PIPELINE_DIR}")

    while True:
        work = pending_stems()
        if not work:
            if idle_since is None:
                idle_since = time.time()
            elif time.time() - idle_since >= IDLE_EXIT_SECS:
                log(f"idle for {IDLE_EXIT_SECS:.0f}s with no pending PDFs -- done")
                common.atomic_write_text(common.OCR_DONE_SENTINEL, f"{time.time()}\n")
                return
            time.sleep(POLL_SECS)
            continue

        idle_since = None
        for stem in work:
            if not common.claim(stem, "ocr"):
                continue
            if (common.RAW_DIR / f"{stem}.md").exists():
                continue  # finished by a previous (now-stale) claim holder

            pdf_path = common.PDF_DIR / f"{stem}.pdf"
            t0 = time.time()
            try:
                if pipe is None:
                    log("constructing PaddleOCRVL (once)...")
                    from paddleocr import PaddleOCRVL

                    pipe = PaddleOCRVL()
                    log("PaddleOCRVL ready")
                md = ocr_pdf(pipe, pdf_path)
                common.atomic_write_text(common.RAW_DIR / f"{stem}.md", md)
                log(f"{stem}: ok in {time.time() - t0:.1f}s")
            except Exception as e:  # noqa: BLE001 - isolate per-map failures
                common.write_failure(stem, "ocr", e)
                log(f"{stem}: FAILED ({e})")


if __name__ == "__main__":
    main()

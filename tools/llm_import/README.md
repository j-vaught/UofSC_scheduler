# LLM major-map import

Everything needed to turn an official major-map PDF into the plain-text
key:value import format, and to verify the result mechanically. The model is
interchangeable; the format and the validator are the contract.

## The format

One `Req` block per table row. Courses carry only their codes (credits and
titles come from the catalog); placeholders (`Slot`) keep their printed
wording and credits; footnote superscripts survive as `^n` pointers into
`Note` blocks, which always keep the note's verbatim wording in `Text`. The
full specification with worked examples is [PROMPT.txt](PROMPT.txt) — the
prompt *is* the spec, and it is written so a student can paste it into any
chatbot along with their PDF.

Design property worth preserving: every field the model produces is checkable
against a closed vocabulary. Course codes resolve against the 9,732-course
catalog, requirement codes against the 15-code legend, `Level`/`Offered`
against tiny grammars, and each semester's credits reconcile against the
credit hours printed in its header. The model never does arithmetic and never
transcribes anything that can be looked up instead.

## Pieces

| file | role |
|---|---|
| `PROMPT.txt` | Format spec + worked examples. Paste into a chatbot with a map PDF attached. |
| `validate_extraction.py` | Reference validator. Catalog lookup, legend check, per-semester credit reconciliation, `Req` numbering, block-shape rules. |
| `qwen_batch_client.py` | Batch extraction against a local vLLM server, for running whole catalog years. Picks the table or prose example by input shape. |
| `pipeline/` | The two-stage server pipeline: `stage_a_ocr.py` (PaddleOCR-VL, PDF → text) and `stage_b_worker.py` (text → format), with atomic claim files so several workers share one queue. |
| `bench/ocr/` | OCR output for ten benchmark maps chosen to cover edge cases: standard 2026 plans, accelerated prose plans, a scanned multi-plan 2022 document, 2020-vintage maps. |
| `bench/truth/` | Hand-made transcriptions of those ten maps. The row counts the validator reports are measured against these. |
| `bench/results/` | Validated end-to-end outputs. `wgst-2026-chatgpt.txt` is a chatbot run of PROMPT.txt on the Women's and Gender Studies B.A. PDF — zero validator errors, confirmed row-by-row against the source. |

## Running

```
uv run python tools/llm_import/validate_extraction.py <out_dir> tools/llm_import/bench/truth
```

An extraction passes when the validator reports zero errors. Errors are
designed to be *reviewable*, not just countable: an unknown course names the
semester and row, a reconciliation failure names the computed and declared
credit ranges. A map with errors goes to a human with its PDF; a map without
errors was verified against everything the catalog knows.

## What the benchmark established

Ten prompt iterations against the hand-made truths, scored by the validator:

- Worked input→output examples beat rule lists. The model imitates examples
  and under-weights prose rules, so every behaviour that matters is
  demonstrated in the example, not only stated.
- Placeholder rows tempt models to invent plausible course codes (a "Social
  Science" row became `POLS 201` on one run, `POLS 110` on another). No
  prompt wording eliminated this; the catalog lookup catches it every time.
  That is the argument for validator-gating rather than trusting output.
- Notes that grant a whole range ("any CSCE course 500 or higher") must
  become a `From:` line. Asked to list courses, models enumerate the range
  and invent dozens of nonexistent codes.
- Frontier chat models with PDF vision outperform a local 32B reading OCR
  text: the chatbot run produced zero errors on its first attempt, including
  the placeholder rows the local model fabricated on.

Older maps reference courses that no longer exist (`MUSC 216` in the 2020
music map). The validator flags them as unknown; for pre-current catalog
years that is a review signal, not necessarily an extraction error.

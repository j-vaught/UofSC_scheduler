# Major Map LLM Processing Package

This package keeps the official major-map PDFs locally and defines a conservative JSON contract for model-assisted extraction. The source archive contains one PDF path per imported map record, even when multiple records refer to the same official document.

## Local inputs

The archive lives in `data/maps/source_pdfs/<catalog-year>/<map-id>.pdf`. Its manifest is `data/maps/source_pdfs/manifest.json`. Each manifest row contains the map identifier, program metadata, official URL, local path, SHA-256 digest, byte size, page count, and comparisons with the earlier deterministic import.

The expected archive contains 1,295 map records from the 2020-2021 through 2026-2027 catalogs. The 28 repository rows that do not expose an official PDF remain source gaps in `data/major_maps_manifest.json`; they are not fabricated.

Rebuild or resume the archive with the following command.

```bash
uv run python scripts/download_major_map_pdfs.py
```

Existing verified files are reused. Use `--force` only when the official source should be fetched again. A nonzero exit means at least one expected PDF is missing or invalid.

## Model inputs and outputs

For each manifest row, give the model four inputs.

1. The PDF at `local_path`.
2. The matching manifest row.
3. `schemas/major_map_llm_v1.schema.json`.
4. `docs/major_maps/LLM_EXTRACTION_PROMPT.md`.

Write exactly one result to `data/maps/llm_output/<catalog-year>/<map-id>.json`. The output filename and `map_id` must match the manifest. Do not combine multiple maps in one response. Do not let one map influence another map's requirements.

The schema deliberately separates the recommended semester sequence from requirements outside the sequence. Every substantive fact must include page-level evidence. Logical rules are recursive, so the model can preserve combinations such as all of, any of, exactly one of, or a bounded number of choices. Ambiguous wording remains an `unresolved` rule and creates a review issue instead of becoming an invented course.

## Data to retain

Retain the official program name, degree, college, department, catalog year, total credits, explicit concentrations, plan format, ordered semesters, semester credit ranges, every requirement row, critical-course markers, minimum grades, Carolina Core and other requirement codes, elective definitions, course-choice logic, footnotes, and page-level evidence.

Retain the original wording in `source_text` even when a normalized rule is also present. Store course subjects and numbers separately. Keep zero-to-three-credit requirements as ranges rather than converting them to three credits. Keep co-requisite pairs as `all_of` when both are required. Keep a choice between courses as `one_of` or `any_of` according to the exact wording.

Do not retain decorative headers, page numbers as requirements, accessibility boilerplate, approval signatures, repeated university branding, or raw OCR artifacts. Faculty approver names are provenance metadata in the repository, not curriculum requirements, and should not appear in model output.

## Review policy

An output is `ready` only when all eight or otherwise explicitly published semesters are present, credit totals are internally consistent or explained, every requirement has evidence, and no unresolved logic affects degree progress. Mark it `needs_review` when wording, a footnote, a course number, or a credit value is uncertain. Mark it `blocked` when pages are missing, unreadable, or the program identity cannot be established.

The JSON is an extraction artifact, not an authoritative audit. The official PDF remains the source of truth. DegreeWorks can later supplement requirement and concentration data, while the major map remains the source for the recommended semester order.


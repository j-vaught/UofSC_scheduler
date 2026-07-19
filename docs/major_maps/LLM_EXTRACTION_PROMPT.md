# Major Map Extraction Prompt

You are converting one official University of South Carolina major-map PDF into a single JSON document. Return JSON only. The result must validate against `schemas/major_map_llm_v1.schema.json`.

You will receive the PDF and one manifest record. Copy `map_id`, `catalog_year`, `pdf_path`, `pdf_url`, `sha256`, and `page_count` from the manifest exactly. Extract information only from the supplied PDF. Do not use knowledge from other programs, catalogs, websites, or earlier documents.

Preserve the published semester order and every curriculum requirement. Each requirement must contain the cleaned display label, the original source wording, its credit range, critical-course marker, minimum grade, requirement codes, a normalized rule, confidence, review flags, and at least one evidence quote with a one-based PDF page number.

Represent logic exactly. Use `course` for one explicit course. Use `all_of` only when all children are required. Use `one_of` when exactly one alternative must be chosen. Use `any_of` when the source permits one or more alternatives without an exact count. Use `n_of` when the source states a number or range of selections. Use `attribute` for Carolina Core or another coded attribute. Use `elective` only when the PDF defines an elective category or filter. Use `unresolved` when the wording cannot be represented without guessing.

Never turn a general label such as elective, major course, cognate, minor course, Carolina Core requirement, or approved course into a specific course unless the PDF explicitly identifies the allowed course. Never infer prerequisites or corequisites from subject knowledge. Extract them only when the PDF or its footnotes state them. Do not convert a slash, comma, plus sign, or the word “or” into a logical relationship without reading the entire row and relevant footnotes.

Footnote numbers attached to labels are markers, not part of course titles. Remove the marker from the normalized label, preserve the full footnote separately, and list the requirement identifiers to which it applies. Preserve credit ranges exactly. A blank credit cell becomes `null`, not zero. A zero-to-three range remains zero to three.

Concentrations must be explicit. If the map has no concentration, return an empty array. Do not create a concentration named “None.” When a document contains several pathways, retain every explicitly named pathway and identify uncertainty in the review section.

Set requirement confidence between zero and one according to the clarity of the PDF. Confidence below 0.90 requires at least one review flag. Add a review issue whenever the extraction depends on ambiguous layout, broken text, an unreadable symbol, an unresolved footnote, inconsistent totals, or uncertain program metadata.

Before returning the JSON, verify that semester numbers are ordered, identifiers are unique, every evidence page is within the source page count, minimum credits do not exceed maximum credits, logical groups are not empty, and the review status reflects all unresolved issues. Return no prose, Markdown, or code fence around the JSON.


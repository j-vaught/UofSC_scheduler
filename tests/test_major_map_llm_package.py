import json
from pathlib import Path

from jsonschema import Draft202012Validator

from scripts.download_major_map_pdfs import _validate_pdf, discover_sources
from scripts.validate_llm_major_maps import validate_outputs


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def test_discover_sources_preserves_manifest_identifiers(tmp_path: Path) -> None:
    imported = tmp_path / "imported" / "2026-2027" / "map_0123456789abcdef.json"
    _write_json(
        imported,
        {
            "id": "map_0123456789abcdef",
            "catalog_year": "2026-2027",
            "major": "Example Major",
            "program": "Bachelor of Science (B.S.)",
            "concentrations": {},
            "source": {
                "url": "https://example.edu/map.pdf",
                "sha256": "a" * 64,
                "page_count": 2,
            },
        },
    )
    sources = discover_sources(tmp_path / "imported")
    assert len(sources) == 1
    assert sources[0].map_id == "map_0123456789abcdef"
    assert sources[0].relative_path == Path("2026-2027/map_0123456789abcdef.pdf")
    assert sources[0].expected_sha256 == "a" * 64


def test_pdf_validation_rejects_non_pdf_and_missing_eof() -> None:
    _validate_pdf(b"%PDF-1.7\nbody\n%%EOF\n")
    for invalid in (b"not a pdf", b"%PDF-1.7\nbody"):
        try:
            _validate_pdf(invalid)
        except ValueError:
            pass
        else:
            raise AssertionError("invalid PDF was accepted")


def test_schema_and_manifest_cross_checks(tmp_path: Path) -> None:
    schema_path = Path("schemas/major_map_llm_v1.schema.json")
    Draft202012Validator.check_schema(json.loads(schema_path.read_text()))
    map_id = "map_0123456789abcdef"
    source_path = "data/raw/major_map_pdfs/2026-2027/map_0123456789abcdef.pdf"
    manifest_path = tmp_path / "manifest.json"
    _write_json(
        manifest_path,
        {
            "maps": [
                {
                    "map_id": map_id,
                    "catalog_year": "2026-2027",
                    "local_path": source_path,
                    "source_url": "https://example.edu/map.pdf",
                    "sha256": "a" * 64,
                    "page_count": 2,
                }
            ]
        },
    )
    output_dir = tmp_path / "outputs"
    _write_json(
        output_dir / "2026-2027" / f"{map_id}.json",
        {
            "schema_version": "major-map-llm-v1",
            "map_id": map_id,
            "source": {
                "pdf_path": source_path,
                "pdf_url": "https://example.edu/map.pdf",
                "sha256": "a" * 64,
                "page_count": 2,
                "catalog_year": "2026-2027",
            },
            "program": {
                "major": "Example Major",
                "degree_name": "Bachelor of Science",
                "degree_abbreviation": "B.S.",
                "college": "Example College",
                "department": None,
                "total_credits": {"minimum": 120, "maximum": 120},
                "concentrations": [],
                "evidence": [{"page": 1, "quote": "Example Major", "region": "header"}],
            },
            "plan": {
                "format": "four_year",
                "semesters": [
                    {
                        "number": 1,
                        "label": "Semester One",
                        "academic_year": 1,
                        "term": "fall",
                        "credits": {"minimum": 3, "maximum": 3},
                        "requirements": [
                            {
                                "id": "semester-1-requirement-1",
                                "sequence": 1,
                                "label": "ENGL 101",
                                "source_text": "ENGL 101 3 credits",
                                "credits": {"minimum": 3, "maximum": 3},
                                "critical": False,
                                "minimum_grade": None,
                                "requirement_codes": [],
                                "rule": {
                                    "type": "course",
                                    "subject": "ENGL",
                                    "number": "101",
                                },
                                "evidence": [
                                    {
                                        "page": 1,
                                        "quote": "ENGL 101 3 credits",
                                        "region": "semester one",
                                    }
                                ],
                                "confidence": 1,
                                "review_flags": [],
                            }
                        ],
                    }
                ],
            },
            "requirements_outside_plan": [],
            "footnotes": [],
            "review": {
                "status": "needs_review",
                "confidence": 0.8,
                "issues": [],
                "summary": "Minimal test fixture.",
            },
        },
    )
    assert validate_outputs(output_dir, schema_path, manifest_path) == []

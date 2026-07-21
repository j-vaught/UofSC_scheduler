"""Focused tests for incremental major-map release publication."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tools.rebuild_major_map_release import rebuild_major_map_release
from tools.static_release import build_manifest, write_immutable_json


def _active_release(root: Path) -> tuple[Path, dict[str, bytes]]:
    release_id = "old-release"
    release = root / "releases" / release_id
    unchanged_payloads = {
        "grades/courses/CSCE": {"kind": "course_grades", "courses": {}},
        "history/CSCE": {"kind": "offering_history", "courses": {}},
    }
    artifacts = {
        name: write_immutable_json(release, f"{name}.json", payload)
        for name, payload in unchanged_payloads.items()
    }
    artifacts["index"] = write_immutable_json(
        release,
        "index.json",
        {"kind": "static_release_index", "generated_at": "old", "major_map_count": 1},
    )
    artifacts["major-maps/index"] = write_immutable_json(
        release,
        "major-maps/index.json",
        {"kind": "major_map_index", "maps": []},
    )
    artifacts["major-maps/legacy-map"] = write_immutable_json(
        release,
        "major-maps/major-map-legacy-map.json",
        {"id": "legacy-map"},
    )
    manifest = build_manifest(
        release_id=release_id,
        generated_at="old",
        scope={"kind": "full", "campus": "COL"},
        coverage={"grades": {"course_count": 1}, "curriculum": {"map_count": 1}},
        artifacts=artifacts,
        base_url=f"releases/{release_id}",
    )
    manifest_path = root / "manifest.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    content = {
        name: (root / descriptor["url"]).read_bytes()
        for name, descriptor in manifest["artifacts"].items()
        if name in unchanged_payloads
    }
    return manifest_path, content


def _maps(directory: Path) -> None:
    directory.mkdir()
    (directory / "maps.json").write_text(
        json.dumps(
            {
                "maps": [
                    {
                        "id": "computer_science_2026",
                        "major": "Computer Science",
                        "program": "B.S.C.S.",
                        "college": "Engineering and Computing",
                        "catalog_year": "2026-2027",
                        "total_credits_required": 120,
                        "semesters": [],
                    },
                    {
                        "id": "mathematics_2025",
                        "major": "Mathematics",
                        "program": "B.S.",
                        "college": "Arts and Sciences",
                        "catalog_year": "2025-2026",
                        "total_credits_required": 120,
                        "semesters": [],
                    },
                ]
            }
        ),
        encoding="utf-8",
    )


def test_rebuild_preserves_existing_hashes_and_replaces_major_maps(tmp_path: Path) -> None:
    source = tmp_path / "source"
    output = tmp_path / "output"
    manifest_path, old_content = _active_release(source)
    maps = tmp_path / "maps"
    _maps(maps)

    destination, activated, manifest = rebuild_major_map_release(
        active_manifest_path=manifest_path,
        maps_dir=maps,
        output_root=output,
        release_id="maps-20260718",
        generated_at="2026-07-18T12:00:00+00:00",
    )

    assert activated == output / "manifest.json"
    assert json.loads(activated.read_text()) == manifest
    assert manifest["coverage"]["grades"] == {"course_count": 1}
    assert manifest["coverage"]["curriculum"] == {
        "map_count": 2,
        "catalog_years": ["2025-2026", "2026-2027"],
        "program_count": 2,
    }
    assert "major-maps/legacy-map" not in manifest["artifacts"]
    assert set(name for name in manifest["artifacts"] if name.startswith("major-maps/")) == {
        "major-maps/index"
    }
    for name, content in old_content.items():
        descriptor = manifest["artifacts"][name]
        assert (
            descriptor["sha256"]
            == json.loads(manifest_path.read_text())["artifacts"][name]["sha256"]
        )
        assert (output / descriptor["url"]).read_bytes() == content

    index_descriptor = manifest["artifacts"]["major-maps/index"]
    major_map_index = json.loads((output / index_descriptor["url"]).read_text())
    assert len(major_map_index["maps"]) == 2
    for entry in major_map_index["maps"]:
        artifact = entry["artifact"]
        content = (output / artifact["url"]).read_bytes()
        assert len(content) == artifact["bytes"]
        assert destination in (output / artifact["url"]).parents
        bundle = json.loads(content)
        assert bundle["kind"] == "major_map_bundle"
        assert bundle["maps"][artifact["entry_key"]]["id"] == entry["id"]
        assert artifact["bundle_key"].endswith(bundle["catalog_year"])

    assert len({entry["artifact"]["url"] for entry in major_map_index["maps"]}) == 2

    release_index = json.loads((output / manifest["artifacts"]["index"]["url"]).read_text())
    assert release_index["major_map_count"] == 2
    assert release_index["generated_at"] == "2026-07-18T12:00:00+00:00"


def test_corrupt_source_does_not_activate_or_leave_staging(tmp_path: Path) -> None:
    source = tmp_path / "source"
    output = tmp_path / "output"
    manifest_path, _ = _active_release(source)
    active = json.loads(manifest_path.read_text())
    descriptor = active["artifacts"]["grades/courses/CSCE"]
    (source / descriptor["url"]).write_text("corrupt", encoding="utf-8")
    maps = tmp_path / "maps"
    _maps(maps)

    with pytest.raises(ValueError, match="Byte-size mismatch|SHA-256 mismatch"):
        rebuild_major_map_release(
            active_manifest_path=manifest_path,
            maps_dir=maps,
            output_root=output,
            release_id="failed-release",
        )

    assert not (output / "manifest.json").exists()
    assert not (output / "releases" / "failed-release").exists()
    assert list((output / "releases").glob(".failed-release.tmp-*")) == []


def test_manifest_replace_failure_preserves_active_manifest(tmp_path: Path) -> None:
    source = tmp_path / "source"
    manifest_path, _ = _active_release(source)
    maps = tmp_path / "maps"
    _maps(maps)
    original = manifest_path.read_bytes()

    def fail_replace(_source: Path, _destination: Path) -> None:
        raise OSError("injected replacement failure")

    with pytest.raises(OSError, match="injected replacement failure"):
        rebuild_major_map_release(
            active_manifest_path=manifest_path,
            maps_dir=maps,
            output_root=source,
            release_id="unactivated-release",
            manifest_replace=fail_replace,
        )

    assert manifest_path.read_bytes() == original
    assert list(source.glob(".manifest.json.*.tmp")) == []

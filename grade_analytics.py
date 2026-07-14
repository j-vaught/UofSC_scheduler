"""Read-only access to the generated historical grade analytics dataset."""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

DATA_PATH = Path(__file__).resolve().parent / "data" / "grade_analytics.json"
_lock = threading.Lock()
_cache: dict[str, Any] | None = None
_cache_mtime: float | None = None


def _load() -> dict[str, Any]:
    global _cache, _cache_mtime
    if not DATA_PATH.exists():
        return {"meta": {"available": False}, "courses": {}, "professors": {}}
    mtime = DATA_PATH.stat().st_mtime
    with _lock:
        if _cache is None or _cache_mtime != mtime:
            _cache = json.loads(DATA_PATH.read_text(encoding="utf-8"))
            _cache_mtime = mtime
    return _cache


def metadata() -> dict[str, Any]:
    data = _load()
    meta = dict(data.get("meta", {}))
    meta["available"] = DATA_PATH.exists()
    meta["course_count"] = len(data.get("courses", {}))
    meta["professor_count"] = len(data.get("professors", {}))
    return meta


def course(code: str) -> dict[str, Any] | None:
    normalized = " ".join(code.upper().split())
    record = _load().get("courses", {}).get(normalized)
    if record is None:
        return None
    return {"code": normalized, **record}


def professor(professor_id: str) -> dict[str, Any] | None:
    record = _load().get("professors", {}).get(professor_id)
    if record is None:
        return None
    return {"id": professor_id, **record}

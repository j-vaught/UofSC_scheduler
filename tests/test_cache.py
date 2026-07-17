import sqlite3

import cache


def test_json_cache_keys_ignore_object_key_order_and_whitespace():
    first = cache.make_key("https://example.test", '{"criteria": [], "other": {"srcdb": "202608"}}')
    second = cache.make_key("https://example.test", '{"other":{"srcdb":"202608"},"criteria":[]}')

    assert first == second


def test_non_json_cache_keys_remain_distinct():
    assert cache.make_key("https://example.test", "alpha") != cache.make_key(
        "https://example.test", "beta"
    )


def test_cache_operations_are_best_effort_when_database_is_unavailable(monkeypatch):
    def unavailable():
        raise sqlite3.OperationalError("database unavailable")

    monkeypatch.setattr(cache, "_get_conn", unavailable)

    assert cache.get("missing") is None
    assert cache.put("key", b"response") is False
    assert cache.cleanup() is False


def test_cleanup_removes_expired_rows_and_uses_expiry_index(tmp_path, monkeypatch):
    cache._discard_connection()
    monkeypatch.setattr(cache, "DB_PATH", str(tmp_path / "cache.db"))
    try:
        assert cache.put("expired", b"old", ttl=-1) is True
        assert cache.put("current", b"new", ttl=300) is True
        assert cache.cleanup() is True

        conn = cache._get_conn()
        keys = [row[0] for row in conn.execute("SELECT cache_key FROM cache")]
        indexes = [row[1] for row in conn.execute("PRAGMA index_list(cache)")]

        assert keys == ["current"]
        assert "idx_cache_expires_at" in indexes
    finally:
        cache._discard_connection()

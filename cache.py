import hashlib
import json
import os
import sqlite3
import threading
import time

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache.db")

_local = threading.local()

CLEANUP_INTERVAL = 6 * 60 * 60
_maintenance_lock = threading.Lock()
_maintenance_started = False


def _get_conn():
    if not hasattr(_local, "conn"):
        _local.conn = sqlite3.connect(DB_PATH, timeout=15)
        _local.conn.execute("PRAGMA busy_timeout=15000")
        _local.conn.execute("PRAGMA journal_mode=WAL")
        _local.conn.execute("""
            CREATE TABLE IF NOT EXISTS cache (
                cache_key TEXT PRIMARY KEY,
                response BLOB,
                timestamp REAL,
                ttl INTEGER DEFAULT 300
            )
        """)
        _local.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_cache_expires_at ON cache(timestamp + ttl)"
        )
        _local.conn.commit()
    return _local.conn


def _discard_connection():
    conn = getattr(_local, "conn", None)
    if conn is not None:
        try:
            conn.close()
        except sqlite3.Error:
            pass
        del _local.conn


def make_key(url, body):
    try:
        normalized_body = json.dumps(
            json.loads(body),
            sort_keys=True,
            separators=(",", ":"),
        )
    except (json.JSONDecodeError, TypeError):
        normalized_body = str(body)
    raw = f"{url}|{normalized_body}".encode()
    return hashlib.sha256(raw).hexdigest()


def get(key):
    try:
        conn = _get_conn()
        row = conn.execute(
            "SELECT response, timestamp, ttl FROM cache WHERE cache_key = ?", (key,)
        ).fetchone()
        if row is None:
            return None
        response, ts, ttl = row
        if time.time() - ts > ttl:
            conn.execute("DELETE FROM cache WHERE cache_key = ?", (key,))
            conn.commit()
            return None
        return response
    except (OSError, sqlite3.Error):
        _discard_connection()
        return None


def put(key, data, ttl=300):
    try:
        conn = _get_conn()
        conn.execute(
            "INSERT OR REPLACE INTO cache (cache_key, response, timestamp, ttl) VALUES (?, ?, ?, ?)",
            (key, data, time.time(), ttl),
        )
        conn.commit()
    except (OSError, sqlite3.Error):
        _discard_connection()
        return False
    return True


def cleanup():
    try:
        conn = _get_conn()
        conn.execute("DELETE FROM cache WHERE timestamp + ttl < ?", (time.time(),))
        conn.commit()
    except (OSError, sqlite3.Error):
        _discard_connection()
        return False
    return True


def start_maintenance(interval=CLEANUP_INTERVAL):
    """Clean expired rows now and periodically without delaying requests."""
    global _maintenance_started
    with _maintenance_lock:
        if _maintenance_started:
            return
        _maintenance_started = True

    cleanup()

    def maintain():
        while True:
            time.sleep(interval)
            cleanup()

    threading.Thread(target=maintain, name="cache-maintenance", daemon=True).start()

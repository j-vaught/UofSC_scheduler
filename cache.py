import sqlite3
import hashlib
import time
import os
import threading

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache.db')

_local = threading.local()

def _get_conn():
    if not hasattr(_local, 'conn'):
        _local.conn = sqlite3.connect(DB_PATH)
        _local.conn.execute('''
            CREATE TABLE IF NOT EXISTS cache (
                cache_key TEXT PRIMARY KEY,
                response BLOB,
                timestamp REAL,
                ttl INTEGER DEFAULT 300
            )
        ''')
        _local.conn.commit()
    return _local.conn

def make_key(url, body):
    raw = f"{url}|{body}".encode()
    return hashlib.sha256(raw).hexdigest()

def get(key):
    conn = _get_conn()
    row = conn.execute(
        'SELECT response, timestamp, ttl FROM cache WHERE cache_key = ?', (key,)
    ).fetchone()
    if row is None:
        return None
    response, ts, ttl = row
    if time.time() - ts > ttl:
        conn.execute('DELETE FROM cache WHERE cache_key = ?', (key,))
        conn.commit()
        return None
    return response

def put(key, data, ttl=300):
    conn = _get_conn()
    conn.execute(
        'INSERT OR REPLACE INTO cache (cache_key, response, timestamp, ttl) VALUES (?, ?, ?, ?)',
        (key, data, time.time(), ttl)
    )
    conn.commit()

def cleanup():
    conn = _get_conn()
    conn.execute('DELETE FROM cache WHERE (? - timestamp) > ttl', (time.time(),))
    conn.commit()

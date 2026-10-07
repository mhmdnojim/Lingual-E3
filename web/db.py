"""The library's database (SQLite, one file): users, books and reports.

DATA is the folder of everything people add on a website (env LB_DATA_DIR; default web/library):
library.db, secret.key, books/<id>/..., users/<id>/recordings/... It is never in git.
"""
import os
import sqlite3
import threading
import time

WEB = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get('LB_DATA_DIR') or os.path.join(WEB, 'library')
LOCAL_USER = 1  # on this computer (no login) everything belongs to user 1, the admin

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pw TEXT NOT NULL DEFAULT '',
  admin INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,      -- raised to log out everywhere
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  owner INTEGER NOT NULL,
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  about TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT 'en',
  kind TEXT NOT NULL,                      -- text | pdf | images
  visibility TEXT NOT NULL DEFAULT 'private',  -- private | public
  license TEXT NOT NULL DEFAULT '',        -- own | public-domain | cc-by | cc-by-sa | other
  source TEXT NOT NULL DEFAULT '',         -- where it comes from (a link), for public books
  hidden INTEGER NOT NULL DEFAULT 0,       -- hidden by an admin (after a report)
  status TEXT NOT NULL DEFAULT 'new',      -- new | working | ready | error
  error TEXT NOT NULL DEFAULT '',
  pages TEXT NOT NULL DEFAULT '[]',        -- JSON: [{"n": "1", "w": 1200, "h": 1700, "words": 230}]
  bytes INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS books_owner ON books(owner);
CREATE INDEX IF NOT EXISTS books_public ON books(visibility, hidden, status);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  book TEXT NOT NULL,
  user INTEGER,
  ip TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,                    -- copyright | inappropriate | other
  note TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0
);
"""

_lock = threading.RLock()
_conn = None


def conn():
    global _conn
    with _lock:
        if _conn is None:
            os.makedirs(DATA, exist_ok=True)
            c = sqlite3.connect(os.path.join(DATA, 'library.db'), check_same_thread=False)
            c.row_factory = sqlite3.Row
            c.execute('PRAGMA journal_mode=WAL')
            c.executescript(SCHEMA)
            if not c.execute('SELECT 1 FROM users WHERE id = ?', (LOCAL_USER,)).fetchone():
                c.execute("INSERT INTO users (id, email, name, admin, created) VALUES (?, 'local', 'You', 1, ?)",
                          (LOCAL_USER, int(time.time())))
            c.commit()
            _conn = c
        return _conn


def rows(sql, args=()):
    with _lock:
        return [dict(r) for r in conn().execute(sql, args).fetchall()]


def one(sql, args=()):
    with _lock:
        r = conn().execute(sql, args).fetchone()
        return dict(r) if r else None


def run(sql, args=()):
    with _lock:
        c = conn()
        cur = c.execute(sql, args)
        c.commit()
        return cur.lastrowid

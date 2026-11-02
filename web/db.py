"""The library's database (SQLite, one file): users, books, reports and the branches of the library.

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
  branch INTEGER,                          -- the branch of the library it is in (NULL: at the top)
  lang TEXT NOT NULL DEFAULT 'en',
  import_options TEXT NOT NULL DEFAULT '{}',
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
CREATE TABLE IF NOT EXISTS branches (      -- folders of the library, made by admins (branches.py)
  id INTEGER PRIMARY KEY,
  parent INTEGER,                          -- the branch it is in (NULL: a main branch)
  name TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS level_branches (  -- the branch of each level of the disc (web/levels.json)
  level TEXT PRIMARY KEY,
  branch INTEGER,
  seed TEXT NOT NULL DEFAULT ''            -- its "branch" in web/levels.json when it was put there
);
CREATE TABLE IF NOT EXISTS disc_books (    -- a book of the disc an admin renamed or moved
  book TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',          -- '' = its own name
  placed INTEGER NOT NULL DEFAULT 0,       -- 1: in branch (else in the branch of its level)
  branch INTEGER
);
CREATE TABLE IF NOT EXISTS links (         -- a copy of a book: the same book in one more branch, with its own name
  id INTEGER PRIMARY KEY,
  book TEXT NOT NULL,
  branch INTEGER,
  title TEXT NOT NULL DEFAULT '',          -- '' = the book's name
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS links_book ON links(book);
CREATE TABLE IF NOT EXISTS subscription_codes (
  id INTEGER PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  code_hint TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  duration_days INTEGER NOT NULL,
  books TEXT NOT NULL DEFAULT '["*"]',
  created_by INTEGER NOT NULL,
  created INTEGER NOT NULL,
  redeem_until INTEGER NOT NULL DEFAULT 0,
  redeemed_by INTEGER,
  redeemed_at INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  code_id INTEGER NOT NULL UNIQUE,
  books TEXT NOT NULL DEFAULT '["*"]',
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER,
  FOREIGN KEY(code_id) REFERENCES subscription_codes(id)
);
CREATE INDEX IF NOT EXISTS subscriptions_user ON subscriptions(user_id, starts_at, ends_at, revoked);
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
            # Keep existing personal libraries usable as the importer gains options.
            columns = {r[1] for r in c.execute('PRAGMA table_info(books)').fetchall()}
            if 'import_options' not in columns:
                c.execute("ALTER TABLE books ADD COLUMN import_options TEXT NOT NULL DEFAULT '{}'")
            if 'branch' not in columns:
                c.execute('ALTER TABLE books ADD COLUMN branch INTEGER')
            if 'course' in columns:  # (for a while a book had a course and a level: now the branches of them)
                _courses_to_branches(c)
            if not c.execute('SELECT 1 FROM users WHERE id = ?', (LOCAL_USER,)).fetchone():
                c.execute("INSERT INTO users (id, email, name, admin, created) VALUES (?, 'local', 'You', 1, ?)",
                          (LOCAL_USER, int(time.time())))
            c.commit()
            _conn = c
        return _conn


def _courses_to_branches(c):
    now = int(time.time())
    for r in c.execute("SELECT id, course, level FROM books WHERE course != '' OR level != ''").fetchall():
        parent = None
        for name in (n for n in (r['course'], r['level']) if n):
            row = c.execute('SELECT id FROM branches WHERE parent IS ? AND name = ? COLLATE NOCASE', (parent, name)).fetchone()
            parent = row[0] if row else c.execute('INSERT INTO branches (parent, name, created) VALUES (?, ?, ?)',
                                                  (parent, name, now)).lastrowid
        c.execute('UPDATE books SET branch = ? WHERE id = ?', (parent, r['id']))
    for name in ('course', 'level'):
        try:
            c.execute(f'ALTER TABLE books DROP COLUMN {name}')
        except sqlite3.OperationalError:  # (an older SQLite: they stay, unused)
            c.execute(f"UPDATE books SET {name} = ''")


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


def transaction(action):
    """Run a multi-step write atomically while serializing it with other DB calls."""
    with _lock:
        c = conn()
        c.execute('BEGIN IMMEDIATE')
        try:
            result = action(c)
            c.commit()
            return result
        except Exception:
            c.rollback()
            raise


def replace(src, dst, wait=3.0):
    """os.replace(src, dst), waiting a moment if it is refused: on Windows a file cannot be
    replaced while another program has it open — the virus scanner or the search indexer often
    opens a file just written, for a moment."""
    end = time.monotonic() + wait
    while True:
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if time.monotonic() >= end:
                raise
            time.sleep(0.05)

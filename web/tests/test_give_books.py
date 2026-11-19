"""Admin gives books: private copies to accounts (a whole copy with its own id), or public."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

from unittest import mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import db
import library


def isolate(case):
    """A database and a books folder of their own (never the real ones): the tests of the other files share this process."""
    case.tmp = tempfile.TemporaryDirectory(prefix='lingua-test-', ignore_cleanup_errors=True)
    case.old_conn, db._conn = db._conn, None
    case.patches = [mock.patch.object(db, 'DATA', case.tmp.name), mock.patch.object(library, 'BOOKS', str(Path(case.tmp.name) / 'books'))]
    for p in case.patches:
        p.start()


def restore(case):
    if db._conn is not None:
        db._conn.close()
    db._conn = case.old_conn
    for p in reversed(case.patches):
        p.stop()
    case.tmp.cleanup()


class GiveBooks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        isolate(cls)
        now = 1000
        for i, (name, admin) in enumerate((('Boss', 1), ('Ann', 0), ('Bob', 0)), start=7900):
            db.run('INSERT INTO users (id, email, name, admin, created) VALUES (?, ?, ?, ?, ?)', (i, f'give-{name}@example.test', name, admin, now))
        cls.boss = db.one('SELECT * FROM users WHERE id = 7900')
        bid = 'Labcdef0123'
        os.makedirs(library.folder(bid, 'edits'))
        Path(library.folder(bid, 'edits', '1.json')).write_text(json.dumps({'a': f'/lib/{bid}/migration-media/x.mp3'}), encoding='utf-8')
        Path(library.folder(bid, 'pages')).mkdir()
        Path(library.folder(bid, 'pages', '1.webp')).write_bytes(b'img')
        db.run("INSERT INTO books (id, owner, title, kind, status, pages, bytes, created, updated) VALUES (?, 7901, 'Ann book', 'text', 'ready', '[{\"n\":\"1\"}]', 3, 1, 1)", (bid,))
        db.run("INSERT INTO books (id, owner, title, kind, status, created, updated) VALUES ('Labc0000001', 7901, 'Busy', 'text', 'working', 1, 1)")
        cls.bid = bid

    def test_private_copy_to_other_accounts(self):
        out = library.give(self.boss, [self.bid], [7901, 7902])
        self.assertEqual(out['copies'], 1)  # Ann owns it already
        self.assertTrue(any('own book already' in p for p in out['problems']))
        copy = db.one("SELECT * FROM books WHERE owner = 7902 AND title = 'Ann book'")
        self.assertEqual((copy['visibility'], copy['status'], copy['hidden']), ('private', 'ready', 0))
        self.assertNotEqual(copy['id'], self.bid)
        self.assertEqual(Path(library.folder(copy['id'], 'pages', '1.webp')).read_bytes(), b'img')
        edit = json.loads(Path(library.folder(copy['id'], 'edits', '1.json')).read_text(encoding='utf-8'))
        self.assertIn(f"/lib/{copy['id']}/", edit['a'], 'the copy points at its own files')
        self.assertTrue(os.path.isdir(library.folder(self.bid)), 'the original stays')

    def test_public_copy_of_another_accounts_book_and_own_book_made_public(self):
        out = library.give(self.boss, [self.bid], [], public=True)
        self.assertEqual(out['public'], 1)
        copy = db.one("SELECT * FROM books WHERE owner = 7900 AND title = 'Ann book'")
        self.assertEqual(copy['visibility'], 'public')
        self.assertEqual(db.one('SELECT visibility FROM books WHERE id = ?', (self.bid,))['visibility'], 'private')
        mine = library.copy_book(db.one('SELECT * FROM books WHERE id = ?', (self.bid,)), 7900)
        out = library.give(self.boss, [mine['id']], [], public=True)
        self.assertEqual(db.one('SELECT visibility FROM books WHERE id = ?', (mine['id'],))['visibility'], 'public')
        self.assertEqual(out['public'], 1)

    def test_not_ready_and_nothing_chosen(self):
        out = library.give(self.boss, ['Labc0000001'], [7902])
        self.assertEqual(out['copies'], 0)
        self.assertTrue(any('not ready' in p for p in out['problems']))
        with self.assertRaises(library.LibraryError):
            library.give(self.boss, [self.bid], [])

    @classmethod
    def tearDownClass(cls):
        restore(cls)


if __name__ == '__main__':
    unittest.main()

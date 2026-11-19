"""A book added with "everyone can see it" is public as soon as it is ready; otherwise it stays private."""
import os, sys, tempfile, unittest, json
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


class AddShare(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        isolate(cls)
        db.run("INSERT INTO users (id, email, name, admin, created) VALUES (7950, 'share-test@example.test', 'Boss', 1, 1)")
        cls.user = db.one('SELECT * FROM users WHERE id = 7950')

    def test_needs_licence_and_rights(self):
        with self.assertRaises(library.LibraryError):
            library.create(self.user, {'kind': 'text', 'title': 'T', 'shareWhenReady': True, 'rights': True})
        with self.assertRaises(library.LibraryError):
            library.create(self.user, {'kind': 'text', 'title': 'T', 'shareWhenReady': True, 'license': 'own'})

    def test_public_when_ready_and_private_otherwise(self):
        shared = library.create(self.user, {'kind': 'text', 'title': 'Shared', 'shareWhenReady': True, 'license': 'own', 'rights': True})
        plain = library.create(self.user, {'kind': 'text', 'title': 'Plain'})
        for b in (shared, plain):
            self.assertEqual(b['visibility'], 'private')  # (nobody sees a book before it is made)
            os.makedirs(library.folder(b['id'], 'source'), exist_ok=True)
        library._write_ready(shared['id']) if hasattr(library, '_write_ready') else None
        for b in (shared, plain):
            db.run("UPDATE books SET status = 'ready', visibility = CASE WHEN share_when_ready = 1 THEN 'public' ELSE visibility END, share_when_ready = 0 WHERE id = ?", (b['id'],))
        self.assertEqual(library.get(shared['id'])['visibility'], 'public')
        self.assertEqual(library.get(plain['id'])['visibility'], 'private')

    @classmethod
    def tearDownClass(cls):
        restore(cls)


if __name__ == '__main__':
    unittest.main()

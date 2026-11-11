"""A student's computer (web/student.py), against a stand-in website: the login goes to the
website with this computer's device id and its cookie is kept; the account is checked (the lease,
the features); locked when the website is not reached and the lease is over, or the clock was
moved back, or nobody is logged in; a book is downloaded into the local library with its pages,
text, audio, play buttons and scripts; the list says which books are here; logging out clears it.

Run: python -m unittest web/tests/test_student.py
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlsplit

from PIL import Image

WEB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WEB / 'tools'))
sys.path.insert(0, str(WEB))
import auth  # noqa: E402
import db  # noqa: E402
import library  # noqa: E402
import student  # noqa: E402
import transcription  # noqa: E402

BOOK = 'L0000000001'
MP3 = 'a' * 64 + '.mp3'
SRC = f'/lib/{BOOK}/migration-media/{MP3}'
SEEN = []


def webp():
    out = io.BytesIO()
    Image.new('RGB', (40, 60), (200, 200, 200)).save(out, 'WEBP')
    return out.getvalue()


class Site(BaseHTTPRequestHandler):
    """The website: one account (ann / secret-123), one shared book of one page with a recording."""
    reach = True

    def answer(self):
        if not Site.reach:
            self.connection.close()
            return
        url = urlsplit(self.path)
        SEEN.append((self.command, self.path, self.headers.get('Cookie', ''), self.headers.get('User-Agent', '')))
        n = int(self.headers.get('Content-Length') or 0)
        body = json.loads(self.rfile.read(n) or b'{}') if n else {}
        logged = self.headers.get('Cookie') == 'lb_session=ann-cookie'
        if url.path == '/api/login':
            if body.get('email') == 'ann@example.com' and body.get('password') == 'secret-123' and len(str(body.get('device', ''))) == 32:
                return self.send(200, {'ok': True, 'user': {'id': 2, 'name': 'Ann', 'email': 'ann@example.com', 'admin': False, 'role': 'user'}},
                                 [('Set-Cookie', 'lb_session=ann-cookie; Path=/; HttpOnly')])
            return self.send(400, {'error': 'Wrong e-mail or password.'})
        if url.path == '/api/logout':
            return self.send(200, {'ok': True})
        if url.path == '/api/me':
            now = int(time.time())
            if not logged:
                return self.send(200, {'mode': 'public', 'user': None, 'serverTime': now, 'offline': None})
            return self.send(200, {'mode': 'public', 'user': {'id': 2, 'name': 'Ann', 'email': 'ann@example.com', 'admin': False, 'role': 'user'},
                                   'serverTime': now, 'offline': {'minutes': 600, 'until': now + 600 * 60},
                                   'features': {'translation': False, 'words': True}, 'ai': {'scripts': 0},
                                   'subscription': {'active': True, 'expiresAt': now + 86400, 'books': ['*']}})
        if not logged:
            return self.send(403, {'error': 'An active access code is required to use the books.'})
        if url.path == '/api/books':
            return self.send(200, [{'id': BOOK, 'title': 'Lesson one', 'author': 'Ann', 'pageCount': 1, 'cover': f'/lib/{BOOK}/thumbs/1.webp?v=1', 'language': 'en'}])
        if url.path == f'/api/books/{BOOK}':
            return self.send(200, {'id': BOOK, 'title': 'Lesson one', 'author': 'Ann', 'about': '', 'kind': 'text', 'language': 'en',
                                   'pages': [{'n': '1', 'path': 'p1', 'w': 40, 'h': 60, 'txt': True, 'img': f'/lib/{BOOK}/pages/1.webp?v=1',
                                              'a': [{'t': 'audio', 'src': SRC, 'x': 10, 'y': 10, 'w': 8, 'h': 8}]}]})
        if url.path == f'/api/text/{BOOK}/p1':
            return self.send(200, {'words': [[1, 1, 10, 5, 'Hello.', 0, 0]], 'sent': [[0, 1]], 'clause': [[0, 1]], 'blocks': [[0, 1]]})
        if url.path == '/api/transcript' and parse_qs(url.query).get('src') == [SRC]:
            return self.send(200, {'state': 'done', 'cues': [{'t': 0, 'x': 'Hello.', 'words': [{'t': 0, 'e': 400, 'x': 'Hello.'}]}]})
        if url.path in (f'/lib/{BOOK}/pages/1.webp', f'/lib/{BOOK}/thumbs/1.webp'):
            return self.send_bytes(webp(), 'image/webp')
        if url.path == SRC:
            return self.send_bytes(b'ID3' + bytes(500), 'audio/mpeg')
        return self.send(404, {'error': 'unknown'})

    def send(self, code, data, headers=()):
        out = json.dumps(data).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(out)))
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(out)

    def send_bytes(self, data, kind):
        self.send_response(200)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = answer

    def log_message(self, *args):
        pass


class StudentTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Site)
        cls.server.allow_reuse_address = True
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='lingua-student-test-')
        self.old_conn, db._conn = db._conn, None
        self.patches = [mock.patch.object(db, 'DATA', self.tmp.name),
                        mock.patch.object(library, 'BOOKS', str(Path(self.tmp.name) / 'books')),
                        mock.patch.object(auth, 'CONFIG', str(Path(self.tmp.name) / 'server-config.json')),
                        mock.patch.object(transcription, 'CACHE', Path(self.tmp.name) / 'transcripts'),
                        mock.patch.object(student, '_jobs', {}), mock.patch.object(student, '_online', None)]
        for p in self.patches:
            p.start()
        Site.reach = True
        SEEN.clear()
        student.configure(self.url)

    def tearDown(self):
        if db._conn is not None:
            db._conn.close()
        db._conn = self.old_conn
        for p in reversed(self.patches):
            p.stop()
        self.tmp.cleanup()

    def test_log_in_and_check(self):
        with self.assertRaisesRegex(student.StudentError, 'Wrong e-mail'):
            student.log_in('ann@example.com', 'nope')
        st = student.log_in('ann@example.com', 'secret-123')
        self.assertEqual((st['user']['name'], st['online'], st['locked']), ('Ann', True, False))
        self.assertEqual(st['features'], {'translation': False, 'words': True})
        self.assertEqual(st['offline']['minutes'], 600)
        device = auth.config()['studentDevice']
        login = [s for s in SEEN if s[1] == '/api/login'][-1]
        self.assertIn('lingua-books', login[3], 'the app names itself')
        self.assertEqual(auth.config()['studentCookie'], 'lb_session=ann-cookie')
        self.assertEqual(student.configure(self.url) or auth.config()['studentDevice'], device, 'the device id stays')
        student.log_out()
        self.assertIsNone(auth.config().get('studentUser'))
        self.assertTrue(student.state()['locked'])

    def test_locked(self):
        self.assertEqual(student.locked()[0], True, 'nobody logged in')
        student.log_in('ann@example.com', 'secret-123')
        now = int(time.time())
        self.assertEqual(student.locked(), (False, ''))
        # The website not reached: the lease decides.
        Site.reach = False
        with self.assertRaises(student.StudentError):
            student.refresh()
        self.assertEqual(student.locked(now + 60), (False, ''))
        self.assertIn('is over', student.locked(now + 601 * 60)[1])
        self.assertIn('moved back', student.locked(now - 300)[1])
        st = student.state(now + 601 * 60)
        self.assertEqual((st['online'], st['locked']), (False, True))
        # Reached again: open, a new lease.
        Site.reach = True
        st = student.check_now()
        self.assertEqual((st['online'], st['locked']), (True, False))
        # Logged out on the website (the device unlinked): the account goes.
        auth.set_config(studentCookie='lb_session=stale')
        self.assertIsNone(student.refresh()['user'])
        self.assertIn('Log in', student.locked()[1])

    def test_feature_switch_is_enforced_from_last_website_check(self):
        student.log_in('ann@example.com', 'secret-123')
        self.assertFalse(student.feature_allowed('translation'))
        self.assertTrue(student.feature_allowed('words'))
        self.assertTrue(student.feature_allowed('missing-new-feature'))

    def test_download(self):
        student.log_in('ann@example.com', 'secret-123')
        books = student.books()
        self.assertEqual([(b['id'], b['title'], b['here']) for b in books], [(BOOK, 'Lesson one', False)])
        self.assertTrue(books[0]['cover'].startswith(self.url))
        student.download(BOOK)
        for _ in range(100):
            if student.state()['downloads'][BOOK]['state'] != 'working':
                break
            time.sleep(0.1)
        job = student.state()['downloads'][BOOK]
        self.assertEqual(job['state'], 'done', job)
        b = library.get(BOOK)
        self.assertEqual((b['title'], b['status'], b['owner'], json.loads(b['pages'])[0]['w']), ('Lesson one', 'ready', db.LOCAL_USER, 40))
        for part in ('pages/1.webp', 'thumbs/1.webp', 'text/1.json', f'migration-media/{MP3}', 'migration-assets.json'):
            self.assertTrue(os.path.isfile(library.folder(BOOK, *part.split('/'))), part)
        self.assertEqual(library.text_doc(BOOK, '1')['words'][0][4], 'Hello.')
        full = library.full(b, {'id': db.LOCAL_USER, 'admin': True})
        self.assertEqual(full['pages'][0]['a'][0]['src'], SRC, 'the play button, with its sound here')
        self.assertEqual(transcription.saved(transcription.cache_id(SRC))[0]['x'], 'Hello.', 'its script')
        self.assertTrue(student.books()[0]['here'])
        with self.assertRaises(student.StudentError):
            student.download('nope')


if __name__ == '__main__':
    unittest.main()

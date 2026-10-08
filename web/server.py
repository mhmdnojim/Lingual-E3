"""The web server of Lingua Books (and, on this computer, the books of the American English
File 3 disc).

Serves the app (/web/), with HTTP Range support so audio and video can seek, and its API:

Accounts (accounts.py) and the library (library.py: books made from a text, a PDF or photos)
    GET    /api/me                         {mode, user, disc}: who is logged in
    POST   /api/signup  /api/login  /api/logout  /api/password
    GET    /api/books?scope=public|mine|local|all&q=…   lists of books
    GET    /api/books/<id>                 one book with its pages (to read it)
    POST   /api/books                      a new book {title, author, about, kind: text|pdf|images}
    PUT    /api/books/<id>                 change title, licence, visibility (private / public)
    DELETE /api/books/<id>
    PUT    /api/books/<id>/source/<part>   upload: pdf, image-<k>, text ({text}), picture
    POST   /api/books/<id>/make            make the pages (in the background)
    GET    /api/books/<id>/job             how far that is
    POST   /api/books/<id>/report          report a public book {reason, note}
    GET    /api/admin/reports              admins: open reports
    POST   /api/admin/books/<id>           admins: {action: hide | show | dismiss | delete}
    GET    /lib/<id>/pages|thumbs/<n>.webp page images of a book

The text of a page, corrections (the disc's in web/edits/, a library book's in its folder)
    GET    /api/text/<book>/<page>   PUT (save corrections)   DELETE (back to the original)
    GET    /api/search/<book>        all page texts of a book, with corrections

My audio (natural-voice MP3s, see tts.py; each user has their own on a website)
    GET    /api/voices    GET /api/voice-sample?voice=…&rate=…
    POST   /api/recordings    GET /api/jobs/<job>    GET /api/recordings
    GET    /api/recordings/<id>    PUT (rename)    DELETE

Translations (translate.py)
    GET    /api/tr-languages    POST /api/translate    POST /api/translate-word

Where it can be reached:

    python web/server.py           this computer only (127.0.0.1): no login, you are the admin
    python web/server.py --lan     also phones and tablets on the home Wi-Fi, with a PIN
    python web/server.py --public --proxy --no-browser
                                   a public website, behind a web server that adds HTTPS: anyone
                                   reads the public books; adding books needs an account; the
                                   disc's books are never served

Other options: --port 8765, --no-browser, --host, --password (the PIN of --lan).
"""
import argparse
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlsplit
from urllib.request import Request, urlopen

import accounts
import auth
import db
import ids
import library
import translate
import tts

# Raise when the app needs new server features; web/js/main.js checks it (NEEDS_API) and asks
# to restart the app if an older server is still running.
API_VERSION = 7  # 1 files, 2 text corrections, 3 My audio, 4 translations, 5 translator busy status, 6 library and accounts, 7 video scripts translated

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
WEB = os.path.join(ROOT, 'web')
DATA = os.path.join(WEB, 'data')  # the disc's books (made by web/tools); only on this computer
EDITS = os.environ.get('AEF_EDITS_DIR') or os.path.join(WEB, 'edits')  # corrections of the disc's books
RANGE = re.compile(r'bytes=(\d*)-(\d*)$')
API_TEXT = re.compile(rf'^/api/text/({ids.BOOK})/({ids.PAGE})$')
API_SEARCH = re.compile(rf'^/api/search/({ids.BOOK})$')
API_REC = re.compile(r'^/api/recordings/(r\d{8}-\d{6}-[0-9a-f]{4})$')
API_JOB = re.compile(r'^/api/jobs/([0-9a-f]{12})$')
API_BOOK = re.compile(r'^/api/books/(\w{1,20})$')
API_BOOK_PART = re.compile(r'^/api/books/(L[0-9a-f]{10})/(source|make|job|report)(?:/([\w-]{1,20}))?$')
API_ADMIN_BOOK = re.compile(r'^/api/admin/books/(L[0-9a-f]{10})$')
LIB_FILE = re.compile(r'^/lib/(L[0-9a-f]{10})/(pages|thumbs)/(\d{1,4}\.webp)$')
MAX_BODY = 5 * 1024 * 1024        # JSON
MAX_UPLOAD = 61 * 1024 * 1024     # one uploaded file
write_lock = threading.Lock()
LOOPBACK = ('127.0.0.1', '::1')
# Only the app (and on this computer the disc's content) is served as files, never these.
NOT_SERVED = re.compile(r'^/web/(server-config\.json|tests/|tools/|edits/|translations/|library/|recordings/|__pycache__/)'
                        r'|\.(py|pyc|bat|ps1|sh|db|key)$|/\.git', re.I)
# Open without the PIN (home Wi-Fi): the login page and what a phone needs for its home-screen icon.
OPEN = ('/web/login.html', '/web/manifest.webmanifest')

MODE = 'local'        # local | lan | public (set in main)
TRUST_PROXY = False   # --proxy: requests come from a web server on this machine (it adds X-Forwarded-*)
PIN = None            # --lan

sys.path.insert(0, os.path.join(WEB, 'tools'))
from segment_text import page_text  # noqa: E402  (same text layout as the build)


def read_json(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def edit_path(book, page):
    return os.path.join(EDITS, book, page + '.json')


def valid_doc(doc):
    """A page text document: words [x, y, w, h, text, line, space] and in-range index pairs."""
    if not isinstance(doc, dict):
        return False
    words, sent, clause, blocks = (doc.get(k) for k in ('words', 'sent', 'clause', 'blocks'))
    if not all(isinstance(x, list) for x in (words, sent, clause, blocks)) or len(words) > 50000:
        return False
    for w in words:
        if not (isinstance(w, list) and len(w) == 7 and isinstance(w[4], str) and len(w[4]) <= 300
                and all(isinstance(v, (int, float)) for v in (w[0], w[1], w[2], w[3], w[5], w[6]))):
            return False

    def pairs(items, limit):
        return all(isinstance(p, list) and len(p) == 2 and all(isinstance(v, int) for v in p)
                   and 0 <= p[0] <= p[1] <= limit for p in items)
    return pairs(sent, len(words)) and pairs(clause, len(words)) and pairs(blocks, len(sent))


# ---------------------------------------------------------------- The disc's books (this computer only)

_disc = {}


def disc():
    """books.json of the original disc (made by web/tools), or None: on a public website never."""
    if MODE == 'public':
        return None
    if 'data' not in _disc:
        path = os.path.join(DATA, 'books.json')
        _disc['data'] = read_json(path) if os.path.isfile(path) else None
    return _disc['data']


def disc_book(bid):
    d = disc()
    return next((b for b in d['books'] if b['id'] == bid), None) if d else None


def disc_summary(b):
    first = next((p for p in b['pages'] if not p.get('blank')), b['pages'][0])
    return {'id': b['id'], 'slug': b['slug'], 'type': b['type'], 'firstPage': first['n'],
            'title': b['type'], 'author': b['title'], 'about': '', 'kind': 'disc',
            'visibility': 'private', 'status': 'ready', 'pageCount': len(b['pages']), 'mine': True, 'canEdit': True,
            'disc': True, 'cover': f"/web/data/thumbs/{b['slug']}/{first['path']}.webp"}


def disc_full(b):
    out = dict(b)
    out.update(disc_summary(b))
    out.update({'type': b['type'], 'title': b['title'], 'resources': disc().get('resources', []),
                'pages': [{**p, 'w': 1984, 'h': 2496, 'img': f"/web/data/pages/{b['slug']}/{p['path']}.webp",
                           'thumb': f"/web/data/thumbs/{b['slug']}/{p['path']}.webp"} for p in b['pages']]})
    return out


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        '.webp': 'image/webp', '.wasm': 'application/wasm', '.js': 'text/javascript',
        '.mjs': 'text/javascript', '.json': 'application/json', '.mp3': 'audio/mpeg',
        '.mp4': 'video/mp4', '.swf': 'application/x-shockwave-flash', '.pdf': 'application/pdf',
        '.ppt': 'application/vnd.ms-powerpoint', '.srt': 'application/x-subrip; charset=utf-8',
        '.vtt': 'text/vtt; charset=utf-8', '.webmanifest': 'application/manifest+json', '.ttf': 'font/ttf',
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):  # keep the console quiet
        pass

    def end_headers(self):
        path = self.path.split('?', 1)[0]
        if path.startswith('/api/'):
            self.send_header('Cache-Control', 'no-store')
        elif not getattr(self, 'cache_set', False):
            app_code = path.startswith('/web/') and not path.startswith(('/web/data/', '/web/vendor/'))
            self.send_header('Cache-Control', 'no-cache' if app_code else 'max-age=86400')
            self.send_header('Accept-Ranges', 'bytes')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

    def list_directory(self, path):
        self.send_error(404)
        return None

    def translate_path(self, path):
        clean = urlsplit(path).path
        if clean.startswith('/web/recordings/'):  # the user's own MP3s (and subtitles)
            return tts.recording_file(os.path.basename(clean), self.rec_dir()) or os.path.join(ROOT, 'missing')
        return super().translate_path(path)

    def handle_one_request(self):
        self._user = None
        self.cache_set = False
        try:
            super().handle_one_request()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            pass  # the browser cancelled a media request while seeking

    # ---------- Answers ----------

    def send_json(self, obj, status=200, headers=()):
        body = json.dumps(obj, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path, ctype, private=False):
        with open(path, 'rb') as f:
            data = f.read()
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', ('private, ' if private else '') + 'max-age=31536000')
        self.cache_set = True
        self.end_headers()
        self.wfile.write(data)

    def denied(self, why='not allowed', status=403):
        return self.send_json({'error': why}, status)

    def need_account(self):
        return self.send_json({'error': 'Please log in (or create an account) first.', 'account': True}, 401)

    def same_origin(self):
        """Refuse changes requested by other web sites (only this app may save)."""
        origin = self.headers.get('Origin')
        return origin is None or urlsplit(origin).netloc == self.headers.get('Host')

    def read_body(self, limit=MAX_BODY, raw=False):
        """The body of a request (JSON, or bytes with raw=True), or None (after sending an error)."""
        length = int(self.headers.get('Content-Length') or 0)
        if not 0 < length <= limit:
            self.send_json({'error': 'The file is too big.' if length > limit else 'Nothing was sent.'}, 413 if length > limit else 400)
            return None
        data = self.rfile.read(length)
        if raw:
            return data
        try:
            return json.loads(data.decode('utf-8'))
        except ValueError:
            self.send_json({'error': 'bad JSON'}, 400)
            return None

    # ---------- Who is asking ----------

    def client_ip(self):
        ip = self.client_address[0]
        if TRUST_PROXY and ip in LOOPBACK and self.headers.get('X-Forwarded-For'):
            return self.headers['X-Forwarded-For'].split(',')[0].strip()
        return ip

    def https(self):
        return TRUST_PROXY and self.client_address[0] in LOOPBACK and self.headers.get('X-Forwarded-Proto') == 'https'

    def user(self):
        """The logged-in user (a row of the users table), or None."""
        if self._user is None:
            if MODE == 'local' or (MODE == 'lan' and self.client_address[0] in LOOPBACK):
                u = accounts.user(db.LOCAL_USER)
            else:
                morsel = SimpleCookie(self.headers.get('Cookie') or '').get(accounts.COOKIE)
                u = accounts.session_user(morsel.value) if morsel else None
                if MODE == 'lan' and u and u['id'] != db.LOCAL_USER:
                    u = None
            self._user = u or False
        return self._user or None

    def rec_dir(self):
        """The folder of this user's MP3s: on a website each user has their own."""
        if MODE != 'public':
            return tts.REC_DIR
        u = self.user()
        return os.path.join(db.DATA, 'users', str(u['id']), 'recordings') if u else None

    def gate(self, path):
        """Home Wi-Fi: nothing without the PIN. True if the request may go on (else it is answered)."""
        if MODE != 'lan' or self.user() or path in OPEN or path.startswith('/web/icons/'):
            return True
        if path.startswith('/api/'):
            self.send_json({'error': 'Please log in.', 'login': True}, 401)
        else:
            self.send_response(302)
            self.send_header('Location', '/web/login.html?next=' + quote(path))
            self.send_header('Content-Length', '0')
            self.end_headers()
        return False

    def book_access(self, book, write=False):
        """True if the user may read (or change) this book's texts; disc books only on this computer."""
        if ids.LIBRARY_BOOK_RE.match(book):
            b = library.get(book)
            return library.can_edit(b, self.user()) if write else library.can_read(b, self.user())
        return MODE != 'public'

    # ---------- Accounts ----------

    def post_account(self, path):
        body = {} if path == '/api/logout' else self.read_body()
        if body is None:
            return None
        if not isinstance(body, dict):
            return self.denied('bad request', 400)
        secure = self.https()
        if path == '/api/logout':
            return self.send_json({'ok': True}, headers=[('Set-Cookie', accounts.cookie('', secure, 0))])
        try:
            if path == '/api/login' and MODE == 'lan':
                if accounts.limited('pin', self.client_ip(), 8, 900):
                    return self.send_json({'error': 'Too many wrong tries. Wait 15 minutes.'}, 429)
                if str(body.get('password', '')) != PIN:
                    time.sleep(1)
                    return self.send_json({'error': 'Wrong PIN.'}, 401)
                u = accounts.user(db.LOCAL_USER)
            elif MODE != 'public':
                return self.send_json({'ok': True, 'user': accounts.public_user(self.user())})
            elif path == '/api/login':
                u = accounts.log_in(body.get('email', ''), body.get('password', ''), self.client_ip())
            elif path == '/api/signup':
                if body.get('website'):  # a field people do not see: filled in by robots
                    return self.denied('bad request', 400)
                u = accounts.sign_up(body.get('email', ''), body.get('name', ''), body.get('password', ''), self.client_ip())
            elif path == '/api/password':
                if not self.user():
                    return self.need_account()
                accounts.change_password(self.user()['id'], body.get('old', ''), body.get('new', ''))
                u = accounts.user(self.user()['id'])
            else:
                return self.denied()
        except accounts.AccountError as e:
            return self.send_json({'error': str(e)}, 400)
        return self.send_json({'ok': True, 'user': accounts.public_user(u)},
                              headers=[('Set-Cookie', accounts.cookie(accounts.new_session(u), secure))])

    # ---------- The library ----------

    def get_library(self, path, query):
        u = self.user()
        if path == '/api/books':
            scope = query.get('scope', ['public'])[0]
            if scope == 'local':
                d = disc()
                return self.send_json([disc_summary(b) for b in d['books']] if d else [])
            return self.send_json(library.list_books(u, scope, query.get('q', [''])[0][:100]))
        m = API_BOOK.match(path)
        if m:
            bid = m.group(1)
            b = disc_book(bid)
            if b:
                return self.send_json(disc_full(b))
            b = library.get(bid)
            if not library.can_read(b, u):
                return self.send_json({'error': 'This book does not exist, or is not shared.'}, 404)
            return self.send_json(library.full(b, u))
        m = API_BOOK_PART.match(path)
        if m and m.group(2) == 'job':
            b = library.get(m.group(1))
            if not library.can_edit(b, u):
                return self.denied()
            return self.send_json({'status': b['status'], 'error': b['error'], 'job': library.job(b['id']),
                                   'book': library.summary(b, u)})
        if path == '/api/admin/reports':
            if not (u and u['admin']):
                return self.denied()
            return self.send_json(library.open_reports())
        return self.send_json({'error': 'unknown'}, 404)

    def change_library(self, method, path):
        u = self.user()
        try:
            if method == 'POST' and path == '/api/books':
                if not u:
                    return self.need_account()
                body = self.read_body()
                if body is None:
                    return None
                return self.send_json(library.summary(library.create(u, body if isinstance(body, dict) else {}), u))
            m = API_ADMIN_BOOK.match(path)
            if m and method == 'POST':
                if not (u and u['admin']):
                    return self.denied()
                body = self.read_body()
                if body is None:
                    return None
                library.moderate(m.group(1), str(body.get('action', '')))
                return self.send_json({'ok': True})
            m = API_BOOK.match(path) or API_BOOK_PART.match(path)
            if not m:
                return self.denied()
            b = library.get(m.group(1))
            part = m.group(2) if m.re is API_BOOK_PART else None
            if part == 'report' and method == 'POST':
                if not library.can_read(b, u) or not b or b['visibility'] != 'public':
                    return self.denied()
                if accounts.limited('report', self.client_ip(), 20, 3600):
                    return self.send_json({'error': 'Too many reports from here. Try again later.'}, 429)
                body = self.read_body()
                if body is None:
                    return None
                library.report(b, u, self.client_ip(), str(body.get('reason', '')), body.get('note', ''))
                return self.send_json({'ok': True})
            if not library.can_edit(b, u):
                return self.need_account() if not u else self.denied()
            if part is None and method == 'PUT':
                body = self.read_body()
                if body is None:
                    return None
                return self.send_json(library.summary(library.update(b, body if isinstance(body, dict) else {}), u))
            if part is None and method == 'DELETE':
                library.delete(b)
                return self.send_json({'ok': True})
            if part == 'source' and method == 'PUT' and m.group(3):
                data = self.read_body(MAX_UPLOAD, raw=True)
                if data is None:
                    return None
                library.save_source(b, u, m.group(3), data)
                return self.send_json({'ok': True})
            if part == 'make' and method == 'POST':
                if not u['admin'] and accounts.limited('make', str(u['id']), 30, 86400):
                    return self.send_json({'error': 'You made many books today. Try again tomorrow.'}, 429)
                library.start(b)
                return self.send_json({'ok': True})
        except library.LibraryError as e:
            return self.send_json({'error': str(e)}, 400)
        return self.denied()

    # ---------- GET ----------

    def api_get(self, path):
        query = parse_qs(urlsplit(self.path).query)
        if path == '/api/version':
            return self.send_json({'api': API_VERSION})
        if path == '/api/me':
            return self.send_json({'mode': MODE, 'user': accounts.public_user(self.user()), 'disc': bool(disc()),
                                   'contact': os.environ.get('LB_CONTACT_EMAIL', ''),
                                   'licenses': library.LICENSES, 'reasons': library.REPORT_REASONS, 'limits': library.LIMITS})
        if path == '/api/session':  # (older pages)
            return self.send_json({'login': MODE == 'lan' and self.client_address[0] not in LOOPBACK})
        if path.startswith(('/api/books', '/api/admin/')):
            return self.get_library(path, query)
        m = API_TEXT.match(path)
        if m:
            book, page = m.groups()
            if not self.book_access(book):
                return self.send_json({'error': 'no text for this page'}, 404)
            if ids.LIBRARY_BOOK_RE.match(book):
                doc = library.text_doc(book, page[1:])
                return self.send_json(doc) if doc else self.send_json({'error': 'no text for this page'}, 404)
            edited = edit_path(book, page)
            if os.path.isfile(edited):
                doc = read_json(edited)
                doc['edited'] = True
                return self.send_json(doc)
            original = os.path.join(DATA, 'text', book, page + '.json')
            if os.path.isfile(original):
                return self.send_json(read_json(original))
            return self.send_json({'error': 'no text for this page'}, 404)
        m = API_SEARCH.match(path)
        if m:
            book = m.group(1)
            if not self.book_access(book):
                return self.send_json([])
            if ids.LIBRARY_BOOK_RE.match(book):
                return self.send_json(library.search_index(library.get(book)))
            index_path = os.path.join(DATA, 'search', book + '.json')
            if not os.path.isfile(index_path):
                return self.send_json([])
            index = read_json(index_path)
            edit_dir = os.path.join(EDITS, book)
            if os.path.isdir(edit_dir) and os.listdir(edit_dir):
                books = read_json(os.path.join(DATA, 'books.json'))['books']
                number = {p['path']: p['n'] for b in books if b['slug'] == book for p in b['pages']}
                fixed = {number.get(f[:-5]): page_text(read_json(os.path.join(edit_dir, f)))
                         for f in os.listdir(edit_dir) if f.endswith('.json')}
                index = [{'p': e['p'], 't': fixed.get(e['p'], e['t'])} for e in index]
            return self.send_json(index)
        return self.api_get_audio(path, query)

    def api_get_audio(self, path, query):
        if path == '/api/tr-languages':
            return self.send_json(translate.languages())
        if path in ('/api/voices', '/api/voice-sample') and tts.missing_packages():
            return self.send_json({'error': f'Install it first: python -m pip install {tts.missing_packages()}'}, 503)
        try:
            if path == '/api/voices':
                return self.send_json(tts.list_voices())
            if path == '/api/voice-sample':
                if MODE == 'public' and accounts.limited('sample', self.client_ip(), 60, 3600):
                    return self.send_json({'error': 'Too many samples. Try again later.'}, 429)
                mp3 = tts.voice_sample(query.get('voice', [''])[0], int(query.get('rate', ['0'])[0]))
                self.send_response(200)
                self.send_header('Content-Type', 'audio/mpeg')
                self.send_header('Content-Length', str(len(mp3)))
                self.end_headers()
                self.wfile.write(mp3)
                return None
            folder = self.rec_dir()
            if path == '/api/recordings':
                return self.send_json(tts.list_recordings(folder) if folder else [])
            m = API_REC.match(path)
            if m:
                if not folder:
                    return self.need_account()
                return self.send_json(tts.get_recording(m.group(1), folder))
            m = API_JOB.match(path)
            if m:
                return self.send_json(tts.get_job(m.group(1)))
        except FileNotFoundError:
            return self.send_json({'error': 'not found'}, 404)
        except ValueError as e:
            return self.send_json({'error': str(e)}, 400)
        except Exception:
            return self.send_json({'error': 'The voice service could not be reached. Is the internet connected?'}, 502)
        return self.send_json({'error': 'unknown'}, 404)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path in ('/', '/index.html', '/web'):
            self.send_response(302)
            self.send_header('Location', '/web/')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        if not self.gate(path):
            return
        if path.startswith('/api/'):
            return self.api_get(path)
        m = LIB_FILE.match(path)
        if m:
            b = library.get(m.group(1))
            f = library.file_path(*m.groups()) if library.can_read(b, self.user()) else None
            if not f:
                return self.send_error(404)
            return self.send_file(f, 'image/webp', private=b['visibility'] != 'public')
        if not self.served(path):
            return self.send_error(404)
        rng = self.headers.get('Range')
        fs_path = self.translate_path(self.path)
        m = RANGE.match(rng.strip()) if rng else None
        if not m or not os.path.isfile(fs_path):
            return super().do_GET()

        size = os.path.getsize(fs_path)
        first, last = m.groups()
        if first == '':  # "bytes=-500": the last 500 bytes
            start, end = max(0, size - int(last or 0)), size - 1
        else:
            start, end = int(first), min(int(last) if last else size - 1, size - 1)
        if start >= size or start > end:
            self.send_response(416)
            self.send_header('Content-Range', f'bytes */{size}')
            self.end_headers()
            return

        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(fs_path))
        self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.send_header('Content-Length', str(end - start + 1))
        self.end_headers()
        with open(fs_path, 'rb') as f:
            f.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = f.read(min(256 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def served(self, path):
        """Files: the app; the user's own MP3s; the disc's content only on this computer."""
        if path.startswith('/web/recordings/'):
            return bool(tts.recording_file(os.path.basename(path), self.rec_dir()))
        if NOT_SERVED.search(path):
            return False
        if path.startswith(('/web/data/', '/web/vendor/', '/.shared/')):
            return MODE != 'public'
        return path.startswith('/web/')

    def do_HEAD(self):
        path = urlsplit(self.path).path
        if not self.gate(path):
            return
        if path.startswith(('/api/', '/lib/')) or not self.served(path):
            return self.send_error(404)
        super().do_HEAD()

    # ---------- POST, PUT, DELETE ----------

    def do_POST(self):
        path = urlsplit(self.path).path
        if not self.same_origin():
            return self.denied()
        if path in ('/api/login', '/api/logout', '/api/signup', '/api/password'):
            return self.post_account(path)
        if not self.gate(path):
            return None
        if path == '/api/quit' and MODE != 'public' and not TRUST_PROXY and self.client_address[0] == '127.0.0.1':
            # A newer copy of the app is starting: make room for it.
            self.send_json({'ok': True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return None
        if path.startswith(('/api/books', '/api/admin/')):
            return self.change_library('POST', path)
        if path in ('/api/translate', '/api/translate-word'):
            return self.post_translate(path)
        if path != '/api/recordings':
            return self.denied()
        folder = self.rec_dir()
        if not folder:
            return self.need_account()
        if tts.missing_packages():
            return self.send_json({'error': f'Install it first: python -m pip install {tts.missing_packages()}'}, 503)
        req = self.read_body()
        if req is None:
            return None
        if MODE == 'public' and not self.user()['admin'] and accounts.limited('mp3', str(self.user()['id']), 40, 86400):
            return self.send_json({'error': 'You made many MP3s today. Try again tomorrow.'}, 429)
        if isinstance(req, dict) and not self.book_access(str(req.get('book', ''))):
            return self.denied()
        try:
            return self.send_json({'job': tts.start_job(req, folder)})
        except ValueError as e:
            return self.send_json({'error': str(e)}, 400)

    def post_translate(self, path):
        req = self.read_body()
        if req is None:
            return None
        if not isinstance(req, dict):
            return self.denied('bad request', 400)
        if MODE == 'public':
            who = f"u{self.user()['id']}" if self.user() else self.client_ip()
            if accounts.limited('translate', who, 600 if self.user() else 200, 3600):
                return self.send_json({'error': 'Too many translations from here. Try again in a while.'}, 429)
        try:
            if path == '/api/translate':
                book = str(req.get('book', ''))
                if not self.book_access(book):
                    return self.denied()
                out, fetched = translate.translate_page(str(req.get('lang', '')), book,
                                                        str(req.get('page', '')), req.get('paragraphs'))
                return self.send_json({'translations': out, 'fetched': fetched})
            return self.send_json({'text': translate.translate_word(str(req.get('lang', '')), str(req.get('word', '')))})
        except ValueError as e:
            return self.send_json({'error': str(e)}, 400)
        except translate.Busy as e:
            return self.send_json({'error': str(e), 'busy': True, 'wait': round(e.wait)}, 429)
        except translate.TranslateError as e:
            return self.send_json({'error': str(e)}, 502)

    def do_PUT(self):
        path = urlsplit(self.path).path
        if not self.gate(path):
            return None
        if not self.same_origin():
            return self.denied()
        if path.startswith('/api/books/'):
            return self.change_library('PUT', path)
        m = API_REC.match(path)
        if m:
            folder = self.rec_dir()
            if not folder:
                return self.need_account()
            body = self.read_body()
            if body is None:
                return None
            try:
                return self.send_json(tts.rename_recording(m.group(1), body.get('title', ''), folder))
            except (FileNotFoundError, ValueError, AttributeError):
                return self.send_json({'error': 'not found'}, 404)
        m = API_TEXT.match(path)
        if not m:
            return self.denied()
        book, page = m.groups()
        if not self.book_access(book, write=True):
            return self.need_account() if not self.user() else self.denied()
        doc = self.read_body()
        if doc is None:
            return None
        if not valid_doc(doc):
            return self.send_json({'error': 'bad page text'}, 400)
        clean = {k: doc[k] for k in ('words', 'sent', 'clause', 'blocks')}
        if ids.LIBRARY_BOOK_RE.match(book):
            library.save_edit(book, page[1:], clean)
            return self.send_json({'ok': True})
        target = edit_path(book, page)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with write_lock:
            tmp = target + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(clean, f, ensure_ascii=False, separators=(',', ':'))
            os.replace(tmp, target)
        self.send_json({'ok': True})

    def do_DELETE(self):
        path = urlsplit(self.path).path
        if not self.gate(path):
            return None
        if not self.same_origin():
            return self.denied()
        if path.startswith('/api/books/'):
            return self.change_library('DELETE', path)
        m = API_REC.match(path)
        if m:
            folder = self.rec_dir()
            if not folder:
                return self.need_account()
            tts.delete_recording(m.group(1), folder)
            return self.send_json({'ok': True})
        m = API_TEXT.match(path)
        if not m:
            return self.denied()
        book, page = m.groups()
        if not self.book_access(book, write=True):
            return self.need_account() if not self.user() else self.denied()
        if ids.LIBRARY_BOOK_RE.match(book):
            library.remove_edit(book, page[1:])
            return self.send_json({'ok': True})
        target = edit_path(book, page)
        with write_lock:
            if os.path.isfile(target):
                os.remove(target)
        self.send_json({'ok': True})


class Server(ThreadingHTTPServer):
    """Only one copy of the app may use a port. (Python's default "reuse address" lets two
    servers share a port on Windows, and the browser may then keep talking to an old copy.)"""
    allow_reuse_address = False
    daemon_threads = True
    request_queue_size = 256  # many readers at once wait in line, not get turned away (Python's default: 5)

    def server_bind(self):
        if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def answers(base):
    try:
        with urlopen(base + '/api/version', timeout=2) as r:
            return 'api' in json.loads(r.read(2000))
    except Exception:
        return False


def stop_old_copy(port):
    """If an older copy of this app still runs on the port (its window was left open), stop it,
    so the browser always talks to the newest version."""
    base = f'http://127.0.0.1:{port}'
    if not answers(base):
        return  # nothing there, or another program
    print('Stopping an older copy of the app that is still running...')
    try:  # copies from now on stop when asked
        urlopen(Request(base + '/api/quit', data=b'{}', method='POST', headers={'Content-Type': 'application/json'}), timeout=3)
    except Exception:
        pass
    for _ in range(15):
        if not answers(base):
            return
        time.sleep(0.2)
    if os.name == 'nt':  # older copies: stop every process on the port that is this app's server
        ps = (f"Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue | "
              "Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { "
              "$c = (Get-CimInstance Win32_Process -Filter \"ProcessId = $_\").CommandLine; "
              "if ($c -match 'server\\.py' -and $_ -ne $PID) { Stop-Process -Id $_ -Force } }")
        subprocess.run(['powershell', '-NoProfile', '-Command', ps], capture_output=True, timeout=30)
        time.sleep(0.5)


def lan_address():
    """This computer's address on the home network (nothing is sent anywhere)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(('192.168.0.1', 80))
            return s.getsockname()[0]
    except OSError:
        return None


def main():
    global MODE, TRUST_PROXY, PIN
    ap = argparse.ArgumentParser(description="Lingua Books: the app's web server.")
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--no-browser', action='store_true')
    ap.add_argument('--host', default='127.0.0.1', help='address to listen on (default: this computer only)')
    ap.add_argument('--lan', action='store_true', help='also phones and tablets on the same Wi-Fi (with a PIN)')
    ap.add_argument('--public', action='store_true', help='a public website: accounts, public books; never the disc')
    ap.add_argument('--proxy', action='store_true', help='behind a web server on this machine that adds HTTPS')
    ap.add_argument('--password', help='the PIN for --lan (default: made once, in web/server-config.json)')
    args = ap.parse_args()

    host = args.host
    if args.public:
        MODE = 'public'
    elif args.lan:
        MODE, host = 'lan', '0.0.0.0'
        PIN = args.password or auth.lan_pin()
    elif host not in ('127.0.0.1', 'localhost', '::1'):
        print('Reachable from other devices without a login: not started. Use --lan (home Wi-Fi, with a PIN)')
        print('or --public (a website with accounts).')
        return 1
    TRUST_PROXY = args.proxy
    db.conn()  # create the library database now (and see errors at once)

    if MODE != 'public':
        stop_old_copy(args.port)
    server = None
    for port in range(args.port, args.port + (1 if MODE == 'public' else 20)):
        try:
            server = Server((host, port), Handler)
            break
        except OSError:
            continue
    if server is None:
        print('Could not find a free port.')
        return 1

    url = f'http://127.0.0.1:{server.server_port}/web/'
    print('Lingua Books is running at', url)
    if MODE == 'lan':
        ip = lan_address() or "<this computer's address>"
        print()
        print('On a phone or tablet on the same Wi-Fi, open:')
        print(f'    http://{ip}:{server.server_port}/web/')
        print(f'    PIN: {PIN}')
        print('(If Windows asks whether Python may use the network, allow it for private networks.)')
        print()
    elif MODE == 'public':
        print('A public website: anyone can read the public books; adding books needs an account.')
        if not accounts.ADMINS:
            print('No admin yet: set LB_ADMIN_EMAIL to your e-mail address (then sign up or log in with it).')
        if not TRUST_PROXY:
            print('Without --proxy (HTTPS from a web server in front of this one) logins are not secure.')
    print('Keep this window open while you use the app. Close it (or press Ctrl+C) to stop.')
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == '__main__':
    sys.exit(main())

"""The web server of Lingua Books (and, on this computer, the books of the American English
File 3 disc).

Serves the app (/web/), with HTTP Range support so audio and video can seek, and its API:

Accounts (accounts.py) and the library (library.py: books made from a text, a PDF or photos)
    GET    /api/me                         {mode, user, disc}: who is logged in
    POST   /api/signup  /api/login  /api/logout  /api/password
    GET    /api/books?scope=public|mine|local|all&q=…   lists of books
    GET    /api/books/<id>                 one book with its pages (to read it)
    POST   /api/books                      a new book {title, author, about, kind: text|pdf|images}
    PUT    /api/books/<id>                 change title, branch, licence, visibility (private / public)
    DELETE /api/books/<id>
    PUT    /api/books/<id>/source/<part>   upload: pdf, word (a Word file, made into the PDF), image-<k>, text ({text}), picture
    GET    /api/page-languages             the languages of pages, and which OCR reads here
    POST   /api/books/<id>/preview         make a sample of 1-5 pages first {options, same, again: find the designs again}
    GET    /api/books/<id>/preview         the sample (with tips), or how far making it is
    GET    /lib/<id>/preview/<n>.webp?token=…   a page of the sample
    GET    /api/books/<id>/designs         the designs of the pages and their areas (designs.py)
    PUT    /api/books/<id>/designs         change them {designs: [{pages, example, areas}]}
    GET    /lib/<id>/designs/<n>.webp      a page drawn small (to see its design)
    GET    /api/books/<id>/pictures?n=     the pictures replaced (on page n) (pictures.py)
    POST   /api/books/<id>/pictures/<n>?x=&y=&w=&h=&fit=   replace the picture in that box (the body: the new one)
    DELETE /api/books/<id>/pictures/<id>   take a replaced picture back
    GET    /lib/<id>/book.pdf              the book's PDF, with the pictures replaced (its owner)
    GET    /api/books/<id>/tracks          its recordings (audio, video) added: how many, on their pages (tracks.py)
    PUT    /api/books/<id>/tracks?name=    add one (the body: the file)   POST …/tracks/place: their buttons on the pages
    DELETE /api/books/<id>/tracks          take them all out
    POST   /api/books/<id>/buttons/<n>     a play button put by hand {file, x, y}   PUT {src, from: [x, y], x, y}: moved
    DELETE /api/books/<id>/buttons/<n>?src=&x=&y=   taken away (each: the page's buttons)
    GET    /api/picture-ai   PUT (admins: {key, model})   POST {book, page, box, prompt, like}: a picture made by AI
    POST   /api/books/<id>/make            make all the pages (in the background) {options}
    GET    /api/books/<id>/job             how far that is
    POST   /api/books/<id>/report          report a public book {reason, note}
    GET    /api/admin/reports              admins: open reports
    POST   /api/admin/books/<id>           admins: {action: hide | show | dismiss | delete}
    GET    /api/branches                   the branches of the library (branches.py): [{id, parent, name, empty}]
    POST   /api/branches                   admins: a new branch {name, parent}   PUT /api/branches/<id> {name, parent}
    DELETE /api/branches/<id>              admins: remove a branch (what is in it goes into the branch above)
    POST   /api/branches/<id>/copy         admins: copy it with all in it {parent} (its books: copies of them)
    POST   /api/links                      a copy of a book in another branch {book, branch, title}
    PUT    /api/links/<id>                 rename a copy, move it {title, branch}   DELETE /api/links/<id>
    PUT    /api/books/<disc book>          admins: rename a book of the disc, move it {title, branch}
    GET    /lib/<id>/pages|thumbs/<n>.webp page images of a book

The text of a page, corrections (the disc's in web/edits/, a library book's in its folder)
    GET    /api/text/<book>/<page>   PUT (save corrections)   DELETE (back to the original)
    GET    /api/search/<book>        all page texts of a book, with corrections

My audio (natural-voice MP3s, see tts.py; each user has their own on a website)
    GET    /api/voices    GET /api/voice-sample?voice=…&rate=…
    POST   /api/recordings    GET /api/jobs/<job>    GET /api/recordings
    GET    /api/recordings/<id>    PUT (rename)    DELETE

New words (flashcards, see words.py; each user has their own on a website)
    GET    /api/words    POST /api/words {items}    PUT /api/words/<id> {known}    DELETE /api/words/<id>
    POST   /api/words/categories {name}    DELETE /api/words/categories/<id>

Translations (translate.py)
    GET    /api/tr-languages    POST /api/translate    POST /api/translate-word
    (each with {lang, from}: from the book's language, 'zh-Hans' …; '' = English, into lang)
    POST   /api/pinyin {texts}   the pinyin of every character of each text (pinyin.py)

Speech recognition (transcription.py: on this computer, or ElevenLabs with its key; a website: admins)
    POST   /api/transcribe {src}    GET /api/transcript?src=…   the lines, or how far it is
    GET    /api/speech-ai           how it is done   PUT (admins: {key, engine: eleven | local})
    POST   /api/transcribe-file?name=          any audio or video (the body)   GET …?job=: its lines
    POST   /api/books/<id>/tracks/transcribe      all the recordings added to a book
    GET    /api/disc-scripts/<disc book>          its recordings' scripts made by speech recognition: how many
    POST   /api/disc-scripts/<disc book>          all of them made (again, with ElevenLabs: better)

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
import base64
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlsplit
from urllib.request import Request, urlopen
from PIL import Image

import accounts
import auth
import branches
import db
import ids
import library
import layout_ai
import migration
import ocr
import office
import pictures
import pinyin
import subscriptions
import transcription
import translate
import tts
import words

# Raise when the app needs new server features; web/js/main.js checks it (NEEDS_API) and asks
# to restart the app if an older server is still running.
API_VERSION = 33  # 33: optional, permission-checked AI layout suggestions

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
WEB = os.path.join(ROOT, 'web')
DATA = os.path.join(WEB, 'data')  # the disc's books (made by web/tools); only on this computer
# Another level's disc and books (web/levels.json): /levels/<id>/.shared/… and /levels/<id>/web/data/…
LEVEL_URL = re.compile(r'^/levels/([0-9A-Za-z-]{1,20})(/(?:\.shared|web/data)/.*)$')
LEVELS = os.environ.get('AEF_LEVELS_FILE') or os.path.join(WEB, 'levels.json')  # (tests use their own)
EDITS = os.environ.get('AEF_EDITS_DIR') or os.path.join(WEB, 'edits')  # corrections of the disc's books
RANGE = re.compile(r'bytes=(\d*)-(\d*)$')
API_TEXT = re.compile(rf'^/api/text/({ids.BOOK})/({ids.PAGE})$')
API_OCR_REGION = re.compile(rf'^/api/ocr-region/({ids.BOOK})/({ids.PAGE})$')
API_SEARCH = re.compile(rf'^/api/search/({ids.BOOK})$')
API_REC = re.compile(r'^/api/recordings/(r\d{8}-\d{6}-[0-9a-f]{4})$')
API_WORD = re.compile(r'^/api/words/(w[0-9a-f]{12})$')
API_WORD_CATEGORY = re.compile(r'^/api/words/categories(?:/(def|common|c[0-9a-f]{8}))?$')
API_JOB = re.compile(r'^/api/jobs/([0-9a-f]{12})$')
API_BOOK = re.compile(r'^/api/books/(\w{1,20})$')
API_BOOK_PART = re.compile(r'^/api/books/(L[0-9a-f]{10})/(source|make|job|report|preview|designs|layout|layout-ai|pictures|tracks|buttons)(?:/([\w-]{1,20}))?$')
LIB_PDF = re.compile(r'^/lib/(L[0-9a-f]{10})/book\.pdf$')
API_ADMIN_BOOK = re.compile(r'^/api/admin/books/(L[0-9a-f]{10})$')
API_BRANCH = re.compile(r'^/api/branches(?:/(\d{1,9})(/copy)?)?$')
API_LINK = re.compile(r'^/api/links(?:/(\d{1,9}))?$')
API_ADMIN_SUBSCRIPTION_CODE = re.compile(r'^/api/admin/subscription-codes(?:/(\d{1,9}))?$')
API_ADMIN_SUBSCRIPTION = re.compile(r'^/api/admin/subscriptions/(\d{1,9})$')
LIB_FILE = re.compile(r'^/lib/(L[0-9a-f]{10})/(pages|thumbs)/(\d{1,4}\.webp)$')
LIB_PREVIEW_FILE = re.compile(r'^/lib/(L[0-9a-f]{10})/preview/(\d{1,4}\.webp)$')
LIB_DESIGN_FILE = re.compile(r'^/lib/(L[0-9a-f]{10})/designs/(\d{1,4})\.webp$')
LIB_MIGRATION_MEDIA = re.compile(r'^/lib/(L[0-9a-f]{10})/migration-media/([0-9a-f]{64}\.(?:mp3|wav|ogg|m4a|mp4|webm|json))$')
API_MIGRATION = re.compile(r'^/api/migrations/(M[0-9a-f]{16})(?:/(source|analyze|sample|convert|cancel|discard|preview|export|report)(?:/([a-zA-Z0-9_.-]+))?)?$')
MAX_BODY = 5 * 1024 * 1024        # JSON
TRANSCRIBE_FILE_MB = 1000          # a file to transcribe (ElevenLabs takes up to 3 GB)
API_DISC_SCRIPTS = re.compile(r'^/api/disc-scripts/([\w-]{1,40})$')  # a disc book's scripts by speech recognition
MAX_UPLOAD = 61 * 1024 * 1024     # one uploaded file
write_lock = threading.Lock()
_ocr_region_lock = threading.Lock()
LOOPBACK = ('127.0.0.1', '::1')
# Only the app (and on this computer the disc's content) is served as files, never these.
NOT_SERVED = re.compile(r'^/web/(server-config\.json|levels\.json|tests/|tools/|edits/|translations/|transcripts/|library/|recordings/'
                        r'|vendor/python/|vendor/models/|__pycache__/)'
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
# The app shows the books of several discs (levels) when web/levels.json lists their folders, in order:
#   {"levels": [{"id": "1", "name": "Level 1", "folder": "../American English File 2e Level 1",
#                "branch": ["Learning English Courses", "American English File 2e", "Level 1"]}, …]}
# Each folder has its disc unpacked (.shared) and the web/data made from it by web/tools
# (build_all.ps1 -Root <folder>). This folder's are served as always (/.shared/…, /web/data/…),
# another folder's under /levels/<id>/. Without the file: this folder's disc only. A level's books are
# in its branch of the library (branches.py), put there the first time from its "branch".

_disc = {}


def levels():
    """The discs whose books the app shows: [{id, name, branch, root, prefix}] (prefix '' for this folder's)."""
    if 'levels' not in _disc:
        found = []
        try:
            for level in read_json(LEVELS)['levels'] if os.path.isfile(LEVELS) else []:
                root = os.path.realpath(os.path.join(ROOT, str(level['folder'])))
                here = root == os.path.realpath(ROOT)
                lid = str(level.get('id', ''))
                if not here and not re.fullmatch(r'[0-9A-Za-z-]{1,20}', lid):
                    print(f'web/levels.json: {level["folder"]} needs an id (letters, digits)')
                    continue
                name = str(level.get('name', '')).strip()
                names = level.get('branch', [name])
                found.append({'id': lid, 'name': name, 'root': root, 'prefix': '' if here else f'/levels/{lid}',
                              'branch': [' '.join(str(n).split()) for n in ([names] if isinstance(names, str) else names) if str(n).strip()]})
        except (OSError, ValueError, KeyError, TypeError) as e:
            print(f'web/levels.json could not be read ({e}): only the books of this folder are shown.')
        _disc['levels'] = found or [{'id': '', 'name': '', 'branch': [], 'root': ROOT, 'prefix': ''}]
    return _disc['levels']


def disc():
    """The books of the discs (books.json made by web/tools, of each level), or None: on a public
    website never. A book also has its level (_level), its web/data folder (_data) and the level's
    documents (_resources); the addresses of another level's files start with /levels/<id>/."""
    if MODE == 'public':
        return None
    if 'data' not in _disc:
        books = []
        for level in levels():
            data = os.path.join(level['root'], 'web', 'data')
            path = os.path.join(data, 'books.json')
            if not os.path.isfile(path):
                continue
            d = read_json(path)
            if level['prefix']:
                d = json.loads(json.dumps(d).replace('"/.shared/', f'"{level["prefix"]}/.shared/')
                               .replace('"/web/data/', f'"{level["prefix"]}/web/data/'))
            for b in d['books']:
                b['type'] = b['type'].strip()
                if level['name'] and not b['type'].startswith(level['name']):
                    b['type'] = f"{level['name']} {b['type']}"  # Level 1 Student Book
                b.update(_level=level, _data=data, _resources=d.get('resources', []))
                books.append(b)
        _disc['data'] = {'books': books} if books else None
    return _disc['data']


def disc_book(bid):
    d = disc()
    return next((b for b in d['books'] if b['id'] == bid), None) if d else None


def disc_by_slug(slug):
    d = disc()
    return next((b for b in d['books'] if b['slug'] == slug), None) if d else None


def disc_data(slug):
    """The web/data folder of a disc book (its level's)."""
    b = disc_by_slug(slug)
    return b['_data'] if b else DATA


def disc_location(url):
    """Where a disc file's address is: (the level's folder, the address in it)."""
    m = LEVEL_URL.match(url or '')
    level = m and next((l for l in levels() if l['prefix'] == f'/levels/{m.group(1)}'), None)
    return (Path(level['root']), m.group(2)) if level else (Path(ROOT), url)


def disc_summary(b, places=None, changed=None):
    """places: the branch of each level (branches.level_branches()), changed: the books an admin
    renamed or moved (branches.disc_books()); given when there are many books."""
    first = next((p for p in b['pages'] if not p.get('blank')), b['pages'][0])
    mine = (branches.disc_books() if changed is None else changed).get(b['id']) or {}
    branch = mine['branch'] if mine.get('placed') else (branches.level_branches() if places is None else places).get(b['_level']['id'])
    return {'id': b['id'], 'slug': b['slug'], 'type': b['type'], 'firstPage': first['n'],
            'title': mine.get('title') or b['type'], 'author': b['title'], 'about': '', 'kind': 'disc', 'branch': branch,
            'visibility': 'private', 'status': 'ready', 'pageCount': len(b['pages']), 'mine': True, 'canEdit': True,
            'disc': True, 'cover': f"{b['_level']['prefix']}/web/data/thumbs/{b['slug']}/{first['path']}.webp"}


def disc_listing(links=True):
    """The disc's books for the library, each in its branch (links: then their copies)."""
    d = disc()
    places, changed = branches.level_branches(), branches.disc_books()
    books = [disc_summary(b, places, changed) for b in d['books']] if d else []
    return branches.with_links(books) if links else books


def disc_lessons(slug):
    """The lessons of a disc book (web/lessons.json): [{id, title, unit, pages}], or []."""
    if 'lessons' not in _disc:
        _disc['lessons'] = read_json(os.path.join(WEB, 'lessons.json'))
    return _disc['lessons'].get(slug, [])


def disc_full(b):
    out = {k: v for k, v in b.items() if not k.startswith('_')}
    s = disc_summary(b)
    out.update(s)
    data = f"{b['_level']['prefix']}/web/data"
    out.update({'type': s['title'], 'title': b['title'], 'resources': b['_resources'], 'lessons': disc_lessons(b['slug']),
                'pages': [{**p, 'w': 1984, 'h': 2496, 'img': f"{data}/pages/{b['slug']}/{p['path']}.webp",
                           'thumb': f"{data}/thumbs/{b['slug']}/{p['path']}.webp"} for p in b['pages']]})
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
        elif path.startswith('/web/recordings/'):
            # Browser IndexedDB owns deliberate offline copies. Do not retain a
            # second HTTP-cache copy after the user deletes a recording.
            self.send_header('Cache-Control', 'private, no-store')
            self.send_header('Accept-Ranges', 'bytes')
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
        if LEVEL_URL.match(clean):  # another level's disc and books (in its own folder)
            root, rest = disc_location(clean)
            return os.path.join(root, os.path.relpath(super().translate_path(rest), ROOT))
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

    def send_migration_file(self, path, ctype, download=None):
        """Stream generated artifacts/media after an ownership check, including audio seeks."""
        size = os.path.getsize(path)
        start, end, status = 0, size - 1, 200
        raw_range = self.headers.get('Range')
        match = RANGE.fullmatch(raw_range.strip()) if raw_range else None
        if match:
            first, last = match.groups()
            if first:
                start, end = int(first), min(int(last), end) if last else end
            else:
                start = max(0, size - int(last or 0))
            if start > end or start >= size:
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{size}')
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            status = 206
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(max(0, end - start + 1)))
        self.send_header('Cache-Control', 'private, no-store')
        self.cache_set = True
        self.send_header('Accept-Ranges', 'bytes')
        if status == 206:
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        if download:
            self.send_header('Content-Disposition', f'attachment; filename="{download}"')
        self.end_headers()
        with open(path, 'rb') as source:
            source.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = source.read(min(256 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def migration_api(self, method, path):
        user = self.user()
        if not user:
            return self.need_account()
        try:
            if path == '/api/migrations':
                if method == 'GET':
                    return self.send_json(migration.list_jobs(user))
                if method == 'POST':
                    body = self.read_body()
                    if body is None:
                        return
                    if not isinstance(body, dict):
                        return self.denied('Expected import settings.', 400)
                    return self.send_json(migration.create(user, body), 201)
            match = API_MIGRATION.fullmatch(path)
            if not match:
                return self.denied('Import not found.', 404)
            mid, action, name = match.groups()
            migration.snapshot(mid, user)  # authorize before reading an upload or artifact
            if method == 'GET':
                if not action:
                    return self.send_json(migration.snapshot(mid, user))
                if action == 'source' and not name:  # the files received so far (going on with an upload)
                    return self.send_json(migration.uploaded(mid, user))
                if action in ('preview', 'export', 'report'):
                    file = migration.artifact(mid, user, action, name)
                    types = {'preview': 'image/webp', 'export': 'application/zip', 'report': 'application/json'}
                    return self.send_migration_file(file, types[action],
                        f'{mid}-converted.zip' if action == 'export' else f'{mid}-report.json' if action == 'report' else None)
            if method == 'PUT' and action == 'source' and not name:
                # Empty marker files are common in uploaded application folders.
                data = b'' if self.headers.get('Content-Length') == '0' else self.read_body(migration.MAX_UPLOAD_BYTES, raw=True)
                if data is None:
                    return
                filename = parse_qs(urlsplit(self.path).query).get('name', [''])[0]
                return self.send_json(migration.save_upload(mid, user, filename, data))
            if method == 'POST' and not name:
                body = self.read_body()
                if body is None:
                    return
                if not isinstance(body, dict):
                    return self.denied('Expected import settings.', 400)
                if action == 'analyze':
                    return self.send_json(migration.analyze(mid, user))
                if action == 'sample':
                    return self.send_json(migration.make_sample(mid, user, body))
                if action == 'convert':
                    return self.send_json(migration.convert(mid, user, body))
                if action == 'cancel':
                    return self.send_json(migration.cancel(mid, user))
                if action == 'discard':
                    return self.send_json(migration.discard(mid, user))
            return self.denied('Unknown import action.', 404)
        except migration.MigrationError as error:
            return self.send_json({'error': str(error)}, error.status)
        except OSError as error:  # (a file kept busy, a full disk …: an answer, not a broken connection)
            return self.send_json({'error': f'A file could not be saved ({error.strerror or error}). Trying again may work.', 'retry': True}, 503)

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

    def words_dir(self):
        """The folder of this user's new words (words.json): on a website each user has their own."""
        if MODE != 'public':
            return words.DIR
        u = self.user()
        return os.path.join(db.DATA, 'users', str(u['id'])) if u else None

    def words_api(self, method, path):
        """New words: list them (and the categories), add some, answer a flashcard (PUT {known}),
        delete one; add a category ({name}), delete one."""
        folder = self.words_dir()
        if not folder:
            return self.need_account()
        m, cat = API_WORD.match(path), API_WORD_CATEGORY.match(path)
        try:
            if method == 'GET' and path == '/api/words':
                return self.send_json(words.list_items(folder))
            body = self.read_body() if method in ('POST', 'PUT') else {}
            if body is None:  # (already answered)
                return None
            if method == 'POST' and cat and not cat.group(1):
                return self.send_json(words.add_category(body.get('name') if isinstance(body, dict) else None, None, folder))
            if method == 'DELETE' and cat and cat.group(1):
                return self.send_json({'moved': words.remove_category(cat.group(1), folder)})
            if method == 'POST' and path == '/api/words':
                items = body.get('items') if isinstance(body, dict) else None
                if not isinstance(items, list) or not all(isinstance(i, dict) and self.book_access(str(i.get('book', ''))) for i in items):
                    return self.denied()
                return self.send_json({'items': words.add(items, folder)})
            if method == 'PUT' and m:
                return self.send_json(words.practiced(m.group(1), body.get('known') if isinstance(body, dict) else None, folder))
            if method == 'DELETE' and m:
                words.remove(m.group(1), folder)
                return self.send_json({'ok': True})
        except FileNotFoundError:
            return self.send_json({'error': 'not found'}, 404)
        except ValueError as e:
            return self.send_json({'error': str(e)}, 400)
        return self.denied()

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

    def subscription_gate(self, path):
        """A paid public deployment serves its account/setup pages, but protects its APIs and media."""
        if MODE != 'public' or not subscriptions.required():
            return True
        if (path.startswith('/web/') or path in ('/', '/index.html', '/web')
                or path in ('/api/version', '/api/me', '/api/login', '/api/signup', '/api/logout',
                            '/api/password', '/api/redeem', '/api/admin/subscriptions')
                or path.startswith('/api/admin/subscription-codes')
                or API_ADMIN_SUBSCRIPTION.match(path)):
            return True
        if not (path.startswith('/api/') or path.startswith('/lib/')):
            return True
        user = self.user()
        if user and user['admin']:
            return True
        if not user:
            self.send_json({'error': 'Create an account or log in, then redeem an access code.',
                            'subscriptionRequired': True}, 403)
            return False
        if not subscriptions.has_access(user['id']):
            self.send_json({'error': 'An active access code is required to use the books.',
                            'subscriptionRequired': True}, 403)
            return False
        return True

    def book_access(self, book, write=False):
        """True if the user may read (or change) this book's texts; disc books only on this computer."""
        if ids.LIBRARY_BOOK_RE.match(book):
            b = library.get(book)
            u = self.user()
            allowed = library.can_edit(b, u) if write else library.can_read(b, u)
            if (allowed and MODE == 'public' and subscriptions.required() and u and not u['admin']
                    and b and b['owner'] != u['id']):
                allowed = subscriptions.can_access_book(u['id'], book)
            return allowed
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
                u = accounts.log_in(body.get('email', ''), body.get('password', ''), self.client_ip(),
                                    body.get('adminSetupCode', ''))
            elif path == '/api/signup':
                if body.get('website'):  # a field people do not see: filled in by robots
                    return self.denied('bad request', 400)
                u = accounts.sign_up(body.get('email', ''), body.get('name', ''), body.get('password', ''),
                                     self.client_ip(), body.get('adminSetupCode', ''))
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
        if path == '/api/branches':
            return self.send_json(branches.all_branches())
        if path == '/api/books':
            scope = query.get('scope', ['public'])[0]
            if scope == 'local':
                return self.send_json(disc_listing())
            books = library.list_books(u, scope, query.get('q', [''])[0][:100])
            if scope == 'public' and MODE == 'public' and subscriptions.required() and u and not u['admin']:
                books = [b for b in books if subscriptions.can_access_book(u['id'], b['id'])]
            return self.send_json(books)
        m = API_BOOK.match(path)
        if m:
            bid = m.group(1)
            b = disc_book(bid)
            if b:
                return self.send_json(disc_full(b))
            b = library.get(bid)
            if not self.book_access(bid):
                return self.send_json({'error': 'This book does not exist, or is not shared.'}, 404)
            return self.send_json(library.full(b, u))
        m = API_BOOK_PART.match(path)
        if m and m.group(2) == 'job':
            b = library.get(m.group(1))
            if not library.can_edit(b, u):
                return self.denied()
            return self.send_json({'status': b['status'], 'error': b['error'], 'job': library.job(b['id']),
                                   'book': library.summary(b, u)})
        if m and m.group(2) == 'preview':
            b = library.get(m.group(1))
            if not library.can_edit(b, u):
                return self.denied()
            sample = library.sample(b['id'])
            return self.send_json(sample) if sample else self.send_json({'error': 'There is no sample yet.'}, 404)
        if m and m.group(2) == 'pictures':
            b = library.get(m.group(1))
            if not library.can_edit(b, u):
                return self.denied()
            return self.send_json({'pictures': library.pictures_of(b, query.get('n', [None])[0])})
        if m and m.group(2) == 'tracks':
            b = library.get(m.group(1))
            if not library.can_edit(b, u):
                return self.denied()
            return self.send_json(self.tracks_info(b))
        if m and m.group(2) == 'designs':
            b = library.get(m.group(1))
            if not library.can_edit(b, u):
                return self.denied()
            found = library.designs_info(b)
            return self.send_json(found) if found else self.send_json({'error': 'The designs of the pages are not found yet.'}, 404)
        if path == '/api/admin/reports':
            if not (u and u['admin']):
                return self.denied()
            return self.send_json(library.open_reports())
        if path == '/api/admin/subscriptions':
            if not (u and u['admin']):
                return self.denied()
            return self.send_json(subscriptions.admin_data())
        return self.send_json({'error': 'unknown'}, 404)

    def change_subscriptions(self, method, path):
        if MODE != 'public' or not subscriptions.required():
            return self.send_json({'error': 'Access codes are not enabled on this server.'}, 404)
        u = self.user()
        if not (u and u['admin']):
            return self.denied()
        if method == 'POST' and path == '/api/admin/subscription-codes':
            req = self.read_body()
            if req is None:
                return None
            if not isinstance(req, dict):
                return self.denied('bad request', 400)
            try:
                books = req.get('books', '*')
                if books != '*' and isinstance(books, list):
                    for bid in books:
                        book = library.get(str(bid))
                        if not book or book['visibility'] != 'public' or book['status'] != 'ready':
                            raise subscriptions.SubscriptionError('Codes can include only ready, shared books.')
                url = os.environ.get('LB_PUBLIC_URL', '').strip().rstrip('/')
                if not url:
                    if not self.https():
                        return self.send_json({'error': 'Set LB_PUBLIC_URL to your HTTPS site address before making QR codes.'}, 400)
                    url = 'https://' + self.headers.get('Host', '').strip()
                parsed = urlsplit(url)
                if (parsed.scheme != 'https' or not parsed.netloc or parsed.username or parsed.password
                        or parsed.path not in ('', '/') or parsed.query or parsed.fragment):
                    return self.send_json({'error': 'LB_PUBLIC_URL must be an HTTPS origin, such as https://books.example.com.'}, 400)
                return self.send_json(subscriptions.create_code(
                    u['id'], req.get('days'), books, req.get('label', ''), req.get('redeemDays', 90), url))
            except subscriptions.SubscriptionError as e:
                return self.send_json({'error': str(e)}, 400)
        m = API_ADMIN_SUBSCRIPTION_CODE.match(path)
        if method == 'DELETE' and m and m.group(1):
            try:
                subscriptions.cancel_code(m.group(1))
                return self.send_json({'ok': True})
            except subscriptions.SubscriptionError as e:
                return self.send_json({'error': str(e)}, 400)
        m = API_ADMIN_SUBSCRIPTION.match(path)
        if method == 'DELETE' and m:
            try:
                subscriptions.revoke_subscription(m.group(1))
                return self.send_json({'ok': True})
            except subscriptions.SubscriptionError as e:
                return self.send_json({'error': str(e)}, 404)
        return self.denied()

    def redeem_subscription(self):
        if MODE != 'public' or not subscriptions.required():
            return self.send_json({'error': 'Access codes are not enabled on this server.'}, 404)
        u = self.user()
        if not u:
            return self.send_json({'error': 'Create an account or log in before redeeming a code.'}, 401)
        if u['admin']:
            return self.send_json({'ok': True, 'admin': True, 'subscription': subscriptions.status(u['id'], True)})
        if accounts.limited('redeem', self.client_ip(), 12, 900):
            return self.send_json({'error': 'Too many code attempts. Try again in 15 minutes.'}, 429)
        req = self.read_body()
        if req is None:
            return None
        if not isinstance(req, dict):
            return self.denied('bad request', 400)
        try:
            grant = subscriptions.redeem(req.get('code'), u['id'])
            return self.send_json({'ok': True, 'grant': grant, 'subscription': subscriptions.status(u['id'])})
        except subscriptions.SubscriptionError as e:
            return self.send_json({'error': str(e)}, 400)

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
            m = API_BOOK.match(path)
            if m and disc_book(m.group(1)):  # a book of the disc: admins rename it, move it into a branch
                if method != 'PUT' or not (u and u['admin']):
                    return self.denied()
                body = self.read_body()
                if body is None:
                    return None
                body = body if isinstance(body, dict) else {}
                branches.change_disc(m.group(1), {k: body[k] for k in ('title', 'branch') if k in body})
                return self.send_json(disc_summary(disc_book(m.group(1))))
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
            if part == 'source' and method == 'PUT' and m.group(3):  # (an admin's PDF can be bigger)
                data = self.read_body(max(MAX_UPLOAD, (library.limits(u)['pdf_mb'] + 1) * 1024 * 1024), raw=True)
                if data is None:
                    return None
                library.save_source(b, u, m.group(3), data)
                return self.send_json({'ok': True})
            if part == 'make' and method == 'POST':
                if not u['admin'] and accounts.limited('make', str(u['id']), 30, 86400):
                    return self.send_json({'error': 'You made many books today. Try again tomorrow.'}, 429)
                body = self.read_body()
                if body is None:
                    return None
                if isinstance(body, dict) and body:  # (else: as before)
                    library.save_options(b, body)
                library.start(b)
                return self.send_json({'ok': True})
            if part == 'preview' and method == 'POST':
                body = self.read_body()
                if body is None:
                    return None
                if not u['admin'] and accounts.limited('sample', str(u['id']), 100, 86400):
                    return self.send_json({'error': 'You made many samples today. Try again tomorrow.'}, 429)
                body = body if isinstance(body, dict) else {}
                return self.send_json(library.start_sample(b, body.get('options'), body.get('same'), body.get('again') is True))
            if part == 'designs' and method == 'PUT':
                body = self.read_body()
                if body is None:
                    return None
                return self.send_json(library.save_designs(b, body))
            if part == 'layout' and method == 'POST':
                number = m.group(3) or ''
                if not number.isdigit():
                    raise library.LibraryError('Choose a valid source page.')
                return self.send_json(library.review_layout(b, int(number)))
            if part == 'layout-ai' and method == 'POST':
                number = m.group(3) or ''
                if not number.isdigit():
                    raise library.LibraryError('Choose a valid source page.')
                return self.post_layout_ai(b, int(number))
            if part == 'pictures' and method == 'POST' and m.group(3):  # (the new picture is the body; its box in the address)
                q = {k: v[0] for k, v in parse_qs(urlsplit(self.path).query).items()}
                data = self.read_body((library.LIMITS['image_mb'] + 1) * 1024 * 1024, raw=True)
                if data is None:
                    return None
                return self.send_json(library.replace_picture(b, m.group(3), [q.get(k) for k in ('x', 'y', 'w', 'h')], data, q.get('fit', 'cover')))
            if part == 'pictures' and method == 'DELETE' and m.group(3):
                return self.send_json(library.restore_picture(b, m.group(3)))
            if part == 'tracks' and method == 'PUT' and not m.group(3):  # (a recording: the body; its name in the address)
                name = parse_qs(urlsplit(self.path).query).get('name', [''])[0]
                data = self.read_body((library.limits(u)['pdf_mb'] + 1) * 1024 * 1024, raw=True)
                if data is None:
                    return None
                return self.send_json(library.add_track(b, u, name, data))
            if part == 'tracks' and method == 'POST' and m.group(3) == 'place':
                library.place_tracks(b)
                return self.send_json(self.tracks_info(library.get(b['id'])))
            if part == 'tracks' and method == 'POST' and m.group(3) == 'transcribe':  # (all not done yet)
                if not self.may_transcribe():
                    return self.denied('Only an admin can transcribe here.')
                how = transcription.speech_settings(auth.config())
                for src, file in library.track_files(b):
                    transcription.start(src, Path(file), b.get('lang') or 'en', False, how)
                return self.send_json(self.tracks_info(b))
            if part == 'buttons' and m.group(3):  # (a page's play buttons changed by hand: correction mode)
                if method == 'DELETE':
                    q = {k: v[0] for k, v in parse_qs(urlsplit(self.path).query).items()}
                    return self.send_json({'buttons': library.remove_button(b, m.group(3), q.get('src'), q.get('x'), q.get('y'))})
                body = self.read_body()
                if body is None:
                    return None
                body = body if isinstance(body, dict) else {}
                if method == 'POST':
                    return self.send_json({'buttons': library.add_button(b, m.group(3), str(body.get('file', '')), body.get('x'), body.get('y'))})
                if method == 'PUT':
                    return self.send_json({'buttons': library.move_button(b, m.group(3), str(body.get('src', '')), body.get('from'),
                                                                          body.get('x'), body.get('y'))})
            if part == 'tracks' and method == 'DELETE' and not m.group(3):
                library.remove_tracks(b)
                return self.send_json(self.tracks_info(library.get(b['id'])))
        except (library.LibraryError, branches.BranchError, ocr.OcrError) as e:
            return self.send_json({'error': str(e)}, 400)
        return self.denied()

    def change_branches(self, method, path):
        """Admins make branches of the library, rename them, move them into others, remove them."""
        u = self.user()
        if not (u and u['admin']):
            return self.need_account() if not u else self.denied()
        bid, copy = API_BRANCH.match(path).groups()
        try:
            if method == 'DELETE' and bid and not copy:
                branches.delete(bid)
                return self.send_json({'ok': True})
            body = self.read_body()
            if body is None:
                return None
            body = body if isinstance(body, dict) else {}
            if method == 'POST' and not bid:
                return self.send_json(branches.create(body.get('name'), body.get('parent')))
            if method == 'POST' and copy:
                places = {b['id']: b['branch'] for b in disc_listing(links=False)}
                return self.send_json(branches.copy(bid, body.get('parent'), places))
            if method == 'PUT' and bid and not copy:
                return self.send_json(branches.change(bid, {k: body[k] for k in ('name', 'parent') if k in body}))
        except branches.BranchError as e:
            return self.send_json({'error': str(e)}, 400)
        return self.denied()

    def may_place(self, book):
        """May this user make copies of a book, rename and move them: the disc's books admins, the
        others whoever may change the book."""
        u = self.user()
        return bool(u and u['admin']) if disc_book(book) else library.can_edit(library.get(book), u)

    def change_links(self, method, path):
        """Copies of books (links: the same book in another branch, with its own name): made, renamed,
        moved, removed."""
        u = self.user()
        lid = API_LINK.match(path).group(1)
        link = branches.get_link(lid) if lid else None
        if lid and not link:
            return self.send_json({'error': 'This copy does not exist (any more).'}, 404)
        body = {}
        if method != 'DELETE':
            body = self.read_body()
            if body is None:
                return None
            body = body if isinstance(body, dict) else {}
        book = link['book'] if link else str(body.get('book', ''))[:20]
        if not self.may_place(book):
            return self.need_account() if not u else self.denied()
        try:
            if method == 'POST' and not lid:
                return self.send_json(branches.add_link(book, body.get('branch'), body.get('title', '')))
            if method == 'PUT' and link:
                return self.send_json(branches.change_link(lid, {k: body[k] for k in ('title', 'branch') if k in body}))
            if method == 'DELETE' and link:
                branches.delete_link(lid)
                return self.send_json({'ok': True})
        except branches.BranchError as e:
            return self.send_json({'error': str(e)}, 400)
        return self.denied()

    # ---------- GET ----------

    def api_get(self, path):
        query = parse_qs(urlsplit(self.path).query)
        if path == '/api/migrations' or path.startswith('/api/migrations/'):
            return self.migration_api('GET', path)
        if path == '/api/version':
            return self.send_json({'api': API_VERSION})
        if path == '/api/me':
            user = self.user()
            subscription = {'required': MODE == 'public' and subscriptions.required()}
            subscription.update(subscriptions.status(user['id'], bool(user['admin'])) if user else
                                {'active': False, 'expiresAt': None, 'books': [], 'admin': False})
            return self.send_json({'mode': MODE, 'user': accounts.public_user(user), 'disc': bool(disc()),
                                   'contact': os.environ.get('LB_CONTACT_EMAIL', ''),
                                   'licenses': library.LICENSES, 'reasons': library.REPORT_REASONS,
                                   'limits': library.limits(user), 'subscription': subscription,
                                   'wordFiles': office.available()})  # (can a book be added from a Word file here)
        if path == '/api/layout-ai':
            return self.send_json(self.layout_ai_info())
        if path == '/api/picture-ai':  # (is there a key for the AI image service: never the key itself)
            u = self.user()
            key, model = pictures.ai_settings(auth.config())
            return self.send_json({'ready': bool(key), 'model': model, 'admin': bool(u and u['admin'])})
        if path == '/api/speech-ai':  # (how transcriptions are made: never the key itself)
            return self.send_json(self.speech_info())
        if path == '/api/transcribe-file':
            if not self.may_transcribe():
                return self.denied()
            return self.send_json(transcription.file_status(query.get('job', [''])[0]))
        if API_DISC_SCRIPTS.match(path):
            return self.disc_scripts(API_DISC_SCRIPTS.match(path).group(1))
        if path == '/api/page-languages':
            return self.send_json(library.page_languages())
        if path == '/api/session':  # (older pages)
            return self.send_json({'login': MODE == 'lan' and self.client_address[0] not in LOOPBACK})
        if path == '/api/transcript':
            return self.transcription(query.get('src', [''])[0], language=query.get('language', ['en'])[0])
        if path.startswith(('/api/books', '/api/admin/')) or path == '/api/branches':
            return self.get_library(path, query)
        if path == '/api/words':
            return self.words_api('GET', path)
        m = API_TEXT.match(path)
        if m:
            book, page = m.groups()
            if not self.book_access(book):
                return self.send_json({'error': 'no text for this page'}, 404)
            # ?original=1: the text as it was made, without the corrections (what they changed).
            first = query.get('original') == ['1']
            if ids.LIBRARY_BOOK_RE.match(book):
                doc = library.text_doc(book, page[1:], first)
                if doc and first:
                    doc['original'] = True
                return self.send_json(doc) if doc else self.send_json({'error': 'no text for this page'}, 404)
            edited = edit_path(book, page)
            if os.path.isfile(edited) and not first:
                doc = read_json(edited)
                doc['edited'] = True
                return self.send_json(doc)
            original = os.path.join(disc_data(book), 'text', book, page + '.json')
            if os.path.isfile(original):
                return self.send_json({**read_json(original), 'original': True} if first else read_json(original))
            return self.send_json({'error': 'no text for this page'}, 404)
        m = API_SEARCH.match(path)
        if m:
            book = m.group(1)
            if not self.book_access(book):
                return self.send_json([])
            if ids.LIBRARY_BOOK_RE.match(book):
                return self.send_json(library.search_index(library.get(book)))
            index_path = os.path.join(disc_data(book), 'search', book + '.json')
            if not os.path.isfile(index_path):
                return self.send_json([])
            index = read_json(index_path)
            edit_dir = os.path.join(EDITS, book)
            if os.path.isdir(edit_dir) and os.listdir(edit_dir):
                number = {p['path']: p['n'] for p in (disc_by_slug(book) or {}).get('pages', [])}
                fixed = {number.get(f[:-5]): page_text(read_json(os.path.join(edit_dir, f)))
                         for f in os.listdir(edit_dir) if f.endswith('.json')}
                index = [{'p': e['p'], 't': fixed.get(e['p'], e['t'])} for e in index]
            return self.send_json(index)
        return self.api_get_audio(path, query)

    def api_get_audio(self, path, query):
        if path == '/api/tr-languages':
            return self.send_json(translate.languages())
        if path == '/api/voice-sample':
            missing = tts.missing_packages(query.get('voice', [''])[0])
            if missing:
                return self.send_json({'error': f'Install it first: python -m pip install {missing}'}, 503)
        try:
            if path == '/api/voices':  # ?lang=ar: the voices of a translation language
                return self.send_json(tts.list_voices(query.get('lang', [None])[0]))
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
        except Exception as e:
            return self.send_json({'error': tts.friendly_error(e) or
                'The voice service could not be reached. Is the internet connected?'}, 502)
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
        if not self.subscription_gate(path):
            return
        if path.startswith('/api/'):
            return self.api_get(path)
        m = LIB_MIGRATION_MEDIA.fullmatch(path)
        if m:
            book = library.get(m.group(1))
            file = library.folder(m.group(1), 'migration-media', m.group(2))
            if not self.book_access(m.group(1)) or not os.path.isfile(file):
                return self.send_error(404)
            return self.send_migration_file(file, self.guess_type(file))
        m = LIB_PREVIEW_FILE.match(path)
        if m:  # a page of the sample: only its owner, and only of the latest sample
            b = library.get(m.group(1))
            token = parse_qs(urlsplit(self.path).query).get('token', [''])[0]
            f = library.preview_file_path(m.group(1), m.group(2), token) if library.can_edit(b, self.user()) else None
            if not f:
                return self.send_error(404)
            return self.send_file(f, 'image/webp', private=True)
        m = LIB_PDF.match(path)
        if m:  # the book's PDF, with the pictures replaced: only its owner
            b = library.get(m.group(1))
            f = library.pdf_file(b) if library.can_edit(b, self.user()) else None
            if not f:
                return self.send_error(404)
            name = re.sub(r'[^\w.-]+', '-', b['title'], flags=re.ASCII).strip('-')[:80] or 'book'
            return self.send_migration_file(f, 'application/pdf', download=f'{name}.pdf')
        m = LIB_DESIGN_FILE.match(path)
        if m:  # a page drawn small, to see its design: only its owner
            b = library.get(m.group(1))
            query = parse_qs(urlsplit(self.path).query)
            f = library.design_picture(m.group(1), int(m.group(2)), query.get('full') == ['1']) if library.can_edit(b, self.user()) else None
            if not f:
                return self.send_error(404)
            return self.send_file(f, 'image/webp', private=True)
        m = LIB_FILE.match(path)
        if m:
            b = library.get(m.group(1))
            f = library.file_path(*m.groups()) if self.book_access(m.group(1)) else None
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
        if {'.', '..'} & set(unquote(path).replace('\\', '/').split('/')):
            return False  # (only a script sends them: a way out of the folders below)
        if path.startswith('/web/recordings/'):
            return bool(tts.recording_file(os.path.basename(path), self.rec_dir()))
        if NOT_SERVED.search(path):
            return False
        if path.startswith(('/web/data/', '/web/vendor/', '/.shared/')):
            return MODE != 'public'
        m = LEVEL_URL.match(path)
        if m:
            return MODE != 'public' and any(l['prefix'] == f'/levels/{m.group(1)}' for l in levels())
        return path.startswith('/web/')

    def do_HEAD(self):
        path = urlsplit(self.path).path
        if not self.gate(path):
            return
        if not self.subscription_gate(path):
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
        if path == '/api/redeem':
            if not self.gate(path):
                return None
            return self.redeem_subscription()
        if not self.gate(path):
            return None
        if not self.subscription_gate(path):
            return None
        if path.startswith('/api/admin/subscription-codes'):
            return self.change_subscriptions('POST', path)
        if path == '/api/migrations' or path.startswith('/api/migrations/'):
            return self.migration_api('POST', path)
        region = API_OCR_REGION.match(path)
        if region:
            return self.post_ocr_region(*region.groups())
        if path == '/api/quit' and MODE != 'public' and not TRUST_PROXY and self.client_address[0] == '127.0.0.1':
            # A newer copy of the app is starting: make room for it.
            self.send_json({'ok': True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return None
        if path.startswith(('/api/books', '/api/admin/')):
            return self.change_library('POST', path)
        if API_BRANCH.match(path):
            return self.change_branches('POST', path)
        if API_LINK.match(path):
            return self.change_links('POST', path)
        if path in ('/api/translate', '/api/translate-word'):
            return self.post_translate(path)
        if path == '/api/picture-ai':
            return self.picture_ai('POST')
        if path == '/api/pinyin':
            body = self.read_body()
            if body is None:
                return None
            try:
                return self.send_json({'pinyin': pinyin.of_texts(body.get('texts') if isinstance(body, dict) else None)})
            except ValueError as e:
                return self.send_json({'error': str(e)}, 400)
            except pinyin.Missing as e:
                return self.send_json({'error': str(e)}, 503)
        if API_DISC_SCRIPTS.match(path):
            return self.disc_scripts(API_DISC_SCRIPTS.match(path).group(1), start=True)
        if path == '/api/transcribe-file':  # (any audio or video: the body; its name in the address)
            if not self.may_transcribe():
                return self.denied('Only an admin can transcribe here.') if self.user() else self.need_account()
            q = {k: v[0] for k, v in parse_qs(urlsplit(self.path).query).items()}
            data = self.read_body(TRANSCRIBE_FILE_MB * 2 ** 20, raw=True)
            if data is None:
                return None
            try:
                how = transcription.speech_settings(auth.config())
                return self.send_json({'job': transcription.start_file(q.get('name'), data, q.get('language'), how),
                                       'engine': how[2]})
            except ValueError as e:
                return self.send_json({'error': str(e)}, 400)
        if path == '/api/transcribe':
            body = self.read_body()
            return None if body is None else self.transcription(body.get('src') if isinstance(body, dict) else None, True,
                                                                 body.get('language', 'en') if isinstance(body, dict) else 'en',
                                                                 bool(body.get('force')) if isinstance(body, dict) else False)
        if path == '/api/words' or API_WORD_CATEGORY.match(path):
            return self.words_api('POST', path)
        if path != '/api/recordings':
            return self.denied()
        folder = self.rec_dir()
        if not folder:
            return self.need_account()
        req = self.read_body()
        if req is None:
            return None
        missing = tts.missing_packages(req)
        if missing:
            return self.send_json({'error': f'Install it first: python -m pip install {missing}'}, 503)
        if MODE == 'public' and not self.user()['admin'] and accounts.limited('mp3', str(self.user()['id']), 40, 86400):
            return self.send_json({'error': 'You made many MP3s today. Try again tomorrow.'}, 429)
        if isinstance(req, dict) and not self.book_access(str(req.get('book', ''))):
            return self.denied()
        try:
            return self.send_json({'job': tts.start_job(req, folder)})
        except ValueError as e:
            return self.send_json({'error': str(e)}, 400)

    def tracks_info(self, b):
        """library.tracks_info, with how far their transcription is ({'transcripts': {done, running,
        failed}}) and whether this user may start it."""
        info = library.tracks_info(b)
        info['transcripts'] = transcription.counts([src for src, _ in library.track_files(b)])
        info['canTranscribe'] = self.may_transcribe()
        return info

    def disc_scripts(self, bid, start=False):
        """The scripts of a disc book's recordings and videos (any level's) that speech recognition
        writes (none on the disc, or written by it before: 'auto'): how many, how far it is
        ({files, transcripts: {done, running, failed}, engine, canTranscribe}); start: all not
        done yet the way chosen now (with ElevenLabs: the ones this computer wrote, again)."""
        b = disc_book(bid)
        if not b or not self.may_transcribe():
            return self.denied()
        how = transcription.speech_settings(auth.config())
        media = {}  # src: has a script speech recognition wrote ('auto')
        for p in b['pages']:
            for a in p.get('a', []):
                src = a.get('src')
                if a.get('t') in ('audio', 'video') and transcription.asset_id(src) and (not a.get('script') or a.get('auto')):
                    media[src] = media.get(src, False) or bool(a.get('auto'))
        # On this computer: a script it wrote before is done; with ElevenLabs only one ElevenLabs wrote.
        todo = [src for src, auto in media.items() if how[2] == 'eleven' or not auto]
        if start:
            for src in todo:
                if transcription.done_by(transcription.asset_id(src), how[2]):
                    continue
                root, rel = disc_location(src)
                path = (Path(root) / rel.lstrip('/')).resolve()
                if path.is_relative_to(Path(root).resolve()) and path.is_file():
                    transcription.start(src, path, 'en', True, how)
        counts = transcription.counts(todo, how[2])
        counts['done'] += len(media) - len(todo)
        return self.send_json({'files': len(media), 'transcripts': counts, 'engine': how[2], 'canTranscribe': True})

    def may_transcribe(self):
        """Starting a transcription: on a website only admins (ElevenLabs costs money)."""
        u = self.user()
        return MODE != 'public' or bool(u and u['admin'])

    def transcription(self, src, start=False, language='en', force=False, delete=False):
        """Start or check transcription for an indexed disc recording or private imported book asset.
        On a website: its lines seen by the book's readers; made by admins, taken out by its editors."""
        if start and not self.may_transcribe():
            return self.denied('Only an admin can transcribe here.') if self.user() else self.need_account()
        try:
            imported = LIB_MIGRATION_MEDIA.fullmatch(src or '')
            if imported:
                bid, name = imported.groups()
                book = library.get(bid)
                if not self.book_access(bid, write=delete and MODE == 'public'):
                    return self.send_json({'error': 'You do not have access to this book.'}, 404)
                media = Path(library.folder(bid, 'migration-media', name)).resolve()
                if not media.is_file():
                    return self.send_json({'error': 'The recording file could not be found.'}, 404)
                language = language or (book or {}).get('lang') or 'en'
            else:
                if MODE == 'public' and not self.may_transcribe():  # (the disc's: admins only)
                    return self.denied()
                media = transcription.resolve(src, disc(), disc_location)
            if delete:
                transcription.delete(src)
                return self.send_json({'ok': True})
            if start:
                return self.send_json(transcription.start(src, media, language, force, transcription.speech_settings(auth.config())))
            return self.send_json(transcription.status(src, media, language))
        except ValueError as e:
            return self.send_json({'error': str(e)}, 400)
        except OSError:
            return self.send_json({'error': 'The saved transcript could not be deleted.'}, 409)

    def speech_info(self):
        """How transcriptions are made here: {ready: a key of ElevenLabs saved, engine: 'eleven' |
        'local', local: Whisper installed on this computer, admin, can: may this user start one}."""
        u = self.user()
        key, model, engine = transcription.speech_settings(auth.config())
        return {'ready': bool(key), 'engine': engine, 'model': model, 'local': transcription.local_ready(),
                'admin': bool(u and u['admin']), 'can': self.may_transcribe() and bool(u)}

    def layout_ai_info(self):
        user, config = self.user(), auth.config()
        key, model, source = layout_ai.settings(config)
        admin = bool(user and user['admin'])
        return {'ready': bool(key), 'model': model, 'admin': admin,
                'can': bool(user and (admin or config.get('layoutAllowUsers') is True)),
                'allowUsers': config.get('layoutAllowUsers') is True,
                'sharedAvailable': bool(config.get('imageKey')) if admin else False,
                'useImageKey': config.get('layoutUseImageKey') is True if admin else False,
                'source': source, 'dailyLimit': 20}

    def configure_layout_ai(self):
        user = self.user()
        if not user or not user['admin']:
            return self.denied('Only an admin can change AI layout settings.')
        body = self.read_body()
        if not isinstance(body, dict):
            return self.send_json({'error': 'Invalid AI layout settings.'}, 400)
        changes = {}
        if 'key' in body:
            key = str(body['key'] or '').strip()
            if len(key) > 300 or '\n' in key or '\r' in key:
                return self.send_json({'error': 'Enter a valid OpenAI API key.'}, 400)
            changes['layoutKey'] = key or None
        if 'model' in body:
            model = str(body['model'] or '').strip()
            if not re.fullmatch(r'[A-Za-z0-9_.:\-]{1,100}', model):
                return self.send_json({'error': 'Enter a valid model ID supporting images and structured output.'}, 400)
            changes['layoutModel'] = model
        for request, field in [('allowUsers', 'layoutAllowUsers'), ('useImageKey', 'layoutUseImageKey')]:
            if request in body:
                changes[field] = body[request] is True
        auth.set_config(**changes)
        return self.send_json(self.layout_ai_info())

    def post_layout_ai(self, book, n):
        info = self.layout_ai_info()
        if not info['can']:
            return self.denied('The admin has not enabled AI layout analysis for book owners.')
        body = self.read_body()
        if not isinstance(body, dict):
            return self.send_json({'error': 'Invalid AI layout request.'}, 400)
        if not info['ready']:
            return self.send_json({'error': 'Add an OpenAI API key in AI layout settings first.'}, 400)
        user = self.user()
        if not user['admin'] and accounts.limited('layout-ai', str(user['id']), info['dailyLimit'], 86400):
            return self.send_json({'error': 'Your daily AI layout limit is reached. Use local outlines or try tomorrow.'}, 429)
        stream = body.get('progress') is True
        if stream:
            self.send_response(200)
            self.send_header('Content-Type', 'application/x-ndjson; charset=utf-8')
            self.send_header('X-Accel-Buffering', 'no')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()

        def tell(**data):
            self.wfile.write((json.dumps(data, ensure_ascii=False) + '\n').encode('utf-8'))
            self.wfile.flush()

        try:
            key, model, _ = layout_ai.settings(auth.config())
            def progress(at, message):
                if stream:
                    try:
                        tell(at=at, message=message)
                    except OSError:
                        pass  # complete and cache a paid response even if its browser closed
            result = library.analyze_layout(book, n, key, model, body.get('refresh') is True, progress)
            return tell(result=result) if stream else self.send_json(result)
        except (layout_ai.LayoutError, library.LibraryError, ocr.OcrError) as error:
            return tell(error=str(error)) if stream else self.send_json({'error': str(error)}, 400)
        except OSError:
            if not stream:
                return self.send_json({'error': 'The page or layout cache could not be read. Try local outlines.'}, 500)
            try:
                return tell(error='The layout cache could not be saved. Your current outlines are kept.')
            except OSError:
                return None

    def speech_ai(self):
        """Admins: ElevenLabs's key ({key}: kept in web/server-config.json, never sent back; '' takes
        it out) and the way used ({engine: 'eleven' | 'local'})."""
        u = self.user()
        if not u:
            return self.need_account()
        if not u['admin']:
            return self.denied('Only an admin can change how recordings are transcribed.')
        body = self.read_body()
        if body is None:
            return None
        if not isinstance(body, dict):
            return self.send_json({'error': 'bad request'}, 400)
        changes = {}
        if 'key' in body:
            changes['speechKey'] = str(body.get('key') or '').strip()[:200] or None
        if body.get('engine') in ('eleven', 'local'):
            changes['speechEngine'] = None if body['engine'] == 'eleven' else 'local'
        auth.set_config(**changes)
        return self.send_json(self.speech_info())

    def picture_ai(self, method):
        """The AI image service (pictures.py), only for admins (each picture costs money): PUT its key
        ({key, model}: kept in web/server-config.json, never sent back); POST a picture made for a
        box of a page of a book ({book, page, box, prompt (none: the old picture made again), like:
        from the old picture, context: the page's text around it}): {image: a data address}."""
        u = self.user()
        if not u:
            return self.need_account()
        if not u['admin']:
            return self.denied('Only an admin can use the AI image service: each picture costs money.')
        body = self.read_body()
        if body is None:
            return None
        if not isinstance(body, dict):
            return self.send_json({'error': 'bad request'}, 400)
        if method == 'PUT':
            changes = {'imageKey': str(body.get('key') or '').strip() or None}
            if 'model' in body:
                changes['imageModel'] = str(body.get('model') or '').strip()[:60] or None
            auth.set_config(**changes)
            key, model = pictures.ai_settings(auth.config())
            return self.send_json({'ready': bool(key), 'model': model, 'admin': True})
        b = library.get(str(body.get('book', '')))
        if not library.can_edit(b, u):
            return self.denied()
        try:
            box = [float(v) for v in body.get('box')][:4]
            prompt = pictures.ai_prompt(body.get('prompt'), body.get('context'), bool(body.get('like')))
            like = library.old_picture(b, str(body.get('page', '')), box) if body.get('like') else None
            key, model = pictures.ai_settings(auth.config())
            data = pictures.ai_picture(prompt, key, model, pictures.ai_size(box[2], box[3]), like)
        except (library.LibraryError, pictures.PictureError) as e:
            return self.send_json({'error': str(e)}, 400)
        except (TypeError, ValueError, IndexError):
            return self.send_json({'error': 'Draw a box around the picture first.'}, 400)
        kind = 'image/png' if data[:4] == b'\x89PNG' else 'image/webp' if data[8:12] == b'WEBP' else 'image/jpeg'
        return self.send_json({'image': f'data:{kind};base64,{base64.b64encode(data).decode("ascii")}'})

    def post_ocr_region(self, book, page):
        """OCR one user-drawn rectangle on a page and return normal editable page text. With
        "progress": a line of JSON for every step as it starts ({"plan": [step names]}, then {"at": k}),
        then {"doc": …} or {"error": …} (reading a whole page takes a while)."""
        if not self.book_access(book, write=True):
            return self.need_account() if ids.LIBRARY_BOOK_RE.match(book) and not self.user() else self.denied()
        req = self.read_body()
        if req is None:
            return None
        if not isinstance(req, dict):
            return self.send_json({'error': 'bad region request'}, 400)
        stream = req.get('progress') is True
        if stream:
            self.send_response(200)
            self.send_header('Content-Type', 'application/x-ndjson; charset=utf-8')
            self.send_header('X-Accel-Buffering', 'no')  # (nginx: each line passed on at once)
            self.end_headers()

        def tell(**line):
            if stream:
                self.wfile.write(json.dumps(line, ensure_ascii=False).encode('utf-8') + b'\n')
                self.wfile.flush()
        try:
            if ids.LIBRARY_BOOK_RE.match(book):
                b = library.get(book)
                number = int(page[1:])
                entry = next((p for p in library._pages(b) if int(p['n']) == number), None)
                if not entry:
                    raise ValueError('page not found')
                image_path = library.folder(book, 'pages', f'{number}.webp')
                options = library._options(b)
                language = options['language']
            else:  # (a book of the disc: the app asks by its slug, BO-…, not by its number)
                b = disc_by_slug(book)
                entry = next((p for p in (b or {}).get('pages', []) if p['path'] == page), None)
                if not entry:
                    raise ValueError('page not found')
                image_path = os.path.join(b['_data'], 'pages', b['slug'], page + '.webp')
                language = str(req.get('language') or 'en')
                options = library._clean_options({'language': language, 'dropPinyin': language.startswith('zh-')})
            if language not in ocr.LANGUAGES:
                raise ValueError('Choose a supported language for this page.')
            with Image.open(image_path) as src:
                image = src.convert('RGB')
            coords = [req.get(k) for k in ('x', 'y', 'w', 'h')]
            if not all(isinstance(v, (int, float)) and 0 <= v <= 10000 for v in coords):
                raise ValueError('bad region coordinates')
            x, y, w, h = (int(round(v)) for v in coords)
            x1, y1 = min(image.width, x + w), min(image.height, y + h)
            x, y = max(0, x), max(0, y)
            if x1 - x < 12 or y1 - y < 8:
                raise ValueError('Select a larger area around the missed text.')
            # What to read: the book's languages ('all'), only its main one ('main'), only English ('en').
            read = str(req.get('read') or ('all' if options.get('english') else 'main'))
            passes = library.area_passes(language, read) if read in library.AREA_READS else []
            tell(plan=['Preparing the page picture', *(f"Reading the {ocr.LANGUAGES[k][0].split(' (')[0]} text (OCR)" for k in passes),
                       'Making the sentences'])
            # A fixed, app-private file avoids Windows OCR retaining a handle to a temporary
            # directory and making its cleanup fail. Serialize region requests while reusing it.
            if not _ocr_region_lock.acquire(blocking=False):
                tell(waiting=True)  # (another reading first)
                _ocr_region_lock.acquire()
            try:
                tell(at=0)
                tmp = os.path.join(db.DATA, 'ocr-work', 'regions')
                os.makedirs(tmp, exist_ok=True)
                crop_path = os.path.join(tmp, 'selected-area.png')
                image.crop((x, y, x1, y1)).save(crop_path)
                raw = library.read_png(crop_path, language, read, lambda k: tell(at=1 + k))
            finally:
                _ocr_region_lock.release()
            tell(at=1 + len(passes))
            for line in raw.get('lines', []):
                for word in line.get('words', []):
                    word['x'] += x
                    word['y'] += y
            raw['w'], raw['h'] = image.size
            # (the page picture: the full stops and bullets OCR did not read, the blanks between the pieces of a line)
            doc, _info = library._doc(raw, options, image, stops=True, rows=True)
            if stream:
                return tell(doc=doc)
            return self.send_json(doc)
        except (ValueError, StopIteration, OSError, ocr.OcrError, library.LibraryError) as e:
            if stream:
                return tell(error=str(e) or 'The page could not be read.')
            return self.send_json({'error': str(e) or 'The selected area could not be read.'}, 400)

    def post_translate(self, path):
        req = self.read_body()
        if req is None:
            return None
        if not isinstance(req, dict):
            return self.denied('bad request', 400)
        # Only what goes to the translator counts: checking what is saved (cachedOnly) reads the disk.
        if MODE == 'public' and not req.get('cachedOnly'):
            who = f"u{self.user()['id']}" if self.user() else self.client_ip()
            if accounts.limited('translate', who, 600 if self.user() else 200, 3600):
                return self.send_json({'error': 'Too many translations from here. Try again in a while.'}, 429)
        try:
            src = str(req.get('from') or 'en')  # the book's language: what is translated from
            if path == '/api/translate':
                book = str(req.get('book', ''))
                if not (self.book_access(book) or book == translate.FILES and self.may_transcribe()):
                    return self.denied()
                out, fetched, missing = translate.translate_page(str(req.get('lang', '')), book,
                    str(req.get('page', '')), req.get('paragraphs'), bool(req.get('cachedOnly')), bool(req.get('refresh')), src)
                word_context = isinstance(req.get('words'), list)
                if word_context:
                    _word_out, word_fetched, word_missing = translate.translate_words(
                        str(req.get('lang', '')), req['words'], bool(req.get('cachedOnly')), book_language=src)
                    fetched += word_fetched
                    missing += word_missing
                # none: the sentences the translator gives nothing for (Prepare counts them as done)
                none = translate.sentences_without_translation(str(req.get('lang', '')), book,
                    str(req.get('page', '')), req.get('paragraphs'), src)
                return self.send_json({'translations': out, 'fetched': fetched, 'missing': missing,
                    'none': none, 'wordContext': word_context})
            if isinstance(req.get('items'), list):
                out, fetched, missing = translate.translate_words(str(req.get('lang', '')),
                    req.get('items'), bool(req.get('cachedOnly')), bool(req.get('refresh')), src)
                return self.send_json({'translations': out, 'fetched': fetched, 'missing': missing,
                    'none': translate.words_without_meaning(str(req.get('lang', '')), req.get('items'), src),
                    'wordContext': True})
            return self.send_json({'text': translate.translate_word(str(req.get('lang', '')),
                str(req.get('word', '')), str(req.get('context', '')), req.get('contextOffset'), bool(req.get('cachedOnly')), src),
                'wordContext': True})
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
        if not self.subscription_gate(path):
            return None
        if not self.same_origin():
            return self.denied()
        if path.startswith('/api/migrations/'):
            return self.migration_api('PUT', path)
        if path == '/api/layout-ai':
            return self.configure_layout_ai()
        if path == '/api/picture-ai':
            return self.picture_ai('PUT')
        if path == '/api/speech-ai':
            return self.speech_ai()
        if path.startswith('/api/books/'):
            return self.change_library('PUT', path)
        if API_BRANCH.match(path):
            return self.change_branches('PUT', path)
        if API_LINK.match(path):
            return self.change_links('PUT', path)
        if API_WORD.match(path):
            return self.words_api('PUT', path)
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
        if not self.subscription_gate(path):
            return None
        if not self.same_origin():
            return self.denied()
        if API_ADMIN_SUBSCRIPTION_CODE.match(path) or API_ADMIN_SUBSCRIPTION.match(path):
            return self.change_subscriptions('DELETE', path)
        if path == '/api/transcript':
            query = parse_qs(urlsplit(self.path).query)
            return self.transcription(query.get('src', [''])[0], language=query.get('language', ['en'])[0], delete=True)
        if path.startswith('/api/books/'):
            return self.change_library('DELETE', path)
        if API_BRANCH.match(path):
            return self.change_branches('DELETE', path)
        if API_LINK.match(path):
            return self.change_links('DELETE', path)
        if API_WORD.match(path) or API_WORD_CATEGORY.match(path):
            return self.words_api('DELETE', path)
        m = API_REC.match(path)
        if m:
            folder = self.rec_dir()
            if not folder:
                return self.need_account()
            try:
                tts.delete_recording(m.group(1), folder)
            except OSError:
                return self.send_json({'error': 'The audio file is still in use or could not be deleted. Stop playback and try again.'}, 409)
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
    servers share a port on Windows, and the browser may then keep talking to an old copy.)
    On Linux "reuse address" only lets the app take its port again at once after a restart (the
    old copy's closed connections still hold it for a minute): two cannot listen on it there."""
    allow_reuse_address = os.name != 'nt'
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
    if MODE != 'public':  # each level in its branch (the first time)
        branches.place_levels([(level['id'], level['branch']) for level in levels()])

    if MODE != 'public':
        stop_old_copy(args.port)
    remade = library.resegment_books()  # (once: books made before sentences were cut as now)
    if remade:
        print(f'Sentences made again on {remade} pages: Chinese and English are a sentence each.')
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

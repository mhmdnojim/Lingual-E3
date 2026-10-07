"""Local web server for the American English File 3 browser version.

Serves this folder's parent (so both /web/ and the original /.shared/ content are
reachable) on 127.0.0.1 only, with HTTP Range support so audio and video can seek.

It also stores text corrections made in the app, one file per page in web/edits/
(kept apart from web/data so a rebuild never overwrites them):

    GET    /api/text/<book>/<page>   corrected page text if there is one, else the OCR text
    PUT    /api/text/<book>/<page>   save corrections for a page
    DELETE /api/text/<book>/<page>   remove corrections (back to the OCR text)
    GET    /api/search/<book>        search index of a book, with corrections applied

and the natural-voice MP3s made in the app ("My audio", see tts.py), in web/recordings/:

    GET    /api/voices               English Natural voices
    GET    /api/voice-sample?voice=…&rate=…   a short MP3 to try a voice
    POST   /api/recordings           create an MP3 of chosen sentences (returns a job id)
    GET    /api/jobs/<job>           progress of a job
    GET    /api/recordings           all recordings (without timing details)
    GET    /api/recordings/<id>      one recording with the timing of every sentence and word
    PUT    /api/recordings/<id>      rename ({"title": …})
    DELETE /api/recordings/<id>      delete

and translations of the text (see translate.py), saved in web/translations/:

    GET    /api/tr-languages         languages to translate into
    POST   /api/translate            {lang, book, page, paragraphs: [[sentence, …], …]} -> same shape
    POST   /api/translate-word       {lang, word} -> {"text": …}

Where it can be reached (see auth.py for the login):

    python web/server.py                 this computer only (127.0.0.1), no login
    python web/server.py --lan           also phones and tablets on the home Wi-Fi, with a PIN
    AEF_PASSWORD=… python web/server.py --proxy --no-browser
                                         on a web host, behind a web server (Caddy) that adds HTTPS

    POST   /api/login                {password} -> a login cookie for 30 days
    POST   /api/logout               ends the login on this device
    GET    /api/session              {"login": true} when a login is used

Other options: --port 8765, --no-browser, --host, --password.
"""
import argparse
import json
from http.cookies import SimpleCookie
import os
import re
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlsplit
from urllib.request import Request, urlopen

import auth
import translate
import tts

# Raise when the app needs new server features; web/js/main.js checks it (NEEDS_API) and asks
# to restart the app if an older server is still running. 1 files, 2 text corrections, 3 My audio,
# 4 translations.
API_VERSION = 5  # 1 files, 2 text corrections, 3 My audio, 4 translations, 5 translator busy status

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
WEB = os.path.join(ROOT, 'web')
DATA = os.path.join(WEB, 'data')
EDITS = os.environ.get('AEF_EDITS_DIR') or os.path.join(WEB, 'edits')  # tests use their own
RANGE = re.compile(r'bytes=(\d*)-(\d*)$')
API_TEXT = re.compile(r'^/api/text/(BO-[0-9a-f]+)/(PA-[0-9a-f]+)$')
API_SEARCH = re.compile(r'^/api/search/(BO-[0-9a-f]+)$')
API_REC = re.compile(r'^/api/recordings/(r\d{8}-\d{6}-[0-9a-f]{4})$')
API_JOB = re.compile(r'^/api/jobs/([0-9a-f]{12})$')
MAX_BODY = 5 * 1024 * 1024
write_lock = threading.Lock()
LOOPBACK = ('127.0.0.1', '::1')
# Only the app and the original disc content are served, and never these (data goes through the API).
SERVED = ('/web/', '/.shared/')
NOT_SERVED = re.compile(r'^/web/(server-config\.json|tests/|tools/|edits/|translations/|__pycache__/)|\.(py|pyc|bat|ps1|sh)$|/\.git', re.I)
# Open without logging in: the login page and what a phone needs for its home-screen icon.
PUBLIC = ('/web/login.html', '/web/manifest.webmanifest')
AUTH = auth.Auth(None)  # set in main()
TRUST_PROXY = False     # --proxy: requests come from a web server on this machine (it adds X-Forwarded-*)
LOCAL_FREE = False      # --lan: this computer itself does not need the PIN

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


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        '.webp': 'image/webp', '.wasm': 'application/wasm', '.js': 'text/javascript',
        '.mjs': 'text/javascript', '.json': 'application/json', '.mp3': 'audio/mpeg',
        '.mp4': 'video/mp4', '.swf': 'application/x-shockwave-flash', '.pdf': 'application/pdf',
        '.ppt': 'application/vnd.ms-powerpoint', '.srt': 'application/x-subrip; charset=utf-8',
        '.vtt': 'text/vtt; charset=utf-8',
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):  # keep the console quiet
        pass

    def end_headers(self):
        path = self.path.split('?', 1)[0]
        if path.startswith('/api/'):
            self.send_header('Cache-Control', 'no-store')
        else:
            app_code = path.startswith('/web/') and not path.startswith(('/web/data/', '/web/vendor/'))
            self.send_header('Cache-Control', 'no-cache' if app_code else 'max-age=86400')
            self.send_header('Accept-Ranges', 'bytes')
        super().end_headers()

    def list_directory(self, path):
        self.send_error(404)
        return None

    def translate_path(self, path):
        # Recordings are served from tts.REC_DIR (a separate folder while testing).
        clean = urlsplit(path).path
        if clean.startswith('/web/recordings/'):
            return os.path.join(tts.REC_DIR, os.path.basename(clean))
        return super().translate_path(path)

    # ---------- JSON API ----------

    def send_json(self, obj, status=200, headers=()):
        body = json.dumps(obj, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    # ---------- Login ----------

    def client_ip(self):
        ip = self.client_address[0]
        if TRUST_PROXY and ip in LOOPBACK and self.headers.get('X-Forwarded-For'):
            return self.headers['X-Forwarded-For'].split(',')[0].strip()
        return ip

    def https(self):
        return TRUST_PROXY and self.client_address[0] in LOOPBACK and self.headers.get('X-Forwarded-Proto') == 'https'

    def logged_in(self):
        if not AUTH.on or (LOCAL_FREE and self.client_address[0] in LOOPBACK):
            return True
        morsel = SimpleCookie(self.headers.get('Cookie') or '').get(auth.COOKIE)
        return bool(morsel) and AUTH.valid(morsel.value)

    def gate(self, path):
        """True if the request may go on; else it is answered here (the login page, or 401)."""
        if self.logged_in() or path in PUBLIC or path.startswith('/web/icons/'):
            return True
        if path.startswith('/api/'):
            self.send_json({'error': 'Please log in.', 'login': True}, 401)
        else:
            self.send_response(302)
            self.send_header('Location', '/web/login.html?next=' + quote(path))
            self.send_header('Content-Length', '0')
            self.end_headers()
        return False

    def post_login(self, path):
        if path == '/api/logout':
            return self.send_json({'ok': True}, headers=[('Set-Cookie', AUTH.cookie('', self.https(), 0))])
        if not AUTH.on:
            return self.send_json({'ok': True})
        req = self.read_body()
        if req is None:
            return None
        ok = AUTH.check_password(self.client_ip(), req.get('password', '') if isinstance(req, dict) else '')
        if ok is None:
            return self.send_json({'error': 'Too many wrong tries. Wait 15 minutes.'}, 429)
        if not ok:
            return self.send_json({'error': 'Wrong password.'}, 401)
        return self.send_json({'ok': True}, headers=[('Set-Cookie', AUTH.cookie(AUTH.new_session(), self.https()))])

    def same_origin(self):
        """Refuse changes requested by other web sites (only this app may save)."""
        origin = self.headers.get('Origin')
        return origin is None or urlsplit(origin).netloc == self.headers.get('Host')

    def api_get(self, path):
        m = API_TEXT.match(path)
        if m:
            edited = edit_path(*m.groups())
            if os.path.isfile(edited):
                doc = read_json(edited)
                doc['edited'] = True
                return self.send_json(doc)
            original = os.path.join(DATA, 'text', m.group(1), m.group(2) + '.json')
            if os.path.isfile(original):
                return self.send_json(read_json(original))
            return self.send_json({'error': 'no text for this page'}, 404)
        m = API_SEARCH.match(path)
        if m:
            book = m.group(1)
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
        return self.api_get_audio(path)

    # ---------- My audio (natural-voice MP3s) ----------

    def api_get_audio(self, path):
        if path == '/api/version':
            return self.send_json({'api': API_VERSION})
        if path == '/api/session':
            return self.send_json({'login': AUTH.on and not (LOCAL_FREE and self.client_address[0] in LOOPBACK)})
        if path == '/api/tr-languages':
            return self.send_json(translate.languages())
        if path in ('/api/voices', '/api/voice-sample') and tts.missing_packages():
            return self.send_json({'error': f'Install it first: python -m pip install {tts.missing_packages()}'}, 503)
        try:
            if path == '/api/voices':
                return self.send_json(tts.list_voices())
            if path == '/api/voice-sample':
                q = parse_qs(urlsplit(self.path).query)
                mp3 = tts.voice_sample(q.get('voice', [''])[0], int(q.get('rate', ['0'])[0]))
                self.send_response(200)
                self.send_header('Content-Type', 'audio/mpeg')
                self.send_header('Content-Length', str(len(mp3)))
                self.end_headers()
                self.wfile.write(mp3)
                return None
            if path == '/api/recordings':
                return self.send_json(tts.list_recordings())
            m = API_REC.match(path)
            if m:
                return self.send_json(tts.get_recording(m.group(1)))
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

    def read_body(self):
        """The JSON body of a request, or None (after sending an error)."""
        length = int(self.headers.get('Content-Length') or 0)
        if not 0 < length <= MAX_BODY:
            self.send_json({'error': 'bad size'}, 400)
            return None
        try:
            return json.loads(self.rfile.read(length).decode('utf-8'))
        except ValueError:
            self.send_json({'error': 'bad JSON'}, 400)
            return None

    def do_POST(self):
        path = urlsplit(self.path).path
        if path in ('/api/login', '/api/logout'):
            return self.post_login(path) if self.same_origin() else self.send_json({'error': 'not allowed'}, 403)
        if not self.gate(path):
            return None
        # (Not on a web host: there every request comes from the web server on the same machine.)
        if (path == '/api/quit' and self.same_origin() and self.client_address[0] == '127.0.0.1' and not TRUST_PROXY
                and (not AUTH.on or LOCAL_FREE)):
            # A newer copy of the app is starting: make room for it.
            self.send_json({'ok': True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return None
        if path in ('/api/translate', '/api/translate-word') and self.same_origin():
            return self.post_translate(path)
        if path != '/api/recordings' or not self.same_origin():
            return self.send_json({'error': 'not allowed'}, 403)
        if tts.missing_packages():
            return self.send_json({'error': f'Install it first: python -m pip install {tts.missing_packages()}'}, 503)
        req = self.read_body()
        if req is None:
            return None
        try:
            return self.send_json({'job': tts.start_job(req)})
        except ValueError as e:
            return self.send_json({'error': str(e)}, 400)

    def post_translate(self, path):
        req = self.read_body()
        if req is None:
            return None
        try:
            if path == '/api/translate':
                out, fetched = translate.translate_page(str(req.get('lang', '')), str(req.get('book', '')),
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
            return self.send_json({'error': 'not allowed'}, 403)
        m = API_REC.match(path)
        if m:
            body = self.read_body()
            if body is None:
                return None
            try:
                return self.send_json(tts.rename_recording(m.group(1), body.get('title', '')))
            except (FileNotFoundError, ValueError, AttributeError):
                return self.send_json({'error': 'not found'}, 404)
        m = API_TEXT.match(path)
        if not m:
            return self.send_json({'error': 'not allowed'}, 403)
        doc = self.read_body()
        if doc is None:
            return None
        if not valid_doc(doc):
            return self.send_json({'error': 'bad page text'}, 400)
        target = edit_path(*m.groups())
        os.makedirs(os.path.dirname(target), exist_ok=True)
        clean = {k: doc[k] for k in ('words', 'sent', 'clause', 'blocks')}
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
            return self.send_json({'error': 'not allowed'}, 403)
        m = API_REC.match(path)
        if m:
            tts.delete_recording(m.group(1))
            return self.send_json({'ok': True})
        m = API_TEXT.match(path)
        if not m:
            return self.send_json({'error': 'not allowed'}, 403)
        target = edit_path(*m.groups())
        with write_lock:
            if os.path.isfile(target):
                os.remove(target)
        self.send_json({'ok': True})

    # ---------- Files ----------

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
        if not path.startswith(SERVED) or NOT_SERVED.search(path):
            return self.send_error(404)
        rng = self.headers.get('Range')
        path = self.translate_path(self.path)
        m = RANGE.match(rng.strip()) if rng else None
        if not m or not os.path.isfile(path):
            return super().do_GET()

        size = os.path.getsize(path)
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
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.send_header('Content-Length', str(end - start + 1))
        self.end_headers()
        with open(path, 'rb') as f:
            f.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = f.read(min(256 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def do_HEAD(self):
        path = urlsplit(self.path).path
        if not self.gate(path):
            return
        if path.startswith('/api/') or not path.startswith(SERVED) or NOT_SERVED.search(path):
            return self.send_error(404)
        super().do_HEAD()

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            pass  # the browser cancelled a media request while seeking


class Server(ThreadingHTTPServer):
    """Only one copy of the app may use a port. (Python's default "reuse address" lets two
    servers share a port on Windows, and the browser may then keep talking to an old copy.)"""
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def answers(base):
    try:
        with urlopen(base + '/web/', timeout=2) as r:
            return b'American English File 3' in r.read(5000)
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
    global AUTH, TRUST_PROXY, LOCAL_FREE
    ap = argparse.ArgumentParser(description='American English File 3: the app\'s local web server.')
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--no-browser', action='store_true')
    ap.add_argument('--host', default='127.0.0.1', help='address to listen on (default: this computer only)')
    ap.add_argument('--lan', action='store_true', help='also phones and tablets on the same Wi-Fi (with a PIN)')
    ap.add_argument('--proxy', action='store_true', help='on a web host, behind a web server that adds HTTPS')
    ap.add_argument('--password', help='password to log in (or the environment variable AEF_PASSWORD)')
    args = ap.parse_args()

    password = args.password or os.environ.get('AEF_PASSWORD') or None
    host = args.host
    if args.lan:
        host = '0.0.0.0'
        password = password or auth.lan_pin()
        LOCAL_FREE = True
    if (host not in ('127.0.0.1', 'localhost', '::1') or args.proxy) and not password:
        print('Reachable from other devices without a password: not started.')
        print('Set one with --password or the environment variable AEF_PASSWORD.')
        return 1
    AUTH = auth.Auth(password)
    TRUST_PROXY = args.proxy

    if not args.proxy:
        stop_old_copy(args.port)
    server = None
    for port in range(args.port, args.port + (1 if args.proxy else 20)):
        try:
            server = Server((host, port), Handler)
            break
        except OSError:
            continue
    if server is None:
        print('Could not find a free port.')
        return 1

    url = f'http://127.0.0.1:{server.server_port}/web/'
    print('American English File 3 is running at', url)
    if args.lan:
        ip = lan_address() or "<this computer's address>"
        print()
        print('On a phone or tablet on the same Wi-Fi, open:')
        print(f'    http://{ip}:{server.server_port}/web/')
        print(f'    PIN: {password}')
        print('(If Windows asks whether Python may use the network, allow it for private networks.)')
        print()
    elif args.proxy:
        print('Behind a web server (HTTPS); everyone must log in.')
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

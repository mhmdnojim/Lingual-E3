"""The Windows copy for students (server.py --student https://the-site): the same app on a
student's computer, with the books of the website downloaded into its library.

The student logs in with their website account: the login goes to the website (with this
computer's device id: one of the account's 2 devices, devices.py there) and the website's login
cookie is kept here (web/server-config.json). The website is asked about the account (/api/me)
at every start, every CHECK minutes, and when asked: it says the features, the plan and until
when the app may stay offline (the lease). When the website cannot be reached and the lease is
over — or the clock was moved back — the app is locked: the books are refused (server.py gate)
and the page shows "Connect to the internet to continue", until the website is reached again.

A book is downloaded in the background (download): its pages, thumbnails and text, its audio and
video with their play buttons, and the scripts of its recordings, into the local library (a book
of this computer's user). The disc's books are never shown in this mode (server.py disc()).
"""
import json
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.cookies import SimpleCookie

import auth
import db
import ids
import library
import transcription

CHECK = 10 * 60
AGENT = 'lingua-books/1 (Windows; student)'
TIMEOUT = 30
GRACE = 120  # seconds the clock may be behind the last contact before it counts as moved back

_lock = threading.Lock()
_jobs = {}      # book id -> {'state': 'working' | 'done' | 'error', 'done', 'total', 'error'}
_online = None  # the last check: reached the website?
_thread = None


class StudentError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def site():
    return (auth.config().get('studentSite') or '').rstrip('/')


def configure(address):
    """The website's address (once, from the start file); this computer's device id made."""
    address = str(address or '').strip().rstrip('/')
    if not address.startswith(('http://', 'https://')):
        raise StudentError('The website address must start with https://')
    changes = {'studentSite': address}
    if not auth.config().get('studentDevice'):
        changes['studentDevice'] = secrets.token_hex(16)
    auth.set_config(**changes)


def _request(path, body=None, cookie=True, timeout=TIMEOUT):
    """An answer of the website ({...} or the bytes of a file): (status, data, set-cookie)."""
    config = auth.config()
    headers = {'User-Agent': AGENT}
    if cookie and config.get('studentCookie'):
        headers['Cookie'] = config['studentCookie']
    data = None
    if body is not None:
        data = json.dumps(body).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(site() + path, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            kind = r.headers.get('Content-Type', '')
            return r.status, (json.loads(raw.decode('utf-8')) if 'json' in kind else raw), r.headers.get('Set-Cookie')
    except urllib.error.HTTPError as e:
        with e:
            raw = e.read()
        try:
            return e.code, json.loads(raw.decode('utf-8')), None
        except ValueError:
            return e.code, {}, None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
        raise StudentError(f'The website could not be reached ({getattr(e, "reason", e)}).', 503)


def log_in(email, password):
    """Log in to the website with the student's account; the cookie is kept here."""
    if not site():
        raise StudentError('No website address is set: start the app with "Start as a student".')
    status, d, set_cookie = _request('/api/login', {'email': email, 'password': password, 'device': auth.config().get('studentDevice')}, cookie=False)
    if status != 200:
        raise StudentError(d.get('error') or f'The website answered {status}.', status if status in (401, 403, 429) else 400)
    morsel = SimpleCookie(set_cookie or '').get('lb_session')
    if not morsel:
        raise StudentError('The website gave no login.')
    auth.set_config(studentCookie=f'lb_session={morsel.value}', studentUser=d.get('user'))
    refresh()
    return state()


def log_out():
    try:
        _request('/api/logout', {})
    except StudentError:
        pass
    auth.set_config(studentCookie=None, studentUser=None, studentLease=None, studentMe=None)


def refresh():
    """Ask the website about the account now: the lease, the features and the plan kept. StudentError:
    not reached (the kept answer stays). Returns state()."""
    global _online
    try:
        status, d, _ = _request('/api/me')
    except StudentError:
        _online = False
        raise
    _online = True
    if status != 200 or not isinstance(d, dict):
        raise StudentError(f'The website answered {status}.', 502)
    now = int(time.time())
    if not d.get('user'):  # (logged out there: the device unlinked, the account blocked …)
        auth.set_config(studentCookie=None, studentUser=None, studentLease=None, studentMe=None, studentContact=now)
        return state()
    lease = d.get('offline') or {}
    auth.set_config(studentUser=d['user'], studentContact=now,
                    studentLease={'until': lease.get('until'), 'minutes': lease.get('minutes'), 'serverTime': d.get('serverTime'), 'at': now} if lease else None,
                    studentMe={'features': d.get('features'), 'ai': d.get('ai'), 'subscription': d.get('subscription'), 'contact': d.get('contact')})
    return state()


def locked(now=None):
    """(True, why) when the app must not open the books: no account, or the website not reached
    and the lease over or the clock moved back."""
    config = auth.config()
    now = int(time.time()) if now is None else int(now)
    if not config.get('studentUser'):
        return True, 'Log in with your website account to use the books.'
    if _online:
        return False, ''
    lease = config.get('studentLease')
    if not lease or not lease.get('until'):
        return True, 'This computer has not checked your account yet. Connect to the internet to continue.'
    if now < int(lease.get('at', 0)) - GRACE:
        return True, 'The clock of this computer was moved back. Connect to the internet to continue.'
    if now > int(lease['until']):
        return True, 'The time the app may stay offline is over. Connect to the internet to continue.'
    return False, ''


def state(now=None):
    """What the page is told (/api/me): the account, the lease, locked or not, the website."""
    config = auth.config()
    is_locked, why = locked(now)
    me = config.get('studentMe') or {}
    return {'site': site(), 'user': config.get('studentUser'), 'online': bool(_online), 'lastContact': config.get('studentContact'),
            'offline': config.get('studentLease'), 'locked': is_locked, 'lockedWhy': why,
            'features': me.get('features') or {}, 'ai': me.get('ai') or {}, 'subscription': me.get('subscription') or {},
            'downloads': {k: dict(v) for k, v in _jobs.items()}}


def feature_allowed(feature):
    """Use the last server-provided feature decision on the local student server.

    Missing information is treated as allowed so an older cached account response does not
    unexpectedly break the app; an explicit False from the website is always enforced locally.
    """
    features = (auth.config().get('studentMe') or {}).get('features')
    return not isinstance(features, dict) or features.get(feature) is not False


def check_now():
    """refresh(), quietly: the state either way (the website reached or not)."""
    try:
        refresh()
    except StudentError:
        pass
    return state()


def start_checking():
    """Ask the website every CHECK seconds, in the background."""
    global _thread
    if _thread:
        return

    def loop():
        while True:
            check_now()
            time.sleep(CHECK)
    _thread = threading.Thread(target=loop, daemon=True)
    _thread.start()


# ---------------------------------------------------------------- The books of the website

def books():
    """The books the account may read on the website, with whether each is here already."""
    status, d, _ = _request('/api/books?scope=public')
    if status != 200 or not isinstance(d, list):
        raise StudentError(d.get('error') if isinstance(d, dict) else f'The website answered {status}.', status if status == 403 else 502)
    here = {b['id'] for b in db.rows("SELECT id FROM books WHERE status = 'ready'")}
    out = []
    for b in d:
        if not ids.LIBRARY_BOOK_RE.match(str(b.get('id', ''))) or b.get('link'):
            continue
        out.append({'id': b['id'], 'title': b['title'], 'author': b.get('author', ''), 'pageCount': b.get('pageCount', 0),
                    'cover': site() + b['cover'] if b.get('cover') else None, 'language': b.get('language', 'en'),
                    'here': b['id'] in here, 'job': _jobs.get(b['id'])})
    return out


def download(bid):
    """Download a book into the local library, in the background (download_now): its job."""
    if not ids.LIBRARY_BOOK_RE.match(str(bid)):
        raise StudentError('Unknown book.', 404)
    with _lock:
        job = _jobs.get(bid)
        if job and job['state'] == 'working':
            return dict(job)
        _jobs[bid] = {'state': 'working', 'done': 0, 'total': 0, 'stage': 'Asking the website…'}
    threading.Thread(target=download_now, args=(bid,), daemon=True).start()
    return dict(_jobs[bid])


def _tell(bid, **values):
    with _lock:
        _jobs[bid].update(values)


def _file(path, into):
    """Download a file in chunks so one large audio/video file is never held in memory."""
    config = auth.config()
    headers = {'User-Agent': AGENT}
    if config.get('studentCookie'):
        headers['Cookie'] = config['studentCookie']
    req = urllib.request.Request(site() + path, headers=headers)
    os.makedirs(os.path.dirname(into), exist_ok=True)
    tmp = into + '.tmp'
    try:
        with urllib.request.urlopen(req, timeout=600) as response, open(tmp, 'wb') as out:
            if response.status != 200:
                raise StudentError(f'{path}: the website answered {response.status}.', 502)
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
        db.replace(tmp, into)
    except StudentError:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
    except urllib.error.HTTPError as error:
        try:
            error.close()
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass
        raise StudentError(f'{path}: the website answered {error.code}.', 502) from None
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise StudentError(f'{path}: the website could not be reached ({getattr(error, "reason", error)}).', 503) from None


def download_now(bid):
    """(download, in its thread) The book's row, pages, thumbnails, text, media and scripts."""
    try:
        status, b, _ = _request(f'/api/books/{bid}')
        if status != 200 or not isinstance(b, dict) or not b.get('pages'):
            raise StudentError(b.get('error') if isinstance(b, dict) and b.get('error') else 'The website did not give this book.', 502)
        pages = b['pages']
        media = sorted({a['src'] for p in pages for a in p.get('a', []) if a.get('t') in ('audio', 'video') and str(a.get('src', '')).startswith(f'/lib/{bid}/migration-media/')})
        _tell(bid, total=len(pages) * 3 + len(media) * 2 + 1, stage=f'Downloading {b.get("title", "the book")}…')
        done = 0
        for p in pages:
            n = p['n']
            _file(f'/lib/{bid}/pages/{n}.webp', library.folder(bid, 'pages', f'{n}.webp'))
            _file(f'/lib/{bid}/thumbs/{n}.webp', library.folder(bid, 'thumbs', f'{n}.webp'))
            status, doc, _ = _request(f'/api/text/{bid}/p{n}')
            if status == 200 and isinstance(doc, dict) and 'words' in doc:
                os.makedirs(library.folder(bid, 'text'), exist_ok=True)
                with open(library.folder(bid, 'text', f'{n}.json'), 'w', encoding='utf-8') as f:
                    json.dump({k: doc[k] for k in ('words', 'sent', 'clause', 'blocks') if k in doc}, f, ensure_ascii=False, separators=(',', ':'))
            done += 3
            _tell(bid, done=done)
        for src in media:
            name = src.rsplit('/', 1)[1]
            target = library.folder(bid, 'migration-media', name)
            if not os.path.isfile(target):
                _file(src, target)
            done += 1
            _tell(bid, done=done, stage='Downloading the audio and video…')
            status, t, _ = _request('/api/transcript?' + urllib.parse.urlencode({'src': src}))
            if status == 200 and isinstance(t, dict) and t.get('state') == 'done' and t.get('cues'):
                transcription.save(transcription.cache_id(src), t['cues'], 'website')
            done += 1
            _tell(bid, done=done)
        assets = {'version': 1, 'pages': {str(p['n']): [a for a in p.get('a', []) if a.get('src', '').startswith(f'/lib/{bid}/migration-media/') or a.get('t') not in ('audio', 'video')]
                                         for p in pages if p.get('a')}}
        with open(library.folder(bid, 'migration-assets.json'), 'w', encoding='utf-8') as f:
            json.dump(assets, f, ensure_ascii=False)
        rows = [{'n': p['n'], 'w': p['w'], 'h': p['h'], 'words': 1 if p.get('txt') else 0} for p in pages]
        now = int(time.time())

        def apply(c):
            c.execute('DELETE FROM books WHERE id = ?', (bid,))
            c.execute('INSERT INTO books (id, owner, title, author, about, lang, kind, visibility, status, pages, created, updated) '
                      "VALUES (?, ?, ?, ?, ?, ?, ?, 'private', 'ready', ?, ?, ?)",
                      (bid, db.LOCAL_USER, b.get('title', 'Book'), b.get('author', ''), b.get('about', ''), b.get('language', 'en'),
                       b.get('kind', 'pdf'), json.dumps(rows), now, now))
        db.transaction(apply)
        _tell(bid, state='done', done=done + 1, stage='Downloaded.')
    except StudentError as e:
        _tell(bid, state='error', error=str(e))
    except Exception as e:  # (a full disk, a bad answer …)
        _tell(bid, state='error', error=f'The download failed: {e}')

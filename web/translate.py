"""Translations of the page text (the "Translation" feature).

Uses Google's free online translators (no account or key; the internet is needed only the
first time a sentence is translated). They are not official Google services for other apps,
so they could change; another engine only needs one more function like _chrome().

1. "chrome": the address Chrome uses for "Translate this page". Each paragraph is one item and
   its sentences are marked <a i=0>…</a> <a i=1>…</a>, so every sentence is translated in the
   context of its paragraph and comes back separately.
2. "gtx": the older address, used only when the first one fails. A paragraph is sent as one
   line; Google returns the translation piece by piece together with the original piece, and
   the original pieces are matched to the app's sentences by position.

When an address answers "too many requests" (Google then sends every request to its "unusual
traffic" page for a while), it is left alone for 2 minutes, then 4, 8… up to 30 if it happens
again: asking again at once would only make the block last longer.

Translations are saved per language and page in web/translations/<lang>/<book>/<page>.json as
{"English sentence": "translation"}: each sentence is translated once and then works offline.
A corrected sentence is simply a new English key.
"""
import html
import http.client
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

import ids

WEB = os.path.dirname(os.path.abspath(__file__))
TR_DIR = os.environ.get('AEF_TRANSLATIONS_DIR') or os.path.join(WEB, 'translations')  # tests use their own
CHROME_URL = 'https://translate-pa.googleapis.com/v1/translateHtml'
CHROME_KEY = 'AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520'  # the public key of Chrome's page translator
GTX_URL = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&dt=t&tl='
MAX_CHARS = {'chrome': 5000, 'gtx': 2500}  # per request
REST, MAX_REST = 120, 1800  # seconds an address is left alone after "too many requests"
GAP = 0.4   # seconds at least between two requests to the same address
_lock = threading.Lock()
_engine_lock = threading.Lock()
_resting = {}  # engine -> time until which it is not asked
_last = {}     # engine -> time of the last request
_strikes = {}  # engine -> "too many requests" answers in a row

# (code, English name, own name, right-to-left)
LANGUAGES = [
    ('ar', 'Arabic', 'العربية', True), ('zh-CN', 'Chinese (Simplified)', '中文（简体）', False),
    ('zh-TW', 'Chinese (Traditional)', '中文（繁體）', False), ('fa', 'Persian', 'فارسی', True),
    ('ur', 'Urdu', 'اردو', True), ('tr', 'Turkish', 'Türkçe', False), ('ckb', 'Kurdish (Sorani)', 'کوردی', True),
    ('ku', 'Kurdish (Kurmanji)', 'Kurdî', False), ('ps', 'Pashto', 'پښتو', True), ('he', 'Hebrew', 'עברית', True),
    ('hi', 'Hindi', 'हिन्दी', False), ('bn', 'Bengali', 'বাংলা', False), ('ta', 'Tamil', 'தமிழ்', False),
    ('id', 'Indonesian', 'Bahasa Indonesia', False), ('ms', 'Malay', 'Bahasa Melayu', False),
    ('vi', 'Vietnamese', 'Tiếng Việt', False), ('th', 'Thai', 'ไทย', False), ('ja', 'Japanese', '日本語', False),
    ('ko', 'Korean', '한국어', False), ('tl', 'Filipino', 'Filipino', False), ('ru', 'Russian', 'Русский', False),
    ('uk', 'Ukrainian', 'Українська', False), ('pl', 'Polish', 'Polski', False), ('es', 'Spanish', 'Español', False),
    ('pt', 'Portuguese', 'Português', False), ('fr', 'French', 'Français', False), ('de', 'German', 'Deutsch', False),
    ('it', 'Italian', 'Italiano', False), ('nl', 'Dutch', 'Nederlands', False), ('el', 'Greek', 'Ελληνικά', False),
    ('ro', 'Romanian', 'Română', False), ('az', 'Azerbaijani', 'Azərbaycan', False), ('uz', 'Uzbek', 'Oʻzbek', False),
    ('kk', 'Kazakh', 'Қазақ', False), ('ka', 'Georgian', 'ქართული', False), ('hy', 'Armenian', 'Հայերեն', False),
    ('sw', 'Swahili', 'Kiswahili', False), ('am', 'Amharic', 'አማርኛ', False), ('so', 'Somali', 'Soomaali', False),
    ('ne', 'Nepali', 'नेपाली', False), ('my', 'Burmese', 'မြန်မာ', False), ('km', 'Khmer', 'ខ្មែរ', False),
]
CODES = {c for c, *_ in LANGUAGES}


class TranslateError(Exception):
    pass


class Busy(TranslateError):
    """Google answered "too many requests"; wait: seconds until it may be asked again."""
    def __init__(self, wait):
        super().__init__('Google’s translator is busy (too many requests).')
        self.wait = max(5, wait)


class Offline(TranslateError):
    def __init__(self):
        super().__init__('The translator could not be reached. Translating needs the internet the first time.')


def languages():
    return [{'code': c, 'name': n, 'native': nat, 'rtl': rtl} for c, n, nat, rtl in LANGUAGES]


def _call(engine, req):
    """Send one request (with two more tries on network errors) and return the JSON answer."""
    for attempt in range(3):
        with _engine_lock:
            if time.time() < _resting.get(engine, 0):
                raise Busy(_resting[engine] - time.time())
            wait = _last.get(engine, 0) + GAP - time.time()
            _last[engine] = time.time() + max(0, wait)
        if wait > 0:
            time.sleep(wait)
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                data = json.load(r)
            _strikes[engine] = 0
            return data
        except urllib.error.HTTPError as e:
            if e.code == 429 or '/sorry/' in (e.url or ''):
                with _engine_lock:
                    rest = min(MAX_REST, REST * 2 ** _strikes.get(engine, 0))
                    _strikes[engine] = _strikes.get(engine, 0) + 1
                    _resting[engine] = time.time() + rest
                raise Busy(rest)
            if e.code < 500 or attempt == 2:
                raise TranslateError(f'The translator answered with error {e.code}.')
        except (urllib.error.URLError, http.client.HTTPException, ValueError, TimeoutError, OSError):
            if attempt == 2:
                raise Offline()
        time.sleep(1 + attempt)


def _clean(text):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]*>', '', text))).strip()


def _chrome(lang, items):
    """Chrome's page translator: a list of HTML snippets in, the same list translated out."""
    req = urllib.request.Request(CHROME_URL, data=json.dumps([[items, 'en', lang], 'te_lib']).encode('utf-8'), headers={
        'Content-Type': 'application/json+protobuf', 'X-Goog-API-Key': CHROME_KEY, 'User-Agent': 'Mozilla/5.0'})
    data = _call('chrome', req)
    out = data[0] if isinstance(data, list) and data and isinstance(data[0], list) else None
    if not out or len(out) != len(items) or not all(isinstance(t, str) for t in out):
        raise TranslateError('The translator gave an answer the app does not understand.')
    return out


def _by_chrome(lang, paragraphs):
    """{sentence: translation}; each paragraph is one item with its sentences marked."""
    items = [' '.join(f'<a i={i}>{html.escape(s, quote=False)}</a>' for i, s in enumerate(p)) for p in paragraphs]
    found, alone = {}, []
    for para, t in zip(paragraphs, _chrome(lang, items)):
        parts = {int(i): _clean(x) for i, x in re.findall(r'<a i=(\d+)>(.*?)</a>', t, re.S)}
        if len(para) == 1 and not parts:
            parts = {0: _clean(t)}
        if all(parts.get(i) for i in range(len(para))):
            found.update((s, parts[i]) for i, s in enumerate(para))
        else:  # Google moved a sentence into another one: these are translated one by one
            alone += para
    if alone:
        found.update(zip(alone, map(_clean, _chrome(lang, [html.escape(s, quote=False) for s in alone]))))
    return found


def _gtx(text, lang):
    """The older address: returns [(original piece, translation)] covering the whole text."""
    body = urllib.parse.urlencode({'q': text}).encode('utf-8')
    req = urllib.request.Request(GTX_URL + urllib.parse.quote(lang), data=body, headers={
        'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8'})
    data = _call('gtx', req)
    return [(seg[1] or '', seg[0] or '') for seg in data[0] or [] if seg and seg[1] is not None]


def _align(lines, pieces):
    """lines: [[sentence, ...], ...] sent as one line per item (sentences joined by spaces).
    Returns the translation of every sentence, or None for a line whose sentences Google
    joined differently (a piece crossing a sentence border)."""
    spans = []  # (line, sentence, start, end) in the text sent
    pos = 0
    for li, sents in enumerate(lines):
        for si, s in enumerate(sents):
            spans.append((li, si, pos, pos + len(s)))
            pos += len(s) + 1  # the space or newline after it
    out = [[[] for _ in sents] for sents in lines]
    bad = set()
    k, pos = 0, 0
    for orig, trans in pieces:
        start, end = pos, pos + len(orig.rstrip())
        pos += len(orig)
        if end <= start:
            continue
        while k < len(spans) and spans[k][3] <= start:
            k += 1
        if k >= len(spans):
            break
        li, si, s0, s1 = spans[k]
        if end > s1:  # this piece covers the end of one sentence and the start of the next
            bad.add(li)
        out[li][si].append(trans.strip())
    return [None if li in bad else [' '.join(t).strip() for t in sents] for li, sents in enumerate(out)]


def _by_gtx(lang, paragraphs):
    """{sentence: translation}; one paragraph per line, matched back by position."""
    found, retry = {}, []
    pieces = _gtx('\n'.join(' '.join(p) for p in paragraphs), lang)
    for para, tr in zip(paragraphs, _align(paragraphs, pieces)):
        if tr is None:
            retry.append(para)
        else:
            found.update(zip(para, tr))
    if retry:  # one sentence per line: lines are hard borders for Google
        singles = [[s] for p in retry for s in p]
        for line, tr in zip(singles, _align(singles, _gtx('\n'.join(s[0] for s in singles), lang))):
            found[line[0]] = (tr or [''])[0]
    return found


ENGINES = (('chrome', _by_chrome), ('gtx', _by_gtx))


def _batches(lines, max_chars):
    batch, size = [], 0
    for line in lines:
        n = sum(len(s) + 1 for s in line)
        if batch and size + n > max_chars:
            yield batch
            batch, size = [], 0
        batch.append(line)
        size += n
    if batch:
        yield batch


def _translate_paragraphs(lang, paragraphs, found):
    """Adds {sentence: translation} for the given paragraphs (lists of sentences) to found,
    batch by batch, so what was translated is kept even if a later batch fails."""
    todo = paragraphs
    errors = []
    for name, engine in ENGINES:
        left = []
        for batch in _batches(todo, MAX_CHARS[name]):
            if left:  # this address failed already: the rest goes to the next one
                left += batch
                continue
            try:
                found.update(engine(lang, batch))
            except TranslateError as e:
                errors.append(e)
                left += batch
        todo = left
        if not todo:
            return
    # Every address failed: say the most useful reason (busy: the shortest wait).
    busy = sorted((e for e in errors if isinstance(e, Busy)), key=lambda e: e.wait)
    raise next((e for e in errors if isinstance(e, Offline)), None) or (busy[0] if busy else errors[0])


def _cache_path(lang, book, page):
    return os.path.join(TR_DIR, lang, book, page + '.json')


def _load(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return {}


def _save(path, new):
    with _lock:
        saved = _load(path)  # another request may have saved meanwhile
        saved.update(new)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(saved, f, ensure_ascii=False)
        os.replace(tmp, path)


def translate_page(lang, book, page, paragraphs):
    """Translations for the paragraphs of a page (lists of sentences), same shape, and how many
    sentences had to be translated now. Saved sentences come from the disk; only missing ones
    go to the translator."""
    if lang not in CODES or not ids.BOOK_RE.match(book) or not ids.PAGE_RE.match(page):
        raise ValueError('bad language or page')
    if not (isinstance(paragraphs, list) and all(isinstance(p, list) and all(isinstance(s, str) and len(s) < 3000 for s in p) for p in paragraphs)):
        raise ValueError('bad text')
    paragraphs = [[s.strip() for s in p] for p in paragraphs]
    path = _cache_path(lang, book, page)
    cache = _load(path)
    todo = [[s for s in p if s] for p in paragraphs if any(s and s not in cache for s in p)]
    found = {}
    if todo:
        try:
            _translate_paragraphs(lang, todo, found)
        finally:
            if found:
                _save(path, found)
        cache.update(found)
    return [[cache.get(s, '') if s else '' for s in p] for p in paragraphs], len(found)


def translate_word(lang, word):
    """One word (Word mode), saved in web/translations/<lang>/words.json."""
    word = word.strip()[:60]
    if lang not in CODES or not word:
        raise ValueError('bad word')
    path = os.path.join(TR_DIR, lang, 'words.json')
    cache = _load(path)
    key = word.lower()
    if key not in cache:
        try:
            text = _clean(_chrome(lang, [html.escape(word, quote=False)])[0])
        except TranslateError:
            text = ''.join(t for _, t in _gtx(word, lang)).strip()
        cache[key] = text
        _save(path, {key: text})
    return cache[key]

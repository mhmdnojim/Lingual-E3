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
{"sentence": "translation"}: each sentence is translated once and then works offline. A corrected
sentence is simply a new key.

Every book is translated from its own language (the language of its pages: SOURCES): the disc's
books and most others from English, a Chinese book from Chinese (into English first of all, the
app's main language; or into the language the reader chooses). Translations from another
language than English are saved apart (<lang>/<book>/from-<source>/<page>.json, and the words
with the source in their key): the first versions sent every book as English, and what Google
made of Chinese sent as English is not used.
"""
import html
import hashlib
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
GTX_URL = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&'
MAX_CHARS = {'chrome': 5000, 'gtx': 2500}  # per request
REST, MAX_REST = 120, 1800  # seconds an address is left alone after "too many requests"
GAP = 0.4   # seconds at least between two requests to the same address
_lock = threading.Lock()
_engine_lock = threading.Lock()
_resting = {}  # engine -> time until which it is not asked
_last = {}     # engine -> time of the last request
_strikes = {}  # engine -> "too many requests" answers in a row

# The languages to translate into: (code, English name, own name, right-to-left). English first:
# the main language (books in other languages, as Chinese ones, are translated into it).
LANGUAGES = [
    ('en', 'English', 'English', False),
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
# The languages books are in (the languages of their pages: ocr.LANGUAGES) as the translator knows them.
SOURCES = {'en': 'en', 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW', 'es': 'es', 'fr': 'fr', 'de': 'de',
           'ja': 'ja', 'ko': 'ko', 'ar': 'ar'}


def source(book_language):
    """The translator's code of a book's language ('' or None: English, as the disc's books)."""
    src = SOURCES.get(book_language or 'en')
    if not src:
        raise ValueError('bad book language')
    return src


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


def _chrome(lang, items, src='en'):
    """Chrome's page translator: a list of HTML snippets in (in the language src), the same list translated out."""
    req = urllib.request.Request(CHROME_URL, data=json.dumps([[items, src, lang], 'te_lib']).encode('utf-8'), headers={
        'Content-Type': 'application/json+protobuf', 'X-Goog-API-Key': CHROME_KEY, 'User-Agent': 'Mozilla/5.0'})
    data = _call('chrome', req)
    out = data[0] if isinstance(data, list) and data and isinstance(data[0], list) else None
    if not out or len(out) != len(items) or not all(isinstance(t, str) for t in out):
        raise TranslateError('The translator gave an answer the app does not understand.')
    return out


def _by_chrome(lang, paragraphs, src='en'):
    """{sentence: translation}; each paragraph is one item with its sentences marked."""
    items = [' '.join(f'<a i={i}>{html.escape(s, quote=False)}</a>' for i, s in enumerate(p)) for p in paragraphs]
    found, alone = {}, []
    for para, t in zip(paragraphs, _chrome(lang, items, src)):
        parts = {int(i): _clean(x) for i, x in re.findall(r'<a i=(\d+)>(.*?)</a>', t, re.S)}
        if len(para) == 1 and not parts:
            parts = {0: _clean(t)}
        if all(parts.get(i) for i in range(len(para))):
            found.update((s, parts[i]) for i, s in enumerate(para))
        else:  # Google moved a sentence into another one: these are translated one by one
            alone += para
    if alone:
        found.update(zip(alone, map(_clean, _chrome(lang, [html.escape(s, quote=False) for s in alone], src))))
    return found


def _gtx(text, lang, src='en'):
    """The older address: returns [(original piece, translation)] covering the whole text."""
    body = urllib.parse.urlencode({'q': text}).encode('utf-8')
    req = urllib.request.Request(GTX_URL + urllib.parse.urlencode({'sl': src, 'tl': lang}), data=body, headers={
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


def _by_gtx(lang, paragraphs, src='en'):
    """{sentence: translation}; one paragraph per line, matched back by position."""
    found, retry = {}, []
    pieces = _gtx('\n'.join(' '.join(p) for p in paragraphs), lang, src)
    for para, tr in zip(paragraphs, _align(paragraphs, pieces)):
        if tr is None:
            retry.append(para)
        else:
            found.update(zip(para, tr))
    if retry:  # one sentence per line: lines are hard borders for Google
        singles = [[s] for p in retry for s in p]
        for line, tr in zip(singles, _align(singles, _gtx('\n'.join(s[0] for s in singles), lang, src))):
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


def _writing(sentence):
    """'latin' (only Latin letters), 'other' (letters of another writing: Chinese …), or None."""
    if re.search(r'[^\W\d_A-Za-zÀ-ɏḀ-ỿ]', sentence):
        return 'other'
    return 'latin' if re.search('[A-Za-z]', sentence) else None


def _apart(paragraphs):
    """A paragraph with sentences in two writings (a Chinese sentence, then the book's English for
    it) is sent one sentence at a time: together, the translator moves words of one into the
    other ("…resolve issues" | "related to lost items.")."""
    out = []
    for p in paragraphs:
        mixed = {'latin', 'other'} <= {_writing(s) for s in p}
        out += [[s] for s in p] if mixed else [p]
    return out


def _translate_paragraphs(lang, paragraphs, found, src='en'):
    """Adds {sentence: translation} for the given paragraphs (lists of sentences, in the language
    src) to found, batch by batch, so what was translated is kept even if a later batch fails."""
    todo = _apart(paragraphs)
    errors = []
    for name, engine in ENGINES:
        left = []
        for batch in _batches(todo, MAX_CHARS[name]):
            if left:  # this address failed already: the rest goes to the next one
                left += batch
                continue
            try:
                found.update(engine(lang, batch, src))
            except TranslateError as e:
                errors.append(e)
                left += batch
        todo = left
        if not todo:
            return
    # Every address failed: say the most useful reason (busy: the shortest wait).
    busy = sorted((e for e in errors if isinstance(e, Busy)), key=lambda e: e.wait)
    raise next((e for e in errors if isinstance(e, Offline)), None) or (busy[0] if busy else errors[0])


def _cache_path(lang, book, page, src='en'):
    return os.path.join(TR_DIR, lang, book, *([] if src == 'en' else ['from-' + src]), page + '.json')


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


def _same(lang, src):
    if lang == src:
        raise ValueError('The book is in that language already: choose another language to translate into.')


def translate_page(lang, book, page, paragraphs, cached_only=False, refresh=False, book_language='en'):
    """Translations for the paragraphs of a page, or of a video's script (page: its id), as
    lists of sentences: the same shape, and how many sentences had to be translated now.
    Saved sentences come from the disk; only missing ones go to the translator (refresh: all
    of them again, replacing the saved ones; a sentence it cannot translate keeps its old one).
    book_language: the language of the book's pages ('zh-Hans' …), which it is translated from."""
    src = source(book_language)
    if lang not in CODES or not ids.BOOK_RE.match(book) or not (ids.PAGE_RE.match(page) or ids.SCRIPT_RE.match(page)):
        raise ValueError('bad language or page')
    _same(lang, src)
    if not (isinstance(paragraphs, list) and all(isinstance(p, list) and all(isinstance(s, str) and len(s) < 3000 for s in p) for p in paragraphs)):
        raise ValueError('bad text')
    paragraphs = [[s.strip() for s in p] for p in paragraphs]
    path = _cache_path(lang, book, page, src)
    cache = _load(path)
    todo = [[s for s in p if s] for p in paragraphs if any(s and (refresh or s not in cache) for s in p)]
    found = {}
    if todo and not cached_only:
        try:
            _translate_paragraphs(lang, todo, found, src)
        except Offline:
            # Preserve access to any saved sentences when the connection is unavailable.
            pass
        finally:
            if found:
                _save(path, found)
        cache.update(found)
    result = [[cache.get(s, '') if s else '' for s in p] for p in paragraphs]
    missing = sum(1 for p in paragraphs for s in p if s and not cache.get(s))
    return result, len(found), missing


def sentences_without_translation(lang, book, page, paragraphs, book_language='en'):
    """Which sentences of these paragraphs (their numbers, counted through all paragraphs) the
    translator was asked for and gave nothing: saved blank, they are not asked for again (only
    with refresh). Prepare counts them as done."""
    cache = _load(_cache_path(lang, book, page, source(book_language)))
    flat = [s.strip() for p in paragraphs for s in p]
    return [i for i, s in enumerate(flat) if s and s in cache and not cache[s]]


def _word_key(word, context, offset, src='en'):
    offset_key = str(offset) if isinstance(offset, int) else ''
    from_key = '' if src == 'en' else '\0' + src  # (English: the keys of the first versions)
    return hashlib.sha256((word.casefold() + '\0' + context.casefold() + '\0' + offset_key + from_key).encode('utf-8')).hexdigest()


def _word_marked(word, context, offset):
    if not context:
        # A direct word lookup must carry the same marker as a contextual lookup;
        # otherwise its successful translation can never be extracted or saved.
        return '<a i=0>' + html.escape(word, quote=False) + '</a>'
    if context and isinstance(offset, int) and 0 <= offset < len(context):
        at = offset
        if context[at:at + len(word)].casefold() != word.casefold():
            at = context.casefold().find(word.casefold())
    elif context:
        at = context.casefold().find(word.casefold())
    else:
        at = -1
    if at < 0:
        return html.escape(word, quote=False)
    return (html.escape(context[:at], quote=False) + '<a i=0>'
            + html.escape(context[at:at + len(word)], quote=False) + '</a>'
            + html.escape(context[at + len(word):], quote=False))


def _marked_word_gloss(value):
    """Extract a marked word even if Chrome quotes or rewrites the marker HTML."""
    # Some translator responses entity-escape the markup. Decode it before looking for the
    # marker; the translated word itself is still cleaned/unescaped below.
    for _ in range(2):
        decoded = html.unescape(value)
        if decoded == value:
            break
        value = decoded
    match = re.search(
        r'<(?:a|span)\b[^>]*\b(?:i|data-i)\s*=\s*["\']?0["\']?[^>]*>(.*?)</(?:a|span)>',
        value, re.S | re.I)
    return _clean(match.group(1)) if match else ''


def _none_path(lang):
    # Words the translator was asked for and gave no meaning for (names, numbers...): when.
    return os.path.join(TR_DIR, lang, 'words-none.json')


def _word_entries(lang, items, src='en'):
    if lang not in CODES or not isinstance(items, list) or len(items) > 2000:
        raise ValueError('bad word list')
    _same(lang, src)
    entries = []
    for item in items:
        if not isinstance(item, dict):
            raise ValueError('bad word')
        word = str(item.get('word', '')).strip()[:60]
        context = str(item.get('context', '')).strip()[:1200]
        offset = item.get('contextOffset')
        if offset is not None and (not isinstance(offset, int) or not 0 <= offset <= len(context)):
            offset = None
        if not word:
            raise ValueError('bad word')
        entries.append((word, context, offset, _word_key(word, context, offset, src)))
    return entries


def translate_words(lang, items, cached_only=False, refresh=False, book_language='en'):
    """Translate/cache multiple word occurrences with their sentence context, in few requests
    (refresh: the saved ones again too)."""
    src = source(book_language)
    entries = _word_entries(lang, items, src)
    path = os.path.join(TR_DIR, lang, 'words-context.json')
    cache = _load(path)
    pending = {}
    for word, context, offset, key in entries:
        if refresh or not cache.get(key):
            pending.setdefault(key, (word, context, offset))
    found, none = {}, {}
    if pending and not cached_only:
        batches, batch, size = [], [], 0
        for key, (word, context, offset) in pending.items():
            marked = _word_marked(word, context, offset)
            if batch and (size + len(marked) > 4500 or len(batch) >= 80):
                batches.append(batch)
                batch, size = [], 0
            batch.append((key, word, marked))
            size += len(marked)
        if batch: batches.append(batch)
        try:
            for batch in batches:
                try:
                    translated = _chrome(lang, [x[2] for x in batch], src)
                except Offline:
                    break
                for (key, _word, _), html_text in zip(batch, translated):
                    gloss = _marked_word_gloss(html_text)
                    if gloss:
                        found[key] = gloss
                    else:  # answered, but without a meaning for the word
                        none[key] = int(time.time())
        finally:
            if found:
                _save(path, found)
                cache.update(found)
            if none:
                _save(_none_path(lang), none)
    result = [cache.get(key, '') for _word, _context, _offset, key in entries]
    missing = sum(not text for text in result)
    return result, len(found), missing


def words_without_meaning(lang, items, book_language='en'):
    """Which of these words (their numbers) the translator was asked for and gave no meaning
    for, and have none saved. Prepare counts them as done; reading asks for them again."""
    entries = _word_entries(lang, items, source(book_language))
    cache, none = _load(os.path.join(TR_DIR, lang, 'words-context.json')), _load(_none_path(lang))
    return [i for i, (_w, _c, _o, key) in enumerate(entries) if key in none and not cache.get(key)]


def translate_word(lang, word, context='', context_offset=None, cached_only=False, book_language='en'):
    """One contextual word gloss; the same cache used by whole-page/book preparation."""
    result, _fetched, _missing = translate_words(lang, [{
        'word': word, 'context': context, 'contextOffset': context_offset,
    }], cached_only, book_language=book_language)
    return result[0]

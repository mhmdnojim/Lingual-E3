"""Lingua Books: the books and lessons people add — a text, a PDF, or photos of pages.

Every book is a folder DATA/books/<id>/:
    source/          what was uploaded (text.json + picture, book.pdf, or 0.jpg, 1.png, ...)
    pages/<n>.webp   the page images
    thumbs/<n>.webp  small page images (the library, the page list)
    text/<n>.json    the words of each page with their place, sentences, clauses, paragraphs
                     (the same format as the books of the original disc)
    edits/<n>.json   corrections made by the owner
and a row in the database (db.py) with its title, owner, visibility and pages.

Turning the upload into pages runs in the background, one book at a time:
- text:   the text is set into pages (the Atkinson Hyperlegible font), so the place of every word
          is known exactly; a picture can go at the top;
- PDF:    each page is drawn (pypdfium2) and its words are taken from the PDF (pdfplumber);
          a page without text (a scan), or whose text is broken, is read with OCR (a scan with
          text hidden under it, which OCR made, keeps it unless the owner asks for OCR);
- photos: each photo is turned upright, made smaller if very big, and read with OCR (ocr.py).

Before a PDF or photos are made into pages, the owner tells the app about them (the language,
pinyin, which pages …: the import options), and a sample of 1 to 5 pages chosen at random is
made first (preview/). The owner checks it, changes the options if needed (the app suggests
what to change: tips), tries again, and then has all pages made with the same options.

Before the first sample, the app also finds the designs of the pages (designs.py: the pages that
look alike, as the units of a textbook), and the first sample is a page of each design: what is
read on it becomes the design's areas, which the owner changes (designs.json, designs/). Then the
pages of a design are read area by area, in their order.
"""
import io
import json
import os
import queue
import random
import re
import secrets
import shutil
import sys
import threading
import time
import unicodedata

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

import branches
import db
import designs
import ids
import ocr
import pictures
import tracks

WEB = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(WEB, 'tools'))
from segment_text import (CJK, PART_OF_SPEECH, PINYIN_MARK, SENTENCE_RULES, _other_writing, cut_after,  # noqa: E402
                          doc_from_blocks, missed_stops, page_text, resegment, segment, split_languages, word_lists)

BOOKS = os.path.join(db.DATA, 'books')
FONTS = os.path.join(WEB, 'fonts')
KINDS = ('text', 'pdf', 'images')
PINYIN = ('none', 'some', 'lines')  # Chinese pages: no pinyin, some words, pinyin over every line
LICENSES = {
    'own': 'My own work',
    'public-domain': 'Public domain',
    'cc-by': 'Creative Commons BY',
    'cc-by-sa': 'Creative Commons BY-SA',
    'cc-by-nc': 'Creative Commons BY-NC',
    'other-free': 'Another licence that allows sharing',
}
LIMITS = {
    'pdf_mb': 60, 'image_mb': 15, 'images': 200, 'pages': 300, 'text_chars': 80000,
    'books_per_user': 100, 'user_mb': 600,
}
ADMIN_PDF_MB = 500  # an admin's PDF (on this computer you are the admin): a whole textbook, often 80-220 MB


def limits(user):
    """The limits of what this user adds (an admin's PDFs can be much bigger)."""
    return {**LIMITS, 'pdf_mb': ADMIN_PDF_MB} if user and user['admin'] else dict(LIMITS)
PAGE_W = 1600            # PDF pages and photos are made this wide (photos: at most 2000)
TEXT_W, TEXT_H, MARGIN = 1200, 1700, 100
INK = (24, 27, 34)


class LibraryError(Exception):
    pass


def folder(bid, *parts):
    return os.path.join(BOOKS, bid, *parts)


# ---------------------------------------------------------------- Who may see and change a book

def get(bid):
    return db.one('SELECT * FROM books WHERE id = ?', (bid,)) if ids.LIBRARY_BOOK_RE.match(str(bid)) else None


def can_edit(b, user):
    return bool(b and user and (user['admin'] or b['owner'] == user['id']))


def can_read(b, user):
    if not b:
        return False
    if can_edit(b, user):
        return True
    return b['visibility'] == 'public' and not b['hidden'] and b['status'] == 'ready'


# ---------------------------------------------------------------- What the app is told

def _pages(b):
    return json.loads(b['pages'] or '[]')


def summary(b, user):
    pages = _pages(b)
    owner = db.one('SELECT name FROM users WHERE id = ?', (b['owner'],))
    v = b['updated']
    out = {
        'id': b['id'], 'title': b['title'], 'author': b['author'], 'about': b['about'], 'kind': b['kind'],
        'branch': b['branch'],
        'visibility': b['visibility'], 'license': b['license'], 'licenseName': LICENSES.get(b['license'], ''),
        'source': b['source'], 'hidden': bool(b['hidden']), 'status': b['status'], 'error': b['error'],
        'language': b.get('lang', 'en'),
        'pageCount': len(pages), 'owner': owner['name'] if owner else '', 'mine': bool(user and b['owner'] == user['id']),
        'canEdit': can_edit(b, user), 'created': b['created'], 'updated': b['updated'],
        'cover': f"/lib/{b['id']}/thumbs/1.webp?v={v}" if pages else None, 'job': job(b['id']),
    }
    if out['canEdit']:  # how its pages are made, is there a sample to check, its PDF (with the pictures replaced)
        out.update(importOptions=_options(b), sample=os.path.isfile(folder(b['id'], 'preview', 'preview.json')),
                   pdf=f"/lib/{b['id']}/book.pdf?v={v}" if b['kind'] == 'pdf' and b['status'] == 'ready' else None)
    return out


def full(b, user):
    """A book as the reader wants it: like a book of the original disc, plus the size of every page."""
    v = b['updated']
    out = summary(b, user)
    out.update({
        'slug': b['id'], 'type': b['title'], 'library': True,
        'pages': [{'n': p['n'], 'path': f"p{p['n']}", 'w': p['w'], 'h': p['h'], 'txt': p.get('words', 0) > 0,
                   'img': f"/lib/{b['id']}/pages/{p['n']}.webp?v={v}", 'thumb': f"/lib/{b['id']}/thumbs/{p['n']}.webp?v={v}"}
                  for p in _pages(b)],
    })
    assets_path = folder(b['id'], 'migration-assets.json')
    if os.path.isfile(assets_path):
        with open(assets_path, encoding='utf-8') as source:
            assets = json.load(source).get('pages', {})
        for page in out['pages']:
            page['a'] = assets.get(str(page['n']), [])
    return out


def _clean_options(raw):
    """What the owner told the app about the pages of a PDF or photos (when adding the book, and
    after checking the sample): how its pages are made.
        language    the main language of the pages (OCR reads it)
        english     the pages also have English (not their main language): OCR for English reads it too
        pinyin      Chinese: 'none', 'some' (words or lines here and there), 'lines' (over every line)
        dropPinyin  Chinese: leave lines of pinyin out of the text
        pages       PDF: the pages to use ('3-120, 125'; '' = all)
        ocrAll      PDF: read every page with OCR, not the PDF's own text
        margins     leave out page numbers, running heads and footers
        enhance     make the pictures clearer before OCR (faint, dark or small print)
        fixes       the same mistake fixed on every page: one per line, 'wrong → right'"""
    if not isinstance(raw, dict):
        raw = {}
    language = str(raw.get('language') or 'en')
    if language not in ocr.LANGUAGES:
        raise LibraryError('Choose a supported page language.')
    pinyin = 'some' if raw.get('pinyin') is True else str(raw.get('pinyin') or 'none')  # (True: the first version)
    if not language.startswith('zh-') or pinyin not in PINYIN:
        pinyin = 'none'
    pages = re.sub(r'\s*[-–]\s*', '-', ' '.join(str(raw.get('pages') or '').split()))[:200]
    _page_numbers(pages, None)  # (only how it is written: the number of pages is checked later)
    fixes = '\n'.join(ln.strip() for ln in str(raw.get('fixes') or '').splitlines() if ln.strip())[:3000]
    _parse_fixes(fixes)
    # A Chinese book may also contain English, which should remain. Always remove only
    # lines recognized as pinyin; the Chinese characters and English text are retained.
    return {'language': language, 'english': language != 'en' and bool(raw.get('english', language.startswith('zh-'))),
            'pinyin': pinyin, 'dropPinyin': language.startswith('zh-'),
            'pages': pages, 'ocrAll': bool(raw.get('ocrAll')), 'margins': bool(raw.get('margins')),
            'enhance': bool(raw.get('enhance')), 'fixes': fixes}


def _options(b):
    try:
        return _clean_options(json.loads(b.get('import_options') or '{}'))
    except (ValueError, TypeError, LibraryError):
        return _clean_options({})


def _page_numbers(spec, total):
    """The pages to use, 0-based: '3-120, 125' -> [2 … 119, 124]; '' = all; '20-' = 20 to the
    end. total None: only check how it is written."""
    if not spec:
        return list(range(total or 0))
    out = set()
    for part in re.split(r'[,;\s]+', spec.strip(' ,;')):
        m = re.fullmatch(r'(\d{1,5})(?:-(\d{0,5}))?', part)
        if not m:
            raise LibraryError(f'“{part}” is not a page or pages: write them like 3-120, 125.')
        a = int(m.group(1))
        b = a if m.group(2) is None else int(m.group(2)) if m.group(2) else total or a
        if a < 1 or b < a:
            raise LibraryError(f'“{part}” is not a page or pages: write them like 3-120, 125.')
        if total is not None:
            if a > total:
                raise LibraryError(f'There is no page {a}: the PDF has {total} pages.')
            out.update(range(a - 1, min(b, total)))
    return sorted(out)


def _parse_fixes(text):
    """'wrong → right' lines -> [(wrong, right)] (also -> or =>; the right side may be empty)."""
    out = []
    for n, ln in enumerate(text.splitlines(), 1):
        m = re.fullmatch(r'(.+?)\s*(?:→|->|=>)\s*(.*)', ln.strip())
        if not m or not m.group(1).strip():
            raise LibraryError(f'Fixes, line {n}: write each one like  rn → m  (what the app reads → what it should be).')
        out.append((m.group(1).strip(), m.group(2).strip()))
    return out[:100]


def page_languages():
    """The languages the pages can be in, and for each whether OCR reads it here (scans, photos)."""
    have = ocr.installed(again=True)  # (a language may have been added meanwhile)
    return {'engine': ocr.engine(),
            'languages': [{'code': k, 'name': name, 'ocr': k in have} for k, (name, _, _) in ocr.LANGUAGES.items()]}


def save_options(b, raw):
    options = _clean_options(raw)
    db.run('UPDATE books SET lang = ?, import_options = ?, updated = ? WHERE id = ?',
           (options['language'], json.dumps(options, ensure_ascii=False), int(time.time()), b['id']))
    return options


def list_books(user, scope, query=''):
    q = f"%{query.strip().lower()}%" if query.strip() else None
    if scope == 'mine':
        if not user:
            return []
        rows = db.rows('SELECT * FROM books WHERE owner = ? ORDER BY updated DESC', (user['id'],))
    elif scope == 'all' and user and user['admin']:  # the admin page: every public book
        rows = db.rows("SELECT * FROM books WHERE visibility = 'public' ORDER BY updated DESC LIMIT 500")
    else:
        rows = db.rows("SELECT * FROM books WHERE visibility = 'public' AND hidden = 0 AND status = 'ready' "
                       'ORDER BY updated DESC LIMIT 500')
    books = [summary(r, user) for r in rows]
    if scope != 'all':  # (the admin page: each book once)
        books = branches.with_links(books)
    if q:  # (also by the names of its branch, and of those it is in)
        where = branches.paths()
        books = [b for b in books if q.strip('%') in ' '.join((b['title'], b['author'], b['about'], *where.get(b['branch'], []))).lower()]
    return books


# ---------------------------------------------------------------- Adding, changing, removing

def _clean_meta(meta, b=None):
    out = {}
    for k, n in (('title', 120), ('author', 120), ('about', 600), ('source', 300)):
        if k in meta:
            out[k] = ' '.join(str(meta[k] or '').split())[:n]
    if 'title' in out and not out['title']:
        raise LibraryError('Please give a title.')
    if 'branch' in meta:  # the branch of the library it is in (None: at the top)
        try:
            out['branch'] = branches.check(meta['branch'])
        except branches.BranchError as e:
            raise LibraryError(str(e))
    if 'license' in meta:
        lic = str(meta['license'] or '')
        if lic and lic not in LICENSES:
            raise LibraryError('Unknown licence.')
        out['license'] = lic
    if 'visibility' in meta:
        vis = str(meta['visibility'])
        if vis not in ('private', 'public'):
            raise LibraryError('Unknown visibility.')
        if vis == 'public':
            lic = out.get('license', b['license'] if b else '')
            if not lic:
                raise LibraryError('To share a book with everyone, choose its licence.')
            if meta.get('rights') is not True:
                raise LibraryError('To share a book with everyone, confirm that you may share it.')
        out['visibility'] = vis
    return out


def create(user, meta):
    kind = str(meta.get('kind', ''))
    if kind not in KINDS:
        raise LibraryError('Unknown kind of book.')
    n = db.one('SELECT COUNT(*) AS n FROM books WHERE owner = ?', (user['id'],))['n']
    if n >= LIMITS['books_per_user'] and not user['admin']:
        raise LibraryError(f"You have {n} books already, the most there can be. Delete one first.")
    clean = _clean_meta({**meta, 'visibility': 'private'})
    if not clean.get('title'):
        raise LibraryError('Please give a title.')
    bid = 'L' + secrets.token_hex(5)
    now = int(time.time())
    options = _clean_options(meta.get('importOptions', {}))
    db.run('INSERT INTO books (id, owner, title, author, about, branch, lang, import_options, kind, license, source, created, updated) '
           'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
           (bid, user['id'], clean['title'], clean.get('author', ''), clean.get('about', ''), clean.get('branch'), options['language'],
            json.dumps(options, ensure_ascii=False), kind, clean.get('license', ''), clean.get('source', ''), now, now))
    os.makedirs(folder(bid, 'source'), exist_ok=True)
    return get(bid)


def update(b, meta):
    clean = _clean_meta(meta, b)
    if clean.get('visibility') == 'public' and b['status'] != 'ready':
        raise LibraryError('The book can be shared when it is ready.')
    if not clean:
        return b
    sets = ', '.join(f'{k} = ?' for k in clean)
    db.run(f'UPDATE books SET {sets}, updated = ? WHERE id = ?', (*clean.values(), int(time.time()), b['id']))
    return get(b['id'])


def delete(b):
    shutil.rmtree(folder(b['id']), ignore_errors=True)
    db.run('DELETE FROM books WHERE id = ?', (b['id'],))
    db.run('DELETE FROM links WHERE book = ?', (b['id'],))  # (its copies in other branches)
    db.run('DELETE FROM reports WHERE book = ?', (b['id'],))


def _used_bytes(owner):
    return db.one('SELECT COALESCE(SUM(bytes), 0) AS n FROM books WHERE owner = ?', (owner,))['n']


def _kind_of_image(data):
    if data[:3] == b'\xff\xd8\xff':
        return '.jpg'
    if data[:8] == b'\x89PNG\r\n\x1a\n':
        return '.png'
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return '.webp'
    if data[4:12] in (b'ftypheic', b'ftypheix', b'ftypmif1'):
        raise LibraryError('HEIC photos (iPhone) are not supported yet: choose "Most compatible" in the camera settings, or send JPEG.')
    raise LibraryError('Only JPEG, PNG and WebP pictures can be used.')


def save_source(b, user, part, data):
    """One uploaded file: 'pdf' (the PDF), 'image-<k>' (photo k), 'text' (JSON: {text}) or 'picture'."""
    src = folder(b['id'], 'source')
    os.makedirs(src, exist_ok=True)
    if not user['admin'] and _used_bytes(b['owner']) + len(data) > LIMITS['user_mb'] * 2 ** 20:
        raise LibraryError(f"Your library is full ({LIMITS['user_mb']} MB). Delete a book first.")
    if part == 'pdf' and b['kind'] == 'pdf':
        if not data.startswith(b'%PDF'):
            raise LibraryError('This is not a PDF file.')
        most = limits(user)['pdf_mb']
        if len(data) > most * 2 ** 20:
            raise LibraryError(f"The PDF is too big (at most {most} MB).")
        name = 'book.pdf'
    elif part == 'text' and b['kind'] == 'text':
        try:
            text = str(json.loads(data.decode('utf-8')).get('text', ''))
        except (ValueError, UnicodeDecodeError, AttributeError):
            raise LibraryError('Bad text.')
        if not text.strip():
            raise LibraryError('The text is empty.')
        if len(text) > LIMITS['text_chars']:
            raise LibraryError(f"The text is too long (at most {LIMITS['text_chars']:,} characters).")
        data = json.dumps({'text': text}, ensure_ascii=False).encode('utf-8')
        name = 'text.json'
    elif (part == 'picture' and b['kind'] == 'text') or (re.fullmatch(r'image-\d{1,3}', part) and b['kind'] == 'images'):
        if len(data) > LIMITS['image_mb'] * 2 ** 20:
            raise LibraryError(f"A picture is too big (at most {LIMITS['image_mb']} MB).")
        ext = _kind_of_image(data)
        if part != 'picture' and int(part[6:]) >= LIMITS['images']:
            raise LibraryError(f"At most {LIMITS['images']} photos in one book.")
        for old in os.listdir(src):  # the same photo again (another type): replace it
            if os.path.splitext(old)[0] == part:
                os.remove(os.path.join(src, old))
        name = part + ext
    else:
        raise LibraryError('This file does not fit this kind of book.')
    with open(os.path.join(src, name), 'wb') as f:
        f.write(data)


# ---------------------------------------------------------------- Making the pages (in the background)

_queue = queue.Queue()
_jobs = {}      # making all the pages of a book
_samples = {}   # making a sample: {'state': 'working' | 'error' | 'done', 'stage', 'done', 'total', 'error'}
_jobs_lock = threading.Lock()
_worker = None


def job(bid):
    with _jobs_lock:
        j = _jobs.get(bid)
        return dict(j) if j else None


def _set_job(bid, **kw):
    with _jobs_lock:
        _jobs.setdefault(bid, {}).update(kw)


def _set_sample(bid, **kw):
    with _jobs_lock:
        _samples.setdefault(bid, {}).update(kw)


def _queue_up(item):
    global _worker
    _queue.put(item)
    with _jobs_lock:
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_work, daemon=True)
            _worker.start()


def _selection(b, options):
    """The pages of the upload to use (0-based) as the owner chose, and how many it has. Checks
    that the upload is there."""
    src = folder(b['id'], 'source')
    files = os.listdir(src) if os.path.isdir(src) else []
    if b['kind'] == 'pdf':
        if 'book.pdf' not in files:
            raise LibraryError('Upload the PDF first.')
        import pypdfium2 as pdfium
        try:
            pdf = pdfium.PdfDocument(os.path.join(src, 'book.pdf'))
        except Exception:
            raise LibraryError('The PDF could not be opened (damaged, or protected with a password).')
        total = len(pdf)
        pdf.close()
        chosen = _page_numbers(options['pages'], total)
        if len(chosen) > LIMITS['pages']:
            raise LibraryError(f"{len(chosen)} pages are chosen; at most {LIMITS['pages']} can be used. "
                               f"Choose fewer under “Pages to use” (for example 1-{LIMITS['pages']}).")
        return chosen, total
    if b['kind'] == 'images':
        n = len(_photo_names(src))
        if not n:
            raise LibraryError('Upload the photos first.')
        return list(range(n)), n
    if 'text.json' not in files:
        raise LibraryError('Add the text first.')
    return [], 0


def start(b):
    """Make (or make again) all the pages of a book in the background, as its options say."""
    _selection(b, _options(b))
    db.run("UPDATE books SET status = 'working', error = '', updated = ? WHERE id = ?", (int(time.time()), b['id']))
    _set_job(b['id'], state='waiting', done=0, total=0, stage='Waiting…')
    _queue_up(('make', b['id']))


def sample_size(n):
    """How many pages a sample of a book of n pages has: 1 of a very short one … 5 of a long one."""
    return 1 if n <= 2 else 2 if n <= 5 else 3 if n <= 15 else 4 if n <= 40 else 5


def start_sample(b, raw_options, same=False, again=False):
    """Make a sample of the pages of a PDF or photos with these options, in the background: of the
    pages of the last sample (same: to compare), or of others chosen at random. The first one (or
    again: the designs found again) finds the designs of the pages, and is a page of each."""
    if b['kind'] == 'text':
        raise LibraryError('A text needs no sample: its pages are made at once.')
    if b['status'] in ('working', 'ready'):
        raise LibraryError('The pages of this book are made already.' if b['status'] == 'ready'
                           else 'The pages of this book are being made.')
    options = save_options(b, raw_options)
    _selection(b, options)  # (what is wrong is said at once: no PDF, no such page …)
    if again and os.path.isfile(_designs_path(b['id'])):
        os.remove(_designs_path(b['id']))
    with _jobs_lock:
        _samples[b['id']] = {'state': 'working', 'stage': 'Waiting…', 'done': 0, 'total': 0}
    _queue_up(('sample', b['id'], bool(same)))
    return sample(b['id'])


def _saved_sample(bid):
    path = folder(bid, 'preview', 'preview.json')
    if not os.path.isfile(path):
        return None
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def sample(bid):
    """The sample to check ({'state': 'ready', 'pages', 'tips', 'options', …}), how far making it
    is ({'state': 'working', 'stage', 'done', 'total'}, {'state': 'error', 'error'}), or None."""
    with _jobs_lock:
        s = _samples.get(bid)
        if s and s['state'] != 'done':
            return dict(s)
    saved = _saved_sample(bid)
    return {'state': 'ready', **saved} if saved else None


def preview_file_path(bid, name, token=None):
    if not re.fullmatch(r'\d{1,4}\.webp', name):
        return None
    saved = _saved_sample(bid)
    if not saved or token != saved.get('token'):
        return None
    path = folder(bid, 'preview', name)
    return path if os.path.isfile(path) else None


# ---------------------------------------------------------------- The designs of the pages (designs.py)

def _designs_path(bid):
    return folder(bid, 'designs.json')


def _designs_for(b, options, total):
    """The designs found of the pages chosen now (designs.json), or None (not found yet, or of other pages)."""
    saved = designs.load(_designs_path(b['id']))
    if saved and saved.get('for') == {'kind': b['kind'], 'pages': options['pages'], 'total': total}:
        return saved
    return None


def _small_pages(b, chosen, progress):
    """[(page number, the page drawn small)] of the chosen pages (0-based), kept in designs/<n>.webp."""
    src, out = folder(b['id'], 'source'), []
    pics = folder(b['id'], 'designs')
    shutil.rmtree(pics, ignore_errors=True)
    os.makedirs(pics)
    what = 'page' if b['kind'] == 'pdf' else 'photo'

    def keep(n, img):
        img.save(os.path.join(pics, f'{n}.webp'), 'WEBP', quality=70)
        out.append((n, img))
    if b['kind'] == 'pdf':
        import pypdfium2 as pdfium
        pdf = pdfium.PdfDocument(os.path.join(src, 'book.pdf'))
        try:
            for k, i in enumerate(chosen):
                progress(f'Looking at the design of {what} {i + 1} ({k + 1} of {len(chosen)})', k, len(chosen))
                page = pdf[i]
                keep(i + 1, page.render(scale=designs.SMALL_W / page.get_size()[0]).to_pil().convert('RGB'))
        finally:
            pdf.close()
        return out
    names = _photo_names(src)
    for k, i in enumerate(chosen):
        progress(f'Looking at the design of {what} {i + 1} ({k + 1} of {len(chosen)})', k, len(chosen))
        try:
            with Image.open(os.path.join(src, names[i])) as im:
                im.draft('RGB', (designs.SMALL_W * 2, designs.SMALL_W * 4))  # (a JPEG: decoded smaller, faster)
                img = ImageOps.exif_transpose(im).convert('RGB')
        except Exception:
            raise LibraryError(f'Photo {i + 1} could not be opened.')
        img.thumbnail((designs.SMALL_W, designs.SMALL_W * 4))
        keep(i + 1, img)
    return out


def _find_designs(b, options, chosen, total, progress):
    """Find the designs of the chosen pages, and keep them (no areas yet: the sample reads them)."""
    small = _small_pages(b, chosen, progress)
    progress('Comparing the designs of the pages…', len(chosen), len(chosen))
    found, other = designs.find([n for n, _ in small], [designs.signature(img) for _, img in small])
    return designs.save(_designs_path(b['id']), {'for': {'kind': b['kind'], 'pages': options['pages'], 'total': total},
                                                 'designs': found, 'other': other})


def designs_info(b):
    """The designs of the pages, as the owner sees and changes them: {'designs': [{'pages',
    'example', 'areas'}], 'other' (pages of no design: read whole), 'pages' (all those chosen),
    'token' (of their pictures: /lib/<id>/designs/<n>.webp?v=<token>)}; None: not found yet."""
    options = _options(b)
    try:
        chosen, total = _selection(b, options)
    except LibraryError:
        return None
    saved = _designs_for(b, options, total)
    if not saved:
        return None
    return {'designs': saved['designs'], 'other': saved['other'], 'pages': [i + 1 for i in chosen], 'token': saved['token']}


def save_designs(b, raw):
    """The designs as the owner changed them (their pages, areas …): checked and kept."""
    if b['status'] in ('working', 'ready'):
        raise LibraryError('The pages of this book are made already.' if b['status'] == 'ready'
                           else 'The pages of this book are being made.')
    options = _options(b)
    chosen, total = _selection(b, options)
    saved = _designs_for(b, options, total)
    if not saved:
        raise LibraryError('The designs of the pages are not found yet: make a sample first.')
    try:
        found, other = designs.clean(raw.get('designs') if isinstance(raw, dict) else None, [i + 1 for i in chosen])
    except ValueError as e:
        raise LibraryError(str(e))
    designs.save(_designs_path(b['id']), {**saved, 'designs': found, 'other': other, 'checked': True})  # (used from now on)
    return designs_info(b)


def design_picture(bid, n):
    """The small picture of page n (to see its design), or None."""
    path = folder(bid, 'designs', f'{n}.webp')
    return path if os.path.isfile(path) else None


def _work():
    while True:
        what, bid, *args = _queue.get()
        try:
            (_make if what == 'make' else _make_sample)(bid, *args)
        except Exception as e:  # tell the owner instead of failing silently
            msg = str(e) if isinstance(e, (LibraryError, ocr.OcrError)) else f'Something went wrong ({e.__class__.__name__}: {e}).'
            if what == 'make':
                db.run("UPDATE books SET status = 'error', error = ?, updated = ? WHERE id = ?", (msg[:400], int(time.time()), bid))
                _set_job(bid, state='error', error=msg)
            else:
                _set_sample(bid, state='error', error=msg)


def _make(bid):
    b = get(bid)
    if not b:
        return
    _set_job(bid, state='working', stage='Starting…')
    build = folder(bid, 'build')
    shutil.rmtree(build, ignore_errors=True)
    for sub in ('pages', 'thumbs', 'text'):
        os.makedirs(os.path.join(build, sub))
    if b['kind'] == 'text':
        pages = _text_pages(b, folder(bid, 'source'))
    else:
        options = _options(b)
        chosen, total = _selection(b, options)
        progress = lambda stage, done, total: _set_job(bid, stage=stage, done=done, total=total)  # noqa: E731
        plan = designs.plan(_designs_for(b, options, total))  # (the pages of a design: area by area)
        pages = [(img, doc) for img, doc, _ in _read(b, options, chosen, build, progress, plan)]
    if not pages:
        raise LibraryError('No pages were found.')
    meta = []
    for i, (img, doc) in enumerate(pages, 1):
        _set_job(bid, stage=f'Saving page {i} of {len(pages)}', done=i, total=len(pages))
        img.save(os.path.join(build, 'pages', f'{i}.webp'), 'WEBP', quality=80, method=4)
        th = img.copy()
        th.thumbnail((240, 2000))
        th.save(os.path.join(build, 'thumbs', f'{i}.webp'), 'WEBP', quality=75)
        with open(os.path.join(build, 'text', f'{i}.json'), 'w', encoding='utf-8') as f:
            json.dump(doc, f, ensure_ascii=False, separators=(',', ':'))
        meta.append({'n': str(i), 'w': img.width, 'h': img.height, 'words': len(doc['words'])})
    # Swap in the new pages (corrections belong to the old pages: they go).
    for sub in ('pages', 'thumbs', 'text', 'edits'):
        shutil.rmtree(folder(bid, sub), ignore_errors=True)
    for sub in ('pages', 'thumbs', 'text'):
        os.replace(os.path.join(build, sub), folder(bid, sub))
    shutil.rmtree(build, ignore_errors=True)
    shutil.rmtree(folder(bid, 'preview'), ignore_errors=True)
    shutil.rmtree(folder(bid, 'designs'), ignore_errors=True)  # (the pages drawn small; designs.json stays)
    # (pictures replaced before: in the PDF, and so in the new pages; nothing to take back now)
    shutil.rmtree(folder(bid, 'pictures'), ignore_errors=True)
    for path in (folder(bid, 'pictures.json'), folder(bid, 'source', 'book.original.pdf')):
        if os.path.isfile(path):
            os.remove(path)
    with _jobs_lock:
        _samples.pop(bid, None)
    size = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(folder(bid)) for f in fs)
    db.run("UPDATE books SET status = 'ready', error = '', pages = ?, bytes = ?, updated = ? WHERE id = ?",
           (json.dumps(meta), size, int(time.time()), bid))
    _set_job(bid, state='done', stage='Ready', done=len(meta), total=len(meta))


def _pick(chosen, k, avoid=()):
    """k of the chosen pages at random, spread over the book (one from each part of it), others
    than those to avoid where there are."""
    k = min(k, len(chosen))
    out = []
    for j in range(k):
        part = chosen[len(chosen) * j // k: len(chosen) * (j + 1) // k]
        out.append(random.choice([i for i in part if i not in avoid] or part))
    return out


def _make_sample(bid, same):
    b = get(bid)
    if not b:
        return
    options = _options(b)
    chosen, total = _selection(b, options)
    progress = lambda stage, done, total: _set_sample(bid, stage=stage, done=done, total=total)  # noqa: E731
    saved = _designs_for(b, options, total) or _find_designs(b, options, chosen, total, progress)
    before = [p['n'] - 1 for p in (_saved_sample(bid) or {}).get('pages', [])]
    fresh = [d['example'] - 1 for d in saved['designs'] if d['areas'] is None][:8]  # (designs not read yet: their example)
    if same:  # (pages no longer chosen: others)
        picks = sorted(set([i for i in before if i in set(chosen)] + fresh))
    else:  # the examples (and a page of no design), and pages at random up to a sample's size
        picks = fresh + ([random.choice(saved['other']) - 1] if fresh and saved['other'] and len(fresh) < 8 else [])
        more = [i for i in _pick(chosen, sample_size(len(chosen)), avoid=set(before) | set(picks)) if i not in picks]
        picks = sorted(picks + more[:max(0, sample_size(len(chosen)) - len(picks))])
    picks = picks or _pick(chosen, sample_size(len(chosen)), avoid=set(before))
    build = folder(bid, 'sample-build')
    shutil.rmtree(build, ignore_errors=True)
    os.makedirs(os.path.join(build, 'preview'))
    try:
        made = _read(b, options, picks, build, progress, designs.plan(saved))
        # A design's example read for the first time: its areas, from what was read on it (once
        # the owner has checked the designs, the pages of the sample of that design read by them).
        fresh = [(d, picks.index(d['example'] - 1)) for d in saved['designs'] if d['areas'] is None and d['example'] - 1 in picks]
        for d, k in fresh:
            img, doc, info = made[k]
            d['areas'] = designs.proposed(doc, img.width, img.height, info['lists'], info['raw'])
            for j, i in enumerate(picks):
                if d['areas'] and i + 1 in d['pages'] and saved.get('checked'):
                    img, doc, info = made[j]
                    doc, found = _doc_in_areas(info['raw'], options, img, info['how'] not in ('pdf', 'hidden'), d['areas'])
                    made[j] = (img, doc, {**info, **found, 'areas': d['areas']})
        if fresh:
            saved = designs.save(_designs_path(bid), saved)
        design_of = {n: k for k, d in enumerate(saved['designs']) for n in d['pages']}
        token = secrets.token_hex(8)
        pages = []
        for i, (img, doc, info) in zip(picks, made):
            img.save(os.path.join(build, 'preview', f'{i + 1}.webp'), 'WEBP', quality=80, method=4)
            k = design_of.get(i + 1)  # areas: its design's (suggested, or used: framed)
            pages.append({'n': i + 1, 'img': f"/lib/{bid}/preview/{i + 1}.webp?token={token}", 'how': info['how'],
                          'text': page_text(doc), 'words': len(doc['words']), 'design': k,
                          'areas': (saved['designs'][k]['areas'] if k is not None else None) or [], 'framed': bool(info['areas'])})
        result = {'total': total, 'chosen': len(chosen), 'pages': pages, 'options': options, 'token': token,
                  'tips': _tips(b['kind'], options, picks, made), 'designs': len(saved['designs']),
                  'checked': bool(saved.get('checked'))}
        with open(os.path.join(build, 'preview', 'preview.json'), 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False)
        shutil.rmtree(folder(bid, 'preview'), ignore_errors=True)
        os.replace(os.path.join(build, 'preview'), folder(bid, 'preview'))
    finally:
        shutil.rmtree(build, ignore_errors=True)
    _set_sample(bid, state='done')


def _tips(kind, options, picks, made):
    """What the app noticed in the sample, and what to change for it: [{'text', 'set': {option: value}}]."""
    tips = []
    lang = options['language']
    name = lambda code: ocr.LANGUAGES[code][0]  # noqa: E731
    label = lambda ks: ('photo ' if kind == 'images' else 'page ') + ', '.join(str(picks[k] + 1) for k in ks)  # noqa: E731
    read = [k for k, (_, _, info) in enumerate(made) if info['how'] != 'pdf']  # read with OCR (the hidden text too)

    letters = [ch for _, doc, _ in made for ch in page_text(doc) if ch.isalpha()]
    cjk = sum(1 for ch in letters if CJK.match(ch))
    kana = sum(1 for ch in letters if '぀' <= ch <= 'ヿ')
    hangul = sum(1 for ch in letters if '가' <= ch <= '힯')
    arabic = sum(1 for ch in letters if '؀' <= ch <= 'ۿ')
    asian = lang in ('zh-Hans', 'zh-Hant', 'ja', 'ko')
    if not asian and cjk > 0.3 * len(letters):
        guess = 'ko' if hangul > cjk / 2 else 'ja' if kana > cjk / 5 else 'zh-Hans'
        tips.append({'text': f'The pages look {name(guess)}. Is that their language?', 'set': {'language': guess}})
    elif lang != 'ar' and arabic > 0.3 * len(letters):
        tips.append({'text': 'The pages look Arabic. Is that their language?', 'set': {'language': 'ar'}})
    elif asian and len(letters) > 40 and cjk < 0.05 * len(letters):
        tips.append({'text': f'Hardly any {name(lang)} characters were found. Is that the language of the pages?',
                     'set': {'language': 'en'}})

    empty = [k for k, (_, doc, _) in enumerate(made) if not doc['words']]
    if empty and not options['enhance'] and any(k in read for k in empty):
        tips.append({'text': f'No words were found on {label(empty)}. If there is text on it, the app can try to make '
                             'the picture clearer before reading it.', 'set': {'enhance': True}})
    elif empty:
        tips.append({'text': f'No words were found on {label(empty)}. If there is text on it, check the language of the pages.'})

    broken = [k for k, (_, _, info) in enumerate(made) if info['how'] == 'broken']
    hidden = [k for k, (_, _, info) in enumerate(made) if info['how'] == 'hidden']
    if broken and not options['ocrAll']:
        tips.append({'text': f'The PDF’s own text of {label(broken)} was broken, so it was read with OCR. If other pages '
                             'show strange letters too, the app can read every page with OCR.', 'set': {'ocrAll': True}})
    elif hidden and not options['ocrAll']:
        tips.append({'text': f'This PDF is a scanned book: {label(hidden)} {"is a picture" if len(hidden) == 1 else "are pictures"}, '
                             'and the text you can select or copy in a PDF viewer is hidden under the picture. OCR made it when '
                             'the book was scanned, with its mistakes. The app can read every page with its own OCR instead: '
                             'try it on the same pages and keep the better one.',
                     'set': {'ocrAll': True}})

    pinyin = [k for k, (_, _, info) in enumerate(made) if info['pinyin']]
    if lang.startswith('zh-') and pinyin:
        if options['pinyin'] == 'none':
            tips.append({'text': f'There are lines of pinyin on {label(pinyin)}.', 'set': {'pinyin': 'lines'}})
        if not options['dropPinyin'] and any(k in read for k in pinyin):
            tips.append({'text': 'Pinyin read from a picture often has wrong tone marks (ǎ read as ä). The app can leave '
                                 'the lines of pinyin out (the characters stay), or you can fix the mistakes below.',
                         'set': {'pinyin': 'lines' if options['pinyin'] == 'none' else options['pinyin'], 'dropPinyin': True}})

    margins = [k for k, (_, _, info) in enumerate(made) if info['margins']]
    if not options['margins'] and len(margins) >= max(1, len(made) / 2):
        tips.append({'text': 'Page numbers or headings at the very top or bottom of the pages are read as text too.',
                     'set': {'margins': True}})
    return tips


# ---------- Text: set into pages

def _font(bold, size):
    return ImageFont.truetype(os.path.join(FONTS, f"AtkinsonHyperlegible-{'Bold' if bold else 'Regular'}.ttf"), size)


def _text_pages(b, src):
    with open(os.path.join(src, 'text.json'), encoding='utf-8') as f:
        text = json.load(f)['text']
    picture = next((os.path.join(src, f) for f in os.listdir(src) if f.startswith('picture')), None)
    styles = {'title': (_font(True, 66), 1.25, 0.9), 'heading': (_font(True, 50), 1.3, 0.6), 'body': (_font(False, 44), 1.6, 0.85)}
    # Paragraphs: separated by an empty line; "# " starts a heading; inside one, a line break stays.
    paras = [('title', b['title'])]
    for chunk in re.split(r'\n\s*\n', text.replace('\r\n', '\n').strip()):
        chunk = chunk.strip()
        if chunk.startswith('#'):
            paras.append(('heading', chunk.lstrip('#').strip()))
        elif chunk:
            paras.append(('body', chunk))
    pages, blocks = [], []
    img = draw = None
    y = 0

    def new_page():
        nonlocal img, draw, y
        if img is not None:
            pages.append((img, doc_from_blocks(blocks)))
            blocks.clear()
        img = Image.new('RGB', (TEXT_W, TEXT_H), 'white')
        draw = ImageDraw.Draw(img)
        y = MARGIN

    new_page()
    width = TEXT_W - 2 * MARGIN
    for k, (style, para) in enumerate(paras):
        font, spacing, after = styles[style]
        size = font.size
        ascent, descent = font.getmetrics()
        line_h = int(size * spacing)
        space = font.getlength(' ')
        block = []
        for src_line in para.split('\n'):
            words = src_line.split()
            line, x = [], MARGIN
            rows = []
            for w in words:
                wl = font.getlength(w)
                if line and x + wl > MARGIN + width:
                    rows.append(line)
                    line, x = [], MARGIN
                line.append((w, x, wl))
                x += wl + space
            if line:
                rows.append(line)
            for row in rows:
                if y + line_h > TEXT_H - MARGIN:
                    if block:
                        blocks.append(block)
                        block = []
                    new_page()
                base = y + int((line_h - (ascent + descent)) / 2) + ascent
                ln = {'words': []}
                for w, wx, wl in row:
                    draw.text((wx, base), w, font=font, fill=INK, anchor='ls')
                    ln['words'].append({'t': w, 'x': round(wx), 'y': base - ascent, 'w': max(1, round(wl)), 'h': ascent + descent})
                block.append(ln)
                y += line_h
        if block:
            blocks.append(block)
        y += int(size * after)
        if k == 0 and picture:  # the picture, under the title
            pic = ImageOps.exif_transpose(Image.open(picture)).convert('RGB')
            pic.thumbnail((width, int(TEXT_H * 0.4)))
            if y + pic.height > TEXT_H - MARGIN:
                new_page()
            img.paste(pic, (MARGIN + (width - pic.width) // 2, y))
            y += pic.height + int(size * 0.9)
    pages.append((img, doc_from_blocks(blocks)))
    return pages


# ---------- PDF and photos: the page pictures and their words

def _read(b, options, indices, build, progress, plan=None):
    """These pages of the upload (0-based), made as the owner asked: [(picture, text document,
    info)]. info: how the words were found ('pdf'; 'hidden': the PDF's text hidden under a scan,
    made by OCR when it was scanned; or with OCR: 'scan' (no text in the PDF), 'broken' (the PDF's
    text was broken), 'ocr' (asked for), 'photo'), and how many lines of the
    page are pinyin, and in its margins; its words as found (raw) and the areas it was read by.
    plan: {page number: the areas of its design} (designs.plan): those pages are read area by area."""
    src = folder(b['id'], 'source')
    if b['kind'] == 'pdf':
        found = _pdf_pages(os.path.join(src, 'book.pdf'), indices, options['ocrAll'], progress)
    else:
        names = _photo_names(src)
        found = _photo_pages([os.path.join(src, names[i]) for i in indices], progress)
    scans = [k for k, (_, raw, _) in enumerate(found) if raw is None]
    if scans:
        raws = _ocr([found[k][0] for k in scans], build, options, progress)
        for k, raw in zip(scans, raws):
            found[k] = (found[k][0], raw, found[k][2])
    out = []
    for i, (img, raw, how) in zip(indices, found):
        areas = (plan or {}).get(i + 1)
        stops = how not in ('pdf', 'hidden')  # (read with OCR: its stops)
        doc, info = _doc_in_areas(raw, options, img, stops, areas) if areas else _doc(raw, options, img, stops=stops)
        out.append((img, doc, {'how': how, **info, 'raw': raw, 'areas': areas}))
    return out


def _pdf_pages(path, indices, ocr_all, progress):
    """[(picture, its words from the PDF, or None: to be read with OCR, how)] of these pages."""
    import pdfplumber
    import pypdfium2 as pdfium
    pdf = pdfium.PdfDocument(path)
    out = []
    try:
        with pdfplumber.open(path) as plumb:
            for k, i in enumerate(indices):
                progress(f'Reading page {i + 1} ({k + 1} of {len(indices)})', k, len(indices))
                page = pdf[i]
                wpt, hpt = page.get_size()
                img = page.render(scale=min(PAGE_W / wpt, 4000 / hpt)).to_pil().convert('RGB')
                if ocr_all:
                    out.append((img, None, 'ocr'))
                    continue
                p = plumb.pages[i]
                words = []
                if not (p.rotation or 0) % 360:  # turned pages: the words' places would not match; read with OCR
                    try:
                        words = p.extract_words(use_text_flow=True, keep_blank_chars=False, x_tolerance=1.5)
                    except Exception:
                        words = []
                if sum(any(ch.isalnum() for ch in w['text']) for w in words) < 3:
                    out.append((img, None, 'scan'))
                elif _broken(words):
                    out.append((img, None, 'broken'))
                else:
                    x0, top = p.bbox[0], p.bbox[1]
                    sx, sy = img.width / p.width, img.height / p.height
                    out.append((img, {'w': img.width, 'h': img.height, 'lines': _lines(words, x0, top, sx, sy)},
                                'hidden' if _hidden_text(page) else 'pdf'))
    finally:
        pdf.close()
    return out


def _hidden_text(page):
    """The PDF's text of this page (pdfium) is hidden under its picture: a scan that OCR gave a text
    (OCRmyPDF, "Recognize text" …), with OCR's mistakes. Most of its text is drawn invisible."""
    import pypdfium2.raw as pdfium_c
    modes = [pdfium_c.FPDFTextObj_GetTextRenderMode(o.raw) for o in page.get_objects() if o.type == pdfium_c.FPDF_PAGEOBJ_TEXT]
    return sum(m == pdfium_c.FPDF_TEXTRENDERMODE_INVISIBLE for m in modes) * 2 > len(modes)


def _broken(words):
    """The PDF has text, but not the real one: characters it cannot name ("(cid:12)", private
    use, �), or Latin letters with accents where there are other letters ("ÎÒ¼ÒÓÐ")."""
    text = ''.join(w['text'] for w in words)
    letters = [ch for ch in text if ch.isalpha()]
    unknown = text.count('(cid:') + len(re.findall('[-�]', text))
    accented = sum(1 for ch in letters if 'À' <= ch <= 'ÿ')
    return unknown > 0.1 * len(words) or accented > 0.3 * max(1, len(letters))


def _lines(words, x0, top, sx, sy):
    """PDF words (in reading order) into lines: a new line where the text goes down or back left."""
    lines, cur, last = [], None, None
    for w in words:
        h = w['bottom'] - w['top']
        box = {'t': w['text'], 'x': round((w['x0'] - x0) * sx), 'y': round((w['top'] - top) * sy),
               'w': max(1, round((w['x1'] - w['x0']) * sx)), 'h': max(1, round(h * sy))}
        if cur and abs(w['top'] - last['top']) < 0.5 * h and w['x0'] >= last['x1'] - 2:
            cur['words'].append(box)
        else:
            cur = {'words': [box]}
            lines.append(cur)
        last = w
    return lines


def _photo_names(src):
    return sorted((f for f in os.listdir(src) if f.startswith('image-')), key=lambda f: int(re.sub(r'\D', '', f)))


def _photo_pages(paths, progress):
    """[(picture, None: to be read with OCR, 'photo')]: each photo upright, and not too big."""
    out = []
    for k, p in enumerate(paths):
        n = int(re.sub(r'\D', '', os.path.basename(p))) + 1
        progress(f'Preparing photo {n} ({k + 1} of {len(paths)})', k, len(paths))
        try:
            img = ImageOps.exif_transpose(Image.open(p)).convert('RGB')
        except Exception:
            raise LibraryError(f'Photo {n} could not be opened.')
        if img.width > 2000:
            img = img.resize((2000, round(img.height * 2000 / img.width)), Image.LANCZOS)
        out.append((img, None, 'photo'))
    return out


AREA_READS = ('all', 'main', 'en')


def area_passes(language, read='all'):
    """The languages read_png reads one after the other (for showing how far it is)."""
    return ocr.passes(language, language != 'en' and read in ('all', 'en'))


def read_png(png, language, read='all', progress=None):
    """The words of one picture (an area of a page read again), of the languages asked: read
    'all' (the main language and English), 'main' (only the main language) or 'en' (only English).
    progress(k): pass k of area_passes() starts."""
    if read not in AREA_READS:
        raise LibraryError('Choose what to read.')
    if language == 'en':
        return ocr.read_pages([png], 'en', progress=progress)[0]
    if read == 'en':  # both read (pinyin keeps its marks, so it is left out), without the other writing
        raw = ocr.read_pages([png], language, True, progress)[0]
        raw['lines'] = [{'words': [w for w in ln['words'] if not ocr.OTHER_SCRIPT.search(w['t']) and re.search(r'[\x21-\x7e]', w['t'])]}
                        for ln in raw['lines']]
    else:
        raw = ocr.read_pages([png], language, read == 'all', progress)[0]
        if read == 'main' and language in ('zh-Hans', 'zh-Hant', 'ja', 'ko', 'ar'):  # its writing only: no Latin letters
            raw['lines'] = [{'words': [w for w in ln['words'] if not re.search('[A-Za-z]', w['t'])]} for ln in raw['lines']]
    raw['lines'] = [ln for ln in raw['lines'] if ln['words']]
    return raw


def _ocr(imgs, build, options, progress):
    """The words of these pictures (raw), read with OCR in the language of the pages."""
    progress(f"Reading the words of {len(imgs)} page{'s' if len(imgs) > 1 else ''} (OCR)…", 0, len(imgs))
    tmp = os.path.join(build, 'ocr')
    os.makedirs(tmp, exist_ok=True)
    pngs, scales = [], []
    for i, img in enumerate(imgs):
        pic, scale = _clearer(img) if options['enhance'] else (img, 1)
        pngs.append(os.path.join(tmp, f'{i:04d}.png'))
        pic.save(pngs[-1])
        scales.append(scale)
    raws = ocr.read_pages(pngs, options['language'], options['english'])
    shutil.rmtree(tmp, ignore_errors=True)
    for raw, scale, img in zip(raws, scales, imgs):
        if scale != 1:  # back to the places on the page picture
            for ln in raw['lines']:
                for w in ln['words']:
                    w.update({k: round(w[k] / scale) for k in ('x', 'y', 'w', 'h')})
        raw['w'], raw['h'] = img.width, img.height
    return raws


def _clearer(img):
    """The picture made easier to read for OCR (faint, dark or small print): grey, full contrast,
    sharper, and bigger when it is small; and how much bigger."""
    pic = ImageOps.autocontrast(ImageOps.grayscale(img), cutoff=1)
    scale = max(1.0, min(2.0, 2400 / pic.width, 9000 / max(pic.size)))
    if scale > 1:
        pic = pic.resize((round(pic.width * scale), round(pic.height * scale)), Image.LANCZOS)
    return pic.filter(ImageFilter.UnsharpMask(radius=2, percent=120, threshold=3)), scale


# A syllable of pinyin without its tone mark (ü written v), and a word of them: "laoshi", "xi'an".
PINYIN_SYLLABLE = (r'(?:[zcs]h|[bpmfdtnlgkhjqxrzcsyw])?'
                   r'(?:iang|iong|uang|ang|eng|ing|ong|uai|uan|iao|ian|ai|ei|ao|ou|an|en|er|in|un|ia|ie|iu|ua|uo|ui|ue'
                   r'|a|o|e|i|u|v)r?')
PINYIN_WORD = re.compile(f"(?:{PINYIN_SYLLABLE}'?)+")
# OCR misreads the vowels of pinyin with tone marks: ā as d after a consonant or in "idn" ("tidn"
# tiān, "gdO" gāo), í as f ("shfhou" shíhou), ì as 1, o as 0, á as 6 ("chu6ng" chuáng).
PINYIN_OCR = [(re.compile(r'(?<=[bcfghjklmpqstwxyz])d|(?<=i)d(?=n)'), 'a'), (re.compile(r'(?<=[a-z])f'), 'i'),
              (re.compile('1'), 'i'), (re.compile('0'), 'o'), (re.compile('6'), 'a')]


def _letters(t):
    """A word as plain lower-case letters, with the digits OCR puts in pinyin: "Wǒ" -> "wo"."""
    # OCR reads the i of pinyin with a tone mark as l, r, T …: "shl", "yrshéng", "IäoshT". (Pinyin
    # has these letters only before a vowel, or r after one.)
    t = re.sub(r'(?<=[b-df-hj-np-tv-zB-DF-HJ-NP-TV-Z])[lrT1|!](?![aeiouvAEIOUV]|[^\x00-\x7f])', 'i', t)
    t = ''.join(ch for ch in unicodedata.normalize('NFD', t) if not unicodedata.combining(ch)).lower()
    return re.sub(r"[^a-z0-9']", '', t)


def _pinyin_word(t):
    """Is t (from _letters) a word of pinyin: 'plain', 'misread' (only as OCR misreads pinyin:
    "tidn"), or '' (not)?"""
    if not 0 < len(t) <= 30:
        return ''
    plain = re.sub(r'\d', '', t)
    if plain and PINYIN_WORD.fullmatch(plain):
        return 'plain'
    for wrong, right in PINYIN_OCR:
        t = wrong.sub(right, t)
    return 'misread' if PINYIN_WORD.fullmatch(t) else ''


# English words that are no pinyin: two of them, and it is English ("after the measure word").
ENGLISH = set('the of to and is for with as by or at from that this it are was be in on not used use after before '
              'example meaning word words sentence sentences verb what should would will when where which who '
              'your they their there been have has had'.split())


def _pinyin_share(ln):
    """How many of the words in Latin letters of a line look like pinyin (0-1); whether it has the
    marks of pinyin read by OCR — tone marks (also misread: ä, å, ö) or digits in words ("w6men") —
    and whether it has words that are pinyin only as OCR misreads it ("tidn"), a weaker sign (English
    words look so too: "of" as "oi"). A line with Chinese characters is not pinyin, unless it is
    one character OCR saw in a longer line of pinyin ("Ni tidn 了 qi chuang"); nor one with English
    words in it."""
    kinds, marks, han, english = [], False, 0, 0
    for w in ln['words']:
        if CJK.search(w['t']):
            han += 1
            continue
        marks = marks or any(ch.isalpha() and not ch.isascii() for ch in w['t']) or bool(re.search(r'[a-zA-Z]\d|\d[a-zA-Z]', w['t']))
        english += re.sub(r'[^a-z]', '', w['t'].lower()) in ENGLISH
        t = _letters(w['t'])
        if re.search('[a-z]', t):
            kinds.append(_pinyin_word(t))
    if han > 1 or han and len(kinds) < 3 or not kinds or english >= 2:
        return 0, False, False
    return sum(map(bool, kinds)) / len(kinds), marks, 'misread' in kinds


def _line_box(ln):
    ws = ln['words']
    return (min(w['x'] for w in ws), min(w['y'] for w in ws),
            max(w['x'] + w['w'] for w in ws), max(w['y'] + w['h'] for w in ws))


def _over_chinese(ln, lines):
    """Is the line right above a line with Chinese characters, over the same place? (Pinyin is
    printed over its characters.)"""
    x0, y0, x1, y1 = _line_box(ln)
    h = max(1, y1 - y0)
    for other in lines:
        if other is ln or not any(CJK.search(w['t']) for w in other['words']):
            continue
        ox0, oy0, ox1, _ = _line_box(other)
        if y0 + h / 2 < oy0 < y1 + 1.6 * h and min(x1, ox1) - max(x0, ox0) >= 0.5 * (x1 - x0):
            return True
    return False


def _is_pinyin_line(ln, lines=(), strict=False):
    """A line of pinyin: Chinese written in Latin letters ("Wǒ jiā yǒu sì kǒu rén."), as OCR reads
    it ("Wö jiä yöu", "Td duö gdO?", "y6u shi jib zhGowd."): with signs of pinyin, and mostly pinyin
    (more than half right above Chinese characters; with its marks, half). Without them it could
    be English ("a man and a woman"). strict (a part of a line): its marks needed."""
    share, marks, misread = _pinyin_share(ln)
    if strict:
        return marks and (share >= 0.75 or share >= 0.5 and _over_chinese(ln, lines))
    return ((marks or misread) and (share >= 0.75 or share >= 0.6 and _over_chinese(ln, lines))
            or marks and share >= 0.5 and _over_chinese(ln, lines))


def _pinyin_runs(lines):
    """The words of pinyin in these lines, as (line, word) numbers: lines of pinyin, and pinyin
    between Chinese characters in a line — OCR joins a line of pinyin with what is beside it (a
    speaker's name, a box of new words: "@ 竞 shi, w6men shi ldi “Ity6u de. 竺三 New Words")."""
    found = set()
    for i, ln in enumerate(lines):
        if _is_pinyin_line(ln, lines):
            found.update((i, k) for k in range(len(ln['words'])))
            continue
        run = []
        for k, w in enumerate(ln['words'] + [{'t': '中'}]):  # (a Chinese character at the end: the last run ends)
            if not CJK.search(w['t']):
                run.append(k)
                continue
            if len(run) >= 2 and len(run) < len(ln['words']) and _is_pinyin_line({'words': [ln['words'][j] for j in run]}, lines, strict=True):
                found.update((i, j) for j in run)
            run = []
    return found


def drop_pinyin(doc):
    """A page made before (text/<n>.json, or its corrections): without its words of pinyin (as
    _doc leaves them out now). Its sentences, clauses and paragraphs stay as they were, without
    those words (the ones left empty go). Returns the page and whether it changed."""
    words = doc['words']
    if any(not isinstance(v, (int, float)) for w in words for v in w[:4]):
        return doc, False  # (words without their place on the page: left as they are)
    lines, numbers = {}, {}
    for k, w in enumerate(words):
        lines.setdefault(w[5], {'words': []})['words'].append({'t': w[4], 'x': w[0], 'y': w[1], 'w': w[2], 'h': w[3]})
        numbers.setdefault(w[5], []).append(k)
    order = list(lines)
    drop = {numbers[order[i]][j] for i, j in _pinyin_runs([lines[n] for n in order])}
    drop |= {k for k, w in enumerate(words) if _pinyin_in_text({'t': w[4]})}
    return _without(doc, drop)


def drop_speakers(doc):
    """A page of a Chinese book made before (text/<n>.json, or its corrections): without the
    names of the speakers of its dialogues and their pictures (_speakers, as _doc leaves them out
    now). Returns the page and whether it changed."""
    words = doc['words']
    if any(not isinstance(v, (int, float)) for w in words for v in w[:4]):
        return doc, False  # (words without their place on the page: left as they are)
    lines, numbers = {}, {}
    for k, w in enumerate(words):
        if w[2] > 0 or w[3] > 0:  # (typed in, without a place: not a name under a picture)
            lines.setdefault(w[5], {'words': []})['words'].append({'t': w[4], 'x': w[0], 'y': w[1], 'w': w[2], 'h': w[3]})
            numbers.setdefault(w[5], []).append(k)
    order = list(lines)
    return _without(doc, {numbers[order[i]][j] for i, j in _speakers([lines[n] for n in order])})


def restore_stops(doc, img):
    """A page of a Chinese book made before (text/<n>.json, or its corrections), with the full stops
    OCR did not read put back (missed_stops: found on its picture, img), on the words before them.
    Returns the page, whether it changed, and the words (their numbers) a stop was put after."""
    words = doc['words']
    if img is None or any(not isinstance(v, (int, float)) for w in words for v in w[:4]):
        return doc, False, set()
    gray = img.convert('L')
    lines = {}
    for k, w in enumerate(words):
        if w[2] > 0 or w[3] > 0:
            lines.setdefault(w[5], []).append({'t': w[4], 'x': w[0], 'y': w[1], 'w': w[2], 'h': w[3], 'k': k})
    stops, drop = set(), set()
    for line in lines.values():
        if not CJK.search(''.join(w['t'] for w in line)):
            continue
        out = missed_stops(gray, sorted(line, key=lambda w: w['x']))
        kept = {w['k'] for w in out}
        drop |= {w['k'] for w in line if w['k'] not in kept}  # (OCR's "0" for a stop: on the word before it now)
        stops |= {w['k'] for w in out if w['t'] != words[w['k']][4]}
    if not stops:
        return doc, False, set()
    doc = {**doc, 'words': [[*w[:4], w[4] + '。', *w[5:]] if k in stops else w for k, w in enumerate(words)]}
    doc, _ = _without(doc, drop)
    return doc, True, {k - sum(1 for d in drop if d < k) for k in stops}


def _without(doc, drop):
    """The page without these words (their numbers): its sentences, clauses and paragraphs stay as
    they were, without them (the ones left empty go). Returns the page and whether it changed."""
    words = doc['words']
    if not drop:
        return doc, False
    before = [0]  # how many words are kept before each word
    for k in range(len(words)):
        before.append(before[-1] + (k not in drop))
    sents, sent_of = [], {}
    for s, (a, b) in enumerate(doc['sent']):
        if before[b] > before[a]:
            sent_of[s] = len(sents)
            sents.append([before[a], before[b]])
    blocks = []
    for sa, sb in doc['blocks']:
        kept = [sent_of[s] for s in range(sa, sb) if s in sent_of]
        if kept:
            blocks.append([kept[0], kept[-1] + 1])
    return {**doc, 'words': [w for k, w in enumerate(words) if k not in drop], 'sent': sents, 'blocks': blocks,
            'clause': [[before[a], before[b]] for a, b in doc.get('clause', []) if before[b] > before[a]]}, True


def _speakers(lines):
    """What names the speakers of a dialogue in a Chinese book, not to be read with it: (line,
    word) numbers. Their names under their pictures: a line of 1 to 4 small characters ("刘明",
    much smaller than the page's, also when the line is flat as "一"); and their pictures as OCR
    reads them ("(O", "(0)", "@": round, bigger than the text)."""
    sizes = sorted(w['h'] for ln in lines for w in ln['words'] if CJK.search(w['t']))
    if len(sizes) < 10:
        return set()
    u = sizes[len(sizes) // 2]  # (the page's characters)
    found, names = set(), []
    for i, ln in enumerate(lines):
        ws = ln['words']
        # The line's groups of words, apart from each other (another column on the same line: "杨同乐 … /").
        groups = []
        for k in sorted(range(len(ws)), key=lambda k: ws[k]['x']):
            if not groups or ws[k]['x'] - max(ws[j]['x'] + ws[j]['w'] for j in groups[-1]) > 1.5 * u:
                groups.append([])
            groups[-1].append(k)
        for g in groups:
            gw = [ws[k] for k in g]
            chars = sum(len(CJK.findall(w['t'])) for w in gw)
            if 1 <= chars <= 4 and all(CJK.fullmatch(w['t']) for w in gw) and max(max(w['w'], w['h']) for w in gw) < 0.62 * u:
                found.update((i, k) for k in g)
                if chars >= 2:  # (a name)
                    names.append((min(w['x'] for w in gw), min(w['y'] for w in gw), max(w['x'] + w['w'] for w in gw)))
        found.update((i, k) for k, w in enumerate(ws)
                     if FACE.fullmatch(w['t']) and w['h'] > 1.25 * u and 0.7 < w['w'] / max(1, w['h']) < 1.4)
    # The picture right above a name, read as characters or signs ("像 )" over "杨同乐"; not English
    # words: text beside it): about as wide, a little higher.
    for x0, y0, x1 in names:
        nw = x1 - x0
        for i, ln in enumerate(lines):
            found.update((i, k) for k, w in enumerate(ln['words'])
                         if x0 - 0.6 * nw <= w['x'] + w['w'] / 2 <= x1 + 0.9 * nw and y0 - 1.3 * u <= w['y'] + w['h'] / 2 < y0
                         and not re.search('[A-Za-z]{2}', w['t']))
    return found


# A picture of a speaker's face, as OCR reads it: "(O", "(0)", "@".
FACE = re.compile(r'[(（]?[O0o@©®]{1,2}[)）]?')


def _pinyin_in_text(w):
    """A word of pinyin with a tone mark among other words: "药 yào n. medicine", "Look at Mǎdīng"."""
    t = w['t']
    return not CJK.search(t) and any(ch.isalpha() and not ch.isascii() for ch in t) and bool(_pinyin_word(_letters(t)))


def _in_margin(ln, h):
    """A short line at the very top or bottom of the page: a running head, a footer, a page number
    with words ("Unit 3 · 24"; a number alone is left out anyway)."""
    top = min(w['y'] for w in ln['words'])
    bottom = max(w['y'] + w['h'] for w in ln['words'])
    text = ''.join(w['t'] for w in ln['words'])
    return (bottom < 0.07 * h or top > 0.93 * h) and len(text) <= 60 and any(ch.isalpha() for ch in text)


def _doc(raw, options, img=None, stops=False, kind='text', rows=False):
    """A page's text document from its words (raw: from the PDF or OCR), as the owner chose; and
    what was found on it: {'pinyin': lines of pinyin, 'margins': lines in its margins, 'lists':
    the boxes of its lists of new words}. img: the page picture, for the bullets of lists that OCR
    did not read. A list of new words: each row its word, then its meaning (its pinyin and part of
    speech left out with the pinyin). A Chinese book's dialogues: without the names of their
    speakers and their pictures (not to be read). kind: what the owner said is in it (an area of
    a design, designs.py): a 'dialogue' (also without the names at the start of its lines, "A:"),
    a list of new words ('words': its rows found also when its columns are not), or 'text'. rows:
    OCR's pieces of one line put together first (segment_text.join_rows: an area read again)."""
    lines = [ln for ln in raw['lines'] if ln['words']]
    if kind == 'dialogue':
        lines = designs.without_speakers(lines)
    if options['language'].startswith('zh-'):
        quiet = _speakers(lines)
        lines = [{**ln, 'words': [w for k, w in enumerate(ln['words']) if (i, k) not in quiet]} for i, ln in enumerate(lines)]
        lines = [ln for ln in lines if ln['words']]
    lists, lines = word_lists(lines, keep_reading=not options['dropPinyin'])
    if kind == 'words' and not lists and lines:
        lists, lines = _list_rows(lines, keep_reading=not options['dropPinyin']), []
    runs = _pinyin_runs(lines) if options['language'].startswith('zh-') else set()
    pinyin = {i for i, _ in runs}  # (the lines with pinyin)
    if options['dropPinyin']:  # also the words of pinyin among other words ("药 yào n. medicine")
        lines = [{**ln, 'words': [w for k, w in enumerate(ln['words']) if (i, k) not in runs and not _pinyin_in_text(w)]}
                 for i, ln in enumerate(lines)]
        lines = [ln for ln in lines if ln['words']]
    margins = {id(ln) for ln in lines if _in_margin(ln, raw['h'])}
    if options['margins']:
        lines = [ln for ln in lines if id(ln) not in margins]
    fixes = _parse_fixes(options['fixes'])

    def fixed(ln):
        words = []
        for w in ln['words']:
            t = w['t']
            for wrong, right in fixes:
                t = t.replace(wrong, right)
            if t.strip():
                words.append({**w, 't': t})
        return {**ln, 'words': words}
    if fixes:
        lines = [fixed(ln) for ln in lines]
        for found in lists:
            found['entries'] = [[fixed(ln) for ln in entry] for entry in found['entries']]
    return (segment({**raw, 'lines': lines}, ocr=False, image=img, lists=lists, stops=stops, rows=rows),
            {'pinyin': len(pinyin), 'margins': len(margins), 'lists': [list(found['box']) for found in lists]})


def _list_rows(lines, keep_reading=True):
    """The rows of a list of new words in an area the owner marked as one, when word_lists did not
    find its columns: a line with a word in another writing than the Latin one ("旅游") starts a
    row, the lines under it without one go on with its meaning. A row: its word (and its reading,
    "lǚyóu", if kept), then its meaning, without the row's number and its part of speech (kept
    with the reading). In word_lists' form: [{'box', 'entries'}]."""
    rows = []
    for ln in sorted(lines, key=lambda ln: min(w['y'] for w in ln['words'])):
        ws = sorted(ln['words'], key=lambda w: w['x'])
        if not rows or any(_other_writing(w['t']) for w in ws):
            rows.append({'word': [], 'reading': [], 'pos': [], 'meaning': [], 'all': []})
        r = rows[-1]
        r['all'] += ws
        for w in ws:
            t = w['t']
            if re.fullmatch(r'[(（]?\d{1,3}[.)）、．]?|[①-⑳]', t):
                continue
            if _other_writing(t):
                r['word'].append(w)
            elif PART_OF_SPEECH.fullmatch(t):
                r['pos'].append(w)
            elif not r['meaning'] and not r['pos'] and t.lower() not in ENGLISH and (PINYIN_MARK.search(t) or _pinyin_word(_letters(t)) == 'plain'):
                r['reading'].append(w)
            else:
                r['meaning'].append(w)
    entries = []
    for r in rows:
        first = r['word'] + (r['reading'] if keep_reading else [])
        meaning = (r['pos'] if keep_reading else []) + r['meaning']
        entry = ([{'words': first, 'own': True}] if first else []) + ([{'words': meaning}] if meaning else [])
        if entry:
            entries.append(entry)
    ws = [w for r in rows for w in r['all']]
    if not entries:
        return []
    return [{'box': (min(w['x'] for w in ws), min(w['y'] for w in ws), max(w['x'] + w['w'] for w in ws),
                     max(w['y'] + w['h'] for w in ws)), 'entries': entries}]


def _doc_in_areas(raw, options, img, stops, areas):
    """A page's text document read area by area (the areas of its design, designs.py), in their
    order; and what was found on it (as _doc)."""
    docs, info = [], {'pinyin': 0, 'margins': 0, 'lists': []}
    for area, part in designs.parts(raw, areas):
        doc, found = _doc(part, options, img, stops, area['kind'])
        docs.append(doc)
        info = {k: info[k] + found[k] for k in info}
    return designs.join(docs), info


# ---------------------------------------------------------------- Text of a page, search

def text_doc(bid, n, original=False):
    """The page's words: the owner's corrections if there are, else as made (original: as made,
    whatever was corrected). None if none."""
    for sub in ('text',) if original else ('edits', 'text'):
        p = folder(bid, sub, f'{n}.json')
        if os.path.isfile(p):
            with open(p, encoding='utf-8') as f:
                doc = json.load(f)
            if sub == 'edits':
                doc['edited'] = True
            return doc
    return None


def _page_picture(bid, n):
    """The picture of page n of a book of the library (PIL), or None."""
    try:
        with Image.open(folder(bid, 'pages', f'{n}.webp')) as img:
            return img.convert('RGB')
    except (OSError, ValueError):
        return None


def resegment_books():
    """Books made before sentences were cut as now (segment_text.SENTENCE_RULES: Chinese and
    English a sentence each; Chinese books without the pinyin OCR misread): the sentences of their
    pages made again from their words, once (sentences.json in the book's folder says so). The
    owner's corrections are only cut where the language changes, before choices and at the full
    stops put back (and lose their pinyin, and the names of the speakers of dialogues): their
    sentences stay as the owner made them. Returns how many pages changed."""
    changed = 0
    for b in db.rows("SELECT id, lang, import_options FROM books WHERE status = 'ready'"):
        chinese = str(b['lang']).startswith('zh-')
        pinyin = chinese and _options(b)['dropPinyin']  # (the pinyin to leave out)
        mark = folder(b['id'], 'sentences.json')
        try:
            with open(mark, encoding='utf-8') as f:
                if json.load(f).get('rules', 0) >= SENTENCE_RULES:
                    continue
        except (OSError, ValueError, AttributeError):
            pass
        for sub, remake in (('text', resegment), ('edits', split_languages)):
            where = folder(b['id'], sub)
            for name in sorted(os.listdir(where)) if os.path.isdir(where) else []:
                if not name.endswith('.json'):
                    continue
                path = os.path.join(where, name)
                try:
                    with open(path, encoding='utf-8') as f:
                        doc, gone = drop_pinyin(json.load(f)) if pinyin else (json.load(f), False)
                    doc, quiet = drop_speakers(doc) if chinese else (doc, False)
                    # (the owner's corrections: text read again with OCR; the pages as made have the PDF's stops)
                    doc, stopped, ends = (restore_stops(doc, _page_picture(b['id'], name[:-5])) if chinese and sub == 'edits'
                                          else (doc, False, set()))
                    doc, new = remake(doc)
                    if ends and sub == 'edits':  # (the owner's sentences: cut only at the stops put back)
                        doc, _ = cut_after(doc, ends)
                    new = new or gone or quiet or stopped
                except (OSError, ValueError, KeyError, IndexError, TypeError):
                    continue  # (a page this does not understand stays as it is)
                if new:
                    with open(path + '.tmp', 'w', encoding='utf-8') as f:
                        json.dump(doc, f, ensure_ascii=False, separators=(',', ':'))
                    os.replace(path + '.tmp', path)
                    changed += 1
        with open(mark, 'w', encoding='utf-8') as f:
            json.dump({'rules': SENTENCE_RULES}, f)
    return changed


def save_edit(bid, n, doc):
    os.makedirs(folder(bid, 'edits'), exist_ok=True)
    tmp = folder(bid, 'edits', f'{n}.json.tmp')
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, folder(bid, 'edits', f'{n}.json'))


def remove_edit(bid, n):
    p = folder(bid, 'edits', f'{n}.json')
    if os.path.isfile(p):
        os.remove(p)


def search_index(b):
    out = []
    for p in _pages(b):
        doc = text_doc(b['id'], p['n'])
        if doc:
            out.append({'p': p['n'], 't': page_text(doc)})
    return out


def file_path(bid, kind, name):
    """A page image or small image of a book, or None."""
    if kind not in ('pages', 'thumbs') or not re.fullmatch(r'\d{1,4}\.webp', name):
        return None
    p = folder(bid, kind, name)
    return p if os.path.isfile(p) else None


def pdf_file(b):
    """The book's PDF (with the pictures its owner replaced), or None (not a PDF)."""
    p = folder(b['id'], 'source', 'book.pdf')
    return p if b['kind'] == 'pdf' and os.path.isfile(p) else None


# ---------------------------------------------------------------- Replacing a picture on a page (pictures.py)

def _pictures(bid):
    try:
        with open(folder(bid, 'pictures.json'), encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return []


def _save_pictures(bid, items):
    tmp = folder(bid, 'pictures.json.tmp')
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(items, f)
    os.replace(tmp, folder(bid, 'pictures.json'))


def pictures_of(b, n=None):
    """The pictures replaced in a book (on page n): [{'id', 'n', 'box': [x, y, w, h], 'fit', 'at'}]."""
    return [r for r in _pictures(b['id']) if n is None or str(r['n']) == str(n)]


def _drop_words_in(bid, n, box):
    """The words in box (their middle) taken out of page n's text (as made, and as corrected): the
    words of the old picture. How many there were (in the text the reader shows)."""
    x, y, w, h = box
    shown = 0
    for sub in ('text', 'edits'):
        path = folder(bid, sub, f'{n}.json')
        if not os.path.isfile(path):
            continue
        with open(path, encoding='utf-8') as f:
            doc = json.load(f)
        drop = {k for k, v in enumerate(doc['words']) if v[2] > 0 and x <= v[0] + v[2] / 2 <= x + w and y <= v[1] + v[3] / 2 <= y + h}
        doc, changed = _without(doc, drop)
        if changed:
            tmp = path + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(doc, f, ensure_ascii=False, separators=(',', ':'))
            os.replace(tmp, path)
        shown = len(drop)  # (the corrections, if any: they are what the reader shows)
    return shown


def _apply_pictures(b, items, pages):
    """The page pictures of these pages, and the PDF, made again from the originals with the
    replacements (items) in them; without any, back to the originals."""
    bid = b['id']
    pic = lambda r: Image.open(folder(bid, 'pictures', f"{r['id']}.jpg"))  # noqa: E731
    for n in pages:
        original = folder(bid, 'pictures', f'page-{n}.webp')
        if not os.path.isfile(original):
            continue
        mine = [r for r in items if str(r['n']) == str(n)]
        with Image.open(original) as im:
            img = pictures.page_with(im, mine, pic)
        img.save(folder(bid, 'pages', f'{n}.webp'), 'WEBP', quality=80, method=4)
        th = img.copy()
        th.thumbnail((240, 2000))
        th.save(folder(bid, 'thumbs', f'{n}.webp'), 'WEBP', quality=75)
        if not mine:
            os.remove(original)
    if b['kind'] != 'pdf':
        return
    book, original = folder(bid, 'source', 'book.pdf'), folder(bid, 'source', 'book.original.pdf')
    if not items:
        if os.path.isfile(original):
            os.replace(original, book)
        return
    if not os.path.isfile(original):
        shutil.copyfile(book, original)
    chosen, _ = _selection(b, _options(b))
    sizes = {str(p['n']): (p['w'], p['h']) for p in _pages(b)}
    changes = []
    for r in items:  # (each new picture made to its box's shape, sharp enough: twice the page's pixels)
        x, y, w, h = r['box']
        k = min(2.0, pictures.MOST_PX / max(w, h))
        fit = folder(bid, 'pictures', f"{r['id']}-fit.jpg")
        with pic(r) as im:
            pictures.fitted(im.convert('RGB'), w * k, h * k, r['fit']).save(fit, 'JPEG', quality=88)
        changes.append((chosen[int(r['n']) - 1], (x, y, w, h), *sizes[str(r['n'])], fit))
    tmp = folder(bid, 'source', 'book.pdf.tmp')
    pictures.pdf_with(original, tmp, changes)
    os.replace(tmp, book)


def replace_picture(b, n, box, data, fit='cover'):
    """Page n's picture in box (x, y, w, h: the page picture's pixels) replaced by this one (data:
    its bytes), on the page and in the PDF; the words of the old picture taken out of the page's
    text. Returns {'picture': the replacement, 'words': how many words were taken out}."""
    if b['status'] != 'ready':
        raise LibraryError('The pages of this book are not made yet.')
    page = next((p for p in _pages(b) if str(p['n']) == str(n)), None)
    if not page:
        raise LibraryError('There is no such page.')
    try:
        x, y, w, h = (float(v) for v in box)
    except (TypeError, ValueError):
        raise LibraryError('Draw a box around the picture.')
    x, y = max(0.0, x), max(0.0, y)
    w, h = min(w, page['w'] - x), min(h, page['h'] - y)
    if w < 12 or h < 8:
        raise LibraryError('Draw a bigger box around the picture.')
    if fit not in pictures.FITS:
        raise LibraryError('Choose how the picture fills the box.')
    try:
        jpeg = pictures.normalized(data)
    except pictures.PictureError as e:
        raise LibraryError(str(e))
    bid = b['id']
    os.makedirs(folder(bid, 'pictures'), exist_ok=True)
    item = {'id': 'p' + secrets.token_hex(5), 'n': str(n), 'box': [round(x), round(y), round(w), round(h)], 'fit': fit, 'at': int(time.time())}
    with open(folder(bid, 'pictures', f"{item['id']}.jpg"), 'wb') as f:
        f.write(jpeg)
    original = folder(bid, 'pictures', f'page-{n}.webp')
    if not os.path.isfile(original):  # (the page as it was: kept once, to take the pictures back)
        shutil.copyfile(folder(bid, 'pages', f'{n}.webp'), original)
    items = _pictures(bid) + [item]
    try:
        _apply_pictures(b, items, [str(n)])
    except Exception as e:
        os.remove(folder(bid, 'pictures', f"{item['id']}.jpg"))
        _apply_pictures(b, items[:-1], [str(n)])
        if isinstance(e, pictures.PictureError):
            raise LibraryError(str(e))
        raise
    _save_pictures(bid, items)
    words = _drop_words_in(bid, n, item['box'])
    _new_addresses(bid)
    return {'picture': item, 'words': words}


def _new_addresses(bid):
    """New addresses for a book's page pictures (?v=…: a browser keeps them a year): later than
    the last, also within the same second (a picture replaced and taken back at once)."""
    db.run('UPDATE books SET updated = MAX(updated + 1, ?) WHERE id = ?', (int(time.time()), bid))


def restore_picture(b, pid):
    """A replaced picture taken back: the page and the PDF as they were there (its words are not
    read back: Re-read text by area reads them)."""
    items = _pictures(b['id'])
    item = next((r for r in items if r['id'] == pid), None)
    if not item:
        raise LibraryError('There is no such picture.')
    items = [r for r in items if r is not item]
    _apply_pictures(b, items, [str(item['n'])])
    _save_pictures(b['id'], items)
    for name in (f'{pid}.jpg', f'{pid}-fit.jpg'):
        if os.path.isfile(folder(b['id'], 'pictures', name)):
            os.remove(folder(b['id'], 'pictures', name))
    _new_addresses(b['id'])
    return {'n': item['n']}


# ---------------------------------------------------------------- Audio and video of a book (tracks.py)

def _media_address(bid, file):
    return f'/lib/{bid}/migration-media/{file}'


def _book_bytes(bid):
    """The book's size counted again (its owner's room: LIMITS['user_mb'])."""
    size = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(folder(bid)) for f in fs)
    db.run('UPDATE books SET bytes = ? WHERE id = ?', (size, bid))


def tracks_info(b):
    """The recordings added to a book: {'files', 'placed' (with a button on a page), 'unplaced':
    [their names], 'bytes', 'items': [{file, name, title, kind, placed}] (to choose one: a button put
    by hand)}."""
    items = tracks.load(folder(b['id']))
    return {'files': len(items), 'placed': sum(1 for it in items if it.get('placed')),
            'unplaced': sorted(it['name'] for it in items if not it.get('placed')), 'bytes': sum(it['size'] for it in items),
            'items': [{'file': it['file'], 'name': it['name'], 'title': tracks.title(it), 'kind': it['kind'],
                       'placed': bool(it.get('placed'))} for it in items]}


def track_files(b):
    """The recordings added to a book: [(their address, their file)] (to transcribe them)."""
    bid = b['id']
    return [(_media_address(bid, it['file']), folder(bid, 'migration-media', it['file'])) for it in tracks.load(folder(bid))]


def add_track(b, user, name, data):
    """One recording (audio or video) added to a book; its button goes on its page when the
    recordings are placed (place_tracks)."""
    if b['status'] != 'ready':
        raise LibraryError('The pages of this book are not made yet.')
    name = os.path.basename(str(name or '').replace('\\', '/'))[:200]
    if os.path.splitext(name)[1].lower() not in tracks.KINDS:
        raise LibraryError('Only audio and video can be added: MP3, M4A, WAV, OGG, MP4, WebM.')
    most = limits(user)['pdf_mb']
    if len(data) > most * 2 ** 20:
        raise LibraryError(f'“{name}” is too big (at most {most} MB).')
    if not user['admin'] and _used_bytes(b['owner']) + len(data) > LIMITS['user_mb'] * 2 ** 20:
        raise LibraryError(f"Your library is full ({LIMITS['user_mb']} MB). Delete a book first.")
    file, kind = tracks.stored(folder(b['id']), name, data)
    t = tracks.track_of(name)
    items = tracks.load(folder(b['id']))
    was = next((it for it in items if it['name'] == name), {})  # (added again: its buttons changed by hand stay so)
    items = [it for it in items if it['name'] != name]
    items.append({'name': name, 'file': file, 'kind': kind, 'track': list(t) if t else None, 'size': len(data),
                  **({'skip': was['skip']} if was.get('skip') else {}), **({'placed': True} if was.get('placed') else {})})
    tracks.save(folder(b['id']), items)
    return {'file': file, 'track': t}


def _assets(bid):
    try:
        with open(folder(bid, 'migration-assets.json'), encoding='utf-8') as f:
            d = json.load(f)
        return d if isinstance(d, dict) and isinstance(d.get('pages'), dict) else {'version': 1, 'pages': {}}
    except (OSError, ValueError):
        return {'version': 1, 'pages': {}}


def _save_assets(bid, d, buttons=None, drop=('added',)):
    """The page buttons: those added before (ours: 'added'; with drop also 'manual': put by hand)
    replaced by these ({page: [button]})."""
    pages = {n: [a for a in spots if not any(a.get(k) for k in drop)] for n, spots in d['pages'].items()}
    for n, spots in (buttons or {}).items():
        pages.setdefault(str(n), []).extend(spots)
    d = {**d, 'pages': {n: spots for n, spots in pages.items() if spots}}
    tmp = folder(bid, 'migration-assets.json.tmp')
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(tmp, folder(bid, 'migration-assets.json'))


def place_tracks(b):
    """A play button for each recording on every page where its number is printed; as the pages'
    text is now (also corrected). Returns tracks_info."""
    bid = b['id']
    items = tracks.load(folder(bid))
    docs = {str(p['n']): d for p in _pages(b) if (d := text_doc(bid, p['n']))}
    buttons, unplaced = tracks.buttons(items, docs, lambda f: _media_address(bid, f))
    _save_assets(bid, _assets(bid), buttons)
    by_hand = {a.get('src') for spots in _assets(bid)['pages'].values() for a in spots if a.get('manual')}
    left = {it['file'] for it in unplaced if _media_address(bid, it['file']) not in by_hand}
    for it in items:
        it['placed'] = it['file'] not in left
    tracks.save(folder(bid), items)
    _book_bytes(bid)
    return tracks_info(get(bid))


def remove_tracks(b):
    """The recordings added to a book taken out, with their buttons (those of an old app imported stay)."""
    bid = b['id']
    items = tracks.load(folder(bid))
    assets = _assets(bid)
    _save_assets(bid, assets, drop=('added', 'manual'))
    still = {a.get('src') for spots in _assets(bid)['pages'].values() for a in spots}
    for it in items:
        path = folder(bid, 'migration-media', it['file'])
        if _media_address(bid, it['file']) not in still and os.path.isfile(path):
            os.remove(path)
    if os.path.isfile(folder(bid, 'tracks.json')):
        os.remove(folder(bid, 'tracks.json'))
    _book_bytes(bid)
    return tracks_info(get(bid))


def _button_page(b, n):
    """Page n of a book (its number as a string), or LibraryError."""
    page = next((p for p in _pages(b) if str(p['n']) == str(n)), None)
    if not page:
        raise LibraryError('There is no such page.')
    return page


def _at(page, x, y):
    """A place on a page (its pixels), kept on the page."""
    try:
        x, y = float(x), float(y)
    except (TypeError, ValueError):
        raise LibraryError('Click on the page where the button goes.')
    return min(max(x, 0), page['w']), min(max(y, 0), page['h'])


def _find_button(spots, src, x, y):
    """The play button of that recording nearest to (x, y) on a page, or LibraryError."""
    try:
        x, y = float(x), float(y)
    except (TypeError, ValueError):
        x = y = 0
    found = [a for a in spots if a.get('src') == src and a.get('t') in ('audio', 'video')]
    if not found:
        raise LibraryError('That play button is not on the page any more. Open the page again.')
    return min(found, key=lambda a: (a['x'] - x) ** 2 + (a['y'] - y) ** 2)


def _by_hand(bid, n, a):
    """A button of ours changed by hand on page n: its recording's button is not put there again
    (when the buttons are placed again)."""
    items = tracks.load(folder(bid))
    for it in items:
        if _media_address(bid, it['file']) == a.get('src'):
            it['skip'] = sorted(set(it.get('skip') or []) | {str(n)}, key=lambda v: int(v) if v.isdigit() else 0)
    tracks.save(folder(bid), items)


def add_button(b, n, file, x, y):
    """A play button put by hand on page n, where the owner clicked, for one of the book's
    recordings (file): the page's buttons."""
    page = _button_page(b, n)
    bid = b['id']
    items = tracks.load(folder(bid))
    it = next((it for it in items if it['file'] == file), None)
    if not it:
        raise LibraryError('Choose one of the recordings of this book (add it first, in Settings → Audio and video).')
    x, y = _at(page, x, y)
    d = _assets(bid)
    d['pages'].setdefault(str(page['n']), []).append(tracks.button(it, x, y, lambda f: _media_address(bid, f)))
    _save_assets(bid, d, drop=())
    it['placed'] = True
    tracks.save(folder(bid), items)
    return _assets(bid)['pages'].get(str(page['n']), [])


def move_button(b, n, src, old, x, y):
    """A play button moved by hand on page n (from old: [x, y], where it was): the page's buttons."""
    page = _button_page(b, n)
    bid = b['id']
    d = _assets(bid)
    spots = d['pages'].get(str(page['n']), [])
    a = _find_button(spots, src, *(list(old or []) + [0, 0])[:2])
    a['x'], a['y'] = (round(v) for v in _at(page, x, y))
    if a.pop('added', None):  # (one of ours: now as put by hand)
        a['manual'] = True
        _by_hand(bid, page['n'], a)
    _save_assets(bid, d, drop=())
    return _assets(bid)['pages'].get(str(page['n']), [])


def remove_button(b, n, src, x, y):
    """A play button taken away by hand from page n (put in a wrong place): the page's buttons. The
    recording stays in the book; its button is not put on this page again."""
    page = _button_page(b, n)
    bid = b['id']
    d = _assets(bid)
    spots = d['pages'].get(str(page['n']), [])
    a = _find_button(spots, src, x, y)
    spots.remove(a)
    if a.get('added') or a.get('manual'):
        _by_hand(bid, page['n'], a)
    _save_assets(bid, d, drop=())
    items = tracks.load(folder(bid))  # (on no page any more: told as not placed)
    still = {a.get('src') for spots in _assets(bid)['pages'].values() for a in spots}
    for it in items:
        if it.get('placed') and _media_address(bid, it['file']) not in still:
            it['placed'] = False
    tracks.save(folder(bid), items)
    return _assets(bid)['pages'].get(str(page['n']), [])


def old_picture(b, n, box):
    """The part of page n's picture in box, as JPEG bytes (for the AI image service to start from)."""
    page = folder(b['id'], 'pages', f'{n}.webp')
    if not os.path.isfile(page):
        raise LibraryError('There is no such page.')
    x, y, w, h = (float(v) for v in box)
    with Image.open(page) as im:
        part = im.convert('RGB').crop((round(x), round(y), round(x + w), round(y + h)))
    out = io.BytesIO()
    part.save(out, 'JPEG', quality=90)
    return out.getvalue()


# ---------------------------------------------------------------- Reports (public books)

REPORT_REASONS = {'copyright': 'Copyright: shared without permission', 'inappropriate': 'Inappropriate content', 'other': 'Something else'}
AUTO_HIDE = 3  # reports from different people: hidden until an admin looks at it


def report(b, user, address, reason, note):
    if reason not in REPORT_REASONS:
        raise LibraryError('Choose a reason.')
    who = user['id'] if user else None
    if db.one('SELECT 1 FROM reports WHERE book = ? AND done = 0 AND (user = ? OR (user IS NULL AND ip = ?))', (b['id'], who, address)):
        return  # reported already
    db.run('INSERT INTO reports (book, user, ip, reason, note, created) VALUES (?, ?, ?, ?, ?, ?)',
           (b['id'], who, address, reason, str(note or '')[:1000], int(time.time())))
    n = db.one('SELECT COUNT(DISTINCT COALESCE(user, ip)) AS n FROM reports WHERE book = ? AND done = 0', (b['id'],))['n']
    if n >= AUTO_HIDE:
        db.run('UPDATE books SET hidden = 1 WHERE id = ?', (b['id'],))


def open_reports():
    rows = db.rows('SELECT r.*, b.title, b.owner, b.hidden, u.name AS owner_name, u.email AS owner_email '
                   'FROM reports r JOIN books b ON b.id = r.book LEFT JOIN users u ON u.id = b.owner '
                   'WHERE r.done = 0 ORDER BY r.created DESC LIMIT 500')
    for r in rows:
        r['reasonName'] = REPORT_REASONS.get(r['reason'], r['reason'])
    return rows


def moderate(bid, action):
    """Admin: 'hide', 'show' (and close its reports), 'delete', or 'dismiss' (close the reports)."""
    b = get(bid)
    if not b:
        raise LibraryError('No such book.')
    if action == 'hide':
        db.run('UPDATE books SET hidden = 1 WHERE id = ?', (bid,))
    elif action == 'show':
        db.run('UPDATE books SET hidden = 0 WHERE id = ?', (bid,))
        db.run('UPDATE reports SET done = 1 WHERE book = ?', (bid,))
    elif action == 'dismiss':
        db.run('UPDATE reports SET done = 1 WHERE book = ?', (bid,))
    elif action == 'delete':
        delete(b)
    else:
        raise LibraryError('Unknown action.')

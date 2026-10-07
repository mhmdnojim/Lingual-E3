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
          a page without text (a scan) is read with OCR;
- photos: each photo is turned upright, made smaller if very big, and read with OCR (ocr.py).
"""
import json
import os
import queue
import re
import secrets
import shutil
import sys
import threading
import time

from PIL import Image, ImageDraw, ImageFont, ImageOps

import db
import ids
import ocr

WEB = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(WEB, 'tools'))
from segment_text import doc_from_blocks, page_text, segment  # noqa: E402

BOOKS = os.path.join(db.DATA, 'books')
FONTS = os.path.join(WEB, 'fonts')
KINDS = ('text', 'pdf', 'images')
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
    return {
        'id': b['id'], 'title': b['title'], 'author': b['author'], 'about': b['about'], 'kind': b['kind'],
        'visibility': b['visibility'], 'license': b['license'], 'licenseName': LICENSES.get(b['license'], ''),
        'source': b['source'], 'hidden': bool(b['hidden']), 'status': b['status'], 'error': b['error'],
        'pageCount': len(pages), 'owner': owner['name'] if owner else '', 'mine': bool(user and b['owner'] == user['id']),
        'canEdit': can_edit(b, user), 'created': b['created'], 'updated': b['updated'],
        'cover': f"/lib/{b['id']}/thumbs/1.webp?v={v}" if pages else None, 'job': job(b['id']),
    }


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
    return out


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
    if q:
        rows = [r for r in rows if q.strip('%') in (r['title'] + ' ' + r['author'] + ' ' + r['about']).lower()]
    return [summary(r, user) for r in rows]


# ---------------------------------------------------------------- Adding, changing, removing

def _clean_meta(meta, b=None):
    out = {}
    for k, n in (('title', 120), ('author', 120), ('about', 600), ('source', 300)):
        if k in meta:
            out[k] = ' '.join(str(meta[k] or '').split())[:n]
    if 'title' in out and not out['title']:
        raise LibraryError('Please give a title.')
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
    db.run('INSERT INTO books (id, owner, title, author, about, kind, license, source, created, updated) '
           'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
           (bid, user['id'], clean['title'], clean.get('author', ''), clean.get('about', ''), kind,
            clean.get('license', ''), clean.get('source', ''), now, now))
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
        if len(data) > LIMITS['pdf_mb'] * 2 ** 20:
            raise LibraryError(f"The PDF is too big (at most {LIMITS['pdf_mb']} MB).")
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
_jobs = {}
_jobs_lock = threading.Lock()
_worker = None


def job(bid):
    with _jobs_lock:
        j = _jobs.get(bid)
        return dict(j) if j else None


def _set_job(bid, **kw):
    with _jobs_lock:
        _jobs.setdefault(bid, {}).update(kw)


def start(b):
    """Make (or make again) the pages of a book, in the background."""
    global _worker
    src = folder(b['id'], 'source')
    files = os.listdir(src) if os.path.isdir(src) else []
    if b['kind'] == 'pdf' and 'book.pdf' not in files:
        raise LibraryError('Upload the PDF first.')
    if b['kind'] == 'text' and 'text.json' not in files:
        raise LibraryError('Add the text first.')
    if b['kind'] == 'images' and not any(f.startswith('image-') for f in files):
        raise LibraryError('Upload the photos first.')
    db.run("UPDATE books SET status = 'working', error = '', updated = ? WHERE id = ?", (int(time.time()), b['id']))
    _set_job(b['id'], state='waiting', done=0, total=0, stage='Waiting…')
    _queue.put(b['id'])
    with _jobs_lock:
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_work, daemon=True)
            _worker.start()


def _work():
    while True:
        bid = _queue.get()
        try:
            _make(bid)
        except Exception as e:  # tell the owner instead of failing silently
            msg = str(e) if isinstance(e, (LibraryError, ocr.OcrError)) else f'Something went wrong ({e.__class__.__name__}: {e}).'
            db.run("UPDATE books SET status = 'error', error = ?, updated = ? WHERE id = ?", (msg[:400], int(time.time()), bid))
            _set_job(bid, state='error', error=msg)


def _make(bid):
    b = get(bid)
    if not b:
        return
    _set_job(bid, state='working', stage='Starting…')
    src = folder(bid, 'source')
    build = folder(bid, 'build')
    shutil.rmtree(build, ignore_errors=True)
    for sub in ('pages', 'thumbs', 'text'):
        os.makedirs(os.path.join(build, sub))
    if b['kind'] == 'text':
        pages = _text_pages(b, src)
    elif b['kind'] == 'pdf':
        pages = _pdf_pages(bid, os.path.join(src, 'book.pdf'), build)
    else:
        names = sorted((f for f in os.listdir(src) if f.startswith('image-')), key=lambda f: int(re.sub(r'\D', '', f)))
        pages = _photo_pages(bid, [os.path.join(src, f) for f in names], build)
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
    size = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(folder(bid)) for f in fs)
    db.run("UPDATE books SET status = 'ready', error = '', pages = ?, bytes = ?, updated = ? WHERE id = ?",
           (json.dumps(meta), size, int(time.time()), bid))
    _set_job(bid, state='done', stage='Ready', done=len(meta), total=len(meta))


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


# ---------- PDF: draw the pages, take the words from the PDF (OCR for scanned pages)

def _pdf_pages(bid, path, build):
    import pdfplumber
    import pypdfium2 as pdfium
    try:
        pdf = pdfium.PdfDocument(path)
    except Exception:
        raise LibraryError('The PDF could not be opened (damaged, or protected with a password).')
    n = len(pdf)
    if n > LIMITS['pages']:
        raise LibraryError(f"The PDF has {n} pages; at most {LIMITS['pages']} can be used.")
    out, scans = [], []
    with pdfplumber.open(path) as plumb:
        for i in range(n):
            _set_job(bid, stage=f'Reading page {i + 1} of {n}', done=i, total=n)
            page = pdf[i]
            wpt, hpt = page.get_size()
            scale = min(PAGE_W / wpt, 4000 / hpt)
            img = page.render(scale=scale).to_pil().convert('RGB')
            p = plumb.pages[i]
            words = []
            if not (p.rotation or 0) % 360:  # turned pages: the words' places would not match; read with OCR
                try:
                    words = p.extract_words(use_text_flow=True, keep_blank_chars=False, x_tolerance=1.5)
                except Exception:
                    words = []
            if sum(bool(re.search(r'[A-Za-z0-9]', w['text'])) for w in words) >= 3:
                x0, top = p.bbox[0], p.bbox[1]
                sx, sy = img.width / p.width, img.height / p.height
                raw = {'w': img.width, 'h': img.height, 'lines': _lines(words, x0, top, sx, sy)}
                out.append((img, segment(raw, ocr=False)))
            else:
                scans.append(len(out))
                out.append((img, None))
    if scans:
        docs = _ocr(bid, [out[i][0] for i in scans], build)
        for i, doc in zip(scans, docs):
            out[i] = (out[i][0], doc)
    return out


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


# ---------- Photos: upright, not too big, read with OCR

def _photo_pages(bid, paths, build):
    imgs = []
    for i, p in enumerate(paths):
        _set_job(bid, stage=f'Preparing photo {i + 1} of {len(paths)}', done=i, total=len(paths))
        try:
            img = ImageOps.exif_transpose(Image.open(p)).convert('RGB')
        except Exception:
            raise LibraryError(f'Photo {i + 1} could not be opened.')
        if img.width > 2000:
            img = img.resize((2000, round(img.height * 2000 / img.width)), Image.LANCZOS)
        imgs.append(img)
    docs = _ocr(bid, imgs, build)
    return list(zip(imgs, docs))


def _ocr(bid, imgs, build):
    _set_job(bid, stage=f"Reading the words of {len(imgs)} page{'s' if len(imgs) > 1 else ''} (OCR)…", done=0, total=len(imgs))
    tmp = os.path.join(build, 'ocr')
    os.makedirs(tmp, exist_ok=True)
    pngs = []
    for i, img in enumerate(imgs):
        pngs.append(os.path.join(tmp, f'{i:04d}.png'))
        img.save(pngs[-1])
    raws = ocr.read_pages(pngs)
    shutil.rmtree(tmp, ignore_errors=True)
    return [segment(raw, ocr=False) for raw in raws]


# ---------------------------------------------------------------- Text of a page, search

def text_doc(bid, n):
    """The page's words: the owner's corrections if there are, else as made. None if none."""
    for sub in ('edits', 'text'):
        p = folder(bid, sub, f'{n}.json')
        if os.path.isfile(p):
            with open(p, encoding='utf-8') as f:
                doc = json.load(f)
            if sub == 'edits':
                doc['edited'] = True
            return doc
    return None


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

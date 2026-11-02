"""Guided, resumable import of supported content from a legacy application.

Uploaded programs are inventoried, never imported or executed. Adapters convert
iTools page tiles, PDFs and page images into private library books.
The durable job record is separate from the upload ledger so a folder containing
hundreds of thousands of small tiles can be uploaded without rewriting its list.
"""
import hashlib
import html
import io
import json
import math
import os
import re
import secrets
import shutil
import sqlite3
import stat
import threading
import time
import unicodedata
import zipfile
from contextlib import contextmanager

from PIL import Image, ImageOps

import db
import library


def _env(name, default):
    try:
        return max(1, int(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


MAX_UPLOAD_BYTES = _env('LB_MIGRATION_UPLOAD_MB', 512) * 2 ** 20
LIMITS = {'files': _env('LB_MIGRATION_FILES', 250000),
          'bytes': _env('LB_MIGRATION_TOTAL_MB', 8192) * 2 ** 20,
          'file_bytes': MAX_UPLOAD_BYTES, 'pages': _env('LB_MIGRATION_PAGES', 2000),
          'candidates': 100, 'pixels': 40000000, 'ratio': 1000, 'jobs_per_user': 10}
ID = re.compile(r'M[0-9a-f]{16}')
BUSY = {'analyzing', 'sampling', 'converting'}
STEPS = ['Upload files', 'Inspect the old app', 'Choose what to convert',
         'Review sample pages', 'Convert pages', 'Validate and export']
IMAGES = {'.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'}
MEDIA = {'.mp3', '.wav', '.ogg', '.m4a', '.mp4', '.webm'}
CODE = {'.exe', '.dll', '.bat', '.cmd', '.ps1', '.sh', '.py', '.js', '.html', '.htm', '.swf', '.jar'}
_lock = threading.RLock()
_saved_at = {}  # migration -> when its job.json was last saved during an upload
_tasks = {}
_cancels = {}
_worker_slot = threading.Semaphore(1)
_INTERNAL = object()


class MigrationError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class _Cancelled(Exception):
    pass


def _root(mid, *parts):
    if not ID.fullmatch(str(mid)):
        raise MigrationError('No such migration.', 404)
    return os.path.join(db.DATA, 'migrations', mid, *parts)


def _json(path, default=None):
    try:
        with open(path, encoding='utf-8-sig') as src:
            return json.load(src)
    except FileNotFoundError:
        return default


def _write(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as out:
        json.dump(value, out, ensure_ascii=False, separators=(',', ':'))
    db.replace(tmp, path)  # (waits a moment if Windows' virus scanner has the file open)


def _load(mid, user=_INTERNAL):
    job = _json(_root(mid, 'job.json'))
    if not job:
        raise MigrationError('No such migration.', 404)
    if user is not _INTERNAL and (not user or not (user.get('admin') or user['id'] == job['owner'])):
        raise MigrationError('This migration belongs to another user.', 403)
    if job['state'] in BUSY and mid not in _tasks:
        job['state'] = 'interrupted'
        job['error'] = 'The server restarted. Resume this step to continue from saved pages.'
        for step in job['steps']:
            if step['state'] == 'working':
                step['state'] = 'interrupted'
        _write(_root(mid, 'job.json'), job)
    return job


def _save(job):
    job['updated'] = int(time.time())
    _write(_root(job['id'], 'job.json'), job)


def _change(mid, **values):
    with _lock:
        job = _load(mid)
        job.update(values)
        _save(job)
        return job


def _step(mid, number, state='working', done=0, total=1, message=''):
    with _lock:
        job = _load(mid)
        job['steps'][number - 1].update(state=state, done=done, total=total, message=message)
        _save(job)


def _public(job):
    out = {k: v for k, v in job.items() if not k.startswith('_') and k != 'owner'}
    out['candidates'] = [{k: v for k, v in c.items() if not k.startswith('_')} for c in job['candidates']]
    out['resumable'] = job['state'] in ('error', 'interrupted', 'cancelled')
    out['canExport'] = os.path.isfile(_root(job['id'], 'export.zip')) and job['state'] == 'ready'
    return out


def snapshot(mid, user):
    if not user:
        raise MigrationError('Sign in to use the migration assistant.', 401)
    with _lock:
        return _public(_load(mid, user))


def list_jobs(user):
    if not user:
        raise MigrationError('Sign in to use the migration assistant.', 401)
    root = os.path.join(db.DATA, 'migrations')
    if not os.path.isdir(root):
        return []
    jobs = []
    with _lock:
        for mid in os.listdir(root):
            if ID.fullmatch(mid):
                job = _load(mid)
                if job['owner'] == user['id']:
                    jobs.append(_public(job))
    return sorted(jobs, key=lambda j: j['updated'], reverse=True)


def create(user, meta):
    if not user:
        raise MigrationError('Sign in to use the migration assistant.', 401)
    if not isinstance(meta, dict):
        raise MigrationError('Send the upload details.')
    kind = meta.get('input', 'zip')
    if kind not in ('zip', 'folder'):
        raise MigrationError('Choose a ZIP file or a folder.')
    with _lock:
        active = [j for j in list_jobs(user) if j['state'] != 'ready']
        if len(active) >= LIMITS['jobs_per_user']:
            raise MigrationError('Finish an existing migration before starting another.')
        try:
            expected = max(0, int(meta.get('expectedFiles') or 0))
            size = max(0, int(meta.get('expectedBytes') or 0))
        except (ValueError, TypeError):
            raise MigrationError('The upload file count or size is invalid.')
        if expected > LIMITS['files'] or size > LIMITS['bytes']:
            raise MigrationError('This upload exceeds the migration file count or size limit.', 413)
        mid = 'M' + secrets.token_hex(8)
        now = int(time.time())
        job = {'id': mid, 'owner': user['id'], 'title': str(meta.get('title') or 'Old app')[:120],
               'input': kind, 'state': 'upload', 'phase': 'upload', 'created': now, 'updated': now,
               'steps': [{'number': n, 'label': label, 'state': 'working' if n == 1 else 'waiting',
                          'done': 0, 'total': expected if n == 1 else 1, 'message': ''}
                         for n, label in enumerate(STEPS, 1)],
               'upload': {'files': 0, 'bytes': 0, 'expectedFiles': expected, 'expectedBytes': size},
               'candidates': [], 'selected': [], 'options': library._clean_options({}),
               'results': [], 'warnings': [], 'error': '', 'sample': None, '_books': {}, '_completed': {}}
        os.makedirs(_root(mid, 'source'))
        _save(job)
        with _ledger(mid) as ledger:
            ledger.execute('CREATE TABLE files (path TEXT PRIMARY KEY, folded TEXT UNIQUE, size INTEGER, sha TEXT)')
        return _public(job)


@contextmanager
def _ledger(mid):
    con = sqlite3.connect(_root(mid, 'files.sqlite'), timeout=30)
    con.row_factory = sqlite3.Row
    try:
        with con:
            yield con
    finally:
        con.close()


def _name(name):
    name = unicodedata.normalize('NFC', str(name)).replace('\\', '/')
    parts = name.split('/')
    if not name or len(name) > 700 or len(parts) > 32 or any(
            not p or p in ('.', '..') or p[-1:] in ('.', ' ') or len(p) > 240
            or re.search(r'[\x00-\x1f\x7f<>:"|?*]', p)
            or re.fullmatch(r'(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?', p, re.I)
            for p in parts):
        raise MigrationError('The upload contains an unsafe file path.')
    return name


def _source(mid, name):
    safe = _name(name)
    path = os.path.realpath(_root(mid, 'source', *safe.split('/')))
    base = os.path.realpath(_root(mid, 'source'))
    if os.path.commonpath([base, path]) != base:
        raise MigrationError('The upload contains an unsafe file path.')
    return path


def _counts(job, ledger):
    """The files received so far (the ledger counts them): into the job."""
    files, size = ledger.execute('SELECT COUNT(*), COALESCE(SUM(size), 0) FROM files').fetchone()
    job['upload'].update(files=files, bytes=size)
    job['steps'][0].update(done=files, total=job['upload']['expectedFiles'] or files, message=f'{files:,} files uploaded')


def save_upload(mid, user, name, data):
    """One file of the upload. job.json (the counts shown) is saved at most once a second: an
    old app can have 100 000 files and more, and every save is a moment when Windows' virus
    scanner can hold the file; the ledger always has the true counts."""
    if not user:
        raise MigrationError('Sign in to upload files.', 401)
    if not isinstance(data, bytes) or len(data) > LIMITS['file_bytes']:
        raise MigrationError('This file exceeds the upload size limit.', 413)
    safe = _name(name)
    digest = hashlib.sha256(data).hexdigest()
    with _lock:
        job = _load(mid, user)
        if job['state'] != 'upload':
            raise MigrationError('The upload is closed. Start a new migration to change its files.', 409)
        if job['input'] == 'zip' and not data:
            raise MigrationError('Choose a non-empty ZIP file.')
        with _ledger(mid) as ledger:
            _counts(job, ledger)
            old = ledger.execute('SELECT * FROM files WHERE folded = ?', (safe.casefold(),)).fetchone()
            if old:
                if old['path'] == safe and old['sha'] == digest:
                    return _public(job)  # (received before: an upload that goes on)
                raise MigrationError('Two uploaded files have the same name. Start a new migration to replace a file.')
            if job['input'] == 'zip' and (job['upload']['files'] or not safe.lower().endswith('.zip')):
                raise MigrationError('Choose one ZIP file for this migration.')
            if job['upload']['files'] + 1 > LIMITS['files'] or job['upload']['bytes'] + len(data) > LIMITS['bytes']:
                raise MigrationError('This upload exceeds the migration size limit.', 413)
            target = _source(mid, safe) if job['input'] == 'folder' else _root(mid, 'upload.zip')
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target + '.part', 'wb') as out:
                out.write(data)
            db.replace(target + '.part', target)
            ledger.execute('INSERT INTO files VALUES (?, ?, ?, ?)', (safe, safe.casefold(), len(data), digest))
            _counts(job, ledger)
        now = time.monotonic()
        if now - _saved_at.get(mid, 0) >= 1 or job['upload']['files'] == job['upload']['expectedFiles']:
            _save(job)
            _saved_at[mid] = now
        return _public(job)


def uploaded(mid, user):
    """The files received so far, {path: size}: an upload that goes on sends only the others."""
    snapshot(mid, user)
    with _lock, _ledger(mid) as ledger:
        return {'files': {row['path']: row['size'] for row in ledger.execute('SELECT path, size FROM files')}}


def _check_cancel(mid):
    if _cancels.get(mid) and _cancels[mid].is_set():
        raise _Cancelled()


def _start(mid, user, phase, state, target):
    with _lock:
        job = _load(mid, user)
        if mid in _tasks:
            raise MigrationError('This migration is already running.', 409)
        def run():
            try:
                with _worker_slot:
                    _check_cancel(mid)
                    target()
            except _Cancelled:
                _change(mid, state='cancelled', error='Paused. Resume this step to continue from saved pages.')
            except Exception as exc:
                _change(mid, state='error', error=str(exc)[:600] or 'This step could not finish.')
            finally:
                with _lock:
                    current = _load(mid)
                    if current['state'] in ('error', 'cancelled'):
                        for step in current['steps']:
                            if step['state'] == 'working':
                                step['state'] = current['state']
                        _save(current)
                    _tasks.pop(mid, None)
                    _cancels.pop(mid, None)
        thread = threading.Thread(target=run, name=f'migration-{mid}', daemon=True)
        _tasks[mid] = thread
        _cancels[mid] = threading.Event()
        job.update(phase=phase, state=state, error='')
        _save(job)
        thread.start()
        return _public(job)


def cancel(mid, user):
    with _lock:
        job = _load(mid, user)
        if mid in _cancels:
            _cancels[mid].set()
            job['message'] = 'Stopping after the current page. Completed pages are saved.'
        elif job['state'] not in ('ready', 'upload'):
            job['state'] = 'cancelled'
        _save(job)
        return _public(job)


def discard(mid, user):
    """Explicitly discard a stopped import, keeping every completed library book."""
    with _lock:
        job = _load(mid, user)
        if mid in _tasks:
            raise MigrationError('Pause this import and wait for the current page before removing it.', 409)
        base = os.path.realpath(os.path.join(db.DATA, 'migrations'))
        target = os.path.realpath(_root(mid))
        if target == base or os.path.commonpath([base, target]) != base:
            raise MigrationError('Invalid import storage path.')
        for bid in job['_books'].values():
            book = library.get(bid)
            if book and book['owner'] == job['owner'] and book['status'] != 'ready':
                books_root = os.path.realpath(library.BOOKS)
                book_root = os.path.realpath(library.folder(bid))
                if book_root == books_root or os.path.commonpath([books_root, book_root]) != books_root:
                    raise MigrationError('Invalid book storage path.')
                library.delete(book)
        shutil.rmtree(target)
        return {'discarded': True}


def analyze(mid, user):
    with _lock:
        job = _load(mid, user)
        if job['_books']:
            raise MigrationError('Conversion has started. Resume it or start a new migration.', 409)
        if job['state'] not in ('upload', 'planned', 'error', 'interrupted', 'cancelled'):
            raise MigrationError('Finish the current step first.', 409)
        if job['state'] == 'upload':
            with _ledger(mid) as ledger:
                _counts(job, ledger)
            _save(job)
        up = job['upload']
        if not up['files'] or up['expectedFiles'] and up['files'] != up['expectedFiles']:
            raise MigrationError('Finish uploading all files before inspecting the app.')
        if up['expectedBytes'] and up['bytes'] != up['expectedBytes']:
            raise MigrationError('The uploaded size does not match the selected files. Finish the upload first.')
        return _start(mid, user, 'analyze', 'analyzing', lambda: _analyze(mid))


def _unpack(mid):
    """Validate the entire directory first; extract only to this job's source root."""
    try:
        archive = zipfile.ZipFile(_root(mid, 'upload.zip'))
    except (zipfile.BadZipFile, OSError):
        raise MigrationError('This ZIP file could not be opened.')
    with archive:
        entries, seen, total = [], set(), 0
        if len(archive.infolist()) > LIMITS['files'] * 2:
            raise MigrationError('The ZIP contains too many entries.', 413)
        for entry in archive.infolist():
            _check_cancel(mid)
            safe = _name(entry.filename.rstrip('/'))
            mode = entry.external_attr >> 16
            if stat.S_ISLNK(mode) or stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR):
                raise MigrationError('ZIP links and special device files are not supported.')
            if entry.flag_bits & 1:
                raise MigrationError('Password-protected ZIP files are not supported.')
            folded = safe.casefold()
            if folded in seen:
                raise MigrationError('The ZIP contains duplicate file paths.')
            seen.add(folded)
            if entry.is_dir():
                continue
            total += entry.file_size
            if (entry.file_size > LIMITS['file_bytes'] or total > LIMITS['bytes']
                    or entry.file_size / max(1, entry.compress_size) > LIMITS['ratio']):
                raise MigrationError('The ZIP exceeds the extraction size or compression limit.', 413)
            entries.append((entry, safe))
            if len(entries) > LIMITS['files']:
                raise MigrationError('The ZIP contains too many files.', 413)
        if not entries:
            raise MigrationError('The ZIP has no files.')
        # The upload ledger originally contains the archive. Replace it transactionally.
        with _ledger(mid) as ledger:
            ledger.execute('DELETE FROM files')
            for index, (entry, safe) in enumerate(entries, 1):
                _check_cancel(mid)
                target = _source(mid, safe)
                os.makedirs(os.path.dirname(target), exist_ok=True)
                digest, written = hashlib.sha256(), 0
                with archive.open(entry) as source, open(target + '.part', 'wb') as out:
                    while True:
                        _check_cancel(mid)
                        block = source.read(1024 * 1024)
                        if not block:
                            break
                        written += len(block)
                        if written > entry.file_size or written > LIMITS['file_bytes']:
                            raise MigrationError('The ZIP contains an invalid expanded file size.')
                        digest.update(block)
                        out.write(block)
                db.replace(target + '.part', target)
                ledger.execute('INSERT INTO files VALUES (?, ?, ?, ?)', (safe, safe.casefold(), written, digest.hexdigest()))
                if index % 100 == 0 or index == len(entries):
                    _step(mid, 2, done=index, total=len(entries), message=f'Unpacking file {index:,} of {len(entries):,}')
        _change(mid, unpacked=True)


def _natural(value):
    return [(0, int(p)) if p.isdigit() else (1, p.casefold()) for p in re.split(r'(\d+)', str(value))]


def _cid(path):
    return 'C' + hashlib.sha256(path.encode('utf-8')).hexdigest()[:16]


def _read_json_upload(mid, path):
    file = _source(mid, path)
    if os.path.getsize(file) > 16 * 2 ** 20:
        raise MigrationError('A content index is too large to inspect.')
    value = _json(file)
    if not isinstance(value, dict):
        raise MigrationError('The content index is invalid.')
    return value


def _join(*parts):
    return '/'.join(str(p).strip('/') for p in parts if str(p).strip('/'))


def _analyze(mid):
    job = _load(mid)
    _step(mid, 1, 'done', job['upload']['files'], job['upload']['files'], 'Upload received')
    _step(mid, 2, message='Inspecting file formats')
    if job['input'] == 'zip' and not job.get('unpacked'):
        _unpack(mid)
    with _ledger(mid) as ledger:
        files = [dict(r) for r in ledger.execute('SELECT path,size FROM files ORDER BY path')]
    paths = {f['path'] for f in files}
    warnings, candidates, roots, counts = [], [], [], {}
    for file in files:
        ext = os.path.splitext(file['path'])[1].lower() or '(no extension)'
        counts[ext] = counts.get(ext, 0) + 1
    index_paths = [p for p in paths if p.lower().endswith('/content/index.json') or p.lower() == 'content/index.json']
    for source in sorted(index_paths):
        _check_cancel(mid)
        try:
            index = _read_json_upload(mid, source)
            if not isinstance(index.get('books'), dict):
                continue
            root = source[:-len('content/index.json')].rstrip('/')
            roots.append(root)
            prefix = _join(root, 'books') + '/'
            tile_counts = {}
            for path in paths:
                if path.startswith(prefix):
                    match = re.fullmatch(r'([^/]+)/pages/([^/]+)/([0-4])/([0-9]{1,2})/([0-9]{1,2})\.png', path[len(prefix):])
                    if match:
                        slug, page, zoom, col, row = match.groups()
                        n = 2 ** int(zoom)
                        if int(col) < n and int(row) < n:
                            key = (slug, page, int(zoom))
                            tile_counts[key] = tile_counts.get(key, 0) + 1
            for old_id, book in index['books'].items():
                if not isinstance(book, dict) or not isinstance(book.get('pages'), dict):
                    continue
                slug = str(book.get('slug', ''))
                if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', slug):
                    warnings.append('A book with an invalid identifier was skipped.')
                    continue
                pages, missing, partial = [], 0, 0
                for n, page in sorted(book['pages'].items(), key=lambda pair: _natural(pair[0])):
                    path = str(page.get('page_path', '')) if isinstance(page, dict) else ''
                    if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', path):
                        missing += 1
                        continue
                    zooms = [z for z in range(5) if tile_counts.get((slug, path, z))]
                    if not zooms:
                        missing += 1
                        continue
                    complete = [z for z in zooms if tile_counts[(slug, path, z)] == 4 ** z]
                    zoom = max(complete or zooms)
                    partial += not bool(complete)
                    pages.append({'sourcePage': str(n), 'path': _join(root, 'books', slug, 'pages', path),
                                  'pagePath': path, 'zoom': zoom})
                if pages:
                    title = ' · '.join(str(book.get(k) or '') for k in ('title', 'type') if book.get(k)) or slug
                    candidates.append({'id': _cid(source + ':' + slug), 'title': title[:120], 'kind': 'itools',
                                       'pageCount': len(pages), 'source': source, 'description': 'iTools book pages, audio and supported video',
                                       '_pages': pages, '_root': root, '_slug': slug, '_oldId': str(old_id)})
                    if missing or partial:
                        warnings.append(f'{title}: {missing} pages without tiles skipped; {partial} pages have incomplete tiles.')
        except (MigrationError, ValueError, TypeError) as exc:
            warnings.append(f'Could not inspect {source}: {str(exc)[:160]}')
    image_groups = {}
    for index, file in enumerate(files, 1):
        _check_cancel(mid)
        path = file['path']
        # A recognized app's image assets are parts of books or controls, not new books.
        inside_known = any(path.startswith(root + '/') if root else path.startswith(('books/', 'assets/', 'content/')) for root in roots)
        ext = os.path.splitext(path)[1].lower()
        if ext == '.pdf':
            try:
                import pypdfium2 as pdfium
                with pdfium.PdfDocument(_source(mid, path)) as pdf:
                    total = len(pdf)
                if total:
                    candidates.append({'id': _cid(path), 'title': os.path.splitext(os.path.basename(path))[0][:120],
                                       'kind': 'pdf', 'pageCount': total, 'source': path,
                                       'description': 'PDF pages with text extraction and OCR when needed',
                                       '_pages': [{'sourcePage': str(n + 1), 'path': path, 'index': n} for n in range(total)]})
            except Exception:
                warnings.append(f'{path}: PDF could not be opened; it may be damaged or password protected.')
        elif ext in IMAGES and not inside_known and not re.search(r'/(?:thumbs|icons|covers|node_modules)/', '/' + path, re.I):
            image_groups.setdefault(os.path.dirname(path).replace('\\', '/'), []).append(path)
        if index % 1000 == 0 or index == len(files):
            _step(mid, 2, done=index, total=len(files), message=f'Inspected {index:,} of {len(files):,} files')
    for directory, images in sorted(image_groups.items()):
        pages = [{'sourcePage': str(n + 1), 'path': path} for n, path in enumerate(sorted(images, key=_natural))]
        candidates.append({'id': _cid('images:' + directory), 'title': os.path.basename(directory) or 'Page images',
                           'kind': 'images', 'pageCount': len(pages), 'source': directory or '/',
                           'description': 'Images in filename order; choose page images, not app icons', '_pages': pages})
    if len(candidates) > LIMITS['candidates']:
        warnings.append(f'Only the first {LIMITS["candidates"]} content collections are listed. Upload smaller groups to import the rest.')
        candidates = candidates[:LIMITS['candidates']]
    programs = sum(counts.get(ext, 0) for ext in CODE)
    if programs:
        warnings.append(f'{programs:,} program/source files were inventoried. Their application logic is not converted or executed.')
    if counts.get('.swf') or counts.get('.flv'):
        warnings.append('Flash activities and FLV videos need a separate adapter; they are not playable in this migration.')
    if not candidates:
        warnings.append('No supported books found. Upload iTools content folders, PDFs, or folders of page images. Other app formats need an adapter.')
    _step(mid, 2, 'done', len(files), len(files), f'{len(candidates)} supported content collections found')
    _step(mid, 3, 'working', 0, len(candidates), 'Choose the books and extraction settings')
    _change(mid, state='planned', candidates=candidates, selected=[c['id'] for c in candidates], warnings=warnings,
            sample=None, inventory={'files': len(files), 'bytes': sum(f['size'] for f in files), 'formats': counts,
                                    'engine': 'Built-in format adapters; no external AI calls'})


def _settings(job, body):
    raw = body.get('selected', job['selected'])
    if not isinstance(raw, list) or not raw or len(raw) != len(set(str(i) for i in raw)):
        raise MigrationError('Choose at least one content collection.')
    selected = [str(v) for v in raw]
    candidates = {c['id']: c for c in job['candidates']}
    if any(cid not in candidates for cid in selected):
        raise MigrationError('Choose a collection from the inspection results.')
    try:
        options = library._clean_options(body.get('options', job['options']))
        options['preserveMedia'] = bool(body.get('options', job['options']).get('preserveMedia', True))
        chosen = [(candidates[cid], [candidates[cid]['_pages'][i] for i in
                   library._page_numbers(options['pages'], len(candidates[cid]['_pages']))]) for cid in selected]
    except (library.LibraryError, TypeError, AttributeError) as exc:
        raise MigrationError(str(exc))
    total = sum(len(pages) for _, pages in chosen)
    if not 0 < total <= LIMITS['pages']:
        raise MigrationError(f'Choose between 1 and {LIMITS["pages"]} pages per migration.')
    fingerprint = hashlib.sha256(json.dumps([selected, options], sort_keys=True).encode()).hexdigest()
    return selected, options, chosen, fingerprint


def make_sample(mid, user, body):
    with _lock:
        job = _load(mid, user)
        if job['_books']:
            raise MigrationError('Conversion has started. Resume it or start a new migration for different settings.', 409)
        if job['state'] not in ('planned', 'review', 'error', 'interrupted', 'cancelled') or not job['candidates']:
            raise MigrationError('Inspect the app and choose content first.', 409)
        selected, options, chosen, fingerprint = _settings(job, body)
        _change(mid, selected=selected, options=options, sample=None, _fingerprint=fingerprint)
        return _start(mid, user, 'sample', 'sampling', lambda: _sample(mid, chosen, options, fingerprint))


def _sample(mid, chosen, options, fingerprint):
    _step(mid, 3, 'done', len(chosen), len(chosen), 'Content and languages chosen')
    all_pages = [(candidate, page) for candidate, pages in chosen for page in pages]
    picks = library._pick(list(range(len(all_pages))), library.sample_size(len(all_pages)))
    token, pages = secrets.token_hex(12), []
    _step(mid, 4, total=len(picks), message='Preparing sample pages')
    for n, index in enumerate(picks):
        _check_cancel(mid)
        candidate, page = all_pages[index]
        _step(mid, 4, done=n, total=len(picks), message=f'Reading {candidate["title"]}, page {page["sourcePage"]}')
        image, doc, how = _render_page(mid, candidate, page, options)
        name = f'{token}-{n + 1}.webp'
        os.makedirs(_root(mid, 'preview'), exist_ok=True)
        image.save(_root(mid, 'preview', name), 'WEBP', quality=82)
        image.close()
        pages.append({'candidate': candidate['id'], 'title': candidate['title'], 'page': page['sourcePage'],
                      'image': f'/api/migrations/{mid}/preview/{name}', 'text': library.page_text(doc),
                      'words': len(doc['words']), 'how': how})
        _step(mid, 4, done=n + 1, total=len(picks), message=f'{n + 1} of {len(picks)} sample pages ready')
    _step(mid, 4, 'review', len(picks), len(picks), 'Check the pages and approve, or adjust settings and preview again')
    _change(mid, state='review', sample={'token': token, 'pages': pages, 'fingerprint': fingerprint,
                                      'total': len(all_pages), 'options': options})


def _image(path):
    with Image.open(path) as source:
        if source.width * source.height > LIMITS['pixels']:
            raise MigrationError('A page image exceeds the pixel limit.')
        image = ImageOps.exif_transpose(source).convert('RGB')
    if image.width > 2000 or image.height > 5000:
        image.thumbnail((2000, 5000), Image.Resampling.LANCZOS)
    return image


def _stitch(mid, page):
    n = 2 ** page['zoom']
    tiles = []
    for col in range(n):
        for row in range(n):
            path = _source(mid, _join(page['path'], page['zoom'], col, f'{row}.png'))
            if os.path.isfile(path):
                tiles.append((col, row, path))
    if not tiles:
        raise MigrationError(f'Page {page["sourcePage"]} has no usable image tiles.')
    with Image.open(tiles[0][2]) as first:
        width, height = first.size
    if width * height * n * n > LIMITS['pixels'] or not width or not height:
        raise MigrationError('The page tiles exceed the image size limit.')
    image = Image.new('RGB', (width * n, height * n), 'white')
    for col, row, path in tiles:
        _check_cancel(mid)
        with Image.open(path) as tile:
            if tile.size != (width, height):
                raise MigrationError('Page tile dimensions are inconsistent.')
            tile = tile.convert('RGBA')
            image.paste(tile, (col * width, (n - row - 1) * height), tile)
    return image


def _existing_raw(mid, candidate, page, image):
    root = candidate['_root']
    parent = root.rsplit('/', 1)[0] if '/' in root else ''
    path = _join(parent, 'web/data/text', candidate['_slug'], page['pagePath'] + '.json')
    if not os.path.isfile(_source(mid, path)):
        return None
    doc = _read_json_upload(mid, path)
    words = doc.get('words')
    if not isinstance(words, list) or len(words) > 30000:
        return None
    lines = {}
    for w in words:
        if not isinstance(w, list) or len(w) < 6 or not isinstance(w[4], str) or len(w[4]) > 1000:
            return None
        if any(not isinstance(v, (float, int)) or not math.isfinite(v) or abs(v) > 100000 for v in w[:4]):
            return None
        # Original iTools OCR coordinates correspond to the full 1984 x 2496 page.
        sx, sy = image.width / 1984, image.height / 2496
        lines.setdefault(str(w[5]), []).append({'t': w[4], 'x': round(w[0] * sx), 'y': round(w[1] * sy),
                                              'w': max(1, round(w[2] * sx)), 'h': max(1, round(w[3] * sy))})
    return {'w': image.width, 'h': image.height, 'lines': [{'words': words} for words in lines.values()]}


def _render_page(mid, candidate, page, options):
    _check_cancel(mid)
    raw, how = None, 'ocr'
    if candidate['kind'] == 'pdf':
        image, raw, how = library._pdf_pages(_source(mid, page['path']), [page['index']], options['ocrAll'],
                                              lambda *args: _check_cancel(mid))[0]
    elif candidate['kind'] == 'itools':
        image = _stitch(mid, page)
        if not options['ocrAll']:
            raw = _existing_raw(mid, candidate, page, image)
            if raw:
                how = 'existing text'
    else:
        image = _image(_source(mid, page['path']))
    if raw is None:
        scratch = _root(mid, 'work')
        os.makedirs(scratch, exist_ok=True)
        raw = library._ocr([image], scratch, options, lambda *args: _check_cancel(mid))[0]
    _check_cancel(mid)
    doc, _ = library._doc(raw, options)
    return image, doc, how


def convert(mid, user, body):
    with _lock:
        job = _load(mid, user)
        if job['state'] == 'ready':
            return _public(job)
        if job['state'] not in ('review', 'error', 'interrupted', 'cancelled'):
            raise MigrationError('Review sample pages before converting the app.', 409)
        sample = job.get('sample')
        selected, options, chosen, fingerprint = _settings(job, body)
        if (body.get('approved') is not True or not sample or not sample.get('pages')
                or body.get('sampleToken') != sample['token'] or fingerprint != sample['fingerprint']):
            raise MigrationError('Review and approve a fresh sample for these books and settings.', 409)
        return _start(mid, user, 'convert', 'converting', lambda: _conversion(mid, user))


def _page_outputs(bid, n):
    return [library.folder(bid, sub, f'{n}.{ext}') for sub, ext in (('pages', 'webp'), ('thumbs', 'webp'), ('text', 'json'))]


def _valid_page(bid, n):
    """Do not reuse a damaged checkpoint on retry."""
    try:
        image_path, thumb_path, text_path = _page_outputs(bid, n)
        for path in (image_path, thumb_path):
            with Image.open(path) as image:
                image.verify()
        doc = _json(text_path)
        return isinstance(doc, dict) and isinstance(doc.get('words'), list)
    except (OSError, ValueError, SyntaxError):
        return False


def _save_page(bid, n, image, doc, source_page):
    paths = _page_outputs(bid, n)
    for path in paths:
        os.makedirs(os.path.dirname(path), exist_ok=True)
    image.save(paths[0] + '.tmp', 'WEBP', quality=85)
    thumb = image.copy()
    thumb.thumbnail((240, 2000))
    thumb.save(paths[1] + '.tmp', 'WEBP', quality=75)
    thumb.close()
    _write(paths[2], doc)
    db.replace(paths[0] + '.tmp', paths[0])
    db.replace(paths[1] + '.tmp', paths[1])
    return {'n': str(n), 'w': image.width, 'h': image.height, 'words': len(doc['words']), 'sourcePage': source_page}


def _conversion(mid, user):
    job = _load(mid)
    _, options, chosen, _ = _settings(job, {})
    total = sum(len(pages) for _, pages in chosen)
    _step(mid, 4, 'done', len(job['sample']['pages']), len(job['sample']['pages']), 'Sample approved')
    completed = job['_completed']
    # Create all private destination identities first so cross-book links can be remapped.
    for candidate, pages in chosen:
        _check_cancel(mid)
        cid = candidate['id']
        if cid not in job['_books']:
            book = library.create(user, {'kind': 'images', 'title': candidate['title'], 'importOptions': options,
                                         'about': f'Imported from {job["title"]} with the migration assistant.'})
            db.run("UPDATE books SET status = 'working' WHERE id = ?", (book['id'],))
            job['_books'][cid] = book['id']
            completed[cid] = {}
            _change(mid, _books=job['_books'], _completed=completed)
    done = sum(len(p) for p in completed.values())
    _step(mid, 5, done=done, total=total, message='Converting pages; completed pages can be resumed')
    warnings = list(job['warnings'])
    for candidate, pages in chosen:
        cid, bid = candidate['id'], job['_books'][candidate['id']]
        if not library.get(bid):
            raise MigrationError('A destination book was removed. Start a new migration to recreate it.')
        for n, page in enumerate(pages, 1):
            _check_cancel(mid)
            if str(n) in completed[cid] and _valid_page(bid, n):
                continue
            _step(mid, 5, done=done, total=total, message=f'{candidate["title"]}: page {n} of {len(pages)}')
            image, doc, how = _render_page(mid, candidate, page, options)
            completed[cid][str(n)] = _save_page(bid, n, image, doc, page['sourcePage'])
            image.close()
            done = sum(len(p) for p in completed.values())
            _change(mid, _completed=completed)
            _step(mid, 5, done=done, total=total, message=f'{done} of {total} pages saved')
        if options['preserveMedia'] and candidate['kind'] == 'itools':
            _copy_assets(mid, candidate, pages, bid, chosen, job['_books'], warnings)
    _step(mid, 5, 'done', total, total, 'All pages converted')
    _step(mid, 6, done=0, total=total + 1, message='Checking the converted pages')
    results, validated = [], 0
    for candidate, pages in chosen:
        _check_cancel(mid)
        bid = job['_books'][candidate['id']]
        meta = [completed[candidate['id']][str(n)] for n in range(1, len(pages) + 1)]
        for page in meta:
            _check_cancel(mid)
            outputs = _page_outputs(bid, page['n'])
            with Image.open(outputs[0]) as image:
                image.verify()
            doc = _json(outputs[2])
            if not isinstance(doc, dict) or not isinstance(doc.get('words'), list):
                raise MigrationError('A converted page did not pass validation. Resume to try again.')
            validated += 1
            _step(mid, 6, done=validated, total=total + 1, message=f'Validated {validated} of {total} pages')
        size = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(library.folder(bid)) for f in fs)
        previous_size = library.get(bid)['bytes'] or 0
        if not user.get('admin') and library._used_bytes(user['id']) - previous_size + size > library.LIMITS['user_mb'] * 2 ** 20:
            raise MigrationError('Your library storage is full. Free some storage before resuming.')
        db.run("UPDATE books SET status = 'ready', visibility = 'private', error = '', pages = ?, bytes = ?, updated = ? WHERE id = ?",
               (json.dumps(meta), size, int(time.time()), bid))
        results.append({'id': bid, 'title': candidate['title'], 'pages': len(meta), 'words': sum(p['words'] for p in meta),
                        'url': f'/web/#/{bid}/1'})
    _change(mid, results=results, warnings=list(dict.fromkeys(warnings)))
    _step(mid, 6, done=total, total=total + 1, message='Packaging books and migration report')
    _export(mid)
    _step(mid, 6, 'done', total + 1, total + 1, 'Books are ready in your library; export is available')
    _change(mid, state='ready', error='')


def _media_type(path):
    ext = os.path.splitext(path)[1].lower()
    with open(path, 'rb') as src:
        head = src.read(16)
    valid = ((ext == '.mp3' and (head[:3] == b'ID3' or len(head) > 1 and head[0] == 255 and head[1] & 224 == 224))
             or (ext == '.wav' and head[:4] == b'RIFF' and head[8:12] == b'WAVE')
             or (ext == '.ogg' and head[:4] == b'OggS')
             or (ext in ('.mp4', '.m4a') and head[4:8] == b'ftyp')
             or (ext == '.webm' and head[:4] == b'\x1aE\xdf\xa3'))
    return ext if valid else None


def _copy_media(mid, bid, source):
    path = _source(mid, source)
    if not os.path.isfile(path) or os.path.splitext(path)[1].lower() not in MEDIA:
        return None
    ext = _media_type(path)
    if not ext:
        return None
    digest = hashlib.sha256()
    with open(path, 'rb') as file:
        for block in iter(lambda: file.read(1024 * 1024), b''):
            _check_cancel(mid)
            digest.update(block)
    name = digest.hexdigest() + ext
    target = library.folder(bid, 'migration-media', name)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    if not os.path.isfile(target):
        shutil.copyfile(path, target)
    return f'/lib/{bid}/migration-media/{name}'


def _script(mid, bid, source):
    path = _source(mid, source)
    if not os.path.isfile(path) or not path.lower().endswith('.xml') or os.path.getsize(path) > 2 * 2 ** 20:
        return None
    with open(path, encoding='utf-8', errors='replace') as file:
        xml = file.read()
    # Parse only cue text; no XML entity resolution or execution.
    cues = []
    for attrs, body in re.findall(r'<Cue\b([^>]*)>(.*?)</Cue>', xml, re.S):
        text = html.unescape(re.sub(r'<[^>]+>', '', re.sub(r'<!\[CDATA\[(.*?)\]\]>', r'\1', body, flags=re.S))).strip()
        if not text or text == 'line_return':
            continue
        value = re.search(r'value\s*=\s*[\'"](\d+)[\'"]', attrs)
        if value:
            cues.append({'t': int(value.group(1)), 'x': text[:10000]})
        elif cues:
            cues[-1]['x'] = (cues[-1]['x'] + ' ' + text)[:10000]
    if not cues:
        return None
    name = hashlib.sha256(json.dumps(cues).encode()).hexdigest() + '.json'
    _write(library.folder(bid, 'migration-media', name), cues)
    return f'/lib/{bid}/migration-media/{name}'


def _copy_assets(mid, candidate, pages, bid, chosen, books, warnings):
    out = {'version': 1, 'pages': {}, 'source': {'migration': mid, 'candidate': candidate['id']}}
    links = {c['_oldId']: (books[c['id']], {p['sourcePage']: str(n) for n, p in enumerate(ps, 1)})
             for c, ps in chosen if c['kind'] == 'itools' and c['_root'] == candidate['_root']}
    skipped = 0
    for n, page in enumerate(pages, 1):
        _check_cancel(mid)
        source = _join(page['path'], 'index.json')
        if not os.path.isfile(_source(mid, source)):
            continue
        assets = _read_json_upload(mid, source).get('page_assets', [])
        if not isinstance(assets, list) or len(assets) > 1000:
            continue
        with Image.open(library.folder(bid, 'pages', f'{n}.webp')) as image:
            w, h = image.size
        spots = []
        for asset in assets:
            try:
                kind = asset.get('type')
                x, y = float(asset['lon']) / 1984 * w, (2496 - float(asset['lat'])) / 2496 * h
                if not math.isfinite(x + y):
                    continue
                spot = {'t': kind, 'x': round(max(0, min(w, x))), 'y': round(max(0, min(h, y))),
                        'title': str(asset.get('title') or '')[:240]}
                if kind in ('audio', 'video'):
                    link = str(asset.get('link') or '').replace('\\', '/')
                    rel = 'assets/' + link[11:] if link.startswith('resource://') else link
                    src = _copy_media(mid, bid, _join(candidate['_root'], rel))
                    if not src:
                        skipped += 1
                        continue
                    spot.update(src=src, script=None)
                    script = str(asset.get('script') or '')
                    if script.startswith('resource://'):
                        spot['script'] = _script(mid, bid, _join(candidate['_root'], 'assets', script[11:]))
                elif kind == 'page-link':
                    target_page, target_book = asset['link']
                    match = links.get(str(target_book))
                    if not match or str(target_page) not in match[1]:
                        skipped += 1
                        continue
                    spot.update(t='link', book=match[0], page=match[1][str(target_page)])
                else:
                    skipped += 1
                    continue
                spots.append(spot)
            except (MigrationError, TypeError, ValueError, KeyError, IndexError):
                skipped += 1
        if spots:
            out['pages'][str(n)] = spots
    _write(library.folder(bid, 'migration-assets.json'), out)
    if skipped:
        warnings.append(f'{candidate["title"]}: {skipped} unsupported or missing hotspots were left out; see the original app for those activities.')


def _report(mid, completed=False):
    with _lock:
        job = _load(mid)
        report = {'version': 1, 'id': mid, 'title': job['title'], 'created': job['created'],
                  'engine': 'Deterministic content adapters; no external AI', 'options': job['options'],
                  'inventory': job.get('inventory', {}), 'results': job['results'], 'warnings': job['warnings'],
                  'state': 'ready' if completed else job['state'], 'error': job.get('error', ''),
                  'note': 'Converted books use the Lingua Books reader. Uploaded application code is not rebuilt or included.'}
        _write(_root(mid, 'report.json'), report)
        return report


def _export(mid):
    job = _load(mid)
    report = _report(mid, completed=True)
    target = _root(mid, 'export.zip')
    with zipfile.ZipFile(target + '.part', 'w', zipfile.ZIP_DEFLATED, compresslevel=3) as archive:
        archive.writestr('migration-report.json', json.dumps(report, ensure_ascii=False))
        for result in job['results']:
            _check_cancel(mid)
            bid = result['id']
            book = library.get(bid)
            manifest = {'id': bid, 'title': book['title'], 'pages': library._pages(book), 'language': book['lang']}
            archive.writestr(f'books/{bid}/book.json', json.dumps(manifest, ensure_ascii=False))
            for sub in ('pages', 'thumbs', 'text', 'migration-media'):
                directory = library.folder(bid, sub)
                if os.path.isdir(directory):
                    for name in sorted(os.listdir(directory), key=_natural):
                        _check_cancel(mid)
                        path = os.path.join(directory, name)
                        if os.path.isfile(path) and not name.endswith(('.tmp', '.part')):
                            archive.write(path, f'books/{bid}/{sub}/{name}')
            assets = library.folder(bid, 'migration-assets.json')
            if os.path.isfile(assets):
                archive.write(assets, f'books/{bid}/migration-assets.json')
    db.replace(target + '.part', target)


def artifact(mid, user, kind, name=None):
    if not user:
        raise MigrationError('Sign in to view migration files.', 401)
    with _lock:
        job = _load(mid, user)
        if kind == 'preview' and re.fullmatch(r'[0-9a-f]{24}-[1-5]\.webp', str(name)):
            path = _root(mid, 'preview', name)
        elif kind == 'report':
            _report(mid)
            path = _root(mid, 'report.json')
        elif kind == 'export' and job['state'] == 'ready':
            path = _root(mid, 'export.zip')
        else:
            raise MigrationError('This migration file is not available.', 404)
        if not os.path.isfile(path):
            raise MigrationError('This migration file is not available.', 404)
        return path

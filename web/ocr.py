"""Reads the words on page images (photos of pages, scanned PDFs), with the place of each word.

Two engines, the same result ({"w", "h", "lines": [{"words": [{"t", "x", "y", "w", "h"}]}]}, the
format web/tools/segment_text.py reads):
- Tesseract, when it is installed (on a Linux web host: apt install tesseract-ocr);
- else, on Windows, the OCR built into Windows (web/tools/ocr_windows.ps1).
"""
import csv
import io
import json
import os
import shutil
import subprocess
import tempfile

WEB = os.path.dirname(os.path.abspath(__file__))
WINDOWS_OCR = os.path.join(WEB, 'tools', 'ocr_windows.ps1')


class OcrError(Exception):
    pass


def engine():
    if shutil.which('tesseract'):
        return 'tesseract'
    if os.name == 'nt':
        return 'windows'
    return None


def read_pages(pngs):
    """Raw OCR of each image path (PNG), in order. One call for all pages (starting the
    engine takes a moment)."""
    which = engine()
    if which == 'tesseract':
        return [_tesseract(p) for p in pngs]
    if which == 'windows':
        return _windows(pngs)
    raise OcrError('No OCR engine: install Tesseract (on Linux: apt install tesseract-ocr).')


def _tesseract(png):
    r = subprocess.run(['tesseract', png, 'stdout', '-l', 'eng', '--psm', '3', 'tsv'],
                       capture_output=True, timeout=300)
    if r.returncode:
        raise OcrError(r.stderr.decode('utf-8', 'replace')[-300:] or 'Tesseract failed.')
    lines, size = {}, (0, 0)
    for row in csv.DictReader(io.StringIO(r.stdout.decode('utf-8', 'replace')), delimiter='\t', quoting=csv.QUOTE_NONE):
        if row['level'] == '1':
            size = (int(row['width']), int(row['height']))
        if row['level'] != '5' or not (row.get('text') or '').strip() or float(row['conf'] or -1) < 0:
            continue
        key = (int(row['block_num']), int(row['par_num']), int(row['line_num']))
        lines.setdefault(key, []).append({'t': row['text'].strip(), 'x': int(row['left']), 'y': int(row['top']),
                                          'w': int(row['width']), 'h': int(row['height'])})
    return {'w': size[0], 'h': size[1], 'angle': 0, 'lines': [{'words': ws} for _, ws in sorted(lines.items())]}


def _windows(pngs):
    with tempfile.TemporaryDirectory() as tmp:
        src, out = os.path.join(tmp, 'in'), os.path.join(tmp, 'out')
        os.makedirs(src)
        for i, p in enumerate(pngs):
            shutil.copy(p, os.path.join(src, f'{i:04d}.png'))
        r = subprocess.run(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WINDOWS_OCR,
                            '-InputDir', src, '-OutputDir', out, '-Force'], capture_output=True, timeout=1800)
        if r.returncode:
            raise OcrError((r.stderr or r.stdout).decode('utf-8', 'replace')[-300:] or 'Windows OCR failed.')
        pages = []
        for i in range(len(pngs)):
            f = os.path.join(out, f'{i:04d}.json')
            if not os.path.exists(f):
                raise OcrError('Windows OCR could not read a page.')
            with open(f, encoding='utf-8-sig') as fh:
                pages.append(json.load(fh))
        return pages

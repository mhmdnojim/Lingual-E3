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
import re
import shutil
import subprocess
import threading

import db

WEB = os.path.dirname(os.path.abspath(__file__))
WINDOWS_OCR = os.path.join(WEB, 'tools', 'ocr_windows.ps1')
# Letters of another writing than the Latin alphabet (Chinese, Arabic, Korean …).
OTHER_SCRIPT = re.compile(r'[^\W\d_\u0000-ɏḀ-ỿ]')
# An English word as English OCR reads it: small letters after the first (not "EIQ"), with the
# brackets and punctuation around it ("(indicating", "happens)", "time;").
ENGLISH_WORD = re.compile(r"[(\[“‘\"']?[A-Za-z][a-z]+(?:['’][a-z]+)?[)\]”’\"'.,;:!?]*")


class OcrError(Exception):
    pass


def engine():
    if shutil.which('tesseract'):
        return 'tesseract'
    if os.name == 'nt':
        return 'windows'
    return None


# The page languages of the books people add: (name, Tesseract's name, Windows' language tags).
LANGUAGES = {
    'en': ('English', 'eng', ('en-US', 'en')),
    'zh-Hans': ('Chinese (Simplified)', 'chi_sim', ('zh-CN', 'zh-Hans', 'zh-SG')),
    'zh-Hant': ('Chinese (Traditional)', 'chi_tra', ('zh-TW', 'zh-Hant', 'zh-HK', 'zh-MO')),
    'es': ('Spanish', 'spa', ('es-ES', 'es')),
    'fr': ('French', 'fra', ('fr-FR', 'fr')),
    'de': ('German', 'deu', ('de-DE', 'de')),
    'ja': ('Japanese', 'jpn', ('ja-JP', 'ja')),
    'ko': ('Korean', 'kor', ('ko-KR', 'ko')),
    'ar': ('Arabic', 'ara', ('ar-SA', 'ar')),
}
_installed = None
_windows_ocr_lock = threading.Lock()


def installed(again=False):
    """{page language: the name the engine knows it by} for the languages it can read here
    (Windows: the languages added with "Optical character recognition"). Asked once (again:
    ask again, e.g. after a language was added)."""
    global _installed
    if _installed is None or again:
        found = {}
        try:
            if engine() == 'tesseract':
                r = subprocess.run(['tesseract', '--list-langs'], capture_output=True, timeout=30)
                have = set(r.stdout.decode('utf-8', 'replace').split())
                found = {k: code for k, (_, code, _) in LANGUAGES.items() if code in have}
            elif engine() == 'windows':
                r = subprocess.run(['powershell', '-NoProfile', '-Command',
                                    '$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]; '
                                    '[Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag }'],
                                   capture_output=True, timeout=60)
                tags = r.stdout.decode('utf-8', 'replace').split()
                for k, (_, _, names) in LANGUAGES.items():
                    tag = next((t for t in tags for n in names if t.lower() == n.lower() or t.lower().startswith(n.lower() + '-')), None)
                    if tag:
                        found[k] = tag
        except (OSError, subprocess.SubprocessError):
            pass
        _installed = found
    return _installed


def passes(language, english=False):
    """The languages read_pages reads one after the other (Windows: English in a pass of its own)."""
    if engine() == 'tesseract' or not english or language == 'en' or 'en' not in installed():
        return [language]
    return [language, 'en']


def read_pages(pngs, language='en', english=False, progress=None):
    """Raw OCR of each image path (PNG), in order. One call for all pages (starting the
    engine takes a moment). english: the pages also have English (read by OCR made for it too).
    progress(k): pass k of passes() starts."""
    progress = progress or (lambda k: None)
    which = engine()
    if language not in LANGUAGES:
        raise OcrError('Choose a supported page language before reading this file.')
    if not which:
        raise OcrError('No OCR engine: install Tesseract (on Linux: apt install tesseract-ocr).')
    name, code, _ = LANGUAGES[language]
    if language not in installed() and language not in installed(again=True):
        if which == 'windows':
            raise OcrError(f'This computer cannot read {name} from pictures yet. In the Windows Settings: Time & language → '
                           f'Language & region → Add a language: {name}, with “Optical character recognition”. Then try again.')
        raise OcrError(f"The server cannot read {name} from pictures yet: install Tesseract's language {code} "
                       f"(apt install tesseract-ocr-{code.replace('_', '-')}).")
    if which == 'tesseract':
        if (english or language in ('zh-Hans', 'zh-Hant', 'ja', 'ko')) and language != 'en' and 'en' in installed():
            code += '+eng'  # pinyin, romaji and English words in these books
        progress(0)
        return [_tesseract(p, code) for p in pngs]
    # (Windows' Chinese reads Latin letters too, but not the tone marks of pinyin well: ǎ -> ä; and
    # English much worse than English OCR, so with English on the pages both read them.)
    progress(0)
    pages = _windows(pngs, installed()[language])
    if len(passes(language, english)) == 1:
        return pages
    progress(1)
    return [_merge_ocr_docs(main, en) for main, en in zip(pages, _windows(pngs, installed()['en']))]


def _tesseract(png, language='eng'):
    r = subprocess.run(['tesseract', png, 'stdout', '-l', language, '--psm', '3', 'tsv'],
                       capture_output=True, timeout=300)
    if r.returncode:
        message = r.stderr.decode('utf-8', 'replace')[-300:] or 'Tesseract failed.'
        if 'Failed loading language' in message or 'Error opening data file' in message:
            raise OcrError(f"The OCR language pack '{language}' is not installed in Tesseract.")
        raise OcrError(message)
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


def _windows(pngs, language='en-US'):
    # Reuse a private work folder. Windows can keep OCR image handles open after the subprocess
    # exits, which makes TemporaryDirectory cleanup fail in sandboxed installs.
    os.makedirs(db.DATA, exist_ok=True)
    tmp = os.path.join(db.DATA, 'ocr-work')
    src, out = os.path.join(tmp, 'in'), os.path.join(tmp, 'out')
    with _windows_ocr_lock:
        os.makedirs(src, exist_ok=True)
        os.makedirs(out, exist_ok=True)
        for i, p in enumerate(pngs):
            shutil.copy(p, os.path.join(src, f'{i:04d}.png'))
        r = subprocess.run(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WINDOWS_OCR,
                            '-InputDir', src, '-OutputDir', out, '-Language', language, '-Force'],
                           capture_output=True, timeout=1800)
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


def overlap(a, b):
    """How much two word boxes overlap: 0 (not) to 1 (the smaller one is inside the other)."""
    w = min(a['x'] + a['w'], b['x'] + b['w']) - max(a['x'], b['x'])
    h = min(a['y'] + a['h'], b['y'] + b['h']) - max(a['y'], b['y'])
    return 0 if w <= 0 or h <= 0 else w * h / max(1, min(a['w'] * a['h'], b['w'] * b['h']))


def _merge_ocr_docs(primary, secondary):
    """The OCR of the main language (primary) with the English OCR (secondary), each for its own
    writing: English OCR reads English much better ("doing", not "d0ing"). Its words in Latin
    letters replace those of the main OCR, except over the main language's own writing (Chinese
    characters …); the main OCR's other words stay where English OCR read nothing. English words
    right next to a line of the main OCR ("A:" before "你好") join that line; others (another
    column) stay lines of their own."""
    def box(words):
        return (min(w['x'] for w in words), min(w['y'] for w in words),
                max(w['x'] + w['w'] for w in words), max(w['y'] + w['h'] for w in words))

    words1 = [w for ln in primary.get('lines', []) for w in ln.get('words', [])]
    own = [w for w in words1 if OTHER_SCRIPT.search(w['t'])]
    # Letters with marks (pinyin: "hěn", as OCR reads it "hén", "shåO") stay as the main OCR read
    # them: English OCR drops the marks, and they tell pinyin from English.
    marked = [w for w in words1 if not OTHER_SCRIPT.search(w['t']) and any(ch.isalpha() and not ch.isascii() for ch in w['t'])]
    letters = [w for w in words1 if w not in own and w not in marked and re.search('[A-Za-z]', w['t'])]

    # The main OCR reads one character a word: one with letters or signs in it is a misreading
    # (italic English as "口褶e磊@“").
    jumbled = [w for w in own if len(w['t']) > 1 and re.search('[一-鿿]', w['t']) and re.search(r'[A-Za-z@#$%&*|]', w['t'])]

    def english_writing(e):  # italic English the main OCR read partly as its own writing ("which": "w 勖")
        return bool(ENGLISH_WORD.fullmatch(e['t'])) and any(overlap(e, w) > 0.3 for w in letters + jumbled)

    def boxed(e, line):  # a short word of a line of English the main OCR read as a box ("to indicate a": "口")
        return (bool(re.fullmatch(r'[a-z]{1,3}[.,;:!?]?', e['t'])) and sum(bool(ENGLISH_WORD.fullmatch(w['t'])) for w in line) >= 2
                and all(o['t'] == '口' for o in own if overlap(e, o) > 0.3))
    latin = [[w for w in ln.get('words', []) if re.search('[A-Za-z0-9]', w['t']) and not any(overlap(w, m) > 0.3 for m in marked)
              and (english_writing(w) or boxed(w, ln.get('words', [])) or not any(overlap(w, o) > 0.3 for o in own))]
             for ln in secondary.get('lines', [])]
    english = [w for ln in latin for w in ln]
    over = [e for e in english if any(overlap(e, o) > 0.3 for o in own)]  # (what it was taken for goes)
    spans = [dict(zip('xywh', (x0, y0, x1 - x0, y1 - y0))) for x0, y0, x1, y1 in (box(ln) for ln in latin if ln)]
    lines = []
    for ln in primary.get('lines', []):
        # Its own writing and marked letters stay; other letters where English OCR read none; digits
        # and punctuation not inside an English line (English OCR reads its own: "B:", not "B:：").
        words = [w for w in ln.get('words', []) if (OTHER_SCRIPT.search(w['t']) and not any(overlap(w, e) > 0.3 for e in over)) or w in marked
                 or (not OTHER_SCRIPT.search(w['t']) and (not any(overlap(w, e) > 0.3 for e in english) if re.search('[A-Za-z]', w['t'])
                     else not any(overlap(w, s) > 0.5 for s in spans)))]
        if words:
            lines.append({'words': words})

    def next_to(a, b):  # on the same line, touching or a little apart
        ax0, ay0, ax1, ay1 = box(a)
        bx0, by0, bx1, by1 = box(b)
        h = min(ay1 - ay0, by1 - by0)
        return min(ay1, by1) - max(ay0, by0) >= 0.5 * h and max(ax0 - bx1, bx0 - ax1) <= 1.5 * h
    for words in filter(None, latin):
        same = next((ln for ln in lines if next_to(words, ln['words'])), None)
        if same:
            same['words'] = sorted(same['words'] + words, key=lambda w: w['x'])
        else:
            lines.append({'words': words})
    lines.sort(key=lambda line: box(line['words'])[1])
    return {'w': primary.get('w', secondary.get('w', 0)), 'h': primary.get('h', secondary.get('h', 0)),
            'angle': primary.get('angle', 0), 'lines': lines}

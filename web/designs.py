"""Lingua Books: the designs of a book's pages (web/library.py uses them).

A textbook repeats a few designs of page: in every unit the same page of dialogues with their new
words beside them, the same page of grammar, of exercises … When a PDF or photos are added, the
app draws every page small and groups the pages that look alike (where their ink and colours
are): the designs. One page of each design is read, its example: the pieces of text read on it
become the design's areas (frames), numbered in the order they are read. The owner changes them
for the whole design: what is in each area (text, a dialogue, a list of new words, or nothing to
read), their order, new ones; and which pages have which design. Then every page is read area by
area, in their order. The words outside every area go with the nearest one (a page's dialogue may
be a little longer than its example's): what is not in an area to leave out is not lost.

In the book's folder: designs.json, and designs/<n>.webp (the pages drawn small; <n>-big.webp
bigger, when the owner looks at one).
"""
import heapq
import json
import os
import re
import secrets
import statistics
from operator import sub

from PIL import Image, ImageOps

KINDS = ('text', 'paragraph', 'heading', 'rows', 'dialogue', 'words', 'skip')
SMALL_W = 360        # the pages are drawn this wide to compare them (and to show them to the owner)
GRID = (16, 22)      # and compared on this many cells across and down
FOUND = 8            # designs found at most (the owner can make more)
MOST = 16            # designs at most
MOST_AREAS = 200     # dense exercise/script pages need more than forty paragraphs
# The name of a speaker at the start of a line of a dialogue: "A:", "王方：", "Wang Fang:".
NAME = r"[A-Z][a-zà-ÿāáǎēéěīíǐōóǒūúǔǖǘǚǜ']*"
SPEAKER = re.compile(rf'(?:[A-Z]|[一-鿿]{{1,4}}|{NAME}(?: {NAME})?) ?[:：]\s*')
CJK = re.compile('[぀-ヿ㐀-鿿豈-﫿가-힯]')
# The heading of a list of new words (its first line).
LIST_HEADING = re.compile(r'生\s*词|词\s*语|单\s*词|new\s+words|vocabulary|word\s+list', re.I)


# ---------------------------------------------------------------- Finding the designs

def signature(img):
    """What is compared of a page drawn small: its ink and its colour on a grid, a flat list of
    each for each of the 3 shifts compared (a left and a right page: the margins move a little)."""
    gw, gh = GRID
    ink = list(ImageOps.grayscale(img).point(lambda p: 255 - p).resize(GRID, Image.BOX).tobytes())
    colour = list(img.convert('HSV').getchannel('S').resize(GRID, Image.BOX).tobytes())

    def cut(cells, x0, x1):
        return [cells[y * gw + x] for y in range(gh) for x in range(x0, x1)]
    return {dx: (cut(ink, max(dx, 0), gw + min(dx, 0)) + cut(colour, max(dx, 0), gw + min(dx, 0)),
                 cut(ink, max(-dx, 0), gw + min(-dx, 0)) + cut(colour, max(-dx, 0), gw + min(-dx, 0)))
            for dx in (-1, 0, 1)}


def apart(p, q):
    """How different two pages look (their signatures): per cell, the least of the 3 shifts."""
    return min(sum(map(abs, map(sub, p[dx][0], q[dx][1]))) * 2 / len(p[dx][0]) for dx in (-1, 0, 1))


def group(sigs, least, share=0.85, most=FOUND):
    """The pages (their signatures) in groups that look alike, the biggest first: the most alike
    pages and groups put together (by the average distance of their pages) until the groups of
    least pages or more have share of the pages, and are most at most; and as long as they are
    much more alike than two pages of the book are as a rule (half as far apart) — but never
    pages hardly more alike than that (0.85 as far apart: a book whose pages all look different,
    a magazine's, has few designs or none, not one of all its pages). Returns the groups ([[index,
    ...]]), the distances, and how far apart the pages of a group can be at most."""
    n = len(sigs)
    d = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(i + 1, n):
            d[i][j] = d[j][i] = apart(sigs[i], sigs[j])
    groups = {i: [i] for i in range(n)}
    between = {i: {j: d[i][j] for j in range(n) if j != i} for i in range(n)}
    heap = [(d[i][j], i, j) for i in range(n) for j in range(i + 1, n)]
    usual = statistics.median([x for x, _, _ in heap]) if heap else 0
    alike, most_apart = 0.5 * usual, 0.85 * usual if n > 8 else float('inf')  # (a few pages: too few to say what is usual)
    heapq.heapify(heap)
    new, last = n, 0.0

    def enough():
        big = [g for g in groups.values() if len(g) >= least]
        return sum(map(len, big)) >= share * n and len(big) <= most
    while heap:
        dist, i, j = heap[0]
        if i not in groups or j not in groups:  # (one of them is in a bigger group now)
            heapq.heappop(heap)
            continue
        if dist > alike and enough() or dist > most_apart:
            break
        last = heapq.heappop(heap)[0]
        gi, gj = groups.pop(i), groups.pop(j)
        bi, bj = between.pop(i), between.pop(j)
        between[new] = {}
        for k in groups:  # (the average distance of the pages of the two groups)
            dk = (len(gi) * bi[k] + len(gj) * bj[k]) / (len(gi) + len(gj))
            between[new][k] = between[k][new] = dk
            del between[k][i], between[k][j]
            heapq.heappush(heap, (dk, k, new))
        groups[new] = gi + gj
        new += 1
    return sorted(groups.values(), key=len, reverse=True), d, min(1.25 * last, most_apart)


def find(numbers, sigs):
    """The designs of these pages (their numbers, and their signatures): [{'pages', 'example',
    'areas': None (not read yet)}] in the order of the book, and the other pages (like none).
    A design has a few of the pages at least (two; of a book of one page, that one); the designs
    have most pages of the book (books look alike in different measure: so many, not how alike)."""
    if not numbers:
        return [], []
    least = 1 if len(numbers) == 1 else max(2, round(0.03 * len(numbers)))
    groups, d, near_enough = group(sigs, least)
    kept = [g for g in groups if len(g) >= least][:FOUND]
    taken = {i for g in kept for i in g}
    other = []
    for i in range(len(numbers)):  # the pages of the small groups: with the most alike design, if near
        if i in taken:
            continue
        near = min(kept, key=lambda g: sum(d[i][j] for j in g) / len(g), default=None)
        if near and sum(d[i][j] for j in near) / len(near) <= near_enough:
            near.append(i)
        else:
            other.append(numbers[i])
    out = []
    for g in kept:
        example = min(g, key=lambda a: sum(d[a][b] for b in g))  # (the most like the others)
        out.append({'pages': sorted(numbers[i] for i in g), 'example': numbers[example], 'areas': None})
    out.sort(key=lambda x: x['pages'][0])
    return out, sorted(other)


# ---------------------------------------------------------------- The areas of a design

def _box(ws):
    return [min(w[0] for w in ws), min(w[1] for w in ws), max(w[0] + w[2] for w in ws), max(w[1] + w[3] for w in ws)]


def _start(tokens):
    """The text of the first words of a line, and where each is in it: a space between them, not
    between characters of Chinese (Japanese, Korean) or before a colon."""
    text, spans = '', []
    for t in tokens[:5]:
        if text and not (CJK.match(t[:1]) and CJK.match(text[-1])) and t[:1] not in ':：':
            text += ' '
        spans.append((len(text), len(text) + len(t)))
        text += t
    return text, spans


def speaking(tokens):
    """A line (its words) starts with a speaker's name ("A:", "王方：")."""
    return SPEAKER.match(_start(tokens)[0]) is not None


def proposed(doc, w, h, lists=(), raw=None):
    """The areas of a page from what the app read on it (doc; lists: the boxes of its lists of new
    words; raw: all the lines of words found on it, also those left out, as pinyin): each list one;
    paragraphs one under the other, close together, one (lines left out between them, as the
    pinyin over a dialogue's lines, join them too); pieces of fewer than 3 characters none (their
    words go with the nearest area). A list's kind is 'words' (also one under a heading "New
    Words", "生词" …), a dialogue's 'dialogue' (two lines start with a speaker's name), else
    'text'. In the order they are read: [{'x', 'y', 'w', 'h' (parts of the page), 'kind'}]."""
    words, found = doc['words'], []
    spans = [(min(x['y'] for x in ln['words']), max(x['y'] + x['h'] for x in ln['words']),
              min(x['x'] for x in ln['words']), max(x['x'] + x['w'] for x in ln['words']))
             for ln in (raw or {}).get('lines', []) if ln['words']]

    def empty(A, B):
        """The tallest stretch with no line between boxes A and B, one under the other, in their column."""
        top, bottom = min(A[3], B[3]), max(A[1], B[1])
        x0, x1 = max(A[0], B[0]), min(A[2], B[2])
        at, most = top, 0
        for a, b in sorted((a, b) for a, b, c, d in spans if a < bottom and b > top and min(d, x1) > max(c, x0)):
            most, at = max(most, a - at), max(at, b)
        return max(most, bottom - at)
    for k, (sa, sb) in enumerate(doc['blocks']):
        if sa >= sb:
            continue
        ws = words[doc['sent'][sa][0]:doc['sent'][sb - 1][1]]
        if ws:
            hs = sorted(x[3] for x in ws)
            found.append({'box': _box(ws), 'lh': hs[len(hs) // 2], 'first': k, 'kind': 'text', 'words': ws})
    for lb in lists:  # a list of new words: one area (each row of it was a paragraph)
        mid = lambda f: ((f['box'][0] + f['box'][2]) / 2, (f['box'][1] + f['box'][3]) / 2)  # noqa: E731
        rows = [f for f in found if lb[0] - 4 <= mid(f)[0] <= lb[2] + 4 and lb[1] - 4 <= mid(f)[1] <= lb[3] + 4]
        if rows:
            found = [f for f in found if f not in rows]
            found.append({'box': [min(f['box'][i] for f in rows) if i < 2 else max(f['box'][i] for f in rows) for i in range(4)],
                          'lh': min(f['lh'] for f in rows), 'first': min(f['first'] for f in rows), 'kind': 'words',
                          'words': [x for f in rows for x in f['words']]})
    merged = True
    while merged:  # paragraphs one under the other, close together
        merged = False
        for a in found:
            for b in found:
                if a is b or 'words' in (a['kind'], b['kind']):
                    continue
                A, B = a['box'], b['box']
                across = min(A[2], B[2]) - max(A[0], B[0])
                if across >= 0.5 * min(A[2] - A[0], B[2] - B[0]) and empty(A, B) <= 1.6 * max(a['lh'], b['lh']):
                    a['box'] = [min(A[0], B[0]), min(A[1], B[1]), max(A[2], B[2]), max(A[3], B[3])]
                    a['lh'], a['first'], a['words'] = max(a['lh'], b['lh']), min(a['first'], b['first']), a['words'] + b['words']
                    found.remove(b)
                    merged = True
                    break
            if merged:
                break
    out = []
    for f in sorted(found, key=lambda f: f['first']):
        if f['kind'] == 'text' and sum(len(x[4]) for x in f['words']) < 3:
            continue
        if f['kind'] == 'text':
            lines = {}
            for x in f['words']:
                lines.setdefault(x[5], []).append(x)
            first = ' '.join(x[4] for x in min(lines.values(), key=lambda ws: min(x[1] for x in ws)))
            if LIST_HEADING.search(first):
                f['kind'] = 'words'
            elif sum(speaking([x[4] for x in ws]) for ws in lines.values()) >= 2:  # a dialogue: two lines at least
                f['kind'] = 'dialogue'
        pad = 0.35 * f['lh']
        x0, y0 = max(0, f['box'][0] - pad), max(0, f['box'][1] - pad)
        x1, y1 = min(w, f['box'][2] + pad), min(h, f['box'][3] + pad)
        out.append({'x': round(x0 / w, 4), 'y': round(y0 / h, 4), 'w': round((x1 - x0) / w, 4), 'h': round((y1 - y0) / h, 4),
                    'kind': f['kind']})
    return out[:MOST_AREAS]


def layout_lines(raw, image=None):
    """Separate repeated column gutters before any paragraph grouping.

    Keep fill-in blanks intact and reconnect a dropped capital to its first word.
    This local pass preserves source words; models can later supply richer regions.
    """
    from segment_text import _blank_under, _reading_order
    lines = [{**ln, 'words': [dict(w) for w in ln['words']]} for ln in raw['lines'] if ln['words']]
    all_words = [w for ln in lines for w in ln['words']]
    if not all_words:
        return {**raw, 'lines': []}
    unit = statistics.median(w['h'] for w in all_words)
    gray = image.convert('L') if image is not None else None
    # A drop cap overlaps several lines vertically; attach it to the top line only.
    for ln in list(lines):
        if len(ln['words']) != 1:
            continue
        cap = ln['words'][0]
        if not re.fullmatch('[A-Z]', cap['t']) or cap['h'] < 1.8 * unit:
            continue
        candidates = []
        for other in lines:
            if other is ln or not other['words']:
                continue
            first = min(other['words'], key=lambda w: w['x'])
            if (0 <= first['x'] - (cap['x'] + cap['w']) <= 1.5 * unit
                    and abs(first['y'] - cap['y']) <= unit and re.match('[a-z]', first['t'])):
                candidates.append((first['y'], other, first))
        if candidates:
            _, other, first = min(candidates, key=lambda item: item[0])
            right = first['x'] + first['w']
            first.update(t=cap['t'] + first['t'], x=cap['x'], w=right - cap['x'])
            lines.remove(ln)
    # Some OCR engines return an entire vertical 1/2/3 label strip as one line.
    # Restore its physical rows so numeric-label filtering does not read it as prose.
    expanded = []
    for ln in lines:
        ws = sorted(ln['words'], key=lambda w: w['y'])
        numeric = len(ws) >= 3 and all(re.fullmatch(r'\d{1,2}[.)]?', w['t']) for w in ws)
        values = [int(re.sub(r'\D', '', w['t'])) for w in ws] if numeric else []
        if (numeric and all(b == a + 1 for a, b in zip(values, values[1:]))
                and max(w['x'] for w in ws) - min(w['x'] for w in ws) <= unit
                and ws[-1]['y'] - ws[0]['y'] >= 2 * unit):
            expanded.extend({**ln, 'words': [w]} for w in ws)
        else:
            expanded.append(ln)
    lines = expanded
    gaps = []
    for i, ln in enumerate(lines):
        ws = sorted(ln['words'], key=lambda w: w['x'])
        for left, right in zip(ws, ws[1:]):
            x0, x1 = left['x'] + left['w'], right['x']
            if x1 - x0 < 3 * unit or not 0.2 * raw['w'] < (x0 + x1) / 2 < 0.8 * raw['w']:
                continue
            if gray is not None and _blank_under(gray, x0, x1, min(left['y'], right['y']),
                                                 max(left['y'] + left['h'], right['y'] + right['h']), unit):
                continue
            gaps.append((i, x0, x1, left['y']))
    gutters = []
    for _, x0, x1, _ in gaps:
        x = (x0 + x1) / 2
        nearby = [(i, y) for i, a, b, y in gaps if a < x < b]
        if len({i for i, _ in nearby}) >= 4 and max(y for _, y in nearby) - min(y for _, y in nearby) >= 4 * unit:
            gutters.append(x)
    if not gutters:
        return {**raw, 'lines': lines}
    out = []
    valid = {(i, x0, x1) for i, x0, x1, _ in gaps if any(x0 < x < x1 for x in gutters)}
    for i, ln in enumerate(lines):
        ws = sorted(ln['words'], key=lambda w: w['x'])
        part = []
        for k, word in enumerate(ws):
            if k and (i, ws[k - 1]['x'] + ws[k - 1]['w'], word['x']) in valid:
                out.append({**ln, 'words': part}); part = []
            part.append(word)
        if part:
            out.append({**ln, 'words': part})
    return {**raw, 'lines': _reading_order(out)}


def paragraph_areas(doc, w, h):
    """One outline per paragraph, without merging neighbouring blocks into a template."""
    areas = []
    for sa, sb in doc['blocks']:
        if sa >= sb:
            continue
        ws = doc['words'][doc['sent'][sa][0]:doc['sent'][sb - 1][1]]
        if not ws:
            continue
        x0, y0, x1, y1 = _box(ws)
        pad = max(2, statistics.median(word[3] for word in ws) * 0.15)
        x0, y0 = max(0, x0 - pad), max(0, y0 - pad)
        x1, y1 = min(w, x1 + pad), min(h, y1 + pad)
        areas.append({'x': x0 / w, 'y': y0 / h, 'w': (x1 - x0) / w, 'h': (y1 - y0) / h, 'kind': 'paragraph'})
    return areas[:MOST_AREAS]


# ---------------------------------------------------------------- Reading a page by its areas

def parts(raw, areas):
    """The words of a page (raw: its lines of words, and its size w, h) by its areas: [(area, raw
    of the words in it)] for each area to read that has words, in their order. A word goes in the
    area its middle is in (the smallest, in one drawn in another), else in the nearest one; the
    words of an area to leave out go."""
    if not areas:
        return []
    strict = any(a.get('strict') for a in areas)
    W, H = raw['w'], raw['h']
    rects = [(a['x'] * W, a['y'] * H, (a['x'] + a['w']) * W, (a['y'] + a['h']) * H) for a in areas]
    lines = {k: [] for k in range(len(areas))}
    for ln in raw['lines']:
        mine = {}
        for w in ln['words']:
            cx, cy = w['x'] + w['w'] / 2, w['y'] + w['h'] / 2
            inside = [k for k, r in enumerate(rects) if r[0] <= cx <= r[2] and r[1] <= cy <= r[3]]
            if inside:
                k = min(inside, key=lambda k: (rects[k][2] - rects[k][0]) * (rects[k][3] - rects[k][1]))
            elif strict:
                continue  # reviewed page: deleting an outline excludes its words
            else:
                k = min(range(len(rects)), key=lambda k: max(rects[k][0] - cx, 0, cx - rects[k][2]) ** 2
                        + max(rects[k][1] - cy, 0, cy - rects[k][3]) ** 2)
            mine.setdefault(k, []).append(w)
        for k, ws in mine.items():
            lines[k].append({**ln, 'words': ws})
    return [(areas[k], {**raw, 'lines': lines[k]}) for k in range(len(areas)) if areas[k]['kind'] != 'skip' and lines[k]]


def without_speakers(lines):
    """The lines of a dialogue without the names of the speakers at their start ("A:", "王方：",
    "Wang Fang:"; as OCR read them, also "A :" or "王方：你好" in one word)."""
    out = []
    for ln in lines:
        ws = ln['words']
        text, spans = _start([w['t'] for w in ws])
        m = SPEAKER.match(text)
        if not m:
            out.append(ln)
            continue
        kept = []
        for k, w in enumerate(ws):
            a, b = spans[k] if k < len(spans) else (len(text) + 1, len(text) + 1)
            if b <= m.end():
                continue
            if a < m.end():  # the name and the first words in one: only the words
                cut = m.end() - a
                part = w['w'] * cut / max(1, len(w['t']))
                w = {**w, 't': w['t'][cut:], 'x': w['x'] + part, 'w': max(1, w['w'] - part)}
            kept.append(w)
        if kept:
            out.append({**ln, 'words': kept})
    return out


def join(docs):
    """One page's text document of the documents of its areas, one after the other."""
    words, sents, clauses, blocks = [], [], [], []
    for d in docs:
        wa, sa, la = len(words), len(sents), 1 + max((w[5] for w in words), default=-1)
        words += [w[:5] + [w[5] + la] + w[6:] for w in d['words']]
        sents += [[a + wa, b + wa] for a, b in d['sent']]
        clauses += [[a + wa, b + wa] for a, b in d.get('clause', [])]
        blocks += [[a + sa, b + sa] for a, b in d['blocks']]
    return {'words': words, 'sent': sents, 'clause': clauses, 'blocks': blocks}


# ---------------------------------------------------------------- Kept, and changed by the owner

def load(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def save(path, saved):
    saved['token'] = secrets.token_hex(6)  # (a new address for the pictures seen with them)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(saved, f, ensure_ascii=False)
    os.replace(tmp, path)
    return saved


def plan(saved):
    """{page number: the areas of its design} (pages without areas: read whole, as the app finds
    them). Only once the owner has checked the designs ('checked': saved them): the areas of an
    example page, laid on the other pages of its design, can cut them wrongly (pages of a
    magazine-like book that only look alike), so the app does not use them by itself."""
    out = {}
    if not (saved or {}).get('checked'):
        return out
    for d in saved.get('designs', []):
        for n in d['pages']:
            out[n] = d['areas'] or None
    for n, areas in saved.get('pageAreas', {}).items():
        # [] is deliberate: a reviewed page with no readable paragraphs.
        out[int(n)] = [{**a, 'strict': True} for a in areas]
    return out


def clean_page_areas(raw, numbers):
    """Validate independent layouts without limiting a book to MOST designs."""
    if not isinstance(raw, dict) or len(raw) > len(numbers):
        raise ValueError('The page layouts are not right.')
    allowed, out = set(numbers), {}
    for key, areas in raw.items():
        if not isinstance(key, str) or not key.isdigit() or int(key) not in allowed or str(int(key)) != key:
            raise ValueError('A layout belongs to a page outside the selected range.')
        if not isinstance(areas, list) or len(areas) > MOST_AREAS:
            raise ValueError(f'A page can have at most {MOST_AREAS} areas.')
        out[key] = [_area(a) for a in areas]
    return out


def _area(a):
    if not isinstance(a, dict) or a.get('kind') not in KINDS:
        raise ValueError('An area is not right.')
    try:
        x, y, w, h = (min(1.0, max(0.0, float(a.get(k, 0)))) for k in ('x', 'y', 'w', 'h'))
    except (TypeError, ValueError):
        raise ValueError('An area is not right.')
    w, h = min(w, 1 - x), min(h, 1 - y)
    if w < 0.004 or h < 0.004:
        raise ValueError('An area is too small.')
    return {'x': round(x, 4), 'y': round(y, 4), 'w': round(w, 4), 'h': round(h, 4), 'kind': a['kind']}


def clean(designs, numbers):
    """The designs as the owner changed them, checked (ValueError if wrong): of these pages (their
    numbers), each page in one design at most; their example one of their pages; their areas
    (None: not read yet; []: none, the whole page is read). Returns (designs, other pages)."""
    if not isinstance(designs, list) or len(designs) > MOST:
        raise ValueError(f'There can be {MOST} designs at most.')
    have, seen, out = set(numbers), set(), []
    for d in designs:
        if not isinstance(d, dict) or not isinstance(d.get('pages'), list):
            raise ValueError('A design is not right.')
        pages = sorted({int(n) for n in d['pages'] if isinstance(n, (int, float)) and int(n) in have} - seen)
        if not pages:
            continue
        seen.update(pages)
        areas = d.get('areas')
        if areas is not None:
            if not isinstance(areas, list) or len(areas) > MOST_AREAS:
                raise ValueError(f'A design can have {MOST_AREAS} areas at most.')
            areas = [_area(a) for a in areas]
        example = d.get('example')
        out.append({'pages': pages, 'example': example if example in pages else pages[0], 'areas': areas})
    return out, sorted(have - seen)

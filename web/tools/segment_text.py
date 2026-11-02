"""Turn raw Windows OCR output into clickable text units.

Input:  web/_build/ocr_raw/<book>__<page>.json  (from ocr_windows.ps1)
Output: web/data/text/<book>/<page>.json
        {"words": [[x, y, w, h, text, line, space_after], ...],
         "sent":   [[first_word, end_word], ...],      # end is exclusive
         "clause": [[first_word, end_word], ...],
         "blocks": [[first_sent, end_sent], ...]}
        web/data/search/<book>.json  [{"p": "<page key>", "t": "<page text>"}, ...]

Lines are grouped into blocks (paragraphs / list items / headings) by geometry,
blocks are split into sentences at end punctuation, sentences into clauses at
commas, colons, dashes and conjunctions. A bullet (•) starts a list item of its own,
also one OCR did not read (found on the page picture, web/data/pages/<book>/<page>.webp).

Chinese, Japanese and Korean (books people add, web/library.py): every character is a word
of its own (punctuation stays with its character), without spaces between them; sentences
end at 。！？, clauses at ，、；：. Where the language changes between Chinese and English (a
Chinese heading and its English: "主谓谓语句 Sentences with a Subject-Predicate Phrase as the
Predicate"), the sentence ends too: each language a sentence of its own (language_parts).
"""
import argparse
import os
import re
import statistics
import sys
import unicodedata

from common import DATA, SHARED, load_json, save_json

# Raised when sentences are cut differently: the pages of the library's books made before get
# their sentences made again, once (web/library.py). 2: Chinese and English a sentence each.
# 3: in Chinese books, pinyin OCR misread left out, also between Chinese characters (library.py).
# 4: the choices of an exercise in a line a sentence each ("A 换房子 B 买空调": choice_starts).
# 5: in Chinese books, the names of a dialogue's speakers left out, and their pictures (library.py).
# 6: in Chinese books, the full stops OCR did not read put back, from the page pictures (missed_stops).
# 7: the speakers' names also with other words on their line, and their pictures read as characters.
SENTENCE_RULES = 7
ABBREV = {'mr.', 'mrs.', 'ms.', 'dr.', 'st.', 'vs.', 'etc.', 'e.g.', 'i.e.', 'p.', 'pp.',
          'a.m.', 'p.m.', 'no.', 'jr.', 'sr.', 'approx.', 'ex.', 'esp.', 'u.s.', 'u.k.'}
LIST_MARK = re.compile(r'^(\d{1,2}|[a-hA-H])[.)]?$')
CHOICE = re.compile(r'[（(_“"]?([A-Ha-h])[.)．）]?')  # the letter of a choice in an exercise: "A", "B.", "(C)" (OCR: "_C")
QUESTION = re.compile(r'[（(]\d{1,2}[)）]')  # the number of the next question: "(2)"
JOINING = {'and', 'or', 'nor', 'to', 'than', 'with', 'vs', 'but', 'from', '&', '+', '=', '/', '-', '—', '–', '和', '或', '跟', '与', '比'}  # "A and B": no choices (two letters)
BULLETS = {'•', '●', '■', '▪', '◆', '·'}
SENT_END = re.compile(r'([.!?]|\.\.\.|…)["\'”’)\]]*$')
CLAUSE_END = re.compile(r'[,;:，、；：]["\'”’)\]）」』]*$|[—–]$')
# Chinese (Japanese, Korean) characters, and their full-width punctuation.
CJK_CHARS = '぀-ヿ㐀-䶿一-鿿豈-﫿가-힯'
CJK = re.compile(f'[{CJK_CHARS}]')
CJK_OPEN, CJK_CLOSE = '（《〈「『【', '。，、；：！？）》〉」』】'
# One character with the brackets before it and the punctuation after it, a run of other
# letters (pinyin, English), or punctuation alone.
CJK_PIECE = re.compile(f'[{CJK_OPEN}]*(?:[{CJK_CHARS}]|[^{CJK_OPEN}{CJK_CLOSE}{CJK_CHARS}]+)[{CJK_CLOSE}]*'
                       f'|[{CJK_OPEN}{CJK_CLOSE}]+')
CJK_SENT_END = re.compile(r'[。！？]+[”’"\'）」』》]*$')
# Letters of another script than the Latin one (Chinese, Arabic, Korean …): such a line is text.
# (Accented Latin letters alone are not: "Täääåä" is what OCR makes of a picture.)
OTHER_SCRIPT = re.compile(r'[^\W\d_\u0000-ɏḀ-ỿ]')
DASHES = {'-', '—', '–'}
# Two languages in one sentence: quotation marks (around an example: Aspect Particle “着”), and
# pinyin with its tone marks (yào), which go with the text around them.
QUOTE_OPEN, QUOTE_CLOSE = '“‘「『《〈', '”’」』》〉'
PINYIN_MARK = re.compile('[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜĀÁǍÀĒÉĚÈĪÍǏÌŌÓǑÒŪÚǓÙǕǗǙǛ]')
# Words that usually start a new clause. Coordinators need longer pieces on
# both sides so "Rutledge and Adam" is not split.
SUBORDINATORS = {'because', 'although', 'though', 'while', 'whereas', 'unless', 'until',
                 'if', 'when', 'whenever', 'where', 'wherever', 'since', 'which', 'who',
                 'whom', 'whose', 'before', 'after'}
COORDINATORS = {'and', 'but', 'or', 'so', 'yet'}
# The part of speech after a word in a list of new words: "n.", "v.", "adj.", "m." (measure word),
# "suf." (suffix) …, also two ("v./n.").
PART_OF_SPEECH = re.compile(r'(?:(?:n|v|vt|vi|adj|adv|m|mw|num|nu|q|pron|prep|conj|part|pt|aux|int|interj|onom'
                            r'|suf|pref|det|cl|abbr|phr|pn|v\.?-?o)\.[/&,]?)+', re.I)


def clean_word(t):
    """Fix common OCR slips; return None for tokens that are just noise."""
    t = t.strip()
    # The audio-track icon is read as "@9)))", "@10))", "@12)" etc.
    if not t or ')))' in t or re.fullmatch(r'[@©®(]?\d{0,3}\){1,4}[.,]?', t):
        return None
    if not re.search(r'[A-Za-z0-9]', t) and not OTHER_SCRIPT.search(t):
        return t if t in DASHES or t in {'...', '…', '&', '?', '!', '=', '+', '/', '%'} else None
    return re.sub(r'^0(?=[A-Z]+\W*$)', 'O', t)  # "0K." -> "OK."


def is_cjk_punct(t):
    return bool(t) and all(ch in CJK_OPEN + CJK_CLOSE for ch in t)


def cjk_words(words):
    """Chinese (Japanese, Korean) words: one per character, its punctuation with it. A PDF gives
    whole runs ("我家有四口人。": split, the width shared out); OCR gives single characters and
    punctuation marks (put with the character next to them). Other words stay as they are."""
    out = []
    for w in words:
        t = w['t']
        if len(t) > 1 and CJK.search(t):
            pieces = CJK_PIECE.findall(t)
            weight = [sum(1 if CJK.match(ch) or is_cjk_punct(ch) else 0.55 for ch in p) for p in pieces]
            x, total = w['x'], sum(weight) or 1
            for p, k in zip(pieces, weight):
                if p.strip():
                    out.append({**w, 't': p.strip(), 'x': round(x), 'w': max(1, round(w['w'] * k / total))})
                x += w['w'] * k / total
        elif is_cjk_punct(t) and out and t[0] in CJK_CLOSE:  # "人" + "。" -> "人。"
            prev = out[-1]
            right = max(prev['x'] + prev['w'], w['x'] + w['w'])
            prev.update(t=prev['t'] + t, w=right - prev['x'])
        else:
            out.append(dict(w))
    # Opening brackets go with the next word: "（" + "ni" -> "（ni".
    merged = []
    for w in out:
        if merged and is_cjk_punct(merged[-1]['t']) and merged[-1]['t'][-1] in CJK_OPEN:
            o = merged.pop()
            w = {**w, 't': o['t'] + w['t'], 'x': o['x'], 'w': w['x'] + w['w'] - o['x']}
        merged.append(w)
    return merged


def no_space(a, b):
    """No space between two words of Chinese (Japanese, Korean) text."""
    return bool(a and b) and bool(CJK.match(a[-1]) or a[-1] in CJK_CLOSE) and bool(CJK.match(b[0]) or b[0] in CJK_OPEN)


def missed_bullet(gray, line):
    """The left edge of a bullet just before the line's first word that OCR did not read: a round
    or square dot in the middle of the line, with nothing between it and the word; or None.
    gray: the page picture in grey."""
    h, first = line['h'], line['words'][0]
    left, top = max(0, round(first['x'] - 1.8 * h)), max(0, round(line['y0']))
    right, bottom = round(first['x']), min(gray.height, round(line['y0'] + h))
    w, ht = right - left, bottom - top
    if w < 4 or ht < 4:
        return None
    px = gray.crop((left, top, right, bottom)).tobytes()
    order = sorted(px)
    if order[len(px) // 2] < 110:  # light print on a dark box
        ink = bytearray(p > order[len(px) // 10] + 70 for p in px)
    else:  # dark print on the paper (or a light box)
        ink = bytearray(p < order[len(px) * 9 // 10] - 70 for p in px)
    # The pieces of ink (connected pixels); the bullet is the one nearest the word.
    pieces, seen = [], bytearray(len(px))
    for start in range(len(px)):
        if not ink[start] or seen[start]:
            continue
        stack, seen[start], piece = [start], 1, []
        while stack:
            i = stack.pop()
            piece.append(i)
            y, x = divmod(i, w)
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if 0 <= y + dy < ht and 0 <= x + dx < w:
                        j = i + dy * w + dx
                        if ink[j] and not seen[j]:
                            seen[j] = 1
                            stack.append(j)
        if len(piece) >= 3:
            xs, ys = [i % w for i in piece], [i // w for i in piece]
            pieces.append((min(xs), min(ys), max(xs), max(ys), xs, ys))
    if not pieces:
        return None
    pieces.sort(key=lambda p: p[2])
    x0, y0, x1, y1, xs, ys = pieces[-1]
    if any(p[2] >= x0 - 0.3 * h for p in pieces[:-1]):  # ink right next to it: the end of a word, not a bullet
        return None
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    if not (0.18 * h <= bw <= 0.55 * h and 0.18 * h <= bh <= 0.55 * h and 0.75 <= bw / bh <= 1.3):
        return None
    if len(xs) < 0.6 * bw * bh or x0 == 0 or y0 == 0 or y1 == ht - 1:  # not filled, or part of something bigger
        return None
    if not 0.2 * h <= (y0 + y1) / 2 <= 0.8 * h or w - 1 - x1 < 0.1 * h:  # not in the middle, or touching the word
        return None
    # Solid: each row and column of it one stretch of ink (a letter has holes and legs: a, e, B, n).
    rows, cols = {}, {}
    for x, y in zip(xs, ys):
        rows.setdefault(y, []).append(x)
        cols.setdefault(x, []).append(y)
    if any(max(v) - min(v) + 1 > len(v) for v in (*rows.values(), *cols.values())):
        return None
    return left + x0


def missed_stops(gray, words):
    """A line of Chinese (words: a character each, its punctuation with it) with the full stops OCR
    did not read, found on the page picture (gray): each character takes a cell of the same width,
    and so does a stop: a small ring low in an empty cell after a character, between it and the
    next word or at the end of the line ("搬家 我明天" -> "搬家。我明天"). A "0" or "o" OCR read
    for one (small and low, right after a character) becomes one too. Returns the words."""
    chars = [w for w in words if CJK.fullmatch(w['t'])]
    if not chars:
        return words
    s = sorted(max(w['w'], w['h']) for w in chars)[len(chars) // 2]  # (a character's size)
    steps = sorted(b['x'] - a['x'] for a, b in zip(words, words[1:]) if CJK.fullmatch(a['t']) and CJK.fullmatch(b['t'])
                   and b['x'] - a['x'] < 1.5 * s)
    pitch = steps[len(steps) // 2] if steps else 1.12 * s  # (from one character to the next)
    top = sorted(w['y'] + w['h'] / 2 for w in chars)[len(chars) // 2] - s / 2  # (the line's characters)
    out = []
    for k, w in enumerate(words):
        nxt = words[k + 1] if k + 1 < len(words) else None
        last = out[-1] if out else None
        if last and re.fullmatch('[0oO°]', w['t']) and CJK.fullmatch(last['t'][-1]) and max(w['w'], w['h']) < 0.5 * s \
                and w['y'] > top + 0.4 * s and w['x'] - (last['x'] + last['w']) < 0.6 * s:
            out[-1] = {**last, 't': last['t'] + '。', 'w': w['x'] + w['w'] - last['x']}  # (OCR's "0" for a stop)
            continue
        out.append(w)
        if not CJK.fullmatch(w['t'][-1]):  # (punctuation read already)
            continue
        right = w['x'] + w['w']
        if nxt is None:
            end = w['x'] + 2 * pitch  # (the cell after the last character)
        elif (nxt['x'] - w['x'] >= 1.7 * pitch) if CJK.match(nxt['t']) else (nxt['x'] - right >= 0.7 * s):
            end = nxt['x']  # (an empty cell between)
        else:
            continue
        if _ring(gray, right + 1, top - 0.1 * s, min(end - 1, right + 1.2 * s), top + 1.2 * s, s):
            out[-1] = {**w, 't': w['t'] + '。'}
    return out


def _ring(gray, x0, y0, x1, y1, s):
    """Is there a full stop ("。": a small ring, empty in its middle) low in this box (a cell of the
    line, from above its characters to under them) on the page picture (gray), and nothing else?
    (A part of a character, also one with a small closed shape as 口, has ink higher up.)
    s: the size of a character."""
    x0, y0, x1, y1 = max(0, round(x0)), max(0, round(y0)), min(gray.width, round(x1)), min(gray.height, round(y1))
    w, h = x1 - x0, y1 - y0
    if w < 4 or h < 4:
        return False
    px = gray.crop((x0, y0, x1, y1)).tobytes()
    paper = sorted(px)[len(px) * 9 // 10]
    if paper < 110:  # (light print on a dark box: not looked at)
        return False
    ink = bytearray(p < paper - 50 for p in px)
    pieces, seen = [], bytearray(len(px))
    for start in range(len(px)):
        if not ink[start] or seen[start]:
            continue
        stack, seen[start], piece = [start], 1, []
        while stack:
            i = stack.pop()
            piece.append(i)
            y, x = divmod(i, w)
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if 0 <= y + dy < h and 0 <= x + dx < w and ink[i + dy * w + dx] and not seen[i + dy * w + dx]:
                        seen[i + dy * w + dx] = 1
                        stack.append(i + dy * w + dx)
        if len(piece) >= 3:
            pieces.append(piece)
    if not pieces:
        return False
    pieces.sort(key=len)
    ring = pieces[-1]
    if sum(map(len, pieces[:-1])) > 0.3 * len(ring):  # (more ink there: something else)
        return False
    xs, ys = [i % w for i in ring], [i // w for i in ring]
    bw, bh = max(xs) - min(xs) + 1, max(ys) - min(ys) + 1
    if not (0.14 * s <= bw <= 0.45 * s and 0.14 * s <= bh <= 0.45 * s and 0.65 <= bw / bh <= 1.5):
        return False
    if min(ys) < h - 0.75 * s or any(i // w < h - 0.8 * s for p in pieces for i in p):  # (low in the cell; nothing above it)
        return False
    middle = ((min(ys) + max(ys)) // 2) * w + (min(xs) + max(xs)) // 2
    return not ink[middle] and len(ring) < 0.75 * bw * bh  # (empty in its middle: a ring, not a dot)


def make_lines(raw, ocr=True, image=None, stops=False):
    """Lines with their words and box. ocr=False (text from a PDF): only blank words are dropped,
    not what looks like an OCR slip on the original disc. A line with a bullet in front ('item':
    where its text starts) begins a list item; image (the page picture) finds the bullets OCR missed,
    and with stops (words read by OCR, in their places on it) the full stops of Chinese it missed."""
    gray = image.convert('L') if image is not None else None
    lines = []
    for ln in raw.get('lines', []):
        bullet = len(ln['words']) > 1 and ln['words'][0]['t'].strip() in BULLETS
        words = []
        for w in ln['words'][1 if bullet else 0:]:
            t = clean_word(w['t']) if ocr else (w['t'].strip() or None)
            if t is not None:
                words.append({'t': t, 'x': w['x'], 'y': w['y'], 'w': w['w'], 'h': w['h']})
        if not words:
            continue
        text = ' '.join(w['t'] for w in words)
        cjk = CJK.search(text) is not None
        if cjk:
            words = cjk_words(words)
            if gray is not None and stops:
                words = missed_stops(gray, words)
        alnum = len(re.findall(r'[A-Za-z0-9]', text))
        if (alnum < 2 and not OTHER_SCRIPT.search(text)) or re.fullmatch(r'\d{1,3}', text):  # lone letters, page numbers
            continue
        hs = ([w['h'] for w in words if re.search(r'[A-Za-z0-9]', w['t']) or OTHER_SCRIPT.search(w['t'])]
              or [w['h'] for w in words])
        line = {
            'words': words,
            # Left edge from the raw words, so a dropped icon still counts as the line start.
            'x0': min(w['x'] for w in ln['words']), 'y0': min(w['y'] for w in words),
            'x1': max(w['x'] + w['w'] for w in words), 'y1': max(w['y'] + w['h'] for w in words),
            # Max word height ~ ascender-to-descender size; stable even for one-word lines.
            'h': max(hs),
        }
        dot = None if bullet or gray is None else missed_bullet(gray, line)
        if bullet or dot is not None:
            line.update(item=words[0]['x'], x0=min(line['x0'], dot if dot is not None else line['x0']))
        if ln.get('own'):  # (a sentence as it is: the word of a list of new words)
            line['own'] = True
        lines.append(line)
    return lines


def _other_writing(t):
    """Letters of another writing than the Latin one in t ("一" is one, "⑧" is not)."""
    return any(unicodedata.category(ch).startswith('L') and OTHER_SCRIPT.match(ch) for ch in t)


def word_lists(lines, keep_reading=True):
    """The lists of new words on a page ("服务 fúwù v. serve"): rows of a word in another writing
    than the Latin one, its reading (pinyin), its part of speech and its meaning, in columns, the
    meaning on as many lines as it needs (also above the middle of its row). Found by the parts of
    speech one under the other; then also the rows whose part of speech OCR misread, by their word.
    At least 3 rows. Returns the lists, [{'box': (x0, y0, x1, y1), 'entries': [[line, ...] for each
    row]}], and the lines without their words. An entry: a line with the word (and its reading if
    keep_reading), 'own': a sentence as it is; then the lines of its meaning (its part of speech
    before it if keep_reading). The rows' numbers ("⑧", as OCR reads it "@", "(D") are left out."""
    words = [w for ln in lines for w in ln['words']]
    hs = sorted(w['h'] for w in words if re.search(r'[A-Za-z0-9]', w['t']) or OTHER_SCRIPT.search(w['t']))
    if not hs:
        return [], lines
    u = hs[len(hs) // 2]  # (the height of a line of text)

    def cy(w):
        return w['y'] + w['h'] / 2

    def right(w):
        return w['x'] + w['w']

    def middle(ws):
        return (min(w['y'] for w in ws) + max(w['y'] + w['h'] for w in ws)) / 2

    # Parts of speech one under the other (their left edges in a line), a row each: one ending in
    # "/" goes on in the one under it ("adj./" ⏎ "v."). A list's rows: a few lines apart at most.
    columns = []
    for p in sorted((w for w in words if PART_OF_SPEECH.fullmatch(w['t'])), key=lambda w: w['x']):
        col = next((c for c in columns if abs(c[0]['x'] - p['x']) <= 0.6 * u), None)
        if col:
            col.append(p)
        else:
            columns.append([p])
    runs = []
    for col in columns:
        rows = []
        for p in sorted(col, key=cy):
            if rows and rows[-1][-1]['t'].endswith(('/', ',', '&')) and cy(p) - cy(rows[-1][-1]) <= 1.6 * u:
                rows[-1].append(p)
            elif not rows or cy(p) - middle(rows[-1]) > 0.6 * u:  # (not a second one in a row)
                rows.append([p])
        runs.append([rows[0]])
        for r in rows[1:]:
            if middle(r) - middle(runs[-1][-1]) > 7 * u:
                runs.append([r])
            else:
                runs[-1].append(r)

    def groups(c, x1):  # the words in another writing on the line at height c left of x1, in groups apart
        out = []
        for w in sorted((w for w in words if abs(cy(w) - c) <= 0.6 * u and _other_writing(w['t']) and right(w) <= x1),
                        key=lambda w: w['x']):
            if out and w['x'] - right(out[-1][-1]) <= u:
                out[-1].append(w)
            else:
                out.append([w])
        return out

    # The words' column: where groups of them start in half the rows at least, the nearest to the
    # parts of speech (not the text beside the list, nor a reading OCR misread as characters).
    found = []
    for run in runs:
        px = min(p['x'] for r in run for p in r)
        starts = [[g[0]['x'] for g in groups(middle(r), px)] for r in run]
        ok = [x for s in starts for x in s if sum(any(abs(y - x) <= 0.6 * u for y in t) for t in starts) >= max(2, len(run) / 2)]
        if ok:
            found.append({'run': run, 'px': px, 'col': statistics.median(x for s in starts for x in s if abs(x - max(ok)) <= 0.6 * u)})
    # Two pieces of one list (the parts of speech between them misread): its words go on between them.
    found.sort(key=lambda f: (f['px'], middle(f['run'][0])))
    lists_found = []
    for f in found:
        g = lists_found[-1] if lists_found else None
        if g and abs(g['px'] - f['px']) <= 0.6 * u and abs(g['col'] - f['col']) <= 0.6 * u:
            a, b = middle(g['run'][-1]), middle(f['run'][0])
            ys = sorted([a, b] + [cy(w) for w in words if abs(w['x'] - g['col']) <= 0.6 * u and _other_writing(w['t']) and a < cy(w) < b])
            if all(y1 - y0 <= 7 * u for y0, y1 in zip(ys, ys[1:])):
                g['run'] += f['run']
                continue
        lists_found.append(f)

    def meaning_of(ws):
        """The words of a line of a meaning (in Latin letters), from its start: up to a wide gap, or
        to the word of the next list beside it ("gift; present ⑱ 一边 yìbiān adv.", without its number)."""
        ws = sorted(ws, key=lambda w: w['x'])
        out = []
        for k, w in enumerate(ws):
            if out and w['x'] - right(out[-1]) > 1.5 * u:
                break
            if _other_writing(w['t']) and any(PART_OF_SPEECH.fullmatch(v['t']) for v in ws[k + 1:]):
                while out and len(out[-1]['t']) <= 4 and not re.search('[a-z]{2}', out[-1]['t']):
                    out.pop()
                break
            out.append(w)
        letters = sum(ch.isascii() and ch.isalpha() for w in out for ch in w['t'])  # (not "|", a dotted line)
        return out if out and not _other_writing(out[0]['t']) and letters >= 2 else []

    lists, taken = [], set()
    for f in lists_found:
        col = f['col']
        bound = min((g['col'] - 3 * u for g in lists_found if g['px'] > f['px']), default=float('inf'))  # (a list to the right)

        def row_of(c, pos, reading_end, meaning_start):
            """The row at height c: its word, number, reading and the meaning on its line."""
            skip = {id(p) for p in pos}
            row = [w for w in words if abs(cy(w) - c) <= 0.6 * u and id(w) not in taken and id(w) not in skip and w['x'] < bound]
            word = []
            for w in sorted((w for w in row if _other_writing(w['t']) and col - 0.6 * u <= w['x'] < reading_end), key=lambda w: w['x']):
                if word and w['x'] - right(word[-1]) > u or not word and w['x'] > col + 0.6 * u:
                    break
                word.append(w)
            number = [w for w in row if w['x'] >= col - 3 * u and right(w) <= col + 0.3 * u and len(w['t']) <= 4 and w not in word]
            reading = [w for w in row if w['x'] >= col and right(w) <= reading_end + 0.2 * u and w not in word]
            meaning = meaning_of(w for w in row if w['x'] >= meaning_start - 0.2 * u and abs(cy(w) - c) <= 0.4 * u)
            ws = pos + word + reading
            return {'cy': c, 'pos': pos, 'word': word, 'number': number, 'reading': reading, 'meaning': meaning,
                    'top': min(w['y'] for w in ws), 'bottom': max(w['y'] + w['h'] for w in ws)}
        rows = [row_of(middle(r), r, min(p['x'] for p in r), max(right(p) for p in r)) for r in f['run']]
        firsts = [r['meaning'][0]['x'] for r in rows if r['meaning']]
        if len(firsts) < 2:
            continue
        mx = statistics.median(firsts)  # (where the meanings start)
        # The rows whose part of speech OCR misread or missed ("v." as "妩"): a word starting the
        # words' column, between the rows (or above or under them, with a reading and a meaning
        # beside it: not the list's title).
        lo, hi = rows[0]['cy'], rows[-1]['cy']
        for w in sorted(words, key=cy):
            c = cy(w)
            if abs(w['x'] - col) <= 0.6 * u and _other_writing(w['t']) and id(w) not in taken \
                    and lo - 7 * u <= c <= hi + 7 * u and all(abs(c - r['cy']) > 0.6 * u for r in rows):
                r = row_of(c, [], mx - 0.5 * u, mx - 0.5 * u)
                if r['word'] and (lo < c < hi or r['meaning'] and r['reading']):
                    rows.append(r)
                    rows.sort(key=lambda r: r['cy'])
        # The rows of which OCR read neither: their reading, between the rows (not the second line of one).
        readings = [min(w['x'] for w in r['reading']) for r in rows if r['pos'] and r['reading']]
        for w in sorted(words, key=cy) if readings else []:
            c = cy(w)
            if abs(w['x'] - statistics.median(readings)) <= 0.6 * u and re.search('[A-Za-z]', w['t']) and not _other_writing(w['t']) \
                    and id(w) not in taken and lo < c < hi and all(abs(c - r['cy']) > 1.2 * u for r in rows):
                rows.append(row_of(c, [], mx - 0.5 * u, mx - 0.5 * u))
                rows.sort(key=lambda r: r['cy'])
        if len(rows) < 3:
            continue
        in_rows = {id(w) for r in rows for w in (r['word'] + r['number'] + r['reading'] + r['pos'])}
        top, bottom = min(r['top'] for r in rows), max(r['bottom'] for r in rows)
        # What else is in the columns of the numbers, readings and parts of speech (a reading on two
        # lines, what OCR misread: "丿" for "/"): with the row nearest to it.
        for w in words:
            if id(w) not in taken and id(w) not in in_rows and col - 3 * u <= w['x'] < mx - 0.5 * u and top <= cy(w) <= bottom \
                    and not (_other_writing(w['t']) and abs(w['x'] - col) <= 0.6 * u):
                min(rows, key=lambda r: abs(r['cy'] - cy(w)))['reading'].append(w)
                in_rows.add(id(w))
        # The lines of the meanings, from a little above the list to a little under it: each from
        # where the meanings start (not a column beside them).
        mlines = []
        for w in sorted((w for w in words if id(w) not in taken and id(w) not in in_rows and mx - 0.5 * u <= w['x'] < bound
                         and top - 8 * u <= cy(w) <= bottom + 8 * u), key=cy):
            last = mlines[-1] if mlines else None
            if last and min(last['y1'], w['y'] + w['h']) - max(last['y0'], w['y']) >= 0.5 * min(last['y1'] - last['y0'], w['h']):
                last['words'].append(w)
                last.update(y0=min(last['y0'], w['y']), y1=max(last['y1'], w['y'] + w['h']))
            else:
                mlines.append({'words': [w], 'y0': w['y'], 'y1': w['y'] + w['h']})
        mlines = [{'words': ws, 'y0': min(w['y'] for w in ws), 'y1': max(w['y'] + w['h'] for w in ws)}
                  for ws in (meaning_of(L['words']) for L in mlines) if ws and ws[0]['x'] <= mx + 1.5 * u]
        # Only the lines that go on from the list's rows, without a gap (not the text above or under it).
        rows_top = min([top] + [L['y0'] for L in mlines if L['y1'] > top and L['y0'] < bottom])
        rows_bottom = max([bottom] + [L['y1'] for L in mlines if L['y1'] > top and L['y0'] < bottom])
        keep = [L for L in mlines if L['y1'] > top and L['y0'] < bottom]
        edge = rows_top
        for L in sorted((L for L in mlines if L['y1'] <= top), key=lambda L: -L['y1']):
            if edge - L['y1'] > 0.8 * u:
                break
            keep.append(L)
            edge = L['y0']
        edge = rows_bottom
        for L in sorted((L for L in mlines if L['y0'] >= bottom), key=lambda L: L['y0']):
            if L['y0'] - edge > 0.8 * u:
                break
            keep.append(L)
            edge = L['y1']
        mlines = sorted(keep, key=lambda L: L['y0'])
        for L in mlines:  # (on the line of a row)
            L['row'] = next((j for w in L['words'] for j, r in enumerate(rows) if abs(cy(w) - r['cy']) <= 0.4 * u), None)

        # Each row's meaning: the lines next to each other around its middle (or from its top), the
        # lines on a row's line with it. (The fewest lines away from their row in all.)
        def cost(j, a, b):
            if a == b:
                return 2 * u  # (no meaning read)
            y0, y1 = mlines[a]['y0'], max(L['y1'] for L in mlines[a:b])
            away = sum(1000 * u for L in mlines[a:b] if L['row'] is not None and L['row'] != j)
            return away + min(abs((y0 + y1) / 2 - rows[j]['cy']), abs(y0 - rows[j]['top']))
        n, m = len(mlines), len(rows)
        best = [[float('inf')] * (m + 1) for _ in range(n + 1)]
        back = [[0] * (m + 1) for _ in range(n + 1)]
        best[0][0] = 0
        for j in range(m):
            for a in range(n + 1):
                if best[a][j] < float('inf'):
                    for b in range(a, n + 1):
                        c = best[a][j] + cost(j, a, b)
                        if c < best[b][j + 1]:
                            best[b][j + 1], back[b][j + 1] = c, a
        ends, b = [], n
        for j in range(m, 0, -1):
            ends.append((back[b][j], b))
            b = back[b][j]
        ends.reverse()

        entries, mine = [], []
        for r, (a, b) in zip(rows, ends):
            meaning = [sorted(L['words'], key=lambda w: w['x']) for L in mlines[a:b]]
            mine += r['word'] + r['number'] + r['reading'] + r['pos'] + [w for ws in meaning for w in ws]
            first = r['word'] + (sorted(r['reading'], key=lambda w: (round(cy(w) / u), w['x'])) if keep_reading else [])
            if keep_reading and r['pos']:
                meaning = [r['pos'] + meaning[0]] + meaning[1:] if meaning else [r['pos']]
            entry = ([{'words': first, 'own': True}] if first else []) + [{'words': ws} for ws in meaning]
            if entry:
                entries.append(entry)
        taken.update(id(w) for w in mine)
        lists.append({'box': (min(w['x'] for w in mine), min(w['y'] for w in mine), max(right(w) for w in mine),
                              max(w['y'] + w['h'] for w in mine)), 'entries': entries})
    rest = [{**ln, 'words': [w for w in ln['words'] if id(w) not in taken]} for ln in lines]
    return lists, [ln for ln in rest if ln['words']]


def _list_place(blocks, box):
    """Where a list of new words goes among the paragraphs: after the one right above it (its title:
    "生词 New Words"), else before the first one under its top, in its column; else at the end."""
    x0, y0, x1, _ = box

    def across(block):
        return any(min(x1, ln['x1']) > max(x0, ln['x0']) for ln in block)
    above = [k for k, b in enumerate(blocks) if across(b) and max(ln['y1'] for ln in b) <= y0]
    if above:
        return max(above, key=lambda k: max(ln['y1'] for ln in blocks[k])) + 1
    return min((k for k, b in enumerate(blocks) if across(b) and min(ln['y0'] for ln in b) >= y0), default=len(blocks))


def starts_list_item(line):
    return len(line['words']) > 1 and LIST_MARK.match(line['words'][0]['t']) is not None


def same_block(prev, line, first=None):
    """Does line go on the block of prev? first: the block's first line (a list item when it has
    a bullet in front)."""
    if 'item' in line:  # a bullet: the next item
        return False
    h = max(prev['h'], line['h'])
    # Different font size. Box heights of one or two words depend on their letters
    # ("context." has no descender), so only compare fuller lines.
    full = min(len(prev['words']), len(line['words'])) >= 3
    if full and h / max(1, min(prev['h'], line['h'])) > 1.4:
        return False
    gap = line['y0'] - prev['y1']
    if gap > 0.9 * h or line['y0'] < prev['y0'] + 0.4 * h:  # too far below, or not below at all
        return False
    if line['x0'] > prev['x1'] or line['x1'] < prev['x0']:  # no horizontal overlap
        return False
    if line['x0'] < prev['x0'] - 2.5 * h:  # outdented: a new paragraph or column
        return False
    if first and 'item' in first and line['x0'] < (first['x0'] + first['item']) / 2:
        return False  # nearer the bullet than the item's text: the list is over
    prev_w, line_w = prev['x1'] - prev['x0'], line['x1'] - line['x0']
    if prev_w < 0.5 * line_w and not prev['words'][-1]['t'].endswith((',', '，')):  # heading above text
        return False
    return not starts_list_item(line)


def group_blocks(lines):
    blocks = []
    for line in lines:
        if blocks and same_block(blocks[-1][-1], line, blocks[-1][0]):
            blocks[-1].append(line)
        else:
            blocks.append([line])
    return blocks


def is_sentence_end(tok, nxt):
    if CJK_SENT_END.search(tok):
        return True
    if not SENT_END.search(tok):
        return False
    if re.search(r'(\.\.\.|…)["\'”’)\]]*$', tok) and nxt and CJK.match(nxt.lstrip('"\'“‘')):
        return False  # …… in Chinese: a pause in the sentence (要/快/快要/就要……了)
    low = tok.lower().strip('"\'”’()[]')
    if low in ABBREV or re.fullmatch(r'[A-Z]\.', tok):
        return False
    if nxt is None:
        return True
    return re.match(rf'["\'“‘(\[{CJK_OPEN}]?([A-Z0-9]|[{CJK_CHARS}])', nxt) is not None


def _language(tok):
    """'zh' (Chinese, Japanese, Korean characters), 'en' (a word in Latin letters), or None: goes
    with the words around it (numbers, punctuation, abbreviations as HSK or CD, pinyin with tone
    marks, and a word ending in Chinese punctuation: "iPhone。" is in a Chinese sentence)."""
    if CJK.search(tok):
        return 'zh'
    letters = re.sub(r'[^A-Za-z]', '', tok)
    if not letters or PINYIN_MARK.search(tok) or tok.rstrip('"\'”’')[-1:] in CJK_CLOSE \
            or (letters.isupper() and len(letters) <= 4):
        return None
    return 'en'


def language_parts(tokens, a, b, line_of=None):
    """The sentence [a, b) cut where its language changes between Chinese and English (a Chinese
    heading and its English): [[start, end], ...], one range if it does not. Chinese in quotation
    marks goes with the words around it (Aspect Particle “着”), and so do a few Chinese characters
    between English words in a line (In this case, 多 and 几 are interchangeable), a word or two of
    English between Chinese (我在用 iPhone 打电话), and one Chinese character after English.
    line_of: the line of each token (a run at the start of a line is not in the one before)."""
    toks = tokens[a:b]
    # Quotations: a quotation mark and the next closing one in the sentence, not too far and
    # without the end of a sentence in it (OCR misses some, and reads others as “ or ").
    quoted, opened = [False] * len(toks), []
    for k, tok in enumerate(toks):
        for ch in tok:
            closes = ch in QUOTE_CLOSE or (ch in '"“' and bool(opened))
            if not closes and (ch in QUOTE_OPEN or ch == '"'):
                opened.append(k)
            elif closes and opened:
                start = opened.pop()
                if k - start <= 20 and not any(CJK_SENT_END.search(t.rstrip('"\'“”’')) for t in toks[start + 1:k]):
                    quoted[start:k + 1] = [True] * (k + 1 - start)
    for start in opened:  # (not closed: a short one goes to the end of the sentence)
        if len(toks) - start <= 20 and not any(CJK_SENT_END.search(t.rstrip('"\'“”’')) for t in toks[start + 1:-1]):
            quoted[start:] = [True] * (len(toks) - start)
    langs = [None if quoted[k] and CJK.search(tok) else _language(tok) for k, tok in enumerate(toks)]
    runs = []  # [language, start, end], in the sentence
    for k, lang in enumerate(langs):
        if runs and runs[-1][0] is None and lang:  # what comes first goes with the first language
            runs[-1][0] = lang
        if runs and lang and runs[-1][0] != lang:
            runs.append([lang, k, k + 1])
        elif runs:
            runs[-1][2] = k + 1
        else:
            runs.append([lang, k, k + 1])

    def size(r):  # its Chinese characters, or its English words
        return sum(len(CJK.findall(t)) if r[0] == 'zh' else 1
                   for t, lang in zip(tokens[a + r[1]:a + r[2]], langs[r[1]:r[2]]) if lang == r[0])

    if len(runs) > 1 and runs[-1][0] == 'zh' and runs[-2][0] == 'en' and size(runs[-1]) == 1:
        runs[-2:] = [['en', runs[-2][1], runs[-1][2]]]  # Aspect Particle 着
    def new_line(r):  # (a heading on its own line: "Lesson ⏎ 注释 Notes")
        return line_of is not None and line_of[a + r[1]] != line_of[a + r[1] - 1]

    def embedded():  # a little of one language between the other, in a line: (how little, Chinese first, where)
        for k in range(1, len(runs) - 1):
            prev, cur, nxt = runs[k - 1], runs[k], runs[k + 1]
            if prev[0] == nxt[0] != cur[0] and size(cur) <= (4 if cur[0] == 'zh' else 2) and not new_line(cur) and not new_line(nxt):
                yield size(cur), cur[0] != 'zh', k

    # It stays in the language around it, the least first ("…几十个人 When 几 is used": 几 in the English).
    while (least := min(embedded(), default=None)) is not None:
        k = least[2]
        runs[k - 1:k + 2] = [[runs[k - 1][0], runs[k - 1][1], runs[k + 1][2]]]
    return [[a + r[1], a + r[2]] for r in runs]


def split_languages(doc):
    """A page made before sentences were cut where the language changes, and before each choice of
    an exercise in a line ("A 换房子 B 买空调"): cut so now. The words stay; a sentence cut in two
    gets its clauses again, the others keep theirs. Returns the page and whether it changed."""
    tokens, line_of = [w[4] for w in doc['words']], [w[5] for w in doc['words']]
    sents, clauses, blocks, changed = [], [], [], False
    old = doc.get('clause', [])
    choices = choice_starts(tokens, line_of)
    for sa, sb in doc['blocks']:
        first = len(sents)
        for a, b in doc['sent'][sa:sb]:
            cuts = [a] + sorted(i for i in choices if a < i < b) + [b]
            parts = [part for p, q in zip(cuts, cuts[1:]) for part in language_parts(tokens, p, q, line_of)]
            if len(parts) == 1:
                sents.append([a, b])
                clauses.extend([c[0], c[1]] for c in old if a <= c[0] and c[1] <= b)
            else:
                changed = True
                for p, q in parts:
                    sents.append([p, q])
                    clauses.extend(split_clauses(tokens, p, q))
        blocks.append([first, len(sents)])
    return ({**doc, 'sent': sents, 'clause': clauses, 'blocks': blocks}, True) if changed else (doc, False)


def cut_after(doc, ends):
    """The page's sentences cut after these words (their numbers: a full stop put back there),
    where they do not end already. A sentence cut gets its clauses again, the others keep theirs.
    Returns the page and whether it changed."""
    tokens = [w[4] for w in doc['words']]
    sents, clauses, blocks, changed = [], [], [], False
    old = doc.get('clause', [])
    for sa, sb in doc['blocks']:
        first = len(sents)
        for a, b in doc['sent'][sa:sb]:
            cuts = [a] + sorted(e + 1 for e in ends if a <= e < b - 1) + [b]
            if len(cuts) == 2:
                sents.append([a, b])
                clauses.extend([c[0], c[1]] for c in old if a <= c[0] and c[1] <= b)
                continue
            changed = True
            for p, q in zip(cuts, cuts[1:]):
                sents.append([p, q])
                clauses.extend(split_clauses(tokens, p, q))
        blocks.append([first, len(sents)])
    return ({**doc, 'sent': sents, 'clause': clauses, 'blocks': blocks}, True) if changed else (doc, False)


def split_clauses(tokens, a, b):
    """Return clause ranges inside sentence [a, b).

    web/js/segment.js has the same rules for text corrected in the app; keep the two in step.
    """
    def is_break(tok):
        return CLAUSE_END.search(tok) is not None or tok in DASHES

    # Words from i up to and including the next comma/colon/dash (or sentence end).
    run_len = [0] * (b - a + 1)
    for i in range(b - 1, a - 1, -1):
        run_len[i - a] = 1 if is_break(tokens[i]) or i == b - 1 else 1 + run_len[i - a + 1]

    cuts = [a]
    for i in range(a + 1, b):
        prev, cur = tokens[i - 1], tokens[i].lower().strip('"\'“‘(')
        before, after = i - cuts[-1], run_len[i - a]
        if is_break(prev):
            cuts.append(i)
        elif cur in SUBORDINATORS and before >= 2 and after >= 2:
            cuts.append(i)
        elif cur in COORDINATORS and before >= 4 and after >= 4:  # not "Adam and Tanner,"
            cuts.append(i)
    cuts.append(b)
    ranges = [[cuts[k], cuts[k + 1]] for k in range(len(cuts) - 1) if cuts[k + 1] > cuts[k]]
    # Fold one-word pieces ("However,") into the following clause.
    merged = []
    for r in ranges:
        if merged and merged[-1][1] - merged[-1][0] == 1:
            merged[-1][1] = r[1]
        else:
            merged.append(r)
    if len(merged) > 1 and merged[-1][1] - merged[-1][0] == 1:
        last = merged.pop()
        merged[-1][1] = last[1]
    return merged


def segment(raw, ocr=True, image=None, lists=(), stops=False):
    """The page text document of raw OCR (or PDF) lines: paragraphs found from the layout.
    image: the page picture (in the places of the words), for the bullets OCR did not read (and with
    stops, the full stops of Chinese). lists: the page's lists of new words (word_lists), each row a
    paragraph: its word, then its meaning."""
    blocks = group_blocks(make_lines(raw, ocr, image, stops))
    last = None  # (the list put in before, and where its rows end)
    for found in sorted(lists, key=lambda f: (f['box'][0], f['box'][1])):
        x0, y0, x1, y1 = found['box']
        rows = [b for b in (make_lines({'lines': entry}, ocr) for entry in found['entries']) if b]
        if last and x0 >= last[0][2] - 4 and min(y1, last[0][3]) - max(y0, last[0][1]) >= 0.5 * min(y1 - y0, last[0][3] - last[0][1]):
            at = last[1]  # (beside the one before: right after it)
        else:
            at = _list_place(blocks, found['box'])
        blocks[at:at] = rows
        last = (found['box'], at + len(rows))
    return doc_from_blocks(blocks)


def doc_from_blocks(block_list):
    """words, sentences, clauses and paragraphs of blocks (paragraphs), each a list of lines
    ({'words': [{'t', 'x', 'y', 'w', 'h'}]})."""
    words, sents, clauses, blocks = [], [], [], []
    for block in block_list:
        start_word = len(words)
        # Flatten the block's words, remembering which physical line each came from.
        flat = [(w, id(line)) for line in block for w in line['words']]
        tokens = [w['t'] for w, _ in flat]
        for k, (w, lid) in enumerate(flat):
            line_end = k + 1 < len(flat) and flat[k + 1][1] != lid
            # Line-end hyphen: join "no-" + "wake" without a space; none in Chinese either.
            space = 0 if (line_end and w['t'].endswith('-') and len(w['t']) > 1
                          or k + 1 < len(flat) and no_space(w['t'], flat[k + 1][0]['t'])) else 1
            words.append([w['x'], w['y'], w['w'], w['h'], w['t'], lid, space])

        first_sent = len(sents)
        # A line of its own (the word of a list of new words) is a sentence as it is; the rest is cut.
        own = {id(line) for line in block if line.get('own')}
        a = 0
        while a < len(flat):
            b = a + 1
            while b < len(flat) and (flat[b][1] == flat[a][1] if flat[a][1] in own else flat[b][1] not in own):
                b += 1
            if flat[a][1] in own:
                sents.append([start_word + a, start_word + b])
                clauses.extend([start_word + p, start_word + q] for p, q in split_clauses(tokens, a, b))
            else:
                block_sents, block_clauses = block_sentences(tokens[a:b], [lid for _, lid in flat[a:b]], start_word + a)
                sents += block_sents
                clauses += block_clauses
            a = b
        blocks.append([first_sent, len(sents)])

    # Replace Python object ids with compact 0..n line numbers.
    line_ids = {}
    for w in words:
        w[5] = line_ids.setdefault(w[5], len(line_ids))
    return {'words': words, 'sent': sents, 'clause': clauses, 'blocks': blocks}


def choice_starts(tokens, line_of):
    """Where the choices of an exercise start in their line ("A 换房子 B 买空调 C 去女儿的初中"): their
    letters one after the other (A, B, C …), each with words after it, the first at the start of
    the line (or three from A; not "A and B"). Each choice is a sentence of its own, and so is
    each question ("(2) 笔在哪儿？" at the start of a line, or after the choices). Returns their word numbers."""
    starts, lines = set(), {}
    for i, line in enumerate(line_of):
        if not (isinstance(line, int) and line < 0):  # (words typed in, on no line of the page)
            lines.setdefault(line, []).append(i)
    for idx in lines.values():
        # A question's number at the start of a line: "(2) 笔在哪儿？" (not in English going on: "sentences ⏎ (10) to compare")
        if len(idx) > 1 and QUESTION.fullmatch(tokens[idx[0]]) and not re.match('[a-z]', tokens[idx[1]]):
            starts.add(idx[0])
        runs = []  # [(word number, letter), ...]: the letters in order
        for i in idx:
            m = CHOICE.fullmatch(tokens[i])
            if not m:
                continue
            if runs and ord(m.group(1)) == ord(runs[-1][-1][1]) + 1 and i - runs[-1][-1][0] > 1:
                runs[-1].append((i, m.group(1)))
            else:
                runs.append([(i, m.group(1))])
        for run in runs:
            joined = len(run) == 2 and run[1][0] - run[0][0] == 2 and tokens[run[0][0] + 1].lower().strip('.,') in JOINING
            if len(run) >= 2 and run[-1][0] < idx[-1] and (run[0][0] == idx[0] or len(run) >= 3 and run[0][1] in 'Aa') and not joined:
                starts.update(i for i, _ in run)
                # The next question after the last choice, on its line: "C 门后面 (2) 笔在哪儿？"
                question = next((i for i in idx if i > run[-1][0] + 1 and QUESTION.fullmatch(tokens[i])), None)
                if question is not None:
                    starts.add(question)
    return starts


def block_sentences(tokens, line_of, start=0):
    """The sentences and clauses of the words of a block (tokens; line_of: the line of each),
    numbered from start (the block's first word): [[first, end], ...] each."""
    sents, clauses = [], []
    s, n = 0, len(tokens)
    choices = choice_starts(tokens, line_of)
    for i in range(n):
        nxt = tokens[i + 1] if i + 1 < n else None
        item_start = (nxt is not None and LIST_MARK.match(nxt) and i + 2 < n
                      and line_of[i + 1] != line_of[i])  # list marker at the start of a line
        if nxt is None or is_sentence_end(tokens[i], nxt) or item_start or i + 1 in choices:
            for p, q in language_parts(tokens, s, i + 1, line_of):  # (Chinese and English: a sentence each)
                sents.append([start + p, start + q])
                clauses.extend([start + c[0], start + c[1]] for c in split_clauses(tokens, p, q))
            s = i + 1
    return sents, clauses


def resegment(doc):
    """A page made before (its words, and the blocks they are in): its sentences and clauses made
    again by the rules of now. Returns the page and whether it changed."""
    words, sents, clauses, blocks = doc['words'], [], [], []
    for sa, sb in doc['blocks']:
        first = len(sents)
        if sa < sb:
            a, b = doc['sent'][sa][0], doc['sent'][sb - 1][1]
            block_sents, block_clauses = block_sentences([w[4] for w in words[a:b]], [w[5] for w in words[a:b]], a)
            sents += block_sents
            clauses += block_clauses
        blocks.append([first, len(sents)])
    if sents == doc['sent'] and clauses == doc.get('clause'):
        return doc, False
    return {**doc, 'sent': sents, 'clause': clauses, 'blocks': blocks}, True


def unit_text(words, a, b):
    out = []
    for w in words[a:b]:
        out.append(w[4] + (' ' if w[6] else ''))
    return ''.join(out).strip()


def page_text(doc):
    paras = []
    for sa, sb in doc['blocks']:
        paras.append(' '.join(unit_text(doc['words'], *doc['sent'][k]) for k in range(sa, sb)))
    return '\n'.join(paras)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--raw-dir', default=os.path.join(os.path.dirname(DATA), '_build', 'ocr_raw'))
    args = ap.parse_args()
    from PIL import Image

    index = load_json(os.path.join(SHARED, 'content', 'index.json'))
    count = 0
    for book in index['books'].values():
        slug = book['slug']
        search = []
        pages = sorted(book['pages'].items(), key=lambda kv: (int(kv[0]) if kv[0].isdigit() else 10**6, kv[1]['id']))
        for key, p in pages:
            raw_path = os.path.join(args.raw_dir, f"{slug}__{p['page_path']}.json")
            if not os.path.exists(raw_path):
                continue
            picture = os.path.join(DATA, 'pages', slug, f"{p['page_path']}.webp")
            image = Image.open(picture) if os.path.exists(picture) else None
            doc = segment(load_json(raw_path), image=image)
            save_json(os.path.join(DATA, 'text', slug, f"{p['page_path']}.json"), doc)
            search.append({'p': key, 't': page_text(doc)})
            count += 1
        save_json(os.path.join(DATA, 'search', f'{slug}.json'), search)
    print(f'segmented {count} pages')


if __name__ == '__main__':
    sys.exit(main())

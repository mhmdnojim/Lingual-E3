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
commas, colons, dashes and conjunctions.
"""
import argparse
import os
import re
import statistics
import sys

from common import DATA, SHARED, load_json, save_json

ABBREV = {'mr.', 'mrs.', 'ms.', 'dr.', 'st.', 'vs.', 'etc.', 'e.g.', 'i.e.', 'p.', 'pp.',
          'a.m.', 'p.m.', 'no.', 'jr.', 'sr.', 'approx.', 'ex.', 'esp.', 'u.s.', 'u.k.'}
LIST_MARK = re.compile(r'^(\d{1,2}|[a-hA-H])[.)]?$')
SENT_END = re.compile(r'([.!?]|\.\.\.|…)["\'”’)\]]*$')
CLAUSE_END = re.compile(r'[,;:]["\'”’)\]]*$|[—–]$')
DASHES = {'-', '—', '–'}
# Words that usually start a new clause. Coordinators need longer pieces on
# both sides so "Rutledge and Adam" is not split.
SUBORDINATORS = {'because', 'although', 'though', 'while', 'whereas', 'unless', 'until',
                 'if', 'when', 'whenever', 'where', 'wherever', 'since', 'which', 'who',
                 'whom', 'whose', 'before', 'after'}
COORDINATORS = {'and', 'but', 'or', 'so', 'yet'}


def clean_word(t):
    """Fix common OCR slips; return None for tokens that are just noise."""
    t = t.strip()
    # The audio-track icon is read as "@9)))", "@10))", "@12)" etc.
    if not t or ')))' in t or re.fullmatch(r'[@©®(]?\d{0,3}\){1,4}[.,]?', t):
        return None
    if not re.search(r'[A-Za-z0-9]', t):
        return t if t in DASHES or t in {'...', '…', '&', '?', '!', '=', '+', '/', '%'} else None
    return re.sub(r'^0(?=[A-Z]+\W*$)', 'O', t)  # "0K." -> "OK."


def make_lines(raw):
    lines = []
    for ln in raw.get('lines', []):
        words = []
        for w in ln['words']:
            t = clean_word(w['t'])
            if t is not None:
                words.append({'t': t, 'x': w['x'], 'y': w['y'], 'w': w['w'], 'h': w['h']})
        if not words:
            continue
        text = ' '.join(w['t'] for w in words)
        alnum = len(re.findall(r'[A-Za-z0-9]', text))
        if alnum < 2 or re.fullmatch(r'\d{1,3}', text):  # lone letters, page numbers
            continue
        hs = [w['h'] for w in words if re.search(r'[A-Za-z0-9]', w['t'])] or [w['h'] for w in words]
        lines.append({
            'words': words,
            # Left edge from the raw words, so a dropped icon still counts as the line start.
            'x0': min(w['x'] for w in ln['words']), 'y0': min(w['y'] for w in words),
            'x1': max(w['x'] + w['w'] for w in words), 'y1': max(w['y'] + w['h'] for w in words),
            # Max word height ~ ascender-to-descender size; stable even for one-word lines.
            'h': max(hs),
        })
    return lines


def starts_list_item(line):
    return len(line['words']) > 1 and LIST_MARK.match(line['words'][0]['t']) is not None


def same_block(prev, line):
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
    prev_w, line_w = prev['x1'] - prev['x0'], line['x1'] - line['x0']
    if prev_w < 0.5 * line_w and not prev['words'][-1]['t'].endswith(','):  # heading above text
        return False
    return not starts_list_item(line)


def group_blocks(lines):
    blocks = []
    for line in lines:
        if blocks and same_block(blocks[-1][-1], line):
            blocks[-1].append(line)
        else:
            blocks.append([line])
    return blocks


def is_sentence_end(tok, nxt):
    if not SENT_END.search(tok):
        return False
    low = tok.lower().strip('"\'”’()[]')
    if low in ABBREV or re.fullmatch(r'[A-Z]\.', tok):
        return False
    if nxt is None:
        return True
    return re.match(r'["\'“‘(\[]?[A-Z0-9]', nxt) is not None


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


def segment(raw):
    lines = make_lines(raw)
    words, sents, clauses, blocks = [], [], [], []
    for block in group_blocks(lines):
        start_word = len(words)
        # Flatten the block's words, remembering which physical line each came from.
        flat = [(w, id(line)) for line in block for w in line['words']]
        tokens = [w['t'] for w, _ in flat]
        for k, (w, lid) in enumerate(flat):
            line_end = k + 1 < len(flat) and flat[k + 1][1] != lid
            # Line-end hyphen: join "no-" + "wake" without a space.
            space = 0 if line_end and w['t'].endswith('-') and len(w['t']) > 1 else 1
            words.append([w['x'], w['y'], w['w'], w['h'], w['t'], lid, space])

        first_sent = len(sents)
        s = 0
        n = len(tokens)
        for i in range(n):
            nxt = tokens[i + 1] if i + 1 < n else None
            item_start = (nxt is not None and LIST_MARK.match(nxt) and i + 2 < n
                          and flat[i + 1][1] != flat[i][1])  # list marker at the start of a line
            if nxt is None or is_sentence_end(tokens[i], nxt) or item_start:
                sents.append([start_word + s, start_word + i + 1])
                for c in split_clauses(tokens, s, i + 1):
                    clauses.append([start_word + c[0], start_word + c[1]])
                s = i + 1
        blocks.append([first_sent, len(sents)])

    # Replace Python object ids with compact 0..n line numbers.
    line_ids = {}
    for w in words:
        w[5] = line_ids.setdefault(w[5], len(line_ids))
    return {'words': words, 'sent': sents, 'clause': clauses, 'blocks': blocks}


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
            doc = segment(load_json(raw_path))
            save_json(os.path.join(DATA, 'text', slug, f"{p['page_path']}.json"), doc)
            search.append({'p': key, 't': page_text(doc)})
            count += 1
        save_json(os.path.join(DATA, 'search', f'{slug}.json'), search)
    print(f'segmented {count} pages')


if __name__ == '__main__':
    sys.exit(main())

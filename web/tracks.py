"""Lingua Books: the audio and video of a book (its recordings: the tracks of its CDs, its videos),
added by its owner (web/library.py, js/library.js: a book's Settings → Audio and video).

The owner chooses a folder (or files); each recording is kept in the book's folder, by its content
(migration-media/<sha256>.mp3, as the recordings of an old app imported: served to whoever may read
the book, also in parts, and its words can be found by speech recognition, transcription.py). Its
number is in its name, as on the disc: "AEF3e_Level_3_SB_1.26.mp3" is track 1.26. A play button goes
on every page where that number is printed — where a recording is marked in the book, "⊙1.26 Watch
or listen…" (OCR reads the ⊙ as 0: "01.26"), over the ⊙. Kept in tracks.json; the buttons with the
page's others in migration-assets.json ('added': ours, made again when placed again).

The owner can change them by hand (correction mode → Play buttons): a button put where they click
('manual': kept when the buttons are placed again), one moved (then manual) or taken away. On the
pages where it was moved or taken away, a recording's button is not put again ('skip' in its item).
"""
import hashlib
import json
import os
import re

KINDS = {'.mp3': 'audio', '.m4a': 'audio', '.wav': 'audio', '.ogg': 'audio', '.mp4': 'video', '.webm': 'video'}
ICON = '0OoQ©®⊙'  # (the ⊙ before a track's number, as OCR reads it)
NAME = re.compile(r'(\d{1,2})[._-](\d{1,3})\.\w+$')  # the number at the end of a file's name: _1.26.mp3, 1-26.mp3
MARK = re.compile(rf'^([{ICON}])?(\d{{1,2}})\.(\d{{1,2}})$')  # in a page: 1.26, 01.26 (⊙1.26), 1.2


def track_of(name):
    """The track's number in a file's name: (1, 26) for "…_1.26.mp3" (1.02 and 1.2 the same), or None."""
    m = NAME.search(name)
    return (int(m.group(1)), int(m.group(2))) if m else None


def marks(doc):
    """The tracks' numbers printed on a page (its text document): [((cd, track), word number, with
    its ⊙ in the word)]. A number with the ⊙ before it (in the word, or a word of its own), or two
    digits after the dot (1.26), counts anywhere; one digit after the dot (1.2: a decimal, perhaps)
    only as the first or second word of its line ("b 1.2 Listen…")."""
    words, lines, out = doc['words'], {}, []
    for k, w in enumerate(words):
        lines.setdefault(w[5], []).append(k)
    for k, w in enumerate(words):
        m = MARK.match(w[4].strip('.,;:!?()'))
        if not m:
            continue
        icon = m.group(1) is not None
        before = k > 0 and words[k - 1][5] == w[5] and len(words[k - 1][4]) == 1 and words[k - 1][4] in ICON
        if icon or before or len(m.group(3)) == 2 or lines[w[5]].index(k) < 2:
            out.append(((int(m.group(2)), int(m.group(3))), k, icon))
    return out


def stored(folder, name, data):
    """The recording kept in the book's folder (migration-media/<sha256><ext>): its address there, its kind."""
    ext = os.path.splitext(name)[1].lower()
    file = hashlib.sha256(data).hexdigest() + ext
    path = os.path.join(folder, 'migration-media', file)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if not os.path.isfile(path):
        tmp = path + '.tmp'
        with open(tmp, 'wb') as f:
            f.write(data)
        os.replace(tmp, path)
    return file, KINDS[ext]


def load(folder):
    try:
        with open(os.path.join(folder, 'tracks.json'), encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return []


def save(folder, items):
    path = os.path.join(folder, 'tracks.json')
    with open(path + '.tmp', 'w', encoding='utf-8') as f:
        json.dump(items, f, ensure_ascii=False)
    os.replace(path + '.tmp', path)


def buttons(items, docs, address):
    """The play buttons of the recordings (items) on the pages (docs: {page number: its text
    document}): {page number: [button]}, and the recordings on no page. address(file): its address."""
    by_track = {}
    for it in items:
        if it.get('track'):
            by_track.setdefault(tuple(it['track']), it)  # (two with one number: the first)
    out, placed = {}, set()
    for n, doc in docs.items():
        seen = set()
        for t, k, icon in marks(doc):
            it = by_track.get(t)
            if not it or t in seen or str(n) in (it.get('skip') or ()):  # (moved or taken away there by hand)
                continue
            seen.add(t)
            placed.add(it['file'])
            x, y, w, h = doc['words'][k][:4]
            out.setdefault(n, []).append({
                't': it['kind'], 'x': round(max(0, x + 0.45 * h if icon else x - 0.7 * h)), 'y': round(y + h / 2),
                'title': title(it), 'src': address(it['file']), 'script': None, 'added': True})
    return out, [it for it in items if it['file'] not in placed]


def title(it):
    """What a recording's button says: "Track 1.26", "Video 2.03", or its file's name."""
    t = it.get('track')
    if t:
        return f"{'Video' if it['kind'] == 'video' else 'Track'} {t[0]}.{t[1]:02d}"
    return os.path.splitext(it['name'])[0]


def button(it, x, y, address):
    """A button put by hand (kept when the buttons are placed again)."""
    return {'t': it['kind'], 'x': round(x), 'y': round(y), 'title': title(it), 'src': address(it['file']),
            'script': None, 'manual': True}

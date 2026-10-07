"""Natural-voice MP3s of chosen sentences (the "My audio" feature).

Speech comes from edge-tts: the online Microsoft "Natural" voices that Microsoft Edge uses for
Read Aloud (an internet connection is needed to create audio; playing it back is offline).
Each sentence is spoken separately, so the exact start of every sentence and word is known;
ffmpeg (from imageio-ffmpeg) joins them, with an optional pause, into one MP3.

A recording is saved as web/recordings/<id>.mp3 and <id>.json (title, voice, and the timing of
every sentence and word, so the app can highlight the text while it plays).
"""
import asyncio
import json
import os
import re
import secrets
import subprocess
import threading
import time

import ids

WEB = os.path.dirname(os.path.abspath(__file__))
REC_DIR = os.environ.get('AEF_RECORDINGS_DIR') or os.path.join(WEB, 'recordings')  # tests use their own
# On a website every user has a folder of their own (rec_dir); the voice list and samples are shared.
RATE = 24000                      # sample rate of the edge-tts audio (mono)
VOICE_RE = re.compile(r'^[a-z]{2,3}-[A-Z]{2}-[A-Za-z]+Neural$')
ID_RE = re.compile(r'^r\d{8}-\d{6}-[0-9a-f]{4}$')
MAX_SENTENCES = 400
SAMPLE_TEXT = 'Hello! This is how I will read your book.'

jobs = {}
jobs_lock = threading.Lock()
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)


def missing_packages():
    """Name of a missing Python package, or None."""
    for name in ('edge_tts', 'imageio_ffmpeg'):
        try:
            __import__(name)
        except ImportError:
            return name.replace('_', '-')
    return None


def _ffmpeg():
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def _decode(mp3):
    """MP3 bytes -> raw 16-bit mono PCM at RATE."""
    r = subprocess.run([_ffmpeg(), '-v', 'error', '-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', str(RATE), 'pipe:1'],
                       input=mp3, capture_output=True, check=True, creationflags=NO_WINDOW)
    return r.stdout


def _encode(pcm, path, title):
    subprocess.run([_ffmpeg(), '-v', 'error', '-y', '-f', 's16le', '-ar', str(RATE), '-ac', '1', '-i', 'pipe:0',
                    '-c:a', 'libmp3lame', '-b:a', '64k', '-metadata', f'title={title}',
                    '-metadata', 'artist=American English File 3', path],
                   input=pcm, capture_output=True, check=True, creationflags=NO_WINDOW)


async def _speak(text, voice, rate):
    """Speak one piece of text: (mp3 bytes, [(start s, end s, word), ...])."""
    import edge_tts
    com = edge_tts.Communicate(text, voice, rate=f'{rate:+d}%', boundary='WordBoundary')
    audio, bounds = bytearray(), []
    async for chunk in com.stream():
        if chunk['type'] == 'audio':
            audio += chunk['data']
        elif chunk['type'] == 'WordBoundary':
            start = chunk['offset'] / 1e7
            bounds.append((start, start + chunk['duration'] / 1e7, chunk['text']))
    return bytes(audio), bounds


# ---------------------------------------------------------------- Voices

def _voice_entry(v):
    m = re.match(r'Microsoft (\w+?)(Multilingual)? Online', v.get('FriendlyName', ''))
    name = m.group(1) if m else v['ShortName'].split('-')[-1].replace('Neural', '')
    return {'id': v['ShortName'], 'name': name + (' (multilingual)' if m and m.group(2) else ''),
            'gender': v.get('Gender', ''), 'locale': v['Locale']}


def list_voices():
    """English Natural voices. Cached in recordings/voices.json so the list also shows offline."""
    cache = os.path.join(REC_DIR, 'voices.json')
    fresh = os.path.exists(cache) and time.time() - os.path.getmtime(cache) < 7 * 86400
    if not fresh:
        try:
            import edge_tts
            voices = asyncio.run(edge_tts.list_voices())
            entries = [_voice_entry(v) for v in voices if v['Locale'].startswith('en-')]
            os.makedirs(REC_DIR, exist_ok=True)
            with open(cache, 'w', encoding='utf-8') as f:
                json.dump(entries, f)
            return entries
        except Exception:
            if not os.path.exists(cache):
                raise
    with open(cache, encoding='utf-8') as f:
        return json.load(f)


def voice_sample(voice, rate=0):
    """A short MP3 to try a voice (cached)."""
    if not VOICE_RE.match(voice) or not -50 <= rate <= 50:
        raise ValueError('bad voice')
    path = os.path.join(REC_DIR, 'samples', f'{voice}_{rate:+d}.mp3')
    if not os.path.exists(path):
        mp3, _ = asyncio.run(_speak(SAMPLE_TEXT, voice, rate))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'wb') as f:
            f.write(mp3)
    with open(path, 'rb') as f:
        return f.read()


# ---------------------------------------------------------------- Word timing

def _norm(s):
    return re.sub(r'[\W_]+', '', s.lower())


def _word_times(words, bounds, start, end):
    """Match the spoken words reported by the voice to the page words of one sentence.

    words:  what is spoken for each page word ('' if nothing)
    bounds: [(start, end, text)] from the voice, relative to the whole recording
    Returns [start, end] for every page word; words the voice did not report get times
    shared out by length between their neighbours.
    """
    times = [None] * len(words)
    rest = [_norm(w) for w in words]
    j = 0
    for bs, be, bt in bounds:
        t = _norm(bt)
        if not t:
            continue
        k = j
        while k < len(words) and k - j <= 3 and not (rest[k] and (rest[k].startswith(t) or t.startswith(rest[k]))):
            k += 1
        if k >= len(words) or k - j > 3:
            continue
        times[k] = [bs, be] if times[k] is None else [times[k][0], be]
        rest[k] = rest[k][len(t):] if rest[k].startswith(t) else ''
        j = k if rest[k] else k + 1  # a word read as several ("p.104" -> "page" "104") stays current

    # Fill the gaps in proportion to word length.
    known = [i for i, t in enumerate(times) if t]
    anchors = [(-1, start)] + [(i, times[i][0]) for i in known] + [(len(words), end)]
    for (i0, t0), (i1, t1) in zip(anchors, anchors[1:]):
        gap = list(range(i0 + 1, i1))
        if not gap:
            continue
        left = times[i0][1] if 0 <= i0 < len(words) and times[i0] else t0
        lens = [max(1, len(words[i])) for i in gap]
        total, pos = sum(lens), left
        for i, l in zip(gap, lens):
            d = (t1 - left) * l / total
            times[i] = [pos, pos + d]
            pos += d
    return [[round(a, 3), round(b, 3)] for a, b in times]


# ---------------------------------------------------------------- Creating a recording

def _clean_request(req):
    if not isinstance(req, dict):
        raise ValueError('bad request')
    voice, rate, gap = req.get('voice', ''), req.get('rate', 0), req.get('gap', 0)
    sentences = req.get('sentences')
    if not VOICE_RE.match(str(voice)):
        raise ValueError('bad voice')
    if not isinstance(rate, int) or not -50 <= rate <= 50 or not isinstance(gap, (int, float)) or not 0 <= gap <= 10:
        raise ValueError('bad speed or pause')
    if not isinstance(sentences, list) or not 0 < len(sentences) <= MAX_SENTENCES:
        raise ValueError('choose between 1 and %d sentences' % MAX_SENTENCES)
    clean = []
    for s in sentences:
        words = s.get('words') if isinstance(s, dict) else None
        if not (isinstance(words, list) and all(isinstance(w, str) and len(w) < 200 for w in words)
                and isinstance(s.get('a'), int) and isinstance(s.get('b'), int) and s['b'] - s['a'] == len(words)
                and isinstance(s.get('text'), str) and ids.PAGE_RE.match(str(s.get('path', '')))):
            raise ValueError('bad sentence')
        clean.append({'path': s['path'], 'a': s['a'], 'b': s['b'], 'text': s['text'][:2000], 'words': words})
    title = str(req.get('title') or '').strip()[:120] or clean[0]['text'][:60]
    meta = {k: str(req.get(k, ''))[:40] for k in ('book', 'bookId', 'bookType', 'page', 'path')}
    if not ids.BOOK_RE.match(meta['book']) or not ids.PAGE_RE.match(meta['path']):
        raise ValueError('bad page')
    return {**meta, 'title': title, 'voice': voice, 'voiceName': str(req.get('voiceName', ''))[:60],
            'rate': rate, 'gap': float(gap), 'sentences': clean}


def start_job(req, rec_dir=None):
    """Check the request and create the MP3 (in rec_dir) in the background. Returns the job id."""
    job = _clean_request(req)
    job['dir'] = rec_dir or REC_DIR
    jid = secrets.token_hex(6)
    with jobs_lock:
        jobs[jid] = {'state': 'running', 'done': 0, 'total': len(job['sentences'])}
    threading.Thread(target=_run_job, args=(jid, job), daemon=True).start()
    return jid


def get_job(jid):
    with jobs_lock:
        return dict(jobs.get(jid) or {'state': 'unknown'})


def _set_job(jid, **kw):
    with jobs_lock:
        jobs[jid].update(kw)


def _run_job(jid, job):
    try:
        _set_job(jid, state='done', recording=asyncio.run(_create(jid, job)))
    except Exception as e:  # report to the app instead of failing silently
        msg = str(e) or e.__class__.__name__
        if 'Cannot connect' in msg or 'ClientConnector' in e.__class__.__name__ or 'getaddrinfo' in msg:
            msg = 'Could not reach the voice service. Creating audio needs an internet connection.'
        _set_job(jid, state='error', error=msg)


PARALLEL = 4          # pieces spoken at the same time (each request takes a second or two)
CHUNK_SENTENCES = 10  # sentences spoken in one go, so they flow like normal reading
CHUNK_CHARS = 1500
# Silence kept before and after each sentence's words. The voice itself pauses about 0.85 s at
# every full stop; keeping 0.25 s on each side gives a natural 0.5 s between sentences
# ("Pause between sentences" is added on top of that).
KEEP = 0.25
END_MARK = re.compile(r'[.!?;:…]["\'”’)\]]*$')


def _chunks(sentences):
    """Group the sentences, in order, into pieces of up to CHUNK_SENTENCES (and CHUNK_CHARS)."""
    chunks, cur, size = [], [], 0
    for i, s in enumerate(sentences):
        n = sum(len(w) + 1 for w in s['words'])
        if cur and (len(cur) >= CHUNK_SENTENCES or size + n > CHUNK_CHARS):
            chunks.append(cur)
            cur, size = [], 0
        cur.append(i)
        size += n
    if cur:
        chunks.append(cur)
    return chunks


async def _create(jid, job):
    """Speak the sentences in pieces of up to 10 (one request each, so the voice flows
    naturally instead of stopping after every sentence), then cut each piece at the sentence
    borders found from the word timings, so a chosen pause can be put between sentences and
    the app knows when each sentence starts."""
    sentences = job['sentences']
    chunks = _chunks(sentences)
    sem = asyncio.Semaphore(PARALLEL)
    done = 0

    async def speak(idx):
        nonlocal done
        words, owner = [], []  # every word of the piece, and the sentence it belongs to
        for i in idx:
            ws = list(sentences[i]['words'])
            said = [j for j, w in enumerate(ws) if w.strip()]
            if said and not END_MARK.search(ws[said[-1]]):
                ws[said[-1]] += '.'  # a heading without a stop: let the voice pause after it
            words += ws
            owner += [i] * len(ws)
        text = ' '.join(w for w in words if w.strip())
        mp3, bounds = b'', []
        if text:
            async with sem:
                for attempt in range(3):  # the online service sometimes drops a request
                    try:
                        mp3, bounds = await _speak(text, job['voice'], job['rate'])
                        break
                    except Exception:
                        if attempt == 2:
                            raise
                        await asyncio.sleep(1 + attempt)
        pcm = await asyncio.to_thread(_decode, mp3) if mp3 else b''
        times = _word_times(words, bounds, 0.0, len(pcm) / 2 / RATE) if words else []
        done += len(idx)
        _set_job(jid, done=done)
        return pcm, words, owner, times

    pieces = await asyncio.gather(*(speak(c) for c in chunks))

    # Cut every piece at the sentence borders and join everything, with the chosen pause.
    out, timeline = bytearray(), [None] * len(sentences)
    gap = b'\0\0' * int(job['gap'] * RATE)
    now = lambda: len(out) / 2 / RATE  # noqa: E731
    for idx, (pcm, words, owner, times) in zip(chunks, pieces):
        dur = len(pcm) / 2 / RATE
        spans = {}  # sentence -> [first word start, last word end] inside the piece
        for w, i, t in zip(words, owner, times):
            if w.strip():
                sp = spans.setdefault(i, [t[0], t[1]])
                sp[0], sp[1] = min(sp[0], t[0]), max(sp[1], t[1])
        said = [i for i in idx if i in spans]
        # Each sentence's part of the piece: its words plus KEEP seconds on each side (half-way
        # to the next sentence if they are closer than that).
        cut = {i: [max(0.0, spans[i][0] - KEEP), min(dur, spans[i][1] + KEEP)] for i in said}
        for x, y in zip(said, said[1:]):
            if cut[x][1] > cut[y][0]:
                cut[x][1] = cut[y][0] = (spans[x][1] + spans[y][0]) / 2
        for i in idx:
            s = sentences[i]
            if i not in spans:  # nothing to say (only symbols)
                t = round(now(), 3)
                timeline[i] = {**{k: s[k] for k in ('path', 'a', 'b', 'text')}, 'start': t, 'end': t, 'words': [[t, t]] * len(s['words'])}
                continue
            a, b = cut[i]
            if out and gap:
                out += gap
            start = now()
            out += pcm[int(a * RATE) * 2:int(b * RATE) * 2]
            shift = start - a
            word_times = [[round(t[0] + shift, 3), round(t[1] + shift, 3)] for o, t in zip(owner, times) if o == i]
            timeline[i] = {**{k: s[k] for k in ('path', 'a', 'b', 'text')},
                           'start': round(start, 3), 'end': round(now(), 3), 'words': word_times}
    pcm = out

    folder = job['dir']
    os.makedirs(folder, exist_ok=True)
    rid = time.strftime('r%Y%m%d-%H%M%S-') + secrets.token_hex(2)
    _encode(bytes(pcm), os.path.join(folder, rid + '.mp3'), job['title'])
    meta = {
        'id': rid, 'title': job['title'], 'created': time.strftime('%Y-%m-%dT%H:%M:%S'),
        **{k: job[k] for k in ('book', 'bookId', 'bookType', 'page', 'path', 'voice', 'voiceName', 'rate', 'gap')},
        'duration': round(len(pcm) / 2 / RATE, 2), 'file': f'/web/recordings/{rid}.mp3',
        'sentences': timeline,
    }
    with open(os.path.join(folder, rid + '.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False)
    _write_subtitles(meta, folder)
    return _summary(meta)


# ---------------------------------------------------------------- Subtitles

def _clock(sec, sep):
    ms = int(round(sec * 1000))
    return f'{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d}{sep}{ms % 1000:03d}'


def _write_subtitles(meta, folder):
    """Save the sentence times as subtitles next to the MP3: <id>.srt and <id>.vtt."""
    cues = [s for s in meta['sentences'] if s['end'] > s['start']]
    srt = '\n'.join(f"{n}\n{_clock(s['start'], ',')} --> {_clock(s['end'], ',')}\n{s['text']}\n"
                    for n, s in enumerate(cues, 1))
    vtt = 'WEBVTT\n\n' + '\n'.join(f"{n}\n{_clock(s['start'], '.')} --> {_clock(s['end'], '.')}\n{s['text']}\n"
                                   for n, s in enumerate(cues, 1))
    for ext, text in (('.srt', srt), ('.vtt', vtt)):
        with open(os.path.join(folder, meta['id'] + ext), 'w', encoding='utf-8', newline='\n') as f:
            f.write(text)


# ---------------------------------------------------------------- The library

def _summary(meta):
    """A recording without its timing details, for lists."""
    out = {k: v for k, v in meta.items() if k != 'sentences'}
    out['count'] = len(meta['sentences'])
    out['text'] = ' '.join(s['text'] for s in meta['sentences'])[:600]
    out['paths'] = sorted({s['path'] for s in meta['sentences']})
    first = next((s for s in meta['sentences'] if s['path'] == meta['path']), None)  # where its icon goes
    out['first'] = {k: first[k] for k in ('a', 'b', 'text')} if first else None
    out['srt'] = f"/web/recordings/{meta['id']}.srt"
    out['vtt'] = f"/web/recordings/{meta['id']}.vtt"
    return out


def _path(rid, ext, rec_dir=None):
    if not ID_RE.match(rid):
        raise ValueError('bad id')
    return os.path.join(rec_dir or REC_DIR, rid + ext)


def list_recordings(rec_dir=None):
    folder = rec_dir or REC_DIR
    if not os.path.isdir(folder):
        return []
    out = []
    for f in os.listdir(folder):
        if ID_RE.match(f[:-5]) and f.endswith('.json'):
            with open(os.path.join(folder, f), encoding='utf-8') as fh:
                meta = json.load(fh)
            if not os.path.exists(os.path.join(folder, meta['id'] + '.srt')):
                _write_subtitles(meta, folder)  # audio made before subtitles existed: the times are in the JSON
            out.append(_summary(meta))
    return sorted(out, key=lambda r: r['created'], reverse=True)


def get_recording(rid, rec_dir=None):
    with open(_path(rid, '.json', rec_dir), encoding='utf-8') as f:
        return json.load(f)


def rename_recording(rid, title, rec_dir=None):
    meta = get_recording(rid, rec_dir)
    meta['title'] = str(title).strip()[:120] or meta['title']
    with open(_path(rid, '.json', rec_dir), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False)
    return _summary(meta)


def delete_recording(rid, rec_dir=None):
    for ext in ('.mp3', '.json', '.srt', '.vtt'):
        p = _path(rid, ext, rec_dir)
        if os.path.exists(p):
            os.remove(p)


def recording_file(name, rec_dir=None):
    """The path of one of a user's files (<id>.mp3, .srt, .vtt), or None."""
    rid, ext = os.path.splitext(name)
    if ext not in ('.mp3', '.srt', '.vtt') or not ID_RE.match(rid):
        return None
    p = _path(rid, ext, rec_dir)
    return p if os.path.isfile(p) else None

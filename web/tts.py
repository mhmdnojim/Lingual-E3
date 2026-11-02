"""Natural or installed Windows-voice MP3s of chosen sentences ("My audio").

Speech comes from edge-tts: the online Microsoft "Natural" voices that Microsoft Edge uses for
Read Aloud (internet is needed to create those voices; playback is offline). Installed Windows
voices use System.Speech and need no internet to generate. Sentences are spoken in chunks with
word timings, then ffmpeg joins them, with an optional pause, into one MP3.

A recording is saved as web/recordings/<id>.mp3 and <id>.json (title, voice, and the timing of
every sentence and word, so the app can highlight the text while it plays).
"""
import asyncio
import base64
import io
import json
import os
import re
import secrets
import subprocess
import threading
import time
import wave

import ids

WEB = os.path.dirname(os.path.abspath(__file__))
REC_DIR = os.environ.get('AEF_RECORDINGS_DIR') or os.path.join(WEB, 'recordings')  # tests use their own
# On a website every user has a folder of their own (rec_dir); the voice list and samples are shared.
RATE = 24000                      # sample rate of the edge-tts audio (mono)
VOICE_RE = re.compile(r'^[a-z]{2,3}-[A-Z]{2}-[A-Za-z]+Neural$')
WINDOWS_VOICE_RE = re.compile(r'^windows:[A-Za-z0-9_.-]{1,120}$')
TR_LANG_RE = re.compile(r'^[a-z]{2,3}(-[A-Z]{2})?$')  # a translation language: ar, zh-CN …
IS_WINDOWS = os.name == 'nt'
ID_RE = re.compile(r'^r\d{8}-\d{6}-[0-9a-f]{4}$')
SPEAKER_PREFIX = re.compile(r'^\s*([A-Z][A-Za-z0-9_.\' -]{0,28}):')
# Since October 2026 Microsoft refuses the Natural voices at edge-tts's address (HTTP 403) in many
# countries. Microsoft Edge now uses this one, which takes the same key and token (edge-tts #490, #491).
EDGE_OLD_URL = 'speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
EDGE_URL = 'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1?Ocp-Apim-Subscription-Key={}'
MAX_SENTENCES = 400
SAMPLE_TEXT = 'Hello! This is how I will read your book.'

jobs = {}
jobs_lock = threading.Lock()
# Listing older recordings creates subtitles, and renaming writes metadata. Keep
# those writes out of a deletion so they cannot recreate a just-deleted file.
recordings_lock = threading.RLock()
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
_windows_voice_cache = None
_windows_voice_cache_time = 0.0
_windows_voice_lock = threading.Lock()


class WindowsSpeechError(RuntimeError):
    """An actionable local speech failure, safe to return to the voice picker."""


def missing_packages(request=None):
    """Name of a missing Python package, or None."""
    voices = []
    if isinstance(request, str):
        voices = [request]
    elif isinstance(request, dict):
        mode = request.get('languageMode', 'en')
        fields = ([] if mode == 'zh' else ['voice']) + ([] if mode == 'en' else ['zhVoice'])
        if request.get('twoSpeakers'):
            fields += [field + 'B' for field in list(fields)]
        voices = [str(request.get(field, '')) for field in fields]
    packages = ['imageio_ffmpeg']
    if not voices or any(not WINDOWS_VOICE_RE.fullmatch(voice) for voice in voices):
        packages.insert(0, 'edge_tts')
    for name in packages:
        try:
            __import__(name)
        except ImportError:
            return name.replace('_', '-')
    return None


def friendly_error(error):
    """Return an actionable, URL-redacted message for a denied Microsoft TTS request."""
    current = error
    while current is not None:
        if isinstance(current, WindowsSpeechError):
            return str(current)
        status = getattr(current, 'status', None)
        message = str(current)
        if status == 403 or ('403' in message and 'Invalid response status' in message):
            return ('Microsoft speech refused the connection (HTTP 403). The selected voice '
                    'could not be generated or saved offline. Choose a Windows offline voice '
                    'to generate without internet, or retry this Natural voice later. '
                    'Existing offline audio is still available.')
        current = current.__cause__ or current.__context__
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


def _valid_voice(voice):
    return bool(VOICE_RE.fullmatch(str(voice)) or WINDOWS_VOICE_RE.fullmatch(str(voice)))


def _windows_call(action, request=None):
    """Call Windows' installed speech engine. Text goes through stdin, never a command."""
    if not IS_WINDOWS:
        raise WindowsSpeechError('Windows offline voices are available only on a Windows server.')
    executable = os.path.join(os.environ.get('SystemRoot', r'C:\Windows'),
                              'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    try:
        result = subprocess.run(
            [executable, '-NoProfile', '-NonInteractive', '-File',
             os.path.join(WEB, 'windows_speech.ps1'), '-Action', action],
            input=json.dumps(request or {}, ensure_ascii=False).encode('utf-8'),
            capture_output=True, timeout=120 if action == 'speak' else 20,
            creationflags=NO_WINDOW)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise WindowsSpeechError('Windows offline speech is unavailable. Check the installed Windows voices.') from error
    try:
        data = json.loads(result.stdout.decode('utf-8-sig'))
    except (ValueError, UnicodeError) as error:
        raise WindowsSpeechError('Windows offline speech could not start. Check Windows speech components and script permissions.') from error
    if result.returncode or not isinstance(data, dict) or data.get('error'):
        message = data.get('error') if isinstance(data, dict) else ''
        raise WindowsSpeechError(message or 'Windows offline speech could not generate this voice.')
    return data


def windows_voices():
    """Only voices installed on this server; do not reuse another machine's local list."""
    global _windows_voice_cache, _windows_voice_cache_time
    if not IS_WINDOWS:
        return []
    with _windows_voice_lock:
        if _windows_voice_cache is not None and time.monotonic() - _windows_voice_cache_time < 300:
            return list(_windows_voice_cache)
        try:
            rows = _windows_call('list').get('voices', [])
            entries = []
            for row in rows:
                vid = 'windows:' + str(row.get('id', ''))
                if not WINDOWS_VOICE_RE.fullmatch(vid) or not row.get('locale'):
                    continue
                native_name = str(row.get('name', ''))
                name = re.sub(r'^Microsoft\s+|\s+Desktop$', '', native_name)
                entries.append({'id': vid, 'name': name + ' (Windows offline)',
                                'nativeName': native_name, 'locale': row['locale'],
                                'gender': row.get('gender', ''), 'provider': 'windows', 'offline': True})
        except Exception:
            # Windows voices are optional. A server without System.Speech can still
            # offer its cloud voices; never advertise an unusable local fallback.
            entries = []
        _windows_voice_cache, _windows_voice_cache_time = entries, time.monotonic()
        return list(entries)


def _windows_speak(text, voice, rate):
    if not WINDOWS_VOICE_RE.fullmatch(voice):
        raise ValueError('bad Windows voice')
    result = _windows_call('speak', {'text': text, 'voice': voice[len('windows:'):], 'rate': rate})
    audio = base64.b64decode(result.get('audio', ''), validate=True)
    try:
        with wave.open(io.BytesIO(audio), 'rb') as stream:
            duration = stream.getnframes() / stream.getframerate()
    except (wave.Error, EOFError) as error:
        raise RuntimeError('Windows speech returned no usable audio. Nothing was saved offline.') from error
    if duration <= 0:
        raise RuntimeError('Windows speech returned no usable audio. Nothing was saved offline.')
    events = result.get('boundaries', [])
    bounds = []
    for i, event in enumerate(events):
        start = max(0.0, min(duration, float(event['start'])))
        end = min(duration, float(events[i + 1]['start'])) if i + 1 < len(events) else duration
        bounds.append((start, max(start, end), str(event['text'])))
    return audio, bounds


def _edge_tts():
    """edge-tts, speaking through Microsoft's new address (a newer edge-tts that has its own is left alone)."""
    import edge_tts
    communicate = getattr(edge_tts, 'communicate', None)  # (tests use a stand-in without it)
    if EDGE_OLD_URL in getattr(communicate, 'WSS_URL', ''):
        communicate.WSS_URL = EDGE_URL.format(edge_tts.constants.TRUSTED_CLIENT_TOKEN)
    return edge_tts


async def _speak(text, voice, rate):
    """Speak one piece: (MP3 or WAV bytes, [(start s, end s, word), ...])."""
    if WINDOWS_VOICE_RE.fullmatch(voice):
        return await asyncio.to_thread(_windows_speak, text, voice, rate)
    edge_tts = _edge_tts()
    com = edge_tts.Communicate(text, voice, rate=f'{rate:+d}%', boundary='WordBoundary')
    audio, bounds = bytearray(), []
    async for chunk in com.stream():
        if chunk['type'] == 'audio':
            audio += chunk['data']
        elif chunk['type'] == 'WordBoundary':
            start = chunk['offset'] / 1e7
            bounds.append((start, start + chunk['duration'] / 1e7, chunk['text']))
    if not audio:
        raise RuntimeError('The speech service returned no audio. Nothing was saved offline.')
    return bytes(audio), bounds


# ---------------------------------------------------------------- Voices

def _voice_entry(v):
    m = re.match(r'Microsoft (\w+?)(Multilingual)? Online', v.get('FriendlyName', ''))
    name = m.group(1) if m else v['ShortName'].split('-')[-1].replace('Neural', '')
    return {'id': v['ShortName'], 'name': name + (' (multilingual)' if m and m.group(2) else ''),
            'gender': v.get('Gender', ''), 'locale': v['Locale']}


def _edge_voices():
    """Natural voices of every language (translations are read too). Cached so the list also shows offline."""
    cache = os.path.join(REC_DIR, 'voices-v3.json')
    fresh = os.path.exists(cache) and time.time() - os.path.getmtime(cache) < 7 * 86400
    if not fresh:
        try:
            import edge_tts
            # Installed Windows voices must still appear promptly if the online
            # catalog is unreachable. Preserve the cached online list when possible.
            voices = asyncio.run(asyncio.wait_for(edge_tts.list_voices(), timeout=5))
            entries = [_voice_entry(v) for v in voices if VOICE_RE.fullmatch(v['ShortName'])]
            os.makedirs(REC_DIR, exist_ok=True)
            with open(cache, 'w', encoding='utf-8') as f:
                json.dump(entries, f)
            return entries
        except Exception:
            if not os.path.exists(cache):
                cache = os.path.join(REC_DIR, 'voices-v2.json')  # (an older list: English and Chinese)
                if not os.path.exists(cache):
                    raise
    with open(cache, encoding='utf-8') as f:
        return json.load(f)


def speaks_language(locale, code):
    """Does a voice of `locale` (en-US, ar-SA, fil-PH …) speak the translation language `code`
    (ar, zh-CN, tl …: as the translation service writes it)? A code with a country needs that country."""
    locale, code = str(locale).replace('_', '-').lower(), str(code).lower()
    if '-' in code:
        return locale == code or locale.startswith(code + '-')
    return locale.split('-')[0] == {'tl': 'fil', 'iw': 'he'}.get(code, code)


def list_voices(lang=None):
    """The English and Chinese voices; with lang (a translation language), the voices of that language."""
    if lang is not None and not TR_LANG_RE.fullmatch(lang):
        raise ValueError('bad language')
    local = windows_voices()
    try:
        edge = [{**voice, 'provider': 'edge', 'offline': False} for voice in _edge_voices()]
    except Exception:
        if not local:
            raise
        edge = []
    if lang:
        return [v for v in local + edge if speaks_language(v['locale'], lang)]
    return local + [v for v in edge if v['locale'].startswith(('en-', 'zh-'))]


def voice_sample(voice, rate=0):
    """A short MP3 to try a voice (cached)."""
    if not _valid_voice(voice) or not -50 <= rate <= 50:
        raise ValueError('bad voice')
    path = os.path.join(REC_DIR, 'samples', f'{voice.replace(":", "_")}_{rate:+d}.mp3')
    if not os.path.exists(path):
        local = next((v for v in windows_voices() if v['id'] == voice), None) if voice.startswith('windows:') else None
        locale = local['locale'] if local else voice
        sample = '你好。' if locale.startswith('zh-') else SAMPLE_TEXT
        mp3, _ = asyncio.run(_speak(sample, voice, rate))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if voice.startswith('windows:'):
            _encode(_decode(mp3), path, 'Windows offline voice sample')
        else:
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
    zh_voice = str(req.get('zhVoice', ''))
    voice_b = str(req.get('voiceB', ''))
    zh_voice_b = str(req.get('zhVoiceB', ''))
    two_speakers = bool(req.get('twoSpeakers', False))
    language_mode = req.get('languageMode', 'en')
    if (not _valid_voice(voice) or (zh_voice and not _valid_voice(zh_voice))
            or (voice_b and not _valid_voice(voice_b)) or (zh_voice_b and not _valid_voice(zh_voice_b))):
        raise ValueError('bad voice')
    if two_speakers and not voice_b:
        raise ValueError('Choose a second English voice for speaker B.')
    if language_mode not in ('both', 'en', 'zh'):
        raise ValueError('bad language mode')
    if language_mode in ('both', 'zh') and not zh_voice:
        raise ValueError('Choose a Chinese voice to create Chinese audio.')
    if two_speakers and language_mode in ('both', 'zh') and not zh_voice_b:
        raise ValueError('Choose a second Chinese voice for speaker B.')
    if not isinstance(rate, int) or not -50 <= rate <= 50 or not isinstance(gap, (int, float)) or not 0 <= gap <= 10:
        raise ValueError('bad speed or pause')
    if not isinstance(sentences, list) or not 0 < len(sentences) <= MAX_SENTENCES:
        raise ValueError('choose between 1 and %d sentences' % MAX_SENTENCES)
    # Each sentence's translation read before or after it (sentences: tr), with a voice of its language.
    translation = req.get('translation') or None
    if translation is not None:
        if not (isinstance(translation, dict) and translation.get('order') in ('after', 'before')
                and TR_LANG_RE.fullmatch(str(translation.get('lang', ''))) and _valid_voice(translation.get('voice', ''))):
            raise ValueError('bad translation')
        translation = {'order': translation['order'], 'lang': translation['lang'], 'langName': str(translation.get('langName', ''))[:40],
                       'voice': translation['voice'], 'voiceName': str(translation.get('voiceName', ''))[:60]}
    clean = []
    for s in sentences:
        words = s.get('words') if isinstance(s, dict) else None
        if not (isinstance(words, list) and all(isinstance(w, str) and len(w) < 200 for w in words)
                and isinstance(s.get('a'), int) and isinstance(s.get('b'), int) and s['b'] - s['a'] == len(words)
                and isinstance(s.get('text'), str) and ids.PAGE_RE.match(str(s.get('path', '')))
                and isinstance(s.get('tr', ''), str)):
            raise ValueError('bad sentence')
        clean.append({'path': s['path'], 'a': s['a'], 'b': s['b'], 'text': s['text'][:2000], 'words': words,
                      **({'tr': s.get('tr', '').strip()[:2000]} if translation else {})})
    if translation and not any(s['tr'] for s in clean):
        raise ValueError('There are no translations of these sentences yet. Check the language in the Translation tab.')
    title = str(req.get('title') or '').strip()[:120] or clean[0]['text'][:60]
    meta = {k: str(req.get(k, ''))[:40] for k in ('book', 'bookId', 'bookType', 'page', 'path')}
    if not ids.BOOK_RE.match(meta['book']) or not ids.PAGE_RE.match(meta['path']):
        raise ValueError('bad page')
    collection = req.get('offlineCollection')
    collection = {k: str(collection[k])[:160] for k in ('id', 'title', 'book', 'bookType', 'voice', 'voiceName', 'languageMode', 'scope')
                  if k in collection} if isinstance(collection, dict) else None
    return {**meta, 'title': title, 'voice': voice, 'voiceName': str(req.get('voiceName', ''))[:60],
            'offlineVoiceOnly': req.get('offlineVoiceOnly') is True, 'offlineCollection': collection,
            'zhVoice': zh_voice, 'zhVoiceName': str(req.get('zhVoiceName', ''))[:60], 'languageMode': language_mode,
            'voiceB': voice_b, 'voiceBName': str(req.get('voiceBName', ''))[:60],
            'zhVoiceB': zh_voice_b, 'zhVoiceBName': str(req.get('zhVoiceBName', ''))[:60], 'twoSpeakers': two_speakers,
            'translation': translation, 'rate': rate, 'gap': float(gap), 'sentences': clean}


def start_job(req, rec_dir=None):
    """Check the request and create the MP3 (in rec_dir) in the background. Returns the job id."""
    job = _clean_request(req)
    job['dir'] = rec_dir or REC_DIR
    jid = secrets.token_hex(6)
    total = len(job['sentences']) + sum(1 for s in job['sentences'] if s.get('tr'))  # (translations are read one by one)
    with jobs_lock:
        jobs[jid] = {'state': 'running', 'done': 0, 'total': total}
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
        msg = friendly_error(e) or str(e) or e.__class__.__name__
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


async def _speak_again(text, voice, rate):
    """_speak, tried up to 3 times (an online voice sometimes fails for a moment); a refusal is not tried again."""
    for attempt in range(3):
        try:
            return await _speak(text, voice, rate)
        except Exception as e:
            denied = friendly_error(e)
            if denied:
                raise RuntimeError(denied) from e
            if WINDOWS_VOICE_RE.fullmatch(voice):
                raise  # retrying a missing local engine cannot make it available
            if attempt == 2:
                raise
            await asyncio.sleep(1 + attempt)


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
    named_speakers = {}
    for sentence in sentences:
        match = SPEAKER_PREFIX.match(sentence['text'])
        label = match.group(1).strip().casefold() if match else None
        if label and label not in ('a', 'speaker a', 'b', 'speaker b') and label not in named_speakers:
            named_speakers[label] = min(len(named_speakers), 1)

    async def speak(idx):
        nonlocal done
        words, owner = [], []  # every word of the piece, and the sentence it belongs to
        word_speakers = []
        for i in idx:
            ws = list(sentences[i]['words'])
            match = SPEAKER_PREFIX.match(sentences[i]['text'])
            label = match.group(1).strip().casefold() if match else None
            if not job['twoSpeakers']:
                speaker = 0
            elif label in ('a', 'speaker a'):
                speaker = 0
            elif label in ('b', 'speaker b'):
                speaker = 1
            elif label:
                speaker = named_speakers[label]
            else:
                # If labels are absent, alternate selected dialogue sentences A/B.
                speaker = i % 2 if job['twoSpeakers'] else 0
            # Do not speak the dialogue label itself (e.g. "A:" or "Mary:").
            if label and ws:
                first = re.sub(r'[:：]$', '', ws[0]).strip().casefold()
                if first == label:
                    ws[0] = ''
                    if len(ws) > 1 and ws[1].strip() in (':', '：'):
                        ws[1] = ''
            said = [j for j, w in enumerate(ws) if w.strip()]
            if said and not END_MARK.search(ws[said[-1]]):
                ws[said[-1]] += '.'  # a heading without a stop: let the voice pause after it
            words += ws
            owner += [i] * len(ws)
            word_speakers += [speaker] * len(ws)
        # Use a matching neural voice for each script instead of asking an English-only
        # voice to pronounce Chinese. Pinyin with tone marks is metadata, not speech.
        pieces_pcm, times = bytearray(), [None] * len(words)
        groups, current = [], None
        for wi, word in enumerate(words):
            if re.search(r'[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜńňḿ]', word, re.I):
                words[wi] = ''
                lang = None
            elif re.search(r'[\u3400-\u9fff\uf900-\ufaff]', word):
                lang = 'zh'
            elif re.search(r'[A-Za-z]', word):
                lang = 'en'
            else:
                # Keep punctuation and numbers with the preceding language span; sending
                # Chinese full stops to an English voice makes it read punctuation aloud.
                lang = current['lang'] if current and word.strip() else ('en' if word.strip() else None)
            if job['languageMode'] == 'en' and lang == 'zh' or job['languageMode'] == 'zh' and lang == 'en':
                words[wi] = ''
                lang = None
            if lang is None:
                current = None
                continue
            speaker = word_speakers[wi]
            if not current or current['lang'] != lang or current['speaker'] != speaker:
                current = {'lang': lang, 'speaker': speaker, 'indices': []}
                groups.append(current)
            current['indices'].append(wi)
        for gi, group in enumerate(groups):
            indexes = group['indices']
            group_words = [words[i] for i in indexes]
            text = (''.join(group_words) if group['lang'] == 'zh' else ' '.join(group_words)).strip()
            voice = (job['zhVoice'] if group['speaker'] == 0 else job['zhVoiceB']) if group['lang'] == 'zh' else (job['voice'] if group['speaker'] == 0 else job['voiceB'])
            if not text:
                continue
            async with sem:
                mp3, bounds = await _speak_again(text, voice, job['rate'])
            pcm = await asyncio.to_thread(_decode, mp3)
            if pieces_pcm:
                pieces_pcm.extend(b'\0\0' * int(0.08 * RATE))
            shift = len(pieces_pcm) / 2 / RATE
            pieces_pcm.extend(pcm)
            group_times = _word_times(group_words, bounds, 0.0, len(pcm) / 2 / RATE)
            for wi, t in zip(indexes, group_times):
                times[wi] = [round(t[0] + shift, 3), round(t[1] + shift, 3)]
        duration = len(pieces_pcm) / 2 / RATE
        # Retain pinyin / filtered words in the source text, but give them zero-length
        # timing points so the text-player's word index still aligns with the OCR.
        prev = 0.0
        for wi, t in enumerate(times):
            if t: prev = t[1]
            else: times[wi] = [round(prev, 3), round(prev, 3)]
        pcm = bytes(pieces_pcm)
        done += len(idx)
        _set_job(jid, done=done)
        return pcm, words, owner, times

    # The translations (when wanted): each one on its own, with the voice of its language, from
    # just before its first word to just after its last.
    translation, spoken_tr = job.get('translation'), {}

    async def say_translation(i):
        nonlocal done
        async with sem:
            mp3, bounds = await _speak_again(sentences[i]['tr'], translation['voice'], job['rate'])
        pcm = await asyncio.to_thread(_decode, mp3)
        dur = len(pcm) / 2 / RATE
        a, b = (max(0.0, bounds[0][0] - KEEP), min(dur, bounds[-1][1] + KEEP)) if bounds else (0.0, dur)
        spoken_tr[i] = pcm[int(a * RATE) * 2:int(b * RATE) * 2]
        done += 1
        _set_job(jid, done=done)

    # Confirm the service accepts this voice with real work for the first piece.
    # A rejected connection then stops the page before launching its other requests.
    pieces = [await speak(chunks[0])]
    more = await asyncio.gather(*(speak(c) for c in chunks[1:]),
                                *(say_translation(i) for i, s in enumerate(sentences) if translation and s['tr']))
    pieces.extend(more[:len(chunks) - 1])

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
            # The sentence with its translation before or after it: they count as one (to repeat
            # it, or play it from a click); its words are timed in the sentence's own part.
            said, tr_at = spoken_tr.get(i), None
            if said and translation['order'] == 'before':
                tr_at = now()
                out += said
            shift = now() - a
            out += pcm[int(a * RATE) * 2:int(b * RATE) * 2]
            if said and translation['order'] == 'after':
                tr_at = now()
                out += said
            word_times = [[round(t[0] + shift, 3), round(t[1] + shift, 3)] for o, t in zip(owner, times) if o == i]
            timeline[i] = {**{k: s[k] for k in ('path', 'a', 'b', 'text')},
                           'start': round(start, 3), 'end': round(now(), 3), 'words': word_times}
            if said:
                timeline[i]['tr'] = {'text': s['tr'], 'start': round(tr_at, 3), 'end': round(tr_at + len(said) / 2 / RATE, 3)}
    pcm = out

    folder = job['dir']
    os.makedirs(folder, exist_ok=True)
    rid = time.strftime('r%Y%m%d-%H%M%S-') + secrets.token_hex(2)
    _encode(bytes(pcm), os.path.join(folder, rid + '.mp3'), job['title'])
    meta = {
        'id': rid, 'title': job['title'], 'created': time.strftime('%Y-%m-%dT%H:%M:%S'),
        'offlineVoiceOnly': job.get('offlineVoiceOnly', False), 'offlineCollection': job.get('offlineCollection'),
        **{k: job[k] for k in ('book', 'bookId', 'bookType', 'page', 'path', 'voice', 'voiceName', 'voiceB', 'voiceBName', 'zhVoice', 'zhVoiceName', 'zhVoiceB', 'zhVoiceBName', 'languageMode', 'twoSpeakers', 'translation', 'rate', 'gap')},
        'duration': round(len(pcm) / 2 / RATE, 2), 'file': f'/web/recordings/{rid}.mp3',
        'sentences': timeline,
    }
    with recordings_lock:
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
    before = (meta.get('translation') or {}).get('order') == 'before'
    # A sentence read with its translation: both lines, in the order they are heard.
    text = lambda s: '\n'.join([s['tr']['text'], s['text']] if before else [s['text'], s['tr']['text']]) if s.get('tr') else s['text']  # noqa: E731
    srt = '\n'.join(f"{n}\n{_clock(s['start'], ',')} --> {_clock(s['end'], ',')}\n{text(s)}\n"
                    for n, s in enumerate(cues, 1))
    vtt = 'WEBVTT\n\n' + '\n'.join(f"{n}\n{_clock(s['start'], '.')} --> {_clock(s['end'], '.')}\n{text(s)}\n"
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
    with recordings_lock:
        if not os.path.isdir(folder):
            return []
        out = []
        for f in os.listdir(folder):
            if ID_RE.match(f[:-5]) and f.endswith('.json'):
                with open(os.path.join(folder, f), encoding='utf-8') as fh:
                    meta = json.load(fh)
                if not os.path.exists(os.path.join(folder, meta['id'] + '.srt')):
                    _write_subtitles(meta, folder)  # older audio already has the timings in JSON
                out.append(_summary(meta))
    return sorted(out, key=lambda r: r['created'], reverse=True)


def get_recording(rid, rec_dir=None):
    with recordings_lock:
        with open(_path(rid, '.json', rec_dir), encoding='utf-8') as f:
            return json.load(f)


def rename_recording(rid, title, rec_dir=None):
    with recordings_lock:
        meta = get_recording(rid, rec_dir)
        meta['title'] = str(title).strip()[:120] or meta['title']
        with open(_path(rid, '.json', rec_dir), 'w', encoding='utf-8') as f:
            json.dump(meta, f, ensure_ascii=False)
    return _summary(meta)


def delete_recording(rid, rec_dir=None):
    with recordings_lock:
        # Metadata goes last: a locked media/subtitle file leaves the recording
        # discoverable, allowing the user to retry instead of leaving an orphan.
        for ext in ('.mp3', '.srt', '.vtt', '.json'):
            p = _path(rid, ext, rec_dir)
            try:
                os.remove(p)
            except FileNotFoundError:
                pass  # already deleted, including a safe retry of DELETE


def recording_file(name, rec_dir=None):
    """The path of one of a user's files (<id>.mp3, .srt, .vtt), or None."""
    rid, ext = os.path.splitext(name)
    if ext not in ('.mp3', '.srt', '.vtt') or not ID_RE.match(rid):
        return None
    p = _path(rid, ext, rec_dir)
    return p if os.path.isfile(p) else None

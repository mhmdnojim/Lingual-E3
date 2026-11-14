"""Speech recognition on this computer (faster-whisper) for the disc's recordings and videos that
have no original script.

Each result is kept in web/transcripts/<id>.json ({"model", "cues"}; the id is the recording's
folder on the disc, e.g. AU-0655e61e4a3d6). web/tools/build_data.py turns these into ordinary
scripts (web/data/scripts/<id>.json, marked "auto" in books.json), so they are shown, repeated
and translated like the disc's own. web/tools/transcribe_all.py does all recordings at once; the
Transcribe button (POST /api/transcribe) does one in the background.

Setup transcription.bat installs the programs (web/vendor/python) and the English model
(web/vendor/models/base.en); after that no internet is needed.

Or ElevenLabs (Speech to Text, "Scribe", on the internet: better, with the speakers told apart, in
90+ languages, and on a website too): with its key in web/server-config.json ('speechKey', saved
by an admin in the app; else ELEVENLABS_API_KEY) it is used instead, unless this computer is
chosen ('speechEngine': 'local'). Its words become the same lines (sentences). Any audio or video
file can be transcribed too (transcribe a file: start_file, file_status), not only a book's.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

WEB = Path(__file__).resolve().parent
ROOT = WEB.parent
CACHE = Path(os.environ.get('AEF_TRANSCRIPTS_DIR', WEB / 'transcripts'))
MODEL = os.environ.get('AEF_WHISPER_MODEL', 'base.en')
MODEL_DIR = WEB / 'vendor' / 'models' / MODEL
MULTILINGUAL_MODEL = os.environ.get('AEF_WHISPER_MULTILINGUAL_MODEL', 'base')
PACKAGES = WEB / 'vendor' / 'python'
ASSET_ID = re.compile(r'/([A-Z]{2}-[0-9a-f]+)/[^/]+$')
# A full stop after these does not end the sentence; after U.S., a.m. … only if a sentence follows.
TITLES = {'mr.', 'mrs.', 'ms.', 'dr.', 'st.', 'prof.'}
ABBREVIATION = re.compile(r'(?:[a-z]\.){2,}')
# Whisper sometimes "hears" these in silence or music at the end (from the videos it learnt from).
INVENTED = {'thank you for watching', 'thanks for watching', 'please subscribe', 'thank you for watching and see you next time'}

SPEECH_API = os.environ.get('LB_SPEECH_API', 'https://api.elevenlabs.io/v1')  # (tests: a stand-in)
SPEECH_MODEL = 'scribe_v2'
MEDIA = {'.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
         '.opus': 'audio/ogg', '.flac': 'audio/flac', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
         '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.wmv': 'video/x-ms-wmv', '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg'}
VIDEO = {'.mp4', '.webm', '.mov', '.mkv', '.avi', '.wmv', '.mpeg', '.mpg'}
FILES = Path(tempfile.gettempdir()) / 'lingua-books-transcribe'  # (files to transcribe, while they are)
FILE_JOB = re.compile(r'^F-[0-9a-f]{32}$')

_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='transcribe')
_online = ThreadPoolExecutor(max_workers=3, thread_name_prefix='transcribe-online')  # (ElevenLabs: a few at once)
_lock = threading.Lock()
_jobs = {}
_scripts = {}  # a file's job -> its script id (its lines' translations kept under it)
_models = {}
_stopping = {}  # a job being written now -> 'pause' or 'stop' (asked for: it ends at its next step)


class Stopped(Exception):
    """A transcription ended by the user (Pause, Cancel)."""


def asset_id(src):
    """/.shared/assets/audio/AU-x/f.mp3 or /web/data/video/VI-x/f.mp4 -> AU-x / VI-x (or None)."""
    m = ASSET_ID.search(src or '')
    return m.group(1) if m else None


def saved(aid):
    """The lines made before for this recording, or None."""
    try:
        return json.loads((CACHE / f'{aid}.json').read_text(encoding='utf-8'))['cues'] or None
    except (OSError, ValueError, KeyError, TypeError):
        return None


def save(aid, cues, made_by=None):
    CACHE.mkdir(parents=True, exist_ok=True)
    temp = CACHE / f'{aid}.{uuid.uuid4().hex}.tmp'
    temp.write_text(json.dumps({'model': made_by or MODEL, 'cues': cues}, ensure_ascii=False, separators=(',', ':')),
                    encoding='utf-8')
    os.replace(temp, CACHE / f'{aid}.json')


def delete(src):
    """Remove a saved transcription when it is not currently being generated."""
    aid = cache_id(src)
    if not aid:
        raise ValueError('This recording is not in the book index.')
    with _lock:
        job = _jobs.get(aid)
        if job and job.get('state') in ('queued', 'running'):
            raise ValueError('Wait for transcription to finish before deleting it.')
        _jobs.pop(aid, None)
    (CACHE / f'{aid}.json').unlink(missing_ok=True)
    # build_data.py exposes cached transcripts as ordinary auto scripts to the reader.
    (WEB / 'data' / 'scripts' / f'{aid}.json').unlink(missing_ok=True)


def model(threads, model_name=None):
    """The speech model (loaded once per number of threads)."""
    model_name = model_name or MODEL
    key = (threads, model_name)
    model_dir = WEB / 'vendor' / 'models' / model_name
    if key not in _models:
        if str(PACKAGES) not in sys.path:
            sys.path.insert(0, str(PACKAGES))  # only now, so the app's own packages are loaded first
        from faster_whisper import WhisperModel
        if not (model_dir / 'model.bin').is_file():
            if model_name == MULTILINGUAL_MODEL and model_name != MODEL:
                raise FileNotFoundError(f'The multilingual speech model “{model_name}” is missing. Install it in web/vendor/models/{model_name} to transcribe Chinese or other languages.')
            raise FileNotFoundError('The speech model is missing. Run Setup transcription.bat, then restart the app '
                                    '— or use ElevenLabs (Speech recognition…, next to Transcribe).')
        _models[key] = WhisperModel(str(model_dir), device='cpu', compute_type='int8', cpu_threads=threads)
    return _models[key]


def sentences(segments, speaker_turns=()):
    """Whisper's pieces -> one line per sentence (so each can be repeated): [{"t": ms of its first
    word, "x": text}]."""
    cues, words = [], []
    current_speaker = None

    def close():
        text = ''.join(w.word for w in words).replace('�', '').strip()  # (half a character)
        if text and not invented(text):
            cue = {
                't': max(0, round(words[0].start * 1000)),
                'x': text,
                'words': [
                    {'t': max(0, round(w.start * 1000)), 'e': max(0, round(w.end * 1000)), 'x': w.word.strip()}
                    for w in words if w.word.strip()
                ],
            }
            if current_speaker:
                cue['speaker'] = current_speaker
            cues.append(cue)
        words.clear()

    after_abbreviation = False
    turns = list(speaker_turns)
    turn_index = 0
    for segment in segments:
        for w in segment.words or []:
            word = w.word.strip()
            gap = w.start - words[-1].end if words else 0
            midpoint = (w.start + w.end) / 2
            while turn_index < len(turns) and turns[turn_index]['end'] <= midpoint:
                turn_index += 1
            speaker = turns[turn_index]['speaker'] if turn_index < len(turns) and turns[turn_index]['start'] <= midpoint else None
            if words and speaker != current_speaker:
                close()
            if not words:
                current_speaker = speaker
            if words and (
                    after_abbreviation and word[:1].isupper()  # "… in the U.S. People …"
                    or gap > 1.2  # a pause: a new line even without a full stop
                    or gap >= 0.3 and len(words) >= 25 or len(words) >= 35  # a long line without full stops
                    # a list of single words (e.g. pronunciation): a line each
                    or gap >= 0.4 and word.endswith(',') and all(x.word.strip().endswith(',') for x in words)):
                close()
            words.append(w)
            end = word.lower().rstrip('"\')”’')
            after_abbreviation = bool(ABBREVIATION.fullmatch(end))
            if end.endswith(('.', '?', '!', '。', '？', '！')) and end not in TITLES and not after_abbreviation:
                close()
    if words:
        close()
    return cues


def invented(text):
    return text.lower().strip(' .!') in INVENTED


def transcribe(path, threads=4, progress=None, language='en', speakers=True):
    """The timed lines of a recording or video. progress(percent) is called while it runs.
    speakers=False: without telling the voices apart (no speaker detection needed)."""
    import numpy as np
    import imageio_ffmpeg
    lang_code = language_code(language) or 'en'
    model_name = MODEL if lang_code == 'en' else MULTILINGUAL_MODEL
    whisper = model(threads, model_name)
    # The app's ffmpeg decodes MP3 and MP4 alike; Whisper gets the sound as 16 kHz mono.
    decoded = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-v', 'error', '-i', str(path),
                              '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'],
                             capture_output=True, timeout=900)
    if decoded.returncode:
        raise ValueError('The recording could not be decoded for transcription.')
    audio = np.frombuffer(decoded.stdout, dtype=np.float32).copy()
    if not audio.size:
        raise ValueError('This recording has no audio to transcribe.')
    speaker_turns = diarize(audio) if speakers else ()
    # hallucination_silence_threshold: no words made up in silence or music (e.g. at the end).
    segments, info = whisper.transcribe(audio, language=lang_code, beam_size=5, word_timestamps=True, vad_filter=True,
                                        condition_on_previous_text=False, hallucination_silence_threshold=2.0)

    def pieces():
        for segment in segments:
            if progress:
                progress(min(99, round(segment.end / max(info.duration, 1) * 100)))
            yield segment
    cues = sentences(pieces(), speaker_turns)
    if not cues:
        raise ValueError('No speech was detected in this recording.')
    return cues


def _diarizer():
    """(its model's folder, its Python) of speaker detection on this computer."""
    py = WEB / 'vendor' / 'diarization' / 'Scripts' / 'python.exe'
    if not py.is_file():
        py = WEB / 'vendor' / 'diarization' / 'bin' / 'python'
    return WEB / 'vendor' / 'models' / 'speaker-diarization-community-1', py


def diarization_ready():
    """Is speaker detection installed (Setup speaker detection.bat)? Without it, the Transcribe
    button on this computer writes the lines without the speakers."""
    model_dir, py = _diarizer()
    return model_dir.is_dir() and py.is_file()


def diarize(audio):
    """Identify up to two dialogue speakers and a third explanation voice locally."""
    model_dir, py = _diarizer()
    helper = WEB / 'diarize_audio.py'
    if not model_dir.is_dir() or not py.is_file():
        raise FileNotFoundError('Automatic speaker detection is not set up. Run Setup speaker detection.bat first.')
    result = subprocess.run([str(py), str(helper)], input=audio.tobytes(), capture_output=True, timeout=1800)
    if result.returncode:
        print(f'Speaker detection failed: {result.stderr[-3000:].decode("utf-8", "replace")}', file=sys.stderr)
        raise ValueError('Automatic speaker detection failed. Check the app window for details and try again.')
    try:
        output = result.stdout.decode('utf-8').strip().splitlines()
        return json.loads(output[-1])
    except (ValueError, TypeError) as error:
        raise ValueError('Speaker detection returned an invalid result.') from error


def language_code(language):
    """en-US, zh_CN, zh-Hans … -> en, zh; nothing or 'auto' -> None (the language found by itself)."""
    lang = str(language or '').strip().lower().replace('_', '-')
    if not lang or lang == 'auto':
        return None
    return 'zh' if lang.startswith('zh-') or lang == 'zh' else lang.split('-', 1)[0]


def local_ready():
    """Is speech recognition on this computer installed (Setup transcription.bat)?"""
    return (MODEL_DIR / 'model.bin').is_file() and (PACKAGES / 'faster_whisper').is_dir()


# ---------------------------------------------------------------- ElevenLabs (Speech to Text)

class SpeechError(ValueError):
    """What ElevenLabs said no to, or could not be reached: told to the user as it is."""


def speech_settings(config):
    """(key, model, engine) of transcription: ElevenLabs's key and model (web/server-config.json
    'speechKey', 'speechModel'; else ELEVENLABS_API_KEY) and the way used: 'eleven' when there is a
    key, unless this computer was chosen ('speechEngine': 'local'); else 'local'."""
    key = config.get('speechKey') or os.environ.get('ELEVENLABS_API_KEY', '')
    engine = 'local' if not key or config.get('speechEngine') == 'local' else 'eleven'
    return key, config.get('speechModel') or SPEECH_MODEL, engine


def _backup_key(key):
    """The backup key of ElevenLabs (services.py), when `key` is the main one and there is one."""
    import auth
    config = auth.config()
    backup = config.get('speechKey2')
    return backup if backup and key == config.get('speechKey') else None


def _note(service, ok, said=''):
    try:
        import services
        services.noted(service, ok, said)
    except Exception:
        pass


def _ffmpeg():
    """The app's ffmpeg (web/vendor/python: imageio-ffmpeg), or None."""
    if str(PACKAGES) not in sys.path and PACKAGES.is_dir():
        sys.path.append(str(PACKAGES))
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def _sound_of(path):
    """(bytes, file name, kind) sent to ElevenLabs: of a video only its sound (much less to send),
    when ffmpeg is here; else the file as it is (ElevenLabs takes video too)."""
    path = Path(path)
    ext = path.suffix.lower()
    if ext in VIDEO and (exe := _ffmpeg()):
        try:
            out = subprocess.run([exe, '-v', 'error', '-i', str(path), '-vn', '-ac', '1', '-ar', '22050', '-b:a', '64k',
                                  '-f', 'mp3', 'pipe:1'], capture_output=True, timeout=900)
            if not out.returncode and len(out.stdout) > 1000:
                return out.stdout, f'{path.stem}.mp3', 'audio/mpeg'
        except (OSError, subprocess.SubprocessError):
            pass
    return path.read_bytes(), f'sound{ext}', MEDIA.get(ext, 'application/octet-stream')


def _said(error):
    """ElevenLabs's own words in an error ({"detail": {"message": …}} or [{"msg": …}])."""
    try:
        detail = json.loads(error.read().decode('utf-8')).get('detail')
    except Exception:
        return '', ''
    finally:
        error.close()
    if isinstance(detail, dict):
        return str(detail.get('status') or ''), str(detail.get('message') or '')
    if isinstance(detail, list):
        return '', '; '.join(str(d.get('msg', '')) for d in detail if isinstance(d, dict))
    return '', str(detail or '')


def eleven(path, key, model=SPEECH_MODEL, language=None, speakers=True, timeout=1800, info=None):
    """The timed lines of a recording or video, written down by ElevenLabs: as transcribe() gives
    ([{"t", "x", "words", "speaker"?}]). language: its code (en, zh …), or None: found by itself.
    info (a dict): its 'language' put in (as the translator knows it: spoken_language).
    The main key refused, or out of credits: the backup key (services.py), if there is one."""
    try:
        out = _eleven(path, key, model, language, speakers, timeout, info)
    except SpeechError as e:
        backup = _backup_key(key)
        if backup and ('accept the key' in str(e) or 'no credits' in str(e)):
            _note('speechKey', False, str(e))
            out = _eleven(path, backup, model, language, speakers, timeout, info)
            _note('speechKey2', True)
            return out
        _note('speechKey', False, str(e))
        raise
    _note('speechKey', True)
    return out


def _eleven(path, key, model, language, speakers, timeout, info):
    if not key:
        raise SpeechError('There is no key of ElevenLabs yet.')
    data, name, kind = _sound_of(path)
    fields = {'model_id': model, 'timestamps_granularity': 'word', 'tag_audio_events': 'false',
              'diarize': 'true' if speakers else 'false'}
    if language_code(language):
        fields['language_code'] = language_code(language)
    boundary = uuid.uuid4().hex
    body = b''.join(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode('utf-8')
                    for k, v in fields.items())
    body += (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\n'
             f'Content-Type: {kind}\r\n\r\n').encode('utf-8') + data + f'\r\n--{boundary}--\r\n'.encode('utf-8')
    req = urllib.request.Request(f'{SPEECH_API}/speech-to-text', body,
                                 {'Content-Type': f'multipart/form-data; boundary={boundary}', 'xi-api-key': key})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            d = json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        status, said = _said(e)
        if e.code == 401 or status in ('invalid_api_key', 'missing_permissions'):
            raise SpeechError('ElevenLabs did not accept the key. Use a key of ElevenLabs (elevenlabs.io → Developers → '
                              'API keys) that may use Speech to Text: “Change the key”, under Speech recognition.')
        if e.code == 402 or status in ('quota_exceeded', 'payment_required'):
            raise SpeechError('Your ElevenLabs account has no credits left for this. Add some at elevenlabs.io, then try again.')
        if e.code == 429:
            raise SpeechError('ElevenLabs is busy (too many at once). Try again in a minute.')
        raise SpeechError(f'ElevenLabs said no ({e.code}){": " + said[:300] if said else ""}.')
    except (urllib.error.URLError, TimeoutError, OSError):
        raise SpeechError('ElevenLabs could not be reached (no internet?). Try again.')
    except ValueError:
        raise SpeechError('ElevenLabs sent back something that is not a transcript. Try again.')
    if info is not None:
        info['language'] = spoken_language(d.get('language_code')) or spoken_language(language) or 'en'
    cues = eleven_cues(d)
    if not cues:
        raise ValueError('No speech was detected in this recording.')
    return cues


# ElevenLabs's codes of languages (ISO 639-3, or 639-1) -> the translator's (translate.SOURCES).
THREE = {'eng': 'en', 'zho': 'zh', 'cmn': 'zh', 'yue': 'zh', 'ara': 'ar', 'fra': 'fr', 'deu': 'de', 'spa': 'es',
         'ita': 'it', 'por': 'pt', 'rus': 'ru', 'tur': 'tr', 'fas': 'fa', 'pes': 'fa', 'urd': 'ur', 'hin': 'hi',
         'jpn': 'ja', 'kor': 'ko', 'nld': 'nl', 'pol': 'pl', 'ind': 'id', 'vie': 'vi', 'tha': 'th'}


def spoken_language(code):
    """'eng', 'en', 'zh' … -> 'en', 'zh-Hans' …: what the lines are translated from; None if not known."""
    code = str(code or '').strip().lower().replace('_', '-')
    if not code or code == 'auto':
        return None
    code = THREE.get(code.split('-')[0], code.split('-')[0])
    return 'zh-Hans' if code == 'zh' else code if len(code) == 2 else None


def eleven_cues(d):
    """ElevenLabs's words -> lines, a sentence each (sentences()): the spacing before a word kept
    with it (as Whisper's), the speakers named A, B and explanation (from the third on) in the order
    they first speak — none when only one speaks."""
    words, order, space = [], {}, ''
    for w in d.get('words') or []:
        kind, text = w.get('type'), str(w.get('text') or '')
        if kind == 'spacing':
            space += text or ' '
            continue
        if kind != 'word' or not text.strip() or w.get('start') is None:
            continue
        who = w.get('speaker_id')
        if who is not None:
            order.setdefault(who, len(order))
        start = float(w['start'])
        end = max(start, float(w.get('end') if w.get('end') is not None else start))
        words.append(SimpleNamespace(word=(space if words else '') + text, start=start, end=end, who=who))
        space = ''
    turns = []
    if len(order) > 1:
        role = lambda who: 'A' if order[who] == 0 else 'B' if order[who] == 1 else 'explanation'  # noqa: E731
        for w in words:
            name = role(w.who) if w.who is not None else None
            if turns and turns[-1]['speaker'] == name:
                turns[-1]['end'] = w.end + 0.001  # (a word of no length still in its turn)
            else:
                turns.append({'start': w.start, 'end': w.end + 0.001, 'speaker': name})
    return sentences([SimpleNamespace(words=words)], turns)


# ---------------------------------------------------------------- The Transcribe button (server)

def resolve(src, books, locate=None):
    """Only the disc's recordings without a script may be transcribed; never other files.
    locate(src): the folder of the recording's disc (level) and its address there."""
    if not isinstance(src, str) or not books:
        raise ValueError('Choose an audio or video from this book.')
    assets = [a for b in books['books'] for p in b['pages'] for a in p['a']
              if a.get('t') in ('audio', 'video') and a.get('src') == src]
    if not assets or not asset_id(src):
        raise ValueError('This recording is not in the book index.')
    if any(a.get('script') and not a.get('auto') for a in assets):
        raise ValueError('This recording already has a script.')
    root, rel = locate(src) if locate else (ROOT, src)
    root = Path(root).resolve()
    path = (root / rel.lstrip('/')).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise ValueError('The recording file could not be found.')
    return path


def cache_id(src):
    aid = asset_id(src)
    if aid:
        return aid
    match = re.fullmatch(r'/lib/(L[0-9a-f]{10})/migration-media/([0-9a-f]{64})\.(?:mp3|wav|ogg|m4a|mp4|webm)', src or '')
    return f'{match.group(1)}-{match.group(2)}' if match else None


def status(src, path, language='en'):
    aid = cache_id(src)
    if not aid:
        return {'state': 'error', 'error': 'This recording is not in the book index.'}
    with _lock:
        job = _jobs.get(aid)
        if job and job.get('state') in ('queued', 'running', 'error'):
            return dict(job)
    cues = saved(aid)
    if cues:
        return {'state': 'done', 'cues': cues, 'generated': True}
    with _lock:
        return dict(_jobs.get(aid, {'state': 'idle'}))


def start(src, path, language='en', force=False, how=None):
    """Transcribe a recording in the background (how: speech_settings(), or None: this computer)."""
    current = status(src, path, language)
    if current['state'] in ('queued', 'running') or current['state'] == 'done' and not force:
        return current
    aid = cache_id(src)
    token = uuid.uuid4().hex  # (a job taken out of the queue and started again: only the new one runs)
    with _lock:
        current = _jobs.get(aid)
        if current and current['state'] in ('queued', 'running'):
            return dict(current)
        _jobs[aid] = {'state': 'queued', 'message': 'Waiting to transcribe…', 'token': token}
        _stopping.pop(aid, None)
    online = bool(how and how[2] == 'eleven')
    (_online if online else _pool).submit(_run, aid, path, language, how, True, token)
    return {'state': 'queued', 'message': 'Waiting to transcribe…'}


def stop(srcs, pause=False):
    """Pause (kept to go on later) or cancel the transcription of these recordings: the ones waiting
    leave the queue at once; one being written on this computer stops at its next step; one being
    written by ElevenLabs is finished (it is paid already). Returns how many were stopped or are stopping."""
    n = 0
    for src in srcs:
        aid = cache_id(src)
        with _lock:
            job = _jobs.get(aid) or {}
            if job.get('state') == 'queued':
                if pause:
                    _jobs[aid] = {'state': 'paused', 'message': 'Paused'}
                else:
                    del _jobs[aid]
                n += 1
            elif job.get('state') == 'running' and job.get('engine') != 'eleven':
                _stopping[aid] = 'pause' if pause else 'stop'
                n += 1
    return n


def file_state(src):
    """One recording's transcription: {'state': idle, queued, running, paused, error or done, 'progress' (percent,
    on this computer), 'message', 'error'}."""
    aid = cache_id(src)
    with _lock:
        job = dict(_jobs.get(aid) or {})
        stopping = aid in _stopping
    state = job.get('state')
    if state in ('queued', 'running', 'paused', 'error'):
        return {'state': state, 'progress': job.get('progress'), 'message': 'Stopping…' if stopping else job.get('message', ''),
                'error': job.get('error', '')}
    if state == 'done' or (CACHE / f'{aid}.json').is_file():
        return {'state': 'done'}
    return {'state': 'idle'}


def done_by(aid, engine=None):
    """Is a transcript of it saved — made by ElevenLabs, when engine is 'eleven'?"""
    try:
        made = json.loads((CACHE / f'{aid}.json').read_text(encoding='utf-8')).get('model')
    except (OSError, ValueError, AttributeError):
        return False
    return str(made or '').startswith('elevenlabs/') if engine == 'eleven' else True


def counts(srcs, engine=None):
    """How far the transcription of these recordings is: {'done', 'running' (or waiting), 'failed'}
    (engine 'eleven': done only by ElevenLabs)."""
    done = running = failed = 0
    for src in srcs:
        aid = cache_id(src)
        with _lock:
            job = dict(_jobs.get(aid) or {})
        if job.get('state') in ('queued', 'running'):
            running += 1
        elif job.get('state') == 'error':
            failed += 1
        elif engine == 'eleven' and done_by(aid, engine) or engine != 'eleven' and (
                job.get('state') == 'done' or (CACHE / f'{aid}.json').is_file()):
            done += 1
    return {'done': done, 'running': running, 'failed': failed}


def _update(aid, **values):
    with _lock:
        _jobs[aid] = values


def _run(aid, path, language='en', how=None, keep=True, token=None):
    """keep: saved in web/transcripts (a book's recording); else only told (a file: file_status)."""
    if token:
        with _lock:
            if (_jobs.get(aid) or {}).get('token') != token:  # (cancelled or paused while it waited)
                return
    try:
        key, model_id, engine = how or ('', '', 'local')
        if engine == 'eleven':
            _update(aid, state='running', message='ElevenLabs is writing it down…', engine='eleven')
            found = {}
            cues = eleven(path, key, model_id, language, info=found)
            made_by, spoken = f'elevenlabs/{model_id}', found.get('language')
        else:
            _update(aid, state='running', message='Preparing speech recognition…')
            def progress(p):
                if aid in _stopping:
                    raise Stopped()
                _update(aid, state='running', message='Transcribing…', progress=p)
            cues = transcribe(path, threads=min(4, os.cpu_count() or 2), progress=progress, language=language or 'en',
                              speakers=diarization_ready())
            made_by, spoken = None, spoken_language(language) or 'en'
        if keep:
            save(aid, cues, made_by)
        _update(aid, state='done', cues=cues, generated=True, at=time.time(), language=spoken)
    except Stopped:
        if _stopping.pop(aid, 'stop') == 'pause':
            _update(aid, state='paused', message='Paused')
        else:
            with _lock:
                _jobs.pop(aid, None)
    except ImportError:
        _update(aid, state='error', at=time.time(), error='Speech recognition is not set up. Add a key of ElevenLabs (Speech recognition…), '
                                         'or run Setup transcription.bat and restart the app.')
    except (ValueError, FileNotFoundError) as error:
        _update(aid, state='error', error=str(error), at=time.time())
    except Exception as error:
        print(f'Transcription failed: {error}', file=sys.stderr)
        _update(aid, state='error', error='Transcription failed. Check the app window for details and try again.', at=time.time())
    finally:
        _stopping.pop(aid, None)
        if not keep:
            shutil.rmtree(Path(path).parent, ignore_errors=True)


# ---------------------------------------------------------------- Transcribe a file (any one)

def start_file(name, data, language=None, how=None, check=None):
    """Any audio or video file transcribed (not kept: its lines told by file_status, for an hour):
    the job's id. Its lines' translations are kept under its script id (AU-<its content's
    sha256>, of the book 'files'): the same file transcribed again finds them."""
    ext = Path(os.path.basename(str(name or '').replace('\\', '/'))).suffix.lower()
    if ext not in MEDIA:
        raise ValueError('Choose an audio or video file (MP3, M4A, WAV, OGG, FLAC, MP4, WebM, MOV …).')
    if not data:
        raise ValueError('The file is empty.')
    _forget_old_files()
    job = f'F-{uuid.uuid4().hex}'
    folder = FILES / job
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f'file{ext}'
    path.write_bytes(data)
    if check:  # (server.py: its length counted against the account's minutes; refused: nothing kept)
        try:
            check(path)
        except Exception:
            shutil.rmtree(folder, ignore_errors=True)
            raise
    with _lock:
        _jobs[job] = {'state': 'queued', 'message': 'Waiting to transcribe…', 'at': time.time()}
        _scripts[job] = f'AU-{hashlib.sha256(data).hexdigest()[:32]}'
    online = bool(how and how[2] == 'eleven')
    (_online if online else _pool).submit(_run, job, path, language, how, False)
    return job


def file_status(job):
    with _lock:
        found = _jobs.get(job) if FILE_JOB.match(str(job or '')) else None
        if not found:
            return {'state': 'error', 'error': 'This transcription is not known (any more). Start it again.'}
        return {**found, 'script': _scripts.get(job)}


def _forget_old_files(hours=1):
    """Files' results told for an hour, then forgotten (and their files, if left)."""
    old = time.time() - hours * 3600
    with _lock:
        for job in [j for j, v in _jobs.items() if j.startswith('F-') and v.get('state') in ('done', 'error') and v.get('at', 0) < old]:
            del _jobs[job]
            _scripts.pop(job, None)
    if FILES.is_dir():
        for folder in FILES.iterdir():
            try:
                if folder.stat().st_mtime < old - 3 * 3600:
                    shutil.rmtree(folder, ignore_errors=True)
            except OSError:
                pass

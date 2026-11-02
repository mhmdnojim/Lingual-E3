"""Speech recognition on this computer (faster-whisper) for the disc's recordings and videos that
have no original script.

Each result is kept in web/transcripts/<id>.json ({"model", "cues"}; the id is the recording's
folder on the disc, e.g. AU-0655e61e4a3d6). web/tools/build_data.py turns these into ordinary
scripts (web/data/scripts/<id>.json, marked "auto" in books.json), so they are shown, repeated
and translated like the disc's own. web/tools/transcribe_all.py does all recordings at once; the
Transcribe button (POST /api/transcribe) does one in the background.

Setup transcription.bat installs the programs (web/vendor/python) and the English model
(web/vendor/models/base.en); after that no internet is needed.
"""
import json
import os
import re
import subprocess
import sys
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

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

_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='transcribe')
_lock = threading.Lock()
_jobs = {}
_models = {}


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


def save(aid, cues):
    CACHE.mkdir(parents=True, exist_ok=True)
    temp = CACHE / f'{aid}.{uuid.uuid4().hex}.tmp'
    temp.write_text(json.dumps({'model': MODEL, 'cues': cues}, ensure_ascii=False, separators=(',', ':')),
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
            raise FileNotFoundError('The speech model is missing. Run Setup transcription.bat, then restart the app.')
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
    lang = str(language or 'en').lower().replace('_', '-')
    lang_code = 'zh' if lang.startswith('zh-') or lang == 'zh' else lang.split('-', 1)[0]
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


def diarize(audio):
    """Identify up to two dialogue speakers and a third explanation voice locally."""
    model_dir = WEB / 'vendor' / 'models' / 'speaker-diarization-community-1'
    py = WEB / 'vendor' / 'diarization' / 'Scripts' / 'python.exe'
    if not py.is_file():
        py = WEB / 'vendor' / 'diarization' / 'bin' / 'python'
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


def start(src, path, language='en', force=False):
    current = status(src, path, language)
    if current['state'] in ('queued', 'running') or current['state'] == 'done' and not force:
        return current
    aid = cache_id(src)
    with _lock:
        current = _jobs.get(aid)
        if current and current['state'] in ('queued', 'running'):
            return dict(current)
        _jobs[aid] = {'state': 'queued', 'message': 'Waiting to transcribe…'}
    _pool.submit(_run, aid, path, language)
    return {'state': 'queued', 'message': 'Waiting to transcribe…'}


def _update(aid, **values):
    with _lock:
        _jobs[aid] = values


def _run(aid, path, language='en'):
    try:
        _update(aid, state='running', message='Preparing speech recognition…')
        progress = lambda p: _update(aid, state='running', message='Transcribing…', progress=p)  # noqa: E731
        cues = transcribe(path, threads=min(4, os.cpu_count() or 2), progress=progress, language=language)
        save(aid, cues)
        _update(aid, state='done', cues=cues, generated=True)
    except ImportError:
        _update(aid, state='error', error='Speech recognition is not installed. Run Setup transcription.bat, then restart the app.')
    except (ValueError, FileNotFoundError) as error:
        _update(aid, state='error', error=str(error))
    except Exception as error:
        print(f'Transcription failed: {error}', file=sys.stderr)
        _update(aid, state='error', error='Transcription failed. Check the app window for details and try again.')

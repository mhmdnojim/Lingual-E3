"""The online services the app uses and their keys (the API part of the Admin page: only the owner
of the website sees it, server.py /api/admin/services). Keys are kept in web/server-config.json
(auth.config, never served); the page is told only whether a key is saved, its last 4 characters
and when it was saved.

Paid, with a key:
- ElevenLabs (the scripts of recordings): a main key and a backup key, used when the main one is
  refused or has no credits left (transcription.py);
- OpenAI: the key of the pictures made by AI (pictures.py) and of the page layouts (layout_ai.py),
  each with its model;
- Google Cloud Translation (the official, paid translator) and Azure Speech (Microsoft's paid
  voices): backups, used only when the free translator or the free Natural voices fail
  (translate.py, tts.py).
Free, without a key: Google's free translator and Microsoft's Natural voices (edge-tts): shown as
working or not (the last time they were used, or tested now).
"""
import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

import auth

# key in the config: (name, which group, a note for the owner)
SERVICES = {
    'speechKey': ('ElevenLabs (main key)', 'scripts', 'elevenlabs.io → Developers → API keys, with Speech to Text allowed.'),
    'speechKey2': ('ElevenLabs (backup key)', 'scripts', 'Used when the main key is refused or its credits are used up (another account).'),
    'imageKey': ('OpenAI (pictures made by AI)', 'openai', 'platform.openai.com → API keys. Each picture costs a few cents.'),
    'layoutKey': ('OpenAI (page layouts by AI)', 'openai', 'Leave empty to use the pictures key for layouts too.'),
    'googleTranslateKey': ('Google Cloud Translation (paid backup)', 'backup',
                           'console.cloud.google.com → APIs → Cloud Translation API → Credentials → API key. Used only when the free translator fails.'),
    'azureSpeechKey': ('Azure Speech (paid backup voices)', 'backup',
                       'portal.azure.com → Speech service → Keys and Endpoint (key and region). Used only when the free Natural voices fail.'),
}
MODELS = {'speechModel': 'scribe_v2', 'imageModel': 'gpt-image-1', 'layoutModel': 'gpt-4.1'}
TEXTS = {'azureSpeechRegion': 'eastasia'}
FREE = {'translator': 'Google’s free translator', 'voices': 'Microsoft’s Natural voices (free)'}

_lock = threading.Lock()
_state = {}  # service -> {'ok': bool, 'at': time, 'said': str}  (the last time it was used or tested)


class ServiceError(Exception):
    pass


def noted(service, ok, said=''):
    """Said by the code that uses a service: it worked (or not) just now."""
    with _lock:
        _state[service] = {'ok': bool(ok), 'at': int(time.time()), 'said': str(said or '')[:200]}


def _hint(key):
    return key[-4:] if len(key) >= 8 else '••••'


def listing():
    """For the owner: every service, whether its key is saved (never the key), its model or
    region, when it was saved, and the last known state."""
    config = auth.config()
    saved_at = config.get('savedAt') or {}
    out = []
    for key, (name, group, note) in SERVICES.items():
        value = str(config.get(key) or '')
        row = {'key': key, 'name': name, 'group': group, 'note': note, 'saved': bool(value),
               'hint': _hint(value) if value else '', 'savedAt': saved_at.get(key), 'state': _state.get(key)}
        if key == 'speechKey':
            row['model'] = config.get('speechModel') or MODELS['speechModel']
            row['engine'] = 'local' if config.get('speechEngine') == 'local' else 'eleven'
        elif key == 'imageKey':
            row['model'] = config.get('imageModel') or MODELS['imageModel']
        elif key == 'layoutKey':
            row['model'] = config.get('layoutModel') or MODELS['layoutModel']
            row['usesImageKey'] = not value and bool(config.get('imageKey'))
        elif key == 'azureSpeechKey':
            row['region'] = config.get('azureSpeechRegion') or TEXTS['azureSpeechRegion']
        out.append(row)
    free = [{'key': k, 'name': name, 'state': _state.get(k)} for k, name in FREE.items()]
    return {'services': out, 'free': free}


def save(changes):
    """{key: value} of keys (a key, '' takes it out), models and the Azure region. Returns listing()."""
    if not isinstance(changes, dict):
        raise ServiceError('Bad request.')
    config = auth.config()
    saved_at = dict(config.get('savedAt') or {})
    clean = {}
    for k, v in changes.items():
        v = str(v or '').strip()
        if k in SERVICES:
            if len(v) > 300 or any(c in v for c in '\r\n\t "\''):
                raise ServiceError(f'{SERVICES[k][0]}: this is not a key.')
            clean[k] = v or None
            if v:
                saved_at[k] = int(time.time())
            else:
                saved_at.pop(k, None)
            with _lock:
                _state.pop(k, None)
        elif k in MODELS:
            if v and not __import__('re').fullmatch(r'[A-Za-z0-9_.:\-]{1,100}', v):
                raise ServiceError('A model name has letters, digits, dots and dashes only.')
            clean[k] = v or None
        elif k in TEXTS:
            if v and not __import__('re').fullmatch(r'[a-z0-9]{2,40}', v):
                raise ServiceError('The Azure region is a short name such as eastasia or westeurope.')
            clean[k] = v or None
        else:
            raise ServiceError('Unknown setting.')
    clean['savedAt'] = saved_at
    auth.set_config(**clean)
    return listing()


# ---------------------------------------------------------------- Tests ("does the key work?")

def _http(req, timeout=20):
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        with e:
            return e.code, e.read().decode('utf-8', 'replace')[:300]
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise ServiceError(f'Could not be reached ({getattr(e, "reason", e)}).')


def test(service):
    """Try a service now: {'ok', 'said'} (noted too). A key is tried with the cheapest request."""
    config = auth.config()
    try:
        if service in ('speechKey', 'speechKey2'):
            key = config.get(service)
            if not key:
                raise ServiceError('No key is saved.')
            import transcription
            status, text = _http(urllib.request.Request(f'{transcription.SPEECH_API}/user/subscription', headers={'xi-api-key': key}))
            if status == 200:
                d = json.loads(text)
                used, total = d.get('character_count', 0), d.get('character_limit', 0)
                said = f"The key works ({d.get('tier', 'plan')}: {used:,} of {total:,} characters used this period)." if total else 'The key works.'
            elif status in (401, 403):
                raise ServiceError('ElevenLabs does not accept this key.')
            else:
                raise ServiceError(f'ElevenLabs answered {status}.')
        elif service in ('imageKey', 'layoutKey'):
            key = config.get(service) or (config.get('imageKey') if service == 'layoutKey' else '')
            if not key:
                raise ServiceError('No key is saved.')
            import pictures
            status, text = _http(urllib.request.Request(f'{pictures.AI_API}/models', headers={'Authorization': f'Bearer {key}'}))
            if status == 200:
                model = config.get('imageModel' if service == 'imageKey' else 'layoutModel') or MODELS['imageModel' if service == 'imageKey' else 'layoutModel']
                names = {m.get('id') for m in json.loads(text).get('data', []) if isinstance(m, dict)}
                said = f'The key works. The model {model} is {"available" if model in names or not names else "NOT in the list of this account’s models"}.'
            elif status == 401:
                raise ServiceError('OpenAI does not accept this key.')
            else:
                raise ServiceError(f'OpenAI answered {status}.')
        elif service == 'googleTranslateKey':
            key = config.get(service)
            if not key:
                raise ServiceError('No key is saved.')
            import translate
            said = translate.cloud_translate(['Hello'], 'fr', 'en', key)[0]
            said = f'The key works (“Hello” → “{said}”).'
        elif service == 'azureSpeechKey':
            key = config.get(service)
            if not key:
                raise ServiceError('No key is saved.')
            import tts
            n = tts.azure_voice_count(key, config.get('azureSpeechRegion') or TEXTS['azureSpeechRegion'])
            said = f'The key works ({n} voices in this region).'
        elif service == 'translator':
            import translate
            said = translate._by_gtx('fr', [['Hello']], 'en').get('Hello', '')
            if not said:
                raise ServiceError('No answer.')
            said = f'Working (“Hello” → “{said}”).'
        elif service == 'voices':
            import tts
            voices = tts.list_voices('en')
            if not voices:
                raise ServiceError('No voices came back.')
            said = f'Working ({len(voices)} English voices).'
        else:
            raise ServiceError('Unknown service.')
    except ServiceError as e:
        noted(service, False, str(e))
        return {'ok': False, 'said': str(e)}
    except Exception as e:  # (a service's own error: told as it is)
        noted(service, False, str(e))
        return {'ok': False, 'said': str(e)[:300] or e.__class__.__name__}
    noted(service, True, said)
    return {'ok': True, 'said': said}

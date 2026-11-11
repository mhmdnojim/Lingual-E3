"""The online services and their keys (web/services.py): the list says only whether a key is saved
and its last 4 characters; a key is saved, changed, taken out; a model and the Azure region are
checked; a test of each key reaches its service (stand-ins here) and says what it found; the
backups work: the free translator failed → Google Cloud Translation; the main ElevenLabs key
refused → the backup key; a Natural voice refused → Azure Speech, with word timings.

Run: python -m unittest web/tests/test_services.py
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest import mock

WEB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WEB / 'tools'))
sys.path.insert(0, str(WEB))
import auth  # noqa: E402
import services  # noqa: E402
import transcription  # noqa: E402
import translate  # noqa: E402
import tts  # noqa: E402

SEEN = []  # (path, headers) of every request the stand-in got


class Standin(BaseHTTPRequestHandler):
    """ElevenLabs, OpenAI, Google Cloud Translation and Azure, all in one: told apart by the path."""

    def answer(self):
        SEEN.append((self.path, dict(self.headers)))
        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n) if n else b''
        key = self.headers.get('xi-api-key') or self.headers.get('Ocp-Apim-Subscription-Key') or (self.headers.get('Authorization') or '')[7:]
        if self.path.startswith('/v1/user/subscription'):
            if key != 'good-eleven-key' and key != 'backup-eleven-key':
                return self.send(401, {'detail': {'status': 'invalid_api_key', 'message': 'no'}})
            return self.send(200, {'tier': 'starter', 'character_count': 1200, 'character_limit': 30000})
        if self.path.startswith('/v1/speech-to-text'):
            if key == 'good-eleven-key':
                return self.send(402, {'detail': {'status': 'quota_exceeded', 'message': 'out'}})
            if key == 'backup-eleven-key':
                return self.send(200, {'language_code': 'en', 'words': [
                    {'text': 'Hello', 'type': 'word', 'start': 0.1, 'end': 0.5, 'speaker_id': 'speaker_0'},
                    {'text': '.', 'type': 'word', 'start': 0.5, 'end': 0.6, 'speaker_id': 'speaker_0'}]})
            return self.send(401, {'detail': {'status': 'invalid_api_key', 'message': 'no'}})
        if self.path.startswith('/v1/models'):
            return self.send(200, {'data': [{'id': 'gpt-image-1'}, {'id': 'gpt-4.1'}]}) if key == 'sk-good' else self.send(401, {})
        if self.path.startswith('/language/translate/v2'):
            if b'key=cloud-good' not in body:
                return self.send(403, {'error': {'message': 'API key not valid'}})
            texts = [v for k, v in [p.split('=') for p in body.decode().split('&')] if k == 'q']
            return self.send(200, {'data': {'translations': [{'translatedText': 'Bonjour' if t == 'Hello' else 'X'} for t in texts]}})
        if self.path.endswith('/voices/list'):
            return self.send(200, [{'Name': 'a'}, {'Name': 'b'}]) if key == 'azure-good' else self.send(401, {})
        if self.path.endswith('/cognitiveservices/v1'):
            self.send_response(200 if key == 'azure-good' else 401)
            self.send_header('Content-Length', '3')
            self.end_headers()
            self.wfile.write(b'MP3')
            return None
        return self.send(404, {})

    def send(self, code, data):
        out = json.dumps(data).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    do_GET = do_POST = answer

    def log_message(self, *args):
        pass


class ServicesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Standin)
        cls.server.allow_reuse_address = True
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='lingua-services-test-')
        self.patches = [mock.patch.object(auth, 'CONFIG', str(Path(self.tmp.name) / 'server-config.json')),
                        mock.patch.object(transcription, 'SPEECH_API', self.url + '/v1'),
                        mock.patch.object(services, '_state', {}),
                        mock.patch.object(translate, 'CLOUD_URL', self.url + '/language/translate/v2'),
                        mock.patch.dict(__import__('os').environ, {'OPENAI_API_KEY': '', 'ELEVENLABS_API_KEY': ''})]
        for p in self.patches:
            p.start()
        import pictures
        self.patches.append(mock.patch.object(pictures, 'AI_API', self.url + '/v1'))
        self.patches[-1].start()
        SEEN.clear()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.tmp.cleanup()

    def test_saved_and_told(self):
        d = services.listing()
        self.assertEqual([s['key'] for s in d['services']], ['speechKey', 'speechKey2', 'imageKey', 'layoutKey', 'googleTranslateKey', 'azureSpeechKey'])
        self.assertTrue(all(not s['saved'] for s in d['services']))
        d = services.save({'speechKey': 'good-eleven-key', 'imageKey': 'sk-good', 'imageModel': 'gpt-image-1', 'azureSpeechRegion': 'westeurope'})
        rows = {s['key']: s for s in d['services']}
        self.assertEqual((rows['speechKey']['saved'], rows['speechKey']['hint']), (True, '-key'))
        self.assertTrue(rows['speechKey']['savedAt'])
        self.assertEqual((rows['layoutKey']['saved'], rows['layoutKey']['usesImageKey']), (False, True))
        self.assertEqual(rows['azureSpeechKey']['region'], 'westeurope')
        self.assertNotIn('good-eleven-key', json.dumps(d), 'the key itself is never told')
        self.assertEqual(auth.config()['speechKey'], 'good-eleven-key')
        d = services.save({'speechKey': ''})
        self.assertFalse({s['key']: s for s in d['services']}['speechKey']['saved'])
        self.assertNotIn('speechKey', auth.config())
        for bad in ({'speechKey': 'a key\nwith a line'}, {'imageModel': 'bad model!'}, {'azureSpeechRegion': 'East Asia'}, {'other': 'x'}, 'text'):
            with self.assertRaises(services.ServiceError, msg=bad):
                services.save(bad)

    def test_tested(self):
        services.save({'speechKey': 'good-eleven-key', 'speechKey2': 'wrong', 'imageKey': 'sk-good', 'googleTranslateKey': 'cloud-good', 'azureSpeechKey': 'azure-good'})
        with mock.patch.object(tts, 'azure_voice_count', lambda key, region: 2 if key == 'azure-good' else (_ for _ in ()).throw(RuntimeError('401'))):
            self.assertEqual(services.test('azureSpeechKey'), {'ok': True, 'said': 'The key works (2 voices in this region).'})
        self.assertEqual(services.test('speechKey'), {'ok': True, 'said': 'The key works (starter: 1,200 of 30,000 characters used this period).'})
        self.assertEqual(services.test('speechKey2'), {'ok': False, 'said': 'ElevenLabs does not accept this key.'})
        self.assertEqual(services.test('imageKey'), {'ok': True, 'said': 'The key works. The model gpt-image-1 is available.'})
        self.assertEqual(services.test('layoutKey')['ok'], True, 'the pictures key, for layouts too')
        self.assertEqual(services.test('googleTranslateKey'), {'ok': True, 'said': 'The key works (“Hello” → “Bonjour”).'})
        self.assertEqual(services.test('azureSpeechKey')['ok'], False)
        states = {s['key']: s['state']['ok'] for s in services.listing()['services']}
        self.assertEqual(states, {'speechKey': True, 'speechKey2': False, 'imageKey': True, 'layoutKey': True, 'googleTranslateKey': True, 'azureSpeechKey': False})
        self.assertEqual(services.test('no-such'), {'ok': False, 'said': 'Unknown service.'})
        services.save({'speechKey': ''})
        self.assertEqual(services.test('speechKey'), {'ok': False, 'said': 'No key is saved.'})

    def test_eleven_backup_key(self):
        services.save({'speechKey': 'good-eleven-key', 'speechKey2': 'backup-eleven-key'})
        path = Path(self.tmp.name) / 'a.mp3'
        path.write_bytes(b'\xff\xfb' + bytes(200))
        with mock.patch.object(transcription, '_ffmpeg', lambda: None):
            cues = transcription.eleven(path, 'good-eleven-key')
        self.assertEqual(cues[0]['x'], 'Hello.')
        self.assertEqual([p for p, _ in SEEN if 'speech-to-text' in p], ['/v1/speech-to-text'] * 2, 'the main key, then the backup')
        states = {s['key']: s['state']['ok'] for s in services.listing()['services'] if s['state']}
        self.assertEqual(states, {'speechKey': False, 'speechKey2': True})
        # No backup key: the refusal as it is.
        services.save({'speechKey2': ''})
        with mock.patch.object(transcription, '_ffmpeg', lambda: None), self.assertRaisesRegex(transcription.SpeechError, 'no credits'):
            transcription.eleven(path, 'good-eleven-key')

    def test_cloud_translation_backup(self):
        def failing(lang, paragraphs, src='en'):
            raise translate.Offline()
        with mock.patch.object(translate, 'ENGINES', (('chrome', failing), ('gtx', failing), ('cloud', translate._by_cloud))):
            found = {}
            with self.assertRaises(translate.TranslateError):  # (no key: the free ones' failure)
                translate._translate_paragraphs('fr', [['Hello']], found)
            services.save({'googleTranslateKey': 'cloud-good'})
            translate._translate_paragraphs('fr', [['Hello']], found)
        self.assertEqual(found, {'Hello': 'Bonjour'})
        states = {s['key']: s['state']['ok'] for s in services.listing()['services'] if s['state']}
        self.assertEqual(states, {'googleTranslateKey': True})
        self.assertEqual(services.listing()['free'][0]['state']['ok'], False, 'the free translator: not working')

    def test_azure_voice_backup(self):
        services.save({'azureSpeechKey': 'azure-good', 'azureSpeechRegion': 'eastasia'})
        import asyncio

        async def refused(text, voice, rate):
            raise RuntimeError('Invalid response status 403')
        with mock.patch.object(tts, '_speak', refused), mock.patch.object(tts, '_mp3_seconds', lambda mp3: 2.0), \
                mock.patch('urllib.request.urlopen') as opened:
            opened.return_value.__enter__.return_value.read.return_value = b'MP3'
            audio, bounds = asyncio.run(tts._speak_again('Hello big world', 'en-US-GuyNeural', 0))
        self.assertEqual(audio, b'MP3')
        self.assertEqual([w for _, _, w in bounds], ['Hello', 'big', 'world'])
        self.assertAlmostEqual(bounds[-1][1], 2.0, places=5)
        self.assertAlmostEqual(bounds[0][1], 2.0 * 5 / 13, places=5, msg='spread by the length of the words')
        req = opened.call_args[0][0]
        self.assertIn('eastasia.tts.speech.microsoft.com', req.full_url)
        self.assertEqual(req.get_header('Ocp-apim-subscription-key'), 'azure-good')
        self.assertIn(b'en-US-GuyNeural', req.data)
        # Without a key: the refusal as it was.
        services.save({'azureSpeechKey': ''})
        with mock.patch.object(tts, '_speak', refused), self.assertRaisesRegex(RuntimeError, '403'):
            asyncio.run(tts._speak_again('Hello', 'en-US-GuyNeural', 0))


if __name__ == '__main__':
    unittest.main()

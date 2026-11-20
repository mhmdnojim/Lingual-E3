"""Transcription by OpenAI (Whisper on the internet; web/transcription.py): its key is the OpenAI key of the Admin page,
the choice is kept, what is sent (the key as Bearer, the model, word times, the language), its words made into lines,
Chinese without spaces, what it says no to told plainly. A stand-in for OpenAI.

Run: python -m unittest web/tests/test_openai_speech.py
"""
import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import transcription  # noqa: E402

HELLO = {'language': 'english', 'words': [
    {'word': 'Hi', 'start': 0.0, 'end': 0.3}, {'word': 'Jenny.', 'start': 0.35, 'end': 0.8},
    {'word': 'How', 'start': 2.0, 'end': 2.2}, {'word': 'are', 'start': 2.25, 'end': 2.4}, {'word': 'you?', 'start': 2.45, 'end': 2.8}]}


class Standin(BaseHTTPRequestHandler):
    seen = []
    answer = (200, HELLO)

    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        Standin.seen.append({'path': self.path, 'auth': self.headers.get('Authorization'), 'body': body})
        code, d = Standin.answer
        data = json.dumps(d).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


class OpenAiSpeech(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Standin)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.api = mock.patch.object(transcription, 'OPENAI_API', f'http://127.0.0.1:{cls.server.server_port}/v1')
        cls.api.start()

    @classmethod
    def tearDownClass(cls):
        cls.api.stop()
        cls.server.shutdown()

    def setUp(self):
        Standin.seen.clear()
        Standin.answer = (200, HELLO)
        self.tmp = tempfile.TemporaryDirectory()
        self.mp3 = Path(self.tmp.name) / 'track.mp3'
        self.mp3.write_bytes(b'ID3 sound')

    def tearDown(self):
        self.tmp.cleanup()

    def test_settings(self):
        with mock.patch.dict('os.environ', {'OPENAI_API_KEY': '', 'ELEVENLABS_API_KEY': ''}):
            self.assertEqual(transcription.speech_settings({'speechEngine': 'openai', 'layoutKey': 'sk-l', 'imageKey': 'sk-i'}),
                             ('sk-l', 'whisper-1', 'openai'))
            self.assertEqual(transcription.speech_settings({'speechEngine': 'openai', 'imageKey': 'sk-i'})[0], 'sk-i', 'the pictures key too')
            self.assertEqual(transcription.speech_settings({'speechKey': 'k1'})[2], 'eleven', 'not chosen: as before')

    def test_lines_and_what_is_sent(self):
        info = {}
        cues = transcription.openai_transcribe(self.mp3, 'sk-test', language='en-US', info=info)
        self.assertEqual([c['x'] for c in cues], ['Hi Jenny.', 'How are you?'])
        self.assertEqual(cues[1]['t'], 2000)
        self.assertEqual(info['language'], 'en')
        sent = Standin.seen[0]
        self.assertEqual((sent['path'], sent['auth']), ('/v1/audio/transcriptions', 'Bearer sk-test'))
        for part in (b'whisper-1', b'verbose_json', b'timestamp_granularities[]', b'name="language"\r\n\r\nen'):
            self.assertIn(part, sent['body'])

    def test_language_found_by_itself(self):
        transcription.openai_transcribe(self.mp3, 'sk-test')
        self.assertNotIn(b'name="language"', Standin.seen[0]['body'])

    def test_chinese_has_no_spaces(self):
        Standin.answer = (200, {'language': 'chinese', 'words': [{'word': '你', 'start': 0, 'end': 0.2}, {'word': '好。', 'start': 0.2, 'end': 0.5}]})
        info = {}
        self.assertEqual([c['x'] for c in transcription.openai_transcribe(self.mp3, 'sk-test', info=info)], ['你好。'])
        self.assertEqual(info['language'], 'zh-Hans')

    def test_no_to_told_plainly(self):
        for code, body, said in ((401, {'error': {'message': 'bad'}}, 'did not accept the key'),
                                 (429, {'error': {'code': 'insufficient_quota'}}, 'no credit'),
                                 (429, {'error': {'code': 'rate_limit'}}, 'busy'),
                                 (400, {'error': {'message': 'Invalid file format'}}, 'Invalid file format')):
            Standin.answer = (code, body)
            with self.assertRaises(transcription.SpeechError) as caught:
                transcription.openai_transcribe(self.mp3, 'sk-secret')
            self.assertIn(said, str(caught.exception))
            self.assertNotIn('sk-secret', str(caught.exception))
        with self.assertRaises(transcription.SpeechError):
            transcription.openai_transcribe(self.mp3, '')
        Standin.answer = (200, {'language': 'english', 'words': []})
        with self.assertRaises(ValueError):
            transcription.openai_transcribe(self.mp3, 'sk-test')

    def test_big_sound_without_ffmpeg(self):
        with mock.patch.object(transcription, 'OPENAI_LIMIT', 4), mock.patch.object(transcription, '_ffmpeg', return_value=None):
            with self.assertRaises(transcription.SpeechError) as caught:
                transcription.openai_transcribe(self.mp3, 'sk-test')
        self.assertIn('25 MB', str(caught.exception))

    def test_pieces_are_put_one_after_the_other(self):
        class Fake:
            def __init__(self, name):
                self.name = name

            def __lt__(self, other):
                return self.name < other.name

            def read_bytes(self):
                return b'x'

        with mock.patch.object(transcription, 'OPENAI_LIMIT', 4), mock.patch.object(transcription, '_ffmpeg', return_value='ffmpeg'), \
                mock.patch('subprocess.run'), mock.patch.object(Path, 'glob', return_value=[Fake('p0000.mp3'), Fake('p0001.mp3')]):
            out = transcription.openai_transcribe(self.mp3, 'sk-test')
        self.assertEqual(len(Standin.seen), 2)
        # the second piece's words are 20 minutes later
        self.assertEqual([c['t'] for c in out if c['t'] >= 1200000][:1], [1200000])

    def test_a_recording_done_by_openai(self):
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(transcription, 'CACHE', Path(folder)):
            transcription.save('AU-0123abc', [{'t': 0, 'x': 'Hi.'}], 'openai/whisper-1')
            self.assertEqual((transcription.done_by('AU-0123abc', 'openai'), transcription.done_by('AU-0123abc', 'eleven')), (True, False))


if __name__ == '__main__':
    unittest.main()

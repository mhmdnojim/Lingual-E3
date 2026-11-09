"""Transcription by ElevenLabs (web/transcription.py): its key and the way used (ElevenLabs, or this
computer); what is sent (the key in xi-api-key, the model, the language, the speakers told apart,
words timed); its words made into lines, a sentence each, with the speakers A, B, explanation;
what it says no to told plainly; any file transcribed and not kept. A stand-in for ElevenLabs.

Run: python -m unittest web/tests/test_speech.py
"""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

WEB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WEB))
import transcription  # noqa: E402


def words(*items):
    """('Hello', 0.0, 0.4, 'speaker_0'), … -> ElevenLabs's words, with spacing between."""
    out = []
    for i, (text, start, end, who) in enumerate(items):
        if i:
            out.append({'text': ' ', 'type': 'spacing', 'start': start, 'end': start})
        out.append({'text': text, 'type': 'word', 'start': start, 'end': end, 'speaker_id': who})
    return out


DIALOGUE = words(('Hi', 0.0, 0.3, 'speaker_0'), ('Jenny.', 0.35, 0.8, 'speaker_0'), ('Hello', 1.0, 1.3, 'speaker_1'),
                 ('Rob!', 1.35, 1.7, 'speaker_1'), ('How', 2.0, 2.2, 'speaker_0'), ('are', 2.25, 2.4, 'speaker_0'),
                 ('you?', 2.45, 2.8, 'speaker_0'), ('Listen', 3.5, 3.9, 'speaker_2'), ('again.', 3.95, 4.3, 'speaker_2'))


class Standin(BaseHTTPRequestHandler):
    seen = []
    answer = (200, {'language_code': 'en', 'text': '…', 'words': DIALOGUE})

    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        Standin.seen.append({'path': self.path, 'key': self.headers.get('xi-api-key'), 'body': body})
        code, d = Standin.answer
        data = json.dumps(d).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


class Speech(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Standin)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.api = mock.patch.object(transcription, 'SPEECH_API', f'http://127.0.0.1:{cls.server.server_port}/v1')
        cls.api.start()

    @classmethod
    def tearDownClass(cls):
        cls.api.stop()
        cls.server.shutdown()

    def setUp(self):
        Standin.seen.clear()
        Standin.answer = (200, {'language_code': 'en', 'text': '…', 'words': DIALOGUE})
        self.tmp = tempfile.TemporaryDirectory()
        self.mp3 = Path(self.tmp.name) / 'track_1.26.mp3'
        self.mp3.write_bytes(b'ID3 sound of 1.26')

    def tearDown(self):
        self.tmp.cleanup()

    def test_settings(self):
        with mock.patch.dict('os.environ', {'ELEVENLABS_API_KEY': ''}):
            self.assertEqual(transcription.speech_settings({}), ('', 'scribe_v2', 'local'))
            self.assertEqual(transcription.speech_settings({'speechKey': 'k1'}), ('k1', 'scribe_v2', 'eleven'))
            self.assertEqual(transcription.speech_settings({'speechKey': 'k1', 'speechEngine': 'local'})[2], 'local', 'this computer chosen')
        with mock.patch.dict('os.environ', {'ELEVENLABS_API_KEY': 'env'}):
            self.assertEqual(transcription.speech_settings({})[:1], ('env',))
        self.assertEqual([transcription.language_code(x) for x in ('en-US', 'zh_CN', 'zh-Hans', '', 'auto', 'AR')],
                         ['en', 'zh', 'zh', None, None, 'ar'])

    def test_lines_and_speakers(self):
        cues = transcription.eleven(self.mp3, 'k1', 'scribe_v2', 'en-US')
        self.assertEqual([(c['t'], c['x'], c.get('speaker')) for c in cues],
                         [(0, 'Hi Jenny.', 'A'), (1000, 'Hello Rob!', 'B'), (2000, 'How are you?', 'A'), (3500, 'Listen again.', 'explanation')])
        self.assertEqual(cues[0]['words'], [{'t': 0, 'e': 300, 'x': 'Hi'}, {'t': 350, 'e': 800, 'x': 'Jenny.'}])
        sent = Standin.seen[0]
        self.assertEqual((sent['path'], sent['key']), ('/v1/speech-to-text', 'k1'))
        for field, value in (('model_id', 'scribe_v2'), ('language_code', 'en'), ('diarize', 'true'), ('timestamps_granularity', 'word')):
            self.assertIn(f'name="{field}"\r\n\r\n{value}\r\n'.encode(), sent['body'])
        self.assertIn(b'filename="sound.mp3"\r\nContent-Type: audio/mpeg\r\n\r\nID3 sound of 1.26\r\n', sent['body'])

    def test_one_speaker_and_no_language(self):
        Standin.answer = (200, {'words': words(('One', 0.0, 0.3, 'speaker_0'), ('voice.', 0.4, 0.8, 'speaker_0'),
                                                ('Still', 1.0, 1.2, 'speaker_0'), ('one.', 1.3, 1.5, 'speaker_0'))})
        cues = transcription.eleven(self.mp3, 'k1', language=None)
        self.assertEqual([(c['x'], c.get('speaker')) for c in cues], [('One voice.', None), ('Still one.', None)])
        self.assertNotIn(b'name="language_code"', Standin.seen[0]['body'], 'the language found by ElevenLabs')

    def test_chinese_words_without_spaces(self):
        Standin.answer = (200, {'words': [{'text': '你好', 'type': 'word', 'start': 0.0, 'end': 0.5},
                                          {'text': '。', 'type': 'word', 'start': 0.5, 'end': 0.5}]})
        self.assertEqual([c['x'] for c in transcription.eleven(self.mp3, 'k1', language='zh')], ['你好。'])

    def test_said_no(self):
        for code, detail, said in ((401, {'status': 'invalid_api_key', 'message': 'Invalid API key'}, 'did not accept the key'),
                                   (402, {'status': 'quota_exceeded', 'message': 'quota'}, 'no credits left'),
                                   (422, [{'loc': ['body', 'file'], 'msg': 'File too short'}], r'said no \(422\): File too short'),
                                   (429, {'status': 'too_many_concurrent_requests'}, 'busy')):
            Standin.answer = (code, {'detail': detail})
            with self.assertRaisesRegex(transcription.SpeechError, said):
                transcription.eleven(self.mp3, 'k1')
        Standin.answer = (200, {'words': []})
        with self.assertRaisesRegex(ValueError, 'No speech'):
            transcription.eleven(self.mp3, 'k1')
        with self.assertRaisesRegex(transcription.SpeechError, 'no key'):
            transcription.eleven(self.mp3, '')
        with mock.patch.object(transcription, 'SPEECH_API', 'http://127.0.0.1:9/v1'):
            with self.assertRaisesRegex(transcription.SpeechError, 'could not be reached'):
                transcription.eleven(self.mp3, 'k1')

    def wait(self, look):
        for _ in range(100):
            d = look()
            if d['state'] in ('done', 'error'):
                return d
            time.sleep(0.05)
        self.fail('still not done')

    def test_a_book_recording_kept(self):
        src = '/lib/L0123456789/migration-media/' + 'a' * 64 + '.mp3'
        with mock.patch.object(transcription, 'CACHE', Path(self.tmp.name) / 'transcripts'):
            first = transcription.start(src, self.mp3, 'en', how=('k1', 'scribe_v2', 'eleven'))
            self.assertEqual(first['state'], 'queued')
            d = self.wait(lambda: transcription.status(src, self.mp3))
            self.assertEqual(d['state'], 'done', d)
            kept = json.loads((Path(self.tmp.name) / 'transcripts' / f'L0123456789-{"a" * 64}.json').read_text(encoding='utf-8'))
            self.assertEqual((kept['model'], len(kept['cues'])), ('elevenlabs/scribe_v2', 4))
            self.assertEqual(transcription.counts([src, src.replace('a' * 64, 'b' * 64)]), {'done': 1, 'running': 0, 'failed': 0})
            self.assertEqual(transcription.start(src, self.mp3, 'en', how=('k1', 'scribe_v2', 'eleven'))['state'], 'done', 'not again')
            self.assertEqual(len(Standin.seen), 1)

    def test_language_found(self):
        self.assertEqual([transcription.spoken_language(x) for x in ('eng', 'en', 'zho', 'cmn', 'ara', 'en-US', '', 'xyzq', None)],
                         ['en', 'en', 'zh-Hans', 'zh-Hans', 'ar', 'en', None, None, None])
        Standin.answer = (200, {'language_code': 'ara', 'words': DIALOGUE})
        found = {}
        transcription.eleven(self.mp3, 'k1', info=found)
        self.assertEqual(found, {'language': 'ar'}, 'what its lines are translated from')

    def test_done_by_elevenlabs_or_any(self):
        """A disc's recordings written before on this computer: done for this computer, not for ElevenLabs."""
        src = '/.shared/assets/audio/AU-0123abc/track.mp3'
        with mock.patch.object(transcription, 'CACHE', Path(self.tmp.name) / 'transcripts'):
            self.assertEqual(transcription.counts([src], 'eleven'), {'done': 0, 'running': 0, 'failed': 0})
            transcription.save('AU-0123abc', [{'t': 0, 'x': 'Old.'}])  # (by Whisper)
            self.assertEqual((transcription.done_by('AU-0123abc', 'local'), transcription.done_by('AU-0123abc', 'eleven')), (True, False))
            self.assertEqual(transcription.counts([src], 'local')['done'], 1)
            self.assertEqual(transcription.counts([src], 'eleven')['done'], 0)
            transcription.start(src, self.mp3, 'en', True, ('k1', 'scribe_v2', 'eleven'))  # (again, by ElevenLabs)
            self.assertEqual(self.wait(lambda: transcription.status(src, self.mp3))['state'], 'done')
            self.assertEqual(transcription.counts([src], 'eleven')['done'], 1)
            self.assertEqual(transcription.saved('AU-0123abc')[0]['x'], 'Hi Jenny.', 'the new lines replace the old ones')

    def test_file_translations_kept(self):
        """A file's lines are translated as a script of the book 'files' (only under a script's id),
        from the language found (also one no book is in, e.g. Russian)."""
        import translate
        with mock.patch.object(translate, 'TR_DIR', self.tmp.name):
            self.assertEqual(translate.translate_page('ar', 'files', 'AU-' + 'a' * 32, [['Hi.']], cached_only=True), ([['']], 0, 1))
            self.assertEqual(translate.translate_page('ar', 'files', 'AU-' + 'a' * 32, [['Привет.']], cached_only=True, book_language='ru')[2], 1)
            for page in ('p1', '../x', 'PA-12ab'):
                with self.assertRaises(ValueError):
                    translate.translate_page('ar', 'files', page, [['Hi.']], cached_only=True)

    def test_any_file(self):
        with mock.patch.object(transcription, 'FILES', Path(self.tmp.name) / 'files'):
            with self.assertRaisesRegex(ValueError, 'audio or video'):
                transcription.start_file('notes.txt', b'x', how=('k1', 'scribe_v2', 'eleven'))
            job = transcription.start_file('C:\\Users\\me\\voice message.m4a', b'sound', '', ('k1', 'scribe_v2', 'eleven'))
            d = self.wait(lambda: transcription.file_status(job))
            self.assertEqual([c['x'] for c in d['cues']][:2], ['Hi Jenny.', 'Hello Rob!'])
            self.assertEqual(d['language'], 'en')
            import hashlib
            self.assertEqual(d['script'], 'AU-' + hashlib.sha256(b'sound').hexdigest()[:32], 'its translations kept under its content')
            self.assertIn(b'filename="sound.m4a"\r\nContent-Type: audio/mp4', Standin.seen[0]['body'])
            self.assertEqual(list((Path(self.tmp.name) / 'files').iterdir()), [], 'the file is not kept')
            self.assertEqual(transcription.file_status('F-' + '0' * 32)['state'], 'error')
            self.assertEqual(transcription.file_status('../x')['state'], 'error')


if __name__ == '__main__':
    unittest.main()

"""Transcription of a book's recordings: each file's state, pause, cancel and start again."""
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import transcription  # noqa: E402


def src_of(letter):
    return f'/lib/L0123456789/migration-media/{letter * 64}.mp3'


class TranscribeControl(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.mp3 = Path(self.tmp.name) / 'a.mp3'
        self.mp3.write_bytes(b'x')
        self.calls = []
        self.release = threading.Event()
        self.patches = [mock.patch.object(transcription, 'CACHE', Path(self.tmp.name) / 'transcripts'),
                        mock.patch.object(transcription, 'transcribe', self.fake),
                        mock.patch.object(transcription, 'diarization_ready', lambda: False)]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)
        transcription._jobs.clear()
        transcription._stopping.clear()

    def fake(self, path, threads=4, progress=None, language='en', speakers=True):
        self.calls.append(path)
        if len(self.calls) == 1 or getattr(self, 'hold', False):
            for _ in range(400):  # (the first one runs until it is let go or stopped)
                progress(20)
                if self.release.is_set():
                    break
                time.sleep(0.01)
        return [{'t': 0, 'x': 'Hello.'}]

    def wait_for(self, look, state, seconds=5):
        end = time.time() + seconds
        while time.time() < end:
            if look()['state'] == state:
                return
            time.sleep(0.02)
        self.fail(f'still {look()} not {state}')

    def test_states_pause_cancel_and_again(self):
        a, b, c = src_of('a'), src_of('b'), src_of('c')
        for src in (a, b, c):
            self.assertEqual(transcription.file_state(src)['state'], 'idle')
            transcription.start(src, self.mp3, 'en')
        self.wait_for(lambda: transcription.file_state(a), 'running')
        self.assertEqual([transcription.file_state(x)['state'] for x in (b, c)], ['queued', 'queued'])
        self.assertEqual(transcription.file_state(a)['progress'], 20, 'how far it is')
        self.assertEqual(transcription.stop([b], pause=True), 1)
        self.assertEqual(transcription.stop([c]), 1)
        self.assertEqual((transcription.file_state(b)['state'], transcription.file_state(c)['state']), ('paused', 'idle'))
        # The one being written stops at its next step (a cancel): it is not kept.
        self.assertEqual(transcription.stop([a]), 1)
        self.wait_for(lambda: transcription.file_state(a), 'idle')
        time.sleep(0.2)
        self.assertEqual(len(self.calls), 1, 'what was paused or cancelled while it waited never ran')
        # Paused: goes on when started again, and runs once.
        transcription.start(b, self.mp3, 'en')
        self.wait_for(lambda: transcription.file_state(b), 'done')
        time.sleep(0.2)
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(transcription.counts([a, b, c]), {'done': 1, 'running': 0, 'failed': 0})

    def test_pause_a_running_one_keeps_it_paused(self):
        a = src_of('d')
        transcription.start(a, self.mp3, 'en')
        self.wait_for(lambda: transcription.file_state(a), 'running')
        transcription.stop([a], pause=True)
        self.wait_for(lambda: transcription.file_state(a), 'paused')
        self.hold = False
        transcription.start(a, self.mp3, 'en')
        self.wait_for(lambda: transcription.file_state(a), 'done')


if __name__ == '__main__':
    unittest.main()

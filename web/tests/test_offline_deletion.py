"""No online voice calls; recording deletion, ownership folders and metadata races."""
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import tts


class OfflineDeletionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='lingua-offline-delete-test-')
        self.folder = Path(self.tmp.name) / 'owner'
        self.folder.mkdir()
        self.rid = 'r20261011-120000-0001'
        self.meta = {'id': self.rid, 'title': 'Page voice', 'created': '2026-10-11',
                     'book': 'BO-ff57d1a56e6bf', 'bookId': '1705', 'bookType': 'Student Book',
                     'page': '25', 'path': 'PA-74f1d4f6f1dd3', 'voice': 'en-US-AriaNeural',
                     'languageMode': 'en', 'offlineVoiceOnly': True,
                     'sentences': [{'a': 0, 'b': 1, 'path': 'PA-74f1d4f6f1dd3', 'text': 'Hello.',
                                    'start': 0, 'end': 1, 'words': ['Hello.']}]}
        self.seed(self.folder)

    def tearDown(self):
        self.tmp.cleanup()

    def seed(self, folder):
        (folder / (self.rid + '.json')).write_text(json.dumps(self.meta), encoding='utf-8')
        (folder / (self.rid + '.mp3')).write_bytes(b'ID3 test')
        tts._write_subtitles(self.meta, str(folder))

    def test_delete_removes_all_files_and_is_idempotent(self):
        other = Path(self.tmp.name) / 'other-owner'
        other.mkdir()
        self.seed(other)
        tts.delete_recording(self.rid, str(self.folder))
        tts.delete_recording(self.rid, str(self.folder))
        self.assertEqual([], list(self.folder.iterdir()))
        self.assertEqual(4, len(list(other.iterdir())))
        self.assertEqual([], tts.list_recordings(str(self.folder)))

    def test_locked_file_retains_metadata_and_can_be_retried(self):
        original = tts.os.remove
        def locked(file):
            if str(file).endswith('.mp3'):
                raise PermissionError('File in use')
            return original(file)
        with mock.patch.object(tts.os, 'remove', side_effect=locked):
            with self.assertRaises(PermissionError):
                tts.delete_recording(self.rid, str(self.folder))
        self.assertTrue((self.folder / (self.rid + '.json')).is_file())
        tts.delete_recording(self.rid, str(self.folder))
        self.assertEqual([], list(self.folder.iterdir()))

    def test_concurrent_subtitle_rebuild_cannot_resurrect_deleted_audio(self):
        (self.folder / (self.rid + '.srt')).unlink()
        entered, release = threading.Event(), threading.Event()
        original = tts._write_subtitles
        errors = []
        def slow_write(meta, folder):
            entered.set()
            release.wait(3)
            return original(meta, folder)
        def run(action):
            try:
                action()
            except Exception as exc:
                errors.append(exc)
        with mock.patch.object(tts, '_write_subtitles', side_effect=slow_write):
            listing = threading.Thread(target=lambda: run(lambda: tts.list_recordings(str(self.folder))))
            listing.start()
            self.assertTrue(entered.wait(3))
            deleting = threading.Thread(target=lambda: run(lambda: tts.delete_recording(self.rid, str(self.folder))))
            deleting.start()
            release.set()
            listing.join(5)
            deleting.join(5)
        self.assertFalse(listing.is_alive() or deleting.is_alive())
        self.assertEqual([], errors)
        self.assertEqual([], list(self.folder.iterdir()))

    def test_explicit_offline_type_survives_request_and_summary(self):
        request = {**self.meta, 'offlineCollection': {'id': 'book:voice', 'title': 'My book', 'extra': {'ignored': True}}}
        clean = tts._clean_request(request)
        self.assertTrue(clean['offlineVoiceOnly'])
        self.assertEqual({'id': 'book:voice', 'title': 'My book'}, clean['offlineCollection'])
        self.assertTrue(tts._summary(self.meta)['offlineVoiceOnly'])
        clean = tts._clean_request({**request, 'offlineVoiceOnly': False})
        self.assertFalse(clean['offlineVoiceOnly'])


if __name__ == '__main__':
    unittest.main()

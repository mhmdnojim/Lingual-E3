"""Offline audio creation: service denial and a complete sentence timeline.

These tests use a fake speech service; they never send book text over the network.
"""
import asyncio
import base64
import io
import json
from pathlib import Path
import sys
import types
import unittest
import wave
from unittest.mock import AsyncMock, mock_open, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import tts


class SpeechDenied(Exception):
    status = 403


class OfflineAudioGenerationTests(unittest.TestCase):
    def make_job(self, folder, count=21):
        job = tts._clean_request({
            'book': 'L0123456789', 'path': 'p1', 'page': '1',
            'voice': 'en-US-AnaNeural', 'languageMode': 'en',
            'offlineVoiceOnly': True,
            'sentences': [
                {'path': 'p1', 'a': i, 'b': i + 1,
                 'text': f'Sentence{i}.', 'words': [f'Sentence{i}.']}
                for i in range(count)
            ],
        })
        job['dir'] = folder
        jid = 'test-generation'
        tts.jobs[jid] = {'state': 'running', 'done': 0, 'total': count}
        self.addCleanup(tts.jobs.pop, jid, None)
        return jid, job

    def test_denied_service_stops_before_other_chunks_and_saves_nothing(self):
        calls = []

        async def denied(text, voice, rate):
            calls.append((text, voice))
            raise SpeechDenied('403 Invalid response status wss://example.test?token=secret')

        jid, job = self.make_job('unused-test-recordings')
        with patch.object(tts, '_speak', denied), \
                patch.object(tts, '_encode') as encode, patch('builtins.open', mock_open()) as files:
            tts._run_job(jid, job)
        state = tts.get_job(jid)
        self.assertEqual(state['state'], 'error')
        self.assertIn('HTTP 403', state['error'])
        self.assertNotIn('wss://', state['error'])
        self.assertNotIn('secret', state['error'])
        self.assertEqual(state['done'], 0)
        self.assertEqual(len(calls), 1)
        encode.assert_not_called()
        # (nothing written: a read of the server's settings — is there a backup voice? — is not a save)
        self.assertFalse([c for c in files.call_args_list if len(c.args) > 1 and 'w' in str(c.args[1]) or 'w' in str(c.kwargs.get('mode', ''))],
                         'no file was written')

    def test_successful_page_keeps_every_sentence_in_order(self):
        async def speech(text, voice, rate):
            words = text.split()
            return b'mock audio', [(i, i + 0.5, word) for i, word in enumerate(words)]

        jid, job = self.make_job('unused-test-recordings')
        with patch.object(tts, '_speak', speech), \
                patch.object(tts, '_decode', return_value=b'\0\0' * tts.RATE * 10), \
                patch.object(tts, '_encode') as encode, \
                patch.object(tts.os, 'makedirs'), patch.object(tts, '_write_subtitles'), \
                patch('builtins.open', mock_open()) as files:
            tts._run_job(jid, job)
        state = tts.get_job(jid)
        self.assertEqual(state['state'], 'done', state.get('error'))
        self.assertEqual(state['done'], 21)
        meta = json.loads(''.join(args.args[0] for args in files().write.call_args_list))
        self.assertTrue(meta['offlineVoiceOnly'])
        self.assertEqual([s['a'] for s in meta['sentences']], list(range(21)))
        self.assertTrue(all(s['end'] > s['start'] for s in meta['sentences']))
        encode.assert_called_once()
        self.assertTrue(encode.call_args.args[1].endswith('.mp3'))

    def test_no_audio_response_is_not_success(self):
        class EmptySpeech:
            def __init__(self, *args, **kwargs):
                pass

            async def stream(self):
                yield {'type': 'WordBoundary', 'offset': 0,
                       'duration': 10_000_000, 'text': 'Hello'}

        module = types.SimpleNamespace(Communicate=EmptySpeech)
        with patch.dict(sys.modules, {'edge_tts': module}):
            with self.assertRaisesRegex(RuntimeError, 'no audio'):
                asyncio.run(tts._speak('Hello', 'en-US-AnaNeural', 0))


class WindowsOfflineVoiceTests(unittest.TestCase):
    voice = 'windows:TTS_MS_EN-US_DAVID_11.0'

    def wav(self):
        out = io.BytesIO()
        with wave.open(out, 'wb') as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(tts.RATE)
            audio.writeframes(b'\0\0' * tts.RATE * 2)
        return out.getvalue()

    def test_local_routing_keeps_audio_and_word_timings_without_importing_edge(self):
        wav = self.wav()
        result = {'audio': base64.b64encode(wav).decode(), 'boundaries': [
            {'start': 0.1, 'text': 'Hello'}, {'start': 0.7, 'text': 'again'}]}
        with patch.object(tts, '_windows_call', return_value=result) as local, \
                patch.dict(sys.modules, {'edge_tts': None}):
            audio, bounds = asyncio.run(tts._speak('Hello again', self.voice, 20))
        self.assertEqual(audio, wav)
        self.assertEqual(bounds, [(0.1, 0.7, 'Hello'), (0.7, 2.0, 'again')])
        local.assert_called_once_with('speak', {
            'text': 'Hello again', 'voice': 'TTS_MS_EN-US_DAVID_11.0', 'rate': 20})

    def test_missing_cloud_library_does_not_block_local_or_list(self):
        with patch.dict(sys.modules, {'edge_tts': None, 'imageio_ffmpeg': types.SimpleNamespace()}):
            self.assertIsNone(tts.missing_packages(self.voice))
            self.assertEqual(tts.missing_packages('en-US-AnaNeural'), 'edge-tts')
            self.assertEqual(tts.missing_packages({'voice': self.voice, 'languageMode': 'both',
                                                   'zhVoice': 'zh-CN-XiaoxiaoNeural'}), 'edge-tts')
        local = [{'id': self.voice, 'name': 'David (Windows offline)', 'provider': 'windows'}]
        with patch.object(tts, 'windows_voices', return_value=local), \
                patch.object(tts, '_edge_voices', side_effect=ImportError):
            self.assertEqual(tts.list_voices(), local)

    def test_non_windows_does_not_offer_or_substitute_windows_voice(self):
        with patch.object(tts, 'IS_WINDOWS', False), patch.object(tts.subprocess, 'run') as run:
            self.assertEqual(tts.windows_voices(), [])
            with self.assertRaisesRegex(tts.WindowsSpeechError, 'Windows server'):
                tts._windows_speak('Hello', self.voice, 0)
            run.assert_not_called()

    def test_local_sample_uses_locale_and_safe_filename(self):
        voice = 'windows:TTS_MS_ZH-CN_HUIHUI_11.0'
        with patch.object(tts, 'windows_voices', return_value=[{'id': voice, 'locale': 'zh-CN'}]), \
                patch.object(tts.os.path, 'exists', return_value=False), \
                patch.object(tts.os, 'makedirs'), \
                patch.object(tts, '_speak', AsyncMock(return_value=(self.wav(), []))) as speak, \
                patch.object(tts, '_decode', return_value=b'pcm'), \
                patch.object(tts, '_encode') as encode, \
                patch('builtins.open', mock_open(read_data=b'mp3')):
            self.assertEqual(tts.voice_sample(voice), b'mp3')
        speak.assert_awaited_once_with('\u4f60\u597d\u3002', voice, 0)
        self.assertNotIn(':', Path(encode.call_args.args[1]).name)
        self.assertTrue(tts._valid_voice(self.voice))
        self.assertFalse(tts._valid_voice('windows:../../somefile'))

    def test_invalid_empty_wav_never_becomes_saved_audio(self):
        with patch.object(tts, '_windows_call', return_value={'audio': '', 'boundaries': []}):
            with self.assertRaisesRegex(RuntimeError, 'no usable audio'):
                tts._windows_speak('Hello', self.voice, 0)


class TranslationAudioTests(unittest.TestCase):
    """Each sentence's translation read before or after it, with a voice of its language."""

    def run_job(self, order):
        job = tts._clean_request({
            'book': 'L0123456789', 'path': 'p1', 'page': '1', 'voice': 'en-US-AnaNeural', 'languageMode': 'en',
            'translation': {'order': order, 'lang': 'ar', 'langName': 'Arabic', 'voice': 'ar-SA-ZariyahNeural', 'voiceName': 'Zariyah'},
            'sentences': [
                {'path': 'p1', 'a': 0, 'b': 2, 'text': 'Hello there.', 'words': ['Hello', 'there.'], 'tr': 'مرحبا هناك.'},
                {'path': 'p1', 'a': 2, 'b': 4, 'text': 'Good night.', 'words': ['Good', 'night.'], 'tr': ''},  # (no translation yet)
            ],
        })
        job['dir'] = 'unused-test-recordings'
        jid = f'test-translation-{order}'
        tts.jobs[jid] = {'state': 'running', 'done': 0, 'total': 3}
        self.addCleanup(tts.jobs.pop, jid, None)
        asked = []

        async def speech(text, voice, rate):
            asked.append((voice, text))
            return voice.encode(), [(i + 0.5, i + 1.0, word) for i, word in enumerate(text.split())]

        # The English piece is 10 s long, the translation 4 s (its words: 0.5-2 s).
        decode = lambda mp3: b'\0\0' * tts.RATE * (4 if mp3.startswith(b'ar-') else 10)  # noqa: E731
        with patch.object(tts, '_speak', speech), patch.object(tts, '_decode', side_effect=decode), \
                patch.object(tts, '_encode'), patch.object(tts.os, 'makedirs'), patch.object(tts, '_write_subtitles'), \
                patch('builtins.open', mock_open()) as files:
            tts._run_job(jid, job)
        state = tts.get_job(jid)
        self.assertEqual(state['state'], 'done', state.get('error'))
        self.assertEqual(state['done'], 3)  # two sentences and one translation
        meta = json.loads(''.join(args.args[0] for args in files().write.call_args_list))
        self.assertIn(('ar-SA-ZariyahNeural', job['sentences'][0]['tr']), asked)
        self.assertEqual(meta['translation']['lang'], 'ar')
        return meta['sentences']

    def test_translation_after_each_sentence(self):
        first, second = self.run_job('after')
        tr = first['tr']
        self.assertLessEqual(first['words'][-1][1], tr['start'])  # the sentence's words, then its translation
        self.assertAlmostEqual(tr['end'] - tr['start'], 2.0, places=2)  # trimmed to its words, with a little silence
        self.assertAlmostEqual(tr['end'], first['end'], places=2)  # the sentence includes its translation
        self.assertNotIn('tr', second)
        self.assertGreaterEqual(second['start'], first['end'])

    def test_translation_before_each_sentence(self):
        first, _ = self.run_job('before')
        self.assertAlmostEqual(first['tr']['start'], first['start'], places=2)
        self.assertGreaterEqual(first['words'][0][0], first['tr']['end'])

    def test_translation_request_is_checked(self):
        base = {'book': 'L0123456789', 'path': 'p1', 'page': '1', 'voice': 'en-US-AnaNeural', 'languageMode': 'en',
                'sentences': [{'path': 'p1', 'a': 0, 'b': 1, 'text': 'Hi.', 'words': ['Hi.'], 'tr': 'Salut.'}]}
        good = {'order': 'after', 'lang': 'fr', 'voice': 'fr-FR-DeniseNeural'}
        self.assertEqual(tts._clean_request({**base, 'translation': good})['sentences'][0]['tr'], 'Salut.')
        self.assertNotIn('tr', tts._clean_request(base)['sentences'][0])  # (without a translation: not kept)
        for bad in ({**good, 'order': 'middle'}, {**good, 'lang': 'French'}, {**good, 'voice': 'fr-FR-Denise'}):
            with self.assertRaisesRegex(ValueError, 'bad translation'):
                tts._clean_request({**base, 'translation': bad})
        with self.assertRaisesRegex(ValueError, 'no translations'):
            tts._clean_request({**base, 'translation': good, 'sentences': [{**base['sentences'][0], 'tr': ' '}]})

    def test_voices_of_a_translation_language(self):
        self.assertTrue(tts.speaks_language('ar-SA', 'ar'))
        self.assertTrue(tts.speaks_language('fil-PH', 'tl'))
        self.assertTrue(tts.speaks_language('zh-TW', 'zh-TW'))
        self.assertFalse(tts.speaks_language('zh-CN', 'zh-TW'))
        self.assertFalse(tts.speaks_language('en-US', 'ar'))
        edge = [{'id': f'{loc}-XNeural', 'locale': loc} for loc in ('en-US', 'zh-CN', 'ar-EG', 'ar-SA', 'fr-FR')]
        with patch.object(tts, 'windows_voices', return_value=[]), patch.object(tts, '_edge_voices', return_value=edge):
            self.assertEqual([v['locale'] for v in tts.list_voices('ar')], ['ar-EG', 'ar-SA'])
            self.assertEqual([v['locale'] for v in tts.list_voices()], ['en-US', 'zh-CN'])  # as before
            with self.assertRaises(ValueError):
                tts.list_voices('../ar')


if __name__ == '__main__':
    unittest.main()

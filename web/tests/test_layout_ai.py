"""Paid AI integration: no real API calls; source anchoring, credentials, and cache safety."""
from pathlib import Path
import copy
import io
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import layout_ai
import library
import designs
import server


def page():
    return {'n': 1, 'fingerprint': 'synthetic-source-v1', 'width': 1000, 'height': 1000,
            'words': [{'x': 50, 'y': 100, 'w': 50, 'h': 20, 't': 'First', 'line': 0},
                      {'x': 110, 'y': 100, 'w': 60, 'h': 20, 't': 'paragraph.', 'line': 0},
                      {'x': 600, 'y': 100, 'w': 60, 'h': 20, 't': 'Second.', 'line': 1}]}


GOOD = {'areas': [{'kind': 'paragraph', 'word_ids': [0, 1]}, {'kind': 'heading', 'word_ids': [2]}], 'notes': []}


def envelope(result=GOOD, **values):
    return {'status': 'completed', 'output': [{'type': 'message', 'content': [
        {'type': 'output_text', 'text': json.dumps(result)}]}],
        'usage': {'input_tokens': 100, 'output_tokens': 20, 'total_tokens': 120}, **values}


class LayoutAITest(unittest.TestCase):
    def test_image_input_and_strict_schema_use_only_supplied_source_words(self):
        with patch.object(layout_ai, '_image', return_value='data:image/jpeg;base64,TEST'), \
                patch.object(layout_ai.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps(envelope()).encode())) as call:
            result, usage = layout_ai.request_layout('unused', page(), 'test-secret-key', 'gpt-4.1')
        body = json.loads(call.call_args.args[0].data)
        self.assertFalse(body['store'])
        self.assertEqual(body['text']['format']['type'], 'json_schema')
        self.assertTrue(body['text']['format']['strict'])
        self.assertEqual(body['input'][0]['content'][1]['type'], 'input_image')
        self.assertIn('First', body['input'][0]['content'][0]['text'])
        self.assertNotIn('test-secret-key', json.dumps(body))
        self.assertEqual((result, usage['total_tokens']), (GOOD, 120))

    def test_provider_errors_cannot_echo_a_key_to_the_browser(self):
        error = HTTPError('unused', 401, 'Denied', {}, io.BytesIO(b'{"error":{"message":"test-secret-key"}}'))
        with patch.object(layout_ai, '_image', return_value='unused'), \
                patch.object(layout_ai.urllib.request, 'urlopen', side_effect=error):
            with self.assertRaises(layout_ai.LayoutError) as caught:
                layout_ai.request_layout('unused', page(), 'test-secret-key', 'gpt-4.1')
        self.assertNotIn('test-secret-key', str(caught.exception))
        self.assertIn('did not accept', str(caught.exception))

    def test_refusal_and_incomplete_output_are_not_applied(self):
        for data in [envelope(status='incomplete'), envelope(output=[{'type': 'message', 'content': [{'type': 'refusal'}]}])]:
            with self.subTest(data=data), patch.object(layout_ai, '_image', return_value='unused'), \
                    patch.object(layout_ai.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps(data).encode())):
                with self.assertRaises(layout_ai.LayoutError):
                    layout_ai.request_layout('unused', page(), 'test-key', 'gpt-4.1')

    def test_no_sending_without_a_key_or_on_empty_or_oversized_pages(self):
        for data, key in [(page(), ''), ({**page(), 'words': []}, 'test'),
                          ({**page(), 'words': page()['words'] * 1400}, 'test')]:
            with patch.object(layout_ai.urllib.request, 'urlopen') as request:
                with self.assertRaises(layout_ai.LayoutError):
                    layout_ai.request_layout('unused', data, key, 'gpt-4.1')
                request.assert_not_called()

    def test_missing_words_are_preserved_and_text_is_unchanged(self):
        source = page(); before = copy.deepcopy(source)
        areas, notes = layout_ai.validate_layout({'areas': GOOD['areas'][:1], 'notes': []}, source)
        self.assertEqual(source, before)
        self.assertEqual(len(areas), 2)
        self.assertTrue(any('1 words' in n for n in notes))
        self.assertGreater(areas[1]['x'], .5)

    def test_invented_and_repeated_word_ids_are_rejected(self):
        for ids in [[0, 999], [0, 0], [True], [0, 1.5]]:
            with self.subTest(ids=ids), self.assertRaises(layout_ai.LayoutError):
                layout_ai.validate_layout({'areas': [{'kind': 'paragraph', 'word_ids': ids}], 'notes': []}, page())

    def test_overlapping_groups_cannot_steal_each_others_words(self):
        bad = {'areas': [{'kind': 'paragraph', 'word_ids': [0, 2]}, {'kind': 'paragraph', 'word_ids': [1]}], 'notes': []}
        with self.assertRaises(layout_ai.LayoutError):
            layout_ai.validate_layout(bad, page())
        duplicate = {'areas': [{'kind': 'paragraph', 'word_ids': [0, 1]}, {'kind': 'paragraph', 'word_ids': [1, 2]}], 'notes': []}
        with self.assertRaises(layout_ai.LayoutError):
            layout_ai.validate_layout(duplicate, page())

    def test_small_number_label_outlines_can_be_saved(self):
        source = {**page(), 'words': [{'x': 20, 'y': 20, 'w': 2, 'h': 2, 't': '1', 'line': 0}]}
        areas, _ = layout_ai.validate_layout({'areas': [{'kind': 'skip', 'word_ids': [0]}], 'notes': []}, source)
        self.assertEqual(designs.clean_page_areas({'1': areas}, [1])['1'][0]['kind'], 'skip')

    def test_key_sources_require_opt_in_to_the_saved_image_key(self):
        with patch.dict(os.environ, {'OPENAI_API_KEY': ''}):
            self.assertEqual(layout_ai.settings({'imageKey': 'image-secret'})[0], '')
            self.assertEqual(layout_ai.settings({'imageKey': 'image-secret', 'layoutUseImageKey': True})[0], 'image-secret')
            self.assertEqual(layout_ai.settings({'layoutKey': 'layout-secret', 'imageKey': 'image-secret'})[0], 'layout-secret')

    def test_settings_response_never_contains_credentials(self):
        handler = object.__new__(server.Handler)
        handler.user = lambda: {'id': 1, 'admin': True}
        with patch.object(server.auth, 'config', return_value={'layoutKey': 'layout-secret', 'imageKey': 'image-secret'}):
            info = handler.layout_ai_info()
        self.assertTrue(info['ready'])
        self.assertNotIn('layout-secret', json.dumps(info)); self.assertNotIn('image-secret', json.dumps(info))

    def test_non_admin_cannot_configure_or_use_owner_funded_ai_by_default(self):
        handler = object.__new__(server.Handler)
        handler.user = lambda: {'id': 2, 'admin': False}
        handler.denied = Mock(return_value='denied')
        handler.read_body = Mock()
        self.assertEqual(handler.configure_layout_ai(), 'denied')
        with patch.object(server.auth, 'config', return_value={'layoutKey': 'secret'}), patch.object(library, 'analyze_layout') as analyze:
            self.assertEqual(handler.post_layout_ai({'id': 'unused'}, 1), 'denied')
            analyze.assert_not_called()
        handler.read_body.assert_not_called()


class LayoutCacheTest(unittest.TestCase):
    def test_reopening_uses_cache_refresh_calls_api_and_failure_keeps_previous_cache(self):
        with tempfile.TemporaryDirectory(prefix='lingua-layout-ai-test-') as folder:
            Path(folder, 'layout-review').mkdir()
            source = page()
            with patch.object(library, 'folder', side_effect=lambda bid, *parts: str(Path(folder, *parts))), \
                    patch.object(library, 'review_layout', return_value=source), \
                    patch.object(layout_ai, 'request_layout', return_value=(GOOD, {'total_tokens': 12})) as request:
                phases = []
                first = library.analyze_layout({'id': 'fixture'}, 1, 'test', 'gpt-4.1', progress=lambda at, _: phases.append(at))
                self.assertEqual(phases, [0, 1, 2])
                again = library.analyze_layout({'id': 'fixture'}, 1, 'test', 'gpt-4.1')
                self.assertTrue(again['ai']['cached']); self.assertFalse(first['ai']['cached'])
                self.assertEqual(request.call_count, 1)
                library.analyze_layout({'id': 'fixture'}, 1, 'test', 'gpt-4.1', refresh=True)
                self.assertEqual(request.call_count, 2)
                request.side_effect = layout_ai.LayoutError('API unavailable')
                with self.assertRaises(layout_ai.LayoutError):
                    library.analyze_layout({'id': 'fixture'}, 1, 'test', 'gpt-4.1', refresh=True)
                self.assertTrue(library.analyze_layout({'id': 'fixture'}, 1, 'test', 'gpt-4.1')['ai']['cached'])
                self.assertFalse(Path(folder, 'designs.json').exists(), 'Suggestions never save a user layout automatically')


if __name__ == '__main__':
    unittest.main()

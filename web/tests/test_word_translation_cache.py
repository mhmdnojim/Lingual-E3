"""Contextual word preparation and offline lookup share a durable occurrence cache.

All translation responses are stubbed; tests never read or modify the user's cache.
"""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import translate


class WordTranslationCacheTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix='lingua-word-cache-test-', dir=Path(__file__).resolve().parent)
        self.addCleanup(folder.cleanup)
        self.cache_dir = Path(folder.name)
        patch = mock.patch.object(translate, 'TR_DIR', folder.name)
        patch.start()
        self.addCleanup(patch.stop)

    @property
    def cache_path(self):
        return self.cache_dir / 'ar' / 'words-context.json'

    def test_prepared_word_is_available_offline_in_a_new_lookup(self):
        item = {'word': 'interested', 'context': 'She is interested in music.', 'contextOffset': 7}
        with mock.patch.object(translate, '_chrome', return_value=['إنها <a i=0>مهتمة</a> بالموسيقى.']) as online:
            result, saved, missing = translate.translate_words('ar', [item])
        self.assertEqual((result, saved, missing), (['مهتمة'], 1, 0))
        self.assertEqual(online.call_args.args[1], ['She is <a i=0>interested</a> in music.'])
        self.assertEqual(len(json.loads(self.cache_path.read_text(encoding='utf-8'))), 1)
        with mock.patch.object(translate, '_chrome', side_effect=AssertionError('offline lookup used network')):
            self.assertEqual(translate.translate_word('ar', 'interested', item['context'], 7, cached_only=True), 'مهتمة')

    def test_different_contexts_and_occurrences_keep_their_own_meaning(self):
        context = 'The bank is beside the river bank.'
        entries = [{'word': 'bank', 'context': context, 'contextOffset': at} for at in (4, 29)]
        entries.append({'word': 'bank', 'context': 'Visit the bank.', 'contextOffset': 10})
        with mock.patch.object(translate, '_chrome', return_value=[
            '<a i=0>المصرف</a>', '<a i=0>الضفة</a>', '<a i=0>البنك</a>',
        ]) as online:
            result, saved, missing = translate.translate_words('ar', entries)
        self.assertEqual((result, saved, missing), (['المصرف', 'الضفة', 'البنك'], 3, 0))
        self.assertIn('river <a i=0>bank</a>', online.call_args.args[1][1])
        with mock.patch.object(translate, '_chrome', side_effect=AssertionError('offline lookup used network')):
            self.assertEqual(translate.translate_words('ar', entries, cached_only=True), (result, 0, 0))

    def test_offline_missing_word_does_not_contact_service_or_create_cache(self):
        with mock.patch.object(translate, '_chrome', side_effect=AssertionError('offline lookup used network')):
            result = translate.translate_words('ar', [{'word': 'manage', 'context': 'How do they manage?', 'contextOffset': 12}], cached_only=True)
        self.assertEqual(result, ([''], 0, 1))
        self.assertFalse(self.cache_path.exists())

    def test_full_sentence_without_marker_is_not_saved_as_a_word_gloss(self):
        with mock.patch.object(translate, '_chrome', return_value=['إنها مهتمة بالموسيقى.']):
            result = translate.translate_words('ar', [{'word': 'interested', 'context': 'She is interested in music.', 'contextOffset': 7}])
        self.assertEqual(result, ([''], 0, 1))
        self.assertFalse(self.cache_path.exists())

    def test_direct_word_is_marked_and_reusable_offline(self):
        with mock.patch.object(translate, '_chrome', return_value=['<a i=0>كتاب</a>']) as online:
            self.assertEqual(translate.translate_word('ar', 'book'), 'كتاب')
        self.assertEqual(online.call_args.args[1], ['<a i=0>book</a>'])
        with mock.patch.object(translate, '_chrome', side_effect=AssertionError('offline lookup used network')):
            self.assertEqual(translate.translate_word('ar', 'book', cached_only=True), 'كتاب')

    def test_blank_cache_entry_is_retried_instead_of_becoming_permanent(self):
        key = translate._word_key('book', '', None)
        translate._save(str(self.cache_path), {key: ''})
        with mock.patch.object(translate, '_chrome', return_value=['<a i=0>كتاب</a>']) as online:
            self.assertEqual(translate.translate_words('ar', [{'word': 'book'}]), (['كتاب'], 1, 0))
        online.assert_called_once()

    def test_quoted_escaped_and_nested_markers_are_read(self):
        for value in ('<a i="0">مهتمة</a>', '&lt;span data-i="0"&gt;مهتمة&lt;/span&gt;', '<a i=0><b>مهتمة</b></a>'):
            with self.subTest(value=value):
                self.assertEqual(translate._marked_word_gloss(value), 'مهتمة')

    def test_completed_batch_survives_a_later_network_failure(self):
        # Long generic contexts force two separate requests.
        entries = [{'word': 'book', 'context': ('very ' * 180) + f'book {i}', 'contextOffset': 900} for i in range(8)]
        def respond(_lang, snippets, _src='en'):
            if respond.calls:
                raise translate.Offline()
            respond.calls += 1
            return ['<a i=0>كتاب</a>' for _ in snippets]
        respond.calls = 0
        with mock.patch.object(translate, '_chrome', side_effect=respond):
            result, saved, missing = translate.translate_words('ar', entries)
        self.assertGreater(saved, 0)
        self.assertGreater(missing, 0)
        with mock.patch.object(translate, '_chrome', side_effect=AssertionError('offline lookup used network')):
            self.assertEqual(translate.translate_words('ar', entries, cached_only=True), (result, 0, missing))

    def test_refresh_downloads_saved_words_again_and_keeps_them_when_offline(self):
        item = {'word': 'interested', 'context': 'She is interested in music.', 'contextOffset': 7}
        with mock.patch.object(translate, '_chrome', return_value=['<a i=0>مهتمة</a>']):
            translate.translate_words('ar', [item])
        with mock.patch.object(translate, '_chrome', side_effect=AssertionError('a saved word was downloaded again')):
            self.assertEqual(translate.translate_words('ar', [item]), (['مهتمة'], 0, 0))
        with mock.patch.object(translate, '_chrome', return_value=['<a i=0>مُهتمّة</a>']):
            self.assertEqual(translate.translate_words('ar', [item], refresh=True), (['مُهتمّة'], 1, 0))
        with mock.patch.object(translate, '_chrome', side_effect=translate.Offline()):
            self.assertEqual(translate.translate_words('ar', [item], refresh=True), (['مُهتمّة'], 0, 0))

    def test_words_without_meaning_are_known_after_one_try(self):
        items = [{'word': 'Oxenden', 'context': 'By Clive Oxenden.', 'contextOffset': 9},
                 {'word': 'By', 'context': 'By Clive Oxenden.', 'contextOffset': 0}]
        self.assertEqual(translate.words_without_meaning('ar', items), [], 'not asked for yet')
        with mock.patch.object(translate, '_chrome', return_value=['بواسطة كلايف أوكسندن.', '<a i=0>بواسطة</a>']):
            self.assertEqual(translate.translate_words('ar', items), (['', 'بواسطة'], 1, 1))
        self.assertEqual(translate.words_without_meaning('ar', items), [0])
        with mock.patch.object(translate, '_chrome', side_effect=translate.Offline()):
            translate.translate_words('ar', [{'word': 'Clive', 'context': 'By Clive Oxenden.', 'contextOffset': 3}])
        self.assertEqual(translate.words_without_meaning('ar', [{'word': 'Clive', 'context': 'By Clive Oxenden.', 'contextOffset': 3}]), [],
                         'not answered (offline) is not the same as no meaning')
        with mock.patch.object(translate, '_chrome', return_value=['<a i=0>أوكسندن</a>']):
            translate.translate_words('ar', items[:1], refresh=True)
        self.assertEqual(translate.words_without_meaning('ar', items), [], 'a meaning found later counts')

    def test_sentences_without_translation_are_the_blank_ones(self):
        page = ('ar', 'BO-0123456789abc', 'PA-0123456789abc')
        with mock.patch.object(translate, '_translate_paragraphs',
                               side_effect=lambda _lang, todo, found, _src: found.update({'One.': 'واحد.', 'happened?': ''})):
            translate.translate_page(*page, [['One.', 'happened?']])
        self.assertEqual(translate.sentences_without_translation(*page, [['One.'], [' happened? ', 'Two.']]), [1])

    def test_refresh_translates_saved_sentences_of_a_page_again(self):
        page = ('ar', 'BO-0123456789abc', 'PA-0123456789abc')
        def answer(text):
            return lambda _lang, todo, found, _src: found.update({s: text + s for p in todo for s in p})
        with mock.patch.object(translate, '_translate_paragraphs', side_effect=answer('old:')):
            translate.translate_page(*page, [['One.', 'Two.']])
        with mock.patch.object(translate, '_translate_paragraphs', side_effect=AssertionError('a saved sentence was translated again')):
            self.assertEqual(translate.translate_page(*page, [['One.', 'Two.']]), ([['old:One.', 'old:Two.']], 0, 0))
        with mock.patch.object(translate, '_translate_paragraphs', side_effect=answer('new:')):
            self.assertEqual(translate.translate_page(*page, [['One.', 'Two.']], refresh=True), ([['new:One.', 'new:Two.']], 2, 0))


class BookLanguageTests(unittest.TestCase):
    """Every book is translated from its own language: a Chinese book from Chinese (into English, the main language)."""

    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix='lingua-book-language-test-', dir=Path(__file__).resolve().parent)
        self.addCleanup(folder.cleanup)
        self.cache_dir = Path(folder.name)
        patch = mock.patch.object(translate, 'TR_DIR', folder.name)
        patch.start()
        self.addCleanup(patch.stop)

    def test_a_chinese_page_is_sent_as_chinese_and_kept_apart_from_the_old_english_guesses(self):
        page = ('en', 'L7feffbfcd7', 'p1')
        old = self.cache_dir / 'en' / 'L7feffbfcd7' / 'p1.json'  # (the first versions sent it as English)
        translate._save(str(old), {'我每天六点起床': '我每天六点起床'})
        with mock.patch.object(translate, '_chrome', return_value=['<a i=0>I get up at six every day.</a>']) as online:
            result = translate.translate_page(*page, [['我每天六点起床']], book_language='zh-Hans')
        self.assertEqual(result, ([['I get up at six every day.']], 1, 0))
        self.assertEqual(online.call_args.args[0], 'en')
        self.assertEqual(online.call_args.args[2], 'zh-CN', 'from Chinese')
        self.assertTrue((self.cache_dir / 'en' / 'L7feffbfcd7' / 'from-zh-CN' / 'p1.json').exists())
        with mock.patch.object(translate, '_chrome', side_effect=AssertionError('a saved sentence was translated again')):
            self.assertEqual(translate.translate_page(*page, [['我每天六点起床']], cached_only=True, book_language='zh-Hans'),
                             ([['I get up at six every day.']], 0, 0))
        self.assertEqual(translate.sentences_without_translation(*page, [['我每天六点起床']], 'zh-Hans'), [])

    def test_the_words_of_a_chinese_book_are_asked_from_chinese_and_saved_apart(self):
        item = {'word': '起床', 'context': '我每天六点起床', 'contextOffset': 5}
        with mock.patch.object(translate, '_chrome', return_value=['我每天六点<a i=0>get up</a>']) as online:
            self.assertEqual(translate.translate_words('en', [item], book_language='zh-Hans'), (['get up'], 1, 0))
        self.assertEqual(online.call_args.args[2], 'zh-CN')
        self.assertEqual(translate.translate_words('en', [item], cached_only=True, book_language='zh-Hans'), (['get up'], 0, 0))
        with mock.patch.object(translate, '_chrome', side_effect=AssertionError('offline lookup used network')):
            self.assertEqual(translate.translate_word('ar', '起床', item['context'], 5, cached_only=True, book_language='zh-Hans'), '',
                             'another language: its own meaning')

    def test_english_is_a_language_to_translate_into_but_not_for_a_book_in_english(self):
        self.assertEqual(translate.languages()[0]['code'], 'en', 'English first: the main language')
        with self.assertRaises(ValueError):
            translate.translate_page('en', 'BO-0123456789abc', 'PA-0123456789abc', [['Hello.']])
        with self.assertRaises(ValueError):
            translate.translate_word('zh-CN', '起床', book_language='zh-Hans')
        with self.assertRaises(ValueError):
            translate.translate_page('en', 'L7feffbfcd7', 'p1', [['Hola.']], book_language='xx')

    def test_the_older_address_is_told_the_language_too(self):
        with mock.patch.object(translate, '_call', return_value=[[['I get up.', '我起床。']]]) as call:
            self.assertEqual(translate._gtx('我起床。', 'en', 'zh-CN'), [('我起床。', 'I get up.')])
        self.assertIn('sl=zh-CN&tl=en', call.call_args.args[1].full_url)


if __name__ == '__main__':
    unittest.main()

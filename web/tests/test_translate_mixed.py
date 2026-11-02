"""Translating a page (web/translate.py): a paragraph with a Chinese sentence and the book's English
for it goes to the translator one sentence at a time, so the translation of one is not moved into
the other ("…resolve issues" | "related to lost items."); a paragraph in one writing goes whole.

All translation responses are stubbed; tests never read or modify the user's cache.
"""
import html
from pathlib import Path
import re
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import translate  # noqa: E402

MIXED = ['L 能听懂并解决物品丢失的问题', '。Be able to understand and handle situations involving lost items.']
CHINESE = ['我们去机场接你们。', '你的护照丢了。']


def chrome(lang, items, src='en'):
    """Every marked sentence "translated" as T(its text); an item without marks as a whole."""
    return [re.sub(r'<a i=(\d+)>(.*?)</a>', lambda m: f'<a i={m[1]}>T({html.unescape(m[2])})</a>', item) if '<a i=' in item
            else f'T({html.unescape(item)})' for item in items]


class MixedParagraphTest(unittest.TestCase):
    def test_writings(self):
        self.assertEqual([translate._writing(s) for s in MIXED + ['Nǐmen hǎo.', '( 1 )']], ['other', 'latin', 'latin', None])

    def test_mixed_paragraph_one_sentence_at_a_time(self):
        found = {}
        with mock.patch.object(translate, '_chrome', side_effect=chrome) as online:
            translate._translate_paragraphs('en', [MIXED, CHINESE], found, 'zh-CN')
        sent = online.call_args.args[1]
        self.assertEqual(len(sent), 3, sent)  # the mixed paragraph's two sentences apart, the Chinese one whole
        self.assertTrue(sent[0].startswith('<a i=0>L 能听懂') and '<a i=1>' not in sent[0])
        self.assertIn('<a i=1>', sent[2])
        self.assertEqual(found[MIXED[0]], f'T({MIXED[0]})')
        self.assertEqual(found[CHINESE[1]], f'T({CHINESE[1]})')


if __name__ == '__main__':
    unittest.main()

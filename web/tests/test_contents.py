"""The contents of a book: lessons found from the headings at the top of its pages, and the owner's list."""
from pathlib import Path
import json
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import library

TEXT = {1: 'Contents Unit 1 ... Unit 2 ...', 2: 'Unit 1 Hello there some text on the page', 3: 'Unit 1 Hello again',
        4: 'Chapter 2: The sea and more text that follows the heading', 5: '第三课 你好吗', 6: '3A Mood food reading',
        7: 'plain text only', 8: 'Lesson 4 Food'}
PAGES = [{'n': n} for n in TEXT]


def book():
    return {'id': 'Lfixture'}


class ContentsTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix='lingua-contents-test-')
        self.patches = [
            patch.object(library, '_pages', return_value=PAGES),
            patch.object(library, 'text_doc', side_effect=lambda bid, n: {'t': TEXT[n]}),
            patch.object(library, 'page_text', side_effect=lambda d: d['t']),
            patch.object(library, 'folder', side_effect=lambda bid, *parts: str(Path(self.folder.name, *parts))),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.folder.cleanup()

    def test_headings_found_once_each_and_the_contents_page_is_not_one(self):
        found = library.detect_contents(book())
        self.assertEqual([(i['page']) for i in found], [2, 4, 5, 6, 8])
        self.assertEqual(found[0]['title'], 'Unit 1 Hello there some text on the page')
        self.assertTrue(all(len(i['title']) <= 48 for i in found))
        self.assertFalse(library.contents_of(book())['saved'])

    def test_the_owners_list_is_checked_kept_and_can_be_forgotten(self):
        saved = library.save_contents(book(), {'items': [{'title': '  Food  ', 'page': 6}, {'title': 'Sea', 'page': 4}]})
        self.assertTrue(saved['saved'])
        self.assertEqual(library.contents_of(book())['items'][0], {'title': 'Food', 'page': 6})
        for bad in ([{'title': 'No page', 'page': 99}], [{'title': '', 'page': 1}], [{'title': 'x', 'page': True}], [{'title': 'x', 'page': '2'}]):
            with self.assertRaises(library.LibraryError):
                library.save_contents(book(), {'items': bad})
        self.assertTrue(library.contents_of(book())['saved'], 'a refused list changes nothing')
        again = library.save_contents(book(), {'detect': True})
        self.assertFalse(again['saved'])
        self.assertEqual(len(again['items']), 5)


if __name__ == '__main__':
    unittest.main()

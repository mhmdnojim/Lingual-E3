"""New words (words.py): adding, not twice, in categories, practicing, deleting; bad items are refused.

The tests use a temporary folder, never the user's own web/words.
"""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import words


def item(**kw):
    return {'book': 'BO-ff57d1a56e6bf', 'bookId': '1705', 'page': '7', 'path': 'PA-60d32105fad4d', 'mode': 'word',
            'a': 10, 'b': 11, 'text': 'Cheap', 'context': 'Cheap restaurants usually serve bad food.', 'contextOffset': 0, **kw}


class WordsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = self.tmp.name

    def items(self):
        return words.list_items(self.dir)['items']

    def test_add_once_practice_and_delete(self):
        first = words.add([item()], self.dir)[0]
        self.assertRegex(first['id'], words.ID_RE)
        self.assertEqual((first['box'], first['seen'], first['category']), (0, 0, 'new'))
        again = words.add([item(), item(mode='sentence', a=10, b=16, text='Cheap restaurants usually serve bad food.')], self.dir)
        self.assertEqual(again[0]['id'], first['id'])  # the same word of the same page: not twice
        self.assertEqual(len(self.items()), 2)

        known = words.practiced(first['id'], True, self.dir)
        self.assertEqual((known['box'], known['seen'], known['right']), (1, 1, 1))
        words.practiced(first['id'], True, self.dir)
        missed = words.practiced(first['id'], False, self.dir)
        self.assertEqual((missed['box'], missed['seen'], missed['right']), (0, 3, 2))  # not known: back to box 0

        words.remove(first['id'], self.dir)
        self.assertEqual([i['mode'] for i in self.items()], ['sentence'])
        with self.assertRaises(FileNotFoundError):
            words.remove(first['id'], self.dir)

    def test_categories(self):
        self.assertEqual([c['name'] for c in words.list_items(self.dir)['categories']], ['New words', 'Definitions', 'Common sentences'])
        verbs = words.add_category('  Phrasal   verbs ', folder=self.dir)
        self.assertEqual(verbs['name'], 'Phrasal verbs')
        self.assertRegex(verbs['color'], words.COLOR_RE)
        with self.assertRaisesRegex(ValueError, 'already'):
            words.add_category('phrasal verbs', folder=self.dir)
        with self.assertRaises(ValueError):
            words.add_category(' ', folder=self.dir)

        added = words.add([item(category=verbs['id'])], self.dir)[0]
        self.assertEqual(added['category'], verbs['id'])
        moved = words.add([item(category='def')], self.dir)[0]  # the same word, another category: moved there
        self.assertEqual((moved['id'], moved['category'], len(self.items())), (added['id'], 'def', 1))
        with self.assertRaisesRegex(ValueError, 'no such category'):
            words.add([item(category='c00000000')], self.dir)

        words.add([item(a=12, b=13, text='serve', category=verbs['id'])], self.dir)
        self.assertEqual(words.remove_category(verbs['id'], self.dir), 1)  # its word goes back to New words
        self.assertEqual(sorted(i['category'] for i in self.items()), ['def', 'new'])
        self.assertNotIn(verbs['id'], [c['id'] for c in words.list_items(self.dir)['categories']])
        with self.assertRaises(ValueError):
            words.remove_category('new', self.dir)

    def test_the_first_version_of_the_file_is_read(self):
        with open(os.path.join(self.dir, 'words.json'), 'w', encoding='utf-8') as f:
            json.dump([{**item(), 'id': 'w' + '1' * 12}], f)  # only a list of items, no categories
        data = words.list_items(self.dir)
        self.assertEqual([c['id'] for c in data['categories']], ['new', 'def', 'common'])
        self.assertEqual(data['items'][0]['category'], 'new')

    def test_bad_items_are_refused(self):
        for bad in (item(mode='letter'), item(book='../x'), item(path='x'), item(a=5, b=5), item(text=' '),
                    item(contextOffset=999), item(a='1')):
            with self.assertRaises(ValueError):
                words.add([bad], self.dir)
        with self.assertRaises(ValueError):
            words.add([], self.dir)
        with self.assertRaises(ValueError):
            words.practiced('w' + '0' * 12, 'yes', self.dir)
        self.assertEqual(self.items(), [])


if __name__ == '__main__':
    unittest.main()

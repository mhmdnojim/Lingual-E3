"""A page made again from its boxes (Apply in the page-layout window) keeps the sentence corrections
its owner made in the reader (library.keep_edits)."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import library  # noqa: E402

SIZE = (1000, 1000)
TOP = {'x': 0.05, 'y': 0.05, 'w': 0.9, 'h': 0.25, 'kind': 'text', 'strict': True}
LOW = {'x': 0.05, 'y': 0.55, 'w': 0.9, 'h': 0.1, 'kind': 'text', 'strict': True}


def word(x, y, text, line):
    return [x, y, 80, 20, text, line, 1]


def doc(words, sent, blocks=None):
    return {'words': words, 'sent': sent, 'clause': [list(s) for s in sent],
            'blocks': blocks or [[i, i + 1] for i in range(len(sent))]}


def text(d):
    return [' '.join(w[4] for w in d['words'][a:b]) for a, b in d['sent']]


WORDS = [word(100, 100, 'Hello', 0), word(200, 100, 'world.', 0), word(100, 200, 'Second', 1), word(200, 200, 'one.', 1),
         word(100, 600, 'Bottom', 2), word(200, 600, 'text.', 2)]


def made():
    return doc([list(w) for w in WORDS], [[0, 2], [2, 4], [4, 6]])


def corrected():
    """The owner joined the first two sentences and corrected two words."""
    words = [list(w) for w in WORDS]
    words[1][4] = 'World!'
    words[5][4] = 'texts.'
    return doc(words, [[0, 4], [4, 6]])


class KeepEdits(unittest.TestCase):
    def check(self, d):
        import server
        self.assertTrue(server.valid_doc(d), 'a page the reader can open')
        self.assertEqual(d['sent'][0][0], 0)
        self.assertEqual(d['sent'][-1][1], len(d['words']))
        self.assertEqual(d['blocks'][-1][1], len(d['sent']))

    def test_boxes_in_another_order_keep_the_corrections(self):
        d = library.keep_edits(made(), corrected(), made(), [LOW, TOP], SIZE)
        self.check(d)
        self.assertEqual(text(d), ['Bottom texts.', 'Hello World! Second one.'], 'the order of the boxes, the owner’s sentences')
        self.assertEqual(d['blocks'], [[0, 1], [1, 2]])

    def test_same_boxes_change_nothing(self):
        d = library.keep_edits(made(), corrected(), made(), [TOP, LOW], SIZE)
        self.assertEqual(text(d), ['Hello World! Second one.', 'Bottom texts.'])

    def test_a_deleted_sentence_stays_deleted(self):
        mine = doc([list(w) for w in WORDS[:4]], [[0, 2], [2, 4]])  # (the bottom sentence deleted in the reader)
        d = library.keep_edits(made(), mine, made(), [LOW, TOP], SIZE)
        self.assertEqual(text(d), ['Hello world.', 'Second one.'])

    def test_a_box_read_differently_takes_the_new_reading(self):
        new = doc([list(w) for w in WORDS[1:]], [[0, 1], [1, 3], [3, 5]])  # ("Hello" is not read any more: another "Read as")
        d = library.keep_edits(made(), corrected(), new, [TOP, LOW], SIZE)
        self.check(d)
        self.assertEqual(text(d), ['world.', 'Second one.', 'Bottom texts.'], 'that box as read now, the other as corrected')

    def test_a_bigger_box_adds_its_new_words_after(self):
        more = [list(w) for w in WORDS[:4]] + [word(100, 250, 'More', 3), word(200, 250, 'here.', 3)] + [list(w) for w in WORDS[4:]]
        new = doc(more, [[0, 2], [2, 4], [4, 6], [6, 8]])
        d = library.keep_edits(made(), corrected(), new, [TOP, LOW], SIZE)
        self.check(d)
        self.assertEqual(text(d), ['Hello World! Second one.', 'More here.', 'Bottom texts.'])

    def test_typed_text_of_a_box(self):
        typed = {**TOP, 'text': 'Typed now.'}
        new = doc([word(100, 100, 'Typed', 0), word(200, 100, 'now.', 0)] + [list(w) for w in WORDS[4:]], [[0, 2], [2, 4]])
        d = library.keep_edits(made(), corrected(), new, [typed, LOW], SIZE)
        self.assertEqual(text(d), ['Typed now.', 'Bottom texts.'], 'typed in the layout now: it wins; the other box as corrected')
        # Typed before (the page as made has it already): the reader's correction of it stays.
        mine = doc([word(100, 100, 'Typed', 0), word(200, 100, 'NOW!', 0)] + [list(w) for w in WORDS[4:]], [[0, 2], [2, 4]])
        d = library.keep_edits(new, mine, new, [typed, LOW], SIZE)
        self.assertEqual(text(d), ['Typed NOW!', 'Bottom text.'])

    def test_a_box_left_out_and_a_deleted_box(self):
        d = library.keep_edits(made(), corrected(), made(), [{**TOP, 'kind': 'skip'}, LOW], SIZE)
        self.assertEqual(text(d), ['Bottom texts.'])
        d = library.keep_edits(made(), corrected(), made(), [LOW], SIZE)
        self.assertEqual(text(d), ['Bottom texts.'], 'a reviewed page: the words outside its boxes are left out')

    def test_a_typed_sentence_stays_after_the_one_before_it(self):
        mine = corrected()
        mine['words'].insert(4, [0, 0, 0, 0, 'Typed.', 0, 1])  # (not marked on the page)
        mine['sent'] = [[0, 4], [4, 5], [5, 7]]
        mine['clause'] = [list(s) for s in mine['sent']]
        mine['blocks'] = [[0, 1], [1, 2], [2, 3]]
        d = library.keep_edits(made(), mine, made(), [LOW, TOP], SIZE)
        self.check(d)
        self.assertEqual(text(d), ['Bottom texts.', 'Hello World! Second one.', 'Typed.'])

    def test_no_areas_keeps_the_page_as_corrected(self):
        d = library.keep_edits(made(), corrected(), made(), None, SIZE)
        self.assertEqual(text(d), ['Hello World! Second one.', 'Bottom texts.'])

    def test_nothing_left_of_the_corrections(self):
        new = doc([word(100, 100, 'Other', 0), word(100, 600, 'Words', 2)], [[0, 1], [1, 2]])
        self.assertIsNone(library.keep_edits(made(), corrected(), new, [TOP, LOW], SIZE))


if __name__ == '__main__':
    unittest.main()

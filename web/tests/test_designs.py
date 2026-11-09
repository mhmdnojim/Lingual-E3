"""The designs of a book's pages (web/designs.py, web/library.py): pages that look alike are found
as a design; the areas of a design come from what was read on its example page (a dialogue, a list
of new words, text), and each page of it is read area by area, in their order, without the areas
marked "skip"; the words outside every area go with the nearest one. The owner's changes are checked.

Run: python -m unittest web/tests/test_designs.py
"""
from pathlib import Path
import random
import sys
import unittest

from PIL import Image, ImageDraw

WEB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WEB))
sys.path.insert(0, str(WEB / 'tools'))
import designs  # noqa: E402
import library  # noqa: E402
import segment_text as S  # noqa: E402

ENGLISH = {'language': 'en', 'english': False, 'pinyin': 'none', 'dropPinyin': False,
           'pages': '', 'ocrAll': False, 'margins': False, 'enhance': False, 'fixes': ''}
CHINESE = {**ENGLISH, 'language': 'zh-Hans', 'english': True, 'pinyin': 'lines', 'dropPinyin': True}


def page(kind, seed):
    """A page drawn small: 'a' (a dark band at the top, text on the left), 'b' (a blue box below,
    text on the right), or something like neither ('photo', 'dark')."""
    rnd = random.Random(seed)
    img = Image.new('RGB', (360, 500), 'white')
    d = ImageDraw.Draw(img)
    if kind == 'a':
        d.rectangle((0, 0, 360, 40), fill=(30, 90, 110))
        for k in range(rnd.randint(10, 14)):
            d.rectangle((30, 70 + k * 26, 30 + rnd.randint(120, 170), 82 + k * 26), fill='black')
    elif kind == 'b':
        d.rectangle((20, 260, 340, 480), fill=(200, 225, 250))
        for k in range(rnd.randint(6, 9)):
            d.rectangle((190, 40 + k * 24, 190 + rnd.randint(100, 140), 52 + k * 24), fill='black')
    elif kind == 'photo':
        d.rectangle((0, 0, 360, 500), fill=(200, 40, 30))
    else:
        d.rectangle((0, 0, 360, 500), fill=(20, 20, 20))
    return img


def words(line, x, y, size=30, gap=12):
    """The words of a line of text (space-separated) set from x, y: raw OCR words."""
    out = []
    for t in line.split():
        w = size * len(t) if S.CJK.search(t) else round(size * 0.55 * len(t))
        out.append({'t': t, 'x': x, 'y': y, 'w': w, 'h': size})
        x += w + gap
    return out


def raw(lines, w=1600, h=2200):
    return {'w': w, 'h': h, 'lines': [{'words': ws} for ws in lines]}


def text(doc):
    return [S.unit_text(doc['words'], a, b) for a, b in doc['sent']]


class FindTest(unittest.TestCase):
    def test_pages_that_look_alike(self):
        kinds = ['a', 'b'] * 9 + ['photo', 'dark']
        found, other = designs.find(list(range(1, 21)), [designs.signature(page(k, n)) for n, k in enumerate(kinds)])
        self.assertEqual([d['pages'] for d in found], [list(range(1, 19, 2)), list(range(2, 19, 2))])
        self.assertEqual(other, [19, 20])
        for d in found:
            self.assertIn(d['example'], d['pages'])
            self.assertIsNone(d['areas'])  # (not read yet)

    def test_pages_that_all_look_different(self):
        """A magazine: its pages, no more alike than usual, make no design of most of them (a few
        may look alike by chance: a design's areas are used only once the owner checks them)."""
        pages = []
        for n in range(24):
            rnd = random.Random(n)
            img = Image.new('RGB', (360, 500), 'white')
            d = ImageDraw.Draw(img)
            for _ in range(6):  # (boxes of colour and of text anywhere)
                x, y = rnd.randint(0, 300), rnd.randint(0, 440)
                d.rectangle((x, y, x + rnd.randint(30, 200), y + rnd.randint(20, 120)),
                            fill=rnd.choice(['black', (200, 40, 30), (30, 120, 200), (240, 200, 40)]))
            pages.append(designs.signature(img))
        found, other = designs.find(list(range(1, 25)), pages)
        self.assertFalse(any(len(d['pages']) > 6 for d in found), [d['pages'] for d in found])  # (not one design of most pages)

    def test_a_short_book(self):
        found, other = designs.find([1, 2, 3], [designs.signature(page('a', n)) for n in range(3)])
        self.assertEqual(([d['pages'] for d in found], other), ([[1, 2, 3]], []))
        found, _ = designs.find([7], [designs.signature(page('b', 0))])
        self.assertEqual(found[0]['pages'], [7])


# A page: a dialogue on the left, a list of new words on the right, a paragraph below.
PAGE = [words('A: Where are you going today?', 100, 200), words('B: I am going to the park.', 100, 260),
        words('A: Can I come with you?', 100, 320),
        words('New Words', 1000, 200), words('旅游 to travel', 1000, 260), words('觉得 to think', 1000, 320),
        words('最 most', 1000, 380),
        words('This is a paragraph of text far below the others.', 100, 900), words('It goes on here.', 100, 960)]


class AreasTest(unittest.TestCase):
    def test_proposed_from_what_was_read(self):
        doc, info = library._doc(raw(PAGE), ENGLISH)
        areas = designs.proposed(doc, 1600, 2200, info['lists'], raw(PAGE))
        self.assertEqual(sorted(a['kind'] for a in areas), ['dialogue', 'text', 'words'])
        for a in areas:  # each around its own words
            x0, y0, x1, y1 = a['x'] * 1600, a['y'] * 2200, (a['x'] + a['w']) * 1600, (a['y'] + a['h']) * 2200
            first = {'dialogue': PAGE[0][0], 'words': PAGE[3][0], 'text': PAGE[7][0]}[a['kind']]
            self.assertTrue(x0 <= first['x'] < x1 and y0 <= first['y'] < y1, (a, first))

    def test_read_area_by_area(self):
        areas = [{'x': 0.6, 'y': 0.05, 'w': 0.38, 'h': 0.2, 'kind': 'words'},
                 {'x': 0.03, 'y': 0.05, 'w': 0.5, 'h': 0.15, 'kind': 'dialogue'},
                 {'x': 0.03, 'y': 0.38, 'w': 0.9, 'h': 0.1, 'kind': 'skip'}]
        doc, _ = library._doc_in_areas(raw(PAGE), CHINESE, None, False, areas)
        found = text(doc)
        self.assertEqual(found[:2], ['New Words', '旅游'])  # (the list first: its area is first)
        self.assertIn('to travel', found)
        self.assertIn('Where are you going today?', found)  # (without "A:")
        self.assertNotIn('A:', ' '.join(found))
        self.assertFalse(any('paragraph' in t for t in found))  # (in the area not read)

    def test_words_outside_the_areas(self):
        areas = [{'x': 0.03, 'y': 0.05, 'w': 0.5, 'h': 0.1, 'kind': 'text'},   # (the dialogue's last line is below it)
                 {'x': 0.6, 'y': 0.05, 'w': 0.38, 'h': 0.2, 'kind': 'text'}]
        parts = designs.parts(raw(PAGE), areas)
        first = ' '.join(w['t'] for ln in parts[0][1]['lines'] for w in ln['words'])
        self.assertIn('Can I come with you?', first)  # (the nearest area)
        self.assertIn('paragraph', first)
        self.assertNotIn('旅游', first)

    def test_a_list_without_its_columns_found(self):
        lines = [words('1. 旅游 lǚyóu to travel', 100, 100), words('2. 觉得 juéde to think, to feel', 100, 160),
                 words('3. 最 zuì most, to the', 100, 220), words('greatest extent', 300, 260)]
        doc, _ = library._doc(raw(lines), CHINESE, kind='words')
        self.assertEqual(text(doc), ['旅游', 'to travel', '觉得', 'to think, to feel', '最', 'most, to the greatest extent'])


class SpeakersTest(unittest.TestCase):
    def test_names_left_out(self):
        lines = [{'words': words('A: Hello there.', 0, 0)}, {'words': words('王方：你好', 0, 50)},
                 {'words': [{'t': 'B', 'x': 0, 'y': 100, 'w': 20, 'h': 30}, {'t': ':', 'x': 22, 'y': 100, 'w': 6, 'h': 30}]
                  + words('Fine.', 40, 100)},
                 {'words': words('Wang Fang: Good morning.', 0, 150)}, {'words': words('It is 10:30 now.', 0, 200)}]
        out = [' '.join(w['t'] for w in ln['words']) for ln in designs.without_speakers(lines)]
        self.assertEqual(out, ['Hello there.', '你好', 'Fine.', 'Good morning.', 'It is 10:30 now.'])


class JoinTest(unittest.TestCase):
    def test_one_document_of_two(self):
        a = S.segment(raw([words('First area here.', 0, 0)]), ocr=False)
        b = S.segment(raw([words('Second one. And more.', 0, 0), words('Next line.', 0, 50)]), ocr=False)
        doc = designs.join([a, b])
        self.assertEqual(S.page_text(doc), S.page_text(a) + '\n' + S.page_text(b))
        self.assertEqual(len({w[5] for w in doc['words']}), len({w[5] for w in a['words']}) + len({w[5] for w in b['words']}))


class CleanTest(unittest.TestCase):
    def test_the_owners_changes(self):
        area = {'x': 0.1, 'y': 0.2, 'w': 0.3, 'h': 0.4, 'kind': 'dialogue'}
        found, other = designs.clean([{'pages': [3, 1, 99], 'example': 7, 'areas': [area]},
                                      {'pages': [1, 2], 'example': 2, 'areas': None}, {'pages': [], 'areas': []}], [1, 2, 3, 4])
        self.assertEqual(found, [{'pages': [1, 3], 'example': 1, 'areas': [area]}, {'pages': [2], 'example': 2, 'areas': None}])
        self.assertEqual(other, [4])
        for wrong in ([{'pages': [1], 'areas': [{**area, 'kind': 'picture'}]}], [{'pages': [1], 'areas': [{**area, 'w': 0}]}],
                      [{'pages': [1], 'areas': [{**area, 'x': 'left'}]}], 'designs'):
            with self.assertRaises(ValueError):
                designs.clean(wrong, [1, 2])

    def test_plan(self):
        saved = {'designs': [{'pages': [1, 2], 'areas': [{'x': 0, 'y': 0, 'w': 1, 'h': 1, 'kind': 'text'}]},
                             {'pages': [3], 'areas': []}, {'pages': [4], 'areas': None}]}
        self.assertEqual(designs.plan(saved), {})  # (not checked by the owner yet: every page read whole)
        plan = designs.plan({**saved, 'checked': True})
        self.assertEqual((len(plan[1]), plan[3], plan[4], plan.get(5)), (1, None, None, None))


if __name__ == '__main__':
    unittest.main()

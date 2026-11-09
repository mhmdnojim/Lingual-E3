"""OCR's pieces of one line of the page put together (segment_text.join_rows: Re-read text by area,
Read the whole page again): at a blank to fill in (a line drawn under the gap; its small number
goes), after a speaker's name or a number at the start of the row; in the order the page is read.
Two columns side by side stay apart.

Run: python -m unittest web/tests/test_join_rows.py
"""
from pathlib import Path
import sys
import unittest

from PIL import Image, ImageDraw

WEB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WEB / 'tools'))
import segment_text as S  # noqa: E402


def line(text, x, y, h=30, small=()):
    """OCR's words of a piece of a line (words in small: a small number, as tall as 0.6 of the line)."""
    out = []
    for t in text.split():
        w = round(len(t) * h * 0.5)
        out.append({'t': t, 'x': x, 'y': y if t not in small else y - 4, 'w': w, 'h': h if t not in small else round(0.6 * h)})
        x += w + 10
    return {'words': out}


def end(ln):
    return max(w['x'] + w['w'] for w in ln['words'])


def texts(lines):
    return [' '.join(w['t'] for w in ln['words']) for ln in lines]


class JoinRowsTest(unittest.TestCase):
    def test_blanks_to_fill_in(self):
        img = Image.new('L', (1600, 600), 255)
        d = ImageDraw.Draw(img)
        first = line('Jenny and Rob work for a 1', 100, 100, small=('1',))
        d.line((end(first) + 4, 128, end(first) + 140, 128), fill=0, width=2)  # (the blank)
        second = line('She is American, and he is 2', 100, 150, small=('2',))
        d.line((end(second) + 4, 178, end(second) + 140, 178), fill=0, width=2)  # (at the end of the line)
        # OCR's order: the left pieces, then the right ones.
        lines = [first, second, line('called NewYork.', end(first) + 150, 100)]
        self.assertEqual(texts(S.join_rows(lines, img)), ['Jenny and Rob work for a called NewYork.', 'She is American, and he is'])

    def test_names_and_numbers_before_their_lines(self):
        # OCR's order: the numbers, the names, then what they say (and a line under one, without a name).
        lines = [line('1', 100, 100), line('Jenny', 130, 100), line('Rob', 130, 140),
                 line('Don’t forget the chocolates.', 240, 100), line('OK. Oh, great!', 240, 140),
                 line('Jenny', 130, 180), line('I don’t believe it.', 240, 180), line('Don’t tell me you forgot them?', 240, 215)]
        self.assertEqual(texts(S.join_rows(lines, None)),
                         ['1 Jenny Don’t forget the chocolates.', 'Rob OK. Oh, great!', 'Jenny I don’t believe it.', 'Don’t tell me you forgot them?'])

    def test_two_columns_stay_apart(self):
        img = Image.new('L', (1600, 600), 255)  # (nothing drawn between them: not a blank)
        lines = [line('The left column is read first and', 100, 100), line('it goes on here.', 100, 140),
                 line('The right column is read after it', 800, 100), line('and goes on here.', 800, 140)]
        self.assertEqual(texts(S.join_rows(lines, img)),
                         ['The left column is read first and', 'it goes on here.', 'The right column is read after it', 'and goes on here.'])

    def test_the_page_made_of_them(self):
        """Through segment: the sentences of a dialogue, each with its line."""
        lines = [line('Jenny', 130, 100), line('Rob', 130, 140), line('Don’t forget the chocolates.', 240, 100), line('OK, I won’t.', 240, 140)]
        doc = S.segment({'lines': lines}, ocr=False, rows=True)
        self.assertEqual([S.unit_text(doc['words'], a, b) for a, b in doc['sent']], ['Jenny Don’t forget the chocolates.', 'Rob OK, I won’t.'])
        doc = S.segment({'lines': lines}, ocr=False)  # (without: as before, the names together)
        self.assertEqual(S.unit_text(doc['words'], *doc['sent'][0]), 'Jenny Rob')


if __name__ == '__main__':
    unittest.main()

"""Boxes found on a page are numbered the way a page is read (a heading across first, then each column from top to
bottom, the left column first): the same order as the editor's "Order boxes automatically"."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import designs


def box(x, y, w, h):
    return {'x': x, 'y': y, 'w': w, 'h': h}


class ReadingOrder(unittest.TestCase):
    def test_heading_then_columns(self):
        heading, left1, left2, right = box(.05, .02, .9, .05), box(.05, .1, .4, .1), box(.05, .3, .4, .1), box(.5, .1, .4, .3)
        out = designs.reading_order([right, left2, heading, left1])
        self.assertEqual(out, [heading, left1, left2, right])

    def test_no_band_higher_then_left(self):
        a, b = box(.1, .1, .5, .3), box(.3, .2, .5, .3)  # they overlap: no empty band between
        self.assertEqual(designs.reading_order([b, a]), [a, b])

    def test_paragraph_areas_are_in_that_order(self):
        words = [[10, 10, 20, 10, 'Right', 0], [10, 200, 20, 10, 'Left', 1]]
        # the first paragraph is the right column's (x 300), the second the left column's (x 10), both at the top
        words = [[300, 10, 40, 10, 'Right', 0], [10, 12, 40, 10, 'Left', 1]]
        doc = {'words': words, 'sent': [(0, 1), (1, 2)], 'blocks': [(0, 1), (1, 2)]}
        out = designs.paragraph_areas(doc, 400, 400)
        self.assertEqual([round(a['x'] * 400) for a in out][0] < [round(a['x'] * 400) for a in out][1], True, 'left first')


if __name__ == '__main__':
    unittest.main()

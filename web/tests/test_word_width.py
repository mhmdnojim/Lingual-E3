"""A word whose box is far wider than its letters is cut back (the highlight must not cover blank page)."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import designs


class WordWidth(unittest.TestCase):
    def test_cut_back(self):
        self.assertLess(designs.tight_width({'t': 'up.', 'w': 300, 'h': 20}), 60)
        self.assertLess(designs.tight_width({'t': '你好', 'w': 300, 'h': 20}), 80)

    def test_kept(self):
        self.assertEqual(designs.tight_width({'t': 'coffee', 'w': 120, 'h': 20}), 120)
        self.assertEqual(designs.tight_width({'t': '________', 'w': 300, 'h': 20}), 300, 'a blank to fill in')
        self.assertEqual(designs.tight_width({'t': 'x', 'w': 0, 'h': 0}), 0)

    def test_layout_lines_does_it(self):
        raw = {'w': 800, 'h': 600, 'lines': [{'words': [{'t': 'Most', 'x': 10, 'y': 10, 'w': 50, 'h': 20}, {'t': 'up.', 'x': 70, 'y': 10, 'w': 400, 'h': 20}]}]}
        out = designs.layout_lines(raw)
        self.assertLess(out['lines'][0]['words'][1]['w'], 60)


if __name__ == '__main__':
    unittest.main()

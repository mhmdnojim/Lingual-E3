"""The choices of an exercise in one line (tools/segment_text.py choice_starts): each a sentence of
its own ("A 换房子 | B 买空调 | C 去女儿的初中"), and each question too ("(2) 王一雪为什么……");
not letters in other text ("neither A nor B", "Plan A and plan B"). Pages made before (also the
owner's corrections) are cut so once (split_languages).

Run: python -m unittest web/tests/test_segment_choices.py
"""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import segment_text as S  # noqa: E402


def page(*lines):
    """A page of these lines (one under the other), each split into words as OCR gives them
    (Chinese: a character each)."""
    out = []
    for k, text in enumerate(lines):
        words, x = [], 100
        for t in text.split():
            for piece in (S.CJK_PIECE.findall(t) if S.CJK.search(t) else [t]):
                w = 30 if S.CJK.search(piece) else 14 * len(piece)
                words.append({'t': piece, 'x': x, 'y': 100 + 40 * k, 'w': w, 'h': 30})
                x += w + 8
        out.append({'words': words})
    return {'w': 1600, 'h': 2000, 'lines': out}


def sentences(doc):
    return [S.unit_text(doc['words'], a, b) for a, b in doc['sent']]


class ChoicesTest(unittest.TestCase):
    def test_chinese_choices(self):
        # New HSK Course 3, p.32.
        doc = S.segment(page('(1) 王一雪和刘明想做什么? ( )', 'A 换房子 B 买空调 C 去女儿的初中',
                             '(2) 王一雪为什么不喜欢这个房子? ( )', 'A 房子太远 B 她不喜欢住一层 C 她不喜欢这个小区'), ocr=False)
        self.assertEqual(sentences(doc)[1:4], ['A 换房子', 'B 买空调', 'C 去女儿的初中'])
        self.assertEqual(sentences(doc)[-3:], ['A 房子太远', 'B 她不喜欢住一层', 'C 她不喜欢这个小区'])

    def test_english_choices_and_the_next_question(self):
        doc = S.segment(page('a went b was going c had gone (2) Where were you?'), ocr=False)
        self.assertEqual(sentences(doc), ['a went', 'b was going', 'c had gone', '(2) Where were you?'])
        # OCR's marks before a letter ("_C").
        doc = S.segment(page('A 外语没考好 B 历史有点儿难 _C 数学考得还可以'), ocr=False)
        self.assertEqual(sentences(doc), ['A 外语没考好', 'B 历史有点儿难', '_C 数学考得还可以'])

    def test_question_at_the_start_of_a_line(self):
        doc = S.segment(page('A 床上 B 桌子上 C 门后面', '(2) 笔在哪儿? ( )'), ocr=False)
        self.assertEqual(sentences(doc), ['A 床上', 'B 桌子上', 'C 门后面', '(2) 笔在哪儿 ? ( )'])

    def test_not_choices(self):
        for lines in (['A and B (neither A nor B), expressing a moderate degree.'],
                      ['Plan A is better than plan B for us.'],
                      ['Master the use of comparative sentences', '(10) to compare products.']):
            doc = S.segment(page(*lines), ocr=False)
            self.assertEqual(len(doc['sent']), 1, lines)

    def test_page_made_before(self):
        # A corrected page (the owner joined the line of choices to the question): cut at the
        # choices, the rest as the owner made it; once.
        made = S.segment(page('(1) 王一雪和刘明想做什么? ( )', 'A 换房子 B 买空调 C 去女儿的初中'), ocr=False)
        before = {**made, 'sent': [[0, len(made['words'])]], 'clause': [[0, len(made['words'])]], 'blocks': [[0, 1]]}
        doc, changed = S.split_languages(before)
        self.assertTrue(changed)
        self.assertEqual(sentences(doc), ['(1) 王一雪和刘明想做什么 ? ( )', 'A 换房子', 'B 买空调', 'C 去女儿的初中'])
        self.assertEqual(S.split_languages(doc), (doc, False))


if __name__ == '__main__':
    unittest.main()

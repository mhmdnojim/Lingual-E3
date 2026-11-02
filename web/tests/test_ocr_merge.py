"""The two OCR passes of a page in Chinese and English, put together (web/ocr.py): italic English
that Chinese OCR read partly as characters ("which" as "w 勖") comes from English OCR, whole; real
Chinese, and pinyin with its tone marks, stay as Chinese OCR read them.

Run: python -m unittest web/tests/test_ocr_merge.py
"""
from pathlib import Path
import sys
import unittest

WEB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WEB))
import ocr  # noqa: E402


def page(*lines):
    """Lines of words, each (text, x, y, w, h)."""
    return {'w': 600, 'h': 400, 'angle': 0, 'lines': [{'words': [dict(zip('txywh', w)) for w in ln]} for ln in lines]}


def text(doc):
    return [' '.join(w['t'] for w in ln['words']) for ln in doc['lines']]


class MergeTest(unittest.TestCase):
    def test_italic_english_read_as_characters(self):
        # As read on HSK22 p.20 (the meaning of a new word, in italics on an orange box).
        chinese = page(
            [('（', 25, 18, 10, 30), ('忉', 36, 20, 24, 22), ('c', 85, 26, 15, 16), ('口', 100, 25, 16, 17), ('/', 116, 22, 9, 20),
             ('g', 148, 25, 19, 24), ('how', 174, 17, 55, 25)],
            [('m', 24, 66, 23, 16), ('口', 48, 66, 16, 16), ('月', 64, 66, 15, 16), ('）', 77, 66, 14, 23), ('，', 90, 66, 5, 10),
             ('times', 103, 60, 67, 23), ('or', 179, 66, 30, 17)],
            [('w', 25, 106, 22, 17), ('勖', 71, 98, 30, 25), ('time', 110, 101, 56, 22)],
            [('something', 23, 139, 135, 30)],
            [('乃', 25, 179, 15, 24), ('叩', 41, 187, 32, 23), ('e', 90, 187, 14, 16), ('）', 133, 179, 10, 30), ('time;', 151, 179, 66, 29)],
            [('occurrence', 25, 226, 141, 18)])
        english = page(
            [('(indicating', 25, 17, 142, 32), ('how', 174, 17, 55, 25)],
            [('many', 24, 66, 71, 23), ('times', 103, 60, 67, 23), ('or', 179, 66, 30, 17)],
            [('which', 25, 98, 76, 25), ('time', 110, 101, 56, 22)],
            [('something', 23, 139, 135, 30)],
            [('happens)', 25, 179, 118, 31), ('time;', 151, 179, 66, 29)],
            [('occurrence', 25, 226, 141, 18)])
        self.assertEqual(text(ocr._merge_ocr_docs(chinese, english)),
                         ['(indicating how', 'many times or', 'which time', 'something', 'happens) time;', 'occurrence'])

    def test_italic_english_read_as_a_jumble(self):
        # As read on New HSK Course 3 p.25 (the meaning of 员, in italics): one "word" of characters,
        # letters and signs where Chinese OCR reads a character a word; "a" as a box (口).
        chinese = page([('口褶e磊@“', 20, 20, 151, 31), ('口', 177, 29, 17, 16)],
                       [('to', 21, 105, 24, 21), ('indicate', 54, 101, 104, 25), ('口', 167, 109, 16, 17)])
        english = page([('added', 20, 20, 83, 25), ('after', 108, 21, 63, 30), ('a', 177, 29, 17, 16)],
                       [('to', 21, 105, 24, 21), ('indicate', 54, 101, 104, 25), ('a', 167, 109, 16, 17)])
        self.assertEqual(text(ocr._merge_ocr_docs(chinese, english)), ['added after a', 'to indicate a'])

    def test_box_in_chinese_stays(self):
        # 口 (mouth) in Chinese: English OCR's letters there are no line of English.
        chinese = page([('人', 20, 20, 30, 30), ('口', 52, 20, 30, 30), ('很', 84, 20, 30, 30), ('多', 116, 20, 30, 30)])
        english = page([('A', 20, 20, 30, 30), ('a', 52, 20, 30, 30), ('Ta', 84, 20, 60, 30)])
        self.assertEqual(text(ocr._merge_ocr_docs(chinese, english)), ['人 口 很 多'])

    def test_chinese_stays(self):
        # English OCR's letters over Chinese characters (there are none in the Chinese reading).
        chinese = page([('你', 20, 20, 30, 30), ('们', 52, 20, 30, 30), ('是', 84, 20, 30, 30), ('第', 116, 20, 30, 30), ('一', 148, 20, 30, 30)])
        english = page([('fiilfJ1', 20, 20, 60, 30), ('Rxa', 84, 20, 60, 30), ('Some', 116, 20, 60, 30)])
        self.assertEqual(text(ocr._merge_ocr_docs(chinese, english)), ['你 们 是 第 一'])

    def test_pinyin_marks_stay(self):
        chinese = page([('Nǐmen', 20, 20, 70, 24), ('shì', 100, 20, 40, 24)], [('你', 20, 50, 30, 30), ('们', 52, 50, 30, 30)])
        english = page([('Nimen', 20, 20, 70, 24), ('shi', 100, 20, 40, 24)])
        self.assertEqual(text(ocr._merge_ocr_docs(chinese, english)), ['Nǐmen shì', '你 们'])

    def test_english_beside_chinese(self):
        chinese = page([('A', 20, 20, 14, 24), ('：', 36, 20, 8, 24), ('你', 60, 20, 30, 30), ('好', 92, 20, 30, 30)])
        english = page([('A:', 20, 20, 22, 24), ('IN#', 60, 20, 60, 30)])
        self.assertEqual(text(ocr._merge_ocr_docs(chinese, english)), ['A: 你 好'])


if __name__ == '__main__':
    unittest.main()

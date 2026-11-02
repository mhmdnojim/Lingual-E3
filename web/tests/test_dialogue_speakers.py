"""The dialogues of Chinese books (web/library.py): the names of the speakers under their pictures
(small characters, a line of their own: "刘明") and the pictures as OCR reads them ("(O", "(0)")
are left out of the text, so they are not read with the dialogue; also from pages made before
(drop_speakers). Small text that is not a name stays ("一", flat; longer lines).

Run: python -m unittest web/tests/test_dialogue_speakers.py
"""
from pathlib import Path
import sys
import unittest

WEB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WEB))
sys.path.insert(0, str(WEB / 'tools'))
import library  # noqa: E402
import segment_text as S  # noqa: E402

CHINESE = {'language': 'zh-Hans', 'english': True, 'pinyin': 'lines', 'dropPinyin': True,
           'pages': '', 'ocrAll': False, 'margins': False, 'enhance': False, 'fixes': ''}


def chars(x, y, text, size=36):
    """Words of OCR: a character each, size pixels."""
    return [(t, x + k * (size + 4), y, size, size) for k, t in enumerate(text)]


# New HSK Course 3, p.32, as the app's OCR read it: the names small under the pictures, the
# pictures read as "(O" and "(0)".
PAGE = [
    chars(270, 778, '小雪的初中离家有点儿远，'),
    chars(268, 831, '咱们换一个近点儿的房子吧。'),
    [('(O', 160, 910, 55, 53)] + chars(265, 930, '好啊，我上网看看。你觉得'),
    chars(170, 966, '刘明', size=16),
    chars(265, 983, '这个小区怎么样？'),
    chars(268, 1078, '环境挺好的，离地铁站还不远。'),
    chars(160, 1060, '王一雪', size=15),
    [('(0)', 162, 1255, 55, 52)] + chars(265, 1273, '是不错，但是我不喜欢住一层。'),
    [('一', 900, 1400, 36, 7)],  # (flat: a character of the text, not small)
]


def raw(lines):
    return {'w': 1601, 'h': 2265, 'lines': [{'words': [dict(zip('txywh', w)) for w in ln]} for ln in lines]}


def text(doc):
    return [S.unit_text(doc['words'], a, b) for a, b in doc['sent']]


class SpeakersTest(unittest.TestCase):
    def test_left_out_when_read(self):
        found = ' '.join(text(library._doc(raw(PAGE), CHINESE)[0]))
        for gone in ('刘明', '王一雪', '(O', '(0)'):
            self.assertNotIn(gone, found)
        for kept in ('你觉得', '这个小区怎么样？', '好啊', '是不错', '一'):
            self.assertIn(kept, found)

    def test_page_made_before(self):
        made = library._doc(raw(PAGE), {**CHINESE, 'language': 'en'})[0]  # (as made before: with the names)
        self.assertIn('刘明', ''.join(text(made)))
        doc, changed = library.drop_speakers(made)
        self.assertTrue(changed)
        self.assertNotIn('刘明', ''.join(text(doc)))
        self.assertNotIn('(O', ' '.join(text(doc)))
        self.assertEqual(library.drop_speakers(doc), (doc, False))

    def test_pictures_read_as_characters(self):
        # New HSK Course 3, p.44, from the PDF's hidden text: the picture read as "像 ) 4", the name
        # with a word of the next column on its line; English beside the picture stays.
        lines = [chars(285, 224, '出去玩的机票买好了吗？', size=40), chars(285, 321, '买好了。', size=40),
                 [('像', 161, 470, 42, 57), (')', 203, 470, 23, 57), ('4', 240, 470, 10, 57)] + chars(284, 470, '宾馆也选好了吗？', size=40),
                 [('stroke', 120, 480, 30, 20)],
                 chars(159, 529, '杨同乐', size=17) + [('/', 793, 529, 6, 17)],
                 chars(265, 570, '是的，这家宾馆很特别，', size=40)]
        found = text(library._doc(raw(lines), CHINESE)[0])
        self.assertIn('宾馆也选好了吗？', found)
        self.assertNotIn('杨同乐', ''.join(found))
        self.assertNotIn('像', ''.join(found))
        self.assertIn('stroke', ' '.join(found))

    def test_other_books(self):
        found = ' '.join(text(library._doc(raw(PAGE), {**CHINESE, 'language': 'en', 'dropPinyin': False})[0]))
        self.assertIn('刘明', found)  # (only Chinese books)


if __name__ == '__main__':
    unittest.main()

"""Lists of new words in Chinese books (tools/segment_text.py word_lists, web/library.py): each row a
paragraph of its own, in the order of the list: its word, then its meaning (also on several lines,
above the middle of the row too); the pinyin, part of speech and number of the row left out (with
the pinyin). The text beside the list stays as it is.

Run: python -m unittest web/tests/test_word_lists.py
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

# New HSK Course 3, p.25, as the app's OCR read it (Chinese and English passes put together): the
# box of new words, and lines of the dialogue beside it. "服务" is misread "月艮务"; OCR did not read
# "尝" and "记". The meaning of "员" is on four lines, the first two above the row's middle.
PAGE_25 = [
    [('生', 892, 505, 32, 29), ('词', 925, 505, 30, 31), ('New', 974, 511, 60, 21), ('Words', 1042, 509, 88, 23), ('2-4', 1180, 510, 39, 22)],
    [('这', 365, 574, 38, 34), ('家', 413, 573, 32, 37), ('饭', 451, 574, 40, 33), ('馆', 495, 574, 38, 35), ('的', 541, 574, 33, 35),
     ('服', 581, 575, 39, 33), ('务', 626, 573, 38, 38), ('很', 667, 575, 41, 35), ('热', 714, 574, 34, 36), ('情', 756, 572, 37, 39),
     ('，', 804, 600, 9, 12)],
    [('月', 965, 592, 12, 26), ('艮', 978, 591, 19, 27), ('务', 1001, 588, 28, 32), ('·', 1030, 604, 1, 2)],
    [('füWü', 1049, 591, 66, 26)],
    [('serve', 1256, 599, 67, 18)],
    [('v.', 1186, 600, 21, 16)],
    [('菜', 368, 626, 35, 39), ('也', 409, 628, 38, 34), ('都', 453, 626, 36, 40), ('做', 495, 629, 39, 34), ('得', 538, 627, 38, 38),
     ('很', 581, 629, 40, 35), ('好', 625, 630, 39, 33), ('吃', 669, 627, 37, 36), ('。', 715, 652, 13, 12), ('你', 756, 628, 36, 36),
     ('们', 800, 628, 35, 35)],
    [('added', 1255, 645, 83, 25), ('after', 1343, 646, 63, 30), ('a', 1412, 654, 17, 16)],
    [('尝', 368, 680, 33, 37), ('尝', 408, 680, 33, 37), ('，', 449, 707, 8, 13), ('看', 485, 680, 35, 38), ('喜', 523, 679, 38, 40),
     ('不', 563, 685, 34, 31), ('喜', 601, 680, 38, 39), ('欢', 642, 681, 36, 35), ('这', 679, 682, 38, 34), ('些', 721, 681, 34, 35),
     ('菜', 760, 680, 35, 39)],
    [('noun', 1255, 694, 65, 16), ('or', 1328, 694, 30, 16), ('verb', 1366, 685, 57, 25)],
    [('员', 968, 702, 24, 33)],
    [('yuån', 1048, 706, 65, 32)],
    [('suf.', 1187, 706, 46, 25)],
    [('to', 1256, 730, 24, 21), ('indicate', 1289, 726, 104, 25), ('a', 1402, 734, 16, 17)],
    [('person', 1252, 774, 91, 24)],
    [('shudng', 1049, 818, 98, 31)],
    [('pair', 1255, 818, 52, 31)],
    [('双', 966, 819, 31, 22)],
    [('m.', 1187, 825, 31, 17)],
    [('(D', 912, 864, 33, 33), ('筷', 967, 866, 28, 31), ('子', 1000, 868, 30, 30), ('kubizi', 1050, 870, 76, 25)],
    [('chopsticks', 1255, 870, 137, 30)],
    [('n.', 1186, 877, 23, 17)],
    [('勺', 968, 919, 25, 30), ('子', 1000, 920, 30, 30), ('shåozi', 1049, 922, 86, 25)],
    [('n.', 1186, 929, 23, 17)],
    [('spoon', 1256, 929, 76, 24)],
    [('@', 912, 969, 33, 31), ('碗', 965, 972, 33, 27)],
    [('wån', 1048, 973, 56, 25)],
    [('bowl', 1255, 973, 65, 25)],
    [('n.', 1186, 981, 23, 17)],
    [('马', 966, 1024, 28, 29), ('上', 1000, 1024, 31, 26), ('måshang', 1050, 1026, 117, 31), ('adv.', 1187, 1026, 51, 24),
     ('immediately', 1256, 1025, 152, 32)],
    [('14', 919, 1027, 20, 18)],
    [('C)', 913, 1072, 32, 33), ('热', 967, 1075, 28, 30), ('情', 1000, 1073, 30, 33), ('réqing', 1050, 1078, 88, 31)],
    [('adj.', 1186, 1078, 47, 31), ('warm', 1255, 1085, 74, 17)],
    [('chång', 1049, 1129, 81, 32)],
    [('taste', 1255, 1133, 60, 21)],
    [('v.', 1186, 1137, 21, 17)],
    [('remember', 1255, 1182, 133, 24)],
    [('v.', 1186, 1189, 21, 17)],
    [('用', 968, 1232, 25, 28)],
    [('ybng', 1048, 1233, 67, 32)],
    [('eat;', 1256, 1237, 44, 25), ('drink;', 1309, 1233, 74, 29), ('use', 1393, 1241, 41, 17)],
    [('18', 919, 1235, 20, 18)],
    [('v.', 1186, 1241, 21, 17)],
]


def raw(lines):
    return {'w': 1601, 'h': 2265, 'lines': [{'words': [dict(zip('txywh', w)) for w in ln]} for ln in lines]}


def paragraphs(doc):
    """The page's paragraphs, each the text of its sentences."""
    return [[S.unit_text(doc['words'], *doc['sent'][s]) for s in range(a, b)] for a, b in doc['blocks']]


def row(y, word, reading, pos, meaning, x=140, h=30):
    """A row of a made-up list: the word at x, its reading, part of speech and meaning in columns."""
    out = []
    for at, text in ((x, word), (x + 90, reading), (x + 190, pos), (x + 260, meaning)):
        for t in text.split():
            for piece in (S.CJK_PIECE.findall(t) if S.CJK.search(t) else [t]):
                w = h if S.CJK.search(piece) else 14 * len(piece)
                out.append((piece, at, y, w, h))
                at += w + 8
    return out


class WordListTest(unittest.TestCase):
    def test_box_of_new_words(self):
        doc, _ = library._doc(raw(PAGE_25), CHINESE)
        found = paragraphs(doc)
        start = found.index(['生词', 'New Words 2-4']) + 1
        self.assertEqual(found[start:start + 11], [
            ['月艮务', 'serve'], ['员', 'added after a noun or verb to indicate a person'], ['双', 'pair'], ['筷子', 'chopsticks'],
            ['勺子', 'spoon'], ['碗', 'bowl'], ['马上', 'immediately'], ['热情', 'warm'],
            ['taste'], ['remember'],  # (their words not read: they can be added)
            ['用', 'eat; drink; use']])
        # The dialogue beside it, a paragraph as before (not cut by the list's lines).
        self.assertIn(['这家饭馆的服务很热情，菜也都做得很好吃。', '你们尝尝，看喜不喜欢这些菜'], found)
        # No pinyin, parts of speech or numbers of the rows.
        text = ' '.join(t for p in found for t in p)
        for gone in ('füWü', 'yuån', 'shudng', 'måshang', 'v.', 'suf.', 'adj.', '(D', '@', '14', '18'):
            self.assertNotIn(gone, text.split())

    def test_first_row_misread(self):
        # The box read alone (an area): OCR read the first row's "v." as "妩", above a row of 4 lines.
        lines = [[('妩', *w[1:]) if w[0] == 'v.' and w[2] == 600 else w for w in ln] for ln in PAGE_25 if ln[0][1] > 880]
        doc, _ = library._doc(raw(lines), CHINESE)
        self.assertEqual(paragraphs(doc)[1:4], [['月艮务', 'serve'], ['员', 'added after a noun or verb to indicate a person'], ['双', 'pair']])

    def test_pinyin_kept(self):
        # Without leaving out the pinyin: with the word, and the part of speech before the meaning.
        doc, _ = library._doc(raw(PAGE_25), {**CHINESE, 'dropPinyin': False})
        found = paragraphs(doc)
        for entry in (['员 yuån', 'suf. added after a noun or verb to indicate a person'], ['双 shudng', 'm. pair'],
                      ['马上 måshang', 'adv. immediately'], ['chång', 'v. taste']):
            self.assertIn(entry, found)

    def test_two_lists_side_by_side(self):
        # As in New HSK Course 3, p.132: one OCR line across both.
        lines = [row(y, *a) + row(y, *b, x=740) for y, a, b in (
            (100, ('晚会', 'wǎnhuì', 'n.', 'evening party'), ('盘子', 'pánzi', 'n.', 'plate')),
            (150, ('礼物', 'lǐwù', 'n.', 'gift; present'), ('一边', 'yìbiān', 'adv.', 'at the same time')),
            (200, ('画家', 'huàjiā', 'n.', 'painter'), ('聊天儿', 'liáotiānr', 'v.', 'chat')))]
        doc, _ = library._doc(raw(lines), CHINESE)
        self.assertEqual(paragraphs(doc), [['晚会', 'evening party'], ['礼物', 'gift; present'], ['画家', 'painter'],
                                           ['盘子', 'plate'], ['一边', 'at the same time'], ['聊天儿', 'chat']])
        # Their title above the left one (New HSK Course 3, p.32): the title, the left list, then the right one.
        title = [('生', 100, 40, 30, 30), ('词', 132, 40, 30, 30), ('New', 180, 44, 42, 22), ('Words', 230, 44, 70, 22)]
        doc, _ = library._doc(raw([title] + lines), CHINESE)
        self.assertEqual(paragraphs(doc)[0], ['生词', 'New Words'])
        self.assertEqual([p[0] for p in paragraphs(doc)[1:]], ['晚会', '礼物', '画家', '盘子', '一边', '聊天儿'])

    def test_rows_ocr_misread(self):
        # As in New HSK Course 3, p.101: a word OCR did not read (难); a meaning on two lines around
        # its row's middle; a part of speech on two lines ("adj./" ⏎ "v."); one misread ("v." as "妩").
        lines = [row(100, '历史', 'lìshǐ', 'n.', 'history'), row(160, '', 'nán', 'adj.', 'hard; difficult'),
                 row(230, '要求', 'yāoqiú', 'n./v.', ''), row(215, '', '', '', 'requirement;'), row(245, '', '', '', 'require'),
                 row(310, '差', 'chà', '', ''), row(295, '', '', 'adj./', 'poor; be'), row(325, '', '', 'v.', 'short of'),
                 row(380, '复习', 'fùxí', '妩', 'review'), row(440, '外语', 'wàiyǔ', 'n.', 'foreign language')]
        doc, _ = library._doc(raw(lines), CHINESE)
        self.assertEqual(paragraphs(doc), [['历史', 'history'], ['hard; difficult'], ['要求', 'requirement; require'],
                                           ['差', 'poor; be short of'], ['复习', 'review'], ['外语', 'foreign language']])

    def test_not_a_list(self):
        # The table of the parts of speech: their names, then the abbreviations (no meaning after them).
        lines = [row(y, name, english, '', abbreviation) for y, name, english, abbreviation in (
            (100, '名词', 'noun', 'n.'), (150, '动词', 'verb', 'v.'), (200, '形容词', 'adjective', 'adj.'), (250, '副词', 'adverb', 'adv.'))]
        lists, rest = S.word_lists([{'words': [dict(zip('txywh', w)) for w in ln]} for ln in lines])
        self.assertEqual(lists, [])
        self.assertEqual(len(rest), 4)


if __name__ == '__main__':
    unittest.main()

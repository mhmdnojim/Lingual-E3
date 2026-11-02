"""Full stops of Chinese that OCR did not read (tools/segment_text.py missed_stops): each character
takes a cell of the same width, and so does a stop, so an empty cell with a small ring low in it,
between two characters or after the last one of a line, is a "。": the sentence ends there. Not a
comma, a dot, or a closed part of a character (口). Only for words read by OCR (text from a PDF
has its stops); pages corrected before get them back and are cut there (library.restore_stops).

The page is drawn here: characters as squares, the stops as rings.
Run: python -m unittest web/tests/test_missed_stops.py
"""
from pathlib import Path
import sys
import unittest

from PIL import Image, ImageDraw

WEB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WEB))
sys.path.insert(0, str(WEB / 'tools'))
import library  # noqa: E402
import segment_text as S  # noqa: E402

SIZE, PITCH = 36, 42


def page(*lines):
    """lines: (y, cells), each cell a character, '。' (a ring), '，' (a comma), '·' (a dot), '口' (a
    hollow square) or ' '. The picture, and the words OCR reads: the characters, not the marks."""
    img = Image.new('RGB', (1400, 120 * len(lines) + 100), (250, 248, 240))
    draw = ImageDraw.Draw(img)
    raw = []
    for y, cells in lines:
        words = []
        for k, c in enumerate(cells):
            x = 100 + k * PITCH
            if c == '。':
                draw.ellipse((x + 3, y + 24, x + 13, y + 34), outline=(120, 120, 120), width=2)
            elif c == '，':
                draw.ellipse((x + 3, y + 26, x + 9, y + 32), fill=(60, 60, 60))
                draw.line((x + 8, y + 30, x + 4, y + 40), fill=(60, 60, 60), width=2)
            elif c == '·':
                draw.ellipse((x + 4, y + 27, x + 10, y + 33), fill=(60, 60, 60))
            elif c == '口':
                draw.rectangle((x + 4, y + 2, x + SIZE - 4, y + SIZE - 2), outline=(30, 30, 30), width=3)
            elif c != ' ':
                draw.rectangle((x, y, x + SIZE, y + SIZE), fill=(30, 30, 30))
                words.append({'t': c, 'x': x, 'y': y, 'w': SIZE, 'h': SIZE})
        raw.append({'words': words})
    return img, {'w': img.width, 'h': img.height, 'lines': raw}


def sentences(doc):
    return [S.unit_text(doc['words'], a, b) for a, b in doc['sent']]


class MissedStopsTest(unittest.TestCase):
    def test_stops_found(self):
        # New HSK Course 3, p.37: "我觉得这个星期就能搬家。我" ⏎ "准备好。搬家那天" ⏎ "搬完。"
        img, raw = page((100, '我觉得这个星期就能搬家。我'), (150, '准备好。搬家那天'), (200, '搬完。'))
        doc = S.segment(raw, ocr=False, image=img, stops=True)
        self.assertEqual(sentences(doc), ['我觉得这个星期就能搬家。', '我准备好。', '搬家那天搬完。'])

    def test_not_stops(self):
        # A comma, a dot, a closed part of a character (口), an empty cell: no stop.
        img, raw = page((100, '我明天去买，很快'), (220, '他·们来了'), (340, '我口们'), (460, '你 好'))
        doc = S.segment(raw, ocr=False, image=img, stops=True)
        self.assertNotIn('。', ''.join(sentences(doc)))
        # Text from a PDF has its stops: not looked for.
        img, raw = page((100, '我觉得这个星期就能搬家。我'))
        self.assertEqual(sentences(S.segment(raw, ocr=False, image=img)), ['我觉得这个星期就能搬家我'])

    def test_ocr_zero_for_a_stop(self):
        img, raw = page((100, '这个小区挺好的。'))
        raw['lines'][0]['words'].append({'t': '0', 'x': 100 + 7 * PITCH + 2, 'y': 124, 'w': 12, 'h': 12})
        doc = S.segment(raw, ocr=False, image=img, stops=True)
        self.assertEqual(sentences(doc), ['这个小区挺好的。'])

    def test_page_corrected_before(self):
        # Read again by area before, without its stops: one sentence. Put back, cut there; once.
        img, raw = page((100, '我觉得这个星期就能搬家。我'), (150, '准备好。搬家那天'))
        made = S.segment(raw, ocr=False, image=img)
        doc = {**made, 'sent': [[0, len(made['words'])]], 'clause': [[0, len(made['words'])]], 'blocks': [[0, 1]]}
        doc, changed, ends = library.restore_stops(doc, img)
        self.assertTrue(changed)
        doc, _ = S.cut_after(doc, ends)
        self.assertEqual(sentences(doc), ['我觉得这个星期就能搬家。', '我准备好。', '搬家那天'])
        self.assertFalse(library.restore_stops(doc, img)[1])


if __name__ == '__main__':
    unittest.main()

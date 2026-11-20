"""An area read again when the OCR finds nothing: the words the PDF itself has there (its text layer, or the hidden
text a scanner app keeps under the picture) are used, so text that was read from the PDF before is not lost."""
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import library


class FakePage:
    rotation = 0
    width, height = 400.0, 600.0
    bbox = (0, 0, 400.0, 600.0)

    def extract_words(self, **kw):
        def w(t, x0, top):
            return {'text': t, 'x0': x0, 'x1': x0 + 30, 'top': top, 'bottom': top + 10}
        return [w('C.', 10, 100), w('办', 50, 100), w('D.', 120, 100), w('办法', 160, 100), w('E.办公室', 250, 100), w('Other', 10, 300)]


class FakePlumb:
    pages = [FakePage()]

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


BOOK = {'id': 'Lfixture00', 'kind': 'pdf'}


class PdfArea(unittest.TestCase):
    def setUp(self):
        self.patches = [
            mock.patch.object(library, '_pages', return_value=[{'n': '1', 'w': 800, 'h': 1200}]),
            mock.patch.object(library, '_options', return_value={}),
            mock.patch.object(library, '_selection', return_value=([0], 1)),
            mock.patch.object(library, 'folder', return_value='book.pdf'),
            mock.patch('pdfplumber.open', return_value=FakePlumb()),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()

    def test_only_the_words_in_the_area_in_the_pictures_pixels(self):
        # the page picture is twice the PDF's size; the strip round y 100..110 pt = 200..220 px
        out = library.pdf_text_in_area(BOOK, 1, 0, 190, 800, 230)
        self.assertEqual([w['t'] for ln in out['lines'] for w in ln['words']], ['C.', '办', 'D.', '办法', 'E.办公室'])
        first = out['lines'][0]['words'][0]
        self.assertEqual((first['x'], first['y']), (20, 200))
        self.assertEqual((out['w'], out['h']), (800, 1200))

    def test_nothing_there(self):
        self.assertIsNone(library.pdf_text_in_area(BOOK, 1, 0, 700, 800, 800))
        self.assertIsNone(library.pdf_text_in_area({**BOOK, 'kind': 'images'}, 1, 0, 190, 800, 230))
        self.assertIsNone(library.pdf_text_in_area(BOOK, 5, 0, 190, 800, 230), 'a page that is not in the book')


if __name__ == '__main__':
    unittest.main()

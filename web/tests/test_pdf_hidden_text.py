"""PDF books (web/library.py): a PDF made with its text (Word, InDesign …) gives its words; a
scanned book that OCR gave a text hidden under the pictures of its pages (OCRmyPDF …) is said to
be one, and the app offers to read its pages with its own OCR instead.

Run: python -m unittest web/tests/test_pdf_hidden_text.py
"""
from pathlib import Path
import sys
import tempfile
import unittest

WEB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WEB))
sys.path.insert(0, str(WEB / 'tools'))
import library  # noqa: E402

OPTIONS = {'language': 'en', 'english': False, 'pinyin': 'none', 'dropPinyin': False, 'pages': '', 'ocrAll': False,
           'margins': False, 'enhance': False, 'fixes': ''}


def pdf(mode):
    """A one-page PDF with a line of text drawn in this text render mode (0: seen, 3: invisible)."""
    contents = f"BT /F1 18 Tf {mode} Tr 40 130 Td (This is a sample page of the book.) Tj ET".encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 190] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(contents)).encode() + b" >>\nstream\n" + contents + b"\nendstream",
    ]
    output = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, item in enumerate(objects, 1):
        offsets.append(len(output))
        output.extend(f"{number} 0 obj\n".encode() + item + b"\nendobj\n")
    xref = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    for offset in offsets:
        output.extend(f"{offset:010d} 00000 n \n".encode())
    output.extend(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return bytes(output)


class HiddenTextTest(unittest.TestCase):
    def made(self, mode):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'book.pdf'
            path.write_bytes(pdf(mode))
            (img, raw, how), = library._pdf_pages(str(path), [0], False, lambda *a: None)
            return img, raw, how

    def test_text_of_the_pdf(self):
        img, raw, how = self.made(0)
        self.assertEqual(how, 'pdf')
        self.assertIn('sample', [w['t'] for ln in raw['lines'] for w in ln['words']])
        doc, info = library._doc(raw, OPTIONS, img)
        self.assertEqual(library._tips('pdf', OPTIONS, [0], [(img, doc, {'how': how, **info})]), [])

    def test_text_hidden_under_a_scan(self):
        img, raw, how = self.made(3)
        self.assertEqual(how, 'hidden')
        self.assertIn('sample', [w['t'] for ln in raw['lines'] for w in ln['words']], '(its words are still used)')
        doc, info = library._doc(raw, OPTIONS, img)
        tips = library._tips('pdf', OPTIONS, [0], [(img, doc, {'how': how, **info})])
        self.assertEqual([t.get('set') for t in tips], [{'ocrAll': True}])
        self.assertIn('scanned book', tips[0]['text'])
        # Asked for already: not offered again.
        self.assertEqual(library._tips('pdf', {**OPTIONS, 'ocrAll': True}, [0], [(img, doc, {'how': how, **info})]), [])


if __name__ == '__main__':
    unittest.main()

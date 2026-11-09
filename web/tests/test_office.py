"""A book added from a Word file (web/office.py, web/library.py save_source 'word'): the kinds of
Word file are told by their bytes (not by their name); what is not a Word file is refused; the
file is kept and made into the book's PDF (book.pdf), which then is read as any PDF; a Word file
sent again replaces the first; without Word or LibreOffice the person is told what to do. When
this computer has Word or LibreOffice, a real Word file is made into a PDF with its words.

Run: python -m unittest web/tests/test_office.py
"""
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
import zipfile

WEB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WEB / 'tools'))
sys.path.insert(0, str(WEB))
import db  # noqa: E402
import library  # noqa: E402
import office  # noqa: E402

ADMIN = {'id': db.LOCAL_USER, 'name': 'You', 'admin': True}


def docx(*paragraphs):
    """A small Word file (.docx) with these paragraphs."""
    body = ''.join(f'<w:p><w:r><w:t>{p}</w:t></w:r></w:p>' for p in paragraphs)
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml',
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Default Extension="xml" ContentType="application/xml"/>'
                   '<Override PartName="/word/document.xml" '
                   'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        z.writestr('_rels/.rels',
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
                   'Target="word/document.xml"/></Relationships>')
        z.writestr('word/document.xml',
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                   f'<w:body>{body}</w:body></w:document>')
    return out.getvalue()


def odt():
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w') as z:
        z.writestr('mimetype', 'application/vnd.oasis.opendocument.text')
        z.writestr('content.xml', '<office:document-content/>')
    return out.getvalue()


def a_pdf(src, out):
    """(a stand-in for Word: a one-page PDF)"""
    import pypdfium2 as pdfium
    pdf = pdfium.PdfDocument.new()
    pdf.new_page(600, 800)
    pdf.save(out)
    pdf.close()


class KindTest(unittest.TestCase):
    def test_told_by_the_bytes(self):
        self.assertEqual(office.kind_of(docx('Hello.')), '.docx')
        self.assertEqual(office.kind_of(odt()), '.odt')
        self.assertEqual(office.kind_of(b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1' + bytes(500)), '.doc')
        self.assertEqual(office.kind_of(b'{\\rtf1\\ansi Hello.}'), '.rtf')
        other = io.BytesIO()
        with zipfile.ZipFile(other, 'w') as z:
            z.writestr('photo.jpg', b'...')
        for data in (b'%PDF-1.4 ...', other.getvalue(), b'PK\x03\x04 broken', b'Just text.', b''):
            self.assertIsNone(office.kind_of(data), data[:12])


class WordBookTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='lingua-office-test-')
        self.old_conn, db._conn = db._conn, None
        self.patches = [mock.patch.object(db, 'DATA', self.tmp.name),
                        mock.patch.object(library, 'BOOKS', str(Path(self.tmp.name) / 'books'))]
        for patch in self.patches:
            patch.start()
        self.b = library.create(ADMIN, {'kind': 'pdf', 'title': 'From Word', 'importOptions': {'language': 'en'}})

    def tearDown(self):
        if db._conn is not None:
            db._conn.close()
        db._conn = self.old_conn
        for patch in reversed(self.patches):
            patch.stop()
        self.tmp.cleanup()

    def source(self):
        return sorted(p.name for p in Path(library.folder(self.b['id'], 'source')).iterdir())

    def test_not_a_word_file(self):
        for data in (b'%PDF-1.4 a PDF', b'Just text.', odt()[:20]):
            with self.assertRaisesRegex(library.LibraryError, 'not a Word file'):
                library.save_source(self.b, ADMIN, 'word', data)
        self.assertEqual(self.source(), [])
        text = library.create(ADMIN, {'kind': 'text', 'title': 'A text'})
        with self.assertRaisesRegex(library.LibraryError, 'does not fit'):
            library.save_source(text, ADMIN, 'word', docx('Hello.'))

    def test_kept_and_made_into_the_pdf(self):
        with mock.patch.object(office, 'to_pdf', side_effect=a_pdf) as made:
            library.save_source(self.b, ADMIN, 'word', docx('Hello.'))
        self.assertEqual(made.call_args[0][0], library.folder(self.b['id'], 'source', 'book.docx'))
        self.assertEqual(self.source(), ['book.docx', 'book.pdf'])
        self.assertEqual(library._selection(self.b, library._options(self.b)), ([0], 1))  # (read as a PDF)
        # Sent again (another kind): it replaces the first.
        with mock.patch.object(office, 'to_pdf', side_effect=a_pdf):
            library.save_source(self.b, ADMIN, 'word', b'{\\rtf1\\ansi Hello.}')
        self.assertEqual(self.source(), ['book.pdf', 'book.rtf'])

    def test_too_big(self):
        user = {'id': db.LOCAL_USER, 'name': 'You', 'admin': False}
        with mock.patch.dict(library.LIMITS, {'pdf_mb': 0.0001, 'user_mb': 600}):  # (about 100 bytes)
            with self.assertRaisesRegex(library.LibraryError, 'too big'):
                library.save_source(self.b, user, 'word', docx('Hello. ' * 400))

    def test_without_word_or_libreoffice(self):
        with mock.patch.object(office, 'engine', return_value=None):
            self.assertFalse(office.available())
            with self.assertRaisesRegex(library.LibraryError, r'(?s)Save As → PDF.*add the PDF'):
                library.save_source(self.b, ADMIN, 'word', docx('Hello.'))
        self.assertNotIn('book.pdf', self.source())

    def test_what_word_says(self):
        """Word's own error (by PowerShell) told plainly: a password, or a file it cannot open."""
        said = {'password': b'error: The password is incorrect. Word cannot open the document.\r\n',
                'damaged': b'error: Word experienced an error trying to open the file.\r\n'}
        for case, out in said.items():
            done = mock.Mock(stdout=out, returncode=0)
            with mock.patch.object(office.subprocess, 'run', return_value=done), \
                 self.assertRaises(office.OfficeError) as e:
                office._by_word('in.docx', self.tmp.name)
            self.assertRegex(str(e.exception), 'protected with a password' if case == 'password' else 'could not open this file')

    @unittest.skipUnless(office.available(), 'no Word or LibreOffice on this computer')
    def test_a_real_word_file(self):
        """(Word or LibreOffice itself: a few seconds)"""
        import pdfplumber
        before = word_copies()
        library.save_source(self.b, ADMIN, 'word', docx('Hello from Word.', '我们学习中文。', 'Wǒmen xuéxí zhōngwén.'))
        with pdfplumber.open(library.folder(self.b['id'], 'source', 'book.pdf')) as pdf:
            text = pdf.pages[0].extract_text()
        for said in ('Hello from Word.', '我们学习中文。', 'Wǒmen xuéxí zhōngwén.'):
            self.assertIn(said, text)
        self.assertLessEqual(word_copies(), before, 'Word quit after the file (it stayed open in the background before)')


def word_copies():
    """How many copies of Word the app's way (PowerShell: "/Automation") are open (0 without Word)."""
    if office.engine() != 'word':
        return 0
    import subprocess
    import time
    time.sleep(1)  # (Word closing)
    r = subprocess.run([office._powershell(), '-NoProfile', '-Command',
                        "@(Get-CimInstance Win32_Process -Filter \"Name='WINWORD.EXE'\" | "
                        "Where-Object { $_.CommandLine -match '/Automation' }).Count"], capture_output=True, text=True)
    return int(r.stdout.strip() or 0)


if __name__ == '__main__':
    unittest.main()

"""Replacing a picture on a page of a book (web/pictures.py, web/library.py): the new picture fills
the box in the page picture and in the PDF (the PDF's picture inside the box taken out), the words
of the old picture leave the page's text; each replacement can be taken back (page and PDF as they
were). A picture made by an AI image service (a stand-in here). The server's settings keep the PIN.

Run: python -m unittest web/tests/test_pictures.py
"""
import base64
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

from PIL import Image

WEB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WEB / 'tools'))
sys.path.insert(0, str(WEB))
import auth  # noqa: E402
import db  # noqa: E402
import library  # noqa: E402
import pictures  # noqa: E402

RED, BLUE, GREEN = (220, 30, 30), (30, 60, 220), (30, 180, 60)


def picture(color, size=(300, 200), kind='PNG'):
    out = io.BytesIO()
    Image.new('RGB', size, color).save(out, kind)
    return out.getvalue()


def pdf_with_a_picture(path):
    """A PDF page 600 × 800 pt with a red picture at 100-300 (across), 500-600 (from the bottom)."""
    import pypdfium2 as pdfium
    pdf = pdfium.PdfDocument.new()
    page = pdf.new_page(600, 800)
    img = pdfium.PdfImage.new(pdf)
    img.set_bitmap(pdfium.PdfBitmap.from_pil(Image.new('RGB', (200, 100), RED)))
    img.set_matrix(pdfium.PdfMatrix().scale(200, 100).translate(100, 500))
    page.insert_obj(img)
    page.gen_content()
    pdf.save(path)
    pdf.close()


def pdf_look(path):
    """The PDF's first page drawn 1600 wide (as the app draws pages), and how many pictures it has."""
    import pypdfium2 as pdfium
    import pypdfium2.raw as pdfium_c
    pdf = pdfium.PdfDocument(path)
    page = pdf[0]
    img = page.render(scale=1600 / page.get_size()[0]).to_pil().convert('RGB')
    n = len(list(page.get_objects(filter=[pdfium_c.FPDF_PAGEOBJ_IMAGE])))
    pdf.close()
    return img, n


def near(a, b, by=40):
    return all(abs(x - y) <= by for x, y in zip(a, b))


class PictureTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='lingua-pictures-test-')
        self.old_conn, db._conn = db._conn, None
        self.patches = [mock.patch.object(db, 'DATA', self.tmp.name),
                        mock.patch.object(library, 'BOOKS', str(Path(self.tmp.name) / 'books'))]
        for patch in self.patches:
            patch.start()
        b = library.create({'id': db.LOCAL_USER, 'name': 'You', 'admin': True}, {'kind': 'pdf', 'title': 'Pictures', 'importOptions': {'language': 'en'}})
        self.bid = b['id']
        pdf_with_a_picture(library.folder(self.bid, 'source', 'book.pdf'))
        page, _ = pdf_look(library.folder(self.bid, 'source', 'book.pdf'))
        for sub in ('pages', 'thumbs', 'text'):
            Path(library.folder(self.bid, sub)).mkdir(parents=True)
        page.save(library.folder(self.bid, 'pages', '1.webp'), 'WEBP', quality=90)
        page.save(library.folder(self.bid, 'thumbs', '1.webp'), 'WEBP')
        self.size = page.size  # (1600 × 2133)
        k = 1600 / 600
        self.box = [round(100 * k), round(200 * k), round(200 * k), round(100 * k)]  # (the red picture, in the page's pixels)
        # Its words: one in the picture (a label), one outside.
        words = [[self.box[0] + 50, self.box[1] + 50, 80, 30, 'Label', 0, 1], [100, 1500, 120, 30, 'Outside.', 1, 0]]
        doc = {'words': words, 'sent': [[0, 1], [1, 2]], 'clause': [[0, 1], [1, 2]], 'blocks': [[0, 1], [1, 2]]}
        Path(library.folder(self.bid, 'text', '1.json')).write_text(json.dumps(doc), encoding='utf-8')
        db.run("UPDATE books SET status = 'ready', pages = ? WHERE id = ?",
               (json.dumps([{'n': '1', 'w': page.width, 'h': page.height, 'words': 2}]), self.bid))

    def tearDown(self):
        if db._conn is not None:
            db._conn.close()
        db._conn = self.old_conn
        for patch in reversed(self.patches):
            patch.stop()
        self.tmp.cleanup()

    def middle(self, img, box):
        return img.getpixel((box[0] + box[2] // 2, box[1] + box[3] // 2))

    def page(self):
        with Image.open(library.folder(self.bid, 'pages', '1.webp')) as im:
            return im.convert('RGB')

    def test_replaced_on_the_page_and_in_the_pdf_then_taken_back(self):
        b = library.get(self.bid)
        pdf = library.folder(self.bid, 'source', 'book.pdf')
        before = Path(pdf).read_bytes()
        first = library.replace_picture(b, '1', self.box, picture(BLUE), 'cover')
        self.assertEqual(first['words'], 1)  # (the label of the old picture)
        self.assertTrue(near(self.middle(self.page(), self.box), BLUE))
        look, n = pdf_look(pdf)
        self.assertTrue(near(self.middle(look, self.box), BLUE), self.middle(look, self.box))
        self.assertEqual(n, 1, 'the red picture taken out of the PDF, the new one in')
        text = library.text_doc(self.bid, '1')
        self.assertEqual([w[4] for w in text['words']], ['Outside.'])
        # A second one, beside it (part of a picture: the PDF's picture is not inside, it stays under).
        other = [self.box[0] + self.box[2] + 40, self.box[1], 200, 150]
        second = library.replace_picture(library.get(self.bid), '1', other, picture(GREEN, kind='JPEG'), 'contain')
        look, n = pdf_look(pdf)
        self.assertTrue(near(self.middle(look, self.box), BLUE) and near(self.middle(look, other), GREEN))
        self.assertEqual(len(library.pictures_of(library.get(self.bid), 1)), 2)
        # The first taken back: red again, there; the second stays.
        library.restore_picture(library.get(self.bid), first['picture']['id'])
        look, _ = pdf_look(pdf)
        self.assertTrue(near(self.middle(self.page(), self.box), RED) and near(self.middle(self.page(), other), GREEN))
        self.assertTrue(near(self.middle(look, self.box), RED) and near(self.middle(look, other), GREEN))
        # The second too: the page and the PDF as they were.
        library.restore_picture(library.get(self.bid), second['picture']['id'])
        self.assertEqual(Path(pdf).read_bytes(), before)
        self.assertFalse(Path(library.folder(self.bid, 'source', 'book.original.pdf')).exists())
        self.assertFalse(Path(library.folder(self.bid, 'pictures', 'page-1.webp')).exists())
        self.assertTrue(near(self.middle(self.page(), self.box), RED))
        self.assertEqual(library.pictures_of(library.get(self.bid)), [])

    def test_what_is_refused(self):
        b = library.get(self.bid)
        for box, data, fit, said in ((self.box, b'not a picture', 'cover', 'not a picture'), ([10, 10, 5, 5], picture(BLUE), 'cover', 'bigger box'),
                                     (self.box, picture(BLUE), 'stretch', 'how the picture fills')):
            with self.assertRaisesRegex(library.LibraryError, said):
                library.replace_picture(b, '1', box, data, fit)
        self.assertEqual(library.pictures_of(b), [])
        self.assertFalse(Path(library.folder(self.bid, 'source', 'book.original.pdf')).exists())


class FitTest(unittest.TestCase):
    def test_cover_and_contain(self):
        img = Image.new('RGB', (400, 100), BLUE)
        self.assertEqual(pictures.fitted(img, 200, 200, 'cover').getpixel((5, 5)), BLUE)  # (filled, its edges cut)
        whole = pictures.fitted(img, 200, 200, 'contain')
        self.assertEqual((whole.size, whole.getpixel((100, 5)), whole.getpixel((100, 100))), ((200, 200), (255, 255, 255), BLUE))

    def test_transparent_on_white(self):
        out = io.BytesIO()
        Image.new('RGBA', (50, 50), (0, 0, 0, 0)).save(out, 'PNG')
        with Image.open(io.BytesIO(pictures.normalized(out.getvalue()))) as im:
            self.assertTrue(near(im.getpixel((10, 10)), (255, 255, 255), 3))


class AiTest(unittest.TestCase):
    def answer(self, data):
        r = mock.MagicMock()
        r.read.return_value = json.dumps(data).encode('utf-8')
        r.__enter__.return_value = r
        return r

    def test_made_from_words_or_from_the_old_picture(self):
        png = picture(GREEN)
        asked = []

        def urlopen(req, timeout=0):
            asked.append(req)
            return self.answer({'data': [{'b64_json': base64.b64encode(png).decode('ascii')}]})
        with mock.patch.object(pictures.urllib.request, 'urlopen', urlopen):
            self.assertEqual(pictures.ai_picture('A boy reading', 'key-1', 'gpt-image-1', '1536x1024'), png)
            self.assertEqual(pictures.ai_picture('Like this, in winter', 'key-1', 'gpt-image-1', '1024x1024', like=picture(RED, kind='JPEG')), png)
        self.assertTrue(asked[0].full_url.endswith('/images/generations'))
        self.assertEqual(json.loads(asked[0].data)['size'], '1536x1024')
        self.assertEqual(asked[0].get_header('Authorization'), 'Bearer key-1')
        self.assertTrue(asked[1].full_url.endswith('/images/edits'))
        self.assertIn(b'name="image"; filename="old.jpg"', asked[1].data)
        self.assertEqual((pictures.ai_size(300, 100), pictures.ai_size(100, 300), pictures.ai_size(100, 110)), ('1536x1024', '1024x1536', '1024x1024'))

    def test_without_a_description(self):
        """No description: the old picture made again, with the page's text around it; a description: as it is."""
        auto = pictures.ai_prompt('', 'Two brothers fighting over a toy.', like=True)
        self.assertTrue(auto.startswith(pictures.AUTO) and auto.endswith('“Two brothers fighting over a toy.”.'))
        self.assertEqual(pictures.ai_prompt('', '', like=True), pictures.AUTO)
        self.assertEqual(pictures.ai_prompt('  A red   bus ', 'ignored', like=False), 'A red bus')
        with self.assertRaisesRegex(pictures.PictureError, 'Describe the picture'):
            pictures.ai_prompt('', 'some text', like=False)

    def test_said_plainly(self):
        err = pictures.urllib.error.HTTPError('u', 401, 'no', {}, io.BytesIO(b'{"error": {"message": "bad key"}}'))
        with mock.patch.object(pictures.urllib.request, 'urlopen', side_effect=err):
            with self.assertRaisesRegex(pictures.PictureError, 'OpenAI did not accept the key.*other AIs \\(Kimi'):
                pictures.ai_picture('A cat', 'wrong', 'gpt-image-1', '1024x1024')
        for prompt, key, said in (('', 'k', 'Write what'), ('A cat', '', 'No key')):
            with self.assertRaisesRegex(pictures.PictureError, said):
                pictures.ai_picture(prompt, key, 'gpt-image-1', '1024x1024')


class ConfigTest(unittest.TestCase):
    def test_the_pin_kept_with_the_key(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(auth, 'CONFIG', str(Path(d) / 'server-config.json')):
            pin = auth.lan_pin()
            auth.set_config(imageKey='sk-test')
            self.assertEqual((auth.lan_pin(), auth.config()['imageKey']), (pin, 'sk-test'))
            auth.set_config(imageKey=None)
            self.assertEqual(auth.config(), {'password': pin})
            self.assertEqual(pictures.ai_settings({'imageKey': 'a'}), ('a', 'gpt-image-1'))


if __name__ == '__main__':
    unittest.main()

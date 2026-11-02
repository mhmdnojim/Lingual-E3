"""Lines of pinyin in Chinese books (web/library.py): left out of the text, also as OCR misreads
them ("w6men", "zhGowd") and when OCR joins them with what is beside them on the page (a
speaker's name, a box of new words); English stays, also English that looks a little like pinyin.

Run: python -m unittest web/tests/test_pinyin_lines.py
"""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

WEB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WEB))
sys.path.insert(0, str(WEB / 'tools'))
import db  # noqa: E402
import library  # noqa: E402
import segment_text as S  # noqa: E402

CHINESE = {'language': 'zh-Hans', 'english': True, 'pinyin': 'lines', 'dropPinyin': True,
           'pages': '', 'ocrAll': False, 'margins': False, 'enhance': False, 'fixes': ''}


def line(y, *parts):
    """A line at y: its parts (x, text), each text split into words as OCR gives them (Chinese: a
    character each)."""
    words = []
    for x, text in parts:
        for t in text.split():
            for piece in (S.CJK_PIECE.findall(t) if S.CJK.search(t) else [t]):
                w = 40 if S.CJK.search(piece) else 14 * len(piece)
                words.append({'t': piece, 'x': x, 'y': y, 'w': w, 'h': 30})
                x += w + 8
    return {'words': words}


# The dialogue of HSK 2, lesson 1, as OCR read it: the speaker's name (and "New Words" in the box
# beside it) on the line of the pinyin, which is misread.
PAGE = [
    line(100, (100, '@ 竞'), (300, 'shi, w6men shi ldi “Ity6u de.'), (900, '竺三 New Words 1-4')),
    line(140, (300, '不是，我们是来旅游的。')),
    line(200, (300, 'y6u shi jib zhGowd.')),
    line(240, (300, '有事就找我。')),
    line(300, (300, '用“多”表达概数'), (700, 'after the measure word. For example:')),
    line(340, (300, '多用在数量词后面。')),
]


def texts(doc):
    return [S.unit_text(doc['words'], a, b) for a, b in doc['sent']]


class PinyinLinesTests(unittest.TestCase):
    def test_a_new_page_leaves_out_the_pinyin_misread_and_beside_other_words(self):
        doc, found = library._doc({'lines': PAGE, 'w': 1200, 'h': 1600}, CHINESE)
        words = ' '.join(texts(doc))
        for gone in ('w6men', 'Ity6u', 'zhGowd'):
            self.assertNotIn(gone, words)
        for kept in ('不是', '有事就找我', 'New Words', 'after the measure word. For example:', '多用在'):
            self.assertIn(kept, words)
        self.assertEqual(found['pinyin'], 2, '(two lines had pinyin)')

    def test_english_which_looks_a_little_like_pinyin_stays(self):
        english = [line(100, (100, '主谓谓语句'), (500, 'can be placed either before or after the verb.')), line(140, (100, '他每天跑步。'))]
        doc, _ = library._doc({'lines': english, 'w': 1200, 'h': 1600}, CHINESE)
        self.assertIn('can be placed either before or after the verb.', texts(doc))

    def test_a_page_made_before_loses_its_pinyin_and_keeps_its_sentences(self):
        made = S.doc_from_blocks([[ln] for ln in PAGE])  # (made without leaving out the pinyin)
        self.assertIn('y6u shi jib zhGowd.', texts(made))
        doc, changed = library.drop_pinyin(made)
        self.assertTrue(changed)
        self.assertNotIn('y6u shi jib zhGowd.', texts(doc))
        self.assertIn('有事就找我。', texts(doc))
        self.assertEqual(len(doc['sent']), len(made['sent']) - 2, 'two sentences of pinyin gone, the others as they were')
        self.assertTrue(all(0 <= a < b <= len(doc['words']) for a, b in doc['sent'] + doc['clause']))
        self.assertEqual(library.drop_pinyin(doc), (doc, False), 'nothing more the second time')


class LibraryBooksTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='lingua-pinyin-test-')
        self.old_conn, db._conn = db._conn, None
        self.patches = [mock.patch.object(db, 'DATA', self.tmp.name),
                        mock.patch.object(library, 'BOOKS', str(Path(self.tmp.name) / 'books'))]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        if db._conn is not None:
            db._conn.close()
        db._conn = self.old_conn
        for patch in reversed(self.patches):
            patch.stop()
        self.tmp.cleanup()

    def test_a_chinese_book_made_before_loses_its_pinyin_once(self):
        user = {'id': db.LOCAL_USER, 'name': 'You', 'admin': True}
        zh = library.create(user, {'kind': 'pdf', 'title': 'HSK 2', 'importOptions': CHINESE})
        en = library.create(user, {'kind': 'pdf', 'title': 'English', 'importOptions': {'language': 'en'}})
        made = S.doc_from_blocks([[ln] for ln in PAGE])
        for b in (zh, en):
            db.run("UPDATE books SET status = 'ready' WHERE id = ?", (b['id'],))
            Path(library.folder(b['id'], 'text')).mkdir(parents=True)
            Path(library.folder(b['id'], 'text', '1.json')).write_text(json.dumps(made, ensure_ascii=False), encoding='utf-8')
        library.resegment_books()
        page = library.text_doc(zh['id'], 1)
        self.assertNotIn('y6u shi jib zhGowd.', texts(page))
        self.assertIn('有事就找我。', texts(page))
        self.assertIn('w6men', json.dumps(library.text_doc(en['id'], 1), ensure_ascii=False), 'a book not in Chinese: its words stay')
        self.assertEqual(library.resegment_books(), 0, 'once')


if __name__ == '__main__':
    unittest.main()

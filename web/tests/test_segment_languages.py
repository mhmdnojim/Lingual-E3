"""Chinese and English in one sentence (a Chinese heading and its English): a sentence each.

Run: python -m unittest web/tests/test_segment_languages.py
"""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

WEB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WEB / 'tools'))
sys.path.insert(0, str(WEB))
import segment_text as S  # noqa: E402
import db  # noqa: E402
import library  # noqa: E402


def words(text):
    """The words of a line as the pages have them: Chinese one per character (its punctuation with it)."""
    out = []
    for chunk in text.split():
        out += S.CJK_PIECE.findall(chunk) if S.CJK.search(chunk) else [chunk]
    return out


def cut(text):
    toks = words(text)
    return [' '.join(toks[a:b]) for a, b in S.language_parts(toks, 0, len(toks))]


def page(*lines):
    """A page of one block, a line each, as doc_from_blocks makes it: its sentences' text."""
    block = [{'words': [{'t': t, 'x': 0, 'y': 0, 'w': 1, 'h': 1} for t in words(line)]} for line in lines]
    doc = S.doc_from_blocks([block])
    return doc, [S.unit_text(doc['words'], a, b) for a, b in doc['sent']]


class LanguagePartsTests(unittest.TestCase):
    def test_a_chinese_heading_and_its_english_are_a_sentence_each(self):
        self.assertEqual(cut('主谓谓语句 Sentences with a Subject-Predicate Phrase as the Predicate'),
                         ['主 谓 谓 语 句', 'Sentences with a Subject-Predicate Phrase as the Predicate'])
        self.assertEqual(cut('看下面的图片 Look at the pictures.'), ['看 下 面 的 图 片', 'Look at the pictures.'])
        self.assertEqual(cut('Notes 注释'), ['Notes', '注 释'])

    def test_quoted_chinese_goes_with_the_english_around_it(self):
        self.assertEqual(cut('动态助词“着”（1） Aspect Particle“着”(1)'),
                         ['动 态 助 词 “ 着 ” （1）', 'Aspect Particle“ 着 ”(1)'])
        self.assertEqual(cut('动态助词 “ 过 “ Aspect Particle “ 过 “'), ['动 态 助 词 “ 过 “', 'Aspect Particle “ 过 “'],
                         'OCR reads the closing quotation mark as an opening one')
        self.assertEqual(cut('固定格式“要/快/快要/就要……了” Fixed Pattern“要/快/快要/就要……了”')[1][:13], 'Fixed Pattern')

    def test_a_heading_on_a_line_of_its_own_is_not_in_the_english_before_it(self):
        _doc, sents = page('课文 Lesson', '注释 Notes')
        self.assertEqual(sents, ['课文', 'Lesson', '注释', 'Notes'])

    def test_a_little_of_one_language_in_the_other_stays(self):
        self.assertEqual(len(cut('In this case, 多 and 几 are interchangeable.')), 1)
        self.assertEqual(len(cut('我在用 iPhone 打电话')), 1)
        self.assertEqual(len(cut('Its negative form is usually 不想 for example')), 1)
        self.assertEqual(len(cut('The word for it is 着')), 1, 'one character after English')

    def test_numbers_abbreviations_and_pinyin_go_with_the_words_around_them(self):
        self.assertEqual(cut('HSK 标准教程 2 Standard Course 2'), ['HSK 标 准 教 程 2', 'Standard Course 2'])
        self.assertEqual(len(cut('我喜欢 iPhone。')), 1)
        self.assertEqual(len(cut('药 yào')), 1)

    def test_english_and_chinese_alone_are_not_cut(self):
        self.assertEqual(len(cut('She treated us to Peking Duck.')), 1)
        self.assertEqual(len(cut('我每天六点起床。')), 1)


class PagesTests(unittest.TestCase):
    def test_a_page_has_a_sentence_for_each_language_with_its_clauses(self):
        doc, sents = page('1. 主谓谓语句 Sentences with a Subject-Predicate Phrase', '2. 选择问句 Alternative Questions')
        self.assertEqual(sents, ['1.', '主谓谓语句', 'Sentences with a Subject-Predicate Phrase', '2.', '选择问句', 'Alternative Questions'],
                         '(the number of an item: a sentence of its own, as in English)')
        for a, b in doc['sent']:  # every clause in one sentence
            self.assertTrue(any(a <= c0 and c1 <= b for c0, c1 in doc['clause'] if c0 == a))

    def test_an_ellipsis_in_chinese_does_not_end_the_sentence(self):
        _doc, sents = page('固定格式“要/快/快要/就要……', '了” Fixed Pattern')
        self.assertEqual([sents[0].replace(' ', ''), sents[1]], ['固定格式“要/快/快要/就要……了”', 'Fixed Pattern'])
        _doc, sents = page('I was going to... Then it rained.')
        self.assertEqual(sents, ['I was going to...', 'Then it rained.'])

    def test_a_page_made_before_is_made_again_from_its_words(self):
        doc, _ = page('主谓谓语句 Sentences with a Subject-Predicate Phrase', '选择问句 Alternative Questions')
        old = {**doc, 'sent': [[0, len(doc['words'])]], 'clause': [[0, len(doc['words'])]], 'blocks': [[0, 1]]}
        new, changed = S.resegment(old)
        self.assertTrue(changed)
        self.assertEqual((new['sent'], new['blocks']), (doc['sent'], doc['blocks']))
        self.assertEqual(S.resegment(new), (new, False), 'once made again: as it is')
        cut_only, changed = S.split_languages(old)  # (the owner's corrections: only cut)
        self.assertTrue(changed)
        self.assertEqual(len(cut_only['sent']), 4)
        english = {**doc, 'words': [[0, 0, 1, 1, t, 0, 1] for t in ['She', 'is', 'here.']], 'sent': [[0, 3]], 'clause': [[0, 3]], 'blocks': [[0, 1]]}
        self.assertEqual(S.resegment(english), (english, False))


class LibraryBooksTests(unittest.TestCase):
    """The library's books made before: their pages made again once when the app starts."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='lingua-sentences-test-')
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

    def test_a_book_made_before_gets_a_sentence_for_each_language_once(self):
        b = library.create({'id': db.LOCAL_USER, 'name': 'You', 'admin': True}, {'kind': 'text', 'title': '汉语', 'importOptions': {'language': 'zh-Hans'}})
        db.run("UPDATE books SET status = 'ready' WHERE id = ?", (b['id'],))
        made, _ = page('课文 Lesson', '注释 Notes')
        old = {**made, 'sent': [[0, len(made['words'])]], 'clause': [[0, len(made['words'])]], 'blocks': [[0, 1]]}
        for sub in ('text', 'edits'):
            Path(library.folder(b['id'], sub)).mkdir(parents=True, exist_ok=True)
            Path(library.folder(b['id'], sub, '1.json')).write_text(json.dumps(old, ensure_ascii=False), encoding='utf-8')
        self.assertEqual(library.resegment_books(), 2)
        text = json.loads(Path(library.folder(b['id'], 'text', '1.json')).read_text(encoding='utf-8'))
        self.assertEqual([S.unit_text(text['words'], a, c) for a, c in text['sent']], ['课文', 'Lesson', '注释', 'Notes'])
        edited = library.text_doc(b['id'], 1)
        self.assertTrue(edited.get('edited'))
        self.assertEqual(len(edited['sent']), 4, "the owner's corrections: cut where the language changes")
        self.assertEqual(library.resegment_books(), 0, 'once')


if __name__ == '__main__':
    unittest.main()

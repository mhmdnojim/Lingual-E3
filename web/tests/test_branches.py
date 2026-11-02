"""The branches of the library (web/branches.py): made, renamed, moved, removed; the disc's levels put in
theirs; books found by them; the course and level of a book (API 20) made into branches.

Run: python -m unittest discover -s web/tests -p test_branches.py -v
"""
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

WEB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WEB))
import branches  # noqa: E402
import db  # noqa: E402
import library  # noqa: E402

USER = {'id': db.LOCAL_USER, 'name': 'You', 'admin': True}


class BranchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='lingua-branches-test-')
        self.old_conn = db._conn
        db._conn = None
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

    def book(self, title, branch=None):
        return library.create(USER, {'kind': 'text', 'title': title, 'branch': branch})

    def test_main_and_sub_branches(self):
        main = branches.create('  Learning   English Courses ')
        aef = branches.create('American English File 2e', main['id'])
        self.assertEqual((main['name'], main['parent'], aef['parent']), ('Learning English Courses', None, main['id']))
        with self.assertRaisesRegex(branches.BranchError, 'already a branch'):
            branches.create('learning english courses')  # (the same name, in the same place)
        branches.create('Learning English Courses', aef['id'])  # (somewhere else: fine)
        with self.assertRaisesRegex(branches.BranchError, 'name'):
            branches.create('   ')
        with self.assertRaisesRegex(branches.BranchError, 'does not exist'):
            branches.create('Level 1', 999)
        self.assertEqual(branches.paths()[aef['id']], ['Learning English Courses', 'American English File 2e'])

    def test_rename_and_move(self):
        a = branches.create('A')
        b = branches.create('B', a['id'])
        c = branches.create('C', b['id'])
        with self.assertRaisesRegex(branches.BranchError, 'cannot go into itself'):
            branches.change(a['id'], {'parent': c['id']})
        with self.assertRaisesRegex(branches.BranchError, 'cannot go into itself'):
            branches.change(a['id'], {'parent': a['id']})
        branches.change(c['id'], {'parent': None, 'name': 'C top'})  # (a main branch now)
        self.assertEqual(branches.paths()[c['id']], ['C top'])
        branches.create('B')
        with self.assertRaisesRegex(branches.BranchError, 'already a branch'):
            branches.change(b['id'], {'parent': None})
        self.assertEqual(branches.change(b['id'], {'name': 'b'})['name'], 'b')  # (its own name, other letters)

    def test_delete_puts_what_was_in_it_in_the_branch_above(self):
        top = branches.create('Courses')
        aef = branches.create('AEF', top['id'])
        l1 = branches.create('Level 1', aef['id'])
        branches.create('Level 1', top['id'])  # (one of the same name above: they become one)
        book = self.book('Lesson', aef['id'])
        other = self.book('Story', l1['id'])
        branches.place_levels([('1', ['Courses', 'AEF'])])
        branches.delete(aef['id'])
        self.assertIsNone(branches.get(aef['id']))
        self.assertEqual(library.get(book['id'])['branch'], top['id'])
        self.assertEqual(branches.level_branches()['1'], top['id'])
        merged = [b for b in branches.all_branches() if b['name'] == 'Level 1']
        self.assertEqual(len(merged), 1)
        self.assertEqual(library.get(other['id'])['branch'], merged[0]['id'])
        branches.delete(top['id'])  # a main branch: what was in it is at the top
        self.assertIsNone(library.get(book['id'])['branch'])
        self.assertIsNone(branches.get(merged[0]['id'])['parent'])

    def test_empty_branches(self):
        a = branches.create('A')
        b = branches.create('B', a['id'])
        self.book('Lesson', b['id'])
        empty = {x['name']: x['empty'] for x in branches.all_branches()}
        self.assertEqual(empty, {'A': True, 'B': False})  # (A has nothing in it itself)

    def test_levels_in_their_branches(self):
        names = ['Learning English Courses', 'American English File 2e', 'Level 1']
        branches.place_levels([('1', names), ('2', names[:2] + ['Level 2'])])
        places = branches.level_branches()
        self.assertEqual(branches.paths()[places['1']], names)
        self.assertEqual(len(branches.all_branches()), 4)  # (made once, for both)
        moved = branches.create('Old levels')
        branches.change(places['1'], {'parent': moved['id']})  # an admin moves it: it stays there
        branches.place_levels([('1', names)])
        self.assertEqual(branches.paths()[branches.level_branches()['1']], ['Old levels', 'Level 1'])
        branches.place_levels([('1', ['Other'])])  # web/levels.json gives it another branch
        self.assertEqual(branches.paths()[branches.level_branches()['1']], ['Other'])

    def test_books_in_branches(self):
        hsk = branches.create('HSK Standard Course')
        h2 = branches.create('HSK 2', hsk['id'])
        b = self.book('Lesson one', h2['id'])
        self.assertEqual(library.summary(b, USER)['branch'], h2['id'])
        self.assertEqual([x['id'] for x in library.list_books(USER, 'mine', 'standard course')], [b['id']], 'found by its branches')
        self.assertEqual(library.list_books(USER, 'mine', 'hsk 3'), [])
        self.assertIsNone(library.update(b, {'branch': None})['branch'])
        with self.assertRaisesRegex(library.LibraryError, 'does not exist'):
            library.update(b, {'branch': 12345})
        self.assertEqual(library.update(b, {'title': 'Lesson 1'})['branch'], None, 'unchanged when not given')

    def test_copies_of_books(self):
        a = branches.create('A')
        b = branches.create('B')
        book = self.book('Lesson one', a['id'])
        link = branches.add_link(book['id'], b['id'], '  My   lesson ')
        self.assertEqual(link['title'], 'My lesson')
        listed = branches.with_links([library.summary(library.get(book['id']), USER)])
        self.assertEqual([(x['title'], x['branch'], x.get('link')) for x in listed],
                         [('Lesson one', a['id'], None), ('My lesson', b['id'], link['id'])])
        self.assertEqual({x.get('link') for x in library.list_books(USER, 'mine', 'my lesson')}, {link['id']}, 'found by its own name')
        branches.change_link(link['id'], {'title': '', 'branch': None})  # (no name of its own: the book's)
        self.assertEqual(branches.with_links([library.summary(library.get(book['id']), USER)])[1]['title'], 'Lesson one')
        with self.assertRaisesRegex(branches.BranchError, 'does not exist'):
            branches.change_link(link['id'], {'branch': 999})
        other = branches.add_link(book['id'], b['id'])
        branches.delete(b['id'])  # (its copies go up, like its books)
        self.assertIsNone(branches.get_link(other['id'])['branch'])
        branches.delete_link(other['id'])
        self.assertIsNone(branches.get_link(other['id']))
        library.delete(library.get(book['id']))  # the book deleted: its copies too
        self.assertEqual(db.rows('SELECT * FROM links'), [])

    def test_copy_a_branch(self):
        top = branches.create('Courses')
        aef = branches.create('AEF', top['id'])
        l1 = branches.create('Level 1', aef['id'])
        mine = self.book('Notes', aef['id'])
        branches.add_link(mine['id'], l1['id'], 'Notes again')
        copy = branches.copy(aef['id'], top['id'], {'1705': l1['id'], '1706': None})
        self.assertEqual(copy['name'], 'AEF (copy)')  # (the same place: another name)
        self.assertEqual(branches.copy(aef['id'], top['id'], {})['name'], 'AEF (copy 2)')
        level = next(b for b in branches.all_branches() if b['parent'] == copy['id'])
        self.assertEqual(level['name'], 'Level 1')
        links = {(r['book'], r['branch'], r['title']) for r in db.rows('SELECT * FROM links WHERE branch IN (?, ?)', (copy['id'], level['id']))}
        self.assertEqual(links, {(mine['id'], copy['id'], ''), ('1705', level['id'], ''), (mine['id'], level['id'], 'Notes again')})
        self.assertEqual(library.get(mine['id'])['branch'], aef['id'], 'the books themselves stay')
        with self.assertRaisesRegex(branches.BranchError, 'into itself'):
            branches.copy(top['id'], l1['id'], {})

    def test_disc_books_renamed_and_moved(self):
        a = branches.create('A')
        b = branches.create('B', a['id'])
        branches.change_disc('1705', {'title': '  Student   Book 1 '})
        self.assertEqual(branches.disc_books()['1705']['title'], 'Student Book 1')
        self.assertEqual(branches.disc_books()['1705']['placed'], 0, 'renamed: still in the branch of its level')
        branches.change_disc('1705', {'branch': b['id']})
        self.assertEqual((branches.disc_books()['1705']['placed'], branches.disc_books()['1705']['branch']), (1, b['id']))
        self.assertFalse(next(x for x in branches.all_branches() if x['id'] == b['id'])['empty'])
        branches.delete(b['id'])
        self.assertEqual(branches.disc_books()['1705']['branch'], a['id'], 'its branch deleted: in the one above')
        branches.change_disc('1705', {'title': ''})
        self.assertEqual(branches.disc_books()['1705']['title'], '', 'its own name again')

    def test_course_and_level_become_branches(self):
        path = Path(self.tmp.name) / 'library.db'
        c = sqlite3.connect(path)
        c.executescript(db.SCHEMA.replace('  branch INTEGER,', "  course TEXT NOT NULL DEFAULT '',\n  level TEXT NOT NULL DEFAULT '',", 1))
        for bid, course, level in (('L0000000001', 'HSK Course', 'HSK 1'), ('L0000000002', 'HSK Course', 'HSK 2'), ('L0000000003', '', '')):
            c.execute("INSERT INTO books (id, owner, title, course, level, kind, created, updated) VALUES (?, 1, 't', ?, ?, 'text', 1, 1)",
                      (bid, course, level))
        c.commit()
        c.close()
        where = branches.paths()
        got = {bid: where.get(library.get(bid)['branch']) for bid in ('L0000000001', 'L0000000002')}
        self.assertEqual(got, {'L0000000001': ['HSK Course', 'HSK 1'], 'L0000000002': ['HSK Course', 'HSK 2']})
        self.assertIsNone(library.get('L0000000003')['branch'], 'no course: at the top')
        columns = {r['name'] for r in db.rows('PRAGMA table_info(books)')}
        self.assertNotIn('course', columns)
        self.assertEqual(len(branches.all_branches()), 3)


if __name__ == '__main__':
    unittest.main()

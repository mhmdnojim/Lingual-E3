"""The audio and video of a book (web/tracks.py, web/library.py): each recording's number from its
name ("AEF3e_Level_3_SB_1.26.mp3": 1.26); a play button on every page where that number is printed
(over its ⊙, which OCR reads as 0: "01.26"); the ones on no page told; all taken out again, the
buttons of an old app imported kept.

Run: python -m unittest web/tests/test_tracks.py
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
import db  # noqa: E402
import library  # noqa: E402
import tracks  # noqa: E402


def page(*lines):
    """A page's text document: its lines, each word 40 wide, 30 tall."""
    words = []
    for n, ln in enumerate(lines):
        for k, t in enumerate(ln.split()):
            words.append([100 + 60 * k, 100 + 50 * n, 40, 30, t, n, 1])
    return {'words': words, 'sent': [[0, len(words)]], 'clause': [[0, len(words)]], 'blocks': [[0, 1]]}


class NumbersTest(unittest.TestCase):
    def test_in_the_names(self):
        self.assertEqual([tracks.track_of(n) for n in ('AEF3e_Level_3_SB_1.26.mp3', 'AEF3e_Level_3_WB_10.1.mp3', 'cd2-07.MP3', 'intro.mp3')],
                         [(1, 26), (10, 1), (2, 7), None])

    def test_on_the_pages(self):
        doc = page('b 01.26 Watch or listen to Jenny.', 'Then listen again 1.27 and check.', 'It costs 2.5 or 1.3 dollars.', '1.2 Listen and repeat.')
        self.assertEqual([t for t, _, _ in tracks.marks(doc)], [(1, 26), (1, 27), (1, 2)])  # (not 2.5, 1.3: decimals in a line)
        self.assertTrue(tracks.marks(doc)[0][2])  # (01.26: its ⊙ read as 0)


class BookTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='lingua-tracks-test-')
        self.old_conn, db._conn = db._conn, None
        self.patches = [mock.patch.object(db, 'DATA', self.tmp.name), mock.patch.object(library, 'BOOKS', str(Path(self.tmp.name) / 'books'))]
        for patch in self.patches:
            patch.start()
        self.user = {'id': db.LOCAL_USER, 'name': 'You', 'admin': True}
        b = library.create(self.user, {'kind': 'pdf', 'title': 'With audio', 'importOptions': {'language': 'en'}})
        self.bid = b['id']
        Path(library.folder(self.bid, 'text')).mkdir(parents=True)
        for n, doc in ((1, page('b 01.26 Watch or listen.')), (2, page('1.2 Listen and repeat.', 'Audioscript 1.26'))):
            Path(library.folder(self.bid, 'text', f'{n}.json')).write_text(json.dumps(doc), encoding='utf-8')
        # An old app's button on page 2 (imported): it stays.
        Path(library.folder(self.bid, 'migration-assets.json')).write_text(json.dumps(
            {'version': 1, 'pages': {'2': [{'t': 'link', 'x': 5, 'y': 5, 'title': 'p.1', 'page': '1'}]}}), encoding='utf-8')
        db.run("UPDATE books SET status = 'ready', pages = ? WHERE id = ?",
               (json.dumps([{'n': '1', 'w': 1600, 'h': 2200}, {'n': '2', 'w': 1600, 'h': 2200}]), self.bid))

    def tearDown(self):
        if db._conn is not None:
            db._conn.close()
        db._conn = self.old_conn
        for patch in reversed(self.patches):
            patch.stop()
        self.tmp.cleanup()

    def test_added_placed_taken_out(self):
        b = library.get(self.bid)
        for name, data in (('AEF_SB_1.26.mp3', b'ID3 one'), ('AEF_SB_1.02.mp3', b'ID3 two'), ('AEF_SB_9.99.mp3', b'ID3 three'), ('notes.txt', b'x')):
            if name.endswith('.txt'):
                with self.assertRaisesRegex(library.LibraryError, 'Only audio and video'):
                    library.add_track(b, self.user, name, data)
            else:
                library.add_track(b, self.user, name, data)
        info = library.place_tracks(b)
        self.assertEqual((info['files'], info['placed'], info['unplaced']), (3, 2, ['AEF_SB_9.99.mp3']))
        full = library.full(library.get(self.bid), self.user)
        one, two = (p['a'] for p in full['pages'])
        self.assertEqual([(a['t'], a['title']) for a in one], [('audio', 'Track 1.26')])
        self.assertEqual(one[0]['x'], round(160 + 0.45 * 30), 'over the ⊙ (in the word: 01.26)')
        self.assertEqual(sorted(a['title'] for a in two), ['Track 1.02', 'Track 1.26', 'p.1'])  # (1.26 again: in the audioscript)
        src = one[0]['src']
        self.assertTrue(src.startswith(f'/lib/{self.bid}/migration-media/') and Path(library.folder(self.bid, 'migration-media', src.split('/')[-1])).read_bytes() == b'ID3 one')
        self.assertEqual(library.place_tracks(library.get(self.bid))['placed'], 2, 'placed again: the same, once')
        self.assertEqual(len(library.full(library.get(self.bid), self.user)['pages'][0]['a']), 1)
        # Taken out: their files and buttons; the old app's button stays.
        info = library.remove_tracks(library.get(self.bid))
        self.assertEqual(info['files'], 0)
        one, two = (p['a'] for p in library.full(library.get(self.bid), self.user)['pages'])
        self.assertEqual((one, [a['title'] for a in two]), ([], ['p.1']))
        self.assertEqual(list(Path(library.folder(self.bid, 'migration-media')).iterdir()), [])

    def test_changed_by_hand(self):
        """Play buttons put, moved and taken away by hand: kept so when the buttons are placed again."""
        b = library.get(self.bid)
        for name in ('AEF_SB_1.26.mp3', 'AEF_SB_1.02.mp3', 'AEF_SB_4.01.mp3'):
            library.add_track(b, self.user, name, f'ID3 {name}'.encode())
        info = library.place_tracks(b)
        self.assertEqual(info['unplaced'], ['AEF_SB_4.01.mp3'])
        self.assertEqual([(it['title'], it['placed']) for it in info['items']], [('Track 1.26', True), ('Track 1.02', True), ('Track 4.01', False)])
        file = {it['title']: it['file'] for it in info['items']}
        buttons = lambda n: library.full(library.get(self.bid), self.user)['pages'][n - 1]['a']  # noqa: E731
        track126 = buttons(1)[0]

        # Put by hand: 4.01 (OCR did not read its number) where the owner clicked; kept on the page.
        spots = library.add_button(b, '1', file['Track 4.01'], 300.4, 99999)
        self.assertEqual([(a['title'], a['x'], a['y'], a.get('manual')) for a in spots][-1], ('Track 4.01', 300, 2200, True))
        self.assertEqual(library.tracks_info(library.get(self.bid))['unplaced'], [])
        with self.assertRaisesRegex(library.LibraryError, 'Choose one of the recordings'):
            library.add_button(b, '1', 'not-a-file.mp3', 1, 1)
        with self.assertRaisesRegex(library.LibraryError, 'no such page'):
            library.add_button(b, '9', file['Track 4.01'], 1, 1)

        # Moved (off the number it covers): now as put by hand, there.
        spots = library.move_button(b, '1', track126['src'], [track126['x'], track126['y']], 150, 80)
        moved = next(a for a in spots if a['title'] == 'Track 1.26')
        self.assertEqual((moved['x'], moved['y'], moved.get('manual'), moved.get('added')), (150, 80, True, None))

        # Taken away (put in a wrong place): 1.26 in the audioscript of page 2; the link stays.
        on2 = next(a for a in buttons(2) if a['title'] == 'Track 1.26')
        spots = library.remove_button(b, '2', on2['src'], on2['x'], on2['y'])
        self.assertEqual(sorted(a['title'] for a in spots), ['Track 1.02', 'p.1'])
        with self.assertRaisesRegex(library.LibraryError, 'not on the page'):
            library.remove_button(b, '2', on2['src'], 0, 0)

        # Placed again (e.g. after adding more files): what was changed by hand stays so.
        library.place_tracks(library.get(self.bid))
        self.assertEqual(sorted((a['title'], a['x'], a['y']) for a in buttons(1)), [('Track 1.26', 150, 80), ('Track 4.01', 300, 2200)])
        self.assertEqual(sorted(a['title'] for a in buttons(2)), ['Track 1.02', 'p.1'])
        info = library.tracks_info(library.get(self.bid))
        self.assertEqual((info['placed'], info['unplaced']), (3, []))
        library.add_track(library.get(self.bid), self.user, 'AEF_SB_1.26.mp3', b'ID3 AEF_SB_1.26.mp3')  # (added again)
        library.place_tracks(library.get(self.bid))
        self.assertEqual(sorted(a['title'] for a in buttons(2)), ['Track 1.02', 'p.1'], 'not put back where it was taken away')

        # A button taken away from its only page: its recording is told as on no page.
        only = next(a for a in buttons(1) if a['title'] == 'Track 4.01')
        library.remove_button(library.get(self.bid), '1', only['src'], only['x'], only['y'])
        self.assertEqual(library.tracks_info(library.get(self.bid))['unplaced'], ['AEF_SB_4.01.mp3'])

        # All taken out: those put by hand too; the old app's button stays.
        library.remove_tracks(library.get(self.bid))
        self.assertEqual((buttons(1), [a['title'] for a in buttons(2)]), ([], ['p.1']))


if __name__ == '__main__':
    unittest.main()

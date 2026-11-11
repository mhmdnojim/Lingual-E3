"""Features switched by an admin and amounts of the paid AI services (web/access.py): every
feature is on at first; switched off for everyone or for one account (its own setting counts
first, and can go back to "as for everyone"); admins always have everything. Paid AI is off until
an amount is given: uses are counted, all or none, from the amount ending first; an ended amount
does not count; what is left can be taken away; uses of failed work are given back. Through the
Users tab (admin_users.change): feature, give-ai, take-ai. The length of a recording is read.

Run: python -m unittest web/tests/test_access.py
"""
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest import mock

WEB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WEB / 'tools'))
sys.path.insert(0, str(WEB))
import access  # noqa: E402
import accounts  # noqa: E402
import admin_users  # noqa: E402
import db  # noqa: E402
import library  # noqa: E402
import transcription  # noqa: E402


class AccessTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='lingua-access-test-')
        self.old_conn, db._conn = db._conn, None
        self.patches = [mock.patch.object(db, 'DATA', self.tmp.name),
                        mock.patch.object(library, 'BOOKS', str(Path(self.tmp.name) / 'books')),
                        mock.patch.object(accounts, 'ADMINS', {'boss@example.com'}),
                        mock.patch.dict(os.environ, {'LB_REQUIRE_SUBSCRIPTION': ''}),
                        mock.patch.object(accounts, '_tries', {}), mock.patch.object(accounts, '_seen', {})]
        for patch in self.patches:
            patch.start()
        self.boss = accounts.sign_up('boss@example.com', 'Boss', 'secret-123', '1.1.1.1')
        self.ann = accounts.sign_up('ann@example.com', 'Ann', 'secret-123', '1.1.1.2')
        self.bob = accounts.sign_up('bob@example.com', 'Bob', 'secret-123', '1.1.1.3')

    def tearDown(self):
        if db._conn is not None:
            db._conn.close()
        db._conn = self.old_conn
        for patch in reversed(self.patches):
            patch.stop()
        self.tmp.cleanup()

    def test_features(self):
        self.assertTrue(all(access.features(self.ann).values()), 'all on at first')
        access.set_feature('everyone', 'translation', False)
        self.assertFalse(access.allowed(self.ann, 'translation'))
        self.assertTrue(access.allowed(self.boss, 'translation'), 'admins: everything')
        with self.assertRaisesRegex(access.AccessError, 'switched off translations'):
            access.need(self.ann, 'translation')
        # Ann's own setting counts first; Bob stays as everyone.
        access.set_feature([self.ann['id']], 'translation', True)
        access.set_feature([self.ann['id']], 'add_books', False)
        self.assertEqual((access.allowed(self.ann, 'translation'), access.allowed(self.ann, 'add_books')), (True, False))
        self.assertEqual((access.allowed(self.bob, 'translation'), access.allowed(self.bob, 'add_books')), (False, True))
        row = {f['key']: f for f in access.feature_rows(self.ann['id'])}
        self.assertEqual((row['translation']['own'], row['translation']['everyone'], row['words']['own']), (True, False, None))
        access.set_feature([self.ann['id']], 'translation', None)  # (as for everyone again)
        self.assertFalse(access.allowed(self.ann, 'translation'))
        access.set_feature('everyone', 'translation', None)
        self.assertTrue(access.allowed(self.bob, 'translation'))
        with self.assertRaises(access.AccessError):
            access.set_feature('everyone', 'no-such', True)

    def test_amounts(self):
        self.assertEqual(access.left(self.ann, 'pictures'), 0)
        self.assertIsNone(access.left(self.boss, 'pictures'), 'admins: no limit')
        with self.assertRaisesRegex(access.AccessError, 'not given your account an amount'):
            access.spend(self.ann, 'pictures', 1)
        access.spend(self.boss, 'pictures', 5)  # (not counted)
        now = int(time.time())
        late = access.give(self.boss['id'], self.ann['id'], 'pictures', 3)                    # no end date
        soon = access.give(self.boss['id'], self.ann['id'], 'pictures', 2, now + 3600)         # ends first: used first
        self.assertEqual(access.left(self.ann, 'pictures'), 5)
        access.spend(self.ann, 'pictures', 3)
        used = {r['id']: r['used'] for r in access.amounts(self.ann['id'])['pictures']['rows']}
        self.assertEqual((used[soon], used[late]), (2, 1))
        with self.assertRaisesRegex(access.AccessError, 'needs 3 pictures, and your account has 2 pictures left'):
            access.spend(self.ann, 'pictures', 3)
        self.assertEqual(access.left(self.ann, 'pictures'), 2, 'all or none')
        access.give_back(self.ann, 'pictures', 1)
        self.assertEqual(access.left(self.ann, 'pictures'), 3)
        # Ended: not counted. Taken away: what is left goes.
        self.assertEqual(access.left(self.ann, 'pictures', now=now + 7200), 3, 'the one without an end date')
        access.give(self.boss['id'], self.ann['id'], 'layout', 4, now + 60)
        self.assertEqual((access.left(self.ann, 'layout'), access.left(self.ann, 'layout', now=now + 61)), (4, 0))
        access.take_away(self.ann['id'], late)
        self.assertEqual(access.left(self.ann, 'pictures'), 0)
        with self.assertRaisesRegex(access.AccessError, 'not this account'):
            access.take_away(self.bob['id'], late)
        for bad in (0, -1, 'x', 1e9):
            with self.assertRaises(access.AccessError):
                access.give(self.boss['id'], self.ann['id'], 'pictures', bad)
        with self.assertRaisesRegex(access.AccessError, 'future'):
            access.give(self.boss['id'], self.ann['id'], 'pictures', 1, now - 5)

    def test_scripts_in_minutes(self):
        access.give(self.boss['id'], self.ann['id'], 'scripts', 2)  # minutes
        self.assertEqual(access.left(self.ann, 'scripts'), 120)
        access.spend(self.ann, 'scripts', 61.4)
        self.assertEqual(access.summary(self.ann)['ai'], {'scripts': 1.0, 'pictures': 0, 'layout': 0})
        self.assertEqual(access.summary(self.boss)['ai']['scripts'], None)
        self.assertEqual((access.shown('scripts', 60), access.shown('scripts', 90), access.shown('layout', 3)),
                         ('1 minute', '1.5 minutes', '3 pages'))

    def test_through_the_users_tab(self):
        boss = accounts.user(self.boss['id'])
        d = admin_users.change(boss, self.ann['id'], {'action': 'feature', 'feature': 'words', 'value': False})
        self.assertFalse({f['key']: f['on'] for f in d['features']}['words'])
        d = admin_users.change(boss, self.ann['id'], {'action': 'give-ai', 'kind': 'scripts', 'amount': 30})
        self.assertEqual(d['ai']['scripts']['left'], 30)
        d = admin_users.change(boss, self.ann['id'], {'action': 'take-ai', 'amount': d['ai']['scripts']['rows'][0]['id']})
        self.assertEqual(d['ai']['scripts']['left'], 0)
        with self.assertRaisesRegex(admin_users.UsersError, 'Unknown AI service'):
            admin_users.change(boss, self.ann['id'], {'action': 'give-ai', 'kind': 'gold', 'amount': 1})
        with self.assertRaises(admin_users.UsersError):  # (a user changes nobody)
            admin_users.change(accounts.user(self.bob['id']), self.ann['id'], {'action': 'give-ai', 'kind': 'scripts', 'amount': 1})
        # Deleted: its settings and amounts go.
        admin_users.change(boss, self.ann['id'], {'action': 'delete'})
        self.assertEqual(db.rows('SELECT * FROM user_features') + db.rows('SELECT * FROM ai_amounts'), [])

    @unittest.skipUnless(transcription._ffmpeg(), 'no ffmpeg here')
    def test_length_of_a_recording(self):
        import subprocess
        path = Path(self.tmp.name) / 'tone.mp3'
        subprocess.run([transcription._ffmpeg(), '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', str(path)], check=True)
        self.assertAlmostEqual(access.media_seconds(path, transcription._ffmpeg()), 3, delta=0.3)
        self.assertIsNone(access.media_seconds(Path(self.tmp.name) / 'none.mp3', transcription._ffmpeg()))
        self.assertIsNone(access.media_seconds(path, None))


if __name__ == '__main__':
    unittest.main()

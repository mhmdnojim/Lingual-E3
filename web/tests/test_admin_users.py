"""The Users tab of the Admin page (web/admin_users.py, web/accounts.py, web/subscriptions.py): the
owner (LB_ADMIN_EMAIL; on this computer its user), helper admins and users; only the owner makes
admins, a helper admin manages users only, nobody changes the owner's account or blocks, deletes
or demotes themselves; blocking and a new password log out everywhere; days given without a code
are added after a plan of the same books, are never listed as codes and can be taken away; a
deleted account takes its books and folders with it; when an account was last used is kept.

Run: python -m unittest web/tests/test_admin_users.py
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
import accounts  # noqa: E402
import admin_users  # noqa: E402
import db  # noqa: E402
import library  # noqa: E402
import subscriptions  # noqa: E402

DAY = 86400


class UsersTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='lingua-users-test-')
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

    def user(self, u):
        return accounts.user(u['id'])

    def do(self, actor, target, action, **more):
        return admin_users.change(self.user(actor), target['id'], {'action': action, **more})

    def refused(self, actor, target, action, why, **more):
        with self.assertRaisesRegex(admin_users.UsersError, why) as e:
            self.do(actor, target, action, **more)
        self.assertEqual(e.exception.status, 403)

    def test_roles(self):
        self.assertEqual([accounts.role(self.user(u)) for u in (self.boss, self.ann)], ['owner', 'user'])
        self.assertTrue(accounts.is_owner(accounts.user(db.LOCAL_USER)), 'this computer: its user is the owner')
        self.assertEqual(accounts.public_user(self.user(self.boss))['role'], 'owner')
        listed = admin_users.listing()
        self.assertEqual(sorted(u['email'] for u in listed), ['ann@example.com', 'bob@example.com', 'boss@example.com'],
                         "(this computer's user is not an account of the website)")
        self.assertEqual({u['email']: u['role'] for u in listed}['boss@example.com'], 'owner')

    def test_only_the_owner_makes_admins(self):
        self.refused(self.ann, self.bob, 'make-admin', 'Only an admin')
        self.assertEqual(self.do(self.boss, self.ann, 'make-admin')['role'], 'admin')
        self.assertEqual(accounts.role(self.user(self.ann)), 'admin')
        # Ann, a helper admin: she manages users, not admins or the owner.
        self.refused(self.ann, self.bob, 'make-admin', 'Only the owner makes or removes admins')
        self.do(self.ann, self.bob, 'block')
        self.do(self.ann, self.bob, 'unblock')
        for action in ('block', 'delete', 'password', 'remove-admin'):
            self.refused(self.ann, self.boss, action, 'owner')
        self.do(self.boss, self.bob, 'make-admin')
        self.refused(self.ann, self.bob, 'block', 'Only the owner changes another admin')
        # Nobody to themselves, nor to the owner; the owner removes helper admins.
        for action in ('block', 'delete', 'remove-admin'):
            self.refused(self.boss, self.boss, action, 'owner')
        self.refused(self.ann, self.ann, 'delete', 'Not your own account')
        self.assertEqual(self.do(self.boss, self.ann, 'remove-admin')['role'], 'user')
        may = admin_users.details(self.user(self.bob), self.ann['id'])['may']
        self.assertEqual((may['block'], may['make-admin'], may['delete']), (True, False, True))

    def test_block_logs_out_everywhere(self):
        token = accounts.new_session(self.user(self.ann))
        self.assertIsNotNone(accounts.session_user(token))
        self.assertTrue(self.do(self.boss, self.ann, 'block')['blocked'])
        self.assertIsNone(accounts.session_user(token))
        with self.assertRaisesRegex(accounts.AccountError, 'blocked'):
            accounts.log_in('ann@example.com', 'secret-123', '1.1.1.9')
        self.do(self.boss, self.ann, 'unblock')
        self.assertTrue(accounts.log_in('ann@example.com', 'secret-123', '1.1.1.9'))

    def test_new_password(self):
        token = accounts.new_session(self.user(self.ann))
        with self.assertRaisesRegex(admin_users.UsersError, '8 characters'):
            self.do(self.boss, self.ann, 'password', password='short')
        self.do(self.boss, self.ann, 'password', password='brand-new-1')
        self.assertIsNone(accounts.session_user(token), 'logged out everywhere')
        self.assertTrue(accounts.log_in('ann@example.com', 'brand-new-1', '1.1.1.9'))
        with self.assertRaises(accounts.AccountError):
            accounts.log_in('ann@example.com', 'secret-123', '1.1.1.9')

    def test_days_given(self):
        before = time.time()
        d = self.do(self.boss, self.ann, 'give-days', days=30, books='*')
        self.assertTrue(subscriptions.has_access(self.ann['id']))
        first = d['grants'][0]
        self.assertEqual((first['kind'], first['label'], first['status']), ('given', 'Given by Boss', 'active'))
        self.assertAlmostEqual(first['ends_at'], before + 30 * DAY, delta=5)
        # The same books again: added after the first.
        d = self.do(self.boss, self.ann, 'give-days', days=7, books='*')
        self.assertEqual(d['grants'][0]['starts_at'], first['ends_at'])
        self.assertEqual(d['grants'][0]['status'], 'scheduled')
        self.assertEqual(d['plan']['expiresAt'], first['ends_at'] + 7 * DAY)
        self.assertEqual(subscriptions.admin_data()['codes'], [], 'given days are not codes')
        with self.assertRaisesRegex(admin_users.UsersError, '3,650'):
            self.do(self.boss, self.ann, 'give-days', days=0, books='*')
        with self.assertRaisesRegex(admin_users.UsersError, 'ready, shared books'):
            self.do(self.boss, self.ann, 'give-days', days=5, books=['L0123456789'])
        # Taken away: only the account's own plans.
        with self.assertRaisesRegex(admin_users.UsersError, 'not this account'):
            self.do(self.boss, self.bob, 'revoke-plan', grant=first['id'])
        for g in d['grants']:
            d = self.do(self.boss, self.ann, 'revoke-plan', grant=g['id'])
        self.assertFalse(subscriptions.has_access(self.ann['id']))
        self.assertEqual({g['status'] for g in d['grants']}, {'revoked'})

    def test_delete(self):
        b = library.create(self.user(self.ann), {'kind': 'text', 'title': 'Ann’s lesson'})
        folder = Path(self.tmp.name, 'users', str(self.ann['id']), 'recordings')
        folder.mkdir(parents=True)
        (folder / 'r1.mp3').write_bytes(b'mp3')
        self.do(self.boss, self.ann, 'give-days', days=30, books='*')
        self.assertEqual(self.do(self.boss, self.ann, 'delete'), {'deleted': True})
        self.assertIsNone(accounts.user(self.ann['id']))
        self.assertIsNone(library.get(b['id']))
        self.assertFalse(Path(library.folder(b['id'])).exists())
        self.assertFalse(folder.parent.exists())
        self.assertEqual(db.rows('SELECT * FROM subscriptions WHERE user_id = ?', (self.ann['id'],)), [])
        with self.assertRaisesRegex(admin_users.UsersError, 'not found'):
            admin_users.details(self.user(self.boss), self.ann['id'])

    def test_last_seen(self):
        accounts.seen(self.ann['id'], now=1000)
        accounts.seen(self.ann['id'], now=1100)  # (within 5 minutes: not saved again)
        self.assertEqual(self.user(self.ann)['last_seen'], 1000)
        accounts.seen(self.ann['id'], now=1000 + accounts.SEEN_EVERY)
        self.assertEqual(self.user(self.ann)['last_seen'], 1000 + accounts.SEEN_EVERY)


if __name__ == '__main__':
    unittest.main()

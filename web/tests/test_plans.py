"""Plans, the free trial and payments told by hand (web/plans.py, web/subscriptions.py): a plan is
made, changed, switched off (deleted only when nobody ever had it); its payment QR pictures; "I
paid" makes one open request per plan; an admin approves it (the plan's days, books and offline
time are given, once — never twice) or refuses it; a screenshot is seen by its sender and the
admins only; a new account's free trial, once, of the days set (0: none); a code of a plan; the
offline time of an account is the longest of its plans.

Run: python -m unittest web/tests/test_plans.py
"""
import io
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest import mock

from PIL import Image

WEB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WEB / 'tools'))
sys.path.insert(0, str(WEB))
import accounts  # noqa: E402
import admin_users  # noqa: E402
import db  # noqa: E402
import library  # noqa: E402
import plans  # noqa: E402
import subscriptions  # noqa: E402

DAY = 86400


def png():
    out = io.BytesIO()
    Image.new('RGB', (40, 40), (0, 0, 0)).save(out, 'PNG')
    return out.getvalue()


class PlansTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='lingua-plans-test-')
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
        self.ok = lambda bid: True

    def tearDown(self):
        if db._conn is not None:
            db._conn.close()
        db._conn = self.old_conn
        for patch in reversed(self.patches):
            patch.stop()
        self.tmp.cleanup()

    def plan(self, **more):
        return plans.create({'name': 'One month', 'price': '¥30', 'days': 30, **more}, self.ok)

    def test_made_and_changed(self):
        p = self.plan(offlineMinutes=600)
        self.assertEqual((p['name'], p['price'], p['days'], p['books'], p['offlineMinutes'], p['active']),
                         ('One month', '¥30', 30, ['*'], 600, True))
        p = plans.update(p['id'], {'days': 90, 'books': ['L0123456789'], 'active': False}, self.ok)
        self.assertEqual((p['days'], p['books'], p['active']), (90, ['L0123456789'], False))
        self.assertEqual(plans.listing(), [], 'switched off: not offered')
        self.assertEqual(len(plans.listing(admin=True)), 1)
        for bad in ({'name': ' '}, {'days': 0}, {'days': 'x'}, {'offlineMinutes': 1}, {'books': []}):
            with self.assertRaises(plans.PlanError, msg=bad):
                plans.update(p['id'], bad, self.ok)
        with self.assertRaisesRegex(plans.PlanError, 'ready, shared books'):
            plans.update(p['id'], {'books': ['L0123456789']}, lambda bid: False)
        with self.assertRaisesRegex(plans.PlanError, 'how many days'):
            plans.create({'name': 'No days'}, self.ok)
        self.assertEqual(plans.delete(p['id']), {'deleted': True})

    def test_qr_pictures(self):
        p = self.plan()
        p = plans.set_qr(p['id'], 1, png())
        p = plans.update(p['id'], {'qr1Label': 'WeChat Pay'}, self.ok)
        self.assertEqual([(q['n'], q['label']) for q in p['qr']], [(1, 'WeChat Pay')])
        name = p['qr'][0]['url'].rsplit('/', 1)[1]
        path, kind = plans.file_path(name, self.ann)
        self.assertTrue(os.path.isfile(path) and kind == 'image/png')
        self.assertIsNone(plans.file_path(name, None), 'logged in only')
        self.assertIsNone(plans.file_path('../library.db', self.ann))
        with self.assertRaisesRegex(plans.PlanError, 'JPEG, PNG and WebP'):
            plans.set_qr(p['id'], 2, b'not a picture')
        self.assertEqual(plans.set_qr(p['id'], 1, None)['qr'], [])
        self.assertFalse(os.path.exists(path))

    def test_i_paid(self):
        p = self.plan(offlineMinutes=600)
        r = plans.paid(self.ann, p['id'], 'By WeChat at 14:05')
        self.assertEqual((r['status'], r['note'], r['planName']), ('pending', 'By WeChat at 14:05', 'One month'))
        with self.assertRaisesRegex(plans.PlanError, 'already'):
            plans.paid(self.ann, p['id'])
        self.assertFalse(subscriptions.has_access(self.ann['id']), 'saying it gives nothing')
        # A screenshot: its sender and the admins see it, nobody else.
        r = plans.set_proof(self.ann, r['id'], png())
        name = r['proof'].rsplit('/', 1)[1]
        self.assertTrue(plans.file_path(name, self.ann) and plans.file_path(name, accounts.user(self.boss['id'])))
        self.assertIsNone(plans.file_path(name, self.bob))
        with self.assertRaises(plans.PlanError):
            plans.set_proof(self.bob, r['id'], png())
        self.assertEqual(plans.admin_data()['pending'], 1)
        # Approved: the plan's days and offline time; a second time: refused.
        out = plans.decide(self.boss, r['id'], 'approve', '¥30')
        self.assertEqual((out['request']['status'], out['request']['amount'], out['request']['user']['name']), ('approved', '¥30', 'Ann'))
        now = time.time()
        st = subscriptions.status(self.ann['id'])
        self.assertTrue(st['active'])
        self.assertAlmostEqual(st['expiresAt'], now + 30 * DAY, delta=5)
        self.assertEqual(st['offlineMinutes'], 600)
        with self.assertRaisesRegex(plans.PlanError, 'answered already'):
            plans.decide(self.boss, r['id'], 'approve')
        self.assertEqual(len(subscriptions.of_user(self.ann['id'])), 1, 'given once')
        g = subscriptions.of_user(self.ann['id'])[0]
        self.assertEqual((g['kind'], g['label']), ('plan', 'Plan: One month'))
        # Refused, with a word; then it can be told again.
        r2 = plans.paid(self.bob, p['id'])
        out = plans.decide(self.boss, r2['id'], 'refuse', reply='No payment found.')
        self.assertEqual((out['request']['status'], out['request']['reply'], out['grant']), ('refused', 'No payment found.', None))
        self.assertFalse(subscriptions.has_access(self.bob['id']))
        self.assertEqual(plans.paid(self.bob, p['id'])['status'], 'pending')
        # A plan people had: switched off, not deleted; not offered: no new request.
        self.assertEqual(plans.delete(p['id'])['deleted'], False)
        with self.assertRaisesRegex(plans.PlanError, 'not offered'):
            plans.paid(self.ann, p['id'])
        self.assertEqual(plans.listing(admin=True)[0]['subscribers'], 1)

    def test_free_trial(self):
        self.assertEqual(plans.trial_days(), 3)
        g = plans.start_trial(self.ann['id'])
        self.assertAlmostEqual(g['expiresAt'], time.time() + 3 * DAY, delta=5)
        self.assertIsNone(plans.start_trial(self.ann['id']), 'once')
        self.assertEqual(subscriptions.of_user(self.ann['id'])[0]['kind'], 'trial')
        self.assertEqual(plans.set_trial_days(0), 0)
        self.assertIsNone(plans.start_trial(self.bob['id']))
        self.assertFalse(subscriptions.has_access(self.bob['id']))
        for bad in (-1, 366, 'x'):
            with self.assertRaises(plans.PlanError):
                plans.set_trial_days(bad)

    def test_a_code_and_a_gift_of_a_plan(self):
        p = self.plan(offlineMinutes=1440, books=['L0123456789'])
        code = subscriptions.create_code(self.boss['id'], 1, '*', plan=plans.get(p['id']))
        self.assertEqual((code['days'], code['books']), (30, ['L0123456789']))
        subscriptions.redeem(code['code'], self.ann['id'])
        st = subscriptions.status(self.ann['id'])
        self.assertEqual((st['books'], st['offlineMinutes']), (['L0123456789'], 1440))
        # Given in the Users tab; the longest offline time of the plans it has counts.
        long = self.plan(name='Year', days=365, offlineMinutes=10080)
        d = admin_users.change(accounts.user(self.boss['id']), self.ann['id'], {'action': 'give-plan', 'plan': long['id']})
        self.assertEqual(d['grants'][0]['label'], 'Plan: Year')
        self.assertEqual(subscriptions.status(self.ann['id'])['offlineMinutes'], 10080)
        self.assertEqual(subscriptions.status(self.bob['id'])['offlineMinutes'], subscriptions.OFFLINE_DEFAULT)
        # An account deleted: its requests go.
        plans.paid(self.bob, long['id'])
        admin_users.change(accounts.user(self.boss['id']), self.bob['id'], {'action': 'delete'})
        self.assertEqual(plans.requests(), [])


if __name__ == '__main__':
    unittest.main()

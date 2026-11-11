"""The record of use and the statistics (web/stats.py): one row per account and day; a page or a
reading counts 5 minutes, at most once in those 5 minutes; admins and this computer's user are not
counted; the periods (today, week, month, year, two dates); everyone or one account; sign-ups,
plans by kind, the money the admins recorded, the paid AI with its cost; old rows go; a deleted
account's rows go.

Run: python -m unittest web/tests/test_stats.py
"""
import datetime
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
import plans  # noqa: E402
import stats  # noqa: E402


class StatsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='lingua-stats-test-')
        self.old_conn, db._conn = db._conn, None
        self.patches = [mock.patch.object(db, 'DATA', self.tmp.name),
                        mock.patch.object(library, 'BOOKS', str(Path(self.tmp.name) / 'books')),
                        mock.patch.object(accounts, 'ADMINS', {'boss@example.com'}),
                        mock.patch.dict(os.environ, {'LB_REQUIRE_SUBSCRIPTION': ''}),
                        mock.patch.object(accounts, '_tries', {}), mock.patch.object(accounts, '_seen', {}),
                        mock.patch.object(stats, '_slot', {}), mock.patch.object(stats, '_cleanup_day', '')]
        for patch in self.patches:
            patch.start()
        self.boss = accounts.sign_up('boss@example.com', 'Boss', 'secret-123', '1.1.1.1')
        self.ann = accounts.sign_up('ann@example.com', 'Ann', 'secret-123', '1.1.1.2')
        self.bob = accounts.sign_up('bob@example.com', 'Bob', 'secret-123', '1.1.1.3')
        self.now = time.time()

    def tearDown(self):
        if db._conn is not None:
            db._conn.close()
        db._conn = self.old_conn
        for patch in reversed(self.patches):
            patch.stop()
        self.tmp.cleanup()

    def test_counted(self):
        t = self.now
        stats.count(self.ann, 'pages', now=t)
        stats.count(self.ann, 'pages', now=t + 60)      # (in the same 5 minutes: a page, no more minutes)
        stats.count(self.ann, 'reads', now=t + 400)     # (a new slot: 5 more minutes)
        stats.count(self.ann, 'translations', 3, now=t)
        stats.count(self.boss, 'pages', now=t)          # (an admin: not counted)
        stats.count(accounts.user(db.LOCAL_USER), 'pages', now=t)
        stats.count(self.ann, 'nothing', now=t)
        rows = db.rows('SELECT * FROM activity ORDER BY user_id')
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]['user_id'], rows[0]['pages'], rows[0]['reads'], rows[0]['minutes'], rows[0]['translations']),
                         (self.ann['id'], 2, 1, 10, 3))
        d = stats.summary('today', now=t)
        self.assertEqual((d['users'], d['minutes'], d['use']['pages'], d['use']['translations']), (1, 10, 2, 3))
        self.assertEqual(d['detail'][0]['name'], 'Ann')

    def test_paid_ai_counted_through_access(self):
        access.give(self.boss['id'], self.ann['id'], 'scripts', 10)
        access.give(self.boss['id'], self.ann['id'], 'pictures', 2)
        access.spend(self.ann, 'scripts', 150)   # 2.5 minutes → 3 (rounded)
        access.spend(self.ann, 'pictures', 1)
        d = stats.summary('today')
        self.assertEqual((d['ai']['scripts']['n'], d['ai']['pictures']['n'], d['ai']['layout']['n']), (3, 1, 0))
        self.assertAlmostEqual(d['aiCost'], round((3 * stats.COST['scripts'] + stats.COST['pictures']) / 100, 2))

    def test_periods(self):
        now = datetime.datetime(2026, 11, 11, 12, 0).timestamp()  # (a Wednesday)
        self.assertEqual(stats.period('today', now=now), ('2026-11-11', '2026-11-11'))
        self.assertEqual(stats.period('week', now=now), ('2026-11-09', '2026-11-11'))
        self.assertEqual(stats.period('month', now=now), ('2026-11-01', '2026-11-11'))
        self.assertEqual(stats.period('year', now=now), ('2026-01-01', '2026-11-11'))
        self.assertEqual(stats.period('custom', '2026-03-05', '2026-01-02', now=now), ('2026-01-02', '2026-03-05'))
        for bad in (('custom', 'x', '2026-01-01'), ('custom', '2020-01-01', '2026-01-01')):
            with self.assertRaises(ValueError):
                stats.period(*bad, now=now)
        # Rows of other days are not in today's figures; one account's days are listed.
        stats.count(self.ann, 'pages', now=now)
        stats.count(self.ann, 'pages', now=now - 2 * 86400)  # (Monday: this week)
        stats.count(self.bob, 'pages', now=now - 40 * 86400)
        today = stats.summary('today', now=now)
        week = stats.summary('week', now=now)
        year = stats.summary('year', user_id=self.ann['id'], now=now)
        self.assertEqual((today['users'], week['users'], week['use']['pages']), (1, 1, 2))
        self.assertEqual([r['day'] for r in year['detail']], ['2026-11-11', '2026-11-09'])
        self.assertEqual(stats.summary('year', now=now)['users'], 2)

    def test_sign_ups_plans_and_money(self):
        p = plans.create({'name': 'Month', 'price': '¥30', 'days': 30}, lambda b: True)
        plans.set_trial_days(3)
        plans.start_trial(self.ann['id'])
        r = plans.paid(self.bob, p['id'])
        plans.decide(self.boss, r['id'], 'approve', '¥30')
        r2 = plans.paid(self.ann, p['id'])
        plans.decide(self.boss, r2['id'], 'approve', '30 CNY')
        r3 = plans.paid(self.ann, p['id'])
        plans.decide(self.boss, r3['id'], 'refuse', reply='no')
        admin_users.change(accounts.user(self.boss['id']), self.ann['id'], {'action': 'give-days', 'days': 5, 'books': '*'})
        d = stats.summary('today')
        self.assertEqual(d['signedUp'], 3)
        self.assertEqual(d['plans'], {'trial': 1, 'plan': 2, 'given': 1})
        self.assertEqual((d['payments']['approved'], d['payments']['refused'], d['payments']['pending']), (2, 1, 0))
        self.assertEqual(d['payments']['recorded'], {'sums': {'¥': 30.0, 'CNY': 30.0}, 'other': []})
        self.assertEqual(d['withPlanNow'], 2)
        one = stats.summary('today', user_id=self.bob['id'])
        self.assertEqual((one['plans'], one['payments']['approved'], one['signedUp']), ({'plan': 1}, 1, 1))

    def test_old_rows_and_deleted_accounts(self):
        stats.count(self.ann, 'pages', now=self.now - 400 * 86400)
        stats.count(self.bob, 'pages', now=self.now)
        stats.forget_old(now=self.now)
        self.assertEqual([r['user_id'] for r in db.rows('SELECT user_id FROM activity')], [self.bob['id']])
        admin_users.change(accounts.user(self.boss['id']), self.bob['id'], {'action': 'delete'})
        self.assertEqual(db.rows('SELECT * FROM activity'), [])

    def test_old_rows_are_cleaned_on_first_activity_of_a_new_day(self):
        stats.count(self.ann, 'pages', now=self.now - 400 * 86400)
        stats.count(self.bob, 'pages', now=self.now)
        self.assertEqual([r['user_id'] for r in db.rows('SELECT user_id FROM activity')], [self.bob['id']])


if __name__ == '__main__':
    unittest.main()

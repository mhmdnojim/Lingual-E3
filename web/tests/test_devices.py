"""The devices of an account (web/devices.py, web/accounts.py): a user may be logged in on at most
2 devices; a third is refused with their names; the same device again only refreshes; logging out
frees the device; a device unlinked by the admin ends its login at once (the cookie carries the
device); admins have no limit; a short name comes from the User-Agent; a deleted account's devices go.

Run: python -m unittest web/tests/test_devices.py
"""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

WEB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WEB / 'tools'))
sys.path.insert(0, str(WEB))
import accounts  # noqa: E402
import admin_users  # noqa: E402
import db  # noqa: E402
import devices  # noqa: E402
import library  # noqa: E402

CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
EDGE = CHROME + ' Edg/130.0.0.0'


class DevicesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='lingua-devices-test-')
        self.old_conn, db._conn = db._conn, None
        self.patches = [mock.patch.object(db, 'DATA', self.tmp.name),
                        mock.patch.object(library, 'BOOKS', str(Path(self.tmp.name) / 'books')),
                        mock.patch.object(accounts, 'ADMINS', {'boss@example.com'}),
                        mock.patch.dict(os.environ, {'LB_REQUIRE_SUBSCRIPTION': ''}),
                        mock.patch.object(accounts, '_tries', {}), mock.patch.object(accounts, '_seen', {}),
                        mock.patch.object(devices, '_seen', {})]
        for patch in self.patches:
            patch.start()
        self.boss = accounts.sign_up('boss@example.com', 'Boss', 'secret-123', '1.1.1.1')
        self.ann = accounts.sign_up('ann@example.com', 'Ann', 'secret-123', '1.1.1.2')

    def tearDown(self):
        if db._conn is not None:
            db._conn.close()
        db._conn = self.old_conn
        for patch in reversed(self.patches):
            patch.stop()
        self.tmp.cleanup()

    def test_names(self):
        self.assertEqual(devices.name_of(CHROME), 'Chrome on Windows')
        self.assertEqual(devices.name_of(IPHONE), 'Safari on iPhone')
        self.assertEqual(devices.name_of(EDGE), 'Edge on Windows')
        self.assertEqual(devices.name_of(''), 'a browser on a device')

    def test_two_devices_at_most(self):
        a, b = devices.new_id(), devices.new_id()
        self.assertEqual(devices.link(self.ann, a, CHROME), a)
        self.assertEqual(devices.link(self.ann, b, IPHONE), b)
        self.assertEqual(devices.link(self.ann, a, CHROME), a, 'the same device again: fine')
        with self.assertRaisesRegex(devices.DeviceError, 'used on 2 devices already \\(Chrome on Windows, Safari on iPhone\\)'):
            devices.link(self.ann, devices.new_id(), EDGE)
        self.assertEqual({v['name'] for v in devices.of_user(self.ann['id'])}, {'Safari on iPhone', 'Chrome on Windows'})
        # Logged out on the phone: a third device may come.
        self.assertTrue(devices.unlink(self.ann['id'], b))
        self.assertFalse(devices.unlink(self.ann['id'], b))
        devices.link(self.ann, devices.new_id(), EDGE)
        # A bad or missing id: a new one is made.
        self.assertTrue(devices.ID_RE.match(devices.link(self.boss, 'not-an-id', CHROME)))
        # Admins: no limit.
        for _ in range(4):
            devices.link(self.boss, devices.new_id(), CHROME)
        self.assertEqual(len(devices.of_user(self.boss['id'])), 5)

    def test_the_cookie_carries_the_device(self):
        a = devices.link(self.ann, devices.new_id(), CHROME)
        token = accounts.new_session(self.ann, a)
        u, device = accounts.session_user(token, with_device=True)
        self.assertEqual((u['id'], device), (self.ann['id'], a))
        self.assertEqual(accounts.session_user(token)['id'], self.ann['id'])
        old = accounts.new_session(self.ann)  # (a cookie from before the devices: still fine)
        self.assertEqual(accounts.session_user(old, with_device=True)[1], '')
        # Unlinked by the admin: that login ends at once; a cookie with another device is refused.
        row = devices.of_user(self.ann['id'])[0]['id']
        admin_users.change(accounts.user(self.boss['id']), self.ann['id'], {'action': 'unlink-device', 'device': row})
        self.assertIsNone(accounts.session_user(token))
        self.assertIsNone(accounts.session_user(accounts.new_session(self.ann, devices.new_id())))
        with self.assertRaisesRegex(admin_users.UsersError, 'not found'):
            admin_users.change(accounts.user(self.boss['id']), self.ann['id'], {'action': 'unlink-device', 'device': row})
        # A deleted account's devices go.
        devices.link(self.ann, devices.new_id(), CHROME)
        admin_users.change(accounts.user(self.boss['id']), self.ann['id'], {'action': 'delete'})
        self.assertEqual(db.rows('SELECT * FROM devices WHERE user_id = ?', (self.ann['id'],)), [])


if __name__ == '__main__':
    unittest.main()

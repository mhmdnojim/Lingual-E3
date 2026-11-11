"""The devices of an account on a website (server.py): an account may be logged in on at most MOST
devices at a time (admins: any number), so a paid account is not shared around.

The browser keeps a random device id (js/util.js deviceId) and sends it when logging in or
signing up; the server links it to the account (a row here, with a short name from the browser's
User-Agent, when it was linked and last seen). A third device is refused with a clear message.
The login cookie carries the device id (accounts.new_session): a device unlinked — by an admin in
the Users tab, or by logging out on it — ends that login at once. Clearing the browser makes a
new device id: the old one stays linked until it is unlinked (the admin's page shows them all).
"""
import re
import secrets
import threading
import time

import db

MOST = 2
ID_RE = re.compile(r'^[0-9a-f]{32}$')
SEEN_EVERY = 300

_lock = threading.Lock()
_seen = {}  # device id -> when its last use was saved


class DeviceError(Exception):
    pass


def new_id():
    return secrets.token_hex(16)


def name_of(user_agent):
    """A short name of the browser and system from its User-Agent: "Chrome on Windows", "Safari on iPhone"."""
    ua = str(user_agent or '')
    system = next((name for key, name in (('iPhone', 'iPhone'), ('iPad', 'iPad'), ('Android', 'Android'), ('Windows', 'Windows'),
                                          ('Mac OS', 'Mac'), ('CrOS', 'Chromebook'), ('Linux', 'Linux')) if key in ua), 'a device')
    browser = next((name for key, name in (('Edg/', 'Edge'), ('OPR/', 'Opera'), ('SamsungBrowser', 'Samsung Internet'), ('Firefox', 'Firefox'),
                                           ('Chrome', 'Chrome'), ('Safari', 'Safari'), ('lingua-books', 'Lingua Books app')) if key in ua), 'a browser')
    return f'{browser} on {system}'


def link(user, device_id, user_agent='', now=None):
    """Link this device to the account (logging in), or refresh it. DeviceError: the account has
    MOST other devices already. Returns the device id (a bad or missing one: a new one is made)."""
    now = int(time.time()) if now is None else int(now)
    device_id = device_id if ID_RE.match(str(device_id or '')) else new_id()
    name = name_of(user_agent)[:60]

    def apply(c):
        row = c.execute('SELECT id FROM devices WHERE user_id = ? AND device = ?', (user['id'], device_id)).fetchone()
        if row:
            c.execute('UPDATE devices SET last_seen = ?, name = ? WHERE id = ?', (now, name, row['id']))
            return
        if not user['admin']:
            others = c.execute('SELECT name FROM devices WHERE user_id = ? ORDER BY linked_at, id', (user['id'],)).fetchall()
            if len(others) >= MOST:
                raise DeviceError(f'This account is used on {MOST} devices already ({", ".join(r["name"] for r in others)}). '
                                  'Log out on one of them, or ask the admin to unlink it.')
        c.execute('INSERT INTO devices (user_id, device, name, linked_at, last_seen) VALUES (?, ?, ?, ?, ?)',
                  (user['id'], device_id, name, now, now))
    db.transaction(apply)
    return device_id


def linked(user_id, device_id):
    """Is this device linked to the account (the login cookie's device still allowed)?"""
    return bool(ID_RE.match(str(device_id or '')) and db.one('SELECT 1 FROM devices WHERE user_id = ? AND device = ?', (int(user_id), device_id)))


def seen(user_id, device_id, now=None):
    """The device is in use now (saved at most every SEEN_EVERY seconds)."""
    now = int(time.time()) if now is None else int(now)
    with _lock:
        if now - _seen.get(device_id, 0) < SEEN_EVERY:
            return
        _seen[device_id] = now
    db.run('UPDATE devices SET last_seen = ? WHERE user_id = ? AND device = ?', (now, int(user_id), device_id))


def unlink(user_id, device_id=None, row_id=None):
    """Take a device away from the account (logging out on it: by its id; the admin: by its row)."""
    if row_id is not None:
        n = db.transaction(lambda c: c.execute('DELETE FROM devices WHERE user_id = ? AND id = ?', (int(user_id), int(row_id))).rowcount)
    else:
        n = db.transaction(lambda c: c.execute('DELETE FROM devices WHERE user_id = ? AND device = ?', (int(user_id), str(device_id))).rowcount)
    return bool(n)


def of_user(user_id, now=None):
    """For the admin and the account: [{id, name, linkedAt, lastSeen, inUse}]."""
    now = int(time.time()) if now is None else int(now)
    return [{'id': r['id'], 'name': r['name'], 'linkedAt': r['linked_at'], 'lastSeen': r['last_seen'],
             'inUse': now - r['last_seen'] < 2 * SEEN_EVERY}
            for r in db.rows('SELECT * FROM devices WHERE user_id = ? ORDER BY last_seen DESC', (int(user_id),))]


def forget(c, user_id):
    """(an account deleted)"""
    c.execute('DELETE FROM devices WHERE user_id = ?', (int(user_id),))

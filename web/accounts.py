"""Accounts on a website: sign up, log in, the login cookie, admins.

Passwords are kept only as scrypt hashes. After logging in the browser keeps a cookie
"lb_session" for 30 days: user id, the user's "version" (raised to log out everywhere), the
time it ends, signed with HMAC-SHA256 and the server's secret key (DATA/secret.key, made once).
The admins are the accounts whose e-mail is in LB_ADMIN_EMAIL (several: separated by commas).
"""
import hashlib
import hmac
import os
import re
import secrets
import threading
import time

import db

COOKIE = 'lb_session'
DAYS = 30
EMAIL_RE = re.compile(r'^[^@\s]{1,64}@[^@\s]{1,190}\.[a-z]{2,}$', re.I)
ADMINS = {e.strip().lower() for e in (os.environ.get('LB_ADMIN_EMAIL') or '').split(',') if e.strip()}

_lock = threading.Lock()
_tries = {}  # (kind, address) -> recent times, to slow down guessing and mass sign-ups


class AccountError(Exception):
    pass


def _secret():
    path = os.path.join(db.DATA, 'secret.key')
    with _lock:
        if not os.path.exists(path):
            os.makedirs(db.DATA, exist_ok=True)
            with open(path, 'w') as f:
                f.write(secrets.token_hex(32))
        with open(path) as f:
            return bytes.fromhex(f.read().strip())


def hash_password(pw):
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(pw.encode('utf-8'), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return f'scrypt${salt.hex()}${h.hex()}'


def _password_ok(stored, pw):
    try:
        _, salt, h = stored.split('$')
    except ValueError:
        return False
    got = hashlib.scrypt(pw.encode('utf-8'), salt=bytes.fromhex(salt), n=2 ** 14, r=8, p=1, dklen=32)
    return hmac.compare_digest(got.hex(), h)


def limited(kind, address, most, seconds):
    """True if `address` did `kind` `most` times in the last `seconds` (then it must wait)."""
    now = time.time()
    with _lock:
        recent = [t for t in _tries.get((kind, address), []) if now - t < seconds]
        _tries[(kind, address)] = recent
        if len(recent) >= most:
            return True
        recent.append(now)
        return False


def public_user(u):
    return {'id': u['id'], 'name': u['name'], 'email': u['email'], 'admin': bool(u['admin'])} if u else None


def sign_up(email, name, password, address):
    email, name = str(email).strip().lower(), ' '.join(str(name).split())[:60]
    if not EMAIL_RE.match(email) or email == 'local':
        raise AccountError('Please give a valid e-mail address.')
    if not name:
        raise AccountError('Please give your name.')
    if len(str(password)) < 8:
        raise AccountError('The password needs at least 8 characters.')
    if limited('signup', address, 5, 3600):
        raise AccountError('Too many new accounts from here. Try again later.')
    if db.one('SELECT 1 FROM users WHERE email = ?', (email,)):
        raise AccountError('There is already an account with this e-mail. Log in instead.')
    uid = db.run('INSERT INTO users (email, name, pw, admin, created) VALUES (?, ?, ?, ?, ?)',
                 (email, name, hash_password(str(password)), int(email in ADMINS), int(time.time())))
    return db.one('SELECT * FROM users WHERE id = ?', (uid,))


def log_in(email, password, address):
    email = str(email).strip().lower()
    if limited('login', address, 10, 900):
        raise AccountError('Too many tries. Wait 15 minutes, then try again.')
    u = db.one('SELECT * FROM users WHERE email = ?', (email,))
    if not u or not u['pw'] or not _password_ok(u['pw'], str(password)):
        time.sleep(0.5)
        raise AccountError('Wrong e-mail or password.')
    if u['disabled']:
        raise AccountError('This account is closed.')
    if email in ADMINS and not u['admin']:  # made an admin (LB_ADMIN_EMAIL) after signing up
        db.run('UPDATE users SET admin = 1 WHERE id = ?', (u['id'],))
        u['admin'] = 1
    return u


def change_password(uid, old, new):
    u = user(uid)
    if not u or not _password_ok(u['pw'], str(old)):
        raise AccountError('The current password is not right.')
    if len(str(new)) < 8:
        raise AccountError('The new password needs at least 8 characters.')
    db.run('UPDATE users SET pw = ?, version = version + 1 WHERE id = ?', (hash_password(str(new)), uid))


def user(uid):
    return db.one('SELECT * FROM users WHERE id = ?', (uid,))


# ---------------------------------------------------------------- The login cookie

def _sign(text):
    return hmac.new(_secret(), text.encode('ascii'), hashlib.sha256).hexdigest()


def new_session(u):
    body = f"{u['id']}.{u['version']}.{int(time.time()) + DAYS * 86400}"
    return f'{body}.{_sign(body)}'


def session_user(token):
    """The user of a login cookie, or None (unknown, run out, logged out everywhere, closed)."""
    try:
        uid, version, until, sig = (token or '').split('.')
    except ValueError:
        return None
    if not (uid.isdigit() and version.isdigit() and until.isdigit()) or int(until) < time.time():
        return None
    if not hmac.compare_digest(sig, _sign(f'{uid}.{version}.{until}')):
        return None
    u = user(int(uid))
    return u if u and not u['disabled'] and u['version'] == int(version) else None


def cookie(token, secure, max_age=DAYS * 86400):
    return f'{COOKIE}={token}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Lax' + ('; Secure' if secure else '')

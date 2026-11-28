"""Accounts on a website: sign up, log in, the login cookie, admins.

Passwords are kept only as scrypt hashes. After logging in the browser keeps a cookie
"lb_session" for 30 days: user id, the user's "version" (raised to log out everywhere), the
time it ends, signed with HMAC-SHA256 and the server's secret key (DATA/secret.key, made once).
The owner is the admin whose e-mail is in LB_ADMIN_EMAIL (several: separated by commas), and on
this computer its only user. The owner makes other accounts admins too (helper admins: the Users
tab of the Admin page, admin_users.py); only the owner makes admins and changes the API keys.
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

SEEN_EVERY = 300  # (when an account was last used is saved at most every 5 minutes)

_lock = threading.Lock()
_tries = {}  # (kind, address) -> recent times, to slow down guessing and mass sign-ups
_seen = {}   # user id -> when its last use was saved


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


def is_owner(u):
    """The owner of the website: an admin whose e-mail is in LB_ADMIN_EMAIL (or this computer's user)."""
    return bool(u and u['admin'] and (u['id'] == db.LOCAL_USER or str(u['email']).lower() in ADMINS))


def role(u):
    return 'owner' if is_owner(u) else 'admin' if u and u['admin'] else 'user'


def public_user(u):
    return {'id': u['id'], 'name': u['name'], 'email': u['email'], 'admin': bool(u['admin']),
            'owner': is_owner(u), 'role': role(u), 'googleConnected': bool(u.get('google_sub')),
            'hasPassword': bool(u.get('pw'))} if u else None


def verify_google_credential(credential, client_id, nonce):
    """Verify a Google Identity Services ID token on the server. The browser is not trusted."""
    if not isinstance(credential, str) or not credential or len(credential) > 12000:
        raise AccountError('Google did not return a valid sign-in credential. Please try again.')
    if not client_id:
        raise AccountError('Google sign-in has not been configured yet.')
    try:
        from google.auth.transport.requests import Request
        from google.oauth2 import id_token
    except ImportError:
        raise AccountError('Google sign-in needs the server package google-auth. Install the server requirements first.')
    try:
        claims = id_token.verify_oauth2_token(credential, Request(timeout=10), audience=client_id)
    except Exception:
        raise AccountError('Google could not verify this sign-in. Please try again.')
    issuer = claims.get('iss')
    if issuer not in ('accounts.google.com', 'https://accounts.google.com'):
        raise AccountError('Google could not verify this sign-in. Please try again.')
    claimed_nonce = claims.get('nonce')
    if not nonce or not isinstance(claimed_nonce, str) or not hmac.compare_digest(claimed_nonce, nonce):
        raise AccountError('This Google sign-in expired. Please try again.')
    email = str(claims.get('email') or '').strip().lower()
    sub = str(claims.get('sub') or '')
    if not claims.get('email_verified') or not EMAIL_RE.match(email) or not sub or len(sub) > 255:
        raise AccountError('Google must provide a verified e-mail address to sign in.')
    name = ' '.join(str(claims.get('name') or email.split('@', 1)[0]).split())[:60] or email
    return {'sub': sub, 'email': email, 'name': name, 'hostedDomain': str(claims.get('hd') or '').lower()}


def google_login(profile, address, admin_setup_token=''):
    """Return an existing linked account, safely link a verified Gmail/Workspace email, or create one."""
    if limited('google-login', address, 10, 900):
        raise AccountError('Too many sign-in tries. Wait 15 minutes, then try again.')
    email, sub = profile['email'], profile['sub']

    def activate_owner(c, row):
        if row['email'].lower() not in ADMINS or row['admin']:
            return row
        if os.environ.get('LB_REQUIRE_SUBSCRIPTION', '').strip().lower() in ('1', 'true', 'yes', 'on'):
            expected = os.environ.get('LB_ADMIN_SETUP_TOKEN', '')
            if not expected:
                raise AccountError('The owner setup code is not configured on this server yet.')
            if not hmac.compare_digest(expected, str(admin_setup_token)):
                raise AccountError('Enter the owner setup code to activate the administrator account.')
        c.execute('UPDATE users SET admin = 1 WHERE id = ?', (row['id'],))
        return c.execute('SELECT * FROM users WHERE id = ?', (row['id'],)).fetchone()

    def resolve(c):
        u = c.execute('SELECT * FROM users WHERE google_sub = ?', (sub,)).fetchone()
        if u:
            if u['disabled']:
                raise AccountError('This account is blocked. Ask the website\'s admin.')
            u = activate_owner(c, u)
            return dict(u), False

        u = c.execute('SELECT * FROM users WHERE email = ?', (email,)).fetchone()
        if u:
            if u['disabled']:
                raise AccountError('This account is blocked. Ask the website\'s admin.')
            u = activate_owner(c, u)
            if u['google_sub']:
                raise AccountError('This e-mail is connected to a different Google account. Log in with your password and contact the admin.')
            # Google confirms Gmail addresses and Workspace identities (hd). For other e-mail
            # providers, require the user to log in first and explicitly connect Google.
            if not (email.endswith('@gmail.com') or profile['hostedDomain']):
                raise AccountError('This e-mail already has an account. Log in with its password, then connect Google in your account settings.')
            try:
                c.execute('UPDATE users SET google_sub = ? WHERE id = ? AND google_sub IS NULL', (sub, u['id']))
            except Exception as error:
                if 'UNIQUE' in str(error).upper():
                    raise AccountError('This Google account is already connected to another user.')
                raise
            return dict(c.execute('SELECT * FROM users WHERE id = ?', (u['id'],)).fetchone()), False

        if limited('signup', address, 5, 3600):
            raise AccountError('Too many new accounts from here. Try again later.')
        is_admin = email in ADMINS
        if is_admin and os.environ.get('LB_REQUIRE_SUBSCRIPTION', '').strip().lower() in ('1', 'true', 'yes', 'on'):
            expected = os.environ.get('LB_ADMIN_SETUP_TOKEN', '')
            if not expected:
                raise AccountError('The owner setup code is not configured on this server yet.')
            if not hmac.compare_digest(expected, str(admin_setup_token)):
                raise AccountError('Enter the owner setup code to activate the administrator account.')
        try:
            uid = c.execute('INSERT INTO users (email, name, pw, admin, created, google_sub) VALUES (?, ?, \'\', ?, ?, ?)',
                            (email, profile['name'], int(is_admin), int(time.time()), sub)).lastrowid
        except Exception as error:
            if 'UNIQUE' in str(error).upper():
                raise AccountError('This Google account is already connected to another user.')
            raise
        return dict(c.execute('SELECT * FROM users WHERE id = ?', (uid,)).fetchone()), True

    u, created = db.transaction(resolve)
    seen(u['id'])
    return u, created


def link_google(uid, profile):
    """Connect Google only from an authenticated account and only when its verified e-mail matches."""
    u = user(uid)
    if not u:
        raise AccountError('Please log in first.')
    if profile['email'] != u['email']:
        raise AccountError('The Google e-mail must match the e-mail on your Lingua Books account.')
    if u['google_sub'] == profile['sub']:
        return u
    if u['google_sub']:
        raise AccountError('A different Google account is already connected. Contact the admin to change it.')
    try:
        db.run('UPDATE users SET google_sub = ? WHERE id = ? AND google_sub IS NULL', (profile['sub'], uid))
    except Exception as error:
        if 'UNIQUE' in str(error).upper():
            raise AccountError('This Google account is already connected to another user.')
        raise
    u = user(uid)
    if not u or u['google_sub'] != profile['sub']:
        raise AccountError('Google could not be connected. Please try again.')
    return u


def seen(uid, now=None):
    """The account is being used now (saved at most every SEEN_EVERY seconds)."""
    now = int(time.time()) if now is None else int(now)
    with _lock:
        if now - _seen.get(uid, 0) < SEEN_EVERY:
            return
        _seen[uid] = now
    db.run('UPDATE users SET last_seen = ? WHERE id = ?', (now, uid))


def sign_up(email, name, password, address, admin_setup_token=''):
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
    is_admin = email in ADMINS
    if is_admin and os.environ.get('LB_REQUIRE_SUBSCRIPTION', '').strip().lower() in ('1', 'true', 'yes', 'on'):
        expected = os.environ.get('LB_ADMIN_SETUP_TOKEN', '')
        # A public server must not grant its owner role to the first person who types the address.
        if not expected:
            raise AccountError('The owner setup code is not configured on this server yet.')
        if not hmac.compare_digest(expected, str(admin_setup_token)):
            raise AccountError('The owner setup code is not correct.')
    uid = db.run('INSERT INTO users (email, name, pw, admin, created) VALUES (?, ?, ?, ?, ?)',
                 (email, name, hash_password(str(password)), int(is_admin), int(time.time())))
    return db.one('SELECT * FROM users WHERE id = ?', (uid,))


def log_in(email, password, address, admin_setup_token=''):
    email = str(email).strip().lower()
    if limited('login', address, 10, 900):
        raise AccountError('Too many tries. Wait 15 minutes, then try again.')
    u = db.one('SELECT * FROM users WHERE email = ?', (email,))
    if not u or not u['pw'] or not _password_ok(u['pw'], str(password)):
        time.sleep(0.5)
        raise AccountError('Wrong e-mail or password.')
    if u['disabled']:
        raise AccountError('This account is blocked. Ask the website’s admin.')
    if email in ADMINS and not u['admin']:
        if os.environ.get('LB_REQUIRE_SUBSCRIPTION', '').strip().lower() in ('1', 'true', 'yes', 'on'):
            expected = os.environ.get('LB_ADMIN_SETUP_TOKEN', '')
            if not expected:
                raise AccountError('The owner setup code is not configured on this server yet.')
            if not hmac.compare_digest(expected, str(admin_setup_token)):
                raise AccountError('Enter the owner setup code to activate the administrator account.')
        db.run('UPDATE users SET admin = 1 WHERE id = ?', (u['id'],))
        u['admin'] = 1
    seen(u['id'])
    return u


def change_password(uid, old, new):
    u = user(uid)
    if not u or (u['pw'] and not _password_ok(u['pw'], str(old))) or (not u['pw'] and not u['google_sub']):
        raise AccountError('The current password is not right.')
    if len(str(new)) < 8:
        raise AccountError('The new password needs at least 8 characters.')
    db.run('UPDATE users SET pw = ?, version = version + 1 WHERE id = ?', (hash_password(str(new)), uid))


def user(uid):
    return db.one('SELECT * FROM users WHERE id = ?', (uid,))


# ---------------------------------------------------------------- The login cookie

def _sign(text):
    return hmac.new(_secret(), text.encode('ascii'), hashlib.sha256).hexdigest()


def new_session(u, device=''):
    """The login cookie's value; device: the device it is on (devices.py), on a website."""
    body = f"{u['id']}.{u['version']}.{int(time.time()) + DAYS * 86400}" + (f'.{device}' if device else '')
    return f'{body}.{_sign(body)}'


def session_user(token, with_device=False):
    """The user of a login cookie, or None (unknown, run out, logged out everywhere, closed, its
    device unlinked). with_device: (user, device id) instead."""
    parts = (token or '').split('.')
    if len(parts) == 4:
        (uid, version, until, sig), device = parts, ''
    elif len(parts) == 5:
        uid, version, until, device, sig = parts
    else:
        return (None, '') if with_device else None
    nothing = (None, '') if with_device else None
    if not (uid.isdigit() and version.isdigit() and until.isdigit()) or int(until) < time.time():
        return nothing
    body = f'{uid}.{version}.{until}' + (f'.{device}' if device else '')
    if not hmac.compare_digest(sig, _sign(body)):
        return nothing
    u = user(int(uid))
    if not (u and not u['disabled'] and u['version'] == int(version)):
        return nothing
    if device:
        import devices
        if not devices.linked(u['id'], device):
            return nothing
    return (u, device) if with_device else u


def cookie(token, secure, max_age=DAYS * 86400):
    return f'{COOKIE}={token}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Lax' + ('; Secure' if secure else '')

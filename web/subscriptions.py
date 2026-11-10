"""Time-limited, server-checked access codes for public deployments.

The plaintext code is returned once to the admin. Only its SHA-256 hash is stored; redemption
consumes it and creates a time-limited grant on the user's account. An admin can also give days
to an account in the Users tab (grant): kept as a code of kind 'given', used at once, never shown
in the list of codes.
"""
import base64
import hashlib
import io
import json
import os
import re
import secrets
import time
from urllib.parse import quote

import db

CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
CODE_RE = re.compile(r'^[A-HJ-NP-Z2-9]{16}$')
BOOK_RE = re.compile(r'^L[0-9a-f]{10}$')


class SubscriptionError(ValueError):
    pass


def required():
    return os.environ.get('LB_REQUIRE_SUBSCRIPTION', '').strip().lower() in ('1', 'true', 'yes', 'on')


def _normal_code(raw):
    code = re.sub(r'[\s-]+', '', str(raw or '')).upper()
    if not CODE_RE.fullmatch(code):
        return None
    return code


def _hash(code):
    return hashlib.sha256(code.encode('ascii')).hexdigest()


def _books(raw):
    if raw is None or raw == '*' or raw == ['*']:
        return ['*']
    if not isinstance(raw, list) or not raw or len(raw) > 200:
        raise SubscriptionError('Choose all public books or one or more specific books.')
    values = sorted(set(str(x) for x in raw))
    if any(not BOOK_RE.fullmatch(x) for x in values):
        raise SubscriptionError('One of the selected books is not valid.')
    return values


def _qr_data(url):
    try:
        import qrcode
        from qrcode.image.svg import SvgPathImage
    except ImportError as exc:
        raise SubscriptionError('QR support is not installed. Update web/requirements.txt and restart the server.') from exc
    qr = qrcode.QRCode(box_size=5, border=2)
    qr.add_data(url)
    qr.make(fit=True)
    image = qr.make_image(image_factory=SvgPathImage)
    out = io.BytesIO()
    image.save(out)
    return 'data:image/svg+xml;base64,' + base64.b64encode(out.getvalue()).decode('ascii')


def create_code(admin_id, days, books, label='', redeem_days=90, public_url=''):
    try:
        days, redeem_days = int(days), int(redeem_days)
    except (TypeError, ValueError):
        raise SubscriptionError('Enter the subscription length and code validity in days.')
    if not 1 <= days <= 3650:
        raise SubscriptionError('A subscription must be from 1 to 3,650 days.')
    if not 1 <= redeem_days <= 3650:
        raise SubscriptionError('A code must be redeemable for 1 to 3,650 days after it is created.')
    books = _books(books)
    label = ' '.join(str(label).split())[:80]
    now = int(time.time())
    redeem_until = now + redeem_days * 86400
    code = ''.join(secrets.choice(CODE_ALPHABET) for _ in range(16))
    code_hash = _hash(code)
    url = f"{public_url.rstrip('/')}/web/redeem.html?code={quote(code)}" if public_url else ''
    qr = _qr_data(url) if url else ''
    code_id = db.run(
        'INSERT INTO subscription_codes (code_hash, code_hint, label, duration_days, books, created_by, created, redeem_until) '
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        (code_hash, code[-4:], label, days, json.dumps(books), int(admin_id), now, redeem_until))
    return {
        'id': code_id,
        'code': '-'.join(code[i:i + 4] for i in range(0, len(code), 4)),
        'days': days,
        'books': books,
        'redeemUntil': redeem_until,
        'redeemUrl': url,
        'qr': qr,
    }


def redeem(raw, user_id):
    code = _normal_code(raw)
    if not code:
        raise SubscriptionError('Enter the 16-character code from your admin.')
    now = int(time.time())

    def apply(c):
        row = c.execute('SELECT * FROM subscription_codes WHERE code_hash = ?', (_hash(code),)).fetchone()
        if not row:
            raise SubscriptionError('That access code is not valid.')
        if row['revoked']:
            raise SubscriptionError('That access code has been cancelled.')
        if row['redeemed_at']:
            raise SubscriptionError('That access code has already been used.')
        if row['redeem_until'] and row['redeem_until'] < now:
            raise SubscriptionError('That access code has expired.')
        changed = c.execute(
            'UPDATE subscription_codes SET redeemed_by = ?, redeemed_at = ? '
            'WHERE id = ? AND redeemed_at IS NULL AND revoked = 0',
            (int(user_id), now, row['id'])).rowcount
        if changed != 1:
            raise SubscriptionError('That access code has already been used.')
        return _add(c, user_id, row['id'], json.loads(row['books'] or '["*"]'), row['duration_days'], now)

    return db.transaction(apply)


def _add(c, user_id, code_id, books, days, now):
    """A grant of days for these books. The same books as a grant not ended yet: from its end
    date (days added); other books: from now."""
    existing = c.execute(
        'SELECT books, ends_at FROM subscriptions WHERE user_id = ? AND revoked = 0 AND ends_at > ?',
        (int(user_id), now)).fetchall()
    start = now
    for grant in existing:
        if json.loads(grant['books'] or '["*"]') == books:
            start = max(start, int(grant['ends_at']))
    end = start + int(days) * 86400
    c.execute('INSERT INTO subscriptions (user_id, code_id, books, starts_at, ends_at) VALUES (?, ?, ?, ?, ?)',
              (int(user_id), int(code_id), json.dumps(books), start, end))
    return {'startsAt': start, 'expiresAt': end, 'books': books, 'days': int(days)}


def grant(admin_id, user_id, days, books, label=''):
    """Days given by an admin to an account (no code: the Users tab), added as a code would add them."""
    try:
        days = int(days)
    except (TypeError, ValueError):
        raise SubscriptionError('Enter the number of days.')
    if not 1 <= days <= 3650:
        raise SubscriptionError('Give from 1 to 3,650 days.')
    books = _books(books)
    label = ' '.join(str(label).split())[:80]
    now = int(time.time())

    def apply(c):
        # (a hash nobody can type: "given" codes are never redeemed)
        code_id = c.execute(
            'INSERT INTO subscription_codes (code_hash, code_hint, label, duration_days, books, created_by, created, '
            "redeem_until, redeemed_by, redeemed_at, kind) VALUES (?, '', ?, ?, ?, ?, ?, 0, ?, ?, 'given')",
            (_hash('given:' + secrets.token_hex(16)), label, days, json.dumps(books), int(admin_id), now,
             int(user_id), now)).lastrowid
        return _add(c, user_id, code_id, books, days, now)

    return db.transaction(apply)


def status(user_id, admin=False, now=None):
    if admin:
        return {'active': True, 'expiresAt': None, 'books': ['*'], 'admin': True}
    now = int(time.time()) if now is None else int(now)
    rows = db.rows('SELECT books, starts_at, ends_at FROM subscriptions '
                   'WHERE user_id = ? AND revoked = 0 AND starts_at <= ? AND ends_at > ?',
                   (int(user_id), now, now))
    all_books = False
    books = set()
    for row in rows:
        scope = json.loads(row['books'] or '["*"]')
        if '*' in scope:
            all_books = True
        else:
            books.update(scope)
    return {
        'active': bool(rows),
        'expiresAt': max((int(r['ends_at']) for r in rows), default=None),
        'books': ['*'] if all_books else sorted(books),
        'admin': False,
    }


def has_access(user_id, now=None):
    return status(user_id, now=now)['active']


def can_access_book(user_id, book_id, admin=False, now=None):
    if admin:
        return True
    now = int(time.time()) if now is None else int(now)
    rows = db.rows('SELECT books FROM subscriptions WHERE user_id = ? AND revoked = 0 AND starts_at <= ? AND ends_at > ?',
                   (int(user_id), now, now))
    for row in rows:
        scope = json.loads(row['books'] or '["*"]')
        if '*' in scope or book_id in scope:
            return True
    return False


def admin_data(now=None):
    now = int(time.time()) if now is None else int(now)
    codes = db.rows('SELECT id, code_hint, label, duration_days, books, created, redeem_until, redeemed_by, redeemed_at, revoked '
                    "FROM subscription_codes WHERE kind = 'code' ORDER BY id DESC LIMIT 500")
    for row in codes:
        row['books'] = json.loads(row['books'] or '["*"]')
        if row['revoked']:
            row['status'] = 'cancelled'
        elif row['redeemed_at']:
            row['status'] = 'used'
        elif row['redeem_until'] and row['redeem_until'] < now:
            row['status'] = 'expired'
        else:
            row['status'] = 'ready'
    grants = db.rows(
        'SELECT s.id, s.user_id, u.email, u.name, s.books, s.starts_at, s.ends_at, s.revoked, s.revoked_at, c.code_hint, '
        'c.kind, c.label '
        'FROM subscriptions s JOIN users u ON u.id = s.user_id JOIN subscription_codes c ON c.id = s.code_id '
        'ORDER BY s.id DESC LIMIT 1000')
    for row in grants:
        row['books'] = json.loads(row['books'] or '["*"]')
        row['status'] = _state(row, now)
    return {'codes': codes, 'subscriptions': grants}


def _state(row, now):
    return 'revoked' if row['revoked'] else 'scheduled' if row['starts_at'] > now else 'expired' if row['ends_at'] <= now else 'active'


def of_user(user_id, now=None):
    """An account's grants, newest first: {id, books, starts_at, ends_at, status, kind (code |
    given), label, code_hint}."""
    now = int(time.time()) if now is None else int(now)
    out = db.rows('SELECT s.id, s.books, s.starts_at, s.ends_at, s.revoked, s.revoked_at, c.kind, c.label, c.code_hint '
                  'FROM subscriptions s JOIN subscription_codes c ON c.id = s.code_id WHERE s.user_id = ? ORDER BY s.id DESC',
                  (int(user_id),))
    for row in out:
        row['books'] = json.loads(row['books'] or '["*"]')
        row['status'] = _state(row, now)
    return out


def cancel_code(code_id):
    code_id = int(code_id)
    row = db.one('SELECT redeemed_at, revoked FROM subscription_codes WHERE id = ?', (code_id,))
    if not row:
        raise SubscriptionError('That code was not found.')
    if row['redeemed_at']:
        raise SubscriptionError('This code was already used. Revoke its subscription instead.')
    db.run('UPDATE subscription_codes SET revoked = 1 WHERE id = ?', (code_id,))


def revoke_subscription(subscription_id):
    subscription_id = int(subscription_id)
    row = db.one('SELECT id FROM subscriptions WHERE id = ?', (subscription_id,))
    if not row:
        raise SubscriptionError('That subscription was not found.')
    db.run('UPDATE subscriptions SET revoked = 1, revoked_at = ? WHERE id = ?',
           (int(time.time()), subscription_id))

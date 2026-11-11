"""Subscription plans of a website, the free trial, and payments told by hand ("I paid").

A plan (made by an admin): a name, a price as it is shown, how many days it gives, for all shared
books or chosen ones, how long the app may stay offline with it, and up to two pictures of the
owner's payment QR codes (WeChat, Alipay, a bank …). There is no online payment yet: a user pays
the owner, presses "I paid" (a note, a screenshot if wanted), and an admin approves the request —
then the plan's days are given (subscriptions.grant, kind 'plan') — or refuses it. The amount an
admin types when approving is what the admin says was paid: not a proof of payment.
(amount_minor, currency, stripe_price: kept for card payments later; not used yet.)

A new account gets a free trial by itself: TRIAL days of all shared books (0: none), once.
Files (QR pictures, screenshots): DATA/plans/.
"""
import json
import os
import re
import time

import db
import subscriptions

FILES = 'plans'
TRIAL_DEFAULT = 3
OFFLINE_DEFAULT = subscriptions.OFFLINE_DEFAULT
PICTURE_MB = 5
STATES = ('pending', 'approved', 'refused')


class PlanError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


# ---------------------------------------------------------------- Settings

def setting(key, default=None):
    row = db.one('SELECT value FROM settings WHERE key = ?', (key,))
    return json.loads(row['value']) if row else default


def set_setting(key, value):
    db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
           (key, json.dumps(value)))


def trial_days():
    return int(setting('trial_days', TRIAL_DEFAULT))


def set_trial_days(days):
    try:
        days = int(days)
    except (TypeError, ValueError):
        raise PlanError('Enter the days of the free trial as a number (0: no trial).')
    if not 0 <= days <= 365:
        raise PlanError('The free trial can be from 0 to 365 days.')
    set_setting('trial_days', days)
    return days


def start_trial(user_id):
    """The free trial of a new account (all shared books), if there is one. Once per account."""
    days = trial_days()
    if days <= 0 or db.one("SELECT 1 FROM subscription_codes WHERE kind = 'trial' AND redeemed_by = ?", (int(user_id),)):
        return None
    return subscriptions.grant(0, user_id, days, '*', 'Free trial', kind='trial')


# ---------------------------------------------------------------- Plans

def _folder():
    path = os.path.join(db.DATA, FILES)
    os.makedirs(path, exist_ok=True)
    return path


def _kind_of_picture(data):
    if data[:3] == b'\xff\xd8\xff':
        return '.jpg'
    if data[:8] == b'\x89PNG\r\n\x1a\n':
        return '.png'
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return '.webp'
    raise PlanError('Only JPEG, PNG and WebP pictures can be used.')


def _plan(row, admin=False):
    books = json.loads(row['books'] or '["*"]')
    out = {'id': row['id'], 'name': row['name'], 'price': row['price_label'], 'about': row['about'], 'days': row['days'],
           'books': books, 'offlineMinutes': row['offline_minutes'],
           'qr': [{'n': n, 'label': row[f'qr{n}_label'], 'url': f"/api/plan-files/{row[f'qr{n}']}"} for n in (1, 2) if row[f'qr{n}']]}
    if admin:
        out.update(active=bool(row['active']), sort=row['sort'], created=row['created'],
                   subscribers=db.one('SELECT COUNT(DISTINCT user_id) AS n FROM subscriptions WHERE plan_id = ? AND revoked = 0 AND ends_at > ?',
                                      (row['id'], int(time.time())))['n'])
    return out


def get(plan_id):
    try:
        return db.one('SELECT * FROM plans WHERE id = ?', (int(plan_id),))
    except (TypeError, ValueError):
        return None


def listing(admin=False):
    rows = db.rows('SELECT * FROM plans' + ('' if admin else ' WHERE active = 1') + ' ORDER BY sort, id')
    return [_plan(r, admin) for r in rows]


def _clean(raw, book_ok):
    raw = raw if isinstance(raw, dict) else {}
    out = {}
    if 'name' in raw:
        out['name'] = ' '.join(str(raw['name']).split())[:60]
        if not out['name']:
            raise PlanError('Give the plan a name.')
    if 'price' in raw:
        out['price_label'] = ' '.join(str(raw['price']).split())[:40]
    if 'about' in raw:
        out['about'] = str(raw['about']).strip()[:400]
    for key, column, low, high, what in (('days', 'days', 1, 3650, 'A plan gives from 1 to 3,650 days.'),
                                         ('offlineMinutes', 'offline_minutes', 10, 525600,
                                          'The offline time can be from 10 minutes to 365 days.'),
                                         ('sort', 'sort', -1000, 1000, 'Bad order.')):
        if key in raw:
            try:
                out[column] = int(raw[key])
            except (TypeError, ValueError):
                raise PlanError(what)
            if not low <= out[column] <= high:
                raise PlanError(what)
    if 'books' in raw:
        try:
            books = subscriptions._books(raw['books'])
        except subscriptions.SubscriptionError as e:
            raise PlanError(str(e))
        if books != ['*'] and not all(book_ok(b) for b in books):
            raise PlanError('A plan can open only ready, shared books.')
        out['books'] = json.dumps(books)
    if 'active' in raw:
        out['active'] = int(bool(raw['active']))
    for n in (1, 2):
        if f'qr{n}Label' in raw:
            out[f'qr{n}_label'] = ' '.join(str(raw[f'qr{n}Label']).split())[:40]
    return out


def create(raw, book_ok):
    clean = _clean(raw, book_ok)
    if not clean.get('name'):
        raise PlanError('Give the plan a name.')
    if 'days' not in clean:
        raise PlanError('Say how many days the plan gives.')
    clean.setdefault('created', int(time.time()))
    cols = ', '.join(clean)
    pid = db.run(f"INSERT INTO plans ({cols}) VALUES ({', '.join('?' for _ in clean)})", tuple(clean.values()))
    return _plan(get(pid), True)


def update(plan_id, raw, book_ok):
    row = get(plan_id)
    if not row:
        raise PlanError('This plan was not found.', 404)
    clean = _clean(raw, book_ok)
    if clean:
        db.run(f"UPDATE plans SET {', '.join(f'{k} = ?' for k in clean)} WHERE id = ?", (*clean.values(), row['id']))
    return _plan(get(row['id']), True)


def delete(plan_id):
    """A plan nobody ever had goes; one that was given stays, switched off (its people keep their days)."""
    row = get(plan_id)
    if not row:
        raise PlanError('This plan was not found.', 404)
    used = db.one('SELECT (SELECT COUNT(*) FROM subscriptions WHERE plan_id = ?) + (SELECT COUNT(*) FROM payment_requests WHERE plan_id = ?) '
                  '+ (SELECT COUNT(*) FROM subscription_codes WHERE plan_id = ?) AS n', (row['id'],) * 3)['n']
    if used:
        db.run('UPDATE plans SET active = 0 WHERE id = ?', (row['id'],))
        return {'deleted': False, 'plan': _plan(get(row['id']), True)}
    for n in (1, 2):
        _remove_file(row[f'qr{n}'])
    db.run('DELETE FROM plans WHERE id = ?', (row['id'],))
    return {'deleted': True}


def _remove_file(name):
    if name:
        try:
            os.remove(os.path.join(_folder(), name))
        except OSError:
            pass


def set_qr(plan_id, n, data):
    """A picture of a payment QR code (n: 1 or 2); data None: taken away."""
    row = get(plan_id)
    if not row or str(n) not in ('1', '2'):
        raise PlanError('This plan was not found.', 404)
    name = ''
    if data is not None:
        if len(data) > PICTURE_MB * 2 ** 20:
            raise PlanError(f'The picture is too big (at most {PICTURE_MB} MB).')
        name = f"qr-{row['id']}-{n}-{int(time.time())}{_kind_of_picture(data)}"
        with open(os.path.join(_folder(), name), 'wb') as f:
            f.write(data)
    _remove_file(row[f'qr{n}'])
    db.run(f'UPDATE plans SET qr{n} = ? WHERE id = ?', (name, row['id']))
    return _plan(get(row['id']), True)


FILE_RE = re.compile(r'^(?:qr-\d+-[12]-\d+|proof-\d+-\d+)\.(?:jpg|png|webp)$')
KINDS = {'.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp'}


def file_path(name, user):
    """(path, content type) of a QR picture (anyone logged in) or a screenshot (admins, and the
    one who sent it), or None."""
    if not user or not FILE_RE.match(str(name)):
        return None
    if name.startswith('proof-') and not user['admin']:
        row = db.one('SELECT user_id FROM payment_requests WHERE proof = ?', (name,))
        if not row or row['user_id'] != user['id']:
            return None
    path = os.path.join(_folder(), name)
    return (path, KINDS[os.path.splitext(name)[1]]) if os.path.isfile(path) else None


# ---------------------------------------------------------------- "I paid"

def _request(r):
    return {'id': r['id'], 'plan': r['plan_id'], 'planName': r['plan_name'], 'note': r['note'], 'status': r['status'],
            'proof': f"/api/plan-files/{r['proof']}" if r['proof'] else None, 'amount': r['amount_label'], 'reply': r['reply'],
            'created': r['created'], 'decided': r['decided_at'] or None,
            **({'user': {'id': r['user_id'], 'name': r['user_name'], 'email': r['user_email']}} if 'user_name' in r else {})}


def paid(user, plan_id, note=''):
    """The user says they paid for a plan: a request for the admins. One open request per plan."""
    row = get(plan_id)
    if not row or not row['active']:
        raise PlanError('This plan is not offered (any more).', 404)
    if db.one("SELECT 1 FROM payment_requests WHERE user_id = ? AND plan_id = ? AND status = 'pending'", (user['id'], row['id'])):
        raise PlanError('You told us about this payment already. An admin will look at it soon.')
    rid = db.run('INSERT INTO payment_requests (user_id, plan_id, plan_name, note, created) VALUES (?, ?, ?, ?, ?)',
                 (user['id'], row['id'], row['name'], str(note or '').strip()[:300], int(time.time())))
    return of_user(user['id'], rid)[0]


def set_proof(user, request_id, data):
    """A screenshot of the payment, added to one's own open request."""
    r = db.one("SELECT * FROM payment_requests WHERE id = ? AND user_id = ? AND status = 'pending'", (int(request_id), user['id']))
    if not r:
        raise PlanError('This request was not found.', 404)
    if len(data) > PICTURE_MB * 2 ** 20:
        raise PlanError(f'The picture is too big (at most {PICTURE_MB} MB).')
    name = f"proof-{r['id']}-{int(time.time())}{_kind_of_picture(data)}"
    with open(os.path.join(_folder(), name), 'wb') as f:
        f.write(data)
    _remove_file(r['proof'])
    db.run('UPDATE payment_requests SET proof = ? WHERE id = ?', (name, r['id']))
    return of_user(user['id'], r['id'])[0]


def of_user(user_id, request_id=None):
    """An account's requests, newest first (or one of them)."""
    rows = db.rows('SELECT * FROM payment_requests WHERE user_id = ?' + (' AND id = ?' if request_id else '') + ' ORDER BY id DESC LIMIT 50',
                   (int(user_id), *([int(request_id)] if request_id else [])))
    return [_request(r) for r in rows]


def requests(status=None):
    """For the admins: the requests (open ones first), with who sent them."""
    rows = db.rows('SELECT r.*, u.name AS user_name, u.email AS user_email FROM payment_requests r JOIN users u ON u.id = r.user_id '
                   + ('WHERE r.status = ? ' if status else '') + "ORDER BY r.status != 'pending', r.id DESC LIMIT 500",
                   (status,) if status else ())
    return [_request(r) for r in rows]


def decide(admin, request_id, action, amount='', reply=''):
    """An admin approves a request (the plan's days are given, as the plan is now) or refuses it.
    amount: what the admin says was paid (a note for the statistics, not a proof)."""
    if action not in ('approve', 'refuse'):
        raise PlanError('Approve or refuse.')
    now = int(time.time())
    try:
        rid = int(request_id)
    except (TypeError, ValueError):
        raise PlanError('This request was not found.', 404)
    r = db.one('SELECT * FROM payment_requests WHERE id = ?', (rid,))
    if not r:
        raise PlanError('This request was not found.', 404)
    # (first marked, so two admins cannot both give the days)
    changed = db.transaction(lambda c: c.execute(
        "UPDATE payment_requests SET status = ?, amount_label = ?, reply = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'",
        ('approved' if action == 'approve' else 'refused', ' '.join(str(amount or '').split())[:40], str(reply or '').strip()[:300],
         now, admin['id'], rid)).rowcount)
    if not changed:
        raise PlanError('This request is answered already.')
    grant = None
    if action == 'approve':
        plan = get(r['plan_id'])
        if not plan:
            db.run("UPDATE payment_requests SET status = 'pending', decided_at = 0 WHERE id = ?", (rid,))
            raise PlanError('Its plan was deleted. Give the days on the user’s page instead, then refuse this request.')
        grant = give(admin['id'], r['user_id'], plan)
    return {'request': [x for x in requests() if x['id'] == rid][0], 'grant': grant}


def give(admin_id, user_id, plan):
    """The days of a plan given to an account (a row of plans)."""
    return subscriptions.grant(admin_id, user_id, plan['days'], json.loads(plan['books'] or '["*"]'), f"Plan: {plan['name']}",
                               kind='plan', plan_id=plan['id'], offline_minutes=plan['offline_minutes'])


def forget(c, user_id):
    """(an account deleted)"""
    for r in c.execute('SELECT proof FROM payment_requests WHERE user_id = ?', (int(user_id),)).fetchall():
        _remove_file(r['proof'])
    c.execute('DELETE FROM payment_requests WHERE user_id = ?', (int(user_id),))


def admin_data():
    return {'plans': listing(True), 'requests': requests(), 'trialDays': trial_days(),
            'pending': db.one("SELECT COUNT(*) AS n FROM payment_requests WHERE status = 'pending'")['n']}

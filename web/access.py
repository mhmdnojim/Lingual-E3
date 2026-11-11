"""What each account of a website may use: features switched on or off by an admin, and amounts
of the paid AI services (server.py checks them on every request; admins may use everything).

Features (FEATURES): on for everyone unless an admin switches one off — for everyone (the row of
user 0) or for one account (its own row, which counts first).

Paid AI (PAID: the scripts written by speech recognition, pictures made by AI, page layouts
found by AI) is off until an admin gives an account an amount, with or without an end date: the
server counts every use (spend) and stops at zero. Scripts are counted in seconds of sound.
"""
import re
import subprocess
import time

import db

# key: (name for the admin, what the user is told when it is off)
FEATURES = {
    'add_books': ('Add books', 'adding books'),
    'my_audio': ('My audio (MP3s)', 'making MP3s'),
    'translation': ('Translation', 'translations'),
    'breakdown': ('Sentence breakdown', 'breaking sentences down'),
    'words': ('New words and flashcards', 'new words'),
    'correction': ('Correction mode', 'correcting books'),
    'download_pdf': ('Download the PDF', 'downloading the PDF'),
    'offline': ('Offline use', 'offline use'),
}
# kind: (name, unit shown, how many of the saved unit make one shown)
PAID = {
    'scripts': ('Scripts of audio and video', 'minutes', 60),
    'pictures': ('Pictures made by AI', 'pictures', 1),
    'layout': ('Page layouts by AI', 'pages', 1),
}
EVERYONE = 0


class AccessError(Exception):
    def __init__(self, message, status=403):
        super().__init__(message)
        self.status = status


# ---------------------------------------------------------------- Features

def _switches(user_id):
    rows = db.rows('SELECT user_id, feature, allowed FROM user_features WHERE user_id IN (?, ?)', (EVERYONE, int(user_id)))
    everyone = {r['feature']: bool(r['allowed']) for r in rows if r['user_id'] == EVERYONE}
    own = {r['feature']: bool(r['allowed']) for r in rows if r['user_id'] != EVERYONE}
    return everyone, own


def features(user):
    """{feature: may this account use it}. Admins: everything."""
    if not user or user['admin']:
        return {f: bool(user) for f in FEATURES}
    everyone, own = _switches(user['id'])
    return {f: own.get(f, everyone.get(f, True)) for f in FEATURES}


def allowed(user, feature):
    return features(user)[feature]


def need(user, feature):
    """AccessError when the feature is switched off for this account."""
    if not allowed(user, feature):
        raise AccessError(f'The admin has switched off {FEATURES[feature][1]} for your account.')


def feature_rows(user_id=None):
    """For the admin: [{key, name, on, own (None: as everyone | True | False), everyone}] of an
    account, or of everyone (user_id None)."""
    everyone, own = _switches(user_id if user_id is not None else EVERYONE)
    return [{'key': f, 'name': name, 'everyone': everyone.get(f, True),
             'own': None if user_id is None else own.get(f),
             'on': everyone.get(f, True) if user_id is None else own.get(f, everyone.get(f, True))}
            for f, (name, _) in FEATURES.items()]


def set_feature(user_ids, feature, value):
    """Switch a feature on (True) or off (False) for these accounts — or, with None, as for
    everyone again. user_ids 'everyone': for everyone (None there: on, as at first)."""
    if feature not in FEATURES:
        raise AccessError('Unknown feature.', 400)
    if value not in (True, False, None):
        raise AccessError('Choose on or off.', 400)
    ids = [EVERYONE] if user_ids == 'everyone' else [int(i) for i in user_ids]
    if not ids or len(ids) > 5000:
        raise AccessError('Choose the accounts.', 400)

    def apply(c):
        for uid in ids:
            c.execute('DELETE FROM user_features WHERE user_id = ? AND feature = ?', (uid, feature))
            if value is not None:
                c.execute('INSERT INTO user_features (user_id, feature, allowed) VALUES (?, ?, ?)', (uid, feature, int(value)))
    db.transaction(apply)


# ---------------------------------------------------------------- Paid AI amounts

def _live(c, user_id, kind, now):
    """The account's amounts of a kind that can still be used: those ending first, first."""
    return c.execute('SELECT id, amount, used, expires_at FROM ai_amounts WHERE user_id = ? AND kind = ? AND used < amount '
                     'AND (expires_at = 0 OR expires_at > ?) ORDER BY expires_at = 0, expires_at, id',
                     (int(user_id), kind, now)).fetchall()


def left(user, kind, now=None):
    """How much of a paid service the account may still use (in the saved unit: seconds of
    scripts, pictures, pages). Admins: None (no limit)."""
    if not user:
        return 0
    if user['admin']:
        return None
    now = int(time.time()) if now is None else int(now)
    return db.transaction(lambda c: sum(r['amount'] - r['used'] for r in _live(c, user['id'], kind, now)))


def spend(user, kind, n, now=None):
    """Count n uses (seconds, pictures, pages) — all of them or none (AccessError: not enough left)."""
    name = PAID[kind][0]
    if not user:
        raise AccessError('Please log in first.', 401)
    if user['admin']:
        return
    n = max(1, int(round(n)))
    now = int(time.time()) if now is None else int(now)

    def apply(c):
        rows = _live(c, user['id'], kind, now)
        have = sum(r['amount'] - r['used'] for r in rows)
        if have <= 0:
            raise AccessError(f'{name}: the admin has not given your account an amount yet (or it is used up).')
        if have < n:
            raise AccessError(f'{name}: this needs {shown(kind, n)}, and your account has {shown(kind, have)} left. Ask the admin for more.')
        need_ = n
        for r in rows:
            take = min(need_, r['amount'] - r['used'])
            c.execute('UPDATE ai_amounts SET used = used + ? WHERE id = ?', (take, r['id']))
            need_ -= take
            if not need_:
                break
    db.transaction(apply)
    try:
        import stats
        stats.count(user, kind, 1 if kind != 'scripts' else -(-int(n) // 60))  # (scripts: minutes, a started one counted)
    except Exception:
        pass


def give_back(user, kind, n):
    """Uses counted for work that then failed: given back (to the amount ending last)."""
    if not user or user['admin'] or n <= 0:
        return

    def apply(c):
        need_ = int(round(n))
        for r in c.execute('SELECT id, used FROM ai_amounts WHERE user_id = ? AND kind = ? AND used > 0 '
                           'ORDER BY expires_at = 0 DESC, expires_at DESC, id DESC',
                           (user['id'], kind)).fetchall():
            take = min(need_, r['used'])
            c.execute('UPDATE ai_amounts SET used = used - ? WHERE id = ?', (take, r['id']))
            need_ -= take
            if not need_:
                break
    db.transaction(apply)


def shown(kind, n):
    """An amount in words: "12 minutes", "1 picture", "3 pages"."""
    _, unit, per = PAID[kind]
    v = n / per
    v = int(v) if float(v).is_integer() else round(v, 1)
    return f"{v} {unit[:-1] if v == 1 else unit}"


def give(admin_id, user_id, kind, amount, expires_at=0):
    """An amount given by an admin (in the unit shown: minutes, pictures, pages)."""
    if kind not in PAID:
        raise AccessError('Unknown AI service.', 400)
    try:
        amount = float(amount)
        expires_at = int(expires_at or 0)
    except (TypeError, ValueError):
        raise AccessError('Enter the amount as a number.', 400)
    if not 0 < amount <= 100000:
        raise AccessError('Give an amount from 1 to 100,000.', 400)
    now = int(time.time())
    if expires_at and expires_at <= now:
        raise AccessError('The end date must be in the future.', 400)
    return db.run('INSERT INTO ai_amounts (user_id, kind, amount, used, expires_at, given_by, created) VALUES (?, ?, ?, 0, ?, ?, ?)',
                  (int(user_id), kind, int(round(amount * PAID[kind][2])), expires_at, int(admin_id), now))


def take_away(user_id, amount_id):
    """What is left of an amount is taken away (what was used stays counted)."""
    if not db.one('SELECT 1 FROM ai_amounts WHERE id = ? AND user_id = ?', (int(amount_id), int(user_id))):
        raise AccessError('This amount is not this account’s.', 404)
    db.run('UPDATE ai_amounts SET amount = used WHERE id = ?', (int(amount_id),))


def amounts(user_id, now=None):
    """For the admin and the account: {kind: {name, unit, left (shown unit), rows: [{id, amount,
    used, left, expiresAt, state}]}}."""
    now = int(time.time()) if now is None else int(now)
    out = {}
    for kind, (name, unit, per) in PAID.items():
        rows = []
        for r in db.rows('SELECT id, amount, used, expires_at, created FROM ai_amounts WHERE user_id = ? AND kind = ? ORDER BY id DESC',
                         (int(user_id), kind)):
            over = bool(r['expires_at']) and r['expires_at'] <= now
            rows.append({'id': r['id'], 'amount': round(r['amount'] / per, 1), 'used': round(r['used'] / per, 1),
                         'left': 0 if over else round((r['amount'] - r['used']) / per, 1), 'expiresAt': r['expires_at'] or None,
                         'created': r['created'], 'state': 'ended' if over else 'used up' if r['used'] >= r['amount'] else 'active'})
        out[kind] = {'name': name, 'unit': unit, 'left': round(sum(r['left'] for r in rows), 1), 'rows': rows}
    return out


def summary(user):
    """For the page (/api/me): {features: {key: bool}, ai: {kind: left in the shown unit, or None: no limit}}."""
    ai = {}
    for kind, (_, _, per) in PAID.items():
        n = left(user, kind)
        ai[kind] = None if n is None else round(n / per, 1)
    return {'features': features(user), 'ai': ai}


def forget(c, user_id):
    """(an account deleted)"""
    c.execute('DELETE FROM user_features WHERE user_id = ?', (int(user_id),))
    c.execute('DELETE FROM ai_amounts WHERE user_id = ?', (int(user_id),))


# ---------------------------------------------------------------- How long a recording is

DURATION = re.compile(rb'Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)')


def media_seconds(path, ffmpeg):
    """The length of an audio or video file in seconds (ffmpeg reads its header), or None."""
    if not ffmpeg:
        return None
    try:
        r = subprocess.run([ffmpeg, '-hide_banner', '-i', str(path)], capture_output=True, timeout=60,
                           creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except (OSError, subprocess.SubprocessError):
        return None
    m = DURATION.search(r.stderr)
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)) if m else None

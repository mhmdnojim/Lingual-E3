"""A record of use, and the Statistics part of the Admin page (server.py /api/admin/stats).

What is kept (the terms page says so): for every account, one row a day (activity): the pages it
opened, the minutes it was active (a page opened or a sentence read counts 5 minutes, at most once
in those 5 minutes), and how many times it used translations, MP3s, new words, scripts, AI
pictures and AI layouts. No page content, no times of day. Rows are kept a year.

The statistics (summary): a period (today, this week, this month, this year, or any two dates),
for everyone or one account: who used the app, how much, who signed up, the plans (trial, paid,
given), the money the admins recorded when approving payments (what they typed: not a proof), and
the paid AI used (with an estimate of its cost: COST).
"""
import datetime
import json
import threading
import time

import db

COUNTED = ('pages', 'reads', 'translations', 'mp3s', 'words', 'scripts', 'pictures', 'layout')
SLOT = 300          # seconds of activity counted for one page or reading (at most once per slot)
KEEP_DAYS = 366
# What a use of the paid AI services costs the owner, about (US cents): told next to the counts.
COST = {'scripts': 0.7, 'pictures': 4.0, 'layout': 1.0}  # a minute of ElevenLabs Scribe, an OpenAI picture, a page by gpt-4.1

_lock = threading.Lock()
_slot = {}   # user id -> the end of the activity slot counted now
_days = {}   # user id -> the day its row is of (rows made at most once a day per account)
_cleanup_day = ''


def _day(now=None):
    return datetime.date.fromtimestamp(time.time() if now is None else now).isoformat()


def _row(c, uid, day):
    c.execute('INSERT OR IGNORE INTO activity (user_id, day) VALUES (?, ?)', (uid, day))


def count(user, what, n=1, now=None):
    """An account used something (what: one of COUNTED). Admins and this computer's user: not counted."""
    if not user or what not in COUNTED or user['id'] == db.LOCAL_USER or user.get('admin'):
        return
    uid, now = int(user['id']), time.time() if now is None else now
    day = _day(now)
    active = 0
    cleanup = False
    with _lock:
        global _cleanup_day
        if day != _cleanup_day:
            _cleanup_day = day
            cleanup = True
        if what in ('pages', 'reads') and now >= _slot.get(uid, 0):
            _slot[uid] = now + SLOT
            active = SLOT // 60

    if cleanup:
        # Keep the one-year retention promise without requiring a separate scheduler. The first
        # recorded activity of each local day performs the inexpensive indexed deletion.
        forget_old(now)

    def apply(c):
        _row(c, uid, day)
        c.execute(f'UPDATE activity SET {what} = {what} + ?, minutes = minutes + ? WHERE user_id = ? AND day = ?', (int(n), active, uid, day))
    db.transaction(apply)


def forget_old(now=None):
    db.run('DELETE FROM activity WHERE day < ?', (_day((time.time() if now is None else now) - KEEP_DAYS * 86400),))


def forget(c, user_id):
    """(an account deleted)"""
    c.execute('DELETE FROM activity WHERE user_id = ?', (int(user_id),))


# ---------------------------------------------------------------- The statistics

def period(name, start=None, end=None, now=None):
    """(first day, last day) as ISO dates: 'today', 'week', 'month', 'year', or 'custom' with start and end."""
    today = datetime.date.fromtimestamp(time.time() if now is None else now)
    if name == 'custom':
        try:
            a, b = datetime.date.fromisoformat(str(start)), datetime.date.fromisoformat(str(end))
        except (TypeError, ValueError):
            raise ValueError('Give the two dates as YYYY-MM-DD.')
        if b < a:
            a, b = b, a
        if (b - a).days > 3 * 366:
            raise ValueError('At most three years at a time.')
        return a.isoformat(), b.isoformat()
    if name == 'week':
        return (today - datetime.timedelta(days=today.weekday())).isoformat(), today.isoformat()
    if name == 'month':
        return today.replace(day=1).isoformat(), today.isoformat()
    if name == 'year':
        return today.replace(month=1, day=1).isoformat(), today.isoformat()
    return today.isoformat(), today.isoformat()


def _stamps(first, last):
    a = datetime.datetime.fromisoformat(first).timestamp()
    b = datetime.datetime.fromisoformat(last).timestamp() + 86400
    return int(a), int(b)


def _money(rows):
    """The amounts the admins typed, added up by their first word or sign ("¥30" + "¥20" = {'¥': 50}); the rest listed."""
    import re
    out, other = {}, []
    for text in rows:
        m = re.fullmatch(r'\s*([^\d\s.,-]{0,4})\s*([\d.,]+)\s*([^\d\s.,]{0,4})\s*', text or '')
        if not m:
            if text:
                other.append(text)
            continue
        unit = (m.group(1) or m.group(3) or '').strip() or '?'
        try:
            out[unit] = round(out.get(unit, 0) + float(m.group(2).replace(',', '')), 2)
        except ValueError:
            other.append(text)
    return {'sums': out, 'other': other}


def summary(name='today', start=None, end=None, user_id=None, now=None):
    """The statistics of a period, for everyone or one account (user_id)."""
    first, last = period(name, start, end, now)
    a, b = _stamps(first, last)
    who = ' AND user_id = ?' if user_id else ''
    args = (int(user_id),) if user_id else ()
    use = db.one(f'SELECT COUNT(DISTINCT user_id) AS users, COALESCE(SUM(minutes), 0) AS minutes, COUNT(*) AS days, '
                 + ', '.join(f'COALESCE(SUM({k}), 0) AS {k}' for k in COUNTED)
                 + f' FROM activity WHERE day BETWEEN ? AND ?{who}', (first, last, *args))
    signed = db.one(f"SELECT COUNT(*) AS n FROM users WHERE created >= ? AND created < ? AND email != 'local'{who.replace('user_id', 'id')}", (a, b, *args))['n']
    # (plans by when they were given — a plan added after another starts later)
    plans = db.rows(f'SELECT c.kind, COUNT(*) AS n FROM subscriptions s JOIN subscription_codes c ON c.id = s.code_id '
                    f'WHERE c.created >= ? AND c.created < ?{who.replace("user_id", "s.user_id")} GROUP BY c.kind', (a, b, *args))
    paid = db.rows(f"SELECT amount_label FROM payment_requests WHERE status = 'approved' AND decided_at >= ? AND decided_at < ?{who}", (a, b, *args))
    refused = db.one(f"SELECT COUNT(*) AS n FROM payment_requests WHERE status = 'refused' AND decided_at >= ? AND decided_at < ?{who}", (a, b, *args))['n']
    pending = db.one("SELECT COUNT(*) AS n FROM payment_requests WHERE status = 'pending'" + who, args)['n']
    active_now = db.one(f'SELECT COUNT(DISTINCT user_id) AS n FROM subscriptions WHERE revoked = 0 AND starts_at <= ? AND ends_at > ?{who}',
                        (b - 1, b - 1, *args))['n']
    ai = {k: {'n': use[k], 'cost': round(use[k] * COST[k] / 100, 2)} for k in COST}
    # The busiest accounts of the period (everyone), or the days of one account.
    if user_id:
        detail = db.rows('SELECT day, minutes, ' + ', '.join(COUNTED) + ' FROM activity WHERE user_id = ? AND day BETWEEN ? AND ? ORDER BY day DESC LIMIT 400',
                         (int(user_id), first, last))
    else:
        detail = db.rows('SELECT a.user_id AS id, u.name, u.email, SUM(a.minutes) AS minutes, COUNT(*) AS days, '
                         + ', '.join(f'SUM(a.{k}) AS {k}' for k in COUNTED)
                         + ' FROM activity a JOIN users u ON u.id = a.user_id WHERE a.day BETWEEN ? AND ? GROUP BY a.user_id ORDER BY minutes DESC LIMIT 50',
                         (first, last))
    return {
        'period': {'name': name, 'first': first, 'last': last},
        'users': use['users'], 'minutes': use['minutes'], 'activeDays': use['days'], 'signedUp': signed,
        'use': {k: use[k] for k in COUNTED},
        'plans': {r['kind']: r['n'] for r in plans}, 'withPlanNow': active_now,
        'payments': {'approved': len(paid), 'refused': refused, 'pending': pending, 'recorded': _money([p['amount_label'] for p in paid])},
        'ai': ai, 'aiCost': round(sum(v['cost'] for v in ai.values()), 2), 'costNote': COST,
        'detail': detail,
    }

"""The Users tab of the Admin page: every account, its role, plan and use, and what an admin may
change about it (server.py: /api/admin/users).

Roles (accounts.role): the owner (an admin whose e-mail is in LB_ADMIN_EMAIL; on this computer its
only user), helper admins (made by the owner) and users. The rules, checked here on the server:
- only the owner makes or removes admins (and only the owner changes the API keys: server.py);
- a helper admin manages users, not admins or the owner;
- nobody blocks, deletes or takes the admin role from the owner, or does it to themselves.
Blocking and a new password log the account out everywhere (accounts: its version is raised).
Days given here are kept as a grant of kind 'given' (subscriptions.grant), added to a grant of the
same books not ended yet, as an access code adds them.
"""
import json
import os
import shutil
import time

import accounts
import db
import library
import subscriptions

ACTIONS = ('block', 'unblock', 'make-admin', 'remove-admin', 'password', 'give-days', 'revoke-plan', 'delete')
LIST_MOST = 5000


class UsersError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def _plans(now):
    """{user id: {active, expiresAt, books ('*' or how many)}} of the grants not ended yet."""
    out = {}
    for g in db.rows('SELECT user_id, books, starts_at, ends_at FROM subscriptions WHERE revoked = 0 AND ends_at > ?', (now,)):
        p = out.setdefault(g['user_id'], {'active': False, 'expiresAt': None, 'all': False, 'books': set()})
        if g['starts_at'] <= now:
            p['active'] = True
        p['expiresAt'] = max(p['expiresAt'] or 0, g['ends_at'])
        books = json.loads(g['books'] or '["*"]')
        if '*' in books:
            p['all'] = True
        else:
            p['books'].update(books)
    return {uid: {'active': p['active'], 'expiresAt': p['expiresAt'], 'books': '*' if p['all'] else len(p['books'])}
            for uid, p in out.items()}


def _row(u, plans):
    return {'id': u['id'], 'name': u['name'], 'email': u['email'], 'role': accounts.role(u),
            'blocked': bool(u['disabled']), 'created': u['created'], 'lastSeen': u['last_seen'] or None,
            'books': u['books'], 'bytes': u['bytes'], 'plan': plans.get(u['id'])}


def _accounts(where='', args=()):
    # (the row of this computer's user is not an account of the website: never listed)
    return db.rows('SELECT u.*, (SELECT COUNT(*) FROM books b WHERE b.owner = u.id) AS books, '
                   '(SELECT COALESCE(SUM(b.bytes), 0) FROM books b WHERE b.owner = u.id) AS bytes '
                   f"FROM users u WHERE u.email != 'local' {where} ORDER BY u.created DESC LIMIT {LIST_MOST}", args)


def listing(now=None):
    now = int(time.time()) if now is None else int(now)
    plans = _plans(now)
    return [_row(u, plans) for u in _accounts()]


def _target(uid):
    rows = _accounts('AND u.id = ?', (int(uid),))
    if not rows:
        raise UsersError('This account was not found.', 404)
    return rows[0]


def allowed(actor, target):
    """What this admin may do to this account: {action: True | 'why not'}."""
    owner, me = accounts.is_owner(actor), actor['id'] == target['id']
    out = {}
    for action in ACTIONS:
        if not (actor and actor['admin']):
            why = 'Only an admin can do this.'
        elif action in ('make-admin', 'remove-admin') and not owner:
            why = 'Only the owner makes or removes admins.'
        elif accounts.is_owner(target) and action in ('block', 'remove-admin', 'delete', 'password'):
            why = 'The owner’s account cannot be changed here (your own password: the account menu).'
        elif me and action in ('block', 'delete', 'remove-admin', 'password'):
            why = 'Not your own account (your own password: the account menu).'
        elif target['admin'] and not owner and not me:
            why = 'Only the owner changes another admin’s account.'
        elif action == 'make-admin' and target['admin']:
            why = 'This account is an admin already.'
        elif action == 'remove-admin' and not target['admin']:
            why = 'This account is not an admin.'
        elif action == 'block' and target['disabled']:
            why = 'This account is blocked already.'
        elif action == 'unblock' and not target['disabled']:
            why = 'This account is not blocked.'
        else:
            why = True
        out[action] = why
    return out


def details(actor, uid, now=None):
    """One account for the Users tab: its row, its grants, its books and what the admin may do."""
    now = int(time.time()) if now is None else int(now)
    u = _target(uid)
    out = _row(u, _plans(now))
    out['grants'] = subscriptions.of_user(u['id'], now)
    out['bookList'] = db.rows('SELECT id, title, status, visibility, bytes FROM books WHERE owner = ? ORDER BY updated DESC LIMIT 200',
                              (u['id'],))
    out['may'] = {k: v is True for k, v in allowed(actor, u).items()}
    out['you'] = actor['id'] == u['id']
    return out


def change(actor, uid, body):
    """Do an action ({action, ...}) to an account. Returns its details, or {'deleted': True}."""
    body = body if isinstance(body, dict) else {}
    action = str(body.get('action', ''))
    if action not in ACTIONS:
        raise UsersError('Unknown action.')
    target = _target(uid)
    why = allowed(actor, target)[action]
    if why is not True:
        raise UsersError(why, 403)
    tid = target['id']
    if action == 'block':
        db.run('UPDATE users SET disabled = 1, version = version + 1 WHERE id = ?', (tid,))
    elif action == 'unblock':
        db.run('UPDATE users SET disabled = 0 WHERE id = ?', (tid,))
    elif action == 'make-admin':
        db.run('UPDATE users SET admin = 1 WHERE id = ?', (tid,))
    elif action == 'remove-admin':
        db.run('UPDATE users SET admin = 0 WHERE id = ?', (tid,))
    elif action == 'password':
        password = str(body.get('password', ''))
        if len(password) < 8:
            raise UsersError('The new password needs at least 8 characters.')
        db.run('UPDATE users SET pw = ?, version = version + 1 WHERE id = ?', (accounts.hash_password(password), tid))
    elif action == 'give-days':
        books = body.get('books', '*')
        if books != '*':
            if not isinstance(books, list) or not books:
                raise UsersError('Choose all shared books, or one or more of them.')
            for bid in books:
                b = library.get(str(bid))
                if not b or b['visibility'] != 'public' or b['status'] != 'ready':
                    raise UsersError('Days can be given only for ready, shared books.')
        try:
            subscriptions.grant(actor['id'], tid, body.get('days'), books, f"Given by {actor['name']}")
        except subscriptions.SubscriptionError as e:
            raise UsersError(str(e))
    elif action == 'revoke-plan':
        try:
            gid = int(body.get('grant'))
        except (TypeError, ValueError):
            raise UsersError('Choose the plan to take away.')
        if not db.one('SELECT 1 FROM subscriptions WHERE id = ? AND user_id = ?', (gid, tid)):
            raise UsersError('This plan is not this account’s.', 404)
        subscriptions.revoke_subscription(gid)
    elif action == 'delete':
        delete(tid)
        return {'deleted': True}
    return details(actor, tid)


def delete(uid):
    """An account and everything it has: its books, plans, MP3s, new words and old-app imports."""
    for b in db.rows('SELECT * FROM books WHERE owner = ?', (uid,)):
        library.delete(b)
    try:
        import migration
        root = os.path.join(db.DATA, 'migrations')
        for mid in os.listdir(root) if os.path.isdir(root) else []:
            if migration.ID.fullmatch(mid) and migration._load(mid).get('owner') == uid:
                shutil.rmtree(os.path.join(root, mid), ignore_errors=True)
    except Exception:  # (an import that cannot be read: left; it belongs to nobody now)
        pass
    shutil.rmtree(os.path.join(db.DATA, 'users', str(int(uid))), ignore_errors=True)

    def apply(c):
        c.execute('DELETE FROM subscriptions WHERE user_id = ?', (uid,))
        c.execute('UPDATE subscription_codes SET redeemed_by = NULL WHERE redeemed_by = ?', (uid,))
        c.execute('UPDATE reports SET user = NULL WHERE user = ?', (uid,))
        c.execute('DELETE FROM users WHERE id = ?', (uid,))
    db.transaction(apply)

"""The branches of the library: folders in folders, made by admins. A main branch (Learning English
Courses) has sub-branches (American English File 2e), they have theirs (Level 1, Level 2 …), and so
on. Every book is in one branch, or at the top of the library (no branch), and its copies (links)
in others: the same book (its pages, corrections, recordings), each copy with its own name.

A book that people add has its branch in the database (books.branch). The disc's books are in the
branch of their level (level_branches): the first time the app starts with a level, the level is put
in its "branch" of web/levels.json, made if it is not there yet. After that the admins move it (they
move its branch, or each of its books), and it is put there again only when web/levels.json gives it
another branch. Admins also rename the disc's books (disc_books).
"""
import json
import time

import db

NAME_MAX = 80
TITLE_MAX = 120  # (as a book's title)


class BranchError(Exception):
    pass


def all_branches():
    """Every branch: [{id, parent, name, empty}] (empty: no book, copy or level is in it itself)."""
    return [{**r, 'empty': bool(r['empty'])} for r in db.rows(
        'SELECT b.id, b.parent, b.name, NOT EXISTS (SELECT 1 FROM books WHERE branch = b.id) '
        'AND NOT EXISTS (SELECT 1 FROM level_branches WHERE branch = b.id) '
        'AND NOT EXISTS (SELECT 1 FROM links WHERE branch = b.id) '
        'AND NOT EXISTS (SELECT 1 FROM disc_books WHERE placed = 1 AND branch = b.id) AS empty FROM branches b ORDER BY b.id')]


def get(bid):
    try:
        return db.one('SELECT * FROM branches WHERE id = ?', (int(bid),))
    except (TypeError, ValueError):
        return None


def check(bid):
    """The branch to put something in: None (the top) or the id of a branch there is."""
    if bid is None or bid == '':
        return None
    b = get(bid)
    if not b:
        raise BranchError('That branch does not exist (any more).')
    return b['id']


def paths():
    """{branch id: [the names of the branches from the top down to it]}."""
    rows = {r['id']: r for r in db.rows('SELECT id, parent, name FROM branches')}
    out = {}

    def path(bid, seen=()):
        if bid not in out:
            r = rows.get(bid)
            out[bid] = [] if not r or bid in seen else [*path(r['parent'], (*seen, bid)), r['name']]
        return out[bid]
    for bid in rows:
        path(bid)
    return out


def _name(raw):
    name = ' '.join(str(raw or '').split())[:NAME_MAX]
    if not name:
        raise BranchError('Give the branch a name.')
    return name


def _named(parent, name):
    return db.one('SELECT id FROM branches WHERE parent IS ? AND name = ? COLLATE NOCASE', (parent, name))


def _inside(bid):
    """The ids of a branch and of every branch in it, all the way down."""
    out, todo = set(), [bid]
    while todo:
        b = todo.pop()
        out.add(b)
        todo += [r['id'] for r in db.rows('SELECT id FROM branches WHERE parent = ?', (b,)) if r['id'] not in out]
    return out


def create(name, parent=None):
    """A new branch: a main branch (parent None), or a sub-branch of parent."""
    parent, name = check(parent), _name(name)
    if _named(parent, name):
        raise BranchError(f'There is already a branch “{name}” there.')
    return get(db.run('INSERT INTO branches (parent, name, created) VALUES (?, ?, ?)', (parent, name, int(time.time()))))


def change(bid, changes):
    """Rename a branch {name}, or move it with all that is in it into another {parent} (None: the top)."""
    b = get(bid)
    if not b:
        raise BranchError('That branch does not exist (any more).')
    name = _name(changes['name']) if 'name' in changes else b['name']
    parent = check(changes['parent']) if 'parent' in changes else b['parent']
    if parent is not None and parent in _inside(b['id']):
        raise BranchError('A branch cannot go into itself, or into a branch that is in it.')
    same = _named(parent, name)
    if same and same['id'] != b['id']:
        raise BranchError(f'There is already a branch “{name}” there.')
    db.run('UPDATE branches SET name = ?, parent = ? WHERE id = ?', (name, parent, b['id']))
    return get(b['id'])


def delete(bid):
    """Remove a branch. What is in it (books, copies, levels, branches) goes into the branch it was in."""
    b = get(bid)
    if not b:
        raise BranchError('That branch does not exist (any more).')
    _merge(b['id'], b['parent'])


def _merge(src, dst):
    db.run('UPDATE books SET branch = ? WHERE branch = ?', (dst, src))
    db.run('UPDATE level_branches SET branch = ? WHERE branch = ?', (dst, src))
    db.run('UPDATE links SET branch = ? WHERE branch = ?', (dst, src))
    db.run('UPDATE disc_books SET branch = ? WHERE placed = 1 AND branch = ?', (dst, src))
    for child in db.rows('SELECT id, name FROM branches WHERE parent = ?', (src,)):
        same = _named(dst, child['name'])
        if same:
            _merge(child['id'], same['id'])  # (one of the same name is there already: they become one)
        else:
            db.run('UPDATE branches SET parent = ? WHERE id = ?', (dst, child['id']))
    db.run('DELETE FROM branches WHERE id = ?', (src,))


def ensure(names):
    """The branch at the end of a path of names, made where missing: its id (None: no names)."""
    parent = None
    for name in names:
        name = _name(name)
        same = _named(parent, name)
        parent = same['id'] if same else db.run('INSERT INTO branches (parent, name, created) VALUES (?, ?, ?)',
                                                (parent, name, int(time.time())))
    return parent


def place_levels(levels):
    """Put each level [(id, [the names of its branch])] in its branch, unless it was put there already
    (from the same names: else the admins may have moved it since)."""
    for lid, names in levels:
        seed = json.dumps(names, ensure_ascii=False)
        row = db.one('SELECT seed FROM level_branches WHERE level = ?', (lid,))
        if not row or row['seed'] != seed:
            db.run('INSERT OR REPLACE INTO level_branches (level, branch, seed) VALUES (?, ?, ?)', (lid, ensure(names), seed))


def level_branches():
    """{level id: the id of its branch (None: the top)}."""
    return {r['level']: r['branch'] for r in db.rows('SELECT level, branch FROM level_branches')}


# ---------------------------------------------------------------- Copying a branch

def copy(bid, parent, disc_places):
    """Copy a branch with all that is in it into parent (None: the top): the same branches, and in
    them a copy (link) of each of their books. disc_places: the branch of each book of the disc
    {book id: branch id}. A name there already gets "(copy)". Returns the new branch."""
    b = get(bid)
    if not b:
        raise BranchError('That branch does not exist (any more).')
    parent = check(parent)
    if parent is not None and parent in _inside(b['id']):
        raise BranchError('A branch cannot be copied into itself, or into a branch that is in it.')
    name, n = b['name'], 1
    while _named(parent, name):
        n += 1
        name = _name(f"{b['name']} (copy{'' if n == 2 else f' {n - 1}'})")
    return get(_copy(b['id'], parent, name, disc_places))


def _copy(src, parent, name, disc_places):
    new = db.run('INSERT INTO branches (parent, name, created) VALUES (?, ?, ?)', (parent, name, int(time.time())))
    books = [(r['id'], '') for r in db.rows('SELECT id FROM books WHERE branch = ? ORDER BY updated DESC', (src,))]
    books += [(book, '') for book, place in disc_places.items() if place == src]
    books += [(r['book'], r['title']) for r in db.rows('SELECT book, title FROM links WHERE branch = ? ORDER BY id', (src,))]
    for book, title in books:
        _link(book, new, title)
    for child in db.rows('SELECT id, name FROM branches WHERE parent = ? ORDER BY id', (src,)):
        _copy(child['id'], new, child['name'], disc_places)
    return new


# ---------------------------------------------------------------- Copies of books (links)

def _title(raw):
    return ' '.join(str(raw or '').split())[:TITLE_MAX]


def _link(book, branch, title):
    return db.run('INSERT INTO links (book, branch, title, created) VALUES (?, ?, ?, ?)', (book, branch, title, int(time.time())))


def get_link(lid):
    try:
        return db.one('SELECT * FROM links WHERE id = ?', (int(lid),))
    except (TypeError, ValueError):
        return None


def add_link(book, branch, title=''):
    """A copy of a book in a branch (None: the top), named title ('': the book's name)."""
    return get_link(_link(book, check(branch), _title(title)))


def change_link(lid, changes):
    """Rename a copy {title}, or move it into another branch {branch}."""
    link = get_link(lid)
    if not link:
        raise BranchError('This copy does not exist (any more).')
    title = _title(changes['title']) if 'title' in changes else link['title']
    branch = check(changes['branch']) if 'branch' in changes else link['branch']
    db.run('UPDATE links SET title = ?, branch = ? WHERE id = ?', (title, branch, link['id']))
    return get_link(link['id'])


def delete_link(lid):
    db.run('DELETE FROM links WHERE id = ?', (int(lid),))


def with_links(books):
    """The books (summaries for the library), then each of their copies: the same book, with the
    copy's id (link), name and branch."""
    links = {}
    for r in db.rows('SELECT id, book, branch, title FROM links ORDER BY id'):
        links.setdefault(r['book'], []).append(r)
    return books + [{**b, 'link': r['id'], 'title': r['title'] or b['title'], 'branch': r['branch']}
                    for b in books for r in links.get(b['id'], [])]


# ---------------------------------------------------------------- The disc's books, renamed or moved

def disc_books():
    """{book id: {title, placed, branch}} of the disc's books an admin renamed or moved."""
    return {r['book']: r for r in db.rows('SELECT * FROM disc_books')}


def change_disc(book, changes):
    """Rename a book of the disc {title} ('': its own name again), or move it into a branch {branch}
    (out of the branch of its level)."""
    row = db.one('SELECT * FROM disc_books WHERE book = ?', (book,)) or {'title': '', 'placed': 0, 'branch': None}
    title = _title(changes['title']) if 'title' in changes else row['title']
    placed, branch = (1, check(changes['branch'])) if 'branch' in changes else (row['placed'], row['branch'])
    db.run('INSERT OR REPLACE INTO disc_books (book, title, placed, branch) VALUES (?, ?, ?, ?)', (book, title, placed, branch))

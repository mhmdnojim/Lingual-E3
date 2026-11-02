"""New words: the words, clauses and sentences a person collects from the pages, in categories, to
practice them as flashcards (js/words.js).

All of a person's new words are one file, words.json: on this computer in web/words (env
AEF_WORDS_DIR); on a website each user has their own (users/<id>/words.json):
    {categories: [{id, name, color}], items: [...]}   (the first version: only the list of items)

The categories: New words, Definitions and Common sentences at first; the person adds more (and
deletes them, except New words: their items go back to it).
An item: {id, book, bookId, page, path, mode: word | clause | sentence, a, b (its words on the
page), text, context (its sentence), contextOffset (where the word is in it), category, added, and
from practicing: box (0-5: how well it is known), seen, right, last}.
"""
import json
import os
import re
import secrets
import threading
import time

import ids

WEB = os.path.dirname(os.path.abspath(__file__))
DIR = os.environ.get('AEF_WORDS_DIR') or os.path.join(WEB, 'words')
MODES = ('word', 'clause', 'sentence')
ID_RE = re.compile(r'^w[0-9a-f]{12}$')
CATEGORY_RE = re.compile(r'^(?:new|def|common|c[0-9a-f]{8})$')
COLOR_RE = re.compile(r'^#[0-9a-f]{6}$')
DEFAULT_CATEGORIES = [{'id': 'new', 'name': 'New words', 'color': '#16a34a'},
                      {'id': 'def', 'name': 'Definitions', 'color': '#2563eb'},
                      {'id': 'common', 'name': 'Common sentences', 'color': '#9333ea'}]
COLORS = ('#ea580c', '#0891b2', '#db2777', '#ca8a04', '#4f46e5', '#65a30d', '#dc2626', '#475569')  # (for the others)
MAX_ITEMS = 20000
MAX_CATEGORIES = 50
_lock = threading.Lock()


def _file(folder):
    return os.path.join(folder or DIR, 'words.json')


def _load(path):
    """{categories, items}; items of no (or a deleted) category are New words."""
    try:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
    except (FileNotFoundError, ValueError):
        data = None
    if isinstance(data, list):  # (the first version)
        data = {'items': data}
    if not isinstance(data, dict):
        data = {}
    categories = [c for c in data.get('categories') or [] if isinstance(c, dict) and CATEGORY_RE.match(str(c.get('id', '')))]
    if not any(c['id'] == 'new' for c in categories):
        categories = [dict(c) for c in DEFAULT_CATEGORIES] + [c for c in categories if c['id'] not in ('def', 'common')]
    known = {c['id'] for c in categories}
    items = [i for i in data.get('items') or [] if isinstance(i, dict)]
    for i in items:
        if i.get('category') not in known:
            i['category'] = 'new'
    return {'categories': categories, 'items': items}


def _save(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, path)


def _clean(raw):
    if not isinstance(raw, dict):
        raise ValueError('bad item')
    a, b, offset = raw.get('a'), raw.get('b'), raw.get('contextOffset')
    text, context = str(raw.get('text', '')).strip(), str(raw.get('context', '')).strip()
    if not (ids.BOOK_RE.match(str(raw.get('book', ''))) and ids.PAGE_RE.match(str(raw.get('path', '')))
            and raw.get('mode') in MODES and isinstance(a, int) and isinstance(b, int) and 0 <= a < b <= a + 400
            and text and len(text) <= 2000 and len(context) <= 3000
            and (offset is None or isinstance(offset, int) and 0 <= offset <= len(context))):
        raise ValueError('bad item')
    return {'book': raw['book'], 'bookId': str(raw.get('bookId', ''))[:40], 'page': str(raw.get('page', ''))[:20],
            'path': raw['path'], 'mode': raw['mode'], 'a': a, 'b': b, 'text': text, 'context': context, 'contextOffset': offset,
            'category': str(raw.get('category') or 'new')}


def list_items(folder=None):
    """{categories, items}."""
    with _lock:
        return _load(_file(folder))


def add(raw_items, folder=None):
    """Add items to their category. One already there is not added again: it is moved to that
    category (if it is in another one) and returned."""
    if not isinstance(raw_items, list) or not 0 < len(raw_items) <= 500:
        raise ValueError('bad items')
    new = [_clean(raw) for raw in raw_items]
    path = _file(folder)
    with _lock:
        data, out = _load(path), []
        items, known = data['items'], {c['id'] for c in data['categories']}
        for c in new:
            if c['category'] not in known:
                raise ValueError('There is no such category (any more). Choose another one.')
            same = next((i for i in items if all(i.get(k) == c[k] for k in ('book', 'path', 'mode', 'a', 'b'))), None)
            if same:
                same['category'] = c['category']
            else:
                if len(items) >= MAX_ITEMS:
                    raise ValueError(f'You have {MAX_ITEMS} new words already. Delete some first.')
                same = {**c, 'id': 'w' + secrets.token_hex(6), 'added': int(time.time()), 'box': 0, 'seen': 0, 'right': 0, 'last': 0}
                items.append(same)
            out.append(same)
        _save(path, data)
    return out


def add_category(name, color=None, folder=None):
    """A new category {id, name, color} (with a name not used yet)."""
    name = ' '.join(str(name or '').split())
    if not 0 < len(name) <= 40:
        raise ValueError('Give the category a name (up to 40 letters).')
    path = _file(folder)
    with _lock:
        data = _load(path)
        categories = data['categories']
        if any(c['name'].casefold() == name.casefold() for c in categories):
            raise ValueError(f'There is a category “{name}” already.')
        if len(categories) >= MAX_CATEGORIES:
            raise ValueError(f'{MAX_CATEGORIES} categories are the most. Delete one first.')
        if not (isinstance(color, str) and COLOR_RE.match(color)):
            used = {c.get('color') for c in categories}
            color = next((c for c in COLORS if c not in used), COLORS[len(categories) % len(COLORS)])
        category = {'id': 'c' + secrets.token_hex(4), 'name': name, 'color': color}
        categories.append(category)
        _save(path, data)
    return category


def remove_category(cid, folder=None):
    """Delete a category (not New words); its items go back to New words. Returns how many."""
    if not CATEGORY_RE.match(str(cid)) or cid == 'new':
        raise ValueError('This category cannot be deleted.')
    path = _file(folder)
    with _lock:
        data = _load(path)
        if not any(c['id'] == cid for c in data['categories']):
            raise FileNotFoundError(cid)
        data['categories'] = [c for c in data['categories'] if c['id'] != cid]
        moved = 0
        for i in data['items']:
            if i['category'] == cid:
                i['category'] = 'new'
                moved += 1
        _save(path, data)
    return moved


def practiced(iid, known, folder=None):
    """A flashcard was answered: known (one box up, to 5), or not yet (back to box 0)."""
    if not ID_RE.match(iid) or not isinstance(known, bool):
        raise ValueError('bad answer')
    path = _file(folder)
    with _lock:
        data = _load(path)
        item = next((i for i in data['items'] if i.get('id') == iid), None)
        if not item:
            raise FileNotFoundError(iid)
        item['seen'] = item.get('seen', 0) + 1
        item['right'] = item.get('right', 0) + (1 if known else 0)
        item['box'] = min(5, item.get('box', 0) + 1) if known else 0
        item['last'] = int(time.time())
        _save(path, data)
    return item


def remove(iid, folder=None):
    if not ID_RE.match(iid):
        raise ValueError('bad id')
    path = _file(folder)
    with _lock:
        data = _load(path)
        rest = [i for i in data['items'] if i.get('id') != iid]
        if len(rest) == len(data['items']):
            raise FileNotFoundError(iid)
        data['items'] = rest
        _save(path, data)

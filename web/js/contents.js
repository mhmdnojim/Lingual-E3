// The Contents tab of the page list: the books of the level (the student book, the workbook …),
// each opening to its lessons or chapters (and their pages); a click goes to the page where the
// lesson starts. A disc book's lessons come from the disc (web/lessons.json). The lessons of a
// book made here are found by the app from the headings at the top of its pages (server:
// library.detect_contents), and the owner can correct them ("Check the list").
import { el } from './util.js';
import { openDialog, closeDialog } from './media.js';

async function api(method, url, body) {
  const r = await fetch(url, {
    method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).catch(() => null);
  if (!r) throw new Error('The app could not reach its server.');
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
  return d;
}

/** "4-7, 132" → [4, 5, 6, 7, 132] */
export function pageList(text) {
  const out = [];
  for (const part of String(text || '').split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]), b = Number(m[2] || m[1]);
    for (let n = a; n <= b && n - a < 400; n++) out.push(n);
  }
  return out;
}

/**
 * The contents of a book as groups: [{ name, items: [{ title, page, pages: [n …] }] }], and whether
 * the owner's list is saved (false: found by the app, to be checked).
 */
export async function contentsOf(book) {
  if (Array.isArray(book.lessons) && book.lessons.length) {
    const groups = new Map();
    for (const l of book.lessons) {
      const pages = pageList(l.pages);
      if (!pages.length) continue;
      if (!groups.has(l.unit || '')) groups.set(l.unit || '', []);
      groups.get(l.unit || '').push({ title: `${l.id} ${l.title}`.trim(), page: pages[0], pages });
    }
    return { groups: [...groups].map(([name, items]) => ({ name, items })), saved: true, own: false };
  }
  if (!book.library) return { groups: [], saved: true, own: false };
  const found = await api('GET', `/api/books/${encodeURIComponent(book.id)}/contents`).catch(() => ({ items: [], saved: true }));
  const numbers = book.pages.map((p) => p.n);
  const items = (found.items || []).map((it, i, all) => {
    const to = i + 1 < all.length ? all[i + 1].page : Infinity;
    return { title: it.title, page: it.page, pages: numbers.filter((n) => n >= it.page && n < Math.max(to, it.page + 1)).slice(0, 30) };
  });
  return { groups: items.length ? [{ name: '', items }] : [], saved: found.saved, own: true };
}

/** What looks wrong in the list of lines {title, page}: [text or '' for each line]. */
export function doubts(lines, numbers) {
  const known = new Set(numbers);
  const seen = new Set();
  let before = -Infinity;
  return lines.map((l) => {
    const page = Number(l.page);
    let why = '';
    if (!String(l.title || '').trim()) why = 'It has no name.';
    else if (!Number.isInteger(page) || !known.has(page)) why = 'This book has no such page.';
    else if (seen.has(page)) why = 'Another line starts on this page.';
    else if (page < before) why = 'It starts before the line above: is the order right?';
    if (Number.isInteger(page)) { seen.add(page); before = Math.max(before, page); }
    return why;
  });
}

const sign = (open) => (open ? '−' : '+');

export class Contents {
  constructor(app, box) {
    this.app = app;
    this.box = box;
    this.open = new Set();   // the books and groups shown open
    this.data = new Map();   // book id → { book, contents }
  }

  /** The books of the level this book is in (the student book, the workbook …): the book itself alone when it has none. */
  siblings(book) {
    const same = (this.app.discList || []).filter((b) => b.branch && book.branch && JSON.stringify(b.branch) === JSON.stringify(book.branch));
    return same.some((b) => b.id === book.id) ? same : [{ id: book.id, title: book.type || book.title, cover: book.cover, branch: book.branch }];
  }

  async show() {
    const book = this.app.book;
    if (!book) return;
    if (this.box.dataset.book !== book.id) { this.open = new Set([book.id]); this.box.dataset.book = book.id; }
    this.data.delete(book.id);
    this.render();
  }

  async load(id) {
    if (this.data.has(id)) return this.data.get(id);
    const full = id === this.app.book?.id ? this.app.book : await this.app.loadBook(id);
    const entry = full ? { book: full, contents: await contentsOf(full) } : { book: null, contents: { groups: [], saved: true, own: false } };
    this.data.set(id, entry);
    return entry;
  }

  render() {
    const book = this.app.book;
    if (!book) return;
    this.box.replaceChildren(...this.siblings(book).map((b) => this.card(b, b.id === book.id)));
    for (const id of this.open) this.fill(id);
  }

  card(b, current) {
    const open = this.open.has(b.id);
    const head = el('button', { class: `ct-head${current ? ' current' : ''}`, type: 'button', 'aria-expanded': String(open), 'aria-controls': `ct-${b.id}`,
      title: open ? 'Hide its contents' : 'Show its contents' },
      el('span', { class: 'ct-sign', 'aria-hidden': 'true' }, sign(open)),
      b.cover ? el('img', { class: 'ct-cover', alt: '', src: b.cover, loading: 'lazy' }) : null,
      el('span', { class: 'ct-name' }, el('b', {}, b.title || b.type || 'Book'), b.author && b.author !== b.title ? el('small', {}, b.author) : null));
    head.addEventListener('click', () => {
      if (this.open.has(b.id)) this.open.delete(b.id); else this.open.add(b.id);
      this.render();
    });
    const body = el('div', { class: 'ct-body', id: `ct-${b.id}`, dataset: { id: b.id }, hidden: !open });
    return el('section', { class: 'ct-book' }, head, body);
  }

  async fill(id) {
    const body = this.box.querySelector(`.ct-body[data-id="${CSS.escape(id)}"]`);
    if (!body) return;
    body.replaceChildren(el('p', { class: 'hint' }, 'Loading…'));
    const { book, contents } = await this.load(id);
    if (!body.isConnected) return;
    if (!book) { body.replaceChildren(el('p', { class: 'hint' }, 'This book could not be opened.')); return; }
    const parts = [];
    if (!contents.groups.length) {
      parts.push(el('p', { class: 'hint' }, contents.own
        ? 'No lessons or chapters were found in this book. Add them yourself with “Check the list”.'
        : 'This book has no list of lessons.'));
    }
    for (const g of contents.groups) parts.push(this.group(book, g));
    if (contents.own && book.canEdit) {
      parts.push(el('p', { class: 'hint' }, contents.saved ? 'This is your list.' : 'The app made this list from the headings on the pages. It can be wrong: check it.'));
      parts.push(el('button', { class: 'btn small', type: 'button', onclick: () => this.edit(book, contents) }, 'Check the list…'));
    }
    body.replaceChildren(...parts);
  }

  group(book, g) {
    const key = `${book.id}|${g.name}`;
    const lessons = el('ul', { class: 'ct-items' }, ...g.items.map((it) => el('li', {},
      el('button', { class: 'ct-item', type: 'button', title: `Go to page ${it.page}`, onclick: () => this.go(book, it.page) },
        el('span', {}, it.title), el('small', {}, `p. ${it.page}`)))));
    if (!g.name) return lessons;
    const pages = [...new Set(g.items.flatMap((it) => it.pages))];
    const thumbs = el('div', { class: 'ct-thumbs' }, ...pages.slice(0, 40).map((n) => {
      const p = book.pages.find((x) => x.n === n);
      return p ? el('button', { class: 'ct-thumb', type: 'button', title: `Page ${n}`, onclick: () => this.go(book, n) },
        el('img', { alt: '', src: p.thumb, loading: 'lazy' }), n) : null;
    }));
    const open = this.open.has(key);
    const head = el('button', { class: 'ct-group', type: 'button', 'aria-expanded': String(open) }, el('span', { class: 'ct-sign', 'aria-hidden': 'true' }, sign(open)), g.name);
    const body = el('div', { class: 'ct-group-body', hidden: !open }, lessons, thumbs);
    head.addEventListener('click', () => {
      const now = body.hidden;
      body.hidden = !now;
      head.setAttribute('aria-expanded', String(now));
      head.firstChild.textContent = sign(now);
      if (now) this.open.add(key); else this.open.delete(key);
    });
    return el('div', { class: 'ct-group-wrap' }, head, body);
  }

  go(book, page) {
    this.app.go(book.id, page);
    if (innerWidth < 980) this.app.setDrawer(false);
  }

  /** The owner checks the list: names, pages, order; the app says what looks wrong. */
  edit(book, contents) {
    const lines = contents.groups.flatMap((g) => g.items).map((it) => ({ title: it.title, page: it.page }));
    const numbers = book.pages.map((p) => p.n);
    const list = el('div', { class: 'ct-edit-list' });
    const msg = el('p', { class: 'form-msg', role: 'alert' });
    const draw = () => {
      const why = doubts(lines, numbers);
      list.replaceChildren(...lines.map((l, i) => {
        const title = el('input', { type: 'text', value: l.title, 'aria-label': `Name of line ${i + 1}`, maxlength: 120 });
        const page = el('input', { type: 'number', value: l.page, min: 1, 'aria-label': `First page of line ${i + 1}`, class: 'ct-page-input' });
        title.addEventListener('input', () => { l.title = title.value; });
        page.addEventListener('change', () => { l.page = Number(page.value); draw(); });
        const move = (d) => () => { const j = i + d; if (j < 0 || j >= lines.length) return; [lines[i], lines[j]] = [lines[j], lines[i]]; draw(); };
        return el('div', { class: `ct-edit-row${why[i] ? ' doubt' : ''}` },
          el('div', { class: 'ct-edit-fields' }, title, el('span', {}, 'page'), page,
            el('button', { class: 'btn small', type: 'button', 'aria-label': 'Move up', title: 'Move up', disabled: i === 0, onclick: move(-1) }, '↑'),
            el('button', { class: 'btn small', type: 'button', 'aria-label': 'Move down', title: 'Move down', disabled: i === lines.length - 1, onclick: move(1) }, '↓'),
            el('button', { class: 'btn small', type: 'button', 'aria-label': 'Delete this line', title: 'Delete this line', onclick: () => { lines.splice(i, 1); draw(); } }, '×')),
          why[i] ? el('small', { class: 'ct-doubt' }, `Check: ${why[i]}`) : null);
      }));
      const count = why.filter(Boolean).length;
      msg.textContent = count ? `${count} line${count === 1 ? '' : 's'} to check (marked in red).` : '';
    };
    const sorted = () => { lines.sort((a, b) => Number(a.page) - Number(b.page)); draw(); };
    const save = el('button', { class: 'btn primary', type: 'submit' }, 'Save the list');
    const form = el('form', { class: 'lib-form ct-edit' },
      el('p', {}, 'Each line is a lesson or a chapter and the page where it starts. Change a name or a page, move a line, delete a wrong one, or add one.'),
      list,
      el('div', { class: 'form-buttons' },
        el('button', { class: 'btn', type: 'button', onclick: () => {
          const here = Number(this.app.book?.pages?.[this.app.idx]?.n) || numbers[0];
          lines.push({ title: 'New lesson', page: here }); draw();
        } }, 'Add a line for the page I am on'),
        el('button', { class: 'btn', type: 'button', onclick: sorted }, 'Sort by page'),
        el('button', { class: 'btn', type: 'button', onclick: async () => {
          if (!window.confirm('Forget your list and let the app find the lessons again?')) return;
          try { await api('PUT', `/api/books/${book.id}/contents`, { detect: true }); this.data.delete(book.id); closeDialog(); this.show(); } catch (e) { msg.textContent = e.message; }
        } }, 'Find them again')),
      msg,
      el('div', { class: 'form-buttons' }, el('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'Cancel'), save));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.textContent = '';
      const bad = doubts(lines, numbers).filter(Boolean).length;
      if (bad && !window.confirm(`${bad} line${bad === 1 ? '' : 's'} may be wrong. Save the list anyway?`)) return;
      try {
        await api('PUT', `/api/books/${book.id}/contents`, { items: lines.map((l) => ({ title: l.title, page: Number(l.page) })) });
        this.data.delete(book.id);
        closeDialog();
        this.show();
      } catch (err) { msg.textContent = err.message; }
    });
    openDialog('Contents of the book', form);
    draw();
  }
}

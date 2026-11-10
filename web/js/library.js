// Lingua Books: the library (the home screen), adding a book (a text, a PDF or photos of pages),
// a book's settings and sharing it with everyone, reports, accounts, and the admin page.
// Everything is kept by the server (web/library.py, web/accounts.py).
import { $, $$, el, icon, store, toast } from './util.js';
import { openDialog as showDialog, closeDialog } from './media.js';
import { designEditor, framed } from './designs.js';
import { speechDialog } from './transcription.js';
import { requestAILayout } from './layout-ai.js';
import { usersAdmin } from './admin-users.js';

/** The library's dialogs (adding a book, settings, names, accounts …) stay open when the page outside them is clicked. */
const openDialog = (title, body) => showDialog(title, body, null, { keep: true });

const KIND = { text: 'Text', pdf: 'PDF', images: 'Photos', disc: 'From the disc' };
// Adding a PDF or photos: the languages of the pages (ocr.LANGUAGES in web/ocr.py: the server says
// which ones OCR reads here), is there pinyin on Chinese pages, how the words of a sample page were found.
const LANGUAGES = [['en', 'English'], ['zh-Hans', 'Chinese (Simplified)'], ['zh-Hant', 'Chinese (Traditional)'], ['es', 'Spanish'],
  ['fr', 'French'], ['de', 'German'], ['ja', 'Japanese'], ['ko', 'Korean'], ['ar', 'Arabic']];
const PINYIN = [['none', 'No pinyin'], ['some', 'Some words or lines in pinyin'], ['lines', 'Pinyin over (or under) every line of characters']];
const HOW = { pdf: 'words from the PDF', hidden: 'a scan: the PDF’s hidden text (made by OCR)', scan: 'a scan: read with OCR', broken: 'the PDF’s text was broken: read with OCR',
  ocr: 'read with OCR', photo: 'read with OCR' };

async function api(method, url, body) {
  const r = await fetch(url, {
    method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).catch(() => null);
  if (!r) throw new Error('The app could not reach its server.');
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || `Error ${r.status}`), { status: r.status, account: d.account });
  return d;
}

/**
 * A photo as the server takes it (JPEG, PNG or WebP): another kind this browser can show (an
 * iPhone's HEIC from the Files app, a BMP …) drawn into a JPEG, at most 4000 px (an iPhone draws
 * nothing bigger). One it cannot show goes as it is: the server says what to do.
 */
export async function serverPhoto(file) {
  if (!file || /^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, 4000 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = el('canvas', { width: Math.round(img.naturalWidth * k), height: Math.round(img.naturalHeight * k) });
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const jpeg = await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', 0.92));
    return jpeg ? new File([jpeg], `${file.name.replace(/\.[^.]+$/, '')}.jpg`, { type: 'image/jpeg' }) : file;
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Send one file (the body as it is) with progress; resolves when the server has it. */
function upload(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onload = () => {
      let d = {};
      try { d = JSON.parse(x.responseText); } catch { /* not JSON */ }
      if (x.status >= 200 && x.status < 300) resolve(d);
      else reject(new Error(d.error || `Upload failed (${x.status}).`));
    };
    x.onerror = () => reject(new Error('The upload was cut off. Check the connection and try again.'));
    x.send(file);
  });
}

/**
 * What is wrong with the size of the files of a new book, or '' (limits: of this user, from
 * /api/me: an admin's PDF can be bigger). Photos the server takes as they are (JPEG, PNG, WebP);
 * others are made into a smaller JPEG first (serverPhoto).
 */
function tooBig(kind, files, limits = {}) {
  const mb = (f) => (f.size / 2 ** 20).toFixed(f.size < 10 * 2 ** 20 ? 1 : 0);
  if (kind === 'pdf' && files[0].size > (limits.pdf_mb || 60) * 2 ** 20) {
    return `This PDF is ${mb(files[0])} MB: at most ${limits.pdf_mb || 60} MB can be added. Make the PDF smaller `
      + '(for example “Reduce file size” in a PDF program), or split it into parts and add each as a book.';
  }
  if (kind === 'word' && files[0].size > (limits.pdf_mb || 60) * 2 ** 20) {
    return `This Word file is ${mb(files[0])} MB: at most ${limits.pdf_mb || 60} MB can be added. Make its pictures smaller `
      + '(in Word: File → Compress Pictures), or split it into parts and add each as a book.';
  }
  const photo = kind === 'images' && files.find((f) => /^image\/(jpeg|png|webp)$/.test(f.type) && f.size > (limits.image_mb || 15) * 2 ** 20);
  return photo ? `The photo “${photo.name}” is ${mb(photo)} MB: at most ${limits.image_mb || 15} MB each. Take it again smaller, or make it smaller.` : '';
}

/** The next step of adding a book in the dialog (opened if it was closed), without closing it in between. */
function step(title, node) {
  if (!$('#md-body').closest('dialog').open) { openDialog(title, node); return; }
  $('#md-title').textContent = title;
  $('#md-body').replaceChildren(node);
}

const when = (t) => new Date(t * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

// ---------------------------------------------------------------- Branches: folders in folders (admins make them)

const naturally = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }); // Level 2 before Level 10
const DRAG = 'application/x-lingua-item'; // (what is dragged is a branch or book of the library, not a file from elsewhere)
/** The phone's layout (js/device.js: automatic or chosen): the tree comes over the books, when asked. */
const isPhone = () => (window.linguaDevice ? window.linguaDevice.isPhone() : matchMedia('(max-width: 700px)').matches);

/** The address of a branch of the library: #/@/<main branch>/<sub-branch>/…, or #/ (the top). */
const folderHash = (path) => (path.length ? `#/@/${path.map(encodeURIComponent).join('/')}` : '#/');

function folderOfHash() {
  const m = location.hash.match(/^#\/@\/(.+)$/);
  try { return m ? m[1].split('/').filter(Boolean).map(decodeURIComponent) : []; } catch { return []; }
}

/**
 * The branches (from the server: [{id, parent, name, empty}]) with these books in them: the top,
 * {id: null, path: [], folders: [{id, name, path, up, folders, books, empty}], books, byId}. A book
 * of a branch there is not (any more) is at the top.
 */
function bookTree(books, branches) {
  const root = { id: null, name: '', path: [], up: null, folders: [], books: [] };
  const byId = new Map(branches.map((b) => [b.id, { ...b, folders: [], books: [] }]));
  for (const n of [...byId.values()].sort((a, b) => naturally(a.name, b.name))) {
    n.up = byId.get(n.parent) || root;
    n.up.folders.push(n);
  }
  const walk = (node) => node.folders.forEach((f) => { f.path = [...node.path, f.name]; walk(f); });
  walk(root);
  for (const b of books) {
    const n = byId.get(b.branch);
    (n?.path ? n : root).books.push(b);
  }
  return Object.assign(root, { byId });
}

/** Every book of a branch, also those in its branches. */
const booksIn = (node) => [...node.folders.flatMap(booksIn), ...node.books];

/** The books whose covers show a branch: the first of each branch in it (of one branch: its own), then its own. */
function coverBooks(node) {
  const subs = node.folders.map(coverBooks);
  return [...(subs.length === 1 ? subs[0] : subs.map((b) => b[0])), ...node.books].filter(Boolean);
}

/** Only the branches with books (admin: also those with nothing in them yet, to fill them). */
function prune(node, admin) {
  const fresh = (n) => n.empty && n.folders.every(fresh); // (no book or level in it, in any tab)
  const keep = (n) => booksIn(n).length > 0 || (admin && fresh(n));
  const cut = (n) => { n.folders = n.folders.filter(keep); n.folders.forEach(cut); };
  cut(node);
  return node;
}

/** Every branch, from the top down (each followed by those in it); not: a branch left out, with those in it. */
function allBranches(root, not = null) {
  const out = [];
  const walk = (n) => n.folders.forEach((f) => { if (f.id !== not) { out.push(f); walk(f); } });
  walk(root);
  return out;
}

/** A book's title without the names of the branches it is shown in ("Level 1 Student Book" in Level 1: "Student Book"). */
function shortTitle(title, path) {
  let t = title;
  for (const name of [...path].reverse()) if (t.startsWith(`${name} `) && t.length > name.length + 1) t = t.slice(name.length + 1);
  return t;
}

export class Library {
  constructor(app) {
    this.app = app;
    this.scope = store.get('libScope', '');
    this.folders = store.get('libFolders', {}); // the branch open last, in each tab: [main branch, sub-branch, …]
    this.branchList = null; // the branches of the library (from the server)
    this.clip = null; // what was cut or copied, to paste: {item, cut}
    this.cardItems = new WeakMap(); // card (or branch of the tree) -> its branch or book (the keys act on the one with the focus)
    const open = store.get('libTreeOpen', null);
    this.treeOpen = open && new Set(open); // the branches open in the tree (null: the main branches, the first time)
    this.treeWanted = store.get('libTree', true); // the tree on the left (wide screens; on a phone it comes when asked)
    this.treeW = store.get('libTreeW', 270);
    this.drag = null; // the branch or book being dragged
    this.query = '';
    this.gen = 0;
    this.bind();
  }

  get me() { return this.app.me; }
  get user() { return this.me.user; }
  get onWebsite() { return this.me.mode === 'public'; }

  bind() {
    $$('#library [role=tab]').forEach((t) => t.addEventListener('click', () => this.setScope(t.dataset.scope)));
    let timer;
    $('#lib-q').addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { this.query = $('#lib-q').value.trim(); this.render(); }, 250);
    });
    $('#lib-add').addEventListener('click', () => this.addDialog());
    document.addEventListener('keydown', (e) => this.keys(e));
    $('#lib-tree-btn').addEventListener('click', () => this.toggleTree());
    $('#lib-tree').addEventListener('keydown', (e) => this.treeKeys(e));
    $('#lib-main').addEventListener('click', (e) => { // (the shade over the books, on a phone)
      if (e.target === e.currentTarget && isPhone()) this.toggleTree(false);
    });
    window.linguaDevice?.onChange(() => this.treeState());
    this.treeState();
    this.bindSplit();
    $('#lib-migrate').addEventListener('click', async () => {
      if (!this.user) { this.accountDialog('signup', 'Log in to import an old app into your library.'); return; }
      try {
        const { MigrationAssistant } = await import('./migration.js');
        this.migration ??= new MigrationAssistant(this.app, this);
        this.migration.open();
      } catch (err) { toast(`Could not open the importer: ${err.message}`); }
    });
    $('#brand').addEventListener('click', () => this.app.goHome());
    $('#book-title').addEventListener('click', () => this.app.goHome());
  }

  // ---------------------------------------------------------------- The home screen

  get isOpen() { return !$('#library').hidden; }

  open() {
    this.app.reader.stop();
    this.app.audio.pause();
    if (!$('#drawer').hidden) this.app.setDrawer(false); // (the page list belongs to a book)
    document.body.classList.add('lib-open');
    $('#library').hidden = false;
    document.title = 'Lingua Books';
    this.render();
  }

  close() {
    document.body.classList.remove('lib-open');
    $('#library').hidden = true;
    $('#library').classList.remove('tree-sheet');
    clearTimeout(this.poll);
  }

  setScope(scope) {
    this.scope = scope;
    store.set('libScope', scope);
    history.replaceState(null, '', folderHash(this.folders[scope] || [])); // (in the folder it was in)
    this.render();
  }

  /** The address of the library in the folder it was in last. */
  homeHash() { return folderHash(this.folders[this.scope] || []); }

  openFolder(path) {
    const hash = folderHash(path);
    if (location.hash !== hash) history.pushState(null, '', hash); // (Back: the folder before)
    this.render();
  }

  scopes() {
    const out = [['public', 'Public library'], ['mine', 'My books']];
    if (this.me.disc) out.push(['local', 'On this computer']);
    if (this.user?.admin && this.onWebsite) out.push(['admin', 'Admin']);
    return out;
  }

  async render() {
    const gen = ++this.gen;
    this.closeMenu();
    clearTimeout(this.poll);
    const scopes = this.scopes();
    if (!scopes.some(([s]) => s === this.scope)) this.scope = this.me.disc ? 'local' : this.user && this.onWebsite ? 'mine' : 'public';
    $$('#library [role=tab]').forEach((t) => {
      t.hidden = !scopes.some(([s]) => s === t.dataset.scope);
      t.setAttribute('aria-selected', String(t.dataset.scope === this.scope));
    });
    this.renderAccount();
    const body = $('#lib-body');
    if (this.scope === 'admin') { this.renderTree(null); this.renderAdmin(gen); return; }
    if (this.scope === 'mine' && !this.user) {
      this.renderTree(null);
      body.replaceChildren(el('div', { class: 'lib-empty' },
        el('h3', {}, 'Your own books'),
        el('p', {}, 'Make any text, PDF or photo of a page clickable, read aloud and translated. Log in or create a free account to add your books.'),
        el('div', { class: 'lib-actions' },
          el('button', { class: 'btn primary', onclick: () => this.accountDialog('signup') }, 'Create an account'),
          el('button', { class: 'btn', onclick: () => this.accountDialog('login') }, 'Log in'))));
      return;
    }
    let books, list;
    try {
      [books, list] = await Promise.all([api('GET', `/api/books?scope=${this.scope}&q=${encodeURIComponent(this.query)}`),
        api('GET', '/api/branches')]);
    } catch (e) {
      if (gen === this.gen) body.replaceChildren(this.me.subscription?.required
        && (!this.user || !this.me.subscription.active)
        ? this.subscriptionEmptyState(e.message) : el('div', { class: 'lib-empty' }, e.message));
      return;
    }
    if (gen !== this.gen) return;
    this.branchList = list;
    const where = bookTree([], list).byId;
    this.pathOf = (b) => where.get(b.branch)?.path || []; // (the names of a book's branch, from the top)
    const q = this.query.toLowerCase();
    if (q && this.scope === 'local') { // (the server finds the others)
      books = books.filter((b) => [b.title, b.author, ...this.pathOf(b)].join(' ').toLowerCase().includes(q));
    }
    this.books = books;
    const admin = !!this.user?.admin;
    const root = prune(bookTree(books, list), admin && !q);
    const keep = q && this.treeScope === this.scope; // (searching: the tree as it was, to go back to a branch)
    if (!books.length && (q || !admin)) { // (admins: the branches all the same, to make and fill them)
      body.replaceChildren(this.emptyState());
      if (!keep) this.renderTree(null);
      return;
    }
    // What was found: every book, wherever it is; else the folder of the address.
    body.replaceChildren(...(q ? [el('div', { class: 'lib-grid' }, ...books.map((b) => this.card(b, [])))] : this.folderView(root)));
    if (!keep) this.renderTree(root);
    // Books whose pages are being made: look again in a moment.
    if (books.some((b) => b.status === 'working')) this.poll = setTimeout(() => { if (this.isOpen && gen === this.gen) this.render(); }, 2500);
  }

  emptyState() {
    if (this.query) return el('div', { class: 'lib-empty' }, `No book matches “${this.query}”.`);
    if (this.me.subscription?.required && !this.me.subscription.active && !this.user?.admin)
      return this.subscriptionEmptyState();
    if (this.scope === 'public') {
      return el('div', { class: 'lib-empty' }, el('h3', {}, 'No public books yet'),
        el('p', {}, 'Books that people share with everyone appear here.'),
        this.user ? el('button', { class: 'btn primary', onclick: () => this.addDialog() }, 'Add the first one') : null);
    }
    return el('div', { class: 'lib-empty' }, el('h3', {}, 'No books yet'),
      el('p', {}, 'Add a text, a PDF, or photos of book pages. Every sentence becomes clickable: hear it, translate it, repeat it.'),
      el('button', { class: 'btn primary', html: `${icon('plus')}Add a book`, onclick: () => this.addDialog() }));
  }

  subscriptionEmptyState(message = '') {
    return el('div', { class: 'lib-empty' },
      el('h3', {}, 'An access code is needed'),
      el('p', {}, message || 'Create an account or log in, then enter the code from your administrator.'),
      this.user
        ? el('button', { class: 'btn primary', onclick: () => this.redeemDialog() }, 'Redeem access code')
        : el('div', { class: 'lib-actions' },
          el('button', { class: 'btn primary', onclick: () => this.accountDialog('signup') }, 'Create an account'),
          el('button', { class: 'btn', onclick: () => this.accountDialog('login') }, 'Log in')));
  }

  /** The branch of the address (or the nearest there is) in the tree: its branches, then its own books; and the way back up. */
  folderView(root) {
    const admin = !!this.user?.admin;
    let node = root;
    for (const name of folderOfHash()) {
      const next = node.folders.find((f) => f.name === name);
      if (!next) break;
      node = next;
    }
    if (location.hash !== folderHash(node.path)) history.replaceState(null, '', folderHash(node.path));
    this.folders[this.scope] = node.path;
    store.set('libFolders', this.folders);
    this.here = node; // (a book added now is put in it)
    const items = [...node.folders.map((f) => this.folderCard(f, admin)), ...node.books.map((b) => this.card(b, node.path))];
    return [...(node.path.length || admin || this.clip ? [this.crumbs(node, admin)] : []),
      items.length ? el('div', { class: 'lib-grid' }, ...items) : node.id === null ? this.emptyState()
        : el('div', { class: 'lib-empty' }, el('h3', {}, 'Nothing in this branch yet'),
          el('p', {}, 'Paste books or branches here (cut or copy them first: ⋮ on a book or branch), add a book, or make a sub-branch.'))];
  }

  /** A branch: the covers of its first books (of each branch in it), and how much is in it. */
  folderCard(f, admin) {
    const books = booksIn(f);
    const covers = [...new Set(coverBooks(f).filter((b) => b.status === 'ready' && b.cover).map((b) => b.cover))].slice(0, 3);
    const n = f.folders.length;
    const meta = [n ? `${n} branch${n === 1 ? '' : 'es'}` : '', books.length ? `${books.length} book${books.length === 1 ? '' : 's'}` : '']
      .filter(Boolean).join(' · ') || 'Empty';
    const open = () => this.openFolder(f.path);
    const card = this.manageable(el('article', { class: 'book-card folder-card', dataset: { folder: f.name, branch: f.id } },
      el('button', { class: `bc-cover folder-cover n${covers.length}`, 'aria-label': `Open the branch ${f.name}`, onclick: open },
        ...covers.map((src) => el('img', { src, alt: '', loading: 'lazy', draggable: 'false' })),
        el('span', { class: 'fc-mark', html: icon('folder') })),
      el('div', { class: 'bc-body' },
        el('h3', {}, el('button', { class: 'bc-title', onclick: open }, f.name)),
        el('p', { class: 'bc-meta' }, meta))), this.branchItem(f));
    this.dropTarget(card, f);
    return card;
  }

  /** Where the branch is: the tab (the top), the branches it is in; each a way back (and a place to drop things). Admins: make a branch here, change this one. */
  crumbs(node, admin) {
    const { path } = node;
    const chain = [];
    for (let n = node; n; n = n.up) chain.unshift(n); // (the top, the branches it is in, and it)
    const parts = chain.flatMap((n, i) => {
      const name = i ? n.name : this.tabName();
      if (i === chain.length - 1) return [i ? el('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '›') : null, el('span', { class: 'crumb here', 'aria-current': 'page' }, name)];
      const crumb = el('button', { class: 'crumb', onclick: () => this.openFolder(n.path) }, name);
      this.dropTarget(crumb, n);
      return [i ? el('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '›') : null, crumb];
    });
    return el('nav', { class: 'lib-crumbs', 'aria-label': 'Branches' },
      path.length ? el('button', { class: 'icon-btn small', title: 'Up one branch', 'aria-label': 'Up one branch', html: icon('left'),
        onclick: () => this.openFolder(path.slice(0, -1)) }) : null,
      ...parts,
      el('span', { class: 'crumb-tools' },
        this.clip ? el('span', { class: 'clip' },
          el('button', { class: 'btn small', html: icon('paste'), title: 'Put it in this branch (Ctrl+V)', onclick: () => this.paste() },
            `Paste “${this.clip.item.name.length > 28 ? `${this.clip.item.name.slice(0, 27)}…` : this.clip.item.name}”`),
          el('button', { class: 'icon-btn small', title: 'Forget what was cut or copied', 'aria-label': 'Forget what was cut or copied', html: icon('x'),
            onclick: () => { this.clip = null; this.render(); } })) : null,
        admin ? el('button', { class: 'btn small', html: `${icon('plus')}${path.length ? 'New sub-branch' : 'New main branch'}`,
          onclick: () => this.branchDialog(node) }) : null,
        admin && node.id !== null ? el('button', { class: 'btn small', html: icon('more'), 'aria-haspopup': 'menu',
          onclick: (e) => this.menuAt(e.currentTarget, this.branchItem(node)) }, 'This branch') : null));
  }

  /** A book. here: the branches it is shown in (its name without them; the others it is in, under it). */
  card(b, here = []) {
    const badges = [];
    if (b.kind) badges.push(el('span', { class: 'badge' }, KIND[b.kind] || b.kind));
    if (!b.disc && b.mine) badges.push(el('span', { class: `badge ${b.visibility}` }, b.visibility === 'public' ? 'Public' : 'Private'));
    if (b.hidden) badges.push(el('span', { class: 'badge warn' }, 'Hidden by an admin'));
    if (b.licenseName && b.visibility === 'public') badges.push(el('span', { class: 'badge' }, b.licenseName));
    if (b.link) badges.push(el('span', { class: 'badge', title: 'The same book as in its other branch: corrections and audio are shared' }, 'Copy'));
    let cover;
    if (b.status === 'ready' && b.cover) cover = el('img', { src: b.cover, alt: '', loading: 'lazy', draggable: 'false' }); // (dragged: the card)
    else if (b.status === 'working') cover = el('div', { class: 'cover-note' }, el('span', { class: 'spinner' }), b.job?.stage || 'Making the pages…');
    else if (b.status === 'error') cover = el('div', { class: 'cover-note err' }, b.error || 'Something went wrong.');
    else cover = el('div', { class: 'cover-note' }, b.sample ? 'Not finished: check its sample' : 'Not finished');
    const author = b.disc && here.length ? '' : b.author; // (the disc's name: what its branches say)
    const meta = [author, b.pageCount ? `${b.pageCount} page${b.pageCount === 1 ? '' : 's'}` : '', !b.mine && b.owner && !b.disc ? `shared by ${b.owner}` : '']
      .filter(Boolean).join(' · ');
    const title = shortTitle(b.title, here);
    const where = (this.pathOf?.(b) || []).filter((name) => !here.includes(name) && !title.includes(name)).join(' › ');
    return this.manageable(el('article', { class: 'book-card', dataset: { id: b.id, ...(b.link ? { link: b.link } : {}) } },
      el('button', { class: 'bc-cover', 'aria-label': `Open ${b.title}`, onclick: () => this.openBook(b) }, cover),
      el('div', { class: 'bc-body' },
        el('h3', {}, el('button', { class: 'bc-title', onclick: () => this.openBook(b) }, title)),
        where ? el('p', { class: 'bc-where', html: icon('folder') }, where) : null,
        meta ? el('p', { class: 'bc-meta' }, meta) : null,
        el('p', { class: 'bc-badges' }, ...badges))), this.bookItem(b));
  }

  // ---------------------------------------------------------------- The tree of branches (on the left)

  tabName() { return this.scopes().find(([s]) => s === this.scope)?.[1] || 'All books'; }

  /**
   * The branches as a tree on the left, like the folders of a file manager: a branch clicked is
   * opened (on the right, what is in it) and unfolded in the tree (or folded, if it was unfolded),
   * › only unfolds or folds it, a right-click gives its menu, and books or branches dragged onto it
   * go into it. The open branch is marked, and the branches it is in are unfolded. root: the tree
   * of the books shown (null: no tree).
   */
  renderTree(root) {
    const tree = $('#lib-tree');
    this.root = root;
    const show = !!root && (root.folders.length > 0 || !!this.user?.admin);
    tree.hidden = $('#lib-tree-btn').hidden = !show;
    this.treeScope = show ? this.scope : null;
    if (!show) { tree.replaceChildren(); return; }
    const here = this.here?.id ?? null;
    this.treeOpen ??= new Set(root.folders.map((f) => f.id)); // (the first time: the main branches open)
    const moved = this.treeAt !== here;
    if (moved) { // (another branch open: it and the branches it is in open in the tree)
      this.treeAt = here;
      for (let n = root.byId.get(here); n?.id != null; n = n.up) if (n.id !== this.treeClicked) this.treeOpen.add(n.id);
      store.set('libTreeOpen', [...this.treeOpen]);
    }
    this.treeClicked = null;
    const was = tree.contains(document.activeElement) ? document.activeElement.closest('[role=treeitem]')?.dataset.branch : undefined;
    const top = tree.scrollTop;
    const item = (n, level) => {
      const kids = n.folders, name = n.id === null ? this.tabName() : n.name, books = booksIn(n).length;
      const li = el('li', { role: 'treeitem', 'aria-level': level, 'aria-selected': String(n.id === here), tabindex: n.id === here ? 0 : -1,
        'aria-expanded': kids.length ? String(n.id === null || this.treeOpen.has(n.id)) : null,
        'aria-label': books ? `${name}, ${books} book${books === 1 ? '' : 's'}` : name, dataset: { branch: n.id ?? '' } });
      const twisty = kids.length && n.id !== null; // (the top is always open)
      const row = el('div', { class: 'tree-row', style: `--depth: ${level - 1}`, title: n.id === null ? name : n.path.join(' › '), onclick: () => this.treeGo(n, li) },
        el('span', { class: 'tree-twisty', html: twisty ? icon('right') : '',
          onclick: twisty ? (e) => { e.stopPropagation(); this.treeExpand(li, li.getAttribute('aria-expanded') !== 'true'); } : null }),
        el('span', { class: 'tree-icon', html: icon(n.id === null ? 'books' : 'folder') }),
        el('span', { class: 'tree-name' }, name),
        books ? el('span', { class: 'tree-n', 'aria-hidden': 'true' }, books) : null);
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.treeFocus(li);
        this.menuFrom = li;
        this.openMenu(this.treeMenu(n), e.clientX, e.clientY);
      });
      if (n.id !== null) {
        const it = this.branchItem(n);
        this.cardItems.set(li, it); // (F2, Ctrl+X, Ctrl+C on it)
        if (this.mayManage(it)) this.draggable(row, it);
        if (this.clip?.cut && this.same(this.clip.item, it)) row.classList.add('is-cut');
      }
      this.dropTarget(row, n, li);
      li.append(row);
      if (kids.length) li.append(el('ul', { role: 'group' }, ...kids.map((k) => item(k, level + 1))));
      return li;
    };
    tree.replaceChildren(el('ul', { role: 'tree', 'aria-label': 'Branches' }, item(root, 1)));
    tree.scrollTop = top;
    const at = tree.querySelector('[role=treeitem][tabindex="0"]') || tree.querySelector('[role=treeitem]');
    at.tabIndex = 0;
    if (moved) at.firstChild.scrollIntoView({ block: 'nearest' });
    if (was !== undefined) {
      const again = tree.querySelector(`[role=treeitem][data-branch="${was}"]`);
      if (again && again !== at) { at.tabIndex = -1; again.tabIndex = 0; }
      (again || at).focus();
    }
  }

  /** The branch of a place in the tree (the top: the root). */
  treeNode(li) { return li.dataset.branch ? this.root?.byId.get(Number(li.dataset.branch)) : this.root; }

  /**
   * A branch chosen in the tree: open it (searching: the search ends). Clicked (li): also unfolded in
   * the tree, or folded if it was unfolded. On a phone the tree goes away (unfolded or folded: it stays).
   */
  treeGo(n, li = null) {
    const unfolds = !!li && n.id !== null && n.folders.length > 0;
    if (unfolds) this.treeExpand(li, li.getAttribute('aria-expanded') !== 'true');
    if (isPhone() && !unfolds) this.toggleTree(false);
    if (n.id === (this.here?.id ?? null) && !this.query) return; // (open already)
    if (this.query) { this.query = ''; $('#lib-q').value = ''; }
    if (unfolds) this.treeClicked = n.id; // (folded or not as it was clicked, not unfolded because it is open)
    this.openFolder(n.path);
  }

  /** The menu of a branch in the tree: the one of its card (who may change it), else open it, paste into it. */
  treeMenu(n) {
    if (n.id !== null && this.mayManage(this.branchItem(n))) return this.menuFor(this.branchItem(n));
    return [['Open', n.id === null ? 'books' : 'folder', () => this.treeGo(n)],
      this.clip ? ['Paste here', 'paste', () => this.paste(n), 'Ctrl+V'] : null,
      n.id === null && this.user?.admin ? ['New main branch…', 'plus', () => this.branchDialog(null)] : null].filter(Boolean);
  }

  /** The keys of a tree: ↑ ↓ Home End to go, → to open (then into it), ← to close (then up), Enter to show it; Esc (phone) closes. */
  treeKeys(e) {
    const li = e.target.closest('[role=treeitem]');
    if (!li || e.ctrlKey || e.metaKey || e.altKey) return;
    const shown = [...$('#lib-tree').querySelectorAll('[role=treeitem]')].filter((x) => !x.parentElement.closest('[aria-expanded="false"]'));
    const i = shown.indexOf(li), open = li.getAttribute('aria-expanded');
    const go = (x) => { e.preventDefault(); if (x) this.treeFocus(x); };
    if (e.key === 'ArrowDown') go(shown[i + 1]);
    else if (e.key === 'ArrowUp') go(shown[i - 1]);
    else if (e.key === 'Home') go(shown[0]);
    else if (e.key === 'End') go(shown.at(-1));
    else if (e.key === 'ArrowRight') { if (open === 'false') { e.preventDefault(); this.treeExpand(li, true); } else go(open === 'true' ? shown[i + 1] : null); }
    else if (e.key === 'ArrowLeft') {
      if (open === 'true' && li.dataset.branch) { e.preventDefault(); this.treeExpand(li, false); } else go(li.parentElement.closest('[role=treeitem]'));
    } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.treeGo(this.treeNode(li)); }
    else if (e.key === 'Escape' && $('#library').classList.contains('tree-sheet')) { this.toggleTree(false); $('#lib-tree-btn').focus(); }
  }

  treeFocus(li) {
    $$('#lib-tree [role=treeitem][tabindex="0"]').forEach((x) => { x.tabIndex = -1; });
    li.tabIndex = 0;
    li.focus();
  }

  /** Open or close a branch in the tree (it stays so, also the next time). */
  treeExpand(li, open) {
    li.setAttribute('aria-expanded', String(open));
    const id = Number(li.dataset.branch);
    if (open) this.treeOpen.add(id); else this.treeOpen.delete(id);
    store.set('libTreeOpen', [...this.treeOpen]);
  }

  treeShown() { return isPhone() ? $('#library').classList.contains('tree-sheet') : this.treeWanted; }

  /** The tree shown or not (the button next to the tabs): on a wide screen it stays so; on a phone it comes over the books. */
  toggleTree(show = !this.treeShown()) {
    if (isPhone()) $('#library').classList.toggle('tree-sheet', show);
    else { this.treeWanted = show; store.set('libTree', show); }
    this.treeState();
    if (show && isPhone()) $('#lib-tree [role=treeitem][tabindex="0"]')?.focus();
  }

  treeState() {
    const show = this.treeShown();
    $('#library').classList.toggle('tree-closed', !this.treeWanted);
    const button = $('#lib-tree-btn');
    button.setAttribute('aria-expanded', String(show));
    button.title = show ? 'Hide the tree of branches' : 'Show the branches as a tree';
  }

  /** The line between the tree and the books: dragged (or ← →), the tree wider or narrower. */
  bindSplit() {
    const split = $('#lib-split');
    const width = (w) => {
      this.treeW = Math.round(Math.max(180, Math.min(520, w)));
      $('#library').style.setProperty('--tree-w', `${this.treeW}px`);
      split.setAttribute('aria-valuenow', this.treeW);
    };
    width(this.treeW);
    split.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const x0 = e.clientX, w0 = this.treeW, stop = new AbortController();
      split.setPointerCapture(e.pointerId);
      split.classList.add('dragging');
      const done = () => { stop.abort(); split.classList.remove('dragging'); store.set('libTreeW', this.treeW); };
      split.addEventListener('pointermove', (ev) => width(w0 + ev.clientX - x0), { signal: stop.signal });
      split.addEventListener('pointerup', done, { signal: stop.signal });
      split.addEventListener('pointercancel', done, { signal: stop.signal });
    });
    split.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      width(this.treeW + (e.key === 'ArrowRight' ? 20 : -20));
      store.set('libTreeW', this.treeW);
    });
  }

  // ---------------------------------------------------------------- Drag and drop: onto a branch (in the tree, its card, the crumbs)

  /** A card or a branch of the tree that can be dragged (by who may move it). */
  draggable(node, item) {
    node.draggable = true;
    node.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      this.drag = item;
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData(DRAG, item.name);
      e.dataTransfer.setData('text/plain', item.name);
    });
    node.addEventListener('dragend', () => this.dragEnd());
  }

  dragEnd() {
    this.drag = null;
    clearTimeout(this.dragOpen);
    $$('.drop-here').forEach((n) => n.classList.remove('drop-here'));
  }

  /**
   * A branch to drop on (to; the top: to.id null): what is dragged is moved into it, or with Ctrl
   * (Option on a Mac) a copy is put there. li: its place in the tree, opened after a moment.
   */
  dropTarget(node, to, li = null) {
    const fits = (e) => this.drag && e.dataTransfer?.types.includes(DRAG) && this.mayDrop(this.drag, to);
    node.addEventListener('dragenter', (e) => { if (fits(e)) e.preventDefault(); });
    node.addEventListener('dragover', (e) => {
      if (!fits(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = e.ctrlKey || e.altKey ? 'copy' : 'move';
      if (node.classList.contains('drop-here')) return;
      $$('.drop-here').forEach((n) => n.classList.remove('drop-here'));
      node.classList.add('drop-here');
      clearTimeout(this.dragOpen);
      if (li?.getAttribute('aria-expanded') === 'false') this.dragOpen = setTimeout(() => this.treeExpand(li, true), 700);
    });
    node.addEventListener('dragleave', (e) => {
      if (node.contains(e.relatedTarget)) return;
      node.classList.remove('drop-here');
      clearTimeout(this.dragOpen);
    });
    node.addEventListener('drop', (e) => {
      if (!fits(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const item = this.drag;
      this.dragEnd();
      const now = item.kind === 'branch' ? item.node.up?.id ?? null : item.entry.branch ?? null;
      const copy = e.ctrlKey || e.altKey;
      if (copy || now !== to.id) this.putIn(item, to.id, copy); // (moved where it is: nothing to do)
    });
  }

  /** A branch goes neither into itself nor into a branch in it. */
  mayDrop(item, to) {
    if (item.kind !== 'branch') return true;
    for (let n = to; n; n = n.up) if (n.id === item.id) return false;
    return true;
  }

  // ---------------------------------------------------------------- Like files: rename, cut, copy, paste, move

  /** A branch, or a book (or a copy of one: link), as something to rename, cut, copy, move or delete. */
  branchItem(f) { return { kind: 'branch', id: f.id, name: f.name, node: f }; }

  bookItem(b) { return { kind: 'book', id: b.id, link: b.link || null, disc: !!b.disc, name: b.title, entry: b }; }

  same(a, b) { return a.kind === b.kind && a.id === b.id && (a.kind === 'branch' || a.link === b.link); }

  /** Branches: admins. Books: who may change them (the disc's: admins). */
  mayManage(item) {
    const admin = !!this.user?.admin;
    return item.kind === 'branch' ? admin : !!item.entry.canEdit && (admin || !item.disc);
  }

  /** A card that can be renamed, cut, copied …: its ⋮ button, its menu on a right-click (or a long press), faded when cut. */
  manageable(card, item) {
    this.cardItems.set(card, item);
    if (!this.mayManage(item)) return card;
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.menuFrom = null;
      this.openMenu(this.menuFor(item), e.clientX, e.clientY);
    });
    if (this.clip?.cut && this.same(this.clip.item, item)) card.classList.add('is-cut');
    this.draggable(card, item);
    card.append(el('button', { class: 'icon-btn small bc-more', title: 'Rename, cut, copy, move, delete', 'aria-label': `More: ${item.name}`,
      'aria-haspopup': 'menu', html: icon('more'), onclick: (e) => this.menuAt(e.currentTarget, item) }));
    return card;
  }

  /** What can be done with a branch or a book: [label, icon, action, keys] (null: a line). */
  menuFor(item) {
    const f = item.node, b = item.entry;
    const own = b?.link ? (this.books || []).find((x) => x.id === b.id && !x.link) || null : b; // (a copy: its book's settings)
    const rows = [
      item.kind === 'branch' ? ['Open', 'folder', () => this.openFolder(f.path)] : ['Open', 'books', () => this.openBook(b)],
      ['Rename…', 'pencil', () => this.renameDialog(item), 'F2'],
      null,
      ['Cut', 'scissors', () => this.toClip(item, true), 'Ctrl+X'],
      ['Copy', 'copy', () => this.toClip(item, false), 'Ctrl+C'],
      ['Move to…', 'arrow', () => this.moveDialog(item)],
      item.kind === 'branch' && this.clip && !this.same(this.clip.item, item) ? ['Paste into it', 'paste', () => this.paste(f)] : null,
      null,
      ...(item.kind === 'branch' ? [['New sub-branch…', 'plus', () => this.branchDialog(f)],
        ['New parent branch…', 'merge-up', () => this.parentDialog(f)], null, ['Delete…', 'trash', () => this.deleteBranch(f)]]
        : [own && !b.disc ? ['Settings and sharing…', 'sliders', () => this.settings(own)] : null,
          b.disc && this.me.disc ? ['Scripts of its audio and video…', 'transcribe', () => this.discScripts(b)] : null, null,
          b.link ? ['Delete this copy', 'trash', () => this.removeLink(item)] : b.disc ? null : ['Delete the book…', 'trash', () => this.remove(b)]]),
    ];
    return rows.filter((r, i, all) => r || (all.slice(0, i).some(Boolean) && all.slice(i + 1).some(Boolean) && all[i - 1]));
  }

  /** The menu of an item under its button. */
  menuAt(button, item) {
    const r = button.getBoundingClientRect();
    this.menuFrom = button;
    this.openMenu(this.menuFor(item), r.right, r.bottom + 4, true);
  }

  /** A menu at x, y (fromRight: its right side there); closed by a choice, a click elsewhere or Esc. */
  openMenu(rows, x, y, fromRight = false) {
    this.closeMenu();
    const menu = el('div', { class: 'lib-menu', role: 'menu' }, ...rows.map((r) => (r
      ? el('button', { type: 'button', role: 'menuitem', html: icon(r[1]), onclick: () => { this.closeMenu(); r[2](); } },
        el('span', {}, r[0]), r[3] ? el('kbd', {}, r[3]) : null)
      : el('hr'))));
    document.body.append(menu);
    const { width, height } = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(fromRight ? x - width : x, innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, innerHeight - height - 8))}px`;
    const buttons = [...menu.querySelectorAll('button')];
    menu.addEventListener('keydown', (e) => {
      const i = buttons.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.stopPropagation(); this.closeMenu(); this.menuFrom?.focus(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        buttons[(i + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length].focus();
      }
    });
    const away = (e) => { if (!menu.contains(e.target)) this.closeMenu(); };
    document.addEventListener('pointerdown', away, true);
    this.menu = { node: menu, off: () => document.removeEventListener('pointerdown', away, true) };
    buttons[0]?.focus();
  }

  closeMenu() {
    this.menu?.off();
    this.menu?.node.remove();
    this.menu = null;
  }

  /** The keys of a file manager on the branch or book with the focus: Ctrl+X, Ctrl+C, F2; Ctrl+V pastes in the open branch (in the tree: in that one). */
  keys(e) {
    if (!this.isOpen || this.menu || this.query || $('#md-body').closest('dialog').open
      || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    const ctrl = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
    if (ctrl && key === 'v' && this.clip) {
      e.preventDefault();
      const li = e.target.closest?.('#lib-tree [role=treeitem]');
      this.paste(li ? this.treeNode(li) : this.here);
      return;
    }
    const card = e.target.closest?.('#lib-body .book-card, #lib-tree [role=treeitem]');
    const item = card && this.cardItems.get(card);
    if (!item || !this.mayManage(item)) return;
    if (ctrl && (key === 'x' || key === 'c')) { e.preventDefault(); this.toClip(item, key === 'x'); }
    else if (e.key === 'F2') { e.preventDefault(); this.renameDialog(item); }
  }

  toClip(item, cut) {
    this.clip = { item, cut };
    toast(`${cut ? 'Cut' : 'Copied'}: “${item.name}”. Open the branch to put it in, then Paste.`);
    this.render(); // (the Paste button; a cut one faded)
  }

  /** Put what was cut (moved) or copied in a branch: the one that is open, or the one it is pasted on. */
  paste(to = this.here) {
    if (this.clip) this.putIn(this.clip.item, to?.id ?? null, !this.clip.cut);
  }

  /** Move an item into the branch `to` (null: the top), or put a copy there; then the library again. */
  async putIn(item, to, copy) {
    try {
      await this.place(item, to, copy);
    } catch (err) { toast(err.message); return; }
    if (!copy && this.clip?.cut && this.same(this.clip.item, item)) this.clip = null; // (a copy can be pasted again)
    toast(`${copy ? 'Copied' : 'Moved'}: “${item.name}”.`);
    this.branchesChanged();
  }

  /**
   * Move an item into the branch `to` (null: the top), or put a copy there (copy): of a branch, the
   * same branches with copies of their books; of a book, the same book in one more branch (a link).
   */
  place(item, to, copy) {
    if (item.kind === 'branch') {
      return copy ? api('POST', `/api/branches/${item.id}/copy`, { parent: to }) : api('PUT', `/api/branches/${item.id}`, { parent: to });
    }
    if (!copy) return api('PUT', item.link ? `/api/links/${item.link}` : `/api/books/${item.id}`, { branch: to });
    const into = to === null ? this.root : this.root?.byId.get(to);
    const taken = into?.books?.some((b) => b.title === item.name); // (next to it: another name)
    return api('POST', '/api/links', { book: item.id, branch: to, title: taken ? `${item.name} (copy)` : item.link ? item.name : '' });
  }

  renameDialog(item) {
    const name = el('input', { type: 'text', class: 'input', required: true, maxlength: item.kind === 'branch' ? 80 : 120, value: item.name });
    const msg = el('p', { class: 'form-msg', role: 'alert' });
    const note = item.link ? 'This is a copy: only the copy gets the new name.'
      : item.disc ? 'The name in this app: the disc stays as it is.' : null;
    const form = el('form', { class: 'lib-form' },
      el('label', { class: 'field' }, el('span', {}, 'Name'), name),
      note ? el('p', { class: 'hint' }, note) : null, msg,
      el('div', { class: 'form-buttons' }, el('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'Cancel'),
        el('button', { class: 'btn primary', type: 'submit' }, 'Rename')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const value = name.value.trim();
      try {
        if (item.kind === 'branch') await api('PUT', `/api/branches/${item.id}`, { name: value });
        else await api('PUT', item.link ? `/api/links/${item.link}` : `/api/books/${item.id}`, { title: value });
      } catch (err) { msg.textContent = err.message; return; }
      closeDialog();
      toast('Renamed.');
      if (item.kind === 'book' && !item.link) this.app.forgetBook(item.id); // (its name in the reader)
      if (this.clip && this.same(this.clip.item, item)) this.clip.item.name = value;
      this.branchesChanged();
    });
    openDialog(`Rename: ${item.name}`, form);
    name.focus();
    name.select();
  }

  /** Move a branch or a book into a branch chosen from the list (without opening it first). */
  moveDialog(item) {
    const now = item.kind === 'branch' ? item.node.up?.id ?? null : item.entry.branch ?? null;
    const select = el('select', { class: 'select' }, el('option', { value: '' }, item.kind === 'branch' ? 'None: a main branch (at the top)' : 'None: at the top of the library'),
      ...allBranches(bookTree([], this.branchList || []), item.kind === 'branch' ? item.id : null)
        .map((f) => el('option', { value: f.id, selected: f.id === now }, f.path.join(' › '))));
    const msg = el('p', { class: 'form-msg', role: 'alert' });
    const form = el('form', { class: 'lib-form' },
      el('label', { class: 'field' }, el('span', {}, 'Into the branch'), select),
      item.kind === 'branch' ? el('p', { class: 'hint' }, 'It takes its books and branches with it.') : null, msg,
      el('div', { class: 'form-buttons' }, el('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'Cancel'),
        el('button', { class: 'btn primary', type: 'submit' }, 'Move')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await this.place(item, select.value ? Number(select.value) : null, false);
      } catch (err) { msg.textContent = err.message; return; }
      closeDialog();
      toast(`Moved: “${item.name}”.`);
      this.branchesChanged();
    });
    openDialog(`Move: ${item.name}`, form);
    select.focus();
  }

  /** A new branch around a branch: made where it is, the branch (with all in it) moved into it. */
  parentDialog(f) {
    const name = el('input', { type: 'text', class: 'input', maxlength: 80, required: true, placeholder: 'For example: Learning English Courses' });
    const msg = el('p', { class: 'form-msg', role: 'alert' });
    const form = el('form', { class: 'lib-form' },
      el('label', { class: 'field' }, el('span', {}, 'Name of the new branch'), name),
      el('p', { class: 'hint' }, `It is made where “${f.name}” is, and “${f.name}” goes into it with all that is in it.`), msg,
      el('div', { class: 'form-buttons' }, el('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'Cancel'),
        el('button', { class: 'btn primary', type: 'submit' }, 'Make the branch')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const made = await api('POST', '/api/branches', { name: name.value, parent: f.up?.id ?? null });
        await api('PUT', `/api/branches/${f.id}`, { parent: made.id });
      } catch (err) { msg.textContent = err.message; return; }
      closeDialog();
      toast(`“${f.name}” is now in “${name.value.trim()}”.`);
      this.branchesChanged();
    });
    openDialog(`New parent branch for ${f.name}`, form);
    name.focus();
  }

  async removeLink(item) {
    if (!confirm(`Delete this copy, “${item.name}”? Only the copy goes: the book stays where it is.`)) return;
    try { await api('DELETE', `/api/links/${item.link}`); } catch (err) { toast(err.message); return; }
    toast('The copy was deleted.');
    if (this.clip && this.same(this.clip.item, item)) this.clip = null;
    this.branchesChanged();
  }

  /** The branch a book is in, to choose (no branches: nothing to choose): {node, value()}. */
  branchField(value) {
    if (!this.branchList?.length) return { node: null, value: () => ({}) };
    const select = el('select', { class: 'select' }, el('option', { value: '' }, 'None: at the top of the library'),
      ...allBranches(bookTree([], this.branchList)).map((f) => el('option', { value: f.id, selected: f.id === value }, f.path.join(' › '))));
    return { node: el('label', { class: 'field' }, el('span', {}, 'Branch (where it is kept in the library)'), select),
      value: () => ({ branch: select.value ? Number(select.value) : null }) };
  }

  openBook(b) {
    if (!b.disc && b.status !== 'ready') {
      if (b.canEdit && b.status === 'new' && b.kind !== 'text') this.resume(b); // (its sample)
      else if (b.canEdit) this.settings(b);
      return;
    }
    this.app.backStack = []; // "Back" is for links inside a book
    $('#btn-back').hidden = true;
    this.app.go(b.id, store.get(`page.${b.id}`, null) || (b.disc ? b.firstPage : '1') || '1');
  }

  // ---------------------------------------------------------------- Adding a book

  /** Which languages of pages OCR reads on this computer (asked once): {engine, languages: [{code, name, ocr}]}. */
  pageLanguages() {
    this.languages ??= api('GET', '/api/page-languages').then((info) => { this.ocrInfo = info; return info; })
      .catch(() => { this.languages = null; return null; }); // (asked again next time)
    return this.languages;
  }

  /**
   * The questions about the pages of a PDF or photos: asked when adding the book, and again with
   * more of them (more) after its sample, when the owner sees what to change. They are how the
   * pages are made (_clean_options() in web/library.py). Returns {node, value(), set(changes), setKind(kind)}.
   */
  pageQuestions(kind, options, more) {
    const o = { language: 'en', pinyin: 'none', dropPinyin: false, pages: '', ocrAll: false, margins: false, enhance: false, fixes: '', ...options };
    o.english ??= o.language.startsWith('zh-');
    const check = (on, text) => el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: on }), ` ${text}`);
    // The pages also have English (besides their main language): OCR made for English reads it too.
    const english = check(o.english, 'The pages also have English');
    let info = this.ocrInfo; // (no warnings until the server has said which languages OCR reads)
    const language = el('select', { class: 'select' },
      ...LANGUAGES.map(([code, name]) => el('option', { value: code, selected: code === o.language }, name)));
    const langNote = el('p', { class: 'hint warn' });
    const pinyin = el('select', { class: 'select' }, ...PINYIN.map(([v, label]) => el('option', { value: v, selected: v === o.pinyin }, label)));
    const dropPinyin = check(o.dropPinyin, 'Exclude detected pinyin; keep the Chinese characters and English text');
    const dropPinyinInput = $('input', dropPinyin);
    const pinyinNote = el('p', { class: 'hint' }, 'When Chinese is the main language, detected pinyin lines are left out automatically. Chinese characters and English are kept.');
    const chinese = el('div', {}, el('label', { class: 'field' }, el('span', {}, 'Is there pinyin on the pages?'), pinyin), dropPinyin, pinyinNote);
    const pages = el('input', { type: 'text', class: 'input', value: o.pages, maxlength: 200, placeholder: 'All pages — or for example 3-120 (without the cover and the answers)' });
    const pagesRow = el('label', { class: 'field' }, el('span', {}, 'Pages to use'), pages);
    const ocrAll = check(o.ocrAll, 'Read every page with OCR, not the PDF’s own text (when the PDF’s text shows strange letters)');
    const margins = check(o.margins, 'Leave out page numbers, headings and footers at the very top and bottom of the pages');
    const enhance = check(o.enhance, 'Make the pictures clearer before reading them (for faint, dark or small print)');
    const fixes = el('textarea', { class: 'input', rows: 3, maxlength: 3000, placeholder: 'One per line: what the app read → what it should be\nIäoshT → lǎoshī\nrn → m' });
    fixes.value = o.fixes;
    const fixesRow = el('label', { class: 'field' }, el('span', {}, 'Fix the same mistake on every page (optional)'), fixes);
    const box = (label) => $('input', label);
    const sync = () => {
      const lang = info?.languages.find((l) => l.code === language.value);
      langNote.hidden = !lang || lang.ocr || kind === 'text';
      langNote.textContent = info?.engine === 'tesseract'
        ? `The server cannot read ${lang?.name} from scans or photos yet. PDFs with their own text work.`
        : `This computer cannot read ${lang?.name} from scans or photos yet. PDFs with their own text work. For the others, add ${lang?.name} in the Windows Settings (Time & language → Language & region), with “Optical character recognition”.`;
      english.hidden = language.value === 'en';
      chinese.hidden = !language.value.startsWith('zh-');
      dropPinyin.hidden = pinyinNote.hidden = !language.value.startsWith('zh-');
      dropPinyinInput.checked = language.value.startsWith('zh-');
      dropPinyinInput.disabled = language.value.startsWith('zh-');
      pagesRow.hidden = ocrAll.hidden = kind !== 'pdf' && kind !== 'word';
    };
    [language, pinyin].forEach((s) => s.addEventListener('change', sync));
    language.addEventListener('change', () => { $('input', english).checked = language.value.startsWith('zh-'); }); // (Chinese textbooks: and English)
    const node = el('div', { class: 'page-questions' },
      el('label', { class: 'field' }, el('span', {}, 'Language of the pages'), language), english, langNote, chinese, pagesRow,
      ...(more ? [ocrAll, margins, enhance, fixesRow] : []));
    sync();
    if (!info) this.pageLanguages().then((i) => { info = i; sync(); });
    return {
      node,
      value: () => ({ ...o, language: language.value, english: language.value !== 'en' && box(english).checked,
        pinyin: pinyin.value, dropPinyin: language.value.startsWith('zh-'), pages: pages.value,
        ocrAll: box(ocrAll).checked, margins: box(margins).checked, enhance: box(enhance).checked, fixes: fixes.value }),
      set: (changes) => {
        if ('language' in changes) language.value = changes.language;
        if ('pinyin' in changes) pinyin.value = changes.pinyin;
        for (const [k, label] of Object.entries({ english, dropPinyin, ocrAll, margins, enhance })) if (k in changes) box(label).checked = changes[k];
        sync();
      },
      setKind: (k) => { kind = k; sync(); },
    };
  }

  addDialog() {
    if (!this.user) { this.accountDialog('signup', 'Create a free account (or log in) to add your books.'); return; }
    let kind = store.get('addKind', 'text');
    const title = el('input', { type: 'text', class: 'input', maxlength: 120, required: true, placeholder: 'For example: My first story' });
    const author = el('input', { type: 'text', class: 'input', maxlength: 120, placeholder: 'Optional' });
    const text = el('textarea', { class: 'input', rows: 10, placeholder: 'Paste or type the text.\n\nAn empty line starts a new paragraph. A line starting with # is a heading.' });
    const picture = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp' });
    const pdf = el('input', { type: 'file', accept: 'application/pdf,.pdf' });
    const word = el('input', { type: 'file', accept: '.docx,.doc,.rtf,.odt,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword' });
    const photos = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true });
    const photoNote = el('p', { class: 'hint' }, 'Choose one photo per page. The pages are put in the order of the file names.');
    photos.addEventListener('change', () => {
      const n = photos.files.length;
      photoNote.textContent = n ? `${n} photo${n === 1 ? '' : 's'} chosen.` : 'Choose one photo per page.';
    });
    const questions = this.pageQuestions(kind, store.get('addOptions', {}), false);
    const place = this.branchField(this.here?.id ?? null); // (added in the branch that is open)
    const parts = {
      text: el('div', {}, el('label', { class: 'field' }, el('span', {}, 'Text'), text),
        el('label', { class: 'field' }, el('span', {}, 'A picture at the top (optional)'), picture)),
      pdf: el('div', {}, el('label', { class: 'field' }, el('span', {}, `PDF file (at most ${this.me.limits?.pdf_mb || 60} MB; ${this.me.limits?.pages || 300} pages are used)`), pdf),
        el('p', { class: 'hint' }, 'Pages with text are read from the PDF; scanned pages are read with OCR.')),
      word: el('div', {}, el('label', { class: 'field' }, el('span', {}, `Word file (.docx or .doc; at most ${this.me.limits?.pdf_mb || 60} MB; ${this.me.limits?.pages || 300} pages are used)`), word),
        el('p', { class: this.me.wordFiles === false ? 'hint warn' : 'hint' }, this.me.wordFiles === false
          ? 'Word files cannot be added here yet. In Word, save the file as a PDF (File → Save As → PDF) and add the PDF.'
          : 'The app makes it into a PDF first, with its pictures and tables, and then reads it like a PDF.')),
      images: el('div', {}, el('label', { class: 'field' }, el('span', {}, 'Photos or scans of the pages'), photos), photoNote,
        el('p', { class: 'hint' }, 'Tip: photograph each page straight from above, in good light.')),
    };
    const sampleNote = el('p', { class: 'hint' }, 'First the app makes a few pages, chosen at random, for you to check. '
      + 'If something is not right, you tell it what to change and try again — then it makes all the pages.');
    const seg = el('div', { class: 'seg add-kind', role: 'radiogroup' },
      ...[['text', 'Text'], ['pdf', 'PDF'], ['word', 'Word'], ['images', 'Photos of pages']].map(([k, label]) =>
        el('button', { type: 'button', role: 'radio', dataset: { kind: k }, onclick: () => setKind(k) }, label)));
    const setKind = (k) => {
      kind = k;
      store.set('addKind', k);
      $$('button', seg).forEach((b) => b.setAttribute('aria-checked', String(b.dataset.kind === k)));
      Object.entries(parts).forEach(([key, node]) => { node.hidden = key !== k; });
      questions.node.hidden = sampleNote.hidden = k === 'text';
      questions.setKind(k);
    };
    const msg = el('p', { class: 'form-msg', role: 'alert' });
    const go = el('button', { class: 'btn primary', type: 'submit' }, 'Add the book');
    const form = el('form', { class: 'lib-form' },
      seg,
      el('label', { class: 'field' }, el('span', {}, 'Title'), title),
      el('label', { class: 'field' }, el('span', {}, 'Author'), author),
      place.node,
      ...Object.values(parts),
      questions.node, sampleNote,
      el('p', { class: 'hint' }, 'Your book stays private (only you can see it) until you share it. Only share what you have the right to share.'),
      msg,
      el('div', { class: 'form-buttons' }, el('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'Cancel'), go));
    setKind(kind);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.textContent = '';
      const files = kind === 'pdf' ? [...pdf.files] : kind === 'word' ? [...word.files]
        : kind === 'images' ? [...photos.files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })) : [];
      if (!title.value.trim()) { msg.textContent = 'Please give a title.'; title.focus(); return; }
      if (kind === 'text' && !text.value.trim()) { msg.textContent = 'Please add the text.'; text.focus(); return; }
      if (kind !== 'text' && !files.length) {
        msg.textContent = { pdf: 'Please choose the PDF file.', word: 'Please choose the Word file.' }[kind] || 'Please choose the photos.';
        return;
      }
      // (said before sending: the server would stop reading it; its limits asked now: it may have been started again since this page was opened)
      const limits = (await api('GET', '/api/me').catch(() => null))?.limits || this.me.limits;
      const big = tooBig(kind, files, limits);
      if (big) { msg.textContent = big; return; }
      const options = kind === 'text' ? undefined : questions.value();
      if (options) store.set('addOptions', { language: options.language, english: options.english, pinyin: options.pinyin }); // (the next book is likely the same)
      go.disabled = true;
      try {
        await this.add({ kind, title: title.value, author: author.value, place: place.value(), text: text.value, picture: picture.files[0], files, options }, form);
      } catch (err) {
        msg.textContent = err.message;
        go.disabled = false;
      }
    });
    openDialog('Add a book', form);
    title.focus();
  }

  async add(d, form) {
    // (a Word file is made into a PDF on the server: the book is a PDF book)
    const book = await api('POST', '/api/books', { kind: d.kind === 'word' ? 'pdf' : d.kind, title: d.title, author: d.author, ...d.place, importOptions: d.options });
    const bar = el('div', { class: 'rec-progress' }, el('div'));
    const stage = el('p', { class: 'hint' }, 'Sending…');
    form.replaceChildren(el('h3', { class: 'lib-progress-title' }, d.title), bar, stage);
    const show = (frac, text) => { bar.firstChild.style.width = `${Math.round(frac * 100)}%`; stage.textContent = text; };
    const src = (part) => `/api/books/${book.id}/source/${part}`;
    try {
      if (d.kind === 'text') {
        await upload(src('text'), new Blob([JSON.stringify({ text: d.text })], { type: 'application/json' }), () => {});
        if (d.picture) await upload(src('picture'), await serverPhoto(d.picture), (f) => show(f, 'Sending the picture…'));
      } else if (d.kind === 'pdf') {
        await upload(src('pdf'), d.files[0], (f) => show(f, `Sending the PDF… ${Math.round(f * 100)}%`));
      } else if (d.kind === 'word') {
        await upload(src('word'), d.files[0], (f) => show(f, f < 1 ? `Sending the Word file… ${Math.round(f * 100)}%`
          : 'Making the Word file into a PDF… (a big file takes a minute or two)'));
      } else {
        for (const [k, f] of d.files.entries()) {
          await upload(src(`image-${k}`), await serverPhoto(f), (x) => show((k + x) / d.files.length, `Sending photo ${k + 1} of ${d.files.length}…`));
        }
      }
    } catch (err) {
      await api('DELETE', `/api/books/${book.id}`).catch(() => {}); // (no empty book left behind: add it again)
      form.replaceChildren(el('p', { class: 'form-msg' }, err.message),
        el('div', { class: 'form-buttons' }, el('button', { class: 'btn', type: 'button', onclick: () => { closeDialog(); this.setScope('mine'); } }, 'Close')));
      return;
    }
    if (d.kind === 'text') this.makeAll(book);
    else this.sample(book, d.options);
  }

  /**
   * Make a sample of the pages of a book with these options (same: of the pages of the last
   * sample, to compare; start false: only follow the one being made; again: find the designs of
   * the pages again, js/designs.js), then show it to check.
   */
  async sample(book, options, { same = false, start = true, again = false } = {}) {
    const bar = el('div', { class: 'rec-progress' }, el('div'));
    const stage = el('p', { class: 'hint' }, 'Making a sample of the pages…');
    const view = el('div', { class: 'lib-form' }, el('h3', { class: 'lib-progress-title' }, book.title), bar, stage);
    step(`Sample: ${book.title}`, view);
    let s;
    try {
      s = start ? await api('POST', `/api/books/${book.id}/preview`, { options, same, again }) : await api('GET', `/api/books/${book.id}/preview`);
      while (s.state === 'working') {
        bar.firstChild.style.width = `${s.total ? Math.round((s.done / s.total) * 100) : 0}%`;
        stage.textContent = s.stage === 'Waiting…' ? 'Waiting for the books before it…' : s.stage || 'Making a sample of the pages…';
        await new Promise((r) => { setTimeout(r, 700); });
        if (!view.isConnected) return; // closed: it is made all the same, and can be checked later
        s = await api('GET', `/api/books/${book.id}/preview`);
      }
    } catch (err) {
      s = { state: 'error', error: err.message };
    }
    if (view.isConnected) this.review(book, s, options);
  }

  /** Show the sample to check (s.state 'ready'), or what went wrong ('error'), with what to change. */
  review(book, s, options) {
    const ready = s.state === 'ready';
    const q = this.pageQuestions(book.kind, ready ? s.options : options, true);
    const again = (same) => this.sample(book, q.value(), { same });
    const page = book.kind === 'images' ? 'Photo' : 'Page';
    const areas = (p) => (s.designs ? el('button', { class: 'btn small', type: 'button', onclick: () => this.designs(book, s, q, p.n) },
      p.design == null ? 'Give it a design' : `Change the areas of design ${p.design + 1}`) : null);
    const pages = ready && el('div', { class: 'sample-pages' }, ...s.pages.map((p) => el('figure', { class: 'sample-page' },
      el('figcaption', {}, el('b', {}, `${page} ${p.n}`), ` · ${HOW[p.how] || ''} · ${p.words} word${p.words === 1 ? '' : 's'}`,
        p.design != null ? ` · design ${p.design + 1}${p.areas?.length && !p.framed ? ' (its areas suggested; read whole)' : ''}` : '', ' ', areas(p)),
      el('a', { href: p.img, target: '_blank', rel: 'noopener', title: 'See it bigger' },
        p.areas?.length ? framed(p.img, p.areas, `${page} ${p.n}, with the areas of its design`) : el('img', { src: p.img, alt: `${page} ${p.n}` })),
      el('div', { class: 'sample-text', lang: s.options.language }, p.text || 'No words were found on this page.'))));
    // The designs of the pages: on each, the app reads its areas in their order (web/designs.py).
    // Its areas are used once the owner has checked them (saved): laid on pages that only look alike they could cut them wrongly.
    const designs = ready && el('div', { class: 'sample-tips design-note' },
      el('h4', {}, s.designs ? `The app found ${s.designs} design${s.designs === 1 ? '' : 's'} of page` : 'Review the paragraphs of every page'),
      el('p', {}, 'Review individual pages to change their paragraph outlines and reading order. Pages that look alike can also share a design. '
        + 'Areas marked “Don’t read” are left out. '
        + (s.checked ? 'Your saved individual layouts and shared designs are used in the sample and the finished book.'
          : 'The frames on the pages below are its suggestion. Check them, change them if needed, and save: then the pages of each design are read by them. Until then every page is read whole, as before.')),
      el('button', { class: 'btn small', type: 'button', onclick: () => this.designs(book, s, q) }, 'Review all pages and paragraph outlines'));
    const tips = ready && s.tips.length > 0 && el('div', { class: 'sample-tips' }, el('h4', {}, 'The app noticed'),
      ...s.tips.map((t) => el('div', { class: 'sample-tip' }, el('p', {}, t.text),
        t.set ? el('button', { class: 'btn small', type: 'button', onclick: () => { q.set(t.set); again(true); } }, 'Change it and try again') : null)));
    const intro = ready
      ? `The app made ${s.pages.length} of the ${s.chosen} pages${s.chosen < s.total ? ` you chose (of ${s.total})` : ''}, `
        + `${s.designs ? 'a page of each design (and others chosen at random)' : 'chosen at random'}. `
        + 'Check that the words were read right: they are what you can click, hear and translate.'
      : 'The sample could not be made. Change what is needed below, and try again.';
    const panel = el('div', { class: 'lib-form sample-review' },
      el('p', { class: 'hint' }, intro),
      ready ? null : el('p', { class: 'form-msg', role: 'alert' }, s.error || 'Something went wrong.'),
      designs, pages, tips,
      el('h4', {}, ready ? 'Something to change?' : 'What to change'), q.node,
      el('div', { class: 'form-buttons' },
        ready ? el('button', { class: 'btn', type: 'button', onclick: () => again(true) }, 'Try again on these pages') : null,
        el('button', { class: 'btn', type: 'button', onclick: () => again(false) }, ready ? 'Show other pages' : 'Try again'),
        el('span', { class: 'push' }),
        el('button', { class: 'btn', type: 'button', title: 'The book waits in My books, unfinished', onclick: () => { closeDialog(); this.setScope('mine'); } }, 'Finish later'),
        ready ? el('button', { class: 'btn primary', type: 'button', onclick: () => this.makeAll(book, q.value()) },
          `Make all ${s.chosen} page${s.chosen === 1 ? '' : 's'}`) : null));
    step(`Check the sample: ${book.title}`, panel);
  }

  /**
   * See and change the designs of the pages of a book (js/designs.js), from the check of its sample
   * s (q: its questions, whose answers the sample made after saving keeps), showing page n first.
   */
  async designs(book, s, q, n) {
    let info;
    try { info = await api('GET', `/api/books/${book.id}/designs`); } catch (err) { toast(err.message); return; }
    const aiInfo = await api('GET', '/api/layout-ai').catch(() => null);
    const sharp = Object.fromEntries(s.pages.map((p) => [p.n, p.img])); // (the pages of the sample: drawn big)
    const back = () => this.review(book, s, q.value());
    step(`Page layouts: ${book.title}`, designEditor({
      info, first: n, aiInfo,
      picture: (k, small) => (!small && sharp[k]) || `/lib/${book.id}/designs/${k}.webp?v=${info.token}`,
      onCancel: back,
      onAgain: () => this.sample(book, q.value(), { again: true }),
      onPage: (n) => api('POST', `/api/books/${book.id}/layout/${n}`),
      onConfigureAI: (body) => api('PUT', '/api/layout-ai', body),
      onAnalyze: (n, refresh, progress) => requestAILayout(book.id, n, refresh, progress),
      onSave: async (designs, pageAreas) => {
        await api('PUT', `/api/books/${book.id}/designs`, { designs, pageAreas });
        this.sample(book, q.value(), { same: true });
      },
    }));
  }

  /** Make all the pages of the book (with these options: those of its last sample), then open it. */
  async makeAll(book, options) {
    const bar = el('div', { class: 'rec-progress' }, el('div'));
    const stage = el('p', { class: 'hint' }, 'Starting…');
    const view = el('div', { class: 'lib-form' }, el('h3', { class: 'lib-progress-title' }, book.title), bar, stage);
    step(`Making the pages: ${book.title}`, view);
    const show = (frac, text) => { bar.firstChild.style.width = `${Math.round(frac * 100)}%`; stage.textContent = text; };
    try {
      await api('POST', `/api/books/${book.id}/make`, options || {});
      for (;;) {
        await new Promise((r) => { setTimeout(r, 800); });
        const j = await api('GET', `/api/books/${book.id}/job`);
        if (j.status === 'ready') break;
        if (j.status === 'error') throw new Error(j.error || 'The pages could not be made.');
        const job = j.job || {};
        show(job.total ? job.done / job.total : 0, job.stage || 'Making the pages…');
      }
    } catch (err) {
      view.replaceChildren(el('p', { class: 'form-msg' }, err.message),
        el('div', { class: 'form-buttons' }, el('button', { class: 'btn', type: 'button', onclick: () => { closeDialog(); this.setScope('mine'); } }, 'Close')));
      return;
    }
    if (!view.isConnected) { this.changed(book.id); return; } // (closed meanwhile: it is in My books)
    closeDialog();
    toast('The book is ready.');
    this.scope = 'mine';
    store.set('libScope', 'mine');
    this.app.go(book.id, '1');
  }

  /** An unfinished book (PDF, photos): check its sample (or the one being made), or make one. */
  async resume(b) {
    const s = await api('GET', `/api/books/${b.id}/preview`).catch(() => null);
    if (s?.state === 'working') this.sample(b, b.importOptions, { start: false });
    else if (s) this.review(b, s, b.importOptions);
    else this.sample(b, b.importOptions);
  }

  // ---------------------------------------------------------------- A book's settings, sharing it

  async settings(b) {
    this.branchList ??= await api('GET', '/api/branches').catch(() => null); // (opened in a book, the library not seen yet)
    const lic = this.me.licenses || {};
    const f = (v) => el('input', { type: 'text', class: 'input', value: v || '', maxlength: 300 });
    const title = f(b.title), author = f(b.author), source = f(b.source);
    const about = el('textarea', { class: 'input', rows: 3, maxlength: 600 });
    about.value = b.about || '';
    const place = this.branchField(b.branch);
    const pub = el('input', { type: 'checkbox', checked: b.visibility === 'public', disabled: b.status !== 'ready' });
    const license = el('select', { class: 'select' }, el('option', { value: '' }, 'Choose the licence…'),
      ...Object.entries(lic).map(([k, name]) => el('option', { value: k, selected: k === b.license }, name)));
    const rights = el('input', { type: 'checkbox', checked: b.visibility === 'public' });
    const share = el('div', { class: 'share-box' },
      el('label', { class: 'field' }, el('span', {}, 'Licence'), license),
      el('label', { class: 'check' }, rights,
        ' I confirm that I may share this with everyone: it is my own work, in the public domain, or under a licence that allows sharing.'),
      el('label', { class: 'field' }, el('span', {}, 'Where it comes from (a link, for others to check the licence)'), source));
    const syncShare = () => { share.hidden = !pub.checked; };
    pub.addEventListener('change', syncShare);
    syncShare();
    const msg = el('p', { class: 'form-msg', role: 'alert' });
    const status = b.status === 'ready' ? null
      : el('p', { class: b.status === 'error' ? 'form-msg' : 'hint' }, b.status === 'error' ? `The pages could not be made: ${b.error}`
        : b.status === 'new' ? 'This book is not finished: its pages are not made yet.' : 'The pages are being made…');
    const form = el('form', { class: 'lib-form' },
      status,
      el('label', { class: 'field' }, el('span', {}, 'Title'), title),
      el('label', { class: 'field' }, el('span', {}, 'Author'), author),
      place.node,
      el('label', { class: 'field' }, el('span', {}, 'About this book (optional)'), about),
      b.status === 'ready' ? this.mediaBox(b) : null,
      el('label', { class: 'check share-toggle' }, pub, el('b', {}, ' Share with everyone'), ' — it appears in the public library'),
      share,
      b.hidden ? el('p', { class: 'form-msg' }, 'An admin has hidden this book after a report. Only you can see it.') : null,
      msg,
      el('div', { class: 'form-buttons' },
        el('button', { class: 'btn danger-btn', type: 'button', html: `${icon('trash')}Delete`, onclick: () => this.remove(b) }),
        ['new', 'error'].includes(b.status) && b.kind !== 'text'  // change how they are made, with a sample
          ? el('button', { class: 'btn', type: 'button', onclick: () => this.resume(b) }, b.sample ? 'Check the sample' : 'Make a sample') : null,
        b.status === 'error' && b.kind === 'text' ? el('button', { class: 'btn', type: 'button', onclick: () => this.makeAgain(b) }, 'Try again') : null,
        b.pdf ? el('a', { class: 'btn', href: b.pdf, download: '', title: 'The book’s PDF, with the pictures you replaced' }, 'Download the PDF') : null,
        el('span', { class: 'push' }),
        el('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'Cancel'),
        el('button', { class: 'btn primary', type: 'submit' }, 'Save')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.textContent = '';
      const body = { title: title.value, author: author.value, ...place.value(), about: about.value, source: source.value,
        visibility: pub.checked ? 'public' : 'private', license: pub.checked ? license.value : b.license };
      if (pub.checked) {
        if (!license.value) { msg.textContent = 'Choose the licence of the book.'; return; }
        if (!rights.checked) { msg.textContent = 'Please confirm that you may share it.'; return; }
        body.rights = true;
      }
      try {
        await api('PUT', `/api/books/${b.id}`, body);
      } catch (err) { msg.textContent = err.message; return; }
      closeDialog();
      toast(pub.checked ? 'Saved. The book is in the public library.' : 'Saved.');
      this.changed(b.id);
    });
    openDialog(`Settings: ${b.title}`, form);
  }

  /**
   * A book's audio and video (web/tracks.py): a folder of them (or some files) added, each with a
   * play button where its number is printed on the pages ("⊙1.26" → …_1.26.mp3); taken out again.
   */
  mediaBox(b) {
    const MEDIA = /\.(mp3|m4a|wav|ogg|mp4|webm)$/i;
    const state = el('p', { class: 'hint', 'aria-live': 'polite' }, '…');
    const bar = el('div', { class: 'rec-progress', hidden: true }, el('div'));
    const folder = el('input', { type: 'file', multiple: true, webkitdirectory: true, hidden: true });
    const files = el('input', { type: 'file', multiple: true, accept: 'audio/*,video/*,.mp3,.m4a,.wav,.ogg,.mp4,.webm', hidden: true });
    const buttons = [
      el('button', { class: 'btn', type: 'button', onclick: () => folder.click() }, 'Add a folder…'),
      el('button', { class: 'btn', type: 'button', onclick: () => files.click() }, 'Add files…'),
      el('button', { class: 'btn danger-btn', type: 'button', hidden: true, onclick: () => removeAll() }, 'Take them all out')];
    // Their scripts written by speech recognition (transcription.py: ElevenLabs or this computer).
    const said = el('p', { class: 'hint', 'aria-live': 'polite', hidden: true });
    const transcribe = el('button', { class: 'btn', type: 'button', hidden: true, onclick: () => transcribeAll() }, 'Transcribe them all');
    let polling = null;
    const show = (d) => {
      buttons[2].hidden = !d.files;
      const lost = d.unplaced.length ? ` Not found on a page: ${d.unplaced.slice(0, 6).join(', ')}${d.unplaced.length > 6 ? ` and ${d.unplaced.length - 6} more` : ''}.` : '';
      state.textContent = d.files ? `${d.files} recording${d.files === 1 ? '' : 's'} (${Math.round(d.bytes / 2 ** 20)} MB): ${d.placed} with a play button on their page.${lost}`
        : 'None yet. Add the folder of the book’s audio (and video), for example its Student’s Book CD: a play button goes where each one’s number is printed on the pages (⊙1.26 → …_1.26.mp3).';
      const t = d.transcripts || { done: 0, running: 0, failed: 0 };
      said.hidden = !d.files || !(t.done || t.running || t.failed);
      said.textContent = `Their scripts: ${t.done} of ${d.files} written down${t.running ? `, ${t.running} still being transcribed…` : '.'}`
        + `${t.failed ? ` ${t.failed} could not be: Transcribe them all again to try them again.` : ''}`;
      transcribe.hidden = !d.files || !d.canTranscribe || t.done >= d.files || t.running > 0;
      clearTimeout(polling);
      if (t.running) {
        polling = setTimeout(() => { if (box.isConnected) api('GET', `/api/books/${b.id}/tracks`).then(show).catch(() => {}); }, 3000);
      }
    };
    const transcribeAll = async () => {
      if (!confirm('Write down what is said in every recording of this book not transcribed yet? '
        + 'With ElevenLabs each hour of sound costs some of your credits; on this computer it takes long.')) return;
      transcribe.disabled = true;
      try { show(await api('POST', `/api/books/${b.id}/tracks/transcribe`)); } catch (err) { toast(err.message); }
      transcribe.disabled = false;
    };
    const changed = () => { if (this.app.book?.id === b.id) this.app.reloadBook(); };
    const add = async (list) => {
      const chosen = [...list].filter((f) => MEDIA.test(f.name)).sort((x, y) => naturally(x.name, y.name));
      if (!chosen.length) { state.textContent = 'There is no audio or video in it (MP3, M4A, WAV, OGG, MP4, WebM).'; return; }
      buttons.forEach((x) => { x.disabled = true; });
      bar.hidden = false;
      const failed = [];
      for (const [k, f] of chosen.entries()) {
        const at = (x) => { bar.firstChild.style.width = `${Math.round(((k + x) / chosen.length) * 100)}%`; };
        state.textContent = `Adding ${k + 1} of ${chosen.length}: ${f.name}`;
        try { await upload(`/api/books/${b.id}/tracks?name=${encodeURIComponent(f.name)}`, f, at); } catch (err) { failed.push(`${f.name}: ${err.message}`); }
      }
      state.textContent = 'Putting their buttons on the pages…';
      try { show(await api('POST', `/api/books/${b.id}/tracks/place`)); } catch (err) { state.textContent = err.message; }
      if (failed.length) state.append(el('br'), `${failed.length} could not be added: ${failed.slice(0, 3).join('; ')}`);
      bar.hidden = true;
      buttons.forEach((x) => { x.disabled = false; });
      folder.value = files.value = '';
      changed();
    };
    const removeAll = async () => {
      if (!confirm(`Take all the audio and video added to “${b.title}” out of it (with their buttons on the pages)?`)) return;
      try { show(await api('DELETE', `/api/books/${b.id}/tracks`)); } catch (err) { toast(err.message); return; }
      changed();
    };
    folder.addEventListener('change', () => add(folder.files));
    files.addEventListener('change', () => add(files.files));
    const box = el('div', { class: 'media-box' }, el('h4', {}, 'Audio and video'), state, bar, el('div', { class: 'form-buttons' }, ...buttons), folder, files,
      said, el('div', { class: 'form-buttons' }, transcribe, el('button', { class: 'link-btn', type: 'button', onclick: () => speechDialog(this.app), title: 'ElevenLabs or this computer' }, 'Speech recognition…')));
    api('GET', `/api/books/${b.id}/tracks`).then(show).catch(() => { state.textContent = ''; });
    return box;
  }

  /**
   * A disc book's recordings and videos (any level's) that came without a script: their scripts,
   * written by speech recognition, all written (again) — with ElevenLabs better than the ones this
   * computer wrote before, with the speakers (server: disc_scripts). The disc's own scripts stay.
   */
  discScripts(b) {
    const url = `/api/disc-scripts/${encodeURIComponent(b.id)}`;
    const state = el('p', { class: 'hint', 'aria-live': 'polite' }, 'Counting its recordings…');
    const go = el('button', { class: 'btn primary', type: 'button', hidden: true }, 'Transcribe them all');
    let polling = null;
    const box = el('div', { class: 'lib-form disc-scripts' },
      el('p', {}, 'Its recordings and videos that have no script on the disc get one written by speech recognition. '
        + 'With ElevenLabs (Speech recognition…) they are written again, better, with the speakers told apart. '
        + 'The scripts that came on the disc stay as they are.'),
      state, el('div', { class: 'form-buttons' },
        el('button', { class: 'link-btn', type: 'button', onclick: () => speechDialog(this.app), title: 'ElevenLabs or this computer' }, 'Speech recognition…'),
        el('span', { class: 'push' }), go));
    const show = (d) => {
      const t = d.transcripts;
      state.textContent = !d.files ? 'All its recordings and videos have their scripts on the disc.'
        : `${d.files} of its recordings and videos have no script on the disc: ${t.done} of them written by `
          + `${d.engine === 'eleven' ? 'ElevenLabs' : 'speech recognition'}${t.running ? `, ${t.running} being transcribed now…` : '.'}`
          + `${t.failed ? ` ${t.failed} could not be: Transcribe them all again to try them again.` : ''}`;
      go.hidden = !d.files || t.done >= d.files || t.running > 0;
      clearTimeout(polling);
      if (t.running) polling = setTimeout(() => { if (box.isConnected) api('GET', url).then(show).catch(() => {}); }, 3000);
    };
    go.addEventListener('click', async () => {
      if (!confirm(`Write the scripts of the recordings and videos of “${b.title}” that have none on the disc? `
        + 'With ElevenLabs each hour of sound costs some of your credits; on this computer it takes long.')) return;
      go.disabled = true;
      try { show(await api('POST', url)); } catch (err) { state.textContent = err.message; }
      go.disabled = false;
    });
    openDialog(`Scripts: ${b.title}`, box);
    api('GET', url).then(show).catch((err) => { state.textContent = err.message; });
  }

  async remove(b) {
    const copies = (this.books || []).some((x) => x.id === b.id && x.link) ? ' Its copies in other branches go too.' : '';
    if (!confirm(`Delete “${b.title}”? Its pages, corrections and settings are removed.${copies} This cannot be undone.`)) return;
    try { await api('DELETE', `/api/books/${b.id}`); } catch (err) { toast(err.message); return; }
    closeDialog();
    toast('Deleted.');
    if (this.app.book?.id === b.id) { this.app.goHome(); this.app.forgetBook(b.id); return; }
    this.changed(b.id);
  }

  async makeAgain(b) {
    try { await api('POST', `/api/books/${b.id}/make`, {}); } catch (err) { toast(err.message); return; }
    closeDialog();
    this.changed(b.id);
  }

  /** A book changed: forget it, and draw the library (or the open book's details) again. */
  changed(id) {
    this.app.forgetBook(id);
    if (this.isOpen) this.render();
    else if (this.app.book?.id === id) this.app.reloadBook();
  }

  // ---------------------------------------------------------------- Branches (admins)

  /** Make a branch in the branch `into` (the top: a main branch; another can be chosen). */
  branchDialog(into = null) {
    const name = el('input', { type: 'text', class: 'input', maxlength: 80, required: true, placeholder: 'For example: Learning English Courses' });
    const up = into?.id ?? null;
    const parent = el('select', { class: 'select' }, el('option', { value: '' }, 'None: it is a main branch (at the top)'),
      ...allBranches(bookTree([], this.branchList || [])).map((f) => el('option', { value: f.id, selected: f.id === up }, f.path.join(' › '))));
    const msg = el('p', { class: 'form-msg', role: 'alert' });
    const form = el('form', { class: 'lib-form' },
      el('label', { class: 'field' }, el('span', {}, 'Name'), name),
      el('label', { class: 'field' }, el('span', {}, 'In the branch'), parent),
      el('p', { class: 'hint' }, 'A main branch is at the top of the library; a sub-branch is in another branch. Then paste books or branches into it.'),
      msg,
      el('div', { class: 'form-buttons' }, el('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'Cancel'),
        el('button', { class: 'btn primary', type: 'submit' }, 'Make the branch')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/api/branches', { name: name.value, parent: parent.value ? Number(parent.value) : null });
      } catch (err) { msg.textContent = err.message; return; }
      closeDialog();
      toast(`The branch “${name.value.trim()}” was made.`);
      this.branchesChanged();
    });
    openDialog(up !== null ? `New sub-branch in ${into.name}` : 'New main branch', form);
    name.focus();
  }

  async deleteBranch(b) {
    const above = b.up?.id != null ? `“${b.up.name}”` : 'the top of the library';
    const full = booksIn(b).length || b.folders.length || !b.empty;
    if (!confirm(`Delete the branch “${b.name}”?${full ? ` What is in it goes into ${above}. No book is deleted.` : ''}`)) return;
    try { await api('DELETE', `/api/branches/${b.id}`); } catch (err) { toast(err.message); return; }
    if (this.clip?.item.kind === 'branch' && this.clip.item.id === b.id) this.clip = null;
    toast('Deleted.');
    this.branchesChanged();
  }

  /** Branches changed: the library again, in the branch that was open (wherever it is now; deleted: the one above). */
  async branchesChanged() {
    const id = this.here?.id ?? null;
    this.branchList = await api('GET', '/api/branches').catch(() => this.branchList);
    const node = bookTree([], this.branchList || []).byId.get(id);
    if (node?.path) history.replaceState(null, '', folderHash(node.path));
    this.render();
  }

  // ---------------------------------------------------------------- Reports

  report(b) {
    const reasons = this.me.reasons || {};
    const radios = Object.entries(reasons).map(([k, name], i) =>
      el('label', { class: 'check' }, el('input', { type: 'radio', name: 'reason', value: k, checked: i === 0 }), ` ${name}`));
    const note = el('textarea', { class: 'input', rows: 3, maxlength: 1000, placeholder: 'What is wrong? For copyright: who owns it, and a link if you have one.' });
    const msg = el('p', { class: 'form-msg', role: 'alert' });
    const form = el('form', { class: 'lib-form' },
      el('p', {}, 'Tell the admins about a problem with this book. They look at every report.'),
      ...radios,
      el('label', { class: 'field' }, el('span', {}, 'Details'), note),
      msg,
      el('div', { class: 'form-buttons' }, el('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'Cancel'),
        el('button', { class: 'btn primary', type: 'submit' }, 'Send the report')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('POST', `/api/books/${b.id}/report`, { reason: form.reason.value, note: note.value });
      } catch (err) { msg.textContent = err.message; return; }
      closeDialog();
      toast('Thank you. The report was sent.');
    });
    openDialog(`Report: ${b.title}`, form);
  }

  // ---------------------------------------------------------------- About the open book (page list â†’ About)

  renderAbout(book) {
    const tab = $('#drawer [data-dtab="resources"][role=tab]');
    const box = $('#about-box');
    if (book.disc) {
      tab.textContent = 'Resources';
      $('#res-list').hidden = false;
      box.replaceChildren();
      return;
    }
    tab.textContent = 'About';
    $('#res-list').hidden = true;
    const rows = [
      ['Author', book.author], ['Shared by', !book.mine ? book.owner : ''],
      ['Licence', book.visibility === 'public' ? book.licenseName : 'Private (only you)'], ['About', book.about],
    ].filter(([, v]) => v);
    box.replaceChildren(
      el('h3', { class: 'about-title' }, book.title),
      el('dl', { class: 'about-list' }, ...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])),
      book.source ? el('p', {}, el('a', { href: book.source, target: '_blank', rel: 'noopener nofollow' }, 'Where it comes from')) : null,
      el('div', { class: 'about-actions' },
        book.canEdit ? el('button', { class: 'btn', html: `${icon('sliders')}Settings and sharing`, onclick: () => this.settings(book) }) : null,
        !book.mine && book.visibility === 'public' ? el('button', { class: 'btn', html: `${icon('flag')}Report a problem`, onclick: () => this.report(book) }) : null),
      el('p', { class: 'hint' }, el('a', { href: '/web/terms.html', target: '_blank' }, 'Terms and privacy')));
  }

  // ---------------------------------------------------------------- Accounts

  renderAccount() {
    const box = $('#lib-account');
    if (this.me.mode === 'local') { box.replaceChildren(); return; }
    if (!this.user) {
      box.replaceChildren(
        el('button', { class: 'btn', onclick: () => this.accountDialog('login') }, 'Log in'),
        el('button', { class: 'btn primary', onclick: () => this.accountDialog('signup') }, 'Sign up'));
      return;
    }
    const account = el('button', { class: 'btn', html: `${icon('user')}<span>${this.user.name.replace(/[<&>]/g, '')}</span>`,
      title: this.user.email, onclick: () => this.accountMenu() });
    box.replaceChildren(account, this.me.subscription?.required
      ? el('button', { class: 'btn primary', onclick: () => this.redeemDialog() }, 'Redeem access code') : null);
  }

  accountMenu() {
    const u = this.user;
    const sub = this.me.subscription;
    const access = sub?.required ? (sub.admin ? 'Administrator access' : sub.active
      ? `Access until ${when(sub.expiresAt)}` : 'No active subscription') : '';
    openDialog('Your account', el('div', { class: 'lib-form' },
      el('p', {}, el('b', {}, u.name), el('br'), u.email, u.admin ? el('span', { class: 'badge' }, 'Admin') : null),
      access ? el('p', { class: 'hint' }, access) : null,
      el('div', { class: 'form-buttons' },
        sub?.required && !u.admin ? el('button', { class: 'btn', type: 'button', onclick: () => { closeDialog(); this.redeemDialog(); } }, 'Redeem an access code') : null,
        this.me.mode === 'public' ? el('button', { class: 'btn', type: 'button', onclick: () => this.passwordDialog() }, 'Change the password') : null,
        el('button', { class: 'btn primary', type: 'button', onclick: () => this.logOut() }, 'Log out'))));
  }

  async logOut() {
    await api('POST', '/api/logout', {}).catch(() => {});
    closeDialog();
    if (this.me.mode === 'lan') { location.href = '/web/login.html'; return; }
    await this.refreshMe();
    toast('Logged out.');
  }

  accountDialog(tab = 'login', why = '') {
    const email = el('input', { type: 'email', class: 'input', autocomplete: 'email', required: true });
    const name = el('input', { type: 'text', class: 'input', autocomplete: 'name', maxlength: 60 });
    const pw = el('input', { type: 'password', class: 'input', required: true, minlength: 8 });
    const setupCode = el('input', { type: 'password', class: 'input', autocomplete: 'off' });
    const trap = el('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', class: 'trap', 'aria-hidden': 'true' });
    const nameRow = el('label', { class: 'field' }, el('span', {}, 'Your name (others see it on books you share)'), name);
    const setupRow = el('label', { class: 'field' }, el('span', {}, 'Owner setup code (site owner only; leave blank otherwise)'), setupCode);
    const terms = el('p', { class: 'hint', html: 'By creating an account you agree to the <a href="/web/terms.html" target="_blank">terms and privacy rules</a>.' });
    const msg = el('p', { class: 'form-msg', role: 'alert' });
    const go = el('button', { class: 'btn primary', type: 'submit' });
    const seg = el('div', { class: 'seg', role: 'radiogroup' },
      el('button', { type: 'button', role: 'radio', dataset: { t: 'login' }, onclick: () => set('login') }, 'Log in'),
      el('button', { type: 'button', role: 'radio', dataset: { t: 'signup' }, onclick: () => set('signup') }, 'Create an account'));
    const set = (t) => {
      tab = t;
      $$('button', seg).forEach((b) => b.setAttribute('aria-checked', String(b.dataset.t === t)));
      nameRow.hidden = terms.hidden = t !== 'signup';
      pw.autocomplete = t === 'signup' ? 'new-password' : 'current-password';
      go.textContent = t === 'signup' ? 'Create the account' : 'Log in';
      msg.textContent = '';
    };
    const form = el('form', { class: 'lib-form' },
      why ? el('p', {}, why) : null, seg,
      el('label', { class: 'field' }, el('span', {}, 'E-mail'), email), nameRow, setupRow,
      el('label', { class: 'field' }, el('span', {}, 'Password (at least 8 characters)'), pw), trap, terms, msg,
      el('div', { class: 'form-buttons' }, el('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'Cancel'), go));
    set(tab);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      go.disabled = true;
      try {
        await api('POST', tab === 'signup' ? '/api/signup' : '/api/login',
          { email: email.value, name: name.value, password: pw.value, website: trap.value,
            adminSetupCode: setupCode.value });
      } catch (err) {
        msg.textContent = err.message;
        go.disabled = false;
        return;
      }
      closeDialog();
      await this.refreshMe();
      toast(tab === 'signup' ? `Welcome, ${this.user.name}!` : 'Logged in.');
    });
    openDialog(tab === 'signup' ? 'Create an account' : 'Log in', form);
    email.focus();
  }

  redeemDialog(initialCode = '') {
    if (!this.user) {
      this.accountDialog('signup', 'Create an account or log in first, then redeem your code.');
      return;
    }
    const code = el('input', { type: 'text', class: 'input', autocomplete: 'off', autocapitalize: 'characters',
      maxlength: 19, required: true, placeholder: 'ABCD-EFGH-JKLM-NPQR', value: initialCode });
    const msg = el('p', { class: 'form-msg', role: 'alert' });
    const submit = el('button', { class: 'btn primary', type: 'submit' }, 'Redeem code');
    const form = el('form', { class: 'lib-form' },
      el('p', {}, 'Enter the access code your administrator gave you. Its subscription starts when you redeem it.'),
      el('label', { class: 'field' }, el('span', {}, 'Access code'), code), msg,
      el('div', { class: 'form-buttons' }, el('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'Cancel'), submit));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        const result = await api('POST', '/api/redeem', { code: code.value });
        await this.refreshMe();
        closeDialog();
        toast(result.grant ? `Access is active until ${when(result.grant.expiresAt)}.` : 'Your administrator account has full access.');
        this.render();
      } catch (err) {
        msg.textContent = err.message;
        submit.disabled = false;
      }
    });
    openDialog('Redeem an access code', form);
    code.focus();
  }

  passwordDialog() {
    const old = el('input', { type: 'password', class: 'input', autocomplete: 'current-password', required: true });
    const nw = el('input', { type: 'password', class: 'input', autocomplete: 'new-password', required: true, minlength: 8 });
    const msg = el('p', { class: 'form-msg', role: 'alert' });
    const form = el('form', { class: 'lib-form' },
      el('label', { class: 'field' }, el('span', {}, 'Current password'), old),
      el('label', { class: 'field' }, el('span', {}, 'New password (at least 8 characters)'), nw),
      el('p', { class: 'hint' }, 'Other devices where you are logged in are logged out.'), msg,
      el('div', { class: 'form-buttons' }, el('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'Cancel'),
        el('button', { class: 'btn primary', type: 'submit' }, 'Change')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('POST', '/api/password', { old: old.value, new: nw.value }); } catch (err) { msg.textContent = err.message; return; }
      closeDialog();
      toast('The password was changed.');
    });
    openDialog('Change the password', form);
  }

  async refreshMe() {
    this.app.me = await api('GET', '/api/me');
    this.app.accountChanged();
    if (this.isOpen) this.render();
  }

  // ---------------------------------------------------------------- Admin

  /**
   * The Admin page, in parts: Users (js/admin-users.js), Books and reports, and Access codes
   * (when the website asks for them). The part last chosen opens again.
   */
  async renderAdmin(gen) {
    const body = $('#lib-body');
    const codes = Boolean(this.me.subscription?.required);
    const parts = [['users', 'Users'], ['books', 'Books and reports'], ...(codes ? [['codes', 'Access codes']] : [])];
    let part = store.get('adminTab', 'users');
    if (!parts.some(([k]) => k === part)) part = 'users';
    const bar = el('div', { class: 'seg admin-tabs', role: 'radiogroup', 'aria-label': 'Admin' },
      ...parts.map(([k, label]) => el('button', { type: 'button', role: 'radio', 'aria-checked': String(k === part), dataset: { adminTab: k },
        onclick: () => { store.set('adminTab', k); this.renderAdmin(this.gen); } }, label)));
    if (part === 'users') {
      body.replaceChildren(el('div', { class: 'admin' }, bar,
        usersAdmin({ me: this.me.user, plans: codes, openDialog: showDialog, closeDialog })));
      return;
    }
    let reports, books, access = null;
    try {
      [reports, books] = await Promise.all([api('GET', '/api/admin/reports'), api('GET', '/api/books?scope=all')]);
      if (part === 'codes') access = await api('GET', '/api/admin/subscriptions');
    } catch (e) {
      body.replaceChildren(el('div', { class: 'admin' }, bar, el('div', { class: 'lib-empty' }, e.message)));
      return;
    }
    if (gen !== this.gen) return;
    const act = (id, action, label, cls = 'btn small') => el('button', { class: cls, onclick: () => this.moderate(id, action) }, label);
    const reportRows = reports.length ? reports.map((r) => el('tr', {},
      el('td', {}, el('button', { class: 'link-btn', onclick: () => this.app.go(r.book, '1') }, r.title), r.hidden ? el('span', { class: 'badge warn' }, 'Hidden') : null),
      el('td', {}, r.reasonName, r.note ? el('div', { class: 'hint' }, r.note) : null),
      el('td', {}, `${r.owner_name} (${r.owner_email})`),
      el('td', {}, when(r.created)),
      el('td', { class: 'admin-acts' }, r.hidden ? act(r.book, 'show', 'Show again') : act(r.book, 'hide', 'Hide'),
        act(r.book, 'dismiss', 'Nothing wrong'), act(r.book, 'delete', 'Delete', 'btn small danger-btn')))) : [el('tr', {}, el('td', { colspan: 5 }, 'No open reports.'))];
    const bookRows = books.map((b) => el('tr', {},
      el('td', {}, el('button', { class: 'link-btn', onclick: () => this.app.go(b.id, '1') }, b.title)),
      el('td', {}, b.owner), el('td', {}, b.licenseName), el('td', {}, when(b.updated)),
      el('td', { class: 'admin-acts' }, b.hidden ? act(b.id, 'show', 'Show again') : act(b.id, 'hide', 'Hide'), act(b.id, 'delete', 'Delete', 'btn small danger-btn'))));
    const table = (head, rows) => el('div', { class: 'table-scroll' }, el('table', { class: 'admin-table' },
      el('thead', {}, el('tr', {}, ...head.map((h) => el('th', {}, h)))), el('tbody', {}, ...rows)));
    const sections = access ? [this.subscriptionAdmin(access, books, table)] : [
      el('h3', {}, `Reports (${reports.length})`),
      el('p', { class: 'hint' }, 'A book reported by three different people is hidden at once, until you look at it.'),
      table(['Book', 'Reason', 'Shared by', 'Date', ''], reportRows),
      el('h3', {}, `All public books (${books.length})`),
      table(['Book', 'Shared by', 'Licence', 'Changed', ''], bookRows),
    ];
    body.replaceChildren(el('div', { class: 'admin' }, bar, ...sections));
  }

  subscriptionAdmin(access, books, table) {
    const published = books.filter((b) => b.visibility === 'public' && b.status === 'ready' && !b.link);
    const mode = el('select', { class: 'select' },
      el('option', { value: '*' }, 'All public books'),
      el('option', { value: 'selected' }, 'Selected public books'));
    const choose = el('select', { class: 'select', multiple: true, size: Math.min(7, Math.max(3, published.length)), hidden: true },
      ...published.map((b) => el('option', { value: b.id }, b.title)));
    mode.addEventListener('change', () => { choose.hidden = mode.value !== 'selected'; });
    const days = el('input', { class: 'input', type: 'number', min: 1, max: 3650, value: 30, required: true });
    const redeemDays = el('input', { class: 'input', type: 'number', min: 1, max: 3650, value: 90, required: true });
    const label = el('input', { class: 'input', type: 'text', maxlength: 80, placeholder: 'Optional note, e.g. Student 1' });
    const msg = el('p', { class: 'form-msg', role: 'alert' });
    const submit = el('button', { class: 'btn primary', type: 'submit' }, 'Generate code and QR');
    const form = el('form', { class: 'lib-form subscription-code-form' },
      el('div', { class: 'subscription-fields' },
        el('label', { class: 'field' }, el('span', {}, 'Subscription length (days)'), days),
        el('label', { class: 'field' }, el('span', {}, 'Code valid for (days)'), redeemDays)),
      el('label', { class: 'field' }, el('span', {}, 'Book access'), mode),
      el('label', { class: 'field' }, choose),
      el('label', { class: 'field' }, el('span', {}, 'Note for you'), label),
      el('p', { class: 'hint' }, 'Each code works once. Access begins when the user redeems it.'), msg, submit);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const selected = mode.value === '*' ? '*' : [...choose.selectedOptions].map((o) => o.value);
      if (selected !== '*' && !selected.length) { msg.textContent = 'Choose at least one public book.'; return; }
      submit.disabled = true;
      msg.textContent = '';
      try {
        this.lastSubscriptionCode = await api('POST', '/api/admin/subscription-codes',
          { days: Number(days.value), redeemDays: Number(redeemDays.value), books: selected, label: label.value });
        await this.renderAdmin(this.gen);
      } catch (error) {
        msg.textContent = error.message;
        submit.disabled = false;
      }
    });

    const generated = this.lastSubscriptionCode;
    const latest = generated ? el('section', { class: 'subscription-new-code' },
      el('h4', {}, 'New access code'),
      el('p', { class: 'hint' }, `Give this code to one user. It grants ${generated.days} days and can be redeemed until ${when(generated.redeemUntil)}.`),
      el('div', { class: 'subscription-new-row' },
        el('strong', { class: 'subscription-plain-code' }, generated.code),
        generated.qr ? el('img', { class: 'subscription-qr', src: generated.qr, alt: 'QR code for access activation' })
          : el('p', { class: 'hint' }, 'QR link unavailable: set the site HTTPS address in LB_PUBLIC_URL.')),
      generated.redeemUrl ? el('p', { class: 'hint subscription-url' }, generated.redeemUrl) : null,
      el('div', { class: 'form-buttons' },
        el('button', { class: 'btn', type: 'button', onclick: () => navigator.clipboard?.writeText(generated.code).then(() => toast('Code copied.')).catch(() => toast('Select and copy the code.')) }, 'Copy code'),
        generated.redeemUrl ? el('button', { class: 'btn', type: 'button', onclick: () => navigator.clipboard?.writeText(generated.redeemUrl).then(() => toast('Link copied.')).catch(() => toast('Select and copy the link.')) }, 'Copy link') : null)) : null;

    const cancelCode = async (id) => {
      try { await api('DELETE', `/api/admin/subscription-codes/${id}`); await this.renderAdmin(this.gen); }
      catch (error) { toast(error.message); }
    };
    const revoke = async (id) => {
      if (!confirm('Revoke this user’s access now?')) return;
      try { await api('DELETE', `/api/admin/subscriptions/${id}`); await this.renderAdmin(this.gen); }
      catch (error) { toast(error.message); }
    };
    const codeRows = access.codes.map((c) => el('tr', {},
      el('td', {}, c.label || `Code •••• ${c.code_hint}`),
      el('td', {}, `${c.duration_days} days`),
      el('td', {}, c.books.includes('*') ? 'All public books' : `${c.books.length} selected`),
      el('td', {}, c.status),
      el('td', {}, when(c.created)),
      el('td', { class: 'admin-acts' }, c.status === 'ready'
        ? el('button', { class: 'btn small danger-btn', onclick: () => cancelCode(c.id) }, 'Cancel') : null)));
    const grantRows = access.subscriptions.map((s) => el('tr', {},
      el('td', {}, el('b', {}, s.name), el('div', { class: 'hint' }, s.email)),
      el('td', {}, s.books.includes('*') ? 'All public books' : `${s.books.length} selected`),
      el('td', {}, when(s.starts_at)), el('td', {}, when(s.ends_at)), el('td', {}, s.status),
      el('td', { class: 'admin-acts' }, ['active', 'scheduled'].includes(s.status)
        ? el('button', { class: 'btn small danger-btn', onclick: () => revoke(s.id) }, 'Revoke') : null)));
    return el('section', { class: 'subscription-admin' },
      el('h3', {}, 'Subscriptions and access codes'),
      el('p', { class: 'hint' }, 'The site serves book files only while an account has an active grant. Codes are stored as hashes and shown only when first generated.'),
      form, latest,
      el('h4', {}, `Codes (${access.codes.length})`),
      table(['Note / code', 'Access', 'Books', 'Status', 'Created', ''], codeRows.length ? codeRows : [el('tr', {}, el('td', { colspan: 6 }, 'No access codes yet.'))]),
      el('h4', {}, `User subscriptions (${access.subscriptions.length})`),
      table(['User', 'Books', 'Starts', 'Ends', 'Status', ''], grantRows.length ? grantRows : [el('tr', {}, el('td', { colspan: 6 }, 'No subscriptions yet.'))]));
  }

  async moderate(id, action) {
    if (action === 'delete' && !confirm('Delete this book for good? Its owner loses it too.')) return;
    try { await api('POST', `/api/admin/books/${id}`, { action }); } catch (err) { toast(err.message); return; }
    this.app.forgetBook(id);
    this.render();
  }
}

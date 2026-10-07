// Lingua Books: the library (the home screen), adding a book (a text, a PDF or photos of pages),
// a book's settings and sharing it with everyone, reports, accounts, and the admin page.
// Everything is kept by the server (web/library.py, web/accounts.py).
import { $, $$, el, icon, store, toast } from './util.js';
import { openDialog, closeDialog } from './media.js';

const KIND = { text: 'Text', pdf: 'PDF', images: 'Photos', disc: 'From the disc' };

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

const when = (t) => new Date(t * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export class Library {
  constructor(app) {
    this.app = app;
    this.scope = store.get('libScope', '');
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
    clearTimeout(this.poll);
  }

  setScope(scope) {
    this.scope = scope;
    store.set('libScope', scope);
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
    clearTimeout(this.poll);
    const scopes = this.scopes();
    if (!scopes.some(([s]) => s === this.scope)) this.scope = this.me.disc ? 'local' : this.user && this.onWebsite ? 'mine' : 'public';
    $$('#library [role=tab]').forEach((t) => {
      t.hidden = !scopes.some(([s]) => s === t.dataset.scope);
      t.setAttribute('aria-selected', String(t.dataset.scope === this.scope));
    });
    this.renderAccount();
    const body = $('#lib-body');
    if (this.scope === 'admin') { this.renderAdmin(gen); return; }
    if (this.scope === 'mine' && !this.user) {
      body.replaceChildren(el('div', { class: 'lib-empty' },
        el('h3', {}, 'Your own books'),
        el('p', {}, 'Make any text, PDF or photo of a page clickable, read aloud and translated. Log in or create a free account to add your books.'),
        el('div', { class: 'lib-actions' },
          el('button', { class: 'btn primary', onclick: () => this.accountDialog('signup') }, 'Create an account'),
          el('button', { class: 'btn', onclick: () => this.accountDialog('login') }, 'Log in'))));
      return;
    }
    let books;
    try {
      books = await api('GET', `/api/books?scope=${this.scope}&q=${encodeURIComponent(this.query)}`);
    } catch (e) {
      if (gen === this.gen) body.replaceChildren(el('div', { class: 'lib-empty' }, e.message));
      return;
    }
    if (gen !== this.gen) return;
    if (!books.length) {
      body.replaceChildren(this.emptyState());
      return;
    }
    body.replaceChildren(el('div', { class: 'lib-grid' }, ...books.map((b) => this.card(b))));
    // Books whose pages are being made: look again in a moment.
    if (books.some((b) => b.status === 'working')) this.poll = setTimeout(() => { if (this.isOpen && gen === this.gen) this.render(); }, 2500);
  }

  emptyState() {
    if (this.query) return el('div', { class: 'lib-empty' }, `No book matches “${this.query}”.`);
    if (this.scope === 'public') {
      return el('div', { class: 'lib-empty' }, el('h3', {}, 'No public books yet'),
        el('p', {}, 'Books that people share with everyone appear here.'),
        this.user ? el('button', { class: 'btn primary', onclick: () => this.addDialog() }, 'Add the first one') : null);
    }
    return el('div', { class: 'lib-empty' }, el('h3', {}, 'No books yet'),
      el('p', {}, 'Add a text, a PDF, or photos of book pages. Every sentence becomes clickable: hear it, translate it, repeat it.'),
      el('button', { class: 'btn primary', html: `${icon('plus')}Add a book`, onclick: () => this.addDialog() }));
  }

  card(b) {
    const badges = [];
    if (b.kind) badges.push(el('span', { class: 'badge' }, KIND[b.kind] || b.kind));
    if (!b.disc && b.mine) badges.push(el('span', { class: `badge ${b.visibility}` }, b.visibility === 'public' ? 'Public' : 'Private'));
    if (b.hidden) badges.push(el('span', { class: 'badge warn' }, 'Hidden by an admin'));
    if (b.licenseName && b.visibility === 'public') badges.push(el('span', { class: 'badge' }, b.licenseName));
    let cover;
    if (b.status === 'ready' && b.cover) cover = el('img', { src: b.cover, alt: '', loading: 'lazy' });
    else if (b.status === 'working') cover = el('div', { class: 'cover-note' }, el('span', { class: 'spinner' }), b.job?.stage || 'Making the pages…');
    else if (b.status === 'error') cover = el('div', { class: 'cover-note err' }, b.error || 'Something went wrong.');
    else cover = el('div', { class: 'cover-note' }, 'Not finished');
    const meta = [b.author, b.pageCount ? `${b.pageCount} page${b.pageCount === 1 ? '' : 's'}` : '', !b.mine && b.owner && !b.disc ? `shared by ${b.owner}` : '']
      .filter(Boolean).join(' · ');
    return el('article', { class: 'book-card', dataset: { id: b.id } },
      el('button', { class: 'bc-cover', 'aria-label': `Open ${b.title}`, onclick: () => this.openBook(b) }, cover),
      el('div', { class: 'bc-body' },
        el('h3', {}, el('button', { class: 'bc-title', onclick: () => this.openBook(b) }, b.title)),
        meta ? el('p', { class: 'bc-meta' }, meta) : null,
        el('p', { class: 'bc-badges' }, ...badges)),
      b.canEdit && !b.disc ? el('button', { class: 'icon-btn small bc-edit', title: 'Settings: title, sharing, delete', 'aria-label': 'Settings',
        html: icon('sliders'), onclick: () => this.settings(b) }) : null);
  }

  openBook(b) {
    if (!b.disc && b.status !== 'ready') {
      if (b.canEdit) this.settings(b);
      return;
    }
    this.app.backStack = []; // "Back" is for links inside a book
    $('#btn-back').hidden = true;
    this.app.go(b.id, store.get(`page.${b.id}`, null) || (b.disc ? b.firstPage : '1') || '1');
  }

  // ---------------------------------------------------------------- Adding a book

  addDialog() {
    if (!this.user) { this.accountDialog('signup', 'Create a free account (or log in) to add your books.'); return; }
    let kind = store.get('addKind', 'text');
    const title = el('input', { type: 'text', class: 'input', maxlength: 120, required: true, placeholder: 'For example: My first story' });
    const author = el('input', { type: 'text', class: 'input', maxlength: 120, placeholder: 'Optional' });
    const text = el('textarea', { class: 'input', rows: 10, placeholder: 'Paste or type the text.\n\nAn empty line starts a new paragraph. A line starting with # is a heading.' });
    const picture = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp' });
    const pdf = el('input', { type: 'file', accept: 'application/pdf,.pdf' });
    const photos = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true });
    const photoNote = el('p', { class: 'hint' }, 'Choose one photo per page. The pages are put in the order of the file names.');
    photos.addEventListener('change', () => {
      const n = photos.files.length;
      photoNote.textContent = n ? `${n} photo${n === 1 ? '' : 's'} chosen.` : 'Choose one photo per page.';
    });
    const parts = {
      text: el('div', {}, el('label', { class: 'field' }, el('span', {}, 'Text'), text),
        el('label', { class: 'field' }, el('span', {}, 'A picture at the top (optional)'), picture)),
      pdf: el('div', {}, el('label', { class: 'field' }, el('span', {}, 'PDF file (at most 300 pages)'), pdf),
        el('p', { class: 'hint' }, 'Pages with text are read from the PDF; scanned pages are read with OCR.')),
      images: el('div', {}, el('label', { class: 'field' }, el('span', {}, 'Photos or scans of the pages'), photos), photoNote,
        el('p', { class: 'hint' }, 'Tip: photograph each page straight from above, in good light.')),
    };
    const seg = el('div', { class: 'seg add-kind', role: 'radiogroup' },
      ...[['text', 'Text'], ['pdf', 'PDF'], ['images', 'Photos of pages']].map(([k, label]) =>
        el('button', { type: 'button', role: 'radio', dataset: { kind: k }, onclick: () => setKind(k) }, label)));
    const setKind = (k) => {
      kind = k;
      store.set('addKind', k);
      $$('button', seg).forEach((b) => b.setAttribute('aria-checked', String(b.dataset.kind === k)));
      Object.entries(parts).forEach(([key, node]) => { node.hidden = key !== k; });
    };
    const msg = el('p', { class: 'form-msg', role: 'alert' });
    const go = el('button', { class: 'btn primary', type: 'submit' }, 'Add the book');
    const form = el('form', { class: 'lib-form' },
      seg,
      el('label', { class: 'field' }, el('span', {}, 'Title'), title),
      el('label', { class: 'field' }, el('span', {}, 'Author'), author),
      ...Object.values(parts),
      el('p', { class: 'hint' }, 'Your book stays private (only you can see it) until you share it. Only share what you have the right to share.'),
      msg,
      el('div', { class: 'form-buttons' }, el('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'Cancel'), go));
    setKind(kind);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.textContent = '';
      const files = kind === 'pdf' ? [...pdf.files] : kind === 'images' ? [...photos.files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })) : [];
      if (!title.value.trim()) { msg.textContent = 'Please give a title.'; title.focus(); return; }
      if (kind === 'text' && !text.value.trim()) { msg.textContent = 'Please add the text.'; text.focus(); return; }
      if (kind !== 'text' && !files.length) { msg.textContent = kind === 'pdf' ? 'Please choose the PDF file.' : 'Please choose the photos.'; return; }
      go.disabled = true;
      try {
        await this.add({ kind, title: title.value, author: author.value, text: text.value, picture: picture.files[0], files }, form);
      } catch (err) {
        msg.textContent = err.message;
        go.disabled = false;
      }
    });
    openDialog('Add a book', form);
    title.focus();
  }

  async add(d, form) {
    const book = await api('POST', '/api/books', { kind: d.kind, title: d.title, author: d.author });
    const bar = el('div', { class: 'rec-progress' }, el('div'));
    const stage = el('p', { class: 'hint' }, 'Sending…');
    form.replaceChildren(el('h3', { class: 'lib-progress-title' }, d.title), bar, stage);
    const show = (frac, text) => { bar.firstChild.style.width = `${Math.round(frac * 100)}%`; stage.textContent = text; };
    const src = (part) => `/api/books/${book.id}/source/${part}`;
    try {
      if (d.kind === 'text') {
        await upload(src('text'), new Blob([JSON.stringify({ text: d.text })], { type: 'application/json' }), () => {});
        if (d.picture) await upload(src('picture'), d.picture, (f) => show(f * 0.3, 'Sending the picture…'));
      } else if (d.kind === 'pdf') {
        await upload(src('pdf'), d.files[0], (f) => show(f * 0.5, `Sending the PDF… ${Math.round(f * 100)}%`));
      } else {
        for (const [k, f] of d.files.entries()) {
          await upload(src(`image-${k}`), f, (x) => show(((k + x) / d.files.length) * 0.5, `Sending photo ${k + 1} of ${d.files.length}…`));
        }
      }
      await api('POST', `/api/books/${book.id}/make`, {});
      for (;;) {
        await new Promise((r) => { setTimeout(r, 800); });
        const j = await api('GET', `/api/books/${book.id}/job`);
        if (j.status === 'ready') break;
        if (j.status === 'error') throw new Error(j.error || 'The pages could not be made.');
        const job = j.job || {};
        show(0.5 + (job.total ? (job.done / job.total) * 0.5 : 0), job.stage || 'Making the pages…');
      }
    } catch (err) {
      form.replaceChildren(el('p', { class: 'form-msg' }, err.message),
        el('div', { class: 'form-buttons' }, el('button', { class: 'btn', type: 'button', onclick: () => { closeDialog(); this.setScope('mine'); } }, 'Close')));
      return;
    }
    closeDialog();
    toast('The book is ready.');
    this.scope = 'mine';
    store.set('libScope', 'mine');
    this.app.go(book.id, '1');
  }

  // ---------------------------------------------------------------- A book's settings, sharing it

  settings(b) {
    const lic = this.me.licenses || {};
    const f = (v) => el('input', { type: 'text', class: 'input', value: v || '', maxlength: 300 });
    const title = f(b.title), author = f(b.author), source = f(b.source);
    const about = el('textarea', { class: 'input', rows: 3, maxlength: 600 });
    about.value = b.about || '';
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
      : el('p', { class: b.status === 'error' ? 'form-msg' : 'hint' }, b.status === 'error' ? `The pages could not be made: ${b.error}` : 'The pages are being made…');
    const form = el('form', { class: 'lib-form' },
      status,
      el('label', { class: 'field' }, el('span', {}, 'Title'), title),
      el('label', { class: 'field' }, el('span', {}, 'Author'), author),
      el('label', { class: 'field' }, el('span', {}, 'About this book (optional)'), about),
      el('label', { class: 'check share-toggle' }, pub, el('b', {}, ' Share with everyone'), ' — it appears in the public library'),
      share,
      b.hidden ? el('p', { class: 'form-msg' }, 'An admin has hidden this book after a report. Only you can see it.') : null,
      msg,
      el('div', { class: 'form-buttons' },
        el('button', { class: 'btn danger-btn', type: 'button', html: `${icon('trash')}Delete`, onclick: () => this.remove(b) }),
        b.status === 'error' ? el('button', { class: 'btn', type: 'button', onclick: () => this.makeAgain(b) }, 'Try again') : null,
        el('span', { class: 'push' }),
        el('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'Cancel'),
        el('button', { class: 'btn primary', type: 'submit' }, 'Save')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.textContent = '';
      const body = { title: title.value, author: author.value, about: about.value, source: source.value,
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

  async remove(b) {
    if (!confirm(`Delete “${b.title}”? Its pages, corrections and settings are removed. This cannot be undone.`)) return;
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

  // ---------------------------------------------------------------- About the open book (page list → About)

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
    box.replaceChildren(el('button', { class: 'btn', html: `${icon('user')}<span>${this.user.name.replace(/[<&>]/g, '')}</span>`,
      title: this.user.email, onclick: () => this.accountMenu() }));
  }

  accountMenu() {
    const u = this.user;
    openDialog('Your account', el('div', { class: 'lib-form' },
      el('p', {}, el('b', {}, u.name), el('br'), u.email, u.admin ? el('span', { class: 'badge' }, 'Admin') : null),
      el('div', { class: 'form-buttons' },
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
    const trap = el('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', class: 'trap', 'aria-hidden': 'true' });
    const nameRow = el('label', { class: 'field' }, el('span', {}, 'Your name (others see it on books you share)'), name);
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
      el('label', { class: 'field' }, el('span', {}, 'E-mail'), email), nameRow,
      el('label', { class: 'field' }, el('span', {}, 'Password (at least 8 characters)'), pw), trap, terms, msg,
      el('div', { class: 'form-buttons' }, el('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'Cancel'), go));
    set(tab);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      go.disabled = true;
      try {
        await api('POST', tab === 'signup' ? '/api/signup' : '/api/login',
          { email: email.value, name: name.value, password: pw.value, website: trap.value });
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

  async renderAdmin(gen) {
    const body = $('#lib-body');
    let reports, books;
    try {
      [reports, books] = await Promise.all([api('GET', '/api/admin/reports'), api('GET', '/api/books?scope=all')]);
    } catch (e) {
      body.replaceChildren(el('div', { class: 'lib-empty' }, e.message));
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
    body.replaceChildren(el('div', { class: 'admin' },
      el('h3', {}, `Reports (${reports.length})`),
      el('p', { class: 'hint' }, 'A book reported by three different people is hidden at once, until you look at it.'),
      table(['Book', 'Reason', 'Shared by', 'Date', ''], reportRows),
      el('h3', {}, `All public books (${books.length})`),
      table(['Book', 'Shared by', 'Licence', 'Changed', ''], bookRows)));
  }

  async moderate(id, action) {
    if (action === 'delete' && !confirm('Delete this book for good? Its owner loses it too.')) return;
    try { await api('POST', `/api/admin/books/${id}`, { action }); } catch (err) { toast(err.message); return; }
    this.app.forgetBook(id);
    this.render();
  }
}

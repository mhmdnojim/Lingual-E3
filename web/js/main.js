import { $, $$, el, icon, store, getJSON, toast, downloadText, typingInField } from './util.js';
import { PageView } from './pageview.js';
import { speech, settings, repeatTimes } from './speech.js';
import { AudioPlayer, openVideo, openSwf, initDialog } from './media.js';
import { Search } from './search.js';
import { TextEditor } from './editor.js';
import { Recordings } from './recordings.js';
import { Translator } from './translation.js';
import { Library } from './library.js';
import { Follower, followSettings, setFollow } from './follow.js';

const RATIO = 1984 / 2496;
const NEEDS_API = 6; // server features this page needs (API_VERSION in web/server.py)
const CHUNK_UNITS = 10; // sentences (or clauses) read in one go, for a smooth flow
const CHUNK_CHARS = 1500;
const MODES = ['sentence', 'clause', 'word', 'off'];
const DOUBLE_CLICK_MS = 280; // a click in the Text list waits this long in case it is a double click
// With a login (phones on the home Wi-Fi, a web host): when it has run out, go to the login page.
const realFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const r = await realFetch(...args);
  if (r.status === 401 && (await r.clone().json().catch(() => ({}))).login) {
    location.href = `/web/login.html?next=${encodeURIComponent(location.pathname)}`;
  }
  return r;
};

/** Phone-sized screen (the layout in app.css changes at the same width). */
const isPhone = () => matchMedia('(max-width: 700px)').matches;

/**
 * Reads the page aloud. Clicking a sentence (or clause) reads from there to the end of the
 * page. Clicking the one being read pauses; clicking it again continues. Clicking another
 * one starts again from there. In word mode only the clicked word is read.
 * "Repeat each sentence" (voice settings) reads every sentence 1-10 times, or again and again.
 */
class Reader {
  constructor(app) {
    this.app = app;
    this.state = 'idle'; // 'idle' | 'playing' | 'paused'
    this.queue = [];
    this.pos = 0;
    this.active = null;
    this.lastWord = -1;
    $('#reading-stop').addEventListener('click', () => this.stop());
    $('#reading-toggle').addEventListener('click', () => this.toggle());
  }

  get busy() { return this.state !== 'idle'; }

  click(view, unit, fromPage) {
    const a = this.active;
    if (this.busy && a && a.view === view && a.unit.a === unit.a && a.unit.b === unit.b) this.toggle();
    else this.start(view, unit, fromPage);
  }

  start(view, unit, fromPage = false) {
    if (!speech.supported) { toast('This browser cannot read text aloud.'); return; }
    this.app.audio.pause();
    this.clear();
    this.app.views.forEach((v) => v.showActive(null)); // e.g. the sentence kept after correcting
    if (unit.mode === 'word') {
      this.queue = [{ view, unit }];
    } else {
      const views = this.app.views;
      for (let k = views.indexOf(view); k < views.length; k++) {
        const v = views[k];
        if (!v.text) continue;
        for (let i = v === view ? unit.i : 0; i < v.text.count(unit.mode); i++) {
          this.queue.push({ view: v, unit: v.text.unit(unit.mode, i) });
        }
      }
    }
    this.pos = 0;
    this.round = 1; // the how-many-th time the current sentence is being read
    this.state = 'playing';
    if (fromPage) this.app.showTab('text');
    this.next(fromPage);
  }

  next(center = true) {
    if (this.pos >= this.queue.length) { this.stop(); return; }
    const item = this.queue[this.pos];
    this.setActive(item, center);
    this.speakFrom(this.pos, item.unit.a);
  }

  /**
   * Speak from queue unit `pos`, starting at word `from` (later than the unit start after a pause).
   *
   * Each request to a voice takes a moment to start (the online Natural voices wait for
   * Microsoft's server), so speaking sentence by sentence leaves a gap after each one. Up to
   * CHUNK_UNITS units of the same page are therefore spoken in one go; the voice's word
   * positions tell which sentence is being read, so the highlight still moves along.
   * One unit at a time is used when a pause between sentences is wanted, when sentences are
   * repeated, in word mode, and for voices that do not report word positions.
   */
  speakFrom(pos, from) {
    const first = this.queue[pos];
    const view = first.view, text0 = view.text;
    const single = first.unit.mode === 'word' || Number(settings.gap) > 0 || repeatTimes() !== 1 || !speech.reportsWords();
    const parts = []; // [{k: queue index, at: start in the spoken text}]
    const starts = []; // word start positions in the spoken text
    let text = '';
    for (let k = pos; k < this.queue.length && parts.length < (single ? 1 : CHUNK_UNITS); k++) {
      const it = this.queue[k];
      if (it.view !== view) break;
      const sp = text0.speech(k === pos ? Math.max(it.unit.a, from) : it.unit.a, it.unit.b);
      if (parts.length && text.length + sp.text.length > CHUNK_CHARS) break;
      parts.push({ k, at: text ? text.length + 1 : 0 });
      if (!sp.text) continue;
      if (text) text += ' ';
      const base = text.length;
      for (const s of sp.starts) starts.push({ w: s.w, at: base + s.at });
      // End every sentence (and heading) with a stop, so the voice makes its normal short pause.
      text += /[.!?;:…]["'”’)\]]*$/.test(sp.text) || first.unit.mode !== 'sentence' ? sp.text : `${sp.text}.`;
    }
    const lastK = parts[parts.length - 1].k;
    this.lastWord = from;
    if (!text) { this.pos = lastK; this.finished(); return; }
    this.app.readingChanged(this.state, this.label());
    let heardWords = false;
    speech.speak(text, {
      onWord: (ci) => {
        heardWords = true;
        let k = parts[0].k;
        for (const p of parts) if (p.at <= ci) k = p.k;
        if (k !== this.pos) { // the voice has moved on to the next sentence
          this.pos = k;
          this.setActive(this.queue[k], true);
          this.app.readingChanged(this.state, this.label());
        }
        const w = text0.wordAtChar(starts, ci);
        this.lastWord = w;
        if (settings.follow) this.app.showWord(view, w);
      },
      onEnd: () => {
        if (this.state !== 'playing') return;
        if (!heardWords && parts.length > 1) speech.markNoWords(); // read sentence by sentence from now on
        this.pos = lastK;
        this.finished();
      },
      onError: (e) => { toast(`The voice stopped (${e.error || 'error'}). Try another voice.`); this.stop(); },
      onFallback: (v) => { if (!this.saidOffline) toast(`No internet: reading with ${v.name}`); this.saidOffline = true; },
    });
  }

  /**
   * The current unit has been read. If it is to be repeated, read it again; else go on with the
   * next one. Before that, wait the "pause between sentences" chosen in the voice settings (the
   * sentence stays highlighted, the bar counts down).
   */
  finished() {
    const item = this.queue[this.pos];
    if (item) this.app.showWord(item.view, -1);
    if (item && this.round < repeatTimes()) this.round++; // once more (the setting is read each time, so it can change while reading)
    else {
      this.round = 1;
      this.pos++;
    }
    if (this.pos >= this.queue.length) { this.stop(); return; }
    const gap = Math.round((Number(settings.gap) || 0) * 1000);
    if (!gap) { this.next(); return; }
    this.waitUntil = Date.now() + gap;
    this.tickWait();
  }

  tickWait() {
    const left = this.waitUntil - Date.now();
    if (left <= 0) {
      this.waitUntil = 0;
      this.next();
      return;
    }
    const what = this.queue[this.pos].unit.mode === 'clause' ? 'part' : 'sentence';
    const msg = this.round > 1 ? `Again (${this.roundLabel()}) in` : `Next ${what} in`;
    this.app.readingChanged(this.state, `${msg} ${Math.ceil(left / 1000)} s`, true);
    this.waitTimer = setTimeout(() => this.tickWait(), Math.min(250, left));
  }

  label() {
    const item = this.queue[this.pos];
    if (!item) return '';
    const where = this.queue.length > 1 ? `page ${item.view.page.n} · ${this.pos + 1} of ${this.queue.length}` : `page ${item.view.page.n}`;
    return repeatTimes() === 1 ? where : `${where} · ${this.roundLabel()}`;
  }

  /** "2nd time of 3", or "4th time" when it repeats again and again. */
  roundLabel() {
    const n = this.round, times = repeatTimes();
    const th = n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th';
    return times === Infinity ? `${n}${th} time, ∞` : `${n}${th} time of ${times}`;
  }

  toggle() {
    if (this.state === 'playing') this.pause();
    else if (this.state === 'paused') this.resume();
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    if (this.waitUntil) { // paused during the silence after a sentence
      clearTimeout(this.waitTimer);
      this.waitUntil = 0;
      this.betweenUnits = true;
    }
    speech.stop();
    this.app.readingChanged(this.state, this.label());
  }

  resume() {
    if (this.state !== 'paused') return;
    const item = this.queue[this.pos];
    if (!item) { this.stop(); return; }
    this.state = 'playing';
    if (this.betweenUnits) { // the last sentence was finished: go on with the next one
      this.betweenUnits = false;
      this.next();
      return;
    }
    // Go on from the word that was being spoken (or the start, if the voice reports no words).
    this.speakFrom(this.pos, Math.max(item.unit.a, Math.min(this.lastWord, item.unit.b - 1)));
  }

  setActive(item, center) {
    if (this.active) {
      this.active.view.showActive(null);
      this.app.showWord(this.active.view, -1);
    }
    this.active = item;
    this.app.markPanel('active', item?.view, item?.unit);
    if (item) {
      this.app.focus = { view: item.view, w: item.unit.a };
      item.view.showActive(item.unit);
      // Keep it in view on the page (and in the Text list), unless the person is looking elsewhere.
      this.app.follower.reading(item.view, item.unit, center);
    }
  }

  clear() {
    speech.stop();
    clearTimeout(this.waitTimer);
    this.waitUntil = 0;
    this.betweenUnits = false;
    this.setActive(null);
    this.queue = [];
  }

  stop() {
    const was = this.busy;
    this.state = 'idle';
    this.clear();
    if (was) this.app.readingChanged('idle');
  }
}

class App {
  async init() {
    this.me = await fetch('/api/me', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!this.me) {
      $('#spread').replaceChildren(el('div', { class: 'empty' },
        'The app could not reach its server. Start it with “Start Lingua Books.bat” instead of opening this file directly.'));
      return;
    }
    this.checkServer();
    this.books = new Map(); // book id -> Promise of the book with its pages (from /api/books/<id>)
    this.discList = this.me.disc ? await fetch('/api/books?scope=local').then((r) => r.json()).catch(() => []) : [];
    this.views = [];
    this.group = [];
    this.book = null;
    this.idx = 0;
    this.backStack = [];
    this.marked = {};
    this.panelWords = new Map();
    this.spreadOn = store.get('spread', false);
    // Phones start at "fit width" (a whole page would be too small to read).
    this.zoom = { mode: store.get('zoomMode', isPhone() ? 'width' : 'page'), w: store.get('zoomW', 900) };

    this.audio = new AudioPlayer(this);
    this.reader = new Reader(this);
    this.search = new Search(this);
    this.editor = new TextEditor(this);
    this.recordings = new Recordings(this);
    this.translator = new Translator(this);
    this.library = new Library(this);
    this.follower = new Follower(this);
    initDialog();

    this.bindToolbar();
    this.bindVoice();
    this.bindFollow();
    this.bindDrawer();
    this.bindPanel();
    this.bindTouch();
    this.bindKeys();
    this.setMode(store.get('mode', 'sentence'));
    this.setPanelOpen(store.get('panel', true));

    new ResizeObserver(() => this.applyZoom()).observe($('#stage'));
    window.addEventListener('hashchange', () => this.route());
    // No address of a page: the book read last, else the library.
    const last = store.get('last', null);
    if (!this.parseHash() && last && location.hash !== '#/') history.replaceState(null, '', `#/${last.book}/${last.page}`);
    this.route();
  }

  /** A book with its pages (the server tells what it may show), or null. */
  loadBook(id) {
    if (!this.books.has(id)) {
      const p = fetch(`/api/books/${encodeURIComponent(id)}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      p.then((b) => { if (!b) this.books.delete(id); });
      this.books.set(id, p);
    }
    return this.books.get(id);
  }

  forgetBook(id) { this.books.delete(id); }

  /** The open book changed (its settings, or who is logged in): load it again, same page. */
  async reloadBook() {
    if (!this.book || this.library.isOpen) return;
    this.forgetBook(this.book.id);
    const page = this.book.pages[this.idx]?.n;
    const book = await this.loadBook(this.book.id);
    if (!book) { this.goHome(); return; }
    this.book = null; // shown again
    this.show(book, Math.max(0, book.pages.findIndex((x) => x.n === page)));
  }

  /** Logged in or out: what may be done changes. */
  accountChanged() {
    this.books.clear();
    this.recordings.load();
    this.translator.loadLanguages?.();
    if (this.book && !this.library.isOpen) this.reloadBook();
  }

  goHome() {
    if (location.hash !== '#/') history.pushState(null, '', '#/');
    return this.route();
  }

  /** After an update the page is new but an older server may still run: say how to fix it. */
  async checkServer() {
    const v = await fetch('/api/version', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!v || v.api < NEEDS_API) $('#update-notice').hidden = false;
  }

  // ---------- Navigation ----------

  parseHash() {
    const m = location.hash.match(/^#\/(\w+)\/([^/?]+)/);
    return m ? { book: m[1], page: decodeURIComponent(m[2]) } : null;
  }

  async route() {
    const r = this.parseHash();
    const opts = this.pendingOpts || {};
    this.pendingOpts = null;
    if (!r) { this.library.open(); return; }
    const book = await this.loadBook(r.book);
    if (this.parseHash()?.book !== r.book) return; // went somewhere else meanwhile
    if (!book) {
      toast('This book does not exist, or is not shared any more.');
      store.set('last', null);
      this.goHome();
      return;
    }
    this.library.close();
    let idx = book.pages.findIndex((p) => p.n === r.page);
    if (idx < 0) idx = 0;
    this.show(book, idx, opts);
  }

  go(bookId, pageN, opts = {}) {
    if (opts.fromLink && this.book) {
      this.backStack.push({ book: this.book.id, page: this.book.pages[this.idx].n });
      $('#btn-back').hidden = false;
    }
    this.pendingOpts = opts;
    const hash = `#/${bookId}/${encodeURIComponent(pageN)}`;
    if (location.hash !== hash) history.pushState(null, '', hash);
    return this.route(); // callers can wait for it, then for this.pageReady
  }

  groupFor(book, idx) {
    if (!this.spreadOn) return [idx];
    const start = idx === 0 ? 0 : idx % 2 === 1 ? idx : idx - 1; // page 1 alone, then 2-3, 4-5 ...
    return start === 0 ? [0] : [start, start + 1].filter((i) => i < book.pages.length);
  }

  step(dir) {
    if (!this.book) return;
    const g = this.group;
    const target = dir > 0 ? g[g.length - 1] + 1 : g[0] - 1;
    if (target < 0 || target >= this.book.pages.length) return;
    this.go(this.book.id, this.book.pages[target].n);
  }

  show(book, idx, opts = {}) {
    const group = this.groupFor(book, idx);
    const same = this.book === book && group.join() === this.group.join();
    this.idx = idx;
    if (!same) {
      this.reader.stop();
      this.editor.commitText();
      this.editor.cancelMarking();
      this.editor.flush();
      const newBook = this.book !== book;
      this.book = book;
      this.group = group;
      const hooks = {
        onHover: (v, u) => this.hover(v, u),
        onClick: (v, u, e) => this.pageClick(v, u, e),
        onHotspot: (v, a) => this.hotspot(v, a),
      };
      if (newBook) this.bookShown(book);
      this.views = group.map((i) => new PageView(book, book.pages[i], hooks));
      this.applyMode();
      const spread = $('#spread');
      spread.classList.toggle('two', this.views.length === 2);
      spread.replaceChildren(...this.views.map((v) => v.el));
      this.applyZoom();
      $('#stage').scrollTo(0, 0);
      this.marked = {};
      $('#text-view').replaceChildren(el('div', { class: 'empty' }, 'Loading text…'));
      if (this.audio.asset) this.markPlaying(this.audio.asset, !this.audio.audio.paused);
      this.preload();
    }
    this.updateToolbar();
    store.set('last', { book: book.id, page: book.pages[idx].n });
    store.set('page.' + book.id, book.pages[idx].n);

    const views = this.views;
    this.pageReady = Promise.all(views.map((v) => v.ready)).then(() => {
      if (this.views !== views) return;
      if (!same) {
        if (this.editor.active) this.editor.pagesChanged();
        this.renderPanelText();
        this.recordings.pageShown();
      }
      if (opts.find) this.findOnPage(opts.find);
    });
  }

  preload() {
    const pages = this.book.pages;
    const around = [this.group[0] - 1, this.group[this.group.length - 1] + 1, this.group[this.group.length - 1] + 2];
    for (const i of around) {
      if (i >= 0 && i < pages.length) new Image().src = pages[i].img;
    }
  }

  /** Another book is opened: its name, what may be done with it, its details. */
  bookShown(book) {
    $('#book-name').textContent = book.type;
    document.body.classList.toggle('readonly', book.canEdit === false); // only the owner corrects the text
    document.body.classList.toggle('disc-book', !!book.disc);
    this.library.renderAbout(book);
    this.renderResources(book);
    $('#search-all').closest('label').hidden = !book.disc; // "all three books": the disc only
  }

  findOnPage(query) {
    for (const v of this.views) {
      const s = v.text?.findSentence(query) ?? -1;
      if (s >= 0) {
        const unit = v.text.sentenceUnit(s);
        v.flash(unit);
        requestAnimationFrame(() => { this.reveal(v, unit, true); this.centerPanel(v, unit); });
        return;
      }
    }
  }

  /** A click on the text of a page image. */
  pageClick(view, unit, e) {
    if (this.editor.active) this.editor.selectAtWord(view, unit.a);
    else if (this.recordings.picking) this.recordings.pageClick(view, unit, e);
    else {
      this.unitClick(view, unit, true);
      // A touch screen cannot point at a sentence: a tap also shows its translation (if shown on the page).
      if (view.touch) this.translator.showTip(view, unit);
    }
  }

  /**
   * A click on a sentence (or clause, or word) to hear it: from a My audio MP3 that reads it
   * (no internet needed), else with the live voice (the reader falls back to an offline
   * voice without internet).
   */
  async unitClick(view, unit, fromPage) {
    const a = this.reader.active;
    if (this.reader.busy && a?.view === view && a.unit.a === unit.a && a.unit.b === unit.b) {
      this.reader.toggle(); // the sentence being read live: pause / continue
      return;
    }
    const hit = await this.recordings.locate(view, unit);
    if (hit) {
      this.reader.stop();
      await this.recordings.playFrom(hit, fromPage);
      return;
    }
    this.reader.click(view, unit, fromPage);
  }

  // ---------- Toolbar ----------

  bindToolbar() {
    $('#btn-prev').addEventListener('click', () => this.step(-1));
    $('#btn-next').addEventListener('click', () => this.step(1));
    $('#btn-back').addEventListener('click', () => {
      const b = this.backStack.pop();
      $('#btn-back').hidden = this.backStack.length === 0;
      if (b) this.go(b.book, b.page);
    });

    const input = $('#page-input');
    input.addEventListener('focus', () => input.select());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const n = input.value.trim().split(/[–-]/)[0];
        const p = this.book.pages.find((pg) => pg.n === n);
        if (p) { this.go(this.book.id, p.n); input.blur(); } else toast(`There is no page ${n} in the ${this.book.type}.`);
      }
      if (e.key === 'Escape') { this.updateToolbar(); input.blur(); }
    });
    input.addEventListener('blur', () => this.updateToolbar());

    $('#btn-zoom-in').addEventListener('click', () => this.zoomBy(1.2));
    $('#btn-zoom-out').addEventListener('click', () => this.zoomBy(1 / 1.2));
    $('#btn-fit').addEventListener('click', () => this.toggleFit());
    $('#btn-spread').addEventListener('click', () => this.setSpread(!this.spreadOn));
    $('#btn-spread').setAttribute('aria-pressed', String(this.spreadOn));

    $('#stage').addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
    }, { passive: false });

    $$('#mode-seg button').forEach((b) => b.addEventListener('click', () => this.setMode(b.dataset.mode)));
    $('#btn-panel').addEventListener('click', () => this.setPanelOpen(document.body.classList.contains('panel-closed')));
  }

  updateToolbar() {
    if (!this.book) return;
    const pages = this.book.pages;
    const first = pages[this.group[0]].n, last = pages[this.group[this.group.length - 1]].n;
    if (document.activeElement !== $('#page-input')) $('#page-input').value = first === last ? first : `${first}–${last}`;
    $('#page-input').style.width = `${Math.max(3.2, String($('#page-input').value).length * 0.62 + 1)}em`;
    $('#page-total').textContent = `/ ${pages.length}`;
    $('#btn-prev').disabled = this.group[0] === 0;
    $('#btn-next').disabled = this.group[this.group.length - 1] >= pages.length - 1;
    document.title = `${this.book.type} p.${first} · Lingua Books`;
    this.updateThumbs();
  }

  setSpread(on) {
    this.spreadOn = on;
    store.set('spread', on);
    $('#btn-spread').setAttribute('aria-pressed', String(on));
    this.group = [];
    if (this.book) this.show(this.book, this.idx);
  }

  setMode(mode) {
    if (!MODES.includes(mode)) mode = 'sentence';
    this.mode = mode;
    store.set('mode', mode);
    $$('#mode-seg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
    this.applyMode();
  }

  /** Apply the click mode to the pages. While correcting text, clicks always pick sentences. */
  applyMode() {
    const mode = this.editor?.active || this.recordings?.picking ? 'sentence' : this.mode;
    document.body.classList.toggle('mode-on', mode !== 'off');
    this.views.forEach((v) => { v.setMode(mode); v.showHover(null); });
    this.markPanel('hover', null, null);
  }

  // ---------- Zoom ----------

  applyZoom() {
    const stage = $('#stage');
    if (!stage.clientWidth) return;
    const n = Math.max(1, this.views.length);
    const cs = getComputedStyle($('#spread')); // the space around the pages (smaller on phones)
    const availW = this.fitWidth() * n;
    const availH = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - 22;
    let w;
    const pg = this.views[0]?.page;
    const ratio = pg?.w && pg?.h ? pg.w / pg.h : RATIO; // pages of library books have their own size
    if (this.zoom.mode === 'page') w = Math.min(availH * ratio, availW / n);
    else if (this.zoom.mode === 'width') w = availW / n;
    else w = this.zoom.w;
    w = Math.round(Math.max(160, Math.min(5000, w)));
    $('#spread').style.setProperty('--page-w', `${w}px`);
    this.pageW = w;
  }

  /** The width of one page for "fit width" (the stage minus the space around the pages). */
  fitWidth() {
    const cs = getComputedStyle($('#spread'));
    const avail = $('#stage').clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return avail / Math.max(1, this.views.length);
  }

  zoomBy(f) {
    const st = $('#stage');
    const cx = (st.scrollLeft + st.clientWidth / 2) / st.scrollWidth;
    const cy = (st.scrollTop + st.clientHeight / 2) / st.scrollHeight;
    this.zoom = { mode: 'custom', w: Math.max(160, Math.min(5000, this.pageW * f)) };
    store.set('zoomMode', 'custom');
    store.set('zoomW', this.zoom.w);
    this.applyZoom();
    st.scrollLeft = cx * st.scrollWidth - st.clientWidth / 2;
    st.scrollTop = cy * st.scrollHeight - st.clientHeight / 2;
  }

  toggleFit() {
    const mode = this.zoom.mode === 'page' ? 'width' : 'page';
    this.zoom = { mode, w: this.pageW };
    store.set('zoomMode', mode);
    this.applyZoom();
    toast(mode === 'page' ? 'Fit whole page' : 'Fit page width', 1200);
  }

  layoutChanged() { requestAnimationFrame(() => this.applyZoom()); }

  /** Scroll the page area so a unit is comfortably visible (or centred). Reading: follower.reading. */
  reveal(view, unit, center = false) { this.follower.reveal(view, unit, center); }

  /** Scroll the text list so a unit sits in the middle of it. */
  centerPanel(view, unit, smooth = true) {
    const spans = this.panelWords.get(view);
    const first = spans?.[unit.a];
    if (!first) return;
    const last = spans[unit.b - 1] || first;
    const tr = last.nextElementSibling?.classList.contains('tr') ? last.nextElementSibling : null;
    this.centerInPanel(first, tr || last, smooth);
  }

  /** Show a sentence as the current one (highlighted and centred) without reading it. */
  setFocus(view, unit, smooth = true) {
    this.focus = { view, w: unit.a };
    view.showActive(unit);
    this.markPanel('active', view, unit);
    this.centerPanel(view, unit, smooth);
  }

  /**
   * The sentence the user is on: the one being read, else the last one read, clicked or
   * corrected, else the one in the middle of the text list. Returns {view, w: word index}.
   */
  currentFocus() {
    const a = this.reader.active;
    if (a) return { view: a.view, w: a.unit.a };
    if (this.focus && this.views.includes(this.focus.view) && this.focus.view.text) return this.focus;
    const tv = $('#text-view'), box = tv.closest('.tab-body');
    if (box.hidden || document.body.classList.contains('panel-closed')) return null;
    const b = box.getBoundingClientRect(), t = tv.getBoundingClientRect();
    const bar = [...box.querySelectorAll('.panel-actions')].find((x) => !x.hidden);
    const mid = (b.top + (bar ? bar.offsetHeight : 0) + b.bottom) / 2;
    for (const dy of [0, 14, -14, 28, -28, 44, -44]) {
      for (const x of [t.left + 30, t.left + t.width / 2]) {
        const span = document.elementFromPoint(x, mid + dy)?.closest?.('.w');
        const view = span && this.views[Number(span.closest('p')?.dataset.v)];
        if (view) return { view, w: Number(span.dataset.w) };
      }
    }
    return null;
  }

  centerInPanel(first, last = first, smooth = true) {
    const box = $('#text-view').closest('.tab-body');
    if (box.hidden || document.body.classList.contains('panel-closed')) return;
    const b = box.getBoundingClientRect(), r1 = first.getBoundingClientRect(), r2 = last.getBoundingClientRect();
    // The visible list starts below the pinned action bar.
    const bar = [...box.querySelectorAll('.panel-actions')].find((x) => !x.hidden);
    const top = b.top + (bar ? bar.offsetHeight : 0);
    const mid = (r1.top + r2.bottom) / 2;
    this.follower.listTo(box.scrollTop + mid - (top + b.bottom) / 2, smooth);
  }

  // ---------- Highlights ----------

  hover(view, unit) {
    if (this.mode === 'off' && !this.editor.active) unit = null;
    this.views.forEach((v) => v.showHover(v === view ? unit : null));
    this.markPanel('hover', view, unit);
    if (unit) this.translator.showTip(view, unit); else this.translator.hideTip();
  }

  showWord(view, w) {
    view.showWord(w);
    this.markPanel('cur', view, w >= 0 ? { a: w, b: w + 1 } : null);
    this.follower?.wordShown(view, w); // the word at the top of the page, if it is off the screen
  }

  markPanel(cls, view, unit) {
    (this.marked[cls] || []).forEach((s) => s.classList.remove(cls));
    const list = [];
    const spans = view && unit ? this.panelWords.get(view) : null;
    if (spans) {
      for (let w = unit.a; w < unit.b; w++) {
        if (spans[w]) { spans[w].classList.add(cls); list.push(spans[w]); }
      }
      if (cls === 'active' && view.text) { // and the translations of its sentences
        const vi = this.views.indexOf(view);
        for (let s = view.text.w2s[unit.a]; s >= 0 && s <= view.text.w2s[unit.b - 1]; s++) {
          const tr = document.querySelector(`#text-view .tr[data-v="${vi}"][data-s="${s}"]`);
          if (tr) { tr.classList.add(cls); list.push(tr); }
        }
      }
    }
    this.marked[cls] = list;
    if (cls === 'active') this.lastActive = view && unit ? { view, unit } : null;
  }

  /** Mark the current sentence again (after the translations were added to the text list). */
  remarkActive() {
    if (this.lastActive && this.views.includes(this.lastActive.view)) this.markPanel('active', this.lastActive.view, this.lastActive.unit);
  }

  /** Update the reading bar and button. `waiting`: label is the countdown between sentences. */
  readingChanged(state, label = '', waiting = false) {
    const pill = $('#reading-pill');
    pill.hidden = state === 'idle';
    if (state === 'idle') this.follower.stopped();
    pill.classList.toggle('paused', state === 'paused' || waiting);
    $('#reading-label').textContent = waiting ? label : state === 'paused' ? `Paused · ${label}` : `Reading ${label}`;
    $('#reading-toggle').innerHTML = state === 'paused' ? `${icon('play')}Continue` : `${icon('pause')}Pause`;
    $('#read-page').innerHTML = state === 'playing' ? `${icon('pause')}Pause`
      : state === 'paused' ? `${icon('play')}Continue` : `${icon('play')}Read page aloud`;
  }

  // ---------- Hotspots ----------

  hotspot(view, a) {
    if (a.t === 'audio') this.audio.play(a);
    else if (a.t === 'video') openVideo(this, a);
    else if (a.t === 'swf') openSwf(this, a);
    else if (a.t === 'link') {
      this.go(a.book || this.book.id, a.page, { fromLink: true });
    }
  }

  markPlaying(asset, on) {
    if (!asset) return;
    this.views.forEach((v) => v.markPlaying(asset, on));
    this.recordings.markPlaying(asset, on);
  }

  /** The audio player's position: recordings made in the app highlight the text as they play. */
  onAudioTime(asset, ms) {
    if (asset?.rec) this.recordings.follow(asset.rec, ms);
    else this.recordings.unfollow();
  }

  toast(msg) { toast(msg); }

  // ---------- Side panel ----------

  bindPanel() {
    $$('.panel [role=tab]').forEach((t) => t.addEventListener('click', () => {
      // Phones: the panel is a sheet at the bottom. A tab opens it; the open tab closes it again.
      if (isPhone()) {
        const closed = document.body.classList.contains('panel-closed');
        if (!closed && t.getAttribute('aria-selected') === 'true') { this.setPanelOpen(false); return; }
        if (closed) this.setPanelOpen(true);
      }
      this.showTab(t.dataset.tab);
    }));
    this.bindSheet();

    const tv = $('#text-view');
    const unitFromEvent = (e) => {
      if (this.editor.active) return null;
      const span = e.target.closest?.('.w');
      const p = span?.closest('p');
      if (!span || !p) return null;
      const view = this.views[Number(p.dataset.v)];
      const unit = view?.text?.unitAt(Number(span.dataset.w), this.mode);
      return unit ? { view, unit } : null;
    };
    tv.addEventListener('pointerover', (e) => {
      const hit = unitFromEvent(e);
      if (hit) this.hover(hit.view, hit.unit);
    });
    tv.addEventListener('pointerleave', () => { if (!this.editor.active) this.hover(null, null); });
    let pending = null, tapLine = null, tapAt = 0;
    // Double click (or double tap on a phone) on a sentence: correct its text right here.
    const correct = (line) => {
      clearTimeout(pending);
      tapLine = null;
      if (this.editor.inline?.line === line) return;
      window.getSelection()?.removeAllRanges();
      this.editor.editInline(this.views[Number(line.dataset.v)], Number(line.dataset.b), Number(line.dataset.s));
    };
    tv.addEventListener('click', (e) => {
      const line = !this.editor.active && e.target.closest('.w') && e.target.closest('.sline');
      const now = performance.now();
      // Phones do not always report a double tap as a double click, so taps are timed too.
      if (line && (e.detail > 1 || (line === tapLine && now - tapAt < DOUBLE_CLICK_MS + 100))) { correct(line); return; }
      tapLine = line;
      tapAt = now;
      if (this.mode === 'off' || window.getSelection()?.toString()) return; // allow selecting text to copy
      const hit = unitFromEvent(e);
      if (!hit) return;
      clearTimeout(pending);
      // Wait a moment first: if a second click follows, it is a double click, not "read".
      pending = setTimeout(() => this.unitClick(hit.view, hit.unit, false), DOUBLE_CLICK_MS);
    });
    tv.addEventListener('mousedown', (e) => { if (e.detail > 1 && e.target.closest('.sline .w')) e.preventDefault(); }); // no word selection
    tv.addEventListener('dblclick', (e) => {
      const line = !this.editor.active && e.target.closest('.w') && e.target.closest('.sline');
      if (line) correct(line);
    });

    $('#read-page').addEventListener('click', () => {
      if (this.reader.busy) { this.reader.toggle(); return; }
      const v = this.views.find((x) => x.text && !x.text.empty);
      if (!v) { toast('There is no text to read on this page.'); return; }
      this.reader.start(v, v.text.unit(this.mode === 'clause' ? 'clause' : 'sentence', 0));
    });
    $('#copy-text').addEventListener('click', () => this.copyText());
    $('#save-text').addEventListener('click', () => {
      const pages = this.views.map((v) => v.page.n).join('-');
      downloadText(`${this.book.type} p${pages}.txt`, this.pageText());
    });
    $('#save-book-text').addEventListener('click', async () => {
      const idx = await getJSON(`/api/search/${this.book.slug}`);
      if (!idx?.length) { toast('No text has been extracted for this book yet.'); return; }
      downloadText(`${this.book.type} - all text.txt`, idx.map((p) => `--- Page ${p.p} ---\n${p.t}`).join('\n\n'));
    });
  }

  showTab(name) {
    $$('.panel [role=tab]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    $$('.panel .tab-body').forEach((b) => { b.hidden = b.dataset.tab !== name; });
  }

  setPanelOpen(open) {
    document.body.classList.toggle('panel-closed', !open);
    $('#btn-panel').setAttribute('aria-pressed', String(open));
    store.set('panel', open);
    this.layoutChanged();
  }

  /** Phones: drag the bar on top of the panel sheet to make it taller or shorter; a tap opens or closes it. */
  bindSheet() {
    const handle = $('#sheet-handle'), panel = $('#panel');
    let drag = null;
    handle.addEventListener('pointerdown', (e) => {
      drag = { y: e.clientY, h: panel.getBoundingClientRect().height, moved: false, id: e.pointerId };
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dy = drag.y - e.clientY;
      if (!drag.moved && Math.abs(dy) < 5) return;
      drag.moved = true;
      if (document.body.classList.contains('panel-closed')) this.setPanelOpen(true);
      const max = panel.parentElement.getBoundingClientRect().height - 80; // keep some of the page in view
      panel.style.setProperty('--sheet-h', `${Math.round(Math.max(70, Math.min(max, drag.h + dy)))}px`);
      this.layoutChanged();
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const { moved } = drag;
      drag = null;
      if (!moved) { this.setPanelOpen(document.body.classList.contains('panel-closed')); return; }
      if (panel.getBoundingClientRect().height < 120) { // pulled almost down: closed (only the tabs)
        panel.style.removeProperty('--sheet-h');
        this.setPanelOpen(false);
      }
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  /**
   * Touch screens: swipe left or right on the page to turn it (when it is not wider than the
   * screen, or at its edge), pinch with two fingers to zoom. A touch elsewhere closes the
   * translation popup of the last tapped sentence.
   */
  bindTouch() {
    const st = $('#stage');
    let pinch = null, swipe = null;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    st.addEventListener('touchstart', (e) => {
      this.translator.hideTip();
      if (e.touches.length === 2) {
        swipe = null;
        const r = st.getBoundingClientRect();
        const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left;
        const my = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top;
        // The point of the page between the fingers stays between them while zooming.
        pinch = { d: dist(e.touches), w0: this.pageW, w: this.pageW, mx, my,
          fx: (st.scrollLeft + mx) / st.scrollWidth, fy: (st.scrollTop + my) / st.scrollHeight };
      } else if (e.touches.length === 1 && !pinch) {
        swipe = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now(), left: st.scrollLeft };
      }
    }, { passive: true });
    st.addEventListener('touchmove', (e) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault(); // no scrolling while pinching
      pinch.w = Math.max(160, Math.min(5000, (pinch.w0 * dist(e.touches)) / pinch.d));
      if (this.pinchFrame) return;
      this.pinchFrame = requestAnimationFrame(() => {
        this.pinchFrame = 0;
        if (!pinch) return;
        this.zoom = { mode: 'custom', w: pinch.w };
        this.applyZoom();
        st.scrollLeft = pinch.fx * st.scrollWidth - pinch.mx;
        st.scrollTop = pinch.fy * st.scrollHeight - pinch.my;
      });
    }, { passive: false });
    st.addEventListener('touchend', (e) => {
      if (pinch) {
        if (e.touches.length) return;
        // Close to the width of the screen: "fit width", which also follows turning the phone.
        const fit = this.fitWidth();
        this.zoom = Math.abs(pinch.w - fit) <= fit * 0.06 ? { mode: 'width', w: fit } : { mode: 'custom', w: pinch.w };
        this.applyZoom();
        store.set('zoomMode', this.zoom.mode);
        store.set('zoomW', this.zoom.w);
        pinch = null;
        return;
      }
      const s = swipe;
      swipe = null;
      if (!s || e.touches.length) return;
      const t = e.changedTouches[0], dx = t.clientX - s.x, dy = t.clientY - s.y;
      if (Date.now() - s.t > 700 || Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
      if (Math.abs(st.scrollLeft - s.left) > 2) return; // the page scrolled sideways: not a swipe
      if (dx < 0 && st.scrollLeft + st.clientWidth >= st.scrollWidth - 2) this.step(1);
      else if (dx > 0 && st.scrollLeft <= 2) this.step(-1);
    }, { passive: true });
    st.addEventListener('touchcancel', () => { pinch = null; swipe = null; }, { passive: true });
  }

  renderPanelText() {
    this.recordings.renderSpots();
    if (this.editor.active) { this.editor.render(); return; }
    this.panelWords = new Map();
    this.marked = {};
    const out = [];
    this.views.forEach((v, vi) => {
      if (this.views.length > 1) out.push(el('h4', {}, `Page ${v.page.n}`));
      if (!v.text || v.text.empty) {
        const msg = v.page.blank ? 'This page is not included on the original disc.'
          : v.text ? 'No text was found on this page.' : 'The text of this page has not been extracted yet.';
        out.push(el('div', { class: 'empty' }, msg));
        return;
      }
      const spans = [];
      const words = v.text.words;
      v.text.blocks.forEach(([sa, sb], bi) => {
        const p = el('p', { dataset: { v: vi } });
        for (let s = sa; s < sb; s++) {
          // Each sentence on a line of its own (its translation goes under it), with its number on
          // the left; the number turns into dots to drag the sentence when the pointer is over it.
          const line = el('span', { class: 'sline', dataset: { v: vi, b: bi, s: s - sa } },
            el('span', { class: 'grip', title: 'Drag to move this sentence', html: `<span class="num">${s + 1}</span>${icon('grip')}` }));
          const [a, b] = v.text.sent[s];
          for (let w = a; w < b; w++) {
            const sp = document.createElement('span');
            sp.className = 'w';
            sp.dataset.w = w;
            // The trailing space belongs to the word so highlights have no gaps.
            sp.textContent = words[w][4] + (words[w][6] || w === b - 1 ? ' ' : '');
            spans[w] = sp;
            line.append(sp);
          }
          p.append(line);
        }
        out.push(p);
      });
      this.panelWords.set(v, spans);
    });
    if (out.some((x) => x.tagName === 'P')) {
      out.push(el('p', { class: 'list-hint' }, 'Double-click a sentence to correct it. Drag the dots on its left to move it.'));
    }
    $('#text-view').classList.remove('editing');
    $('#text-view').replaceChildren(...out);
    return this.translator?.decoratePanel();
  }

  /** A sentence was moved or corrected in the Text list: draw it again and keep that sentence in the middle. */
  textChanged(view, unit) {
    this.reader.stop(); // its word positions belong to the old text
    const translated = this.renderPanelText();
    if (!unit || !this.views.includes(view)) return;
    this.setFocus(view, unit, false);
    translated?.then(() => { if (this.focus?.view === view && this.focus.w === unit.a) this.centerPanel(view, unit, false); });
  }

  pageText() {
    return this.views.map((v) => {
      const head = this.views.length > 1 ? `Page ${v.page.n}\n` : '';
      const trs = v.text && this.translator.ready(v);
      if (!trs) return head + (v.text?.fullText() || '');
      // Translations shown: each sentence followed by its translation.
      return head + v.text.blocks.map(([sa, sb]) => {
        const lines = [];
        for (let s = sa; s < sb; s++) lines.push(v.text.text(...v.text.sent[s]), trs[s] || '');
        return lines.filter(Boolean).join('\n');
      }).join('\n\n');
    }).join('\n\n');
  }

  async copyText() {
    const text = this.pageText();
    if (!text.trim()) { toast('There is no text on this page.'); return; }
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = el('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('Page text copied');
  }

  // ---------- Drawer (pages + resources) ----------

  bindDrawer() {
    $('#btn-pages').addEventListener('click', () => this.setDrawer($('#drawer').hidden));
    $('#drawer-close').addEventListener('click', () => this.setDrawer(false));
    $$('#drawer [role=tab]').forEach((t) => t.addEventListener('click', () => {
      $$('#drawer [role=tab]').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
      $$('#drawer .drawer-body').forEach((b) => { b.hidden = b.dataset.dtab !== t.dataset.dtab; });
    }));
  }

  /** The disc's resources (PDF and PowerPoint files) in the page list's second tab. */
  renderResources(book) {
    $('#res-list').replaceChildren(...(book.resources || []).map((r) => el('li', {},
      el('a', { href: r.src, target: '_blank', rel: 'noopener', download: r.kind === 'pdf' ? null : '', html:
        `${icon('file')}<span>${r.title.replace(/[&<>]/g, '')}</span><span class="kind">${r.kind}</span>` }))));
  }

  setDrawer(open) {
    $('#drawer').hidden = !open;
    $('#btn-pages').setAttribute('aria-expanded', String(open));
    if (open) {
      this.renderThumbs();
      $('#thumbs .current')?.scrollIntoView({ block: 'center' });
    }
    this.layoutChanged();
  }

  renderThumbs() {
    const box = $('#thumbs');
    if (box.dataset.book === this.book.id) { this.updateThumbs(); return; }
    box.dataset.book = this.book.id;
    box.replaceChildren(...this.book.pages.map((p, i) => {
      const b = el('button', { class: p.blank ? 'thumb blank' : 'thumb', dataset: { i }, title: p.blank ? `Page ${p.n} (not on the disc)` : `Page ${p.n}` },
        el('img', { loading: 'lazy', alt: '', src: p.thumb }),
        p.n);
      b.addEventListener('click', () => {
        this.go(this.book.id, p.n);
        if (innerWidth < 980) this.setDrawer(false);
      });
      return b;
    }));
    this.updateThumbs();
  }

  updateThumbs() {
    const box = $('#thumbs');
    if (!this.book || box.dataset.book !== this.book.id) return;
    $$('.thumb.current', box).forEach((t) => t.classList.remove('current'));
    this.group.forEach((i) => box.children[i]?.classList.add('current'));
  }

  // ---------- Following the reading (settings, Follow tab) ----------

  bindFollow() {
    const on = $('#follow-on'), list = $('#follow-list'), speed = $('#follow-speed'), wait = $('#follow-wait');
    this.syncFollowSettings = () => {
      on.checked = followSettings.on;
      list.checked = followSettings.list;
      speed.value = followSettings.speed;
      wait.value = followSettings.wait;
      $('#follow-speed-out').textContent = followSettings.speed ? `${(followSettings.speed / 1000).toFixed(1)} s` : 'jump at once';
      $('#follow-wait-out').textContent = `${followSettings.wait} s`;
      $$('#follow-where button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.where === followSettings.where)));
      $('#follow-body')?.classList.toggle('off', !followSettings.on);
    };
    on.addEventListener('change', () => { if (on.checked !== followSettings.on) this.follower.toggle(); });
    list.addEventListener('change', () => setFollow('list', list.checked));
    speed.addEventListener('input', () => { setFollow('speed', Number(speed.value)); this.syncFollowSettings(); });
    wait.addEventListener('input', () => { setFollow('wait', Number(wait.value)); this.syncFollowSettings(); });
    $$('#follow-where button').forEach((b) => b.addEventListener('click', () => { setFollow('where', b.dataset.where); this.syncFollowSettings(); }));
    this.syncFollowSettings();
  }

  // ---------- Voice popover ----------

  bindVoice() {
    const pop = $('#voice-pop'), btn = $('#btn-voice');
    const sel = $('#voice-select'), rate = $('#rate-input'), out = $('#rate-out'), follow = $('#follow-input');
    const place = () => {
      const r = btn.getBoundingClientRect();
      pop.style.left = `${Math.max(8, Math.min(innerWidth - 348, r.right - 340))}px`;
    };
    const setOpen = (open) => {
      pop.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      if (open) place();
    };
    btn.addEventListener('click', (e) => { e.stopPropagation(); setOpen(pop.hidden); });
    document.addEventListener('click', (e) => { if (!pop.hidden && !pop.contains(e.target)) setOpen(false); });
    this.closeVoice = () => setOpen(false);
    // Two tabs: Voice and Translation (the last one used opens again).
    const showTab = (name) => {
      $$('#voice-pop [data-ptab]').forEach((x) => {
        if (x.matches('[role=tab]')) x.setAttribute('aria-selected', String(x.dataset.ptab === name));
        else x.hidden = x.dataset.ptab !== name;
      });
      store.set('settingsTab', name);
    };
    $$('#voice-pop [role=tab]').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.ptab)));
    showTab(store.get('settingsTab', 'voice'));
    /** Open the settings on one tab ('voice' or 'translation'). */
    this.openSettings = (tab) => { showTab(tab); setOpen(true); };
    // With a login: "Log out" at the bottom of the settings.
    fetch('/api/session').then((r) => r.json()).then((d) => { $('#logout-row').hidden = !d.login; }).catch(() => {});
    $('#btn-logout').addEventListener('click', async () => {
      await fetch('/api/logout', { method: 'POST' }).catch(() => {});
      location.href = '/web/login.html';
    });

    speech.onVoices((voices) => {
      if (!speech.supported) {
        sel.replaceChildren(el('option', {}, 'Not available'));
        $('#voice-hint').textContent = 'This browser cannot read text aloud. Use Microsoft Edge or Google Chrome.';
        return;
      }
      if (!voices.length) { sel.replaceChildren(el('option', {}, 'Loading voices…')); return; }
      const current = speech.currentVoice();
      sel.replaceChildren(...voices.map((v) => el('option', { value: v.voiceURI, selected: v === current },
        `${v.name.replace(/^Microsoft /, '').replace(/ - English.*$/, '')} (${v.lang})`)));
      $('#voice-hint').textContent = voices.some((v) => /natural/i.test(v.name))
        ? 'Voices marked “Natural” sound best but need an internet connection.'
        : 'Tip: open this app in Microsoft Edge for more natural-sounding voices.';
    });
    sel.addEventListener('change', () => speech.setVoice(sel.value));
    rate.value = settings.rate;
    out.textContent = `${Number(settings.rate).toFixed(2).replace(/0$/, '')}×`;
    rate.addEventListener('input', () => {
      speech.setRate(Number(rate.value));
      out.textContent = `${Number(rate.value).toFixed(2).replace(/0$/, '')}×`;
    });
    follow.checked = settings.follow;
    follow.addEventListener('change', () => speech.setFollow(follow.checked));
    const gap = $('#gap-input'), gapOut = $('#gap-out');
    const showGap = () => { gapOut.textContent = Number(gap.value) ? `${Number(gap.value)} s` : 'none'; };
    gap.value = settings.gap;
    showGap();
    gap.addEventListener('input', () => { speech.setGap(Number(gap.value)); showGap(); });
    // Repeat each sentence: the slider here (1-10, ∞) and the repeat button in the top bar
    // (each click: 2, 3, 4, 5 times, ∞, then once again) change the same setting.
    const rp = $('#repeat-input'), rpOut = $('#repeat-out'), rpBtn = $('#btn-repeat'), rpBadge = $('#repeat-badge');
    const repeatNow = () => (Number(settings.repeat) === 0 ? 0 : Math.max(1, Math.min(10, Number(settings.repeat) || 1))); // 0 = ∞
    const showRepeat = () => {
      const n = repeatNow();
      const text = n === 0 ? '∞ until you stop' : n === 1 ? 'once' : `${n} times`;
      rp.value = n === 0 ? 11 : n;
      rpOut.textContent = text;
      rpBadge.hidden = n === 1;
      rpBadge.textContent = n === 0 ? '∞' : String(n);
      rpBadge.classList.toggle('inf', n === 0);
      rpBtn.setAttribute('aria-pressed', String(n !== 1));
      rpBtn.setAttribute('aria-label', `Repeat each sentence: ${text}`);
      const next = n === 0 ? 'once' : n >= 5 ? '∞' : `${n + 1} times`;
      rpBtn.title = `Repeat each sentence: ${text}. Click for ${next} (R)`;
    };
    this.setRepeat = (n) => { speech.setRepeat(n); showRepeat(); };
    /** The repeat button (or R): once → 2 → 3 → 4 → 5 → ∞ → once. */
    this.cycleRepeat = () => {
      const n = repeatNow();
      const next = n === 0 ? 1 : n >= 5 ? 0 : n + 1;
      this.setRepeat(next);
      toast(`Repeat each sentence: ${next === 0 ? '∞ (again and again until you stop)' : next === 1 ? 'once' : `${next} times`}`, 1500);
    };
    showRepeat();
    rp.addEventListener('input', () => this.setRepeat(Number(rp.value) >= 11 ? 0 : Number(rp.value)));
    rpBtn.addEventListener('click', () => this.cycleRepeat());
    $('#voice-test').addEventListener('click', () => {
      this.reader.stop();
      speech.speak('Hello! This is how I will read the book to you.');
    });
  }

  // ---------- Keyboard ----------

  bindKeys() {
    document.addEventListener('keydown', (e) => {
      if ($('#media-dialog').open) return; // the dialog handles Esc itself
      if (e.key === 'Escape') {
        if (this.editor.escape()) return;
        if (this.recordings.picking) { this.recordings.stopPicking(); return; }
        if (this.reader.busy) this.reader.stop();
        else if (!$('#voice-pop').hidden) this.closeVoice();
        else if (!$('#drawer').hidden) this.setDrawer(false);
        return;
      }
      if (typingInField()) return;
      // Undo the last correction (also one made in the Text list by dragging or double-clicking).
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); this.editor.undo(); return; }
      if (this.editor.active) {
        if (!e.ctrlKey && !e.metaKey && !e.altKey) {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); this.editor.step(e.key === 'ArrowDown' ? 1 : -1); return; }
          if (e.key === 'Delete' && this.editor.sel) { e.preventDefault(); this.editor.tool('delete'); return; }
          // Enter (or F2): change the text of the selected sentence (not when a button has the focus).
          if ((e.key === 'Enter' || e.key === 'F2') && this.editor.sel && !e.defaultPrevented && !e.target.closest?.('button, a, select')) {
            e.preventDefault();
            this.editor.tool('edit');
            return;
          }
        }
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      if (k === 'ArrowLeft' || k === 'PageUp') { e.preventDefault(); this.step(-1); }
      else if (k === 'ArrowRight' || k === 'PageDown') { e.preventDefault(); this.step(1); }
      else if (k === 'Home') this.go(this.book.id, this.book.pages[0].n);
      else if (k === 'End') this.go(this.book.id, this.book.pages[this.book.pages.length - 1].n);
      else if (k === '+' || k === '=') this.zoomBy(1.2);
      else if (k === '-' || k === '_') this.zoomBy(1 / 1.2);
      else if (k === '0') this.toggleFit();
      else if (k >= '1' && k <= '4') this.setMode(MODES[Number(k) - 1]);
      else if (k === 'p' || k === 'P') this.setDrawer($('#drawer').hidden);
      else if (k === 't' || k === 'T') this.setPanelOpen(document.body.classList.contains('panel-closed'));
      else if (k === 's' || k === 'S') this.setSpread(!this.spreadOn);
      else if (k === 'e' || k === 'E') { if (this.editor.active) this.editor.stop(); else this.editor.start(); }
      else if (k === 'l' || k === 'L') this.translator.setList(!(this.translator.listOn && this.translator.lang));
      else if (k === 'r' || k === 'R') this.cycleRepeat();
      else if (k === 'f' || k === 'F') this.follower.toggle();
      else if (k === '/') { e.preventDefault(); $('#search-input').focus(); }
      else if (k === ' ') {
        if (this.reader.busy) { e.preventDefault(); this.reader.toggle(); }
        else if (this.audio.open) { e.preventDefault(); this.audio.toggle(); }
      }
    });
  }
}

const app = new App();
window.aef = app; // handy for debugging in the browser console
app.init();

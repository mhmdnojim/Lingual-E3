import { $, $$, el, icon, store, getJSON, toast, downloadText, typingInField } from './util.js';
import { PageView, HOLD_MS } from './pageview.js';
import { speech, settings, repeatTimes, chineseKind } from './speech.js';
import { AudioPlayer, openVideo, openSwf, initDialog } from './media.js';
import { Search } from './search.js';
import { TextEditor } from './editor.js';
import { Recordings } from './recordings.js';
import { Translator } from './translation.js';
import { Library } from './library.js';
import { Follower, followSettings, setFollow } from './follow.js';
import { Words } from './words.js';
import { Breakdown } from './breakdown.js';

const RATIO = 1984 / 2496;
const NEEDS_API = 31; // server features this page needs (API_VERSION in web/server.py)
const CHUNK_UNITS = 10; // sentences (or clauses) read in one go, for a smooth flow
const CHUNK_CHARS = 1500;
const MODES = ['sentence', 'clause', 'word', 'off'];
const FIT_UNITS = ['paragraph', 'sentence', 'word']; // the fit button after the page and its width
const FIT_MIN = { paragraph: 0.3, sentence: 0.35, word: 0.15 }; // fitted as if at least this part of the page wide
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

/** The phone's layout (js/device.js: automatic, or chosen in the Screen tab; app.css follows it). */
const isPhone = () => (window.linguaDevice ? window.linguaDevice.isPhone() : matchMedia('(max-width: 700px)').matches);

const VOICE_SAMPLES = {
  en: 'Hello! This is how I will read the book to you.',
  zh: '你好！我会这样给你读这本书。',
  both: 'Hello! This is how I will read the book to you. 你好！我会这样给你读这本书。',
};
const CHINESE_KINDS = { mandarin: 'Mandarin', taiwan: 'Taiwan Mandarin', regional: 'regional accent', cantonese: 'Cantonese, not Mandarin' };
const NO_CHINESE_VOICE = 'No Chinese voice on this device: the Chinese cannot be read. Open the app in Microsoft Edge (natural Chinese voices), '
  + 'or add Chinese to the speech of the device (Windows: Settings → Time & language → Speech; Android: Text-to-speech output; '
  + 'iPhone and iPad: Accessibility → Spoken Content → Voices).';

/** The English and Chinese voice lists of the settings, best first, and a hint about them. */
function fillVoices(sel, zhSel, recordings = null) {
  const short = (v) => v.name.replace(/^Microsoft /, '').replace(/ - (English|Chinese).*$/, '');
  const fill = (select, language, none, label) => {
    const list = speech.voicesFor(language), current = speech.currentVoice(language);
    select.replaceChildren(...(list.length
      ? [true, false].map((local) => {
        const matching = list.filter((v) => !!v.localService === local);
        return matching.length ? el('optgroup', { label: local ? 'Device voices — offline' : 'Online voices' },
          ...matching.map((v) => el('option', { value: v.voiceURI, selected: v === current }, label(v)))) : null;
      }).filter(Boolean)
      : [el('option', { value: '' }, none)]));
  };
  fill(sel, 'en', 'No English voice on this device', (v) => `${short(v)} (${v.lang}) · ${recordings?.voiceAvailability(v).label || (v.localService ? 'offline on device' : 'checking')}`);
  fill(zhSel, 'zh', 'No Chinese voice on this device', (v) => `${short(v)} · ${CHINESE_KINDS[chineseKind(v)]} (${v.lang})`);
  const zh = speech.currentVoice('zh');
  $('#voice-hint').textContent = !zh
    ? 'No Chinese voice: Chinese cannot be read well. Open this app in Microsoft Edge (natural Chinese voices), or add Chinese in the Windows Settings: Time & language → Speech.'
    : chineseKind(zh) !== 'mandarin'
      ? `${short(zh)} does not speak standard Mandarin. Choose a voice marked “Mandarin” for the pronunciation of the book.`
      : !/natural/i.test(zh.name) && speech.voicesFor('zh').some((v) => /natural/i.test(v.name) && chineseKind(v) === 'mandarin')
        ? 'Voices marked “Natural” (Xiaoxiao, Yunxi) sound best; they need an internet connection.'
        : 'Chinese characters are read by the Chinese voice, everything else by the English voice. Pinyin with tone marks is skipped. “Natural” voices sound best but need an internet connection.';
}

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
    this.ticket = 0; // a translation being fetched or read is dropped when this changes (pause, stop)
    this.trSaid = false; // the current sentence's translation has been read
    this.phase = null; // 'translation' while one is read
    this.told = new Set(); // what was told already in this reading (tellOnce)
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
    const queue = [];
    if (unit.mode === 'word') {
      queue.push({ view, unit });
    } else {
      const views = this.app.views;
      for (let k = views.indexOf(view); k < views.length; k++) {
        const v = views[k];
        if (!v.text) continue;
        for (let i = v === view ? unit.i : 0; i < v.text.count(unit.mode); i++) {
          queue.push({ view: v, unit: v.text.unit(unit.mode, i) });
        }
      }
    }
    this.startList(queue, fromPage);
  }

  /** Read these ([{view, unit}]) one after the other: from a sentence to the end, or the sentences of an area of the page. */
  startList(queue, fromPage = false) {
    if (!speech.supported) { toast('This browser cannot read text aloud.'); return; }
    if (!queue.length) return;
    this.app.audio.pause();
    this.clear();
    this.app.views.forEach((v) => v.showActive(null)); // e.g. the sentence kept after correcting
    this.queue = queue;
    this.pos = 0;
    this.round = 1; // the how-many-th time the current sentence is being read
    this.state = 'playing';
    this.saidTrProblem = false;
    this.told = new Set();
    if (fromPage) this.app.showTab('text');
    this.next(fromPage);
  }

  next(center = true) {
    if (this.pos >= this.queue.length) { this.stop(); return; }
    const item = this.queue[this.pos];
    this.setActive(item, center);
    if (this.trOrder === 'before' && !this.trSaid) { this.sayTranslation(item, () => this.speakFrom(this.pos, item.unit.a)); return; }
    this.speakFrom(this.pos, item.unit.a);
  }

  /** Read each sentence's translation too: 'before' or 'after' it, or 'off' (voice settings). */
  get trOrder() { return this.app.translator?.lang ? settings.trOrder : 'off'; }

  /**
   * Read the translation of the current sentence (or clause, or word) with the voice of its
   * language, then go on with `then`. Without a translation or a voice for it, go on at once.
   */
  async sayTranslation(item, then) {
    const t = this.app.translator, ticket = ++this.ticket;
    this.trSaid = true;
    this.phase = 'translation'; // (paused now: read the translation again when continuing)
    this.app.showWord(item.view, -1);
    this.app.readingChanged(this.state, `${t.name || 'Translation'} · ${this.label()}`);
    const goOn = () => { if (ticket === this.ticket && this.state === 'playing') { this.phase = null; then(); } };
    let text = '';
    try { text = await t.textFor(item.view, item.unit); } catch (err) { this.trProblem(err.message || 'The translation could not be fetched.'); }
    if (ticket !== this.ticket || this.state !== 'playing') return;
    if (!text) { goOn(); return; }
    const spoken = speech.speakTranslation(text, t.lang, {
      onEnd: goOn,
      onError: (e) => { this.trProblem(`The ${t.name} voice stopped (${e.error || 'error'}).`); goOn(); },
      onFallback: (v) => { if (!this.saidOffline) toast(`No internet: reading with ${v.name}`); this.saidOffline = true; },
    });
    if (!spoken) { this.trProblem(`No voice on this device reads ${t.name}. Choose another browser (Microsoft Edge has most languages).`); goOn(); }
  }

  /** Tell once per reading why a translation was not read (the sentences go on). */
  trProblem(message) {
    if (!this.saidTrProblem) toast(message);
    this.saidTrProblem = true;
  }

  /**
   * Speak from queue unit `pos`, starting at word `from` (later than the unit start after a pause).
   *
   * Each request to a voice takes a moment to start (the online Natural voices wait for
   * Microsoft's server), so speaking sentence by sentence leaves a gap after each one. Up to
   * CHUNK_UNITS units of the same page are therefore spoken in one go; the voice's word
   * positions tell which sentence is being read, so the highlight still moves along.
   * One unit at a time is used when a pause between sentences is wanted, when sentences are
   * repeated, when their translations are read too, in word mode, and for voices that do not
   * report word positions.
   */
  speakFrom(pos, from) {
    const first = this.queue[pos];
    const view = first.view, text0 = view.text;
    const single = first.unit.mode === 'word' || Number(settings.gap) > 0 || repeatTimes() !== 1 || !speech.reportsWords()
      || this.trOrder !== 'off';
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
      // End every sentence (and heading) with a stop, so the voice makes its normal short pause
      // (a Chinese one after Chinese: the Chinese voice would read "." after 。).
      text += /[.!?;:…。！？；：]["'”’)\]）」』》]*$/.test(sp.text) || first.unit.mode !== 'sentence' ? sp.text
        : `${sp.text}${/[㐀-鿿]$/u.test(sp.text) ? '。' : '.'}`;
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
      onSkipped: (language) => this.tellOnce(`skip-${language}`, language === 'zh'
        ? 'The Chinese is not read: “EN” (English only) is chosen in the top bar. Choose 中+EN or 中 to hear it.'
        : 'The English is not read: “中” (Chinese only) is chosen in the top bar. Choose 中+EN or EN to hear it.'),
      onNoVoice: (language) => this.tellOnce(`voice-${language}`, language === 'zh' ? NO_CHINESE_VOICE : 'No English voice on this device.'),
    });
  }

  /** Tell something once per reading (a sentence skipped, no voice for its language), as a message that stays a while. */
  tellOnce(key, message) {
    if (this.told.has(key)) return;
    this.told.add(key);
    toast(message, 6000);
  }

  /**
   * The current unit has been read. If it is to be repeated, read it again; else go on with the
   * next one. Before that, wait the "pause between sentences" chosen in the voice settings (the
   * sentence stays highlighted, the bar counts down).
   */
  finished() {
    const item = this.queue[this.pos];
    if (item) this.app.showWord(item.view, -1);
    if (item && this.trOrder === 'after' && !this.trSaid) { this.sayTranslation(item, () => this.finished()); return; }
    this.trSaid = false; // (a sentence and its translation are repeated together)
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
    this.ticket++;
    speech.stop();
    this.app.readingChanged(this.state, this.label());
  }

  resume() {
    if (this.state !== 'paused') return;
    const item = this.queue[this.pos];
    if (!item) { this.stop(); return; }
    this.state = 'playing';
    if (this.phase === 'translation') { // paused during a translation: read it again
      this.phase = null;
      this.trSaid = false;
      if (this.trOrder === 'before') this.next();
      else this.finished();
      return;
    }
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
    this.ticket++;
    this.trSaid = false;
    this.phase = null;
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
    this.words = new Words(this); // new words: collecting them, flashcards
    this.breakdown = new Breakdown(this); // a sentence broken down: each word and its meaning
    this.library = new Library(this);
    this.follower = new Follower(this);
    initDialog();

    this.bindToolbar();
    this.bindVoice();
    this.bindFollow();
    this.bindDrawer();
    this.bindPanel();
    this.bindDevice();
    this.bindTouch();
    this.bindKeys();
    this.setMode(store.get('mode', 'sentence'));
    this.setPanelOpen(store.get('panel', true));

    new ResizeObserver(() => { // (fit paragraph, sentence or word: fitted again, and in the middle again)
      if (FIT_UNITS.includes(this.zoom.mode) && this.fitted && this.views.includes(this.fitted.view)) this.fitTo(this.fitted);
      else this.applyZoom();
    }).observe($('#stage'));
    window.addEventListener('hashchange', () => this.route());
    // No address of a page (or of the library): the book read last, else the library.
    const last = store.get('last', null);
    if (!this.parseHash() && last && location.hash !== '#/' && !location.hash.startsWith('#/@/')) history.replaceState(null, '', `#/${last.book}/${last.page}`);
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

  /** The library, in the branch it was in last. */
  goHome() {
    const home = this.library.homeHash();
    if (location.hash !== home) history.pushState(null, '', home);
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
    const current = this.parseHash();
    if (current?.book !== r.book || current?.page !== r.page) return; // a newer navigation won the race
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
        onHold: (v, u) => this.holdUnit(v, u),
        onHotspot: (v, a) => this.hotspot(v, a),
      };
      if (newBook) this.bookShown(book);
      this.views = group.map((i) => new PageView(book, book.pages[i], hooks));
      this.applyMode();
      const spread = $('#spread');
      spread.classList.toggle('two', this.views.length === 2);
      spread.replaceChildren(...this.views.map((v) => v.el));
      this.setSlack();
      this.applyZoom();
      $('#stage').scrollTo(0, 0);
      this.marked = {};
      $('#text-view').replaceChildren(el('div', { class: 'empty' }, 'Loading text…'));
      if (this.audio.asset) this.markPlaying(this.audio.asset, !this.audio.audio.paused);
      this.preload();
    }
    this.updateToolbar(true);
    this.recordings.syncPageOfflineVoice();
    this.recordings.renderPageOfflineFiles();
    this.updateVoiceOfflineStatus?.(); // do not retain the preceding page's badge while text loads
    store.set('last', { book: book.id, page: book.pages[idx].n });
    store.set('page.' + book.id, book.pages[idx].n);

    const views = this.views;
    this.pageReady = Promise.all(views.map((v) => v.ready)).then(() => {
      if (this.views !== views) return;
      if (!same) {
        if (FIT_UNITS.includes(this.zoom.mode)) { // fit paragraph, sentence or word: the one being read, else the first one
          const a = this.reader.active, kind = this.zoom.mode;
          const u = (a && views.includes(a.view) && this.fitUnitAt(a.view, a.unit.a, kind))
            || views.map((view) => (view.text?.sent.length ? this.fitUnitAt(view, view.text.sent[0][0], kind) : null)).find(Boolean);
          if (u) this.fitTo(u);
        }
        if (this.editor.active) this.editor.pagesChanged();
        this.renderPanelText();
        this.recordings.pageShown();
        this.translator?.pageShown();
        this.words.pageShown();
        this.breakdown.place();
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
  /** Where the "read which language" choice is kept: one for Chinese books, one for the others. */
  languageModeKey() { return (this.book?.language || '').startsWith('zh') ? 'speechLanguageMode.zh' : 'speechLanguageMode'; }

  bookShown(book) {
    $('#book-name').textContent = book.type;
    this.setLanguageMode?.(store.get(this.languageModeKey(), 'both')); // (this book's kind: Chinese or not)
    this.translator.setBook(book); // (translated from its language: a Chinese book into English, unless another is chosen)
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
    if (this.audio.wordMapSelection) this.audio.mapBookWord(view, Number(e.target.dataset.w));
    else if (this.audio.mapCueIndex != null) this.audio.mapSentence(view, unit);
    else if (this.words.collecting) this.words.toggle(view, unit); // adding new words: no reading
    else if (this.editor.active) this.editor.selectAtWord(view, unit.a, e);
    else if (this.recordings.picking) this.recordings.pageClick(view, unit, e);
    else if (e.detail > 1 && !view.touch) return; // (the second click of a double click: the sentence broken down, holdUnit)
    else {
      this.unitClick(view, unit, true);
      // A tap has to show translations on touch screens; in Word mode a click also pins the gloss.
      if (view.touch || unit.mode === 'word') this.translator.showTip(view, unit);
    }
  }

  /** A sentence double-clicked (a finger held on it, on a phone or tablet): broken down — each word, its meaning (and pinyin). */
  holdUnit(view, unit) {
    if (this.editor.active || this.recordings.picking || this.words.collecting || this.audio.wordMapSelection || this.audio.mapCueIndex != null) return;
    window.getSelection()?.removeAllRanges(); // (a double click selects a word)
    const s = this.breakdown.sentenceOf(view, unit);
    if (s) this.breakdown.open(s);
  }

  /** A text click follows an active saved recording when it contains the sentence; otherwise it reads normally. */
  unitClick(view, unit, fromPage) {
    const clickId = ++this.recordings.pageClickId;
    if (this.recordings.deselectFromPage(view, unit)) return;
    const readNormally = () => {
      if (clickId !== this.recordings.pageClickId) return;
      const readLive = () => {
        if (clickId !== this.recordings.pageClickId) return;
        const a = this.reader.active;
        if (this.reader.busy && a?.view === view && a.unit.a === unit.a && a.unit.b === unit.b) {
          this.reader.toggle(); // the sentence being read live: pause / continue
          return;
        }
        this.reader.click(view, unit, fromPage);
      };
      // Prefer an imported copy when its saved voice matches the selected live voice.
      this.recordings.playOfflineForUnit(view, unit, fromPage).then((playedOffline) => {
        if (!playedOffline) readLive();
      }).catch(() => readLive());
    };
    if (this.recordings.modeId) {
      const id = this.recordings.modeId;
      const selectedRec = this.recordings.selectedRec;
      if (selectedRec?.id === id && !this.recordings.containsUnit(view, unit, selectedRec)) {
        this.recordings.stopModeForLiveRead(id);
        readNormally();
        return;
      }
      this.recordings.locate(view, unit, id).then((hit) => {
        if (clickId !== this.recordings.pageClickId || this.recordings.modeId !== id) return;
        if (hit) {
          this.recordings.playFrom(hit, fromPage);
          return;
        }
        this.recordings.stopModeForLiveRead(id);
        readNormally();
      }).catch(() => {
        if (clickId !== this.recordings.pageClickId || this.recordings.modeId !== id) return;
        this.recordings.stopModeForLiveRead(id);
        readNormally();
      });
      return;
    }
    readNormally();
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

  updateToolbar(forcePage = false) {
    if (!this.book) return;
    const pages = this.book.pages;
    const first = pages[this.group[0]].n, last = pages[this.group[this.group.length - 1]].n;
    if (forcePage || document.activeElement !== $('#page-input')) $('#page-input').value = first === last ? first : `${first}–${last}`;
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
    if (this.words?.collecting) this.words.renderMarks(); // ("click words / clauses / sentences")
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
    const sl = this.slack || {};
    const availH = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) + (sl.t || 0) + (sl.b || 0) - 22;
    let w;
    const pg = this.views[0]?.page;
    const ratio = pg?.w && pg?.h ? pg.w / pg.h : RATIO; // pages of library books have their own size
    if (this.zoom.mode === 'page') w = Math.min(availH * ratio, availW / n);
    else if (this.zoom.mode === 'width') w = availW / n;
    else if (FIT_UNITS.includes(this.zoom.mode)) w = this.fitZoom() || availW / n; // (nothing fitted yet: the width)
    else w = this.zoom.w;
    w = Math.round(Math.max(160, Math.min(5000, w)));
    $('#spread').style.setProperty('--page-w', `${w}px`);
    this.pageW = w;
  }

  /** The width of one page for "fit width" (the stage minus the space around the pages). */
  fitWidth() {
    const cs = getComputedStyle($('#spread'));
    const sl = this.slack || {};
    const avail = $('#stage').clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) + (sl.l || 0) + (sl.r || 0);
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
    // The sentence you are on stays in the middle of the screen (without one, the middle stays the middle).
    const s = this.activeSentence();
    if (s && this.centerOn(s)) return;
    this.setSlack();
    st.scrollLeft = cx * st.scrollWidth - st.clientWidth / 2;
    st.scrollTop = cy * st.scrollHeight - st.clientHeight / 2;
  }

  /**
   * The sentence you are on — being read (or played from an MP3), else read, clicked or corrected
   * last — while its page is shown: {view, a, b} (its words), or null.
   */
  activeSentence() {
    const r = this.reader.active, f = r ? { view: r.view, w: r.unit.a } : this.focus;
    const t = f && this.views.includes(f.view) ? f.view.text : null, s = t?.w2s[f.w];
    return s >= 0 ? { view: f.view, a: t.sent[s][0], b: t.sent[s][1] } : null;
  }

  /**
   * Scroll so `y` (a part of a page: {view, a, b}) is in the middle of the screen up and down (its
   * top, if it is taller than the screen), and `x` (the same, or another part) from side to side.
   */
  centerOn(y, x = y, ms = 0, { sideways = true } = {}) {
    const by = this.fitBox(y), bx = this.fitBox(x);
    if (!by || !bx) return false;
    const st = $('#stage');
    /** The scroll that puts them there. */
    const want = () => {
      const sr = st.getBoundingClientRect();
      const place = (u, b) => {
        const pr = u.view.el.getBoundingClientRect(), s = pr.width / u.view.W;
        return { left: pr.left - sr.left + st.scrollLeft + b.x0 * s, top: pr.top - sr.top + st.scrollTop + b.y0 * s, w: (b.x1 - b.x0) * s, h: (b.y1 - b.y0) * s };
      };
      const Y = place(y, by), X = place(x, bx);
      return { top: Y.h > st.clientHeight - 32 ? Y.top - 16 : Y.top + Y.h / 2 - st.clientHeight / 2, left: X.left + X.w / 2 - st.clientWidth / 2 };
    };
    // Near the edge of a page (or with the page smaller than the screen) there is no scrolling far
    // enough: room is made past the edge, as much as needed. (Centred pages move half as far: again.)
    this.setSlack();
    let to = want();
    for (let k = 0; k < 8; k++) {
      const maxT = st.scrollHeight - st.clientHeight, maxL = st.scrollWidth - st.clientWidth;
      const need = { t: Math.max(0, -to.top), b: Math.max(0, to.top - maxT),
        l: sideways ? Math.max(0, -to.left) : 0, r: sideways ? Math.max(0, to.left - maxL) : 0 };
      if (need.t + need.b + need.l + need.r < 1) break;
      this.setSlack({ t: this.slack.t + need.t, r: this.slack.r + need.r, b: this.slack.b + need.b, l: this.slack.l + need.l });
      to = want();
    }
    this.follower.stage.scrollTo(to.top, sideways ? to.left : st.scrollLeft, ms);
    return true;
  }

  /**
   * Room past the edges of the pages ({t, r, b, l} pixels; none by default), so that the sentence
   * you are on can be in the middle of the screen while zooming, also near the edge of a page.
   */
  setSlack(s = { t: 0, r: 0, b: 0, l: 0 }) {
    this.slack = { t: Math.ceil(s.t), r: Math.ceil(s.r), b: Math.ceil(s.b), l: Math.ceil(s.l) };
    for (const k of ['t', 'r', 'b', 'l']) $('#spread').style.setProperty(`--slack-${k}`, `${this.slack[k]}px`);
  }

  /**
   * The fit button (or 0) zooms in step by step — the whole page → the page width → the paragraph →
   * the sentence → the word you are on — and then out again the same way: the sentence, the
   * paragraph (those of that word), the page width, the whole page; then in again …
   */
  toggleFit() {
    const steps = ['page', 'width', ...FIT_UNITS], was = this.zoom.mode;
    let k = steps.indexOf(was);
    if (k < 0) { k = -1; this.fitOut = false; } // (zoomed with + or −: from the whole page)
    else if (k === steps.length - 1) this.fitOut = true; // the closest: back out
    else if (k === 0) this.fitOut = false; // the whole page: in again
    let mode = steps[k + (this.fitOut ? -1 : 1)];
    let unit = null;
    if (FIT_UNITS.includes(mode)) {
      // The one you are on; from a paragraph, sentence or word: the one in it (or around it).
      const f = this.currentFocus(), u = FIT_UNITS.includes(was) && this.fitted && this.views.includes(this.fitted.view) ? this.fitted : null;
      const at = u ? (f && f.view === u.view && f.w >= u.a && f.w < u.b ? f : { view: u.view, w: u.a }) : null;
      unit = at ? this.fitUnitAt(at.view, at.w, mode) : this.pickFitUnit(mode);
      if (!unit) { mode = 'page'; this.fitOut = false; } // (no text on the page)
    }
    this.zoom = { mode, w: this.pageW };
    store.set('zoomMode', mode);
    if (unit) this.fitTo(unit);
    else {
      this.setSlack();
      this.applyZoom();
      // The width of the page: the sentence you are on in the middle, up and down. (The whole page: all of it.)
      const s = mode === 'width' && this.activeSentence();
      if (s) this.centerOn(s, s, 0, { sideways: false });
    }
    const out = this.fitOut && mode !== 'page' ? 'Zoom out: ' : '';
    toast(out + { page: 'Fit whole page', width: 'Fit page width', paragraph: 'Fit the paragraph', sentence: 'Fit the sentence', word: 'Zoom to the word' }[mode], 1200);
  }

  // Fit paragraph, sentence or word: the one you are on is as wide as the screen (a short one as if
  // it were FIT_MIN of the page wide), in the middle of it. While reading (with "Follow the
  // reading" on), the next paragraph or sentence is fitted when the reading gets there; zoomed to
  // the word, the page goes along when the word being read is about to leave the screen.

  /** The paragraph, sentence or word (kind) of word w: {view, kind, a, b} (its words), or null. */
  fitUnitAt(view, w, kind) {
    const t = view.text, s = t?.w2s[w];
    if (!(s >= 0)) return null;
    if (kind === 'word') return { view, kind, a: w, b: w + 1 };
    if (kind === 'sentence') return { view, kind, a: t.sent[s][0], b: t.sent[s][1] };
    const block = t.blocks.find(([sa, sb]) => s >= sa && s < sb);
    return block ? { view, kind, a: t.sent[block[0]][0], b: t.sent[block[1] - 1][1] } : null;
  }

  /** Its box in page pixels {x0, y0, x1, y1}, or null. */
  fitBox(u) {
    const rs = u?.view.text ? u.view.text.rects(u.a, u.b) : [];
    if (!rs.length) return null;
    return { x0: Math.min(...rs.map((r) => r.x)), y0: Math.min(...rs.map((r) => r.y)),
      x1: Math.max(...rs.map((r) => r.x + r.w)), y1: Math.max(...rs.map((r) => r.y + r.h)) };
  }

  /** What to fit (kind): the one being read, clicked or corrected last, else the one in the middle of the screen. */
  pickFitUnit(kind) {
    const f = this.currentFocus();
    if (f) return this.fitUnitAt(f.view, f.w, kind);
    const sr = $('#stage').getBoundingClientRect(), cx = sr.left + sr.width / 2, cy = sr.top + sr.height / 2;
    let best = null, bestD = Infinity;
    for (const view of this.views) {
      const t = view.text;
      if (!t) continue;
      const pr = view.el.getBoundingClientRect(), s = pr.width / view.W;
      const starts = kind === 'word' ? t.words.map((_, w) => w) : kind === 'sentence' ? t.sent.map(([a]) => a) : t.blocks.map(([sa]) => t.sent[sa][0]);
      for (const w of starts) {
        const u = this.fitUnitAt(view, w, kind), b = this.fitBox(u);
        const d = b ? Math.hypot(pr.left + ((b.x0 + b.x1) / 2) * s - cx, pr.top + ((b.y0 + b.y1) / 2) * s - cy) : Infinity;
        if (d < bestD) { bestD = d; best = u; }
      }
    }
    return best;
  }

  /** The page width that makes the fitted paragraph, sentence or word as wide as the screen (0: none). */
  fitZoom() {
    const u = this.fitted?.kind === this.zoom.mode && this.views.includes(this.fitted.view) ? this.fitted : null;
    const b = this.fitBox(u);
    if (!b) return 0;
    return ($('#stage').clientWidth - 32) * u.view.W / Math.max(b.x1 - b.x0, u.view.W * FIT_MIN[u.kind]);
  }

  /**
   * Zoom to a paragraph, sentence or word and put it in the middle of the screen (its top, if it is
   * taller). A paragraph: up and down, the sentence you are on in it is in the middle.
   */
  fitTo(u, ms = 0) {
    this.fitted = u;
    this.applyZoom();
    const s = u.kind === 'paragraph' ? this.activeSentence() : null;
    this.centerOn(s && s.view === u.view && s.a >= u.a && s.b <= u.b ? s : u, u, ms);
  }

  /** Is that part of a page on the screen (above the reading bar), with `margin` pixels to spare? */
  onScreen(view, a, b, margin = 0) {
    const box = view.unitBox({ a, b }), st = $('#stage').getBoundingClientRect(), pr = view.el.getBoundingClientRect();
    return !!box && pr.top + box.y >= st.top + margin && pr.top + box.y + box.h <= st.bottom - 60 - margin
      && pr.left + box.x >= st.left + margin && pr.left + box.x + box.w <= st.right - margin;
  }

  /**
   * Fitted to a paragraph, sentence or word, and the reading has come to a sentence: fit its
   * paragraph if it is another one (while the sentence is on the screen, nothing else moves), its
   * sentence, or its first word. True when the page needs no other scrolling.
   */
  followFit(view, unit) {
    const kind = this.zoom.mode;
    const u = this.fitUnitAt(view, unit.a, kind);
    if (!u) return false;
    const same = this.fitted?.view === u.view && this.fitted.kind === kind && this.fitted.a === u.a && this.views.includes(u.view);
    if (kind === 'paragraph' && same) return this.onScreen(view, unit.a, unit.b);
    if (!same) this.fitTo(u);
    return true;
  }

  /** Zoomed to the word: the word being read (w) is about to leave the screen: the page goes along. */
  followWord(view, w) {
    if (this.zoom.mode !== 'word' || w < 0 || this.onScreen(view, w, w + 1, 40)) return;
    this.fitTo({ view, kind: 'word', a: w, b: w + 1 }, followSettings.speed);
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
    if (cls === 'hover' || cls === 'active') this.breakdown?.track(cls, view, unit); // (its button goes there)
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
    const language = view.book.language || 'en';
    if (a.t === 'audio') this.audio.play(a, { book: view.book.slug, language });
    else if (a.t === 'video') openVideo(this, a, view.book.slug, language);
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

  // ---------- Phone, tablet or computer ----------

  /** The layout's choosers (Settings → Screen, the foot of the library): Automatic (what this device looks like) or one chosen. */
  bindDevice() {
    const device = window.linguaDevice;
    if (!device) return;
    const name = (d) => device.NAMES[d].toLowerCase();
    const fill = () => {
      const found = name(device.detect()), now = name(device.get()), chosen = device.choice();
      $$('.device-select').forEach((sel) => {
        sel.replaceChildren(...device.CHOICES.map((c) => el('option', { value: c }, c === 'auto' ? `Automatic (${found})` : device.NAMES[c])));
        sel.value = chosen;
      });
      $('#device-hint').textContent = chosen === 'auto' ? `This device looks like a ${found}: the app has the ${now}’s layout.`
        : `The ${now}’s layout, as you chose (Automatic would give the ${found}’s).`;
    };
    $$('.device-select').forEach((sel) => sel.addEventListener('change', () => {
      device.set(sel.value);
      fill();
      toast(`The ${name(device.get())}’s layout.`);
    }));
    device.onChange(fill);
    fill();
  }

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
    let pending = null, tapLine = null, tapAt = 0, hold = null;
    // A finger held on a sentence (a phone, a tablet; not on its number, which moves it): the
    // sentence broken down, as on the page.
    const letGo = () => { clearTimeout(hold?.timer); if (hold && !hold.fired) hold = null; };
    tv.addEventListener('pointerdown', (e) => {
      letGo();
      hold = null;
      const hit = e.pointerType !== 'mouse' && !this.editor.active && !e.target.closest('.grip') && unitFromEvent(e);
      if (!hit) return;
      hold = { x: e.clientX, y: e.clientY, id: e.pointerId };
      hold.timer = setTimeout(() => { hold.fired = true; clearTimeout(pending); this.holdUnit(hit.view, hit.unit); }, HOLD_MS);
    });
    tv.addEventListener('pointermove', (e) => {
      if (hold && !hold.fired && e.pointerId === hold.id && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 10) letGo();
    });
    for (const type of ['pointerup', 'pointercancel']) tv.addEventListener(type, letGo);
    tv.addEventListener('contextmenu', (e) => { if (hold) e.preventDefault(); }); // (not the phone's menu)
    // Double click (or double tap on a phone) on a sentence: correct its text right here.
    const correct = (line) => {
      clearTimeout(pending);
      tapLine = null;
      if (this.editor.inline?.line === line) return;
      window.getSelection()?.removeAllRanges();
      this.editor.editInline(this.views[Number(line.dataset.v)], Number(line.dataset.b), Number(line.dataset.s));
    };
    tv.addEventListener('click', (e) => {
      if (hold?.fired) { hold = null; return; } // (the finger was held: not a tap)
      if (this.words.collecting) { // adding new words: a click adds one (or takes it out)
        const hit = unitFromEvent(e);
        if (hit) this.words.toggle(hit.view, hit.unit);
        return;
      }
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
    $('#read-area').addEventListener('click', () => (this.areaReading ? this.areaReading() : this.readArea()));
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
    this.recordings?.setCoverageVisible(name === 'audio');
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

  /**
   * The top bar's "read which language" switch (中+EN, 中, EN), for books in Chinese and pages with
   * Chinese and English. Elsewhere everything is read, whatever was chosen there.
   */
  updateLangSeg() {
    const text = this.views.map((v) => v.text?.fullText() || '').join(' ');
    const both = (this.book?.language || '').startsWith('zh') || (/[㐀-鿿]/u.test(text) && /[A-Za-z]{2}/.test(text));
    $('#lang-seg').hidden = !both;
    speech.languageChoice = both;
  }

  renderPanelText() {
    this.recordings.renderSpots();
    this.updateLangSeg();
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

  /**
   * Read an area aloud (the button next to Read page aloud): draw a box on the page; the sentences
   * in it (clauses, in Clause mode) are read one after the other, each highlighted while it is read.
   * A sentence is in the box when most of its words are. Esc (or the button again) cancels the box.
   */
  readArea() {
    const views = this.views.filter((v) => v.text && !v.text.empty);
    if (!views.length) { toast('There is no text to read on this page.'); return; }
    this.reader.stop();
    if (this.editor.active) this.editor.stop();
    if (this.recordings.picking) this.recordings.stopPicking();
    if (this.words.collecting) this.words.setCollecting(false);
    const btn = $('#read-area');
    const stop = () => {
      views.forEach((v) => v.stopMarking());
      document.body.classList.remove('marking');
      btn.setAttribute('aria-pressed', 'false');
      this.areaReading = null;
    };
    this.areaReading = stop;
    btn.setAttribute('aria-pressed', 'true');
    document.body.classList.add('marking');
    toast('Draw a box on the page around the sentences to read (Esc: cancel).', 2500);
    for (const view of views) {
      view.startMarking((rect) => {
        stop();
        if (!rect) return;
        const t = view.text, mode = this.mode === 'clause' ? 'clause' : 'sentence', queue = [];
        const inside = ([x, y, w, h]) => x + w / 2 >= rect.x && x + w / 2 <= rect.x + rect.w && y + h / 2 >= rect.y && y + h / 2 <= rect.y + rect.h;
        for (let i = 0; i < t.count(mode); i++) {
          const unit = t.unit(mode, i), placed = t.words.slice(unit.a, unit.b).filter((w) => w[2] > 0 || w[3] > 0);
          if (placed.length && placed.filter(inside).length / placed.length >= 0.5) queue.push({ view, unit });
        }
        if (!queue.length) { toast('No sentence is in that box: draw it around the sentences to read.'); return; }
        this.reader.startList(queue);
      });
    }
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
    const sel = $('#voice-select'), zhSel = $('#chinese-voice-select'), mode = $('#speech-language-mode');
    const rate = $('#rate-input'), out = $('#rate-out'), follow = $('#follow-input');
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
    // Settings tabs (the last one used opens again).
    const showTab = (name) => {
      if (!$$('#voice-pop .pop-body[data-ptab]').some((x) => x.dataset.ptab === name)) name = 'voice';
      $$('#voice-pop [data-ptab]').forEach((x) => {
        if (x.matches('[role=tab]')) x.setAttribute('aria-selected', String(x.dataset.ptab === name));
        else x.hidden = x.dataset.ptab !== name;
      });
      store.set('settingsTab', name);
    };
    $$('#voice-pop [role=tab]').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.ptab)));
    showTab(store.get('settingsTab', 'voice'));
    /** Open the settings on a tab such as 'voice' or 'translation'. */
    this.openSettings = (tab) => { showTab(tab); setOpen(true); };
    const updateVoiceAvailability = () => {
      const en = speech.currentVoice('en'), zh = speech.currentVoice('zh');
      fillVoices(sel, zhSel, this.recordings);
      const availability = this.recordings?.voiceAvailability(en);
      const selectedVoiceCached = !!(en?.localService || this.recordings?.hasOfflineVoiceForCurrentPage(en));
      const pageHasOfflineAudio = !!this.recordings?.hasAnyOfflineVoiceOnCurrentPage();
      const badge = $('#voice-offline-status');
      badge.textContent = en?.localService ? (availability?.canGenerate ? 'Windows offline · generate without internet' : 'Device voice works offline')
        : selectedVoiceCached ? 'Offline available on this page' : 'Online for this voice on this page';
      badge.classList.toggle('available', selectedVoiceCached);
      badge.classList.toggle('online', !selectedVoiceCached);
      const modeBadge = $('#offline-voice-badge');
      modeBadge.hidden = !this.book || !this.views.length;
      modeBadge.textContent = pageHasOfflineAudio ? 'OFFLINE' : 'ONLINE';
      modeBadge.title = pageHasOfflineAudio
        ? 'Offline voice audio exists for this page. Delete it from My audio; other cached voices remain until their files are deleted too.'
        : 'No offline voice audio is saved for this page.';
      modeBadge.classList.toggle('offline', pageHasOfflineAudio);
      modeBadge.classList.toggle('online', !pageHasOfflineAudio);
      modeBadge.setAttribute('aria-label', pageHasOfflineAudio ? 'Offline audio available for this page' : 'This page has no offline audio');
      this.recordings?.setOfflineVoiceMode(selectedVoiceCached);
      const generate = $('#offline-import');
      generate.hidden = !availability?.canGenerate;
      if (availability?.canGenerate) {
        generate.innerHTML = `${icon('download')}Generate`;
        generate.title = `Generate ${availability.neural.name} English audio for the chosen scope${en?.localService ? ' — no internet needed' : ' — requires internet once'}`;
        generate.setAttribute('aria-label', generate.title);
      }
    };
    this.updateVoiceOfflineStatus = updateVoiceAvailability;
    // With a login: "Log out" at the bottom of the settings.
    fetch('/api/session').then((r) => r.json()).then((d) => { $('#logout-row').hidden = !d.login; }).catch(() => {});
    $('#btn-logout').addEventListener('click', async () => {
      await fetch('/api/logout', { method: 'POST' }).catch(() => {});
      location.href = '/web/login.html';
    });

    speech.onVoices((voices) => {
      if (!speech.supported) {
        [sel, zhSel].forEach((s) => s.replaceChildren(el('option', {}, 'Not available')));
        $('#voice-hint').textContent = 'This browser cannot read text aloud. Use Microsoft Edge or Google Chrome.';
        return;
      }
      if (!voices.length) { [sel, zhSel].forEach((s) => s.replaceChildren(el('option', {}, 'Loading voices…'))); return; }
      fillVoices(sel, zhSel);
      this.fillTranslationVoice?.(); // (not yet the first time: it is set up below)
      updateVoiceAvailability();
    });
    sel.addEventListener('change', () => {
      speech.setVoice(sel.value);
      const id = this.recordings.neuralVoiceFor(speech.currentVoice('en'))?.id?.toLowerCase();
      this.recordings.pageOfflineId = this.recordings.pageOfflineItems().find(({ recording: rec }) => [rec.voice, rec.voiceB].some((v) => v?.toLowerCase() === id))?.id || null;
      updateVoiceAvailability();
    });
    zhSel.addEventListener('change', () => { speech.setChineseVoice(zhSel.value); fillVoices(sel, zhSel); updateVoiceAvailability(); });
    // Read each sentence's translation too (into the language of the Translation tab), before or
    // after it, with a voice of that language.
    const trRead = $('#tr-read'), trSel = $('#tr-voice-select');
    this.fillTranslationVoice = () => {
      const code = this.translator?.lang || '', name = this.translator?.name || code;
      const list = code ? speech.translationVoices(code) : [], current = code ? speech.translationVoice(code) : null;
      const short = (v) => v.name.replace(/^Microsoft /, '').replace(/ - .*$/, '');
      trSel.replaceChildren(...(list.length
        ? list.map((v) => el('option', { value: v.voiceURI, selected: v === current }, `${short(v)} (${v.lang})${v.localService ? ' · offline' : ''}`))
        : [el('option', { value: '' }, code ? `No ${name} voice on this device` : 'Choose a language first')]));
      $('#tr-voice-label').textContent = name ? `${name} voice` : 'Translation voice';
      $('#tr-voice-field').hidden = settings.trOrder === 'off';
      const hint = $('#tr-read-hint');
      hint.textContent = settings.trOrder === 'off' ? ''
        : !code ? 'Choose the language in the Translation tab.'
          : !list.length ? `No voice on this device reads ${name}. Microsoft Edge has Natural voices for most languages.` : '';
      hint.hidden = !hint.textContent;
    };
    trRead.value = settings.trOrder;
    this.fillTranslationVoice();
    trRead.addEventListener('change', () => {
      speech.setTranslationOrder(trRead.value);
      this.fillTranslationVoice();
      updateVoiceAvailability(); // offline audio is made (and used) with or without the translation
    });
    trSel.addEventListener('change', () => speech.setTranslationVoice(this.translator.lang, trSel.value));
    // Read which language (books with Chinese and English): in the settings and in the top bar.
    // Chinese books keep their own (中+EN at first): "EN" chosen in an English book does not
    // silence them.
    const langSeg = $$('#lang-seg button');
    this.setLanguageMode = (m) => {
      speech.setLanguageMode(m, this.languageModeKey());
      mode.value = m;
      langSeg.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.lang === m)));
    };
    mode.addEventListener('change', () => this.setLanguageMode(mode.value));
    langSeg.forEach((b) => b.addEventListener('click', () => {
      this.setLanguageMode(b.dataset.lang);
      toast({ both: 'Reading the Chinese and the English', zh: 'Reading only the Chinese', en: 'Reading only the English' }[b.dataset.lang], 1500);
    }));
    this.setLanguageMode(settings.languageMode);
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
    // Repeat each sentence: the slider here (1-10, ∞) and the repeat buttons — in the top bar, on
    // the Script tab and next to a video (each click: 2, 3, 4, 5 times, ∞, then once again) —
    // change the same setting.
    const rp = $('#repeat-input'), rpOut = $('#repeat-out');
    const repeatNow = () => (Number(settings.repeat) === 0 ? 0 : Math.max(1, Math.min(10, Number(settings.repeat) || 1))); // 0 = ∞
    const showRepeat = (extra = null) => {
      const n = repeatNow();
      const text = n === 0 ? '∞ until you stop' : n === 1 ? 'once' : `${n} times`;
      const next = n === 0 ? 'once' : n >= 5 ? '∞' : `${n + 1} times`;
      rp.value = n === 0 ? 11 : n;
      rpOut.textContent = text;
      for (const btn of new Set([...$$('.repeat-btn'), ...(extra ? [extra] : [])])) {
        const badge = btn.querySelector('.count-badge');
        btn.querySelector('.i use')?.setAttribute('href', n === 1 ? '#i-repeat' : '#i-repeat-fill');
        badge.hidden = n === 1;
        badge.textContent = n === 0 ? '∞' : String(n);
        badge.classList.toggle('inf', n === 0);
        btn.setAttribute('aria-pressed', String(n !== 1));
        btn.setAttribute('aria-label', `Repeat each sentence: ${text}`);
        btn.title = `Repeat each sentence: ${text}. Click for ${next} (R)`;
      }
    };
    this.showRepeat = showRepeat;
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
    $('#btn-repeat').addEventListener('click', () => this.cycleRepeat());
    $('#voice-test').addEventListener('click', () => {
      this.reader.stop();
      speech.speak(VOICE_SAMPLES[settings.languageMode] || VOICE_SAMPLES.both);
    });
    $('#offline-import').addEventListener('click', () => this.recordings.generateOfflineVoice(speech.currentVoice('en'), $('#offline-scope').value));
  }

  // ---------- Keyboard ----------

  bindKeys() {
    document.addEventListener('keydown', (e) => {
      if ($('#media-dialog').open) return; // the dialog handles Esc itself
      if (e.key === 'Escape') {
        if (this.editor.escape()) return;
        if (this.recordings.picking) { this.recordings.stopPicking(); return; }
        if (this.words.closeCategories()) return; // (the panel of categories first)
        if (this.words.collecting) { this.words.setCollecting(false); return; }
        if (this.areaReading) { this.areaReading(); return; } // (drawing the area to read: not any more)
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
          if (e.key === 'Delete' && this.editor.anyChecked()) { e.preventDefault(); this.editor.tool('delete-checked'); return; }
          if (e.key === 'Delete' && this.editor.sel) { e.preventDefault(); this.editor.tool('delete'); return; }
          // Enter: split the sentence before the words marked (Split).
          if (e.key === 'Enter' && this.editor.splitting) {
            e.preventDefault();
            this.editor.tool('split-apply');
            return;
          }
          // Enter: read the boxes drawn to re-read text by area.
          if (e.key === 'Enter' && this.editor.readingAreas?.areas.length && !e.target.closest?.('button, a, select')) {
            e.preventDefault();
            this.editor.tool('ocr-read');
            return;
          }
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
      else if (k === 'n' || k === 'N') this.words.setCollecting(!this.words.collecting);
      else if (k === 'c' || k === 'C') this.words.openCards();
      else if (k === 'b' || k === 'B') this.breakdown.openCurrent();
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

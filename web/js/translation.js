// Translations of the page text: under each sentence in the Text list, in a popup when pointing
// at a sentence on the page (in Word mode: the word too), and highlighted with the sentence being
// read. The list and the page are switched on and off separately: the translate button in the
// Text tab (or L) for the list, the one at the top for the page; the language and the whole-book
// translation are in the settings (Translation tab). Made by the local server (web/translate.py)
// and saved there, so each sentence is translated only once and then works without internet.
import { $, el, icon, store, toast } from './util.js';
import { PageText } from './pagetext.js';


export class Translator {
  constructor(app) {
    this.app = app;
    this.listOn = store.get('trOn', false);                 // under each sentence in the Text list
    this.pageOn = store.get('trPageOn', this.listOn);        // in a popup on the page
    this.lang = store.get('trLang', '');
    this.langs = [];
    this.byDoc = new WeakMap(); // page text doc -> Map(lang -> Promise of one translation per sentence)
    this.done = new WeakMap();  // page text doc -> Map(lang -> translations), once they arrived
    this.words = new Map();     // lang|word -> Promise of the word's translation
    this.gen = 0;
    this.tip = el('div', { class: 'tr-tip', hidden: true, role: 'tooltip' });
    document.body.append(this.tip);
    this.bind();
    this.loadLanguages();
  }

  get rtl() { return !!this.langs.find((l) => l.code === this.lang)?.rtl; }
  get name() { return this.langs.find((l) => l.code === this.lang)?.name || ''; }

  async loadLanguages() {
    try { this.langs = await (await fetch('/api/tr-languages')).json(); } catch { this.langs = []; }
    const sel = $('#tr-lang');
    sel.replaceChildren(el('option', { value: '' }, 'Choose a language…'),
      ...this.langs.map((l) => el('option', { value: l.code }, l.name === l.native ? l.name : `${l.name} — ${l.native}`)));
    sel.value = this.lang;
    this.updateButton();
    if (this.listOn && this.lang) this.app.renderPanelText?.();
  }

  bind() {
    // Quick on/off: the button at the top for the page, the one in the Text tab for the list.
    $('#btn-translate').addEventListener('click', (e) => { e.stopPropagation(); this.setPage(!(this.pageOn && this.lang)); });
    $('#tr-toggle').addEventListener('click', (e) => { e.stopPropagation(); this.setList(!(this.listOn && this.lang)); });
    // The settings (Translation tab).
    $('#tr-show').addEventListener('change', (e) => this.setList(e.target.checked));
    $('#tr-page').addEventListener('change', (e) => this.setPage(e.target.checked));
    $('#tr-lang').addEventListener('change', (e) => this.setLang(e.target.value));
    $('#tr-book').addEventListener('click', () => this.translateBook());
    const follow = () => this.place?.(); // the box moves with the page
    $('#stage').addEventListener('scroll', follow, { passive: true });
    addEventListener('resize', follow);
  }

  updateButton() {
    const page = this.pageOn && !!this.lang, list = this.listOn && !!this.lang;
    const btn = $('#btn-translate');
    btn.setAttribute('aria-pressed', String(page));
    btn.title = page ? `Translation on the page: on (${this.name}). Click to switch it off.`
      : 'Translation on the page: off. Click to show it when pointing at a sentence.';
    const tg = $('#tr-toggle');
    tg.setAttribute('aria-pressed', String(list));
    tg.title = list ? 'Hide the translations in the list (L)' : this.lang ? `Show the ${this.name} translations in the list (L)` : 'Show translations in the list (L)';
    tg.setAttribute('aria-label', list ? 'Hide translations' : 'Show translations');
    $('#tr-show').checked = this.listOn;
    $('#tr-page').checked = this.pageOn;
  }

  /** No language yet: open the settings on the Translation tab. Returns true if it had to ask. */
  askLanguage() {
    if (this.lang) return false;
    this.app.openSettings('translation');
    $('#tr-lang').focus();
    toast('Choose the language to translate into.');
    return true;
  }

  /** Translations under each sentence in the Text list. */
  setList(on) {
    if (on) this.askLanguage();
    this.listOn = on;
    store.set('trOn', on);
    this.updateButton();
    this.app.renderPanelText();
  }

  /** Translation in a popup when pointing at a sentence on the page. */
  setPage(on) {
    if (on) this.askLanguage();
    this.pageOn = on;
    store.set('trPageOn', on);
    this.updateButton();
    if (!on) this.hideTip();
  }

  setLang(code) {
    const first = !this.lang;
    this.lang = code;
    store.set('trLang', code);
    if (code && (first || (!this.listOn && !this.pageOn))) { // choosing a language means: show it (list and page)
      this.listOn = this.pageOn = true;
      store.set('trOn', true);
      store.set('trPageOn', true);
    }
    this.updateButton();
    this.app.renderPanelText();
  }

  // ---------------------------------------------------------------- Getting translations

  paragraphs(text) {
    return text.blocks.map(([sa, sb]) => Array.from({ length: sb - sa }, (_, i) => text.text(...text.sent[sa + i])));
  }

  async request(book, path, paragraphs) {
    const r = await fetch('/api/translate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang: this.lang, book, page: path, paragraphs }),
    }).catch(() => null);
    if (!r) throw new Error('The app’s server is not running. Start the app with Start Lingua Books.bat.');
    if (r.status === 404) throw new Error('The app’s server is an older version. Close the black window and start the app again.');
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.error || 'The translation failed.'), { busy: !!d.busy, wait: d.wait || 60 });
    return d; // {translations, fetched: how many sentences went to the translator now}
  }

  /** One translation per sentence of a page (Promise). Cached per text version and language. */
  forView(view) {
    if (!view.text || !this.lang) return Promise.resolve(null);
    let m = this.byDoc.get(view.doc);
    if (!m) { m = new Map(); this.byDoc.set(view.doc, m); }
    const lang = this.lang;
    if (!m.has(lang)) {
      const p = this.request(view.book.slug, view.page.path, this.paragraphs(view.text)).then((d) => {
        const flat = d.translations.flat();
        if (!this.done.has(view.doc)) this.done.set(view.doc, new Map());
        this.done.get(view.doc).set(lang, flat);
        return flat;
      });
      p.catch(() => m.delete(lang)); // try again next time
      m.set(lang, p);
    }
    return m.get(lang);
  }

  /** Translations of a page if they have arrived already (for copying and saving). */
  ready(view) { return (this.listOn && this.done.get(view.doc)?.get(this.lang)) || null; }

  word(text) {
    const key = `${this.lang}|${text.toLowerCase()}`;
    if (!this.words.has(key)) {
      const p = fetch('/api/translate-word', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: this.lang, word: text }),
      }).then((r) => (r.ok ? r.json() : Promise.reject(new Error()))).then((d) => d.text);
      p.catch(() => this.words.delete(key));
      this.words.set(key, p);
    }
    return this.words.get(key);
  }

  // ---------------------------------------------------------------- The Text list

  /** Put each sentence's translation under it in the Text list (after it was drawn). */
  async decoratePanel() {
    const gen = ++this.gen;
    const tv = $('#text-view');
    const active = this.listOn && this.lang && !this.app.editor.active;
    tv.classList.toggle('with-tr', !!active);
    tv.querySelectorAll('.tr, .tr-note').forEach((e) => e.remove());
    if (!active) return;
    const views = this.app.views;
    const note = el('p', { class: 'tr-note', html: `${icon('languages')}Translating into ${this.name}…` });
    tv.prepend(note);
    for (const [vi, view] of views.entries()) {
      let trs;
      try {
        trs = await this.forView(view);
      } catch (err) {
        if (gen !== this.gen) return;
        note.classList.add('err');
        if (!err.busy) { note.textContent = err.message; return; }
        // Google asks to slow down: try again by itself when it may be asked again.
        await this.countdown(err.wait, () => gen !== this.gen,
          (t) => { note.textContent = `${err.message} Trying again in ${t}…`; });
        if (gen === this.gen) this.decoratePanel();
        return;
      }
      if (gen !== this.gen || this.app.views !== views) return; // the page changed meanwhile
      const spans = this.app.panelWords.get(view);
      if (!spans || !trs) continue;
      view.text.sent.forEach(([a, b], s) => {
        if (!spans[b - 1] || !trs[s]) return;
        spans[b - 1].after(el('span', { class: 'tr', dir: this.rtl ? 'rtl' : 'ltr', lang: this.lang, dataset: { v: vi, s } }, trs[s]));
      });
    }
    note.remove();
    this.app.remarkActive(); // the sentence being read: highlight its translation too
  }

  // ---------------------------------------------------------------- The popup on the page

  async showTip(view, unit) {
    if (!this.pageOn || !this.lang || !unit || !view?.text || this.app.editor.active || this.app.recordings.picking) {
      this.hideTip();
      return;
    }
    const key = `${view.page.path}|${unit.mode}|${unit.a}|${unit.b}`;
    this.tipKey = key;
    let trs;
    try { trs = await this.forView(view); } catch { this.hideTip(); return; }
    if (this.tipKey !== key) return;
    const t = view.text;
    const s0 = t.w2s[unit.a], s1 = t.w2s[unit.b - 1];
    const sentence = trs?.slice(s0, s1 + 1).filter(Boolean).join(' ');
    // The box must not cover any line of the sentence (also in Clause and Word mode).
    const lines = t.rects(t.sent[s0][0], t.sent[s1][1]);
    if (!sentence || !lines.length) { this.hideTip(); return; }
    const area = {
      x0: Math.min(...lines.map((r) => r.x)), y0: Math.min(...lines.map((r) => r.y)),
      x1: Math.max(...lines.map((r) => r.x + r.w)), y1: Math.max(...lines.map((r) => r.y + r.h)),
    };
    const dir = this.rtl ? 'rtl' : 'ltr';
    const render = (wordLine) => {
      this.tip.replaceChildren(...[wordLine, el('div', { class: wordLine ? 'ts sub' : 'ts', dir, lang: this.lang }, sentence)].filter(Boolean));
      this.place = () => this.placeTip(view, area);
      this.place();
    };
    const word = unit.mode === 'word' ? t.words[unit.a][4].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '') : '';
    const wordLine = (wt) => el('div', { class: 'tw' }, el('b', { dir: 'ltr' }, word), ' → ', el('span', { dir }, wt));
    render(word ? wordLine('…') : null); // the sentence at once; the word when it arrives
    if (!word) return;
    const wt = await this.word(word).catch(() => '');
    if (this.tipKey === key) render(wt ? wordLine(wt) : null);
  }

  /** Below the sentence; above it if there is no room; else beside it. Again after scrolling. */
  placeTip(view, area) {
    const page = view.el.getBoundingClientRect();
    const k = page.width / view.W;
    const s = { left: page.left + area.x0 * k, top: page.top + area.y0 * k, right: page.left + area.x1 * k, bottom: page.top + area.y1 * k };
    const b = $('#stage').getBoundingClientRect();
    if (s.bottom < b.top || s.top > b.bottom) { this.tip.hidden = true; return; } // scrolled out of sight
    this.tip.hidden = false;
    const m = 8, tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
    const x = clamp(s.left, b.left + m, b.right - tw - m), y = clamp(s.top, b.top + m, b.bottom - th - m);
    const fits = ([l, t]) => l >= b.left + m - 1 && t >= b.top + m - 1 && l + tw <= b.right - m + 1 && t + th <= b.bottom - m + 1;
    const spot = [[x, s.bottom + m], [x, s.top - th - m], [s.right + m, y], [s.left - tw - m, y]].find(fits)
      // A very long sentence: on the side with more room.
      || (b.bottom - s.bottom > s.top - b.top ? [x, b.bottom - th - m] : [x, b.top + m]);
    this.tip.style.left = `${Math.max(m, spot[0])}px`;
    this.tip.style.top = `${Math.max(m, spot[1])}px`;
  }

  hideTip() {
    this.tipKey = null;
    this.place = null;
    this.tip.hidden = true;
  }

  /** Wait seconds, showing m:ss left; stops early when cancelled() says so. */
  async countdown(seconds, cancelled, show) {
    const until = Date.now() + seconds * 1000;
    while (!cancelled() && Date.now() < until) {
      const s = Math.ceil((until - Date.now()) / 1000);
      show(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
      await new Promise((r) => { setTimeout(r, 1000); });
    }
  }

  // ---------------------------------------------------------------- The whole book

  async translateBook() {
    const btn = $('#tr-book'), bar = $('#tr-progress'), status = $('#tr-status');
    if (this.job) { this.job.stop = true; return; } // the button says "Stop" while working
    if (!this.lang) { toast('Choose the language first.'); $('#tr-lang').focus(); return; }
    const book = this.app.book;
    const pages = book.pages.filter((p) => !p.blank);
    const job = this.job = { stop: false };
    btn.textContent = 'Stop';
    bar.hidden = false;
    let done = 0, error = null, busy = 0;
    while (done < pages.length && !job.stop) {
      const p = pages[done];
      status.textContent = `Translating the ${book.type} into ${this.name}: page ${p.n} (${done} of ${pages.length})`;
      try {
        const doc = await fetch(`/api/text/${book.slug}/${p.path}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null));
        if (doc?.words.length) {
          const d = await this.request(book.slug, p.path, this.paragraphs(new PageText(doc)));
          // Go gently: Google blocks for a while when it gets many requests in a row.
          if (d.fetched) await this.countdown(1.5, () => job.stop, () => {});
        }
        busy = 0;
      } catch (err) {
        if (!err.busy || ++busy > 6) { error = err.message; break; }
        // Busy: wait as long as the server says, then go on with the same page.
        await this.countdown(err.wait, () => job.stop, (t) => {
          status.textContent = `Google’s translator asks the app to slow down (too many requests). It goes on by itself in ${t} — ${done} of ${pages.length} pages done and saved.`;
        });
        continue;
      }
      done++;
      bar.firstChild.style.width = `${(done / pages.length) * 100}%`;
    }
    this.job = null;
    btn.textContent = 'Translate the whole book now';
    bar.hidden = true;
    status.textContent = error ? `Stopped: ${error} Click again to go on later (finished pages are skipped).`
      : job.stop ? `Stopped after ${done} of ${pages.length} pages. Click again to go on (finished pages are skipped).`
        : `Done: the ${book.type} is translated into ${this.name} and now works without internet.`;
  }
}

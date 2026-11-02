// Translations of the page text: under each sentence in the Text list, in a popup when pointing
// at a sentence on the page (in Word mode: the word too), and highlighted with the sentence being
// read. The list and the page are switched on and off separately: the translate button in the
// Text tab (or L) for the list, the one at the top for the page; the language and the whole-book
// translation are in the settings (Translation tab). Made by the local server (web/translate.py)
// and saved there, so each sentence is translated only once and then works without internet.
import { $, $$, el, icon, store, toast } from './util.js';
import { PageText } from './pagetext.js';

const LEVELS = ['sentence', 'clause', 'word', 'breakdown']; // what Prepare saves (Translation tab)
const LEVEL_NAMES = { sentence: 'sentences', clause: 'clauses', word: 'contextual word meanings', breakdown: 'breakdowns (word by word)' };
/** The steps of Prepare, each with its own bar: what the chosen levels need saved. */
const STEPS = [
  { key: 'sentence', name: 'Sentences', on: (l) => l.sentence || l.breakdown },
  { key: 'clause', name: 'Clauses', on: (l) => l.clause },
  { key: 'word', name: 'Words in context', on: (l) => l.word || l.breakdown },
  { key: 'alone', name: 'Breakdown: each word on its own', on: (l) => l.breakdown },
];
// A book's language (of its pages) as a language to translate into: not offered for that book.
const SAME = { 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW' };


export class Translator {
  constructor(app) {
    this.app = app;
    this.listOn = store.get('trOn', false);                 // under each sentence in the Text list
    this.pageOn = store.get('trPageOn', this.listOn);        // in a popup on the page
    this.from = 'en';                                        // the open book's language: translated from it
    this.lang = this.langFor(this.from);                     // into this one
    this.offlineOnly = store.get('trOfflineOnly', false);
    this.levels = store.get('trLevels', { sentence: true, clause: true, word: true, breakdown: true });
    this.langs = [];
    this.byDoc = new WeakMap(); // page text doc -> Map(lang -> Promise of one translation per sentence)
    this.done = new WeakMap();  // page text doc -> Map(lang -> translations), once they arrived
    this.words = new Map();     // language + word + sentence context -> Promise of the contextual gloss
    this.gen = 0;
    this.tip = el('div', { class: 'tr-tip', hidden: true, role: 'tooltip' });
    document.body.append(this.tip);
    this.bind();
    this.loadLanguages();
  }

  get rtl() { return !!this.langs.find((l) => l.code === this.lang)?.rtl; }
  get name() { return this.langs.find((l) => l.code === this.lang)?.name || ''; }
  /** The name of the open book's language (what is translated from). */
  get fromName() { return this.langs.find((l) => l.code === (SAME[this.from] || this.from))?.name || 'English'; }

  async loadLanguages() {
    try { this.langs = await (await fetch('/api/tr-languages')).json(); } catch { this.langs = []; }
    this.fillLanguages();
    this.updateButton();
    this.app.fillTranslationVoice?.(); // (the language's name is known now)
    if (this.listOn && this.lang) this.app.renderPanelText?.();
    this.showPrepared(); // (with the language's name)
  }

  /**
   * The language books in this language are translated into: the one chosen for them (books in
   * English: the first setting), else English, the main language (a Chinese book: into English).
   */
  langFor(from) {
    if (from === 'en') return store.get('trLang', '');
    return store.get('trLangFrom', {})[from] ?? 'en';
  }

  /** A book shown: translated from its language, into the language chosen for books in it. */
  setBook(book) {
    const from = book.language || 'en'; // (the disc's books: English)
    if (from === this.from) return;
    this.from = from;
    this.lang = this.langFor(from);
    this.hideTip();
    this.fillLanguages();
    this.updateButton();
    this.app.fillTranslationVoice?.();
    this.showPrepared();
  }

  /** The languages to translate into (not the book's own), and which language the book is translated from. */
  fillLanguages() {
    const own = SAME[this.from] || this.from, sel = $('#tr-lang');
    if (!this.langs.length) return; // (not arrived yet)
    sel.replaceChildren(el('option', { value: '' }, 'Choose a language…'),
      ...this.langs.filter((l) => l.code !== own).map((l) => el('option', { value: l.code }, l.name === l.native ? l.name : `${l.name} — ${l.native}`)));
    sel.value = this.lang;
    const from = $('#tr-from'), name = this.fromName;
    from.hidden = this.from === 'en';
    from.textContent = `This book is in ${name}: it is translated from ${name}${this.lang ? ` into ${this.name}` : ''}.`;
  }

  bind() {
    // Quick on/off: the button at the top for the page, the one in the Text tab for the list.
    $('#btn-translate').addEventListener('click', (e) => { e.stopPropagation(); this.setPage(!(this.pageOn && this.lang)); });
    $('#tr-toggle').addEventListener('click', (e) => { e.stopPropagation(); this.setList(!(this.listOn && this.lang)); });
    // The settings (Translation tab).
    $('#tr-show').addEventListener('change', (e) => this.setList(e.target.checked));
    $('#tr-page').addEventListener('change', (e) => this.setPage(e.target.checked));
    $('#tr-lang').addEventListener('change', (e) => this.setLang(e.target.value));
    $('#tr-offline').addEventListener('change', (e) => {
      this.offlineOnly = e.target.checked;
      store.set('trOfflineOnly', this.offlineOnly);
      this.byDoc = new WeakMap();
      this.done = new WeakMap();
      this.words.clear();
      this.hideTip();
      if (this.listOn) this.app.renderPanelText();
      this.updateStatus();
    });
    $('#tr-scope').addEventListener('change', () => { this.refreshPicker(); this.updatePrepareButton(); this.showPrepared(); });
    for (const level of LEVELS) {
      const input = $(`#tr-level-${level}`);
      if (!input) continue; // (a page without that choice)
      input.checked = this.levels[level] !== false;
      input.addEventListener('change', () => {
        this.levels[level] = input.checked;
        store.set('trLevels', this.levels);
        this.showPrepared();
      });
    }
    $('#tr-book').addEventListener('click', () => this.prepareScope());
    $('#tr-again-yes').addEventListener('click', () => this.prepareScope(true));
    $('#tr-again-no').addEventListener('click', () => { $('#tr-again').hidden = true; });
    $('#tr-offline').checked = this.offlineOnly;
    this.refreshPicker();
    this.updatePrepareButton();
    this.updateStatus();
    const follow = () => this.place?.(); // the box moves with the page
    $('#stage').addEventListener('scroll', follow, { passive: true });
    addEventListener('resize', follow);
  }

  updateButton() {
    const page = this.pageOn && !!this.lang, list = this.listOn && !!this.lang;
    const btn = $('#btn-translate');
    btn.setAttribute('aria-pressed', String(page));
    btn.title = page ? `Translation on the page: on (${this.name}). Click to switch it off.`
      : 'Translation on the page: off. Click to show sentence, clause, or word meanings by their text.';
    const tg = $('#tr-toggle');
    tg.setAttribute('aria-pressed', String(list));
    tg.title = list ? 'Hide the translations in the list (L)' : this.lang ? `Show the ${this.name} translations in the list (L)` : 'Show translations in the list (L)';
    tg.setAttribute('aria-label', list ? 'Hide translations' : 'Show translations');
    $('#tr-show').checked = this.listOn;
    $('#tr-page').checked = this.pageOn;
  }

  updateStatus() {
    const s = $('#tr-status');
    if (this.offlineOnly && !s.textContent) s.textContent = 'Offline mode: only translations already saved on this computer will be shown.';
    else if (!this.offlineOnly && s.textContent.startsWith('Offline mode:')) s.textContent = '';
  }

  currentView() {
    const page = this.app.book?.pages?.[this.app.idx];
    return this.app.views.find((v) => v.page.path === page?.path) || this.app.views[0] || null;
  }

  pageShown() { // (one page or two)
    this.refreshPicker();
    this.updatePrepareButton();
    if ($('#tr-scope').value !== 'book') this.showPrepared();
  }

  refreshPicker() {
    const box = $('#tr-sentence-picker');
    if ($('#tr-scope').value !== 'selected') { box.hidden = true; return; }
    const view = this.currentView();
    box.hidden = false;
    if (!view?.text) { box.textContent = 'Page text is still loading.'; return; }
    const prior = new Map($$('input[data-tr-sentence]', box).map((x) => [Number(x.dataset.trSentence), x.checked]));
    const tools = el('div', { class: 'tr-pick-tools' },
      el('button', { type: 'button', onclick: () => box.querySelectorAll('input[data-tr-sentence]').forEach((x) => { x.checked = true; }) }, 'Select all'),
      el('button', { type: 'button', onclick: () => box.querySelectorAll('input[data-tr-sentence]').forEach((x) => { x.checked = false; }) }, 'Clear'));
    const rows = view.text.sent.map(([a, b], i) => {
      const input = el('input', { type: 'checkbox', checked: prior.has(i) ? prior.get(i) : true,
        dataset: { trSentence: i }, 'aria-label': `Include sentence ${i + 1}` });
      return el('label', {}, input, el('span', {}, view.text.text(a, b)));
    });
    box.replaceChildren(tools, ...rows);
  }

  updatePrepareButton() {
    const scope = $('#tr-scope').value;
    const labels = { page: this.app.views?.length > 1 ? 'Prepare both pages' : 'Prepare current page', selected: 'Prepare selected sentences', book: 'Prepare whole book' };
    if (!this.job) $('#tr-book').textContent = labels[scope] || labels.page; // (else: Stop)
    $('#tr-sentence-picker').hidden = scope !== 'selected';
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

  /** show: in the settings, choosing a language also switches the translations on (not in a video's bar). */
  setLang(code, show = true) {
    const first = !this.lang;
    this.lang = code;
    if (this.from === 'en') store.set('trLang', code);
    else store.set('trLangFrom', { ...store.get('trLangFrom', {}), [this.from]: code }); // (for the books in that language)
    this.fillLanguages();
    if (show && code && (first || (!this.listOn && !this.pageOn))) { // choosing a language means: show it (list and page)
      this.listOn = this.pageOn = true;
      store.set('trOn', true);
      store.set('trPageOn', true);
    }
    this.updateButton();
    this.app.renderPanelText();
    this.app.fillTranslationVoice?.(); // the voice that reads the translation aloud
    this.app.updateVoiceOfflineStatus?.(); // (offline audio with translations is of one language)
    this.showPrepared();
  }

  // ---------------------------------------------------------------- Getting translations

  paragraphs(text) {
    return text.blocks.map(([sa, sb]) => Array.from({ length: sb - sa }, (_, i) => text.text(...text.sent[sa + i])));
  }

  selectedParagraphs(text, selected) {
    const paragraphs = [];
    for (const [sa, sb] of text.blocks) {
      const part = [];
      for (let i = sa; i < sb; i++) if (selected.has(i)) part.push(text.text(...text.sent[i]));
      if (part.length) paragraphs.push(part);
    }
    return paragraphs;
  }

  selectedClauses(text, selected) {
    const groups = new Map([...selected].map((i) => [i, []]));
    text.clause.forEach(([a, b]) => {
      const sentence = text.w2s[a];
      if (groups.has(sentence)) groups.get(sentence).push(text.text(a, b));
    });
    return [...groups.values()].filter((x) => x.length);
  }

  wordEntries(text, selected) {
    const entries = [];
    for (const sentence of selected) {
      const [a, b] = text.sent[sentence];
      const context = text.text(a, b);
      for (let i = a; i < b; i++) {
        const raw = text.words[i][4];
        const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
        if (!word) continue;
        let contextOffset = 0;
        for (let k = a; k < i; k++) contextOffset += text.words[k][4].length + (text.words[k][6] && k < b - 1 ? 1 : 0);
        contextOffset += raw.length - raw.replace(/^[^\p{L}\p{N}]+/u, '').length;
        entries.push({ word, context, contextOffset });
      }
    }
    return entries;
  }

  selectedLevels() {
    return Object.fromEntries(LEVELS.map((level) => [level, !!$(`#tr-level-${level}`)?.checked]));
  }

  async requestWords(items, options = {}) {
    const r = await fetch('/api/translate-word', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang: options.lang ?? this.lang, from: this.from, items, cachedOnly: options.cachedOnly ?? this.offlineOnly, refresh: options.refresh || undefined }),
    }).catch(() => null);
    if (!r) throw new Error('The app’s server is not running. Start it with Start Lingua Books.bat.');
    if (r.status === 404) throw new Error('The app’s server is an older version. Close the black window and start the app again.');
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.error || 'The word translations failed.'), { busy: !!d.busy, wait: d.wait || 60 });
    if (d.wordContext !== true) throw new Error('The running app server is an older version and cannot save contextual word translations. Close its black window and restart Lingua Books.');
    if (!Array.isArray(d.translations) || d.translations.length !== items.length) throw new Error('The server did not return all requested word meanings. Restart Lingua Books and prepare again.');
    return d;
  }

  /** What Prepare saves for some sentences of a page: the sentences and the clauses (in
   * paragraphs, translated together for context) and the words, each with the step it belongs to.
   * A sentence broken down (breakdown.js) shows the sentence, each word in it, and each word on its
   * own (word by word): the breakdown level saves all three. */
  preparationPlan(text, selected, levels) {
    const paragraphs = [], kinds = [];
    const add = (list, kind) => { for (const p of list) { paragraphs.push(p); kinds.push(kind); } };
    if (levels.sentence || levels.breakdown) add(this.selectedParagraphs(text, selected), 'sentence');
    if (levels.clause) add(this.selectedClauses(text, selected), 'clause');
    const entries = levels.word || levels.breakdown ? this.wordEntries(text, selected) : [];
    const words = entries.map((item) => ({ ...item, step: 'word', saved: false, none: false }));
    if (levels.breakdown) { // each different word on its own, once (as a word by word lookup asks for it)
      const seen = new Set();
      for (const { word } of entries) {
        if (seen.has(word.toLocaleLowerCase())) continue;
        seen.add(word.toLocaleLowerCase());
        words.push({ word, context: '', contextOffset: null, step: 'alone', saved: false, none: false });
      }
    }
    // found: the saved translation of each sentence or clause ('' while it is not saved); none:
    // the translator gave nothing for it (as for some names and numbers), which counts as done.
    const blank = () => paragraphs.map((p) => p.map(() => ''));
    return { paragraphs, kinds, found: blank(), none: blank(), words };
  }

  /** How many items of each step a plan has, how many of them are saved, and how many the
   * translator gives nothing for. */
  planCounts(plan) {
    const counts = Object.fromEntries(STEPS.map(({ key }) => [key, { total: 0, saved: 0, none: 0 }]));
    plan.paragraphs.forEach((p, i) => p.forEach((_, j) => {
      const c = counts[plan.kinds[i]];
      c.total++;
      if (plan.found[i]?.[j]) c.saved++;
      else if (plan.none[i]?.[j]) c.none++;
    }));
    for (const w of plan.words) {
      const c = counts[w.step];
      c.total++;
      if (w.saved) c.saved++;
      else if (w.none) c.none++;
    }
    return counts;
  }

  /** A page's plan to the server: only to read what is saved (cachedOnly: nothing goes to the
   * translator), or to download what is missing (refresh: all of it again). done(n) after each
   * answer: n more items were dealt with. */
  async sendPlan(page, plan, { lang, cachedOnly = false, refresh = false, cancelled, done }) {
    let fetched = 0;
    const none = plan.none.flat();
    const missing = plan.found.flat().filter((t, i) => !t && !none[i]).length;
    if (plan.paragraphs.length && (cachedOnly || refresh || missing)) {
      const d = await this.request(page.book, page.path, plan.paragraphs, { lang, cachedOnly, refresh });
      fetched += d.fetched || 0;
      plan.found = d.translations;
      const without = new Set(d.none || []); // (numbered through all the paragraphs)
      let k = 0;
      plan.none = plan.found.map((p) => p.map(() => without.has(k++)));
      done?.(cachedOnly || refresh ? plan.found.flat().length : missing);
    }
    const words = cachedOnly || refresh ? plan.words : plan.words.filter((w) => !w.saved && !w.none);
    // From the disk: all at once. Downloading: a few at a time, to show how far it is.
    const size = cachedOnly ? 2000 : 24;
    for (let i = 0; i < words.length; i += size) {
      if (cancelled?.()) return { fetched, stopped: true };
      const batch = words.slice(i, i + size);
      const d = await this.requestWords(batch.map(({ word, context, contextOffset }) => ({ word, context, contextOffset })),
        { lang, cachedOnly, refresh });
      fetched += d.fetched || 0;
      const without = new Set(d.none || []);
      batch.forEach((w, k) => { w.saved = !!d.translations[k]; w.none = !w.saved && without.has(k); });
      if (!cachedOnly) this.words.clear(); // newly saved glosses are available while later batches are preparing
      done?.(batch.length);
    }
    return { fetched };
  }

  async request(book, path, paragraphs, options = {}) {
    const r = await fetch('/api/translate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang: options.lang ?? this.lang, from: this.from, book, page: path, paragraphs,
        words: options.words, cachedOnly: options.cachedOnly ?? this.offlineOnly, refresh: options.refresh || undefined }),
    }).catch(() => null);
    if (!r) throw new Error('The app’s server is not running. Start the app with Start Lingua Books.bat.');
    if (r.status === 404) throw new Error('The app’s server is an older version. Close the black window and start the app again.');
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.error || 'The translation failed.'), { busy: !!d.busy, wait: d.wait || 60 });
    return d; // translations plus fetched/missing counts
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
        if (d.missing) m.delete(lang); // retry when online mode is enabled or cache fills in
        return flat;
      });
      p.catch(() => m.delete(lang)); // try again next time
      m.set(lang, p);
    }
    return m.get(lang);
  }

  /** One translation per sentence of a page that is not shown (its PageText), e.g. for audio. */
  async forText(book, path, text) {
    return (await this.request(book, path, this.paragraphs(text))).translations.flat();
  }

  /** Translations of a page if they have arrived already (for copying and saving). */
  ready(view) { return (this.listOn && this.done.get(view.doc)?.get(this.lang)) || null; }

  word(text, context = '', contextOffset = null) {
    const key = `${this.from}>${this.lang}|${text.toLocaleLowerCase()}|${context.toLocaleLowerCase()}|${contextOffset}`;
    if (!this.words.has(key)) {
      const p = fetch('/api/translate-word', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: this.lang, from: this.from, word: text, context, contextOffset, cachedOnly: this.offlineOnly }),
      }).then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'The word translation could not be fetched.');
        if (d.wordContext !== true) throw new Error('The running app server does not support contextual word translations. Restart Lingua Books.');
        // A miss is temporary: preparation in this or another tab may fill the disk cache.
        if (!d.text && this.words.get(key) === p) this.words.delete(key);
        return d.text;
      });
      p.catch(() => { if (this.words.get(key) === p) this.words.delete(key); });
      this.words.set(key, p);
    }
    return this.words.get(key);
  }

  /** A word of the page without its punctuation, its sentence, and where in the sentence it is. */
  wordQuery(t, unit) {
    const s0 = t.w2s[unit.a], [sentenceStart, sentenceEnd] = t.sent[s0];
    const raw = t.words[unit.a][4];
    let contextOffset = 0;
    for (let i = sentenceStart; i < unit.a; i++) contextOffset += t.words[i][4].length + (t.words[i][6] && i < sentenceEnd - 1 ? 1 : 0);
    contextOffset += raw.length - raw.replace(/^[^\p{L}\p{N}]+/u, '').length;
    return { word: raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''), context: t.text(sentenceStart, sentenceEnd), contextOffset };
  }

  /** The translation of a sentence, clause or word (its meaning there) of a page, to read it aloud. */
  async textFor(view, unit) {
    if (!this.lang || !view.text) return '';
    if (unit.mode === 'clause') return this.translateClause(view, unit);
    if (unit.mode === 'word') {
      const q = this.wordQuery(view.text, unit);
      return q.word ? this.word(q.word, q.context, q.contextOffset) : '';
    }
    return (await this.forView(view))?.[unit.i] || '';
  }

  async translateClause(view, unit) {
    const text = view.text, sentence = text.w2s[unit.a];
    const clauses = [], target = [];
    text.clause.forEach(([a, b]) => {
      if (text.w2s[a] !== sentence) return;
      if (a === unit.a && b === unit.b) target.push(clauses.length);
      clauses.push(text.text(a, b));
    });
    const d = await this.request(view.book.slug, view.page.path, [clauses]);
    return d.translations?.[0]?.[target[0]] || '';
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
    const t = view.text;
    const s0 = t.w2s[unit.a], s1 = t.w2s[unit.b - 1];
    let trs;
    let sentence = '';
    try {
      if (unit.mode === 'clause') sentence = await this.translateClause(view, unit);
      else {
        trs = await this.forView(view);
        sentence = trs?.slice(s0, s1 + 1).filter(Boolean).join(' ');
      }
    } catch { /* An unavailable translation should not prevent a contextual word lookup. */ }
    if (this.tipKey !== key) return;
    const { word, context, contextOffset } = unit.mode === 'word' ? this.wordQuery(t, unit) : { word: '' };
    // Anchor a word/clause gloss to that exact unit; sentence translation uses its full lines.
    const lines = unit.mode === 'sentence' ? t.rects(t.sent[s0][0], t.sent[s1][1]) : t.rects(unit.a, unit.b);
    if ((!sentence && !word && !this.offlineOnly) || !lines.length) { this.hideTip(); return; }
    const area = {
      x0: Math.min(...lines.map((r) => r.x)), y0: Math.min(...lines.map((r) => r.y)),
      x1: Math.max(...lines.map((r) => r.x + r.w)), y1: Math.max(...lines.map((r) => r.y + r.h)),
    };
    const dir = this.rtl ? 'rtl' : 'ltr';
    const render = (wordLine) => {
      const translation = sentence || (this.offlineOnly ? 'Not saved offline yet' : '');
      const showTranslation = translation && (unit.mode !== 'word' || sentence);
      this.tip.replaceChildren(...[wordLine, showTranslation && el('div', { class: wordLine ? 'ts sub' : 'ts', dir, lang: this.lang }, translation)].filter(Boolean));
      this.place = () => this.placeTip(view, area);
      this.place();
    };
    const wordLine = (wt) => el('div', { class: 'tw' }, el('b', { dir: 'ltr' }, word), ' → ', el('span', { dir }, wt));
    render(word ? wordLine('…') : null); // the sentence at once; the word when it arrives
    if (!word) return;
    const wt = await this.word(word, context, contextOffset).catch((err) => err.message || '')
      || (this.offlineOnly ? 'Not saved offline yet' : 'Unavailable');
    if (this.tipKey === key) render(wordLine(wt));
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

  // ---------------------------------------------------------------- Prepare (for offline use)

  /** The pages Prepare is about ({ book, path, n, text, selected }; the whole book's texts are
   * loaded one by one later), or null and why (a toast). */
  preparationPages(scope) {
    if (scope === 'book') {
      const book = this.app.book;
      if (!book) { toast('Open a book first.'); return null; }
      return book.pages.filter((p) => !p.blank).map((p) => ({ book: book.slug, path: p.path, n: p.n }));
    }
    // The current page: every page shown (both pages of a spread). Selected sentences: those of the page in the picker.
    const views = scope === 'page' ? this.app.views : [this.currentView()];
    if (!views.length || views.some((v) => !v?.text)) { toast('Wait for the page text to load.'); return null; }
    let selected = null;
    if (scope === 'selected') {
      const indices = $$('input[data-tr-sentence]:checked', $('#tr-sentence-picker')).map((x) => Number(x.dataset.trSentence));
      if (!indices.length) { toast('Select at least one sentence.'); return null; }
      selected = new Set(indices);
    }
    return views.map((v) => ({ book: v.book.slug, path: v.page.path, n: v.page.n, text: v.text, selected }));
  }

  /** The plan of a page (preparationPlan), its text loaded if need be; null: no text on it. */
  async pagePlan(page, levels) {
    let text = page.text;
    if (!text) {
      const response = await fetch(`/api/text/${page.book}/${page.path}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Could not load text for page ${page.n}.`);
      const doc = await response.json();
      if (!Array.isArray(doc?.words)) throw new Error(`Page ${page.n} has no readable text data.`);
      if (!doc.words.length) return null;
      text = new PageText(doc);
    }
    return this.preparationPlan(text, page.selected || new Set(text.sent.map((_, i) => i)), levels);
  }

  /** What Prepare is about, in words: " (pages 4 and 5)". */
  preparationWhere(scope, pages) {
    if (scope === 'book') return ` (the whole book, ${pages.length} page${pages.length === 1 ? '' : 's'})`;
    if (scope === 'selected') return ` (${pages[0].selected.size} selected sentences of page ${pages[0].n})`;
    return pages.length > 1 ? ` (pages ${pages.map((p) => p.n).join(' and ')})` : ` (page ${pages[0].n})`;
  }

  /** When Prepare saved all these levels for these pages, in this browser (the latest time), or 0.
   * pages: { book, path } (the whole book: its pages are not needed). */
  preparedAt(scope, pages, levels, lang) {
    if (scope === 'selected' || !pages.length) return 0;
    const saved = store.get('trPrepared', {});
    lang = this.prepKey(lang);
    let at = 0;
    for (const page of scope === 'book' ? [{ book: pages[0].book, path: '' }] : pages) {
      for (const level of LEVELS) {
        if (!levels[level]) continue;
        // (a page of a book prepared as a whole is prepared too)
        const t = saved[`${lang}|${page.book}|${page.path}`]?.[level] || saved[`${lang}|${page.book}|`]?.[level];
        if (!t) return 0;
        at = Math.max(at, t);
      }
    }
    return at;
  }

  /** The language in the marks of what was prepared (a book not in English: with its language, as the server keeps them apart). */
  prepKey(lang) { return this.from === 'en' ? lang : `${lang}<${this.from}`; }

  markPrepared(scope, pages, levels, lang) {
    if (scope === 'selected' || !pages.length) return;
    const saved = store.get('trPrepared', {}), now = Date.now();
    lang = this.prepKey(lang);
    for (const page of scope === 'book' ? [{ book: pages[0].book, path: '' }] : pages) {
      const key = `${lang}|${page.book}|${page.path}`;
      saved[key] = { ...saved[key] };
      for (const level of LEVELS) if (levels[level]) saved[key][level] = now;
    }
    store.set('trPrepared', saved);
  }

  dateText(t) { return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }

  /** Before Prepare is clicked (after choosing what to prepare, or turning the page): whether it
   * was done before (in this browser). The bars of an earlier Prepare go. */
  showPrepared() {
    if (this.job) return;
    for (const id of ['#tr-progress', '#tr-steps', '#tr-again']) $(id).hidden = true;
    const status = $('#tr-status');
    status.classList.toggle('done', false);
    const scope = $('#tr-scope').value;
    const pages = scope === 'book' ? (this.app.book ? [{ book: this.app.book.slug }] : [])
      : scope === 'page' ? (this.app.views || []).map((v) => ({ book: v.book.slug, path: v.page.path })) : [];
    const at = this.lang ? this.preparedAt(scope, pages, this.selectedLevels(), this.lang) : 0;
    status.textContent = at ? `✓ Prepared before, on ${this.dateText(at)}, for ${this.name}. Prepare checks it again and downloads only what is missing.` : '';
    this.updateStatus();
  }

  /** A bar for every step of Prepare (the chosen levels'), under the Prepare button. */
  showSteps(levels) {
    const steps = STEPS.filter((s) => s.on(levels)).map((s) => ({ ...s, total: 0, saved: 0, none: 0 }));
    for (const step of steps) {
      step.fill = el('div', {});
      step.bar = el('div', { class: 'tr-step-bar', role: 'progressbar', 'aria-label': step.name, 'aria-valuemin': '0', 'aria-valuemax': '100' }, step.fill);
      step.count = el('span', { class: 'tr-step-count' });
      step.row = el('div', { class: 'tr-step' }, el('span', { class: 'tr-step-name' }, step.name), step.count, step.bar);
    }
    const box = $('#tr-steps');
    box.replaceChildren(...steps.map((s) => s.row));
    box.hidden = false;
    this.steps = steps;
    this.drawSteps(steps);
    return steps;
  }

  drawSteps(steps) {
    for (const step of steps) {
      const done = step.saved + step.none; // (what the translator gives nothing for is done too)
      const percent = step.total ? Math.floor(100 * done / step.total) : 0; // (100 only when all are done)
      step.fill.style.width = `${percent}%`;
      step.bar.setAttribute('aria-valuenow', String(percent));
      step.row.classList.toggle('done', step.total > 0 && done === step.total);
      step.count.textContent = !step.total ? '…'
        : `${step.saved.toLocaleString()} / ${step.total.toLocaleString()} saved` + (step.none ? `, ${step.none.toLocaleString()} without a translation` : '');
    }
  }

  /** Prepare (Translation tab). First what is saved already is read from the disk (nothing goes
   * to the translator): when everything is, it says so and asks whether to download it all again.
   * Otherwise only what is missing is downloaded, page by page, with a bar for every step and one
   * for all. again: download everything again (replacing the saved translations). */
  async prepareScope(again = false) {
    if (this.job) { this.job.stop = true; return; } // the button says "Stop" while working
    if (!this.lang) { toast('Choose the translation language first.'); $('#tr-lang').focus(); return; }
    const levels = this.selectedLevels();
    if (!Object.values(levels).some(Boolean)) { toast('Choose Sentence, Clause, Word in context or Breakdown.'); return; }
    const scope = $('#tr-scope').value;
    const pages = this.preparationPages(scope);
    if (!pages) return;
    const lang = this.lang, languageName = this.name;
    const before = this.preparedAt(scope, pages, levels, lang);
    const job = this.job = { stop: false };
    const btn = $('#tr-book'), bar = $('#tr-progress'), status = $('#tr-status');
    btn.textContent = 'Stop';
    $('#tr-again').hidden = true;
    status.classList.toggle('done', false);
    const steps = this.showSteps(levels);
    const setBar = (fraction, complete = false) => {
      const percent = Math.min(100, Math.round(100 * fraction));
      bar.hidden = false;
      bar.firstChild.style.width = `${percent}%`;
      bar.setAttribute('aria-valuenow', String(percent));
      bar.classList.toggle('done', complete);
    };
    const recount = (page) => { // the steps' counts, with this page's as they are now
      const now = this.planCounts(page.plan);
      for (const step of steps) {
        for (const n of ['total', 'saved', 'none']) step[n] += now[step.key][n] - (page.counts?.[step.key][n] || 0);
      }
      page.counts = now;
      this.drawSteps(steps);
    };
    const sum = (f) => steps.reduce((n, s) => n + f(s), 0);
    const where = this.preparationWhere(scope, pages);
    const what = LEVELS.filter((k) => levels[k]).map((k) => LEVEL_NAMES[k]).join(', ');
    let error = null, todo = 0;
    setBar(0);
    try {
      // 1. What is saved already.
      for (const [k, page] of pages.entries()) {
        if (job.stop) break;
        status.textContent = pages.length > 1
          ? `Checking what is saved already: page ${page.n} (${k + 1} of ${pages.length})…` : 'Checking what is saved already…';
        page.plan = await this.pagePlan(page, levels);
        if (page.plan) {
          await this.sendPlan(page, page.plan, { lang, cachedOnly: true });
          recount(page);
        }
        setBar((k + 1) / pages.length);
      }
      // 2. Download what is missing (everything again, when asked to), page by page.
      const left = (c) => c.total - c.saved - c.none;
      const work = job.stop ? [] : pages.filter((p) => p.plan && (again || p.counts && Object.values(p.counts).some(left)));
      if (again) {
        for (const page of work) { // (the bars fill again as they come)
          page.plan.found = page.plan.found.map((p) => p.map(() => ''));
          page.plan.none = page.plan.found.map((p) => p.map(() => ''));
          for (const w of page.plan.words) w.saved = w.none = false;
          recount(page);
        }
      }
      todo = sum(left);
      if (work.length) setBar(0);
      let dealt = 0, busy = 0;
      for (let k = 0; k < work.length && !job.stop;) {
        const page = work[k];
        status.textContent = (again ? 'Downloading everything again' : 'Downloading what is missing')
          + (work.length > 1 ? `: page ${page.n} (${k + 1} of ${work.length})…` : '…');
        try {
          const d = await this.sendPlan(page, page.plan, { lang, refresh: again, cancelled: () => job.stop,
            done: (n) => { dealt += n; recount(page); setBar(dealt / todo); } });
          if (d.stopped) break;
          busy = 0;
          k++;
          // Go gently: Google blocks for a while when it gets many requests in a row.
          if (d.fetched && k < work.length) await this.countdown(1.5, () => job.stop, () => {});
        } catch (err) {
          if (!err.busy || ++busy > 6) throw err;
          // Busy: wait as long as the server says, then go on with the same page.
          await this.countdown(err.wait, () => job.stop, (t) => {
            status.textContent = `Google’s translator asks the app to slow down (too many requests). It goes on by itself in ${t}. What is downloaded so far is saved.`;
          });
        }
      }
    } catch (err) {
      error = err.message;
    } finally {
      this.job = null;
      this.updatePrepareButton();
      // What was downloaded is shown now (also after a failure: earlier batches may have been saved).
      if (todo || error) this.clearReadCache();
    }
    const total = sum((s) => s.total), none = sum((s) => s.none), missing = sum((s) => s.total - s.saved - s.none);
    const complete = !error && !job.stop && total > 0 && !missing;
    const without = !none ? '' : ` The translator gives no translation for ${none === 1 ? 'one item' : `${none.toLocaleString()} items`} (as for some names): `
      + 'that is all right, and Prepare again asks for them again.';
    if (complete) {
      this.markPrepared(scope, pages, levels, lang);
      setBar(1, true);
    }
    status.classList.toggle('done', complete);
    status.textContent = error ? `${error} What was downloaded is kept. Click Prepare to go on.`
      : job.stop ? 'Stopped. What was downloaded is kept. Click Prepare to go on.'
        : !total ? `There is no text to prepare${where}.`
          : missing ? `${missing.toLocaleString()} translations could not be downloaded${where}; the rest are saved. Click Prepare again while connected to get them.`
            : todo ? `✓ Completed: ${what} are saved for ${languageName}${where}. They work offline.${without}`
              : `✓ Already prepared${before ? ` (on ${this.dateText(before)})` : ''}: ${what} are saved for ${languageName}${where}. No need to prepare again.${without}`;
    $('#tr-again').hidden = !(complete && !todo); // already prepared: "Prepare again" or "No need"
  }

  clearReadCache() {
    this.byDoc = new WeakMap();
    this.done = new WeakMap();
    this.words.clear();
    this.hideTip();
    if (this.listOn) this.app.renderPanelText();
  }
}

/**
 * The translation of a script (the timed lines of a recording on the Script tab, or next to a
 * video): two buttons over the lines — the translation under every line, and in a box when
 * pointing at a line — and the language. A script is translated once, a few lines at a time (for
 * context), and saved by the server like a page (the script's id instead of the page's).
 * tipHost: where the box goes (inside the video window, which is above everything else).
 */
export class ScriptTranslation {
  constructor(translator, transcript, tipHost = document.body) {
    this.tr = translator;
    this.transcript = transcript;
    this.book = this.id = null;
    this.under = store.get('cueTrUnder', false);
    this.point = store.get('cueTrPoint', false);
    this.byLang = new Map(); // lang -> Promise of one translation per line
    this.gen = 0;
    this.underBtn = el('button', { class: 'icon-btn small cue-tr-under', type: 'button', html: icon('tr-under') });
    this.pointBtn = el('button', { class: 'icon-btn small cue-tr-point', type: 'button', html: icon('tr-point') });
    this.lang = el('select', { class: 'cue-lang', 'aria-label': 'Translate into', title: 'Translate into' },
      el('option', { value: '' }, 'Translate into…'));
    this.note = el('div', { class: 'cue-note', hidden: true });
    this.tip = el('div', { class: 'tr-tip', hidden: true, role: 'tooltip' });
    tipHost.append(this.tip);

    this.underBtn.addEventListener('click', () => { this.under = !this.under; store.set('cueTrUnder', this.under); this.refresh(true); });
    this.pointBtn.addEventListener('click', () => {
      this.point = !this.point;
      store.set('cueTrPoint', this.point);
      if (!this.point) this.hideTip();
      this.refresh(true);
    });
    this.lang.addEventListener('change', () => { this.tr.setLang(this.lang.value, false); this.hideTip(); this.refresh(); });
    // Pointing at a line (a mouse), or tapping it (a finger: phones cannot point).
    const list = transcript.list;
    list.addEventListener('pointerover', (e) => { if (e.pointerType === 'mouse') this.showTip(e.target.closest('.cue')); });
    list.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') this.hideTip(); }); // (a finger "leaves" when lifted)
    list.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') this.showTip(e.target.closest('.cue')); });
    list.addEventListener('scroll', () => this.placeTip(), { passive: true }); // the box moves with its line
    this.updateButtons();
    this.setScript(null, null);
  }

  /** The script now shown: its book and id (null: a script that cannot be translated, e.g. My audio). */
  setScript(book, id) {
    this.book = book;
    this.id = id;
    this.byLang = new Map();
    this.hideTip();
    for (const e of [this.underBtn, this.pointBtn, this.lang]) e.hidden = !id;
    if (this.lang.options.length < 2) { // the languages arrive from the server after the app starts
      this.lang.append(...this.tr.langs.map((l) => el('option', { value: l.code }, l.name)));
    }
    this.lang.value = this.tr.lang;
    this.refresh();
  }

  updateButtons() {
    const set = (b, on, what) => {
      b.setAttribute('aria-pressed', String(on));
      b.title = `${what}: ${on ? 'on' : 'off'}`;
      b.setAttribute('aria-label', what);
    };
    set(this.underBtn, this.under, 'Translation under every line');
    set(this.pointBtn, this.point, 'Translation when pointing at a line');
  }

  /** The script is shown (or the settings changed): put the translations where they are wanted. */
  async refresh(clicked = false) {
    const gen = ++this.gen;
    this.updateButtons();
    this.say('');
    if (!this.under || !this.id) this.transcript.setTranslations(null);
    if ((!this.under && !this.point) || !this.id) return;
    if (!this.tr.lang) {
      if (clicked) { this.say('Choose the language to translate into.'); this.lang.focus(); }
      return;
    }
    if (!this.transcript.cues.length) return;
    let trs;
    try {
      this.say(`Translating into ${this.tr.name}…`, false, 400);
      trs = await this.load();
    } catch (err) {
      if (gen !== this.gen) return;
      if (!err.busy) { this.say(err.message, true); return; }
      // Google asks to slow down: try again by itself when it may be asked again.
      await this.tr.countdown(err.wait, () => gen !== this.gen || !this.lang.isConnected,
        (t) => this.say(`${err.message} Trying again in ${t}…`, true));
      if (gen === this.gen && this.lang.isConnected) this.refresh();
      return;
    }
    if (gen !== this.gen) return;
    this.say('');
    if (this.under) this.transcript.setTranslations(trs, this.tr.rtl ? 'rtl' : 'ltr', this.tr.lang);
  }

  /** One translation per line, in the chosen language (Promise; asked for once). */
  load() {
    const lang = this.tr.lang;
    if (!this.byLang.has(lang)) {
      const lines = this.transcript.cues.map((c) => (/\p{L}/u.test(c.x) ? c.x : '')); // not the track numbers
      const paragraphs = [];
      for (let i = 0; i < lines.length; i += 6) paragraphs.push(lines.slice(i, i + 6));
      const p = this.tr.request(this.book, this.id, paragraphs).then((d) => d.translations.flat());
      p.catch(() => this.byLang.delete(lang)); // try again next time
      this.byLang.set(lang, p);
    }
    return this.byLang.get(lang);
  }

  say(text, error = false, delay = 0) {
    clearTimeout(this.sayTimer);
    const show = () => {
      this.note.textContent = text;
      this.note.classList.toggle('err', error);
      this.note.hidden = !text;
    };
    if (delay && text) this.sayTimer = setTimeout(show, delay); else show();
  }

  async showTip(li) {
    if (!this.point || !li || !this.tr.lang || !this.id) { this.hideTip(); return; }
    if (this.tipFor === li) return;
    this.tipFor = li;
    const i = this.transcript.items.indexOf(li);
    const trs = await this.load().catch(() => null);
    if (this.tipFor !== li) return;
    if (!trs?.[i]) { this.hideTip(); return; }
    this.tip.replaceChildren(el('div', { class: 'ts', dir: this.tr.rtl ? 'rtl' : 'ltr', lang: this.tr.lang }, trs[i]));
    this.placeTip();
  }

  /** Beside the lines (over the video); where there is no room (phones), under the line or above it. */
  placeTip() {
    const li = this.tipFor;
    if (!li || !this.tip.firstChild) return;
    const r = li.getBoundingClientRect(), side = this.transcript.list.getBoundingClientRect();
    if (!li.isConnected || !side.width) { this.hideTip(); return; } // the script was closed or hidden
    this.tip.hidden = r.bottom < side.top || r.top > side.bottom; // its line is scrolled out of sight
    if (this.tip.hidden) return;
    const m = 8, tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
    let x = side.left - tw - m, y = clamp(r.top, m, innerHeight - th - m);
    if (x < m) {
      x = clamp(r.left, m, innerWidth - tw - m);
      y = r.bottom + 6 + th <= innerHeight - m ? r.bottom + 6 : Math.max(m, r.top - th - 6);
    }
    this.tip.style.left = `${x}px`;
    this.tip.style.top = `${y}px`;
  }

  hideTip() {
    this.tipFor = null;
    this.tip.hidden = true;
    this.tip.replaceChildren();
  }
}

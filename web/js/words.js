// New words: collect words, clauses and sentences from the pages in categories, and practice them as
// flashcards.
//
// Collecting (the bookmark button at the top, or N): the bar at the bottom says which category the
// new words go to (New words, Definitions, Common sentences, or one the person adds there). While
// it is on, a click on the page or in the Text list adds the word, clause or sentence under the
// pointer — which of them, "Click to hear" says (Word, Clause, Sentence) — to that category; a
// click on one already there takes it out again, on one of another category moves it here. They
// are marked on the page meanwhile, in the colour of their category. The button again (or Done)
// stops; later it adds more.
// Flashcards (the cards button, or C): which categories, what (words, clauses, sentences) and from
// where (this page, its lesson, its File, the whole book). A click on a card turns it over (and
// back): the translation (the language of the Translation tab) and, for a word or a clause, its
// sentence. ◀ ▶ (or the arrow keys) go to the card before or after. "I knew it" puts a card a box
// higher; "Again" back to box 0, and it comes again a few cards later. Saved by the server
// (words.py): the computer and the phones share them.
import { $, el, icon, store, toast } from './util.js';
import { openDialog } from './media.js';
import { speech } from './speech.js';

const MODES = ['word', 'clause', 'sentence'];
const NAMES = { word: ['word', 'words', 'Words'], clause: ['clause', 'clauses', 'Clauses'], sentence: ['sentence', 'sentences', 'Sentences'] };

/** The page numbers of a lesson ('4-7, 132') as a Set. */
function pageSet(spec) {
  const out = new Set();
  for (const part of String(spec).split(',')) {
    const [a, b] = part.trim().split('-').map(Number);
    if (Number.isFinite(a)) for (let n = a; n <= (Number.isFinite(b) ? b : a); n++) out.add(n);
  }
  return out;
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/** Ask the server; the answer's JSON, or throws its error. */
async function call(url, method = 'GET', body = undefined) {
  const r = await fetch(url, { method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body && JSON.stringify(body) }).catch(() => null);
  const d = r ? await r.json().catch(() => ({})) : null;
  if (!r) throw new Error('The app’s server is not running. Start it with Start Lingua Books.bat.');
  if (r.status === 404 && !d?.error) throw new Error('The app’s server is an older version. Close its black window and start the app again.');
  if (!r.ok) throw new Error(d.error || 'That did not work.');
  return d;
}

export class Words {
  constructor(app) {
    this.app = app;
    this.categories = [];
    this.items = [];
    this.category = store.get('words.category', 'new'); // where new words go
    this.collecting = false;
    this.translations = new Map(); // language + item -> Promise of its translation (while the page is open)
    $('#btn-collect').addEventListener('click', () => this.setCollecting(!this.collecting));
    $('#collect-done').addEventListener('click', () => this.setCollecting(false));
    $('#btn-cards').addEventListener('click', () => this.openCards());
    $('#collect-cards').addEventListener('click', () => { this.setCollecting(false); this.openCards(); });
    $('#collect-cat').addEventListener('click', () => this.showCategories($('#collect-cats').hidden));
    $('#collect-new-add').addEventListener('click', () => this.addCategory());
    $('#collect-new-name').addEventListener('keydown', (e) => {
      e.stopPropagation(); // (typing a name: no shortcuts)
      if (e.key === 'Enter') this.addCategory();
      if (e.key === 'Escape') this.showCategories(false);
    });
    // A click somewhere else closes the panel of categories.
    document.addEventListener('pointerdown', (e) => {
      if (!$('#collect-cats').hidden && !e.target.closest?.('#collect-cats, #collect-cat')) this.showCategories(false);
    });
    this.load();
  }

  async load() {
    const d = await call('/api/words').catch(() => null);
    this.categories = d?.categories || [];
    this.items = d?.items || [];
    this.renderCategories();
    this.renderMarks();
  }

  /** The new words of a page. */
  of(view) { return this.items.filter((i) => i.book === view.book.slug && i.path === view.page.path); }

  categoryOf(id) { return this.categories.find((c) => c.id === id) || { id, name: 'New words', color: '#16a34a' }; }

  // ---------------------------------------------------------------- Categories (in the bar)
  // The button in the bar shows where new words go; it opens a panel upwards from the bar (the bar
  // and the page stay where they are): the categories (each with how many new words it has) to
  // choose one, a bin to delete one (not New words), and a box to add a new one.

  /** The button of the bar, and the categories in its panel. */
  renderCategories() {
    if (!this.categories.some((c) => c.id === this.category)) this.category = 'new';
    const chosen = this.categoryOf(this.category);
    $('#collect-dot').style.background = chosen.color;
    $('#collect-cat-name').textContent = chosen.name;
    $('#collect-cat-list').replaceChildren(...this.categories.map((c) => {
      const pick = el('button', { type: 'button', class: 'pick', role: 'radio', 'aria-checked': String(c.id === chosen.id), dataset: { id: c.id } },
        el('span', { class: 'cat-dot', style: `background:${c.color}` }), el('span', { class: 'name' }, c.name),
        el('span', { class: 'count', title: 'New words in it' }, String(this.items.filter((i) => i.category === c.id).length)));
      pick.addEventListener('click', () => this.chooseCategory(c.id));
      const del = c.id === 'new' ? null : el('button', { type: 'button', class: 'icon-btn small', title: `Delete “${c.name}”`, 'aria-label': `Delete the category ${c.name}`, html: icon('trash') });
      del?.addEventListener('click', () => this.deleteCategory(c));
      return el('div', { class: 'collect-cat-row' }, pick, del);
    }));
  }

  /** Open (or close) the panel of categories. */
  showCategories(open) {
    $('#collect-cats').hidden = !open;
    $('#collect-cat').setAttribute('aria-expanded', String(open));
    if (open) {
      this.renderCategories();
      $('#collect-cat-list [aria-checked="true"]')?.focus({ preventScroll: true });
    }
  }

  /** Esc: close the panel of categories, if it is open. True if it was. */
  closeCategories() {
    if ($('#collect-cats').hidden) return false;
    this.showCategories(false);
    return true;
  }

  chooseCategory(id) {
    this.category = id;
    store.set('words.category', id);
    this.showCategories(false);
    this.renderCategories();
    this.renderMarks();
  }

  async deleteCategory(c) {
    const n = this.items.filter((i) => i.category === c.id).length;
    if (!confirm(`Delete the category “${c.name}”?${n ? `\n\nIts ${n} new word${n === 1 ? '' : 's'} go${n === 1 ? 'es' : ''} back to New words.` : ''}`)) return;
    try {
      await call(`/api/words/categories/${c.id}`, 'DELETE');
      if (this.category === c.id) { this.category = 'new'; store.set('words.category', 'new'); }
      await this.load(); // (its words are New words now)
    } catch (err) { toast(err.message); }
  }

  async addCategory() {
    const input = $('#collect-new-name'), name = input.value.trim();
    if (!name) { input.focus(); return; }
    try {
      const c = await call('/api/words/categories', 'POST', { name });
      this.categories.push(c);
      input.value = '';
      this.chooseCategory(c.id);
      toast(`New words now go to “${c.name}”.`, 1800);
    } catch (err) { toast(err.message); }
  }

  // ---------------------------------------------------------------- Collecting

  setCollecting(on) {
    if (on && this.app.me?.mode === 'public' && !this.app.me.user) { // on a website they belong to an account
      this.app.library.accountDialog('signup', 'Create a free account (or log in) to keep your new words.');
      return;
    }
    this.collecting = on;
    if (on) {
      this.app.reader.stop();
      if (this.app.recordings.picking) this.app.recordings.stopPicking();
      if (this.app.editor.active) this.app.editor.stop();
      if (this.app.mode === 'off') this.app.setMode('word'); // (a click has to choose something)
      this.renderCategories();
    }
    document.body.classList.toggle('collecting', on);
    $('#btn-collect').setAttribute('aria-pressed', String(on));
    $('#collect-bar').hidden = !on;
    if (!on) this.showCategories(false);
    this.renderMarks();
  }

  /**
   * Collecting: add the word, clause or sentence clicked to the chosen category; one there already
   * is taken out again, one of another category is moved to this one.
   */
  async toggle(view, unit) {
    const t = view.text;
    if (!t || !unit) return;
    const had = this.of(view).find((i) => i.mode === unit.mode && i.a === unit.a && i.b === unit.b);
    if (had?.category === this.category) {
      if (await this.remove(had)) toast(`Taken out: ${had.text}`, 1200);
      return;
    }
    const [sa, sb] = t.sent[t.w2s[unit.a]];
    let text = t.text(unit.a, unit.b), offset = 0;
    if (unit.mode === 'word') ({ word: text, contextOffset: offset } = this.app.translator.wordQuery(t, unit));
    else for (let i = sa; i < unit.a; i++) offset += t.words[i][4].length + (t.words[i][6] && i < sb - 1 ? 1 : 0);
    if (!text) return; // (only a symbol)
    const item = { book: view.book.slug, bookId: view.book.id, page: view.page.n, path: view.page.path, mode: unit.mode,
      a: unit.a, b: unit.b, text, context: t.text(sa, sb), contextOffset: offset, category: this.category };
    let d;
    try { d = await call('/api/words', 'POST', { items: [item] }); } catch (err) { toast(err.message); return; }
    for (const saved of d.items) {
      const i = this.items.findIndex((x) => x.id === saved.id);
      if (i >= 0) this.items[i] = saved;
      else this.items.push(saved);
    }
    if (had) toast(`Moved to “${this.categoryOf(this.category).name}”: ${had.text}`, 1500);
    view.flash(unit);
    this.renderMarks();
  }

  async remove(item) {
    try { await call(`/api/words/${item.id}`, 'DELETE'); } catch (err) { if (!/not found/.test(err.message)) { toast(err.message); return false; } }
    this.items = this.items.filter((i) => i.id !== item.id);
    this.renderMarks();
    return true;
  }

  /** Mark the new words on the pages shown (seen while collecting), and count them in the bar. */
  renderMarks() {
    const mine = this.app.views.flatMap((v) => {
      const list = this.of(v);
      v.showCollected(list.map((i) => ({ ...i, color: this.categoryOf(i.category).color })));
      return list;
    });
    const here = this.categories.map((c) => [c, mine.filter((i) => i.category === c.id).length]).filter(([, n]) => n);
    $('#collect-label').textContent = here.length
      ? `${this.app.views.length > 1 ? 'These pages' : 'This page'}: ${here.map(([c, n]) => `${n} in ${c.name}`).join(', ')}`
      : `Click ${NAMES[this.app.mode]?.[1] || 'words'} to add them`;
  }

  pageShown() { this.renderMarks(); }

  // ---------------------------------------------------------------- Flashcards
  // Three filters — lists, the same on the list of cards and above the card while practicing, and
  // remembered: the category (all, or one), what (words, clauses and sentences, or only one kind),
  // and from where (the page(s) shown, their lesson, their File, the whole book, or any lesson, File
  // or page that has cards).

  /** The parts of the book to practice from: [{id, group, label, test(item)}]. */
  ranges(book) {
    const inBook = this.items.filter((i) => i.book === book.slug);
    const shown = this.app.views.filter((v) => v.book.slug === book.slug);
    const paths = new Set(shown.map((v) => v.page.path));
    const lessons = book.lessons || [];
    const name = (l) => (l.id === l.title ? l.title : `${l.id} ${l.title}`);
    const unitOf = (unit) => lessons.filter((l) => l.unit === unit);
    const pagesOf = (list) => new Set(list.flatMap((l) => [...pageSet(l.pages)]));
    const has = (pages) => inBook.some((i) => pages.has(Number(i.page)));
    const test = (pages) => (i) => pages.has(Number(i.page));
    const here = 'Where you are';
    const out = [{ id: 'page', group: here, label: shown.length > 1 ? `These pages (${shown.map((v) => v.page.n).join(' and ')})` : `This page (${shown[0]?.page.n ?? ''})`,
      test: (i) => paths.has(i.path) }];
    const n = Number(book.pages[this.app.idx]?.n);
    const lesson = lessons.find((l) => pageSet(l.pages).has(n));
    if (lesson) {
      out.push({ id: 'lesson', group: here, label: `This lesson: ${name(lesson)}`, test: test(pagesOf([lesson])) });
      if (unitOf(lesson.unit).length > 1) out.push({ id: 'unit', group: here, label: `This File: ${lesson.unit}`, test: test(pagesOf(unitOf(lesson.unit))) });
    }
    out.push({ id: 'book', group: here, label: `The whole ${book.type || 'book'}`, test: () => true });
    for (const l of lessons) {
      const pages = pagesOf([l]);
      if (has(pages)) out.push({ id: `lesson:${l.id}`, group: 'Lessons', label: name(l), test: test(pages) });
    }
    for (const unit of new Set(lessons.map((l) => l.unit))) {
      const list = unitOf(unit), pages = pagesOf(list);
      if (list.length > 1 && has(pages)) out.push({ id: `unit:${unit}`, group: 'Files', label: `${unit} (${list.map((l) => l.id).join(', ')})`, test: test(pages) });
    }
    for (const p of [...new Set(inBook.map((i) => i.page))].sort((x, y) => Number(x) - Number(y))) {
      out.push({ id: `page:${p}`, group: 'Pages', label: `Page ${p}`, test: (i) => i.page === p });
    }
    return out;
  }

  /** The filters chosen (remembered): {cat, kind, from}; one that is not there any more: the first. */
  filters(ranges) {
    let cat = store.get('cards.cat', 'all'), kind = store.get('cards.kind', 'all'), from = store.get('cards.from', store.get('cards.scope', 'lesson'));
    if (cat !== 'all' && !this.categories.some((c) => c.id === cat)) cat = 'all';
    if (kind !== 'all' && !MODES.includes(kind)) kind = 'all';
    if (!ranges.some((r) => r.id === from)) from = ranges.some((r) => r.id === 'lesson') ? 'lesson' : ranges[0].id;
    return { cat, kind, from };
  }

  /** The cards of the book that the filters (f, or those chosen) let through, in the order of the pages. */
  cardsFor(book, ranges, f = this.filters(ranges)) {
    const range = ranges.find((r) => r.id === f.from) || ranges[0];
    return this.items.filter((i) => i.book === book.slug && (f.cat === 'all' || i.category === f.cat) && (f.kind === 'all' || i.mode === f.kind) && range.test(i))
      .sort((a, b) => Number(a.page) - Number(b.page) || a.a - b.a);
  }

  /**
   * The three lists, each choice with how many cards it gives (with the other two as they are).
   * onChange() after a choice. compact: without their names (above the card).
   */
  filterLists(book, ranges, onChange, compact = false) {
    const f = this.filters(ranges);
    const count = (o) => this.cardsFor(book, ranges, { ...f, ...o }).length;
    const list = (key, role, label, options) => {
      const sel = el('select', { class: 'select small', 'aria-label': label, title: label, dataset: { role } }, ...options);
      sel.value = f[key];
      sel.addEventListener('change', () => { store.set(`cards.${key}`, sel.value); onChange(); });
      return compact ? sel : el('label', { class: 'field cards-filter' }, el('span', {}, label), sel);
    };
    const groups = [...new Set(ranges.map((r) => r.group))];
    return el('div', { class: compact ? 'fc-filters' : 'cards-filters' },
      list('cat', 'cards-category', 'Category', [
        el('option', { value: 'all' }, `All categories (${count({ cat: 'all' })})`),
        ...this.categories.map((c) => el('option', { value: c.id }, `${c.name} (${count({ cat: c.id })})`))]),
      list('kind', 'cards-kind', 'Show', [
        el('option', { value: 'all' }, `Words, clauses and sentences (${count({ kind: 'all' })})`),
        ...MODES.map((m) => el('option', { value: m }, `Only ${NAMES[m][1]} (${count({ kind: m })})`))]),
      list('from', 'cards-from', 'From', groups.map((g) => el('optgroup', { label: g },
        ...ranges.filter((r) => r.group === g).map((r) => el('option', { value: r.id }, `${r.label} (${count({ from: r.id })})`))))));
  }

  /** A checkbox for a remembered setting (true by default). */
  setting(key, label) {
    const box = el('input', { type: 'checkbox', checked: store.get(key, true) });
    box.addEventListener('change', () => store.set(key, box.checked));
    return el('label', { class: 'check cards-say' }, box, label);
  }

  /** The cards to practice: the three filters, how to show them, the list (delete one), Start. */
  openCards() {
    const book = this.app.book;
    if (!book) return;
    if (this.collecting) this.setCollecting(false);
    this.app.reader.stop();
    const tr = this.app.translator;
    const body = el('div', { class: 'cards-setup' });
    const render = () => {
      const ranges = this.ranges(book), chosen = this.cardsFor(book, ranges);
      const front = store.get('cards.front', 'en');
      const start = el('button', { class: 'btn primary', type: 'button', disabled: !chosen.length, dataset: { role: 'cards-start' },
        html: `${icon('cards')}Start (${chosen.length} card${chosen.length === 1 ? '' : 's'})` });
      start.addEventListener('click', () => this.practice(chosen, { back: show, book }));
      body.replaceChildren(...[
        this.filterLists(book, ranges, render),
        el('p', { class: 'sub-head' }, 'Show first'),
        el('div', { class: 'seg', role: 'radiogroup' }, ...[['en', tr.fromName], ['tr', tr.lang ? tr.name || 'Translation' : 'Translation']].map(([v, label]) => {
          const b = el('button', { type: 'button', role: 'radio', 'aria-checked': String(front === v), disabled: v === 'tr' && !tr.lang }, label);
          b.addEventListener('click', () => { store.set('cards.front', v); render(); });
          return b;
        })),
        this.setting('cards.say', `Read the ${tr.fromName} aloud`),
        this.setting('cards.example', 'Show the example sentence on the back (also while practicing: the ≡ icon, or E)'),
        tr.lang ? null : el('p', { class: 'hint' }, 'To see the meanings on the back of the cards, choose a language in Settings → Translation.'),
        el('div', { class: 'rec-buttons cards-start' }, start), // (above the cards: the list can be long)
        chosen.length ? el('ul', { class: 'cards-list' }, ...chosen.map((i) => {
          const c = this.categoryOf(i.category);
          const del = el('button', { class: 'icon-btn small', type: 'button', title: 'Delete this card', 'aria-label': `Delete ${i.text}`, html: icon('trash') });
          del.addEventListener('click', async () => { if (await this.remove(i)) render(); });
          return el('li', {}, el('span', { class: 'cat-dot', style: `background:${c.color}`, title: c.name }), el('span', { class: `cards-text ${i.mode}` }, i.text),
            el('span', { class: 'cards-meta' }, `${c.name} · ${NAMES[i.mode][0]} · p.${i.page}${i.box ? ` · ${'●'.repeat(i.box)}` : ''}`), del);
        })) : el('p', { class: 'hint' }, this.items.some((i) => i.book === book.slug)
          ? 'No cards for these choices. Choose another category, kind or part of the book.'
          : 'No new words yet. Click the bookmark button at the top (N), then click words, clauses or sentences on the page.'),
      ].filter(Boolean));
    };
    // One dialog: the list of cards, or practicing (keys: Space, ← →, 1, 2, E), until it is closed.
    const show = () => { this.cardKeys = null; render(); $('#md-body').replaceChildren(body); }; // (also back from practicing)
    const dialog = $('#media-dialog'), keys = (e) => this.cardKeys?.(e);
    render();
    openDialog('Flashcards', body, () => { dialog.removeEventListener('keydown', keys); this.cardKeys = null; speech.stop(); });
    dialog.addEventListener('keydown', keys);
  }

  /** The translation of a card ({mode, text, context …}), or of its sentence (part 'context'). */
  translation(item, part = 'text') {
    const t = this.app.translator;
    if (!t.lang) return Promise.resolve('');
    const key = `${t.lang}|${item.id}|${part}`;
    if (!this.translations.has(key)) {
      const p = part === 'text' && item.mode === 'word' ? t.word(item.text, item.context, item.contextOffset)
        : t.request(item.book, item.path, [[part === 'context' ? item.context : item.text]]).then((d) => d.translations?.[0]?.[0] || '');
      p.catch(() => this.translations.delete(key));
      this.translations.set(key, p);
    }
    return this.translations.get(key);
  }

  /**
   * Practice the cards (those known least first, in a new order each time). A click on a card
   * turns it over; ◀ ▶ go to the card before or after; Again / I knew it answer it and go on.
   * Above the card: the three filters (a choice there starts again with the cards it gives), and
   * showing or hiding the example sentence on the back (E).
   */
  practice(cards, { back, book }) {
    const t = this.app.translator, dir = t.rtl ? 'rtl' : 'ltr';
    const reverse = store.get('cards.front', 'en') === 'tr' && !!t.lang;
    const deck = shuffle([...cards]).sort((a, b) => (a.box || 0) - (b.box || 0)); // ("Again" puts a card in once more)
    const firstTime = new Map(); // card id -> known the first time it was answered
    let at = 0, flipped = false, shown = null;
    const body = el('div', { class: 'cards-practice' });
    // The filters: another choice, another round with its cards.
    const ranges = this.ranges(book);
    const filters = this.filterLists(book, ranges, () => { speech.stop(); this.practice(this.cardsFor(book, ranges), { back, book }); }, true);
    // The example sentence (with its translation) on the back of the cards: shown or not.
    let example = store.get('cards.example', true);
    const exampleBtn = el('button', { class: 'icon-btn small', type: 'button', 'aria-label': 'The example sentence on the back', dataset: { role: 'cards-example' }, html: icon('text') });
    const showExample = () => {
      body.classList.toggle('no-example', !example);
      exampleBtn.setAttribute('aria-pressed', String(example));
      exampleBtn.title = `${example ? 'Hide' : 'Show'} the example sentence on the back of the cards (E)`;
    };
    const toggleExample = () => { example = !example; store.set('cards.example', example); showExample(); };
    exampleBtn.addEventListener('click', toggleExample);
    showExample();
    const say = (text) => { if (store.get('cards.say', true)) speech.speak(text); };
    const hear = (text, lang) => {
      const b = el('button', { class: 'icon-btn small', type: 'button', title: 'Listen', 'aria-label': 'Listen', html: icon('volume') });
      b.addEventListener('click', (e) => { e.stopPropagation(); if (lang) speech.speakTranslation(text, lang); else speech.speak(text); });
      return b;
    };
    /** The sentence of a word or clause, with it marked. */
    const inContext = (i) => {
      const k = i.context.indexOf(i.text, Math.max(0, (i.contextOffset || 0) - 1));
      return k < 0 ? i.context : [i.context.slice(0, k), el('mark', {}, i.context.slice(k, k + i.text.length)), i.context.slice(k + i.text.length)];
    };
    const known = () => [...firstTime.values()].filter(Boolean).length;
    const go = (to) => {
      if (to < 0) return;
      if (to >= deck.length) { finish(); return; }
      at = to;
      draw();
    };
    const flip = () => {
      if (!shown) return;
      flipped = !flipped;
      shown.card.classList.toggle('flipped', flipped);
      shown.card.setAttribute('aria-pressed', String(flipped));
      if (flipped && reverse) say(shown.item.text);
    };
    const answer = (ok) => {
      const item = deck[at];
      if (!item || !shown) return;
      call(`/api/words/${item.id}`, 'PUT', { known: ok })
        .then((saved) => Object.assign(this.items.find((x) => x.id === saved.id) || {}, saved)).catch(() => {});
      if (!firstTime.has(item.id)) firstTime.set(item.id, ok);
      if (!ok) deck.splice(Math.min(at + 4, deck.length), 0, item); // again, a few cards later
      go(at + 1);
    };
    const draw = async () => {
      speech.stop();
      flipped = false;
      const item = deck[at], c = this.categoryOf(item.category);
      const english = el('div', { class: 'fc-en' }, item.text, hear(item.text));
      const meta = el('div', { class: 'fc-meta' }, el('span', { class: 'cat-dot', style: `background:${c.color}` }), `${c.name} · ${NAMES[item.mode][0]} · p.${item.page}`);
      const meaning = el('div', { class: 'fc-tr', dir, lang: t.lang }, t.lang ? '…' : 'No translation language chosen');
      const own = item.mode === 'sentence' || item.context === item.text; // (a clause that is the whole sentence)
      const sentence = own ? null : el('div', { class: 'fc-context' }, inContext(item));
      const sentenceTr = own || !t.lang ? null : el('div', { class: 'fc-context-tr', dir, lang: t.lang });
      const frontFace = el('div', { class: 'fc-face fc-front' }, ...(reverse ? [meaning, meta] : [english, meta]),
        el('div', { class: 'fc-hint' }, 'Click to turn over'));
      const backFace = el('div', { class: 'fc-face fc-back' }, ...[reverse ? english : meaning, sentence, sentenceTr].filter(Boolean));
      const card = el('div', { class: `fc-card ${item.mode}`, role: 'button', tabindex: '0', 'aria-pressed': 'false', title: 'Turn the card over (Space)' },
        el('div', { class: 'fc-inner' }, frontFace, backFace));
      card.addEventListener('click', flip);
      shown = { item, card };
      const prev = el('button', { class: 'fc-nav', type: 'button', title: 'The card before (←)', 'aria-label': 'The card before', disabled: at === 0, html: icon('left') });
      const next = el('button', { class: 'fc-nav', type: 'button', title: 'The card after (→)', 'aria-label': 'The card after', html: icon('right') });
      prev.addEventListener('click', () => go(at - 1));
      next.addEventListener('click', () => go(at + 1));
      const again = el('button', { class: 'btn', type: 'button', dataset: { role: 'cards-again' } }, '✗ Again (1)');
      const knew = el('button', { class: 'btn primary', type: 'button', dataset: { role: 'cards-knew' } }, '✓ I knew it (2)');
      again.addEventListener('click', () => answer(false));
      knew.addEventListener('click', () => answer(true));
      const stop = el('button', { class: 'btn small', type: 'button', dataset: { role: 'cards-end' } }, 'Stop');
      stop.addEventListener('click', () => { speech.stop(); back(); });
      body.replaceChildren(filters,
        el('div', { class: 'fc-top' }, exampleBtn, el('span', { class: 'fc-progress' }, `Card ${at + 1} of ${deck.length} · ${known()} known`), stop),
        el('div', { class: 'fc-stage' }, prev, card, next),
        el('div', { class: 'rec-buttons fc-buttons' }, again, knew));
      card.focus();
      if (!reverse) say(item.text);
      if (t.lang) {
        const text = await this.translation(item).catch(() => '');
        if (shown?.item !== item || !card.isConnected) return;
        meaning.replaceChildren(text || (t.offlineOnly ? 'Not saved offline yet' : 'No translation (no internet?)'));
        if (text) meaning.append(hear(text, t.lang));
        if (sentenceTr) sentenceTr.textContent = await this.translation(item, 'context').catch(() => '');
      }
    };
    const finish = () => {
      speech.stop();
      shown = null;
      const missed = [...firstTime].filter(([, ok]) => !ok).map(([id]) => id);
      const choose = el('button', { class: 'btn', type: 'button' }, 'Choose cards');
      const more = el('button', { class: 'btn primary', type: 'button', disabled: !missed.length }, `Practice the ${missed.length} I missed`);
      choose.addEventListener('click', back);
      more.addEventListener('click', () => this.practice(cards.filter((c) => missed.includes(c.id)), { back, book }));
      body.replaceChildren(el('div', { class: 'fc-done' },
        el('h3', {}, 'All done!'),
        el('p', {}, firstTime.size ? `${known()} of ${firstTime.size} known the first time.` : 'You went through the cards without answering them.'),
        el('div', { class: 'rec-buttons' }, choose, more)));
      (missed.length ? more : choose).focus();
    };
    this.cardKeys = (e) => {
      if (!body.isConnected || !shown || e.target.closest?.('input, select, textarea')) return;
      const keys = { ' ': flip, Enter: flip, ArrowLeft: () => go(at - 1), ArrowRight: () => go(at + 1), 1: () => answer(false), 2: () => answer(true),
        e: toggleExample, E: toggleExample };
      if (!keys[e.key] || (e.key === 'Enter' && e.target.closest?.('button'))) return;
      e.preventDefault();
      keys[e.key]();
    };
    $('#md-body').replaceChildren(body); // (in the dialog of openCards)
    if (deck.length) { draw(); return; }
    // No cards for these choices: the filters, to choose others.
    const stop = el('button', { class: 'btn small', type: 'button', dataset: { role: 'cards-end' } }, 'Stop');
    stop.addEventListener('click', back);
    body.replaceChildren(filters, el('div', { class: 'fc-top' }, exampleBtn, el('span', { class: 'fc-progress' }, 'No cards'), stop),
      el('p', { class: 'hint fc-none' }, 'No cards for these choices. Choose another category, kind or part of the book.'));
  }
}

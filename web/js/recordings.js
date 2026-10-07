// "My audio": natural-voice MP3s of chosen sentences, made by the local server (web/tts.py).
// Choose whole paragraphs or single sentences, create one MP3, then play it from an icon next
// to the paragraph or from the list. While it plays, the text is highlighted like when reading.
import { $, el, icon, store, toast, fmtTime } from './util.js';
import { speakable } from './pagetext.js';
import { settings, repeatTimes } from './speech.js';
import { openDialog, closeDialog } from './media.js';

const gapMs = () => Math.round((Number(settings.gap) || 0) * 1000);

const ACCENTS = {
  'en-US': 'American', 'en-GB': 'British', 'en-AU': 'Australian', 'en-CA': 'Canadian', 'en-IE': 'Irish',
  'en-NZ': 'New Zealand', 'en-IN': 'Indian', 'en-ZA': 'South African', 'en-SG': 'Singapore',
  'en-PH': 'Philippine', 'en-HK': 'Hong Kong', 'en-KE': 'Kenyan', 'en-NG': 'Nigerian', 'en-TZ': 'Tanzanian',
};
const COUNTRY = {
  'United States': 'en-US', 'United Kingdom': 'en-GB', Australia: 'en-AU', Canada: 'en-CA', Ireland: 'en-IE',
  'New Zealand': 'en-NZ', India: 'en-IN', 'South Africa': 'en-ZA',
};
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const fileName = (r) => `${(r.title || 'audio').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80)}.mp3`;

export class Recordings {
  constructor(app) {
    this.app = app;
    this.list = [];             // recordings without timing details
    this.full = new Map();      // id -> recording with the timing of every sentence and word
    this.assets = new Map();    // id -> player asset
    this.resolved = new WeakMap(); // page text doc -> Map(id -> sentence ranges on that page)
    this.picking = false;
    this.picked = new Map();    // view -> Set(sentence index)
    this.filter = store.get('recFilter', 'page');
    this.playingId = null;
    this.box = $('#rec-view');
    this.bind();
    this.load();
  }

  async load() {
    try {
      const r = await fetch('/api/recordings', { cache: 'no-store' });
      this.list = r.ok ? await r.json() : [];
    } catch { this.list = []; }
    this.renderList();
    this.renderSpots();
  }

  bind() {
    $('#rec-new').addEventListener('click', () => this.startPicking());
    $('#rec-cancel').addEventListener('click', () => this.stopPicking());
    $('#rec-create').addEventListener('click', () => this.openCreate());
    $('#rec-search').addEventListener('input', () => this.renderList());
    for (const b of document.querySelectorAll('#rec-filter button')) {
      b.addEventListener('click', () => { this.filter = b.dataset.f; store.set('recFilter', this.filter); this.renderList(); });
    }
    this.box.addEventListener('click', (e) => (this.picking ? this.onPickClick(e) : this.onListClick(e)));
  }

  // ---------------------------------------------------------------- The list

  renderList() {
    document.querySelectorAll('#rec-filter button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.f === this.filter)));
    if (this.picking) return;
    const q = norm($('#rec-search').value).toLowerCase();
    const paths = new Set(this.app.views.map((v) => v.page.path));
    const items = this.list.filter((r) => {
      if (this.filter === 'page' && !r.paths.some((p) => paths.has(p))) return false;
      if (this.filter === 'book' && r.book !== this.app.book?.slug) return false;
      return !q || `${r.title} ${r.text}`.toLowerCase().includes(q);
    });
    if (!items.length) {
      const msg = q ? 'Nothing matches your search.'
        : this.filter === 'page' ? 'No audio for this page yet. Click “New audio” and choose the sentences to read.'
          : 'No audio yet. Click “New audio” and choose the sentences to read.';
      this.box.replaceChildren(el('div', { class: 'empty' }, msg));
      return;
    }
    this.box.replaceChildren(el('ul', { class: 'rec-list' }, ...items.map((r) => {
      const playing = r.id === this.playingId;
      return el('li', { class: `rec${playing ? ' playing' : ''}`, dataset: { id: r.id } },
        el('button', { class: 'icon-btn rec-play', dataset: { act: 'play' }, title: playing ? 'Pause' : 'Play', html: icon(playing ? 'pause' : 'play') }),
        el('div', { class: 'rec-main' },
          el('div', { class: 'rec-title' }, r.title),
          el('button', { class: 'rec-meta', dataset: { act: 'goto' }, title: 'Go to this page' },
            `${r.bookType} p.${r.page} · ${fmtTime(r.duration)} · ${r.voiceName || r.voice} · ${r.count} sentence${r.count === 1 ? '' : 's'}`),
          el('div', { class: 'rec-text' }, r.text.length > 150 ? `${r.text.slice(0, 150)}…` : r.text)),
        el('div', { class: 'rec-tools' },
          el('a', { class: 'icon-btn small', href: r.file, download: fileName(r), title: 'Download the MP3', html: icon('download') }),
          el('a', { class: 'icon-btn small cc', href: r.srt, download: fileName(r).replace(/\.mp3$/, '.srt'), title: 'Download the subtitles (.srt): the time of every sentence' }, 'CC'),
          el('button', { class: 'icon-btn small', dataset: { act: 'rename' }, title: 'Rename', html: icon('pencil') }),
          el('button', { class: 'icon-btn small', dataset: { act: 'delete' }, title: 'Delete', html: icon('trash') })));
    })));
  }

  onListClick(e) {
    const btn = e.target.closest('[data-act]');
    const id = e.target.closest('.rec')?.dataset.id;
    if (!btn || !id) return;
    const r = this.list.find((x) => x.id === id);
    if (btn.dataset.act === 'play') this.play(id, { tab: null });
    else if (btn.dataset.act === 'goto') this.app.go(r.bookId, r.page);
    else if (btn.dataset.act === 'rename') this.rename(r);
    else if (btn.dataset.act === 'delete') this.remove(r);
  }

  async rename(r) {
    const title = prompt('New name for this audio:', r.title);
    if (!title || !title.trim() || title === r.title) return;
    const res = await fetch(`/api/recordings/${r.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
    }).catch(() => null);
    if (!res?.ok) { toast('Could not rename. Is the app window still open?'); return; }
    Object.assign(r, await res.json());
    if (this.full.has(r.id)) this.full.get(r.id).title = r.title;
    if (this.assets.has(r.id)) this.assets.get(r.id).title = `My audio: ${r.title}`;
    this.renderList();
    this.renderSpots();
  }

  async remove(r) {
    if (!confirm(`Delete the audio “${r.title}”?`)) return;
    const res = await fetch(`/api/recordings/${r.id}`, { method: 'DELETE' }).catch(() => null);
    if (!res?.ok) { toast('Could not delete. Is the app window still open?'); return; }
    if (this.app.audio.asset?.rec?.id === r.id) this.app.audio.close();
    this.list = this.list.filter((x) => x.id !== r.id);
    this.full.delete(r.id);
    this.assets.delete(r.id);
    this.renderList();
    this.renderSpots();
    toast('Audio deleted');
  }

  // ---------------------------------------------------------------- Playing

  async loadFull(id) {
    if (!this.full.has(id)) {
      const r = await fetch(`/api/recordings/${id}`, { cache: 'no-store' }).catch(() => null);
      if (!r?.ok) throw new Error('missing');
      this.full.set(id, await r.json());
    }
    return this.full.get(id);
  }

  assetFor(rec) {
    if (!this.assets.has(rec.id)) {
      this.assets.set(rec.id, {
        t: 'recording', src: rec.file, title: `My audio: ${rec.title}`, rec,
        cues: rec.sentences.map((s) => ({ t: Math.round(s.start * 1000), x: s.text })),
      });
    }
    return this.assets.get(rec.id);
  }

  /**
   * A recording that reads this unit (sentence, clause or word) on this page, and where:
   * {rec, k: sentence number, t: start second, end: stop second (word mode) or null}.
   * The recording in the player is tried first, then the page's recordings, newest first.
   */
  async locate(view, unit) {
    if (!view.text) return null;
    const ids = [];
    const loaded = this.app.audio.asset?.rec?.id;
    if (loaded) ids.push(loaded);
    for (const r of this.list) {
      if (r.book === view.book.slug && r.paths.includes(view.page.path) && !ids.includes(r.id)) ids.push(r.id);
    }
    for (const id of ids) {
      let rec;
      try { rec = await this.loadFull(id); } catch { continue; }
      const ranges = this.resolve(view, rec);
      const k = ranges.findIndex((r) => r && unit.a >= r.a && unit.a < r.b);
      if (k < 0) continue;
      const s = rec.sentences[k], r = ranges[k];
      if (unit.mode === 'sentence' || !r.exact) return { rec, k, t: s.start, end: null };
      const w = s.words[unit.a - r.a]; // clause or word: start at its first word
      return { rec, k, t: Math.max(s.start, w[0] - 0.05), end: unit.mode === 'word' ? w[1] + 0.12 : null };
    }
    return null;
  }

  /** Play a recording from a located place. Clicking the sentence being played pauses / continues. */
  async playFrom(hit, fromPage) {
    const a = this.app.audio;
    const asset = this.assetFor(hit.rec);
    if (!hit.end && a.asset === asset && a.open && this.followKey === `${hit.rec.id}:${hit.k}`) {
      a.toggle();
      return;
    }
    this.cancelWait();
    this.stopAt = hit.end;
    this.stopFrom = hit.t;
    this.wordRound = 1;
    this.loop = { id: hit.rec.id, k: hit.k, round: 1 }; // "Repeat each sentence" counts from here
    await a.play(asset, { tab: fromPage ? 'text' : null, at: hit.t });
  }

  /** Play from `at` again, after `ms` of silence (the player waits paused meanwhile). */
  replay(at, ms) {
    const a = this.app.audio;
    if (!ms) { a.seek(at, true); return; }
    a.pause();
    this.wait = setTimeout(() => { this.wait = null; a.seek(at, true); }, ms);
  }

  /** The user paused, moved or closed the player while it waited to repeat: do not repeat. */
  cancelWait() {
    if (!this.wait) return;
    clearTimeout(this.wait);
    this.wait = null;
    this.stopAt = null;
    this.loop = null;
  }

  /** The MP3 ended: repeat its last sentence if wanted. Returns true if it plays again. */
  ended(asset) {
    const rec = asset?.rec, L = this.loop;
    if (!rec || !L || L.id !== rec.id || L.k !== rec.sentences.length - 1 || L.round >= repeatTimes()) return false;
    L.round++;
    this.replay(rec.sentences[L.k].start, gapMs());
    return true;
  }

  /** Play (or pause) a recording, on its page. tab: side panel tab to show (null: keep). */
  async play(id, { tab = 'text' } = {}) {
    const sum = this.list.find((r) => r.id === id);
    if (!sum) return;
    if (!this.app.views.some((v) => v.page.path === sum.path)) {
      this.app.go(sum.bookId, sum.page);
      await this.app.pageReady;
    }
    let rec;
    try { rec = await this.loadFull(id); } catch { toast('This audio file is missing.'); return; }
    this.app.audio.play(this.assetFor(rec), { tab });
  }

  markPlaying(asset, on) {
    const id = asset?.rec?.id;
    if (!id) return;
    this.playingId = on ? id : this.playingId === id ? null : this.playingId;
    this.app.views.forEach((v) => v.markRecPlaying(id, on));
    if (!this.picking) this.renderList();
  }

  /** Where each sentence of a recording is in the page text now (text corrections can move it). */
  resolve(view, rec) {
    let byRec = this.resolved.get(view.doc);
    if (!byRec) { byRec = new Map(); this.resolved.set(view.doc, byRec); }
    if (!byRec.has(rec.id)) {
      const t = view.text;
      const texts = t.sent.map(([a, b]) => norm(t.text(a, b)));
      byRec.set(rec.id, rec.sentences.map((s) => {
        if (s.path !== view.page.path) return null;
        if (s.b <= t.words.length && norm(t.text(s.a, s.b)) === norm(s.text)) return { a: s.a, b: s.b, exact: true };
        const i = texts.indexOf(norm(s.text));
        if (i < 0) return null;
        const [a, b] = t.sent[i];
        return { a, b, exact: b - a === s.b - s.a };
      }));
    }
    return byRec.get(rec.id);
  }

  /** Highlight the sentence and word being played (called many times a second). */
  follow(rec, ms) {
    if (this.wait) return; // waiting to repeat: the sentence stays highlighted
    const t = ms / 1000;
    const times = repeatTimes();
    if (this.stopAt != null && t >= this.stopAt) { // word mode: just the clicked word (again, if wanted)
      if (this.wordRound < times) {
        this.wordRound++;
        this.replay(this.stopFrom, Math.max(600, gapMs()));
        return;
      }
      this.stopAt = null;
      this.app.audio.pause();
    }
    // "Repeat each sentence": the MP3 has just gone on to the next sentence by itself (after the
    // pause the MP3 has between sentences), so go back to the start of the one being repeated.
    const L = this.loop;
    if (L && L.id === rec.id && this.stopAt == null && L.round < times && !this.app.audio.audio.paused) {
      const cur = rec.sentences[L.k], until = rec.sentences[L.k + 1]?.start ?? cur?.end;
      if (cur && t + 0.03 >= until && t < until + 0.6) {
        L.round++;
        this.replay(cur.start, gapMs());
        return;
      }
    }
    let k = -1;
    rec.sentences.forEach((s, i) => { if (s.start <= t + 0.03) k = i; });
    if (!L || L.id !== rec.id || L.k !== k) this.loop = { id: rec.id, k, round: 1 };
    const s = rec.sentences[k];
    const view = s && this.app.views.find((v) => v.page.path === s.path && v.book.slug === rec.book && v.text);
    const range = view ? this.resolve(view, rec)[k] : null;
    const key = range ? `${rec.id}:${k}` : null;
    if (key !== this.followKey) {
      this.unfollow();
      this.followKey = key;
      if (range) {
        const unit = { mode: 'sentence', a: range.a, b: range.b };
        view.showActive(unit);
        this.app.markPanel('active', view, unit);
        this.app.reveal(view, unit);
        this.app.centerPanel(view, unit);
        this.app.focus = { view, w: range.a };
      }
    }
    if (!range || !range.exact || !settings.follow) return;
    let j = -1;
    s.words.forEach(([ws], i) => { if (ws <= t) j = i; });
    if (j !== this.followWord) {
      this.followWord = j;
      this.app.showWord(view, j >= 0 ? range.a + j : -1);
    }
  }

  unfollow() {
    if (this.followKey === undefined) return;
    this.followKey = undefined;
    this.followWord = -1;
    this.app.views.forEach((v) => { v.showActive(null); v.showWord(-1); });
    this.app.markPanel('active', null, null);
    this.app.markPanel('cur', null, null);
  }

  // ---------------------------------------------------------------- Icons on the page

  renderSpots() {
    for (const view of this.app.views) {
      if (!view.text) { view.setRecSpots([], () => {}); continue; }
      const used = new Map();
      const spots = this.list.filter((r) => r.path === view.page.path && r.book === view.book.slug).map((r) => {
        // Next to the first sentence of the recording (found again if the text was corrected).
        const f = r.first;
        let range = null;
        if (f) {
          const t = view.text;
          if (f.b <= t.words.length && norm(t.text(f.a, f.b)) === norm(f.text)) range = [f.a, f.b];
          else range = t.sent.find(([a, b]) => norm(t.text(a, b)) === norm(f.text)) || null;
        }
        const box = range && view.text.rects(range[0], range[1])[0];
        let x = box ? box.x : 110, y = box ? box.y + box.h / 2 : 60; // the icon is drawn left of x
        const k = `${Math.round(x)},${Math.round(y)}`;
        y += (used.get(k) || 0) * 48; // several recordings starting at the same sentence
        used.set(k, (used.get(k) || 0) + 1);
        return { id: r.id, title: r.title, x, y };
      });
      view.setRecSpots(spots, (id) => this.play(id));
      if (this.playingId) view.markRecPlaying(this.playingId, true);
    }
  }

  // ---------------------------------------------------------------- Choosing sentences

  startPicking() {
    if (this.app.editor.active) this.app.editor.stop();
    this.app.reader.stop();
    this.picking = true;
    this.picked = new Map();
    this.anchor = null;
    // Start with the paragraph you are on (being read, last read or clicked), if any.
    const f = this.app.currentFocus();
    if (f?.view?.text) {
      const s = f.view.text.w2s[f.w];
      const block = f.view.text.blocks.find(([a, b]) => s >= a && s < b);
      if (block) this.picked.set(f.view, new Set(Array.from({ length: block[1] - block[0] }, (_, i) => block[0] + i)));
    }
    document.body.classList.add('picking');
    $('#rec-actions').hidden = true;
    $('#rec-pick-actions').hidden = false;
    $('#rec-search-row').hidden = true;
    this.app.setPanelOpen(true);
    this.app.showTab('audio');
    this.app.applyMode();
    this.update();
    const first = this.box.querySelector('.prow.on');
    if (first) this.app.centerInPanel(first, first, false);
  }

  stopPicking() {
    if (!this.picking) return;
    this.picking = false;
    this.picked = new Map();
    document.body.classList.remove('picking');
    $('#rec-actions').hidden = false;
    $('#rec-pick-actions').hidden = true;
    $('#rec-search-row').hidden = false;
    this.app.views.forEach((v) => v.showPicks([]));
    this.app.applyMode();
    this.renderList();
  }

  /** The shown pages changed. */
  pageShown() {
    if (this.picking) { this.picked = new Map(); this.update(); }
    this.renderList();
  }

  setOf(view) {
    if (!this.picked.has(view)) this.picked.set(view, new Set());
    return this.picked.get(view);
  }

  /**
   * A click on sentence s. Click the first sentence, then the last one: everything in between
   * is chosen. Clicking a chosen sentence removes it; Ctrl+click picks or drops just one.
   */
  toggle(view, s, e = {}) {
    const set = this.setOf(view);
    if (e.ctrlKey || e.metaKey) {
      if (set.has(s)) set.delete(s); else set.add(s);
      this.anchor = null;
    } else if (set.has(s)) {
      set.delete(s);
      if (this.anchor?.view === view && this.anchor.s === s) this.anchor = null;
    } else if (this.anchor?.view === view && set.has(this.anchor.s)) {
      for (let i = Math.min(s, this.anchor.s); i <= Math.max(s, this.anchor.s); i++) set.add(i);
      this.anchor = null; // the range is complete: the next click starts a new one
    } else {
      set.add(s);
      this.anchor = { view, s }; // the first sentence: wait for the last one
    }
    this.update();
  }

  toggleBlock(view, bi) {
    const [a, b] = view.text.blocks[bi];
    const set = this.setOf(view);
    const all = Array.from({ length: b - a }, (_, i) => a + i);
    if (all.every((s) => set.has(s))) all.forEach((s) => set.delete(s));
    else all.forEach((s) => set.add(s));
    this.anchor = null;
    this.update();
  }

  pageClick(view, unit, e) {
    const s = view.text?.w2s[unit.a] ?? -1;
    if (s >= 0) this.toggle(view, s, e || {});
  }

  pickedSentences() {
    const out = [];
    for (const view of this.app.views) {
      const set = this.picked.get(view);
      if (!set?.size || !view.text) continue;
      for (const s of [...set].sort((x, y) => x - y)) {
        const [a, b] = view.text.sent[s];
        const words = [];
        for (let k = a; k < b; k++) words.push(speakable(view.text.words[k][4]));
        out.push({ view, path: view.page.path, a, b, text: view.text.text(a, b), words });
      }
    }
    return out;
  }

  update() {
    const n = this.pickedSentences().length;
    $('#rec-count').textContent = this.anchor ? 'Now click the last sentence' : `${n} sentence${n === 1 ? '' : 's'} chosen`;
    $('#rec-create').disabled = n === 0;
    for (const view of this.app.views) {
      const set = this.picked.get(view) || new Set();
      view.showPicks([...set].map((s) => view.text.sentenceUnit(s)));
    }
    this.renderPick();
  }

  renderPick() {
    const keep = this.box.closest('.tab-body').scrollTop;
    const out = [el('p', { class: 'edit-hint' },
      'Click the first sentence, then the last one: everything in between is chosen. ' +
      'The box next to a paragraph chooses the whole paragraph. Ctrl+click picks or drops a single sentence. ' +
      'This works in the list and on the page.'),
    el('div', { class: 'pick-tools' },
      el('button', { class: 'link-btn', dataset: { pick: 'all' } }, 'Choose everything'), ' · ',
      el('button', { class: 'link-btn', dataset: { pick: 'none' } }, 'Clear'))];
    this.app.views.forEach((view, vi) => {
      out.push(el('h4', {}, `Page ${view.page.n}`));
      if (!view.text?.sent.length) { out.push(el('div', { class: 'empty' }, 'There is no text on this page.')); return; }
      const set = this.picked.get(view) || new Set();
      view.text.blocks.forEach(([sa, sb], bi) => {
        const count = Array.from({ length: sb - sa }, (_, i) => sa + i).filter((s) => set.has(s)).length;
        const box = el('input', { type: 'checkbox', checked: count === sb - sa, 'aria-label': 'The whole paragraph', dataset: { pick: 'block', v: vi, b: bi } });
        box.indeterminate = count > 0 && count < sb - sa;
        const rows = [];
        for (let s = sa; s < sb; s++) {
          const isAnchor = this.anchor?.view === view && this.anchor.s === s;
          rows.push(el('label', { class: `prow${set.has(s) ? ' on' : ''}${isAnchor ? ' anchor' : ''}` },
            el('input', { type: 'checkbox', checked: set.has(s), dataset: { pick: 'sent', v: vi, s } }),
            el('span', {}, view.text.text(...view.text.sent[s]))));
        }
        out.push(el('div', { class: `pblock${count ? ' some' : ''}` }, el('div', { class: 'pblock-box', title: 'Choose the whole paragraph' }, box), el('div', {}, ...rows)));
      });
    });
    this.box.replaceChildren(...out);
    this.box.closest('.tab-body').scrollTop = keep;
  }

  onPickClick(e) {
    const t = e.target.closest('[data-pick]');
    if (!t) return;
    if (t.dataset.pick === 'all' || t.dataset.pick === 'none') {
      for (const view of this.app.views) {
        const set = this.setOf(view);
        set.clear();
        if (t.dataset.pick === 'all') view.text?.sent.forEach((_, i) => set.add(i));
      }
      this.update();
      return;
    }
    e.preventDefault(); // the list is drawn again with the new state
    const view = this.app.views[Number(t.dataset.v)];
    if (t.dataset.pick === 'block') this.toggleBlock(view, Number(t.dataset.b));
    else this.toggle(view, Number(t.dataset.s), e);
  }

  // ---------------------------------------------------------------- Creating an audio

  voices() {
    if (!this.voicesPromise) {
      this.voicesPromise = fetch('/api/voices').then(async (r) => {
        if (r.status === 404) {
          throw new Error('The app’s server is an older version. Close the black “American English File 3” window and start the app again with Start American English File.bat.');
        }
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(`${data.error || 'The voices could not be loaded.'} Making audio needs the internet (playing it later does not).`);
        return data;
      }, () => { throw new Error('The app’s server is not running. Start the app with Start American English File.bat.'); });
      this.voicesPromise.catch(() => { this.voicesPromise = null; });
    }
    return this.voicesPromise;
  }

  /** The Natural voice that matches the reading voice chosen in the app, if any. */
  defaultVoice(voices) {
    const saved = store.get('recVoice', null);
    if (saved && voices.some((v) => v.id === saved)) return saved;
    const m = (settings.voiceURI || '').match(/Microsoft (\w+) Online \(Natural\) - English \(([^)]+)\)/);
    const same = m && voices.find((v) => v.name === m[1] && v.locale === COUNTRY[m[2]]);
    return same?.id || voices.find((v) => v.id === 'en-US-AriaNeural')?.id || voices[0]?.id;
  }

  openCreate() {
    const sents = this.pickedSentences();
    if (!sents.length) return;
    const words = sents.reduce((n, s) => n + s.words.length, 0);
    const field = (label, control, out) => el('label', { class: 'field' }, el('span', {}, label, out || ''), control);
    const title = el('input', { type: 'text', class: 'input', maxlength: '120', value: sents[0].text.slice(0, 60) });
    const voice = el('select', { class: 'select' }, el('option', {}, 'Loading voices…'));
    const tryBtn = el('button', { class: 'btn small', type: 'button', html: `${icon('volume')}Try` });
    const rate = el('input', { type: 'range', min: '-50', max: '50', step: '5', value: String(store.get('recRate', 0)) });
    const rateOut = el('output');
    const gap = el('input', { type: 'range', min: '0', max: '10', step: '0.5', value: String(store.get('recGap', settings.gap || 0)) });
    const gapOut = el('output');
    const showRate = () => { rateOut.textContent = Number(rate.value) ? `${Number(rate.value) > 0 ? '+' : ''}${rate.value}%` : 'normal'; };
    const showGap = () => { gapOut.textContent = Number(gap.value) ? `${Number(gap.value)} s` : 'none'; };
    const estimate = () => `${sents.length} sentence${sents.length === 1 ? '' : 's'} · about ${fmtTime(
      (words / 2.6) / (1 + Number(rate.value) / 100) + Number(gap.value) * (sents.length - 1))}`;
    const summary = el('p', { class: 'hint' }, estimate());
    rate.addEventListener('input', () => { showRate(); summary.textContent = estimate(); });
    gap.addEventListener('input', () => { showGap(); summary.textContent = estimate(); });
    showRate();
    showGap();
    const error = el('p', { class: 'rec-error', hidden: true });
    const bar = el('div', { class: 'rec-progress', hidden: true }, el('div'));
    const status = el('p', { class: 'hint', hidden: true });
    const create = el('button', { class: 'btn primary', type: 'button', disabled: true, html: `${icon('wave')}Create MP3` });
    const cancel = el('button', { class: 'btn', type: 'button' }, 'Cancel');
    cancel.addEventListener('click', () => closeDialog());

    this.voices().then((voices) => {
      const groups = new Map();
      for (const v of voices) {
        const g = ACCENTS[v.locale] || v.locale;
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(v);
      }
      voice.replaceChildren(...[...groups].map(([g, vs]) => el('optgroup', { label: `${g} English` },
        ...vs.map((v) => el('option', { value: v.id }, `${v.name} — ${v.gender.toLowerCase()}`)))));
      voice.value = this.defaultVoice(voices);
      create.disabled = false;
      this.voiceList = voices;
    }).catch((err) => {
      voice.replaceChildren(el('option', {}, 'Not available'));
      error.textContent = err.message;
      error.hidden = false;
    });

    tryBtn.addEventListener('click', () => {
      const a = new Audio(`/api/voice-sample?voice=${encodeURIComponent(voice.value)}&rate=${rate.value}`);
      a.play().catch(() => toast('The voice could not be played. Is the internet connected?'));
    });

    create.addEventListener('click', async () => {
      const v = this.voiceList?.find((x) => x.id === voice.value);
      if (!v) return;
      store.set('recVoice', v.id);
      store.set('recRate', Number(rate.value));
      store.set('recGap', Number(gap.value));
      const first = sents[0].view;
      const body = {
        book: first.book.slug, bookId: first.book.id, bookType: first.book.type, page: first.page.n, path: first.page.path,
        title: title.value.trim(), voice: v.id, voiceName: v.name, rate: Number(rate.value), gap: Number(gap.value),
        sentences: sents.map(({ path, a, b, text, words: w }) => ({ path, a, b, text, words: w })),
      };
      create.disabled = true;
      error.hidden = true;
      bar.hidden = false;
      status.hidden = false;
      status.textContent = 'Starting…';
      try {
        const rec = await this.create(body, (done, total) => {
          bar.firstChild.style.width = `${(done / total) * 100}%`;
          status.textContent = `Creating the audio… ${done} of ${total} sentences`;
        });
        closeDialog();
        this.stopPicking();
        this.list.unshift(rec);
        this.renderList();
        this.renderSpots();
        toast(`Audio “${rec.title}” is ready. Play it from the icon next to the paragraph.`);
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        bar.hidden = true;
        status.hidden = true;
        create.disabled = false;
      }
    });

    openDialog('New audio', el('div', { class: 'rec-form' },
      field('Title', title),
      el('div', { class: 'field' }, el('span', {}, 'Voice'), el('div', { class: 'row' }, voice, tryBtn)),
      field('Speed ', rate, rateOut),
      field('Pause between sentences ', gap, gapOut),
      summary, error, bar, status,
      el('div', { class: 'rec-buttons' }, cancel, create)));
    title.focus();
    title.select();
  }

  /** Ask the server to make the MP3 and wait for it. progress(done, total). */
  async create(body, progress) {
    const r = await fetch('/api/recordings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).catch(() => null);
    if (!r) throw new Error('The app server is not running. Start the app again with the .bat file.');
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'The audio could not be created.');
    for (;;) {
      await new Promise((ok) => setTimeout(ok, 500));
      const j = await fetch(`/api/jobs/${data.job}`, { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
      if (!j) throw new Error('The app server stopped while creating the audio.');
      progress(j.done || 0, j.total || body.sentences.length);
      if (j.state === 'done') return j.recording;
      if (j.state !== 'running') throw new Error(j.error || 'The audio could not be created.');
    }
  }
}

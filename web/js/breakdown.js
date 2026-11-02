// Breaking a sentence down. Beside the sentence pointed at on the page (or in the Text list) — else
// beside the one being read, or read / clicked last — a small button (or B, or a double click on
// the sentence on the page; on a phone or tablet a finger held on it, also in the list); it opens a panel:
// the sentence and its translation (the language of the Translation tab), then every word with its
// meaning in that sentence. Each can be heard (the word: the English voice, its meaning: the voice
// of the translation), at the speed chosen there; "Play all words" reads each word, then its
// meaning. Pointing at (or playing) a word marks it in the sentence, and its meaning in the
// translation where it is found there. A Chinese sentence has its pinyin: over every character of
// the sentence, and beside every word (made by the server: web/pinyin.py).
import { el, icon, store, toast } from './util.js';
import { openDialog } from './media.js';
import { speech } from './speech.js';

const KEEP_MS = 700; // the button stays this long after the pointer left the sentence (time to reach it)
const SWITCH_MS = 350; // another sentence pointed at: the button goes there after this (time to reach it across that one)
const HAN = /\p{Script=Han}/u; // (Chinese characters: also in Japanese, which gets no pinyin)
const pinyins = new Map(); // text -> Promise of the pinyin of each of its characters ('' for others)

/** The pinyin of every character of a text (asked once per text). */
function pinyinOf(text) {
  if (!pinyins.has(text)) {
    const p = fetch('/api/pinyin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texts: [text] }) })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (r.status === 404) throw new Error('The app’s server is an older version: close its black window and start the app again.');
        if (!r.ok) throw new Error(d.error || 'The pinyin could not be made.');
        return d.pinyin[0];
      });
    p.catch(() => pinyins.delete(text)); // (another try next time)
    pinyins.set(text, p);
  }
  return pinyins.get(text);
}

/** Letters and digits only: 'ستقرأون.' and 'ستقرأون' are the same translation. */
const same = (x) => String(x || '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * The parts of a sentence: neighbouring words whose translation in the sentence is the same (they
 * are translated together) are one part, {items, text, meaning}; a word on its own, one part.
 */
function groupParts(words, t, a, b) {
  const parts = [];
  for (const item of words) {
    const last = parts[parts.length - 1];
    if (last && item.meaning && same(item.meaning) === same(last.meaning) && item.w === last.items[last.items.length - 1].w + 1) last.items.push(item);
    else parts.push({ items: [item], meaning: item.meaning });
  }
  for (const part of parts) { // its words as on the page (a group: from its first word to its last)
    const w0 = part.items[0].w, w1 = part.items[part.items.length - 1].w;
    part.text = part.items.length > 1 ? t.text(w0, w1 + 1).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '') : part.items[0].word;
  }
  return parts;
}

export class Breakdown {
  constructor(app) {
    this.app = app;
    this.hovered = null; // {view, a, b}: the sentence pointed at
    this.active = null;  // the sentence being read (or played from an MP3)
    this.overButton = false;
    this.shown = null;   // the sentence the button shows for
    this.timer = 0;
    this.playing = 0;    // which "Play all words" is going on (another number stops it)
  }

  /** The sentence of a unit (a word, a clause, a sentence) of a page: {view, a, b}, or null. */
  sentenceOf(view, unit) {
    const t = view?.text, s = unit ? t?.w2s[unit.a] : -1;
    return s >= 0 ? { view, a: t.sent[s][0], b: t.sent[s][1] } : null;
  }

  /**
   * The app marks what is pointed at ('hover') or read ('active'): the button moves there. Another
   * sentence pointed at while the button shows moves it after SWITCH_MS: on the way to the button
   * (at the end of the line, after the next sentence) the pointer crosses that one.
   */
  track(kind, view, unit) {
    const s = this.sentenceOf(view, unit);
    if (kind === 'active') { this.active = s; this.place(); return; }
    clearTimeout(this.timer);
    if (s && this.shown && !(s.view === this.shown.view && s.a === this.shown.a)) {
      this.timer = setTimeout(() => { if (!this.overButton) { this.hovered = s; this.place(); } }, SWITCH_MS);
      return;
    }
    if (s) { this.hovered = s; this.place(); return; }
    this.timer = setTimeout(() => { if (!this.overButton) { this.hovered = null; this.place(); } }, KEEP_MS);
  }

  /** The sentence the button is for: pointed at, else being read, else clicked or read last. */
  target() {
    const shown = (s) => (s && this.app.views.includes(s.view) ? s : null);
    const f = this.app.focus;
    return shown(this.hovered) || shown(this.active) || shown(f && this.sentenceOf(f.view, { a: f.w, b: f.w + 1 }));
  }

  /** Put the button beside that sentence (and nowhere else). */
  place() {
    const at = this.target();
    this.shown = null; // (the sentence the button shows for)
    for (const view of this.app.views) {
      const btn = view.showBreakdown(at?.view === view ? at : null, () => this.open(at));
      if (btn) this.shown = at;
      if (btn && !btn.dataset.bd) {
        btn.dataset.bd = '1';
        btn.addEventListener('pointerenter', () => { this.overButton = true; clearTimeout(this.timer); });
        btn.addEventListener('pointerleave', () => { this.overButton = false; this.track('hover', null, null); });
      }
    }
  }

  /** B: break down the sentence pointed at, being read or clicked last. */
  openCurrent() {
    const at = this.target();
    if (at) this.open(at);
    else toast('Point at a sentence (or click it) first.');
  }

  stop() {
    this.playing++;
    speech.stop();
  }

  /**
   * The panel of a sentence ({view, a, b}). Each word is translated in its sentence; words that
   * come back with the same translation are one part of the sentence (You're going to read →
   * ستقرأون, an article → مقالاً): they are shown together, with that meaning — and, opened, each of
   * them with its own meaning out of the sentence (word by word).
   */
  async open({ view, a, b }) {
    const t = view.text, tr = this.app.translator;
    if (!t) return;
    if (this.app.reader.state === 'playing') this.app.reader.pause(); // (one voice at a time)
    this.app.audio.pause?.();
    const lang = tr.lang, dir = tr.rtl ? 'rtl' : 'ltr';
    const words = [];
    for (let w = a; w < b; w++) {
      const q = tr.wordQuery(t, { a: w, b: w + 1 });
      if (q.word) words.push({ w, ...q, meaning: '' });
    }
    const english = t.text(a, b);
    let sentenceTr = '', parts = [];
    let rate = Number(store.get('breakdown.rate', 0.9));

    // (onWord: each word as it is said, by its place in the text)
    const sayEnglish = (text, onWord) => new Promise((ok) => { if (!speech.speak(text, { rate, onWord, onEnd: ok, onError: ok })) ok(); });
    const sayMeaning = (text, onWord) => new Promise((ok) => {
      if (!lang || !text || !speech.speakTranslation(text, lang, { rate, onWord, onEnd: ok, onError: ok })) ok();
    });
    const hear = (title, say) => {
      const btn = el('button', { class: 'icon-btn small', type: 'button', title, 'aria-label': title, html: icon('volume') });
      btn.addEventListener('click', (e) => { e.stopPropagation(); this.stop(); say(); });
      return btn;
    };

    // The sentence, its words marked when their part is pointed at or played.
    const spans = new Map();
    const sentenceLine = el('span', { class: 'bd-text' });
    for (let w = a; w < b; w++) {
      const span = el('span', { class: 'w' }, t.words[w][4]);
      spans.set(w, span);
      sentenceLine.append(span, t.words[w][6] && w < b - 1 ? ' ' : '');
    }
    // Chinese: the pinyin of each character (over it in the sentence), of each word (beside it below).
    const chinese = HAN.test(english) && !['ja', 'ko'].includes(tr.from);
    const pinyinNote = el('p', { class: 'hint', hidden: true });
    const pinyinOfWord = (w) => (w.pinyin || '');
    const pinyinOfPart = (part) => part.items.map(pinyinOfWord).join('');
    const translationText = el('span', { class: 'bd-text' }, lang ? '…' : '');
    /**
     * Where each part's meaning is in the sentence's translation: Map(part → [start, end]). A
     * meaning there twice (的 … 的 → of … of) gives each part its own place, in the order of the
     * sentence; longer meanings first ("related to" before "to"); whole words where words have
     * spaces between them ("an" not in "and"), else wherever it is.
     */
    const placesIn = (text) => {
      const lower = text.toLocaleLowerCase(), taken = [], at = new Map();
      const letter = (i) => i >= 0 && i < lower.length && /[\p{L}\p{N}]/u.test(lower[i]);
      const meaning = (p) => (p.meaning || '').toLocaleLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      for (const p of [...parts].sort((x, y) => meaning(y).length - meaning(x).length)) {
        const m = meaning(p);
        if (!m) continue;
        const found = [];
        for (let k = lower.indexOf(m); k >= 0; k = lower.indexOf(m, k + 1)) {
          if (!taken.some(([s, e]) => k < e && k + m.length > s)) found.push(k);
        }
        const k = found.find((i) => !letter(i - 1) && !letter(i + m.length)) ?? found[0];
        if (k === undefined) continue;
        taken.push([k, k + m.length]);
        at.set(p, [k, k + m.length]);
      }
      return at;
    };
    /**
     * Mark a part (its row, its words in the sentence, its meaning in the translation); null: none.
     * While the sentence is said: only its word being said (word); while the translation is said:
     * only what is being said of it (said: [start, end]).
     */
    const mark = (part, { word, said } = {}) => {
      parts.forEach((p) => p.row?.classList.toggle('on', p === part));
      const ws = new Set(word !== undefined ? [word] : part ? part.items.map((i) => i.w) : []);
      spans.forEach((span, w) => span.classList.toggle('on', ws.has(w)));
      const [k, end] = said || (part && sentenceTr && placesIn(sentenceTr).get(part)) || [];
      translationText.replaceChildren(...(k === undefined ? [sentenceTr || (lang ? '…' : '')]
        : [sentenceTr.slice(0, k), el('mark', {}, sentenceTr.slice(k, end)), sentenceTr.slice(end)]));
      part?.row?.scrollIntoView({ block: 'nearest' });
    };
    // Following the voice: where each word of the sentence starts in its text.
    const starts = [];
    for (let w = a, at = 0; w < b; w++) {
      starts.push(at);
      at += t.words[w][4].length + (t.words[w][6] && w < b - 1 ? 1 : 0);
    }
    /** The sentence being said: the word said (at character c), its part's row and its meaning in the translation. */
    const followSentence = (c) => {
      let w = a;
      while (w + 1 < b && starts[w + 1 - a] <= c) w++;
      mark(parts.find((p) => p.items.some((i) => i.w === w)) || null, { word: w });
    };
    /** The translation being said: the word said (c, its length n), and the words of the sentence it is the meaning of. */
    const followTranslation = (c, n) => {
      n ||= (/^(?:[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+)/u
        .exec(sentenceTr.slice(c)) || [''])[0].length;
      const places = placesIn(sentenceTr);
      const part = parts.find((p) => { const at = places.get(p); return at && c < at[1] && c + n > at[0]; });
      mark(part || null, { said: [c, c + n] });
    };
    const playPart = async (part, id = ++this.playing) => {
      speech.stop();
      mark(part);
      await sayEnglish(part.text);
      if (id !== this.playing) return false;
      await new Promise((ok) => setTimeout(ok, 250));
      if (id !== this.playing) return false;
      await sayMeaning(part.meaning);
      return id === this.playing;
    };
    spans.forEach((span, w) => {
      span.addEventListener('pointerenter', () => { const part = parts.find((p) => p.items.some((i) => i.w === w)); if (part) mark(part); });
      span.addEventListener('click', () => { const part = parts.find((p) => p.items.some((i) => i.w === w)); if (part) playPart(part); });
    });

    // The parts of the sentence and their meanings (drawn when the meanings are there).
    const table = el('table', { class: 'bd-words' }, el('tbody', {}, el('tr', {}, el('td', { class: 'hint' }, lang ? 'Translating each word in this sentence…' : 'Choose a translation language first.'))));
    /** A part of several words, opened: each word with its own meaning (in a row of its own under the part). */
    const wordByWord = (part, sub, holder, button) => {
      if (holder.childElementCount) {
        sub.hidden = !sub.hidden;
        button.setAttribute('aria-expanded', String(!sub.hidden));
        if (!sub.hidden) sub.scrollIntoView({ block: 'nearest' });
        return;
      }
      button.setAttribute('aria-expanded', 'true');
      sub.hidden = false;
      requestAnimationFrame(() => sub.scrollIntoView({ block: 'nearest' })); // (the last part opened: its words in sight, in the list)
      for (const item of part.items) {
        const own = el('span', { dir, lang }, '…');
        holder.append(el('div', { class: 'bd-sub' },
          hear(`Hear “${item.word}”`, () => sayEnglish(item.word)), el('span', { class: 'bd-sub-en' }, item.word,
            item.pinyin ? el('span', { class: 'bd-py' }, item.pinyin) : null), el('span', { class: 'bd-arrow' }, '→'),
          own, hear('Hear its meaning', () => sayMeaning(own.textContent))));
        // Its own meaning: the word alone (not in the sentence) — word by word.
        tr.word(item.word, '', null).then((m) => { own.textContent = m || '?'; }).catch(() => { own.textContent = '?'; });
      }
    };
    const drawParts = () => {
      table.tBodies[0].replaceChildren(...parts.flatMap((part) => {
        const row = el('tr', {});
        const more = part.items.length > 1
          ? el('button', { class: 'btn small bd-more', type: 'button', 'aria-expanded': 'false', title: 'Each of these words with its own meaning' }, 'word by word') : null;
        const holder = el('div', { class: 'bd-subs' });
        const sub = el('tr', { class: 'bd-subrow', hidden: true }, el('td', { colspan: '3' }, holder));
        more?.addEventListener('click', (e) => { e.stopPropagation(); wordByWord(part, sub, holder, more); });
        const py = pinyinOfPart(part);
        row.append(
          el('td', { class: 'bd-en' }, hear(`Hear “${part.text}”`, () => { mark(part); sayEnglish(part.text); }), el('span', {}, part.text),
            py ? el('span', { class: 'bd-py' }, py) : null, more),
          el('td', { class: 'bd-arrow', 'aria-hidden': 'true' }, '→'),
          el('td', { class: 'bd-tr' }, el('span', { dir, lang }, part.meaning || (tr.offlineOnly ? 'not saved offline yet' : '?')),
            part.meaning ? hear('Hear its meaning', () => { mark(part); sayMeaning(part.meaning); }) : null));
        row.addEventListener('pointerenter', () => mark(part));
        part.row = row;
        return more ? [row, sub] : [row];
      }));
      count.textContent = `${words.length} word${words.length === 1 ? '' : 's'}${parts.length < words.length ? ` in ${parts.length} parts` : ''}`;
    };

    // Speed, and every part one after the other.
    const speed = el('input', { type: 'range', min: '0.5', max: '1.5', step: '0.05', value: String(rate), 'aria-label': 'Speed of the voices here' });
    const speedOut = el('output', {}, `${rate.toFixed(2).replace(/0$/, '')}×`);
    speed.addEventListener('input', () => {
      rate = Number(speed.value);
      store.set('breakdown.rate', rate);
      speedOut.textContent = `${rate.toFixed(2).replace(/0$/, '')}×`;
    });
    const all = el('button', { class: 'btn small primary', type: 'button', title: 'Each word (or group of words) and then its meaning', html: `${icon('play')}Play all` });
    all.addEventListener('click', async () => {
      if (all.dataset.on) { this.stop(); return; }
      const id = ++this.playing;
      all.dataset.on = '1';
      all.innerHTML = `${icon('stop')}Stop`;
      for (const part of parts) {
        if (!(await playPart(part, id))) break;
        await new Promise((ok) => setTimeout(ok, 450));
        if (id !== this.playing) break;
      }
      if (all.isConnected) { delete all.dataset.on; all.innerHTML = `${icon('play')}Play all`; mark(null); }
    });
    const count = el('span', { class: 'bd-count' }, `${words.length} word${words.length === 1 ? '' : 's'}`);

    const body = el('div', { class: 'bd' },
      el('div', { class: 'bd-line bd-sentence' }, hear('Hear the sentence', () => {
        mark(null);
        sayEnglish(english, followSentence).then(() => mark(null)); // (stopped by another voice: it does not end)
      }), sentenceLine),
      el('div', { class: 'bd-line bd-translation', dir, lang: lang || undefined }, lang ? hear('Hear the translation', () => {
        mark(null);
        sayMeaning(sentenceTr, followTranslation).then(() => mark(null));
      }) : null, translationText),
      pinyinNote,
      lang ? null : el('p', { class: 'hint' }, 'Choose the language of the meanings: ',
        el('button', { class: 'btn small', type: 'button', onclick: () => this.app.openSettings?.('translation') }, 'Settings → Translation')),
      el('div', { class: 'bd-tools' }, count, el('label', { class: 'bd-speed' }, el('span', {}, 'Speed '), speed, speedOut), all),
      el('div', { class: 'bd-scroll' }, table));
    table.addEventListener('pointerleave', () => mark(null));
    sentenceLine.addEventListener('pointerleave', () => mark(null));
    openDialog('Break down the sentence', body, () => this.stop());
    if (chinese) {
      // Each word's place in the sentence (in characters): its characters get their pinyin from there.
      let text = '';
      const at = new Map();
      for (let w = a; w < b; w++) {
        at.set(w, [...text].length);
        text += t.words[w][4] + (t.words[w][6] && w < b - 1 ? ' ' : '');
      }
      pinyinOf(text).then((py) => {
        spans.forEach((span, w) => span.replaceChildren(...[...t.words[w][4]].map((ch, i) => {
          const s = py[at.get(w) + i];
          return s ? el('ruby', {}, ch, el('rt', {}, s)) : ch;
        })));
        for (const item of words) item.pinyin = [...t.words[item.w][4]].map((_, i) => py[at.get(item.w) + i]).join('');
        if (parts.length) drawParts(); // (the meanings came first)
      }).catch((err) => { pinyinNote.textContent = `No pinyin: ${err.message}`; pinyinNote.hidden = false; });
    }
    if (!lang) return;

    // The translations: the sentence (as on the page), and each word in this sentence — one request.
    tr.forView(view).then((trs) => {
      sentenceTr = trs?.[t.w2s[a]] || '';
      if (translationText.isConnected) translationText.textContent = sentenceTr || (tr.offlineOnly ? 'Not saved offline yet' : 'No translation (no internet?)');
    }).catch((err) => { translationText.textContent = err.message; });
    try {
      const d = await tr.requestWords(words.map(({ word, context, contextOffset }) => ({ word, context, contextOffset })));
      words.forEach((item, i) => { item.meaning = d.translations[i] || ''; });
    } catch (err) {
      toast(err.message || 'The meanings could not be fetched.');
    }
    parts = groupParts(words, t, a, b);
    drawParts();
  }

}

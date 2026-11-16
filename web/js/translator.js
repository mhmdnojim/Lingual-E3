// The Translator page (the Voice Bridge app inside Lingua Books): two languages, each side speaks or
// types, the other side reads and hears the translation. The conversation is kept on this device.
// Translating uses the site's translator (POST /api/translator); speaking uses the browser's speech
// recognition, listening the voices of speech.js.
import { el, store, toast } from './util.js';
import { openDialog } from './media.js';
import { speech } from './speech.js';

const KEEP = 60;           // messages kept
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

/** Ask the server to translate `text` from `from` into `lang`. */
export async function translateText(text, lang, from) {
  const r = await fetch('/api/translator', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, lang, from }),
  }).catch(() => null);
  if (!r) throw new Error('The app could not reach its server.');
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
  return d.text || '';
}

export class Translator {
  constructor() {
    this.langs = [];
    this.a = store.get('translatorA', 'en');
    this.b = store.get('translatorB', 'ar');
    this.read = store.get('translatorRead', true);
    this.messages = store.get('translator', []).filter((m) => m && m.text && m.lang);
    this.listening = null;   // the side being dictated: 'a' | 'b'
    this.rec = null;
  }

  async open() {
    if (!this.langs.length) {
      try { this.langs = await (await fetch('/api/tr-languages')).json(); } catch { this.langs = []; }
      if (!Array.isArray(this.langs) || !this.langs.length) { toast('The translator is not available now.'); return; }
    }
    openDialog('Translator', this.build(), () => this.stop());
    this.renderList();
  }

  name(code) { return this.langs.find((l) => l.code === code)?.name || code; }
  rtl(code) { return !!this.langs.find((l) => l.code === code)?.rtl; }

  select(side) {
    const sel = el('select', { class: 'select', 'aria-label': side === 'a' ? 'First language' : 'Second language' },
      ...this.langs.map((l) => el('option', { value: l.code }, `${l.name}${l.native && l.native !== l.name ? ` · ${l.native}` : ''}`)));
    sel.value = this[side];
    sel.addEventListener('change', () => {
      this[side] = sel.value;
      store.set(side === 'a' ? 'translatorA' : 'translatorB', sel.value);
      this.labels();
    });
    return sel;
  }

  build() {
    this.selA = this.select('a');
    this.selB = this.select('b');
    const swap = el('button', { class: 'icon-btn', type: 'button', title: 'Swap the two languages', 'aria-label': 'Swap the two languages' }, '⇄');
    swap.addEventListener('click', () => {
      [this.a, this.b] = [this.b, this.a];
      store.set('translatorA', this.a); store.set('translatorB', this.b);
      this.selA.value = this.a; this.selB.value = this.b;
      this.labels();
    });
    this.list = el('div', { class: 'tr-list', role: 'log', 'aria-live': 'polite' });
    this.input = el('textarea', { class: 'input tr-input', rows: 3, maxlength: 2000, placeholder: 'Write here, or press a microphone and speak', 'aria-label': 'Text to translate' });
    this.micA = el('button', { class: 'btn', type: 'button' });
    this.micB = el('button', { class: 'btn', type: 'button' });
    this.sendA = el('button', { class: 'btn primary', type: 'button' });
    this.sendB = el('button', { class: 'btn primary', type: 'button' });
    this.micA.addEventListener('click', () => this.dictate('a'));
    this.micB.addEventListener('click', () => this.dictate('b'));
    this.sendA.addEventListener('click', () => this.send(this.input.value, 'a'));
    this.sendB.addEventListener('click', () => this.send(this.input.value, 'b'));
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.send(this.input.value, 'a'); }
    });
    const readBox = el('input', { type: 'checkbox' });
    readBox.checked = !!this.read;
    readBox.addEventListener('change', () => { this.read = readBox.checked; store.set('translatorRead', this.read); });
    const clear = el('button', { class: 'link-btn', type: 'button' }, 'Clear the conversation');
    clear.addEventListener('click', () => {
      if (!this.messages.length || !window.confirm('Clear the whole conversation from this device?')) return;
      this.messages = []; this.save(); this.renderList();
    });
    this.labels();
    return el('div', { class: 'translator' },
      el('div', { class: 'tr-langs' }, this.selA, swap, this.selB),
      this.list,
      this.input,
      el('div', { class: 'tr-actions' }, this.micA, this.micB, this.sendA, this.sendB),
      Recognition ? null : el('p', { class: 'hint' }, 'This browser cannot listen. Write the text instead, or use Chrome or Edge to speak.'),
      el('div', { class: 'tr-foot' }, el('label', {}, readBox, ' Read the translation aloud'), clear),
      el('p', { class: 'hint' }, 'Ctrl+Enter translates what you wrote from the first language. Nothing here is sent anywhere except to the translator.'));
  }

  /** The buttons say what they do in the languages chosen. */
  labels() {
    const a = this.name(this.a), b = this.name(this.b);
    if (!this.micA) return;
    this.micA.textContent = this.listening === 'a' ? `■ Stop (${a})` : `🎤 ${a}`;
    this.micB.textContent = this.listening === 'b' ? `■ Stop (${b})` : `🎤 ${b}`;
    this.micA.title = `Speak ${a}; it is translated into ${b}`;
    this.micB.title = `Speak ${b}; it is translated into ${a}`;
    this.sendA.textContent = `${a} → ${b}`;
    this.sendB.textContent = `${b} → ${a}`;
    for (const m of [this.micA, this.micB]) m.disabled = !Recognition;
  }

  save() { store.set('translator', this.messages.slice(-KEEP)); }

  renderList() {
    if (!this.list) return;
    if (!this.messages.length) {
      this.list.replaceChildren(el('p', { class: 'hint' }, 'The conversation will appear here: what was said, and its translation.'));
      return;
    }
    this.list.replaceChildren(...this.messages.map((m, i) => this.card(m, i)));
    this.list.scrollTop = this.list.scrollHeight;
  }

  card(m, i) {
    const listen = el('button', { class: 'icon-btn small', type: 'button', title: 'Listen to the translation', 'aria-label': 'Listen to the translation' }, '🔊');
    listen.addEventListener('click', () => this.say(m.translation, m.to));
    const copy = el('button', { class: 'icon-btn small', type: 'button', title: 'Copy the translation', 'aria-label': 'Copy the translation' }, '⧉');
    copy.addEventListener('click', () => navigator.clipboard?.writeText(m.translation).then(() => toast('Copied.'), () => toast('Could not copy.')));
    const del = el('button', { class: 'icon-btn small', type: 'button', title: 'Remove this message', 'aria-label': 'Remove this message' }, '✕');
    del.addEventListener('click', () => { this.messages.splice(i, 1); this.save(); this.renderList(); });
    return el('div', { class: `tr-msg ${m.side === 'b' ? 'right' : 'left'}` },
      el('div', { class: 'tr-said', lang: m.lang, dir: this.rtl(m.lang) ? 'rtl' : 'ltr' }, m.text),
      el('div', { class: 'tr-result', lang: m.to, dir: this.rtl(m.to) ? 'rtl' : 'ltr' }, m.translation),
      el('div', { class: 'tr-tools' }, el('span', { class: 'hint' }, `${this.name(m.lang)} → ${this.name(m.to)}`), listen, copy, del));
  }

  /** Read a translation aloud with the voice chosen for its language. */
  say(text, code) {
    if (!text) return;
    if (!speech.translationVoice(code)) { toast(`This device has no voice for ${this.name(code)}.`); return; }
    speech.speakTranslation(text, code, { rate: 1 });
  }

  /** Translate `text` said or written by `side` into the other language, add it to the conversation. */
  async send(text, side) {
    text = String(text || '').trim();
    if (!text) { toast('Write or say something first.'); return; }
    const from = side === 'a' ? this.a : this.b, to = side === 'a' ? this.b : this.a;
    const busy = [this.sendA, this.sendB];
    busy.forEach((b) => { b.disabled = true; });
    try {
      const translation = await translateText(text, to, from);
      if (!translation) { toast('The translator gave nothing for that.'); return; }
      this.messages.push({ text, lang: from, translation, to, side, at: Date.now() });
      this.save();
      this.input.value = '';
      this.renderList();
      if (this.read) this.say(translation, to);
    } catch (err) {
      toast(err.message);
    } finally {
      busy.forEach((b) => { b.disabled = false; });
    }
  }

  /** Listen to one side: the words appear in the box; when the speaker stops, they are translated. */
  dictate(side) {
    if (this.listening) { const same = this.listening === side; this.stop(); if (same) return; }
    if (!Recognition) { toast('This browser cannot listen. Use Chrome or Edge, or write the text.'); return; }
    speech.stop();
    const rec = new Recognition();
    rec.lang = side === 'a' ? this.a : this.b;
    rec.interimResults = true;
    rec.continuous = false;
    let said = '';
    rec.onresult = (e) => {
      said = [...e.results].map((r) => r[0].transcript).join(' ').trim();
      this.input.value = said;
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech') toast('Nothing was heard. Try again, closer to the microphone.');
      else if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Allow the microphone for this site in the browser, then try again.');
      else if (e.error === 'language-not-supported') toast(`This browser cannot listen to ${this.name(rec.lang)}. Write the text instead.`);
      else if (e.error !== 'aborted') toast(`The microphone stopped: ${e.error}.`);
    };
    rec.onend = () => {
      if (this.rec !== rec) return;
      this.rec = null; this.listening = null; this.labels();
      if (said) this.send(said, side);
    };
    this.rec = rec;
    this.listening = side;
    this.labels();
    try { rec.start(); } catch { this.rec = null; this.listening = null; this.labels(); }
  }

  stop() {
    const rec = this.rec;
    this.rec = null; this.listening = null;
    try { rec?.abort(); } catch { /* already stopped */ }
    speech.stop();
    this.labels();
  }
}

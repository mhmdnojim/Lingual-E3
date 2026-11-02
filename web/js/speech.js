// Text-to-speech with the browser's Web Speech API. Edge offers high-quality
// "Natural" voices (online); Windows voices (David, Zira; Huihui for Chinese) work offline.
// A voice reads only its own language well, so Chinese characters are read by a Chinese
// (Mandarin) voice and everything else by an English one.
import { store } from './util.js';

const synth = window.speechSynthesis;
let voices = [];
const listeners = new Set();
let generation = 0; // ignore events from utterances that were cancelled
const noWordEvents = new Set(); // voices that never reported a word position

/** How many times each sentence is read (Infinity: again and again until the user stops it). */
export const repeatTimes = () => (Number(settings.repeat) === 0 ? Infinity : Math.max(1, Math.min(10, Number(settings.repeat) || 1)));

export const settings = {
  voiceURI: store.get('voice', null),
  // (A new name: the Chinese voice used before could be a Cantonese one, picked by mistake.)
  chineseVoiceURI: store.get('mandarinVoice', null),
  languageMode: store.get('speechLanguageMode', 'both'), // 'both', 'en' (English only) or 'zh' (Chinese only)
  rate: store.get('rate', 1),
  follow: store.get('follow', true),
  gap: store.get('gap', 0), // seconds of silence between one sentence (or clause) and the next
  repeat: store.get('repeat', 1), // times each sentence (or clause, or word) is read: 1-10, or 0 = again and again
  trOrder: store.get('trRead', 'off'), // also read each sentence's translation: 'off', 'after' or 'before' it
  trVoices: store.get('trVoices', {}), // translation language -> the voice chosen for it (voiceURI)
};

/**
 * Does a voice of `locale` (en-US, ar-SA, fil-PH …) speak the translation language `code` (as
 * the translation service writes it: ar, zh-CN, tl …)? A code with a country needs that country.
 */
export function speaksLanguage(locale, code) {
  const l = String(locale || '').replace(/_/g, '-').toLowerCase(), c = String(code || '').toLowerCase();
  if (!l || !c) return false;
  if (c.includes('-')) return l === c || l.startsWith(`${c}-`);
  return l.split('-')[0] === ({ tl: 'fil', iw: 'he' }[c] || c);
}

const LANGUAGE = { en: /^en([-_]|$)/i, zh: /^(zh|cmn|yue)([-_]|$)/i };
const HAN = /[㐀-䶿一-鿿豈-﫿]/u;
const LATIN = /\p{Script=Latin}/u;

const languageVoices = (language) => voices.filter((v) => LANGUAGE[language].test(v.lang));

/**
 * What a Chinese voice speaks: 'mandarin' (standard Mandarin, as it is taught), 'taiwan'
 * (Taiwanese Mandarin), 'regional' (Mandarin with a strong regional accent: Edge's Northeastern
 * and Shaanxi voices) or 'cantonese' (the Hong Kong voices: another language, wrong for Mandarin).
 */
export function chineseKind(v) {
  if (/^(yue|zh[-_](Hant[-_])?(HK|MO))\b/i.test(v.lang) || /cantonese|hong kong|粤|粵/i.test(v.name)) return 'cantonese';
  if (/^zh[-_]CN[-_][a-z]/i.test(v.lang) || /northeastern|shaanxi|zhongyuan|liaoning|sichuan|henan|shandong|dialect/i.test(v.name)) return 'regional';
  if (/^zh[-_](Hant|TW)/i.test(v.lang) || /taiwan|臺灣|台灣/i.test(v.name)) return 'taiwan';
  return 'mandarin';
}

const CHINESE_RANK = { mandarin: 30, taiwan: 10, regional: -20, cantonese: -60 };

function rank(v) {
  let r = 0;
  if (/natural/i.test(v.name)) r += 40;
  if (/online/i.test(v.name)) r += 5;
  if (/^en[-_]US/i.test(v.lang)) r += 20;
  else if (/^en[-_]GB/i.test(v.lang)) r += 12;
  else if (LANGUAGE.zh.test(v.lang)) {
    r += CHINESE_RANK[chineseKind(v)];
    // Edge's clearest standard voices first.
    if (/xiaoxiao/i.test(v.name)) r += 4;
    else if (/yunxi\b/i.test(v.name)) r += 3;
    else if (/yunyang|yunjian|huihui/i.test(v.name)) r += 2;
  }
  if (/google/i.test(v.name)) r += 8;
  if (v.localService) r += 1;
  return r;
}

function refresh() {
  voices = (synth ? synth.getVoices() : []).sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name));
  listeners.forEach((fn) => fn(voices));
}

if (synth) {
  refresh();
  synth.addEventListener?.('voiceschanged', refresh);
  if (!voices.length) setTimeout(refresh, 400);
}

/**
 * Text in pieces of one language each, {lang, text, start}: start is where the piece begins in
 * the text (for the highlight). Spaces, digits and punctuation go with the piece before them (or
 * else the one after), so "2009年" and "你好。" stay with the Chinese voice.
 */
function pieces(text) {
  const runs = [];
  const chars = [...text];
  const languageOf = (ch) => (HAN.test(ch) ? 'zh' : LATIN.test(ch) ? 'en' : null);
  let at = 0;
  chars.forEach((ch, i) => {
    const start = at;
    at += ch.length;
    let lang = languageOf(ch) || runs[runs.length - 1]?.lang;
    for (let j = i + 1; !lang && j < chars.length; j++) lang = languageOf(chars[j]);
    lang ||= 'en';
    const prev = runs[runs.length - 1];
    if (prev && prev.lang === lang) prev.text += ch;
    else runs.push({ lang, text: ch, start });
  });
  // Speakers' letters and abbreviations next to Chinese ("A: 你好", "HSK 考试") are read by the
  // Chinese voice too, instead of switching voices (and waiting for the other one) for a moment.
  const out = [];
  runs.forEach((p, i) => {
    if (p.lang === 'en' && (runs[i - 1]?.lang === 'zh' || runs[i + 1]?.lang === 'zh')
      && /^[A-Z]{1,4}$/.test(p.text.replace(/[^\p{L}]/gu, ''))) p = { ...p, lang: 'zh' };
    const prev = out[out.length - 1];
    if (prev && prev.lang === p.lang) prev.text += p.text;
    else out.push({ ...p });
  });
  return out.filter((p) => p.text.trim());
}

export const speech = {
  supported: !!synth,
  languageChoice: true, // false: settings.languageMode does not apply here (a page without Chinese)

  get voices() { return voices; },

  onVoices(fn) { listeners.add(fn); fn(voices); },

  /** The voice for 'en' or 'zh': the one chosen in the settings, else the best one. */
  currentVoice(language = 'en') {
    const list = languageVoices(language);
    const uri = language === 'zh' ? settings.chineseVoiceURI : settings.voiceURI;
    return list.find((v) => v.voiceURI === uri) || list[0] || null;
  },

  voicesFor(language) { return languageVoices(language); },

  setVoice(uri) { settings.voiceURI = uri; store.set('voice', uri); },
  setChineseVoice(uri) { settings.chineseVoiceURI = uri; store.set('mandarinVoice', uri); },
  /** key: where it is kept (Chinese books keep their own: see main.js). */
  setLanguageMode(mode, key = 'speechLanguageMode') { settings.languageMode = mode; store.set(key, mode); },
  setRate(rate) { settings.rate = rate; store.set('rate', rate); },
  setFollow(on) { settings.follow = on; store.set('follow', on); },
  setGap(sec) { settings.gap = sec; store.set('gap', sec); },
  setRepeat(n) { settings.repeat = n; store.set('repeat', n); },
  setTranslationOrder(order) { settings.trOrder = order; store.set('trRead', order); },

  /** The voices that read the translation language `code` (ar, zh-CN …), best first. */
  translationVoices(code) { return voices.filter((v) => speaksLanguage(v.lang, code)); },
  /** The voice chosen for that language, else the best one (null: no voice reads it). */
  translationVoice(code) {
    const list = this.translationVoices(code);
    return list.find((v) => v.voiceURI === settings.trVoices[code]) || list[0] || null;
  },
  setTranslationVoice(code, uri) {
    settings.trVoices = { ...settings.trVoices, [code]: uri };
    store.set('trVoices', settings.trVoices);
  },

  /** Do the current voices report where each word is? (Needed to read many sentences in one go.) */
  reportsWords() {
    return ['en', 'zh'].every((language) => {
      const v = this.currentVoice(language);
      return !v || !noWordEvents.has(v.voiceURI);
    });
  },
  markNoWords() {
    ['en', 'zh'].forEach((language) => { const v = this.currentVoice(language); if (v) noWordEvents.add(v.voiceURI); });
  },

  /**
   * Speak text: English with the English voice, Chinese with the Chinese voice, one after the
   * other. Callbacks: onStart(), onWord(charIndex), onEnd(), onError(err), onFallback(voice),
   * onSkipped(language) (some of it in a language not read: "EN" or "中" chosen), onNoVoice(language)
   * (no voice of that language on this device); rate: a speed of its own.
   * Returns false when speech is not available.
   */
  speak(text, cb = {}) {
    if (!synth || !text) return false;
    const gen = ++generation;
    synth.cancel();
    const all = pieces(text), mode = this.languageChoice ? settings.languageMode : 'both';
    const queue = all.filter((p) => mode === 'both' || p.lang === mode);
    const skipped = all.find((p) => !queue.includes(p));
    if (skipped) cb.onSkipped?.(skipped.lang);
    if (!queue.length) { // nothing to read in the chosen language
      setTimeout(() => gen === generation && cb.onEnd?.());
      return true;
    }
    let index = 0, started = false, attempt = 0;
    const offlineVoice = (language) => languageVoices(language).find((v) => v.localService);
    const say = (piece, voice) => {
      const mine = ++attempt;
      const u = new SpeechSynthesisUtterance(piece.text);
      if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = piece.lang === 'zh' ? 'zh-CN' : 'en-US';
      u.rate = cb.rate ?? settings.rate; // (a speed of its own: e.g. the words of a sentence broken down)
      u.onstart = () => { if (gen === generation && !started) { started = true; cb.onStart?.(); } };
      u.onboundary = (e) => {
        if (gen === generation && (e.name === 'word' || e.name == null)) cb.onWord?.(piece.start + e.charIndex);
      };
      u.onend = () => { if (gen === generation && mine === attempt) next(); };
      u.onerror = (e) => {
        if (gen !== generation || mine !== attempt || e.error === 'interrupted' || e.error === 'canceled') return;
        // An online voice without internet: retry once with an offline voice of the same language.
        const offline = offlineVoice(piece.lang);
        if (voice && !voice.localService && offline) {
          cb.onFallback?.(offline);
          say(piece, offline);
          return;
        }
        cb.onError?.(e);
      };
      // Chrome sometimes leaves the engine paused after cancel(); resume to be safe.
      synth.resume();
      synth.speak(u);
    };
    const next = () => {
      if (index >= queue.length) { cb.onEnd?.(); return; }
      const piece = queue[index++];
      let voice = this.currentVoice(piece.lang);
      if (!voice && voices.length) cb.onNoVoice?.(piece.lang); // (the browser's own voice reads it, if it can)
      if (voice && !voice.localService && !navigator.onLine) {
        // No internet: use an offline (Windows) voice at once instead of waiting for an error.
        const offline = offlineVoice(piece.lang);
        if (offline) { voice = offline; cb.onFallback?.(offline); }
      }
      say(piece, voice);
    };
    next();
    return true;
  },

  /**
   * Speak a translation with the voice of its language `code`. Callbacks: onWord(charIndex,
   * charLength) (the word being said), onEnd(), onError(err), onFallback(voice). Returns false when
   * no voice reads that language.
   */
  speakTranslation(text, code, cb = {}) {
    let voice = this.translationVoice(code);
    if (!synth || !text || !voice) return false;
    const gen = ++generation;
    synth.cancel();
    const offline = () => this.translationVoices(code).find((v) => v.localService);
    if (!voice.localService && !navigator.onLine && offline()) { voice = offline(); cb.onFallback?.(voice); }
    const say = (v) => {
      const u = new SpeechSynthesisUtterance(text);
      u.voice = v;
      u.lang = v.lang;
      u.rate = cb.rate ?? settings.rate; // (a speed of its own: e.g. the words of a sentence broken down)
      u.onboundary = (e) => { if (gen === generation && (e.name === 'word' || e.name == null)) cb.onWord?.(e.charIndex, e.charLength || 0); };
      u.onend = () => { if (gen === generation) cb.onEnd?.(); };
      u.onerror = (e) => {
        if (gen !== generation || e.error === 'interrupted' || e.error === 'canceled') return;
        // An online voice without internet: once more with an offline voice of the language.
        if (!v.localService && offline()) { cb.onFallback?.(offline()); say(offline()); return; }
        cb.onError?.(e);
      };
      synth.resume();
      synth.speak(u);
    };
    say(voice);
    return true;
  },

  stop() {
    generation++;
    if (synth) synth.cancel();
  },

  get speaking() { return !!synth && (synth.speaking || synth.pending); },
};

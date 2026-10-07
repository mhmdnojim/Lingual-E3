// Text-to-speech with the browser's Web Speech API. Edge offers high-quality
// "Natural" voices (online); Windows voices (David, Zira) work offline.
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
  rate: store.get('rate', 1),
  follow: store.get('follow', true),
  gap: store.get('gap', 0), // seconds of silence between one sentence (or clause) and the next
  repeat: store.get('repeat', 1), // times each sentence (or clause, or word) is read: 1-10, or 0 = again and again
};

function englishVoices() {
  return (synth ? synth.getVoices() : []).filter((v) => /^en([-_]|$)/i.test(v.lang));
}

function rank(v) {
  let r = 0;
  if (/natural/i.test(v.name)) r += 40;
  if (/online/i.test(v.name)) r += 5;
  if (/^en[-_]US/i.test(v.lang)) r += 20;
  else if (/^en[-_]GB/i.test(v.lang)) r += 12;
  if (/google/i.test(v.name)) r += 8;
  if (v.localService) r += 1;
  return r;
}

function refresh() {
  voices = englishVoices().sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name));
  listeners.forEach((fn) => fn(voices));
}

if (synth) {
  refresh();
  synth.addEventListener?.('voiceschanged', refresh);
  if (!voices.length) setTimeout(refresh, 400);
}

export const speech = {
  supported: !!synth,

  get voices() { return voices; },

  onVoices(fn) { listeners.add(fn); fn(voices); },

  currentVoice() {
    return voices.find((v) => v.voiceURI === settings.voiceURI) || voices[0] || null;
  },

  setVoice(uri) { settings.voiceURI = uri; store.set('voice', uri); },
  setRate(rate) { settings.rate = rate; store.set('rate', rate); },
  setFollow(on) { settings.follow = on; store.set('follow', on); },
  setGap(sec) { settings.gap = sec; store.set('gap', sec); },
  setRepeat(n) { settings.repeat = n; store.set('repeat', n); },

  /** Does the current voice report where each word is? (Needed to read many sentences in one go.) */
  reportsWords() {
    const v = this.currentVoice();
    return !v || !noWordEvents.has(v.voiceURI);
  },
  markNoWords() {
    const v = this.currentVoice();
    if (v) noWordEvents.add(v.voiceURI);
  },

  /**
   * Speak text. Callbacks: onStart(), onWord(charIndex), onEnd(), onError(err).
   * Returns false when speech is not available.
   */
  speak(text, cb = {}, voiceOverride) {
    if (!synth || !text) return false;
    const gen = ++generation;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    let voice = voiceOverride || this.currentVoice();
    if (!voiceOverride && voice && !voice.localService && !navigator.onLine) {
      // No internet: use an offline (Windows) voice at once instead of waiting for an error.
      const offline = voices.find((v) => v.localService);
      if (offline) { voice = offline; cb.onFallback?.(offline); }
    }
    if (voice) { u.voice = voice; u.lang = voice.lang; } else { u.lang = 'en-US'; }
    u.rate = settings.rate;
    u.onstart = () => gen === generation && cb.onStart?.();
    u.onboundary = (e) => {
      if (gen === generation && (e.name === 'word' || e.name == null)) cb.onWord?.(e.charIndex);
    };
    u.onend = () => gen === generation && cb.onEnd?.();
    u.onerror = (e) => {
      if (gen !== generation || e.error === 'interrupted' || e.error === 'canceled') return;
      // An online voice without internet: retry once with an offline voice.
      const offline = voices.find((v) => v.localService);
      if (!voiceOverride && voice && !voice.localService && offline) {
        cb.onFallback?.(offline);
        this.speak(text, cb, offline);
        return;
      }
      cb.onError?.(e);
    };
    // Chrome sometimes leaves the engine paused after cancel(); resume to be safe.
    synth.resume();
    synth.speak(u);
    return true;
  },

  stop() {
    generation++;
    if (synth) synth.cancel();
  },

  get speaking() { return !!synth && (synth.speaking || synth.pending); },
};

// Run: node web/tests/audio-create-recovery-test.mjs
// Actual Recordings.openCreate + voice helpers with an in-memory DOM/API adapter.
// No network, browser, synthesis, filesystem writes, or user book data are involved.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const moduleURL = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const voicesURL = moduleURL(await readFile(new URL('../js/voice-options.js', import.meta.url), 'utf8'));
const nodes = [], stored = new Map(), posts = [];
let dialog, closed = false, failCreation = false;
class Element {
  constructor(tag, props = {}, children = []) {
    this.tagName = tag.toUpperCase(); this.children = children.flat().filter((x) => x != null);
    this.events = new Map(); this.dataset = {}; this.style = {}; this.hidden = false;
    this.disabled = false; this.checked = false; this.classList = { add() {}, remove() {}, toggle() {} };
    Object.assign(this, props); nodes.push(this);
  }
  get firstChild() { return this.children[0]; }
  get options() { return this.children.flatMap((x) => x.tagName === 'OPTGROUP' ? x.children : [x]); }
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.tagName === 'SELECT') return (this.options.find((x) => x.selected) || this.options[0])?.value || '';
    return this.tagName === 'OPTION' ? this.children.join('') : '';
  }
  set value(value) { this._value = String(value); }
  get textContent() { return this._text ?? this.children.map((x) => typeof x === 'string' ? x : x.textContent || '').join(''); }
  set textContent(value) { this._text = String(value); }
  replaceChildren(...children) { this.children = children; if (this.tagName === 'SELECT') delete this._value; }
  addEventListener(event, handler) {
    if (!this.events.has(event)) this.events.set(event, []);
    this.events.get(event).push(handler);
  }
  async trigger(event) {
    if (event === 'click' && this.disabled) return;
    for (const fn of this.events.get(event) || []) await fn({ target: this });
  }
  setAttribute(name, value) { this[name] = value; }
  focus() {} select() {} append(...children) { this.children.push(...children); }
}
const el = (tag, props = {}, ...children) => new Element(tag, props, children);
const settings = { gap: 0 };
globalThis.audioTestDeps = {
  $: () => el('div'), el, icon: () => '', fmtTime: (n) => String(Math.round(n)), toast() {},
  store: { get: (key, fallback) => stored.get(key) ?? fallback, set: (key, value) => stored.set(key, value) },
  speakable: (text) => text, settings, repeatTimes: () => 1, speech: {}, offlineAudio: {},
  openDialog: (title, body) => { dialog = { title, body }; }, closeDialog: () => { closed = true; },
};
const response = (body, ok = true) => ({ ok, json: async () => body });
globalThis.fetch = async (url, options = {}) => {
  if (url === '/api/recordings' && options.method === 'POST') {
    posts.push(JSON.parse(options.body)); return response({ job: 'test-job' });
  }
  if (url === '/api/jobs/test-job') return response(failCreation
    ? { state: 'error', error: 'Microsoft speech refused the connection (HTTP 403).' }
    : { state: 'done', done: posts.at(-1).sentences.length, recording: { ...posts.at(-1), id: 'created' } });
  throw new Error(`Unexpected network request: ${url}`);
};
// The job fixture has no asynchronous work; skip only create()'s polling interval.
globalThis.setTimeout = (fn) => { queueMicrotask(fn); return 1; };
let source = await readFile(new URL('../js/recordings.js', import.meta.url), 'utf8');
source = source.replace(/import \{([^}]+)\} from '\.\/(util|pagetext|speech|media|offline-audio)\.js';/g,
  (_, names) => `const {${names}} = globalThis.audioTestDeps;`)
  .replace("'./voice-options.js'", JSON.stringify(voicesURL));
source += '\n//# sourceURL=recordings-recovery-fixture.js';
const { Recordings } = await import(moduleURL(source));

const ANA = 'en-US-AnaNeural', GUY = 'en-US-GuyNeural', XIAO = 'zh-CN-XiaoxiaoNeural';
const DAVID = 'windows:david', ZIRA = 'windows:zira', HUIHUI = 'windows:huihui';
const voices = [
  { id: ANA, name: 'Ana', locale: 'en-US', gender: 'Female', provider: 'edge' },
  { id: GUY, name: 'Guy', locale: 'en-US', gender: 'Male', provider: 'edge' },
  { id: XIAO, name: 'Xiaoxiao', locale: 'zh-CN', gender: 'Female', provider: 'edge' },
  { id: DAVID, name: 'David (Windows offline)', locale: 'en-US', gender: 'Male', provider: 'windows' },
  { id: ZIRA, name: 'Zira (Windows offline)', locale: 'en-US', gender: 'Female', provider: 'windows' },
  { id: HUIHUI, name: 'Huihui (Windows offline)', locale: 'zh-CN', gender: 'Female', provider: 'windows' },
];
const book = { id: 1, slug: 'synthetic', type: 'Fixture book' }, page = { n: 1, path: 'page1' };
const sentence = (text, i = 0) => ({ text, words: text.split(' '), a: i * 10, b: i * 10 + 5,
  path: page.path, view: { book, page } });
const control = (role) => {
  const found = nodes.find((node) => node.dataset.role === role);
  assert.ok(found, `Missing data-role=${role}`); return found;
};
async function open({ text = ['This is a synthetic example.'], available = voices, existing = null } = {}) {
  nodes.length = 0; posts.length = 0; stored.clear(); closed = false; failCreation = false;
  const picked = text.map(sentence);
  const recordings = Object.create(Recordings.prototype);
  Object.assign(recordings, {
    app: { book, views: [], audio: {} }, list: existing ? [existing] : [], full: new Map(), assets: new Map(),
    unselectedRanges: new Set(), voices: async () => available,
    pickedSentences: () => picked, defaultVoice: () => ANA, defaultChineseVoice: () => XIAO,
    otherVoice: (list, first) => list.find((v) => v.id !== first)?.id || first,
    stopPicking() {}, renderList() {}, renderSpots() {}, updateRecordingFrame() {},
    loadFull: async () => ({ ...posts.at(-1), id: 'created' }),
    deleteRecording: async () => { recordings.deleted = existing?.id; return true; },
  });
  recordings.openCreate(existing ? { existing, original: picked, additions: [] } : {});
  await Promise.resolve(); await Promise.resolve();
  assert.ok(dialog.body); return recordings;
}

await open();
assert.equal(control('audio-language').value, 'en');
assert.equal(control('audio-voice').value, ANA, 'A fresh dialog keeps the selected Natural voice');
const title = nodes.find((node) => node.tagName === 'INPUT' && node.type === 'text');
title.value = 'My custom title';
failCreation = true;
await control('audio-create').trigger('click');
assert.equal(posts[0].voice, ANA, 'First attempt must not silently substitute the selected provider');
assert.equal(closed, false);
assert.ok(nodes.some((node) => node.class === 'rec-error' && !node.hidden && /403/.test(node.textContent)));
assert.equal(control('audio-use-offline').disabled, false);
await control('audio-use-offline').trigger('click');
assert.equal(control('audio-voice').value, ZIRA, 'Explicit recovery preserves the chosen female voice where available');
assert.equal(posts.length, 1, 'Recovery changes voice choices without starting another generation');
assert.equal(title.value, 'My custom title');
assert.match(control('audio-voice-source').textContent, /offline/i);
failCreation = false;
await control('audio-create').trigger('click');
assert.equal(posts[1].voice, ZIRA);
assert.equal(posts[1].title, 'My custom title');
assert.deepEqual(posts[1].sentences, posts[0].sentences);
assert.equal(posts[1].languageMode, 'en');
assert.equal(closed, true);
console.log('PASS: Ana HTTP 403 recovers explicitly to Windows voice, retaining title and sentences');

await open({ text: ['A: Good morning.', 'B: 你好。'] });
assert.equal(control('audio-language').value, 'both');
await control('audio-use-offline').trigger('click');
for (const role of ['audio-voice', 'audio-voice-b', 'audio-zh-voice', 'audio-zh-voice-b']) {
  assert.match(control(role).value, /^windows:/, `${role} uses an installed voice`);
}
assert.notEqual(control('audio-voice').value, control('audio-voice-b').value);
await control('audio-create').trigger('click');
assert.equal(posts[0].twoSpeakers, true);
assert.match(posts[0].voice, /^windows:/);
assert.match(posts[0].voiceB, /^windows:/);
assert.equal(posts[0].zhVoice, HUIHUI);
assert.equal(posts[0].zhVoiceB, HUIHUI);
console.log('PASS: bilingual dialogue recovery switches all active speaker/language slots');

await open({ text: ['Hello.', '你好。'], available: voices.filter((v) => v.id !== HUIHUI) });
assert.equal(control('audio-use-offline').disabled, true);
assert.match(control('audio-voice-source').textContent, /Chinese|中文/i);
await control('audio-use-offline').trigger('click');
assert.equal(control('audio-voice').value, ANA, 'Missing Chinese voice must not partly change English');
assert.equal(control('audio-zh-voice').value, XIAO);
assert.equal(posts.length, 0);
console.log('PASS: missing required installed language prevents partial or silent voice substitution');

await open({ available: voices.filter((v) => v.provider === 'edge') });
assert.equal(control('audio-use-offline').disabled, true);
assert.match(control('audio-voice-source').textContent, /install|available|found/i);
assert.equal(control('audio-voice').value, ANA);
console.log('PASS: no installed voices explains recovery unavailable');

await open({ text: ['你好。'], available: voices.filter((v) => v.id !== DAVID && v.id !== ZIRA) });
assert.equal(control('audio-language').value, 'zh');
assert.equal(control('audio-use-offline').disabled, false, 'Chinese-only does not require English offline voices');
await control('audio-use-offline').trigger('click');
assert.equal(control('audio-zh-voice').value, HUIHUI);
await control('audio-create').trigger('click');
assert.equal(posts[0].languageMode, 'zh');
assert.equal(posts[0].zhVoice, HUIHUI);
console.log('PASS: Chinese-only generation needs only an installed Chinese voice');

const existing = { id: 'original', book: book.slug, bookId: book.id, bookType: book.type, page: 1,
  path: page.path, title: 'Keep my recording', languageMode: 'both', voice: GUY, voiceB: ANA,
  zhVoice: XIAO, twoSpeakers: false, rate: 10, gap: 0.5 };
const recordings = await open({ existing });
assert.equal(control('audio-language').value, 'both', 'Regeneration retains previous read mode');
assert.equal(control('audio-voice').value, GUY, 'Regeneration retains exact existing voice');
failCreation = true;
await control('audio-create').trigger('click');
assert.equal(recordings.deleted, undefined, 'Failure must keep the original recording');
assert.equal(posts[0].voice, GUY);
await control('audio-use-offline').trigger('click');
assert.equal(control('audio-voice').value, DAVID);
failCreation = false;
await control('audio-create').trigger('click');
assert.equal(recordings.deleted, 'original', 'Replace original only after replacement succeeds');
assert.equal(posts[1].voice, DAVID);
assert.equal(posts[1].title, existing.title);
console.log('PASS: regeneration preserves existing choices and recording until explicit successful replacement');

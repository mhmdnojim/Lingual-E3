// Run: node web/tests/translation-offline-logic-test.mjs
// Actual Translator and PageText, tiny DOM adapter, and an in-memory API fixture.
// No browser, network, cache-directory writes, or user book text are involved.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const moduleURL = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const pageTextURL = moduleURL(await readFile(new URL('../js/pagetext.js', import.meta.url), 'utf8'));
const { PageText } = await import(pageTextURL);
const nodes = new Map(), stored = new Map(), widths = [];
function element() {
  return { checked: false, hidden: false, disabled: false, value: '', textContent: '', style: {}, dataset: {},
    events: {}, attrs: {}, classList: { toggle() {} },
    addEventListener(event, handler) { this.events[event] = handler; },
    setAttribute(key, value) { this.attrs[key] = value; },
    replaceChildren(...children) { this.children = children; }, append() {}, focus() {},
  };
}
const $ = (selector) => {
  if (!nodes.has(selector)) nodes.set(selector, element());
  return nodes.get(selector);
};
$('#tr-scope').value = 'page';
$('#tr-progress').firstChild = { style: new Proxy({}, { set(target, key, value) {
  if (key === 'width') widths.push(parseFloat(value));
  target[key] = value; return true;
} }) };
globalThis.document = { body: element() };
globalThis.addEventListener = () => {};
globalThis.translationTestUtil = { $, $$: () => [], el: element, icon: () => '',
  store: { get: (key, fallback) => stored.get(key) ?? fallback, set: (key, value) => stored.set(key, value) },
  toast: () => {},
};
globalThis.confirm = () => { throw new Error('Prepare must not ask for a blocking confirmation'); };

const requests = [], words = new Map(), sentences = new Map();
// What the translator gives nothing for (as for some names): asked once, then known (none).
const unglossable = new Set(), blankable = new Set(), noWord = new Set();
let failBatch = 0, batches = 0, changeLanguageDuringRequest = false;
const keyFor = (lang, item) => JSON.stringify([lang, item.word, item.context, item.contextOffset]);
const response = (body, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => body });
globalThis.fetch = async (url, options) => {
  if (url === '/api/tr-languages') return response([{ code: 'ar', name: 'Arabic' }, { code: 'fr', name: 'French' }]);
  if (url.startsWith('/api/text/')) return response(doc);
  const body = JSON.parse(options.body);
  requests.push({ url, body });
  if (changeLanguageDuringRequest) { changeLanguageDuringRequest = false; translator.lang = 'fr'; }
  if (url === '/api/translate-word') {
    if (body.items && ++batches === failBatch) return response({ error: 'Translator temporarily unavailable' }, false);
    let fetched = 0, missing = 0;
    const none = [];
    const translations = (body.items || [body]).map((item, i) => {
      const key = keyFor(body.lang, item);
      if ((!words.has(key) || body.refresh) && !body.cachedOnly) {
        if (unglossable.has(item.word)) noWord.add(key);
        else { words.set(key, `meaning:${item.word}`); fetched++; }
      }
      if (!words.has(key)) missing++;
      if (!words.has(key) && noWord.has(key)) none.push(i);
      return words.get(key) || '';
    });
    return response(body.items ? { translations, fetched, missing, none, wordContext: true }
      : { text: translations[0], wordContext: true });
  }
  assert.equal(url, '/api/translate');
  let fetched = 0, missing = 0;
  const translations = body.paragraphs.map((paragraph) => paragraph.map((sentence) => {
    const key = JSON.stringify([body.lang, sentence]);
    if ((!sentences.has(key) || body.refresh) && !body.cachedOnly) {
      sentences.set(key, blankable.has(sentence) ? '' : `translation:${sentence}`); // (saved blank, as the server does)
      fetched++;
    }
    if (!sentences.get(key)) missing++;
    return sentences.get(key) || '';
  }));
  const none = body.paragraphs.flat().flatMap((sentence, i) => (sentences.get(JSON.stringify([body.lang, sentence])) === '' ? [i] : []));
  return response({ translations, fetched, missing, none });
};

let source = await readFile(new URL('../js/translation.js', import.meta.url), 'utf8');
source = source.replace("import { $, $$, el, icon, store, toast } from './util.js';",
  () => 'const { $, $$, el, icon, store, toast } = globalThis.translationTestUtil;')
  .replace("'./pagetext.js'", JSON.stringify(pageTextURL));
source += '\n//# sourceURL=translation-fixture.js';
const { Translator } = await import(moduleURL(source));
const doc = { words: [], sent: [], clause: [], blocks: [] };
for (let sentence = 0; sentence < 10; sentence++) {
  const start = doc.words.length;
  for (let word = 0; word < 6; word++) doc.words.push([word * 60, sentence * 25, 55, 20,
    `word${sentence * 6 + word}${word === 5 ? '.' : ''}`, sentence, word < 5 ? 1 : 0]);
  doc.sent.push([start, start + 6]);
  doc.clause.push([start, start + 3], [start + 3, start + 6]);
  doc.blocks.push([sentence, sentence + 1]);
}
const book = { slug: 'fixture', type: 'Synthetic book', pages: [{ path: 'page1', n: 1 }] };
const view = { doc, text: new PageText(doc), book, page: book.pages[0] };
const app = { book, idx: 0, views: [view], renderPanelText() {}, openSettings() {} };
const translator = new Translator(app);
await Promise.resolve(); await Promise.resolve();
$('#tr-level-breakdown').checked = false; // (the breakdown level has its own check at the end)
translator.lang = 'ar';
translator.listOn = true;
const offlineToggle = (checked) => $('#tr-offline').events.change({ target: { checked } });
offlineToggle(true);
assert.equal(translator.offlineOnly, true);
const first = translator.wordEntries(view.text, new Set([0]))[0];
const lookup = () => translator.word(first.word, first.context, first.contextOffset);
assert.equal(await lookup(), '');
const misses = requests.length;
assert.equal(await lookup(), '');
assert.equal(requests.length, misses + 1, 'A missing word is retried');
console.log('PASS: offline toggle and retry after a missing word');

// What Prepare sends: first a check (from the disk only), then downloads of what is missing.
const checks = () => requests.filter(({ body }) => body.cachedOnly === true);
const downloads = () => requests.filter(({ body }) => body.cachedOnly === false);
const sentencesOf = (list) => list.filter(({ url }) => url === '/api/translate').flatMap(({ body }) => body.paragraphs.flat());
const itemsOf = (list) => list.filter(({ body }) => body.items).flatMap(({ body }) => body.items);
const stepCounts = () => Object.fromEntries(translator.steps.map((s) => [s.key, `${s.saved}/${s.total}${s.none ? ` none ${s.none}` : ''}`]));
const status = () => $('#tr-status').textContent;

requests.length = 0;
await translator.prepareScope();
assert.match(status(), /✓ Completed: .*Arabic \(page 1\)/);
assert.equal(translator.offlineOnly, true);
assert.equal(sentencesOf(checks()).length, 30, 'the check asks for the ten sentences and twenty clauses');
assert.deepEqual(checks().filter(({ body }) => body.items).map(({ body }) => body.items.length), [60], 'and for all words at once');
assert.equal(sentencesOf(downloads()).length, 30);
assert.deepEqual(downloads().filter(({ body }) => body.items).map(({ body }) => body.items.length), [24, 24, 12]);
assert.ok(requests.every(({ body }) => body.cachedOnly === true || body.cachedOnly === false));
assert.deepEqual(stepCounts(), { sentence: '10/10', clause: '20/20', word: '60/60' });
assert.ok(translator.steps.every((s) => s.fill.style.width === '100%'));
assert.ok(widths.some((n) => n > 0 && n < 100));
assert.equal(widths.at(-1), 100);
assert.equal($('#tr-again').hidden, true, 'a first preparation does not ask to do it again');
assert.equal(translator.job, null);
assert.equal(await lookup(), 'meaning:word0');
assert.equal(requests.at(-1).body.cachedOnly, true);
console.log('PASS: explicit preparation: check, download what is missing, a bar for every step, preserved offline reading');

requests.length = 0;
await translator.prepareScope();
assert.match(status(), /✓ Already prepared \(on .+\): .*No need to prepare again/);
assert.equal(downloads().length, 0, 'nothing is downloaded again');
assert.equal($('#tr-again').hidden, false, 'it asks: prepare again, or no need');
$('#tr-again-no').events.click();
assert.equal($('#tr-again').hidden, true);
translator.showPrepared();
assert.match(status(), /✓ Prepared before, on .+, for Arabic/, 'before clicking: prepared before');
$('#tr-scope').value = 'selected';
translator.showPrepared();
assert.equal(status().startsWith('✓ Prepared before'), false, 'selected sentences are not remembered');
$('#tr-scope').value = 'page';
console.log('PASS: prepared before: says so, downloads nothing, asks whether to do it again');

requests.length = 0;
await translator.prepareScope(true); // "Prepare again"
assert.match(status(), /✓ Completed/);
assert.equal(sentencesOf(downloads()).length, 30);
assert.equal(itemsOf(downloads()).length, 60);
assert.ok(downloads().every(({ body }) => body.refresh === true), 'everything is downloaded again');
console.log('PASS: prepare again downloads everything again');

for (const clause of [true, false]) {
  $('#tr-level-sentence').checked = false;
  $('#tr-level-clause').checked = clause;
  if (clause) for (const key of [...sentences.keys()]) if (JSON.parse(key)[1].split(' ').length === 3) sentences.delete(key); // the clauses
  requests.length = 0;
  await translator.prepareScope();
  assert.match(status(), clause ? /✓ Completed/ : /✓ Already prepared/);
  assert.equal(sentencesOf(downloads()).length, clause ? 20 : 0);
  assert.equal(itemsOf(checks()).length, 60);
  assert.equal(itemsOf(downloads()).length, 0, 'the saved words are not asked for again');
}
console.log('PASS: clause/word and word-only preparation');

words.clear(); translator.words.clear();
assert.equal(await lookup(), '');
batches = 0; failBatch = 3; // (1: the check, 2: the first download)
await translator.prepareScope();
assert.match(status(), /temporarily unavailable.*What was downloaded is kept/);
assert.deepEqual(stepCounts(), { word: '24/60' });
assert.equal(translator.job, null);
assert.equal(await lookup(), 'meaning:word0');
failBatch = 0; requests.length = 0;
await translator.prepareScope();
assert.match(status(), /✓ Completed/);
assert.equal(itemsOf(downloads()).length, 36, 'only the missing words');
console.log('PASS: partial failure retains saved words, retry downloads only the missing words');

requests.length = 0; changeLanguageDuringRequest = true;
await translator.prepareScope();
assert.ok(requests.every(({ body }) => body.lang === 'ar'), 'All preparation batches use the starting language');
assert.match(status(), /Arabic/);
console.log('PASS: changing reading language does not mix preparation cache languages');

translator.lang = 'ar'; requests.length = 0;
words.clear(); sentences.clear();
$('#tr-level-sentence').checked = true;
$('#tr-scope').value = 'book';
await translator.prepareScope();
assert.match(status(), /✓ Completed: .*\(the whole book, 1 page\)/);
assert.deepEqual(stepCounts(), { sentence: '10/10', word: '60/60' });
assert.equal(translator.job, null);
assert.equal(translator.offlineOnly, true);
requests.length = 0;
await translator.prepareScope();
assert.match(status(), /✓ Already prepared/);
assert.equal(downloads().length, 0);
console.log('PASS: whole-book preparation, then already prepared');

words.clear(); sentences.clear();
const running = translator.prepareScope();
await translator.prepareScope(); // the button says Stop
await running;
assert.match(status(), /^Stopped/);
assert.equal(translator.job, null);
console.log('PASS: Stop');

// Breakdown (word by word): also each different word on its own, once, as a word by word lookup asks for it.
$('#tr-scope').value = 'page';
for (const level of ['sentence', 'clause', 'word']) $(`#tr-level-${level}`).checked = false;
$('#tr-level-breakdown').checked = true;
words.clear(); sentences.clear(); requests.length = 0;
await translator.prepareScope();
assert.match(status(), /✓ Completed: breakdowns \(word by word\)/);
const breakdownItems = itemsOf(downloads());
const alone = breakdownItems.filter((item) => item.context === '' && item.contextOffset === null);
assert.equal(breakdownItems.length - alone.length, 60, 'each word in its sentence (the parts of the breakdown)');
assert.equal(new Set(alone.map((item) => item.word.toLowerCase())).size, alone.length, 'each word on its own once');
assert.ok(alone.length > 0);
assert.equal(sentencesOf(downloads()).length, 10, 'and the sentences');
assert.deepEqual(Object.keys(stepCounts()), ['sentence', 'word', 'alone']);
console.log('PASS: the breakdown level saves the sentences, each word in them and each word on its own');

// What the translator gives nothing for (a name, a sentence): done, not asked for again (but by Prepare again).
$('#tr-level-breakdown').checked = false;
for (const level of ['sentence', 'word']) $(`#tr-level-${level}`).checked = true;
words.clear(); sentences.clear(); noWord.clear();
unglossable.add('word7');
blankable.add(view.text.text(...doc.sent[3]));
await translator.prepareScope();
assert.match(status(), /✓ Completed: .*The translator gives no translation for 2 items/);
assert.deepEqual(stepCounts(), { sentence: '9/10 none 1', word: '59/60 none 1' });
assert.ok(translator.steps.every((s) => s.fill.style.width === '100%'));
requests.length = 0;
await translator.prepareScope();
assert.match(status(), /✓ Already prepared.*no translation for 2 items/);
assert.equal(downloads().length, 0, 'what the translator gives nothing for is not asked for again');
assert.equal($('#tr-again').hidden, false);
unglossable.clear(); blankable.clear(); requests.length = 0;
await translator.prepareScope(true);
assert.match(status(), /✓ Completed/);
assert.doesNotMatch(status(), /no translation/);
assert.deepEqual(stepCounts(), { sentence: '10/10', word: '60/60' });
console.log('PASS: what the translator gives nothing for counts as done; Prepare again asks for it again');

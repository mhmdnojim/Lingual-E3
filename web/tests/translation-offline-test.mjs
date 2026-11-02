// Focused browser regressions using the real Translator/PageText modules and synthetic text.
// Every translation response is mocked; no user text or online translation service is used.
// Run: node web/tests/translation-offline-test.mjs (intercepted origin; no server needed).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.PORT ||= '8804';
const { openBrowser, BASE } = await import('./harness.mjs');
const origin = new URL(BASE).origin;
const fixtureURL = new URL('translation-regression-fixture', BASE).href;
const html = `<!doctype html><meta charset="utf-8"><title>Translation regression fixture</title>
<button id="btn-translate">Page translation</button><button id="tr-toggle">List translation</button>
<select id="tr-lang"></select><p id="tr-from" hidden></p><input id="tr-show" type="checkbox"><input id="tr-page" type="checkbox">
<input id="tr-offline" type="checkbox"><select id="tr-scope"><option value="page">Current page</option><option value="selected">Selected</option><option value="book">Whole book</option></select>
<input id="tr-level-sentence" type="checkbox"><input id="tr-level-clause" type="checkbox"><input id="tr-level-word" type="checkbox">
<div id="tr-sentence-picker"></div><button id="tr-book">Prepare current page</button>
<div id="tr-progress" hidden><div></div></div><p id="tr-status"></p>
<div id="tr-again" hidden><button id="tr-again-yes">Prepare again</button><button id="tr-again-no">No need</button></div><div id="tr-steps" hidden></div>
<div id="stage" style="width:800px;height:600px"><div id="fixture-page" style="width:800px;height:600px"></div></div><div id="toast"></div>`;

const requests = [], dialogs = [], errors = [], wordCache = new Map(), paragraphCache = new Map();
let browser, wordBatches = 0, failWordBatch = 0;
const wordKey = (lang, item) => JSON.stringify([lang, item.word, item.context, item.contextOffset]);
const response = (request, data, status = 200) => request.respond({ status, contentType: 'application/json', body: JSON.stringify(data) });

try {
  const opened = await openBrowser();
  browser = opened.browser;
  const { page } = opened;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.setRequestInterception(true);
  page.on('request', async (request) => {
    const url = new URL(request.url());
    // The fixture never needs external resources. Block them even if a future module adds one.
    if (url.origin !== origin) return request.abort();
    if (request.url() === fixtureURL) return request.respond({ contentType: 'text/html', body: html });
    const module = url.pathname.match(/^\/web\/js\/(translation|pagetext|util)\.js$/)?.[1];
    if (module) return request.respond({ contentType: 'text/javascript', body: await readFile(new URL(`../js/${module}.js`, import.meta.url)) });
    if (url.pathname === '/api/tr-languages') return response(request, [
      { code: 'ar', name: 'Arabic', native: 'Arabic', rtl: true },
      { code: 'fr', name: 'French', native: 'French', rtl: false },
    ]);
    if (url.pathname === '/api/translate-word') {
      const body = JSON.parse(request.postData());
      requests.push({ path: url.pathname, body });
      const items = body.items || [body];
      if (body.items && ++wordBatches === failWordBatch) return response(request, { error: 'Fixture: translator temporarily unavailable' }, 503);
      let fetched = 0, missing = 0;
      const translations = items.map((item) => {
        const key = wordKey(body.lang, item);
        if (!wordCache.has(key) && !body.cachedOnly) {
          wordCache.set(key, `meaning:${item.word}`);
          fetched++;
        }
        if (!wordCache.has(key)) missing++;
        return wordCache.get(key) || '';
      });
      return response(request, body.items
        ? { translations, fetched, missing, wordContext: true }
        : { text: translations[0], fetched, missing, wordContext: true });
    }
    if (url.pathname === '/api/translate') {
      const body = JSON.parse(request.postData());
      requests.push({ path: url.pathname, body });
      let fetched = 0, missing = 0;
      const translations = (body.paragraphs || []).map((paragraph) => paragraph.map((sentence) => {
        const key = JSON.stringify([body.lang, sentence]);
        if (!paragraphCache.has(key) && !body.cachedOnly) {
          paragraphCache.set(key, `translation:${sentence}`);
          fetched++;
        }
        if (!paragraphCache.has(key)) missing++;
        return paragraphCache.get(key) || '';
      }));
      return response(request, { translations, fetched, missing, wordContext: true });
    }
    return request.respond({ status: 404, body: '' });
  });

  await page.goto(fixtureURL);
  await page.evaluate(async () => {
    const { Translator } = await import('/web/js/translation.js');
    const { PageText } = await import('/web/js/pagetext.js');
    localStorage.clear();
    const doc = { words: [], sent: [], clause: [], blocks: [] };
    for (let sentence = 0; sentence < 10; sentence++) {
      const start = doc.words.length;
      for (let word = 0; word < 6; word++) doc.words.push([20 + word * 85, 20 + sentence * 35, 80, 20,
        `word${sentence * 6 + word}${word === 5 ? '.' : ''}`, sentence, word !== 5 ? 1 : 0]);
      doc.sent.push([start, start + 6]);
      doc.clause.push([start, start + 3], [start + 3, start + 6]);
      doc.blocks.push([sentence, sentence + 1]);
    }
    const book = { slug: 'test-book', type: 'Synthetic book', pages: [{ path: 'test-page', n: 1 }] };
    const view = { book, page: book.pages[0], doc, text: new PageText(doc), W: 800, el: document.querySelector('#fixture-page') };
    const app = window.aef = { book, idx: 0, views: [view], editor: { active: false }, recordings: { picking: false },
      renders: 0, renderPanelText() { this.renders++; }, openSettings() {}, remarkActive() {} };
    app.translator = new Translator(app);
    app.translator.setLang('ar', false);
    app.translator.setPage(true);
    window.progressSnapshots = [];
    new MutationObserver(() => window.progressSnapshots.push({
      status: document.querySelector('#tr-status').textContent,
      width: document.querySelector('#tr-progress').firstChild.style.width,
    })).observe(document.querySelector('#tr-progress'), { attributes: true, subtree: true });
  });
  await page.waitForFunction(() => window.aef.translator.langs.length === 2);

  await page.click('#tr-offline');
  assert.deepEqual(errors, [], 'Offline toggle must not reference undefined scope/levels');
  assert.equal(await page.evaluate(() => window.aef.translator.offlineOnly), true);
  const first = await page.evaluate(() => window.aef.translator.wordEntries(window.aef.views[0].text, new Set([0]))[0]);
  const lookup = (item = first) => page.evaluate((entry) => window.aef.translator.word(entry.word, entry.context, entry.contextOffset), item);
  assert.equal(await lookup(), '');
  const afterFirstMiss = requests.length;
  assert.equal(await lookup(), '');
  assert.equal(requests.length, afterFirstMiss + 1, 'A missing offline word must be retried, not cached as empty forever');
  console.log('PASS: offline toggle and retry after an offline word cache miss');

  const prepare = async () => {
    await page.click('#tr-book');
    await page.waitForFunction(() => !window.aef.translator.job, { timeout: 15000 });
    return page.$eval('#tr-status', (element) => element.textContent);
  };
  requests.length = 0;
  const result = await prepare();
  assert.equal(dialogs.length, 0, 'Prepare is the explicit online action and must not open a blocking confirmation');
  assert.match(result, /✓ Completed/);
  assert.equal(await page.evaluate(() => window.aef.translator.offlineOnly), true, 'Preparation must preserve offline-only reading');
  // First a check of what is saved (from the disk only), then the downloads of what is missing.
  const checks = () => requests.filter((entry) => entry.body.cachedOnly === true);
  const downloads = () => requests.filter((entry) => entry.body.cachedOnly === false);
  assert.ok(checks().length >= 1);
  const paragraphs = downloads().filter((entry) => entry.path === '/api/translate');
  const batches = downloads().filter((entry) => entry.path === '/api/translate-word' && entry.body.items);
  assert.ok(paragraphs.length >= 1);
  assert.equal(paragraphs.flatMap((entry) => entry.body.paragraphs.flat()).length, 30, 'Prepares ten sentences and twenty clauses');
  assert.deepEqual(batches.map((entry) => entry.body.items.length), [24, 24, 12]);
  assert.equal(checks().length + downloads().length, requests.length, 'Prepare fetches missing translations even with offline-only reading selected');
  assert.deepEqual(await page.$$eval('#tr-steps .tr-step', (rows) => rows.map((row) => [row.classList.contains('done'), row.textContent])),
    [[true, 'Sentences10 / 10 saved'], [true, 'Clauses20 / 20 saved'], [true, 'Words in context60 / 60 saved']], 'a bar for every step, each complete');
  assert.equal(await page.$eval('#tr-again', (box) => box.hidden), true);
  const progress = await page.evaluate(() => window.progressSnapshots);
  assert.ok(progress.some((entry) => parseFloat(entry.width) > 0 && parseFloat(entry.width) < 100), 'Progress advances before the last batch completes');
  assert.ok(progress.some((entry) => parseFloat(entry.width) === 100), 'Progress reaches completion');
  assert.equal(await lookup(), 'meaning:word0');
  assert.equal(requests.at(-1).body.cachedOnly, true, 'Subsequent word lookup reads only saved translations');
  await page.evaluate(async () => { const app = window.aef; await app.translator.showTip(app.views[0], app.views[0].text.unitAt(0, 'word')); });
  assert.match(await page.$eval('.tr-tip', (element) => element.textContent), /meaning:word0/);
  console.log('PASS: Prepare saves sentence, clause, and bounded word batches, shows progress, and supplies offline word popup');

  // Again: it was prepared already, so nothing is downloaded and it asks whether to do it again.
  requests.length = 0;
  assert.match(await prepare(), /✓ Already prepared \(on .+\): .*No need to prepare again/);
  assert.equal(downloads().length, 0);
  assert.equal(await page.$eval('#tr-again', (box) => box.hidden), false);
  await page.click('#tr-again-no');
  assert.equal(await page.$eval('#tr-again', (box) => box.hidden), true);
  console.log('PASS: prepared before: says so, downloads nothing, asks whether to prepare again');

  // Rebuild selected levels without sentence preparation. This must not depend on sentence-level results.
  await page.click('#tr-level-sentence');
  assert.match(await page.$eval('#tr-status', (element) => element.textContent), /✓ Prepared before, on .+, for Arabic/);
  requests.length = 0;
  assert.match(await prepare(), /✓ Already prepared/);
  assert.equal(checks().filter((entry) => entry.path === '/api/translate').flatMap((entry) => entry.body.paragraphs.flat()).length, 20);
  assert.equal(checks().filter((entry) => entry.body.items).flatMap((entry) => entry.body.items).length, 60);
  assert.equal(downloads().length, 0);
  await page.click('#tr-level-clause');
  requests.length = 0;
  assert.match(await prepare(), /✓ Already prepared/);
  assert.equal(requests.filter((entry) => entry.path === '/api/translate').length, 0);
  assert.equal(requests.filter((entry) => entry.body.items).flatMap((entry) => entry.body.items).length, 60);
  console.log('PASS: clause/word preparation and word-only preparation do not require sentence level');

  // One batch is durable even when the next batch fails. An earlier miss must not hide it.
  wordCache.clear();
  await page.evaluate(() => { window.aef.translator.words.clear(); });
  assert.equal(await lookup(), '');
  wordBatches = 0;
  failWordBatch = 3; // (1: the check, 2: the first download)
  const failed = await prepare();
  assert.match(failed, /temporarily unavailable/i);
  assert.equal(await lookup(), 'meaning:word0', 'First-batch words remain usable offline after later preparation failure');
  assert.equal(await page.evaluate(() => window.aef.translator.offlineOnly), true);
  failWordBatch = 0;
  assert.match(await prepare(), /✓ Completed/, 'Retry finishes remaining word translations');
  assert.deepEqual(errors, []);
  console.log('PASS: partial preparation failure preserves saved words and clears stale missing results');
} finally {
  await browser?.close();
}

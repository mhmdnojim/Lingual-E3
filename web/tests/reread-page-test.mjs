// Reading a whole page again: its steps shown as they go; the sentences corrected before (text
// changed, split, typed) stay as they are and keep their places, what is read in their places is
// left out; text deleted before comes back unticked; Stop leaves the page as it was.
// Run: node web/tests/reread-page-test.mjs
import assert from 'node:assert/strict';

process.env.PORT ||= '8822';
const { startServer, stopServer, openBrowser, gotoPage, sleep } = await import('./harness.mjs');

const server = await startServer();
const { browser, page } = await openBrowser();
const errors = [];
const sentences = () => page.evaluate(() => { const t = window.aef.views[0].text; return t.sent.map(([a, b]) => t.text(a, b)); });
const saved = () => page.waitForFunction(() => window.aef.editor.status === 'saved' && window.aef.views[0].edited, { timeout: 5000 });
const review = () => page.evaluate(() => ({
  kept: [...document.querySelectorAll('.ocr-kept li')].map((li) => li.textContent),
  rows: [...document.querySelectorAll('.ocr-preview-line')].map((r) => ({ text: r.querySelector('textarea').value, on: r.querySelector('input').checked, deleted: r.classList.contains('was-deleted') })),
}));
const accept = () => page.evaluate(() => [...document.querySelectorAll('.ocr-preview .btn.primary')][0].click());
try {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await gotoPage(page, '#/1706/10');
  await page.click('.panel [role=tab][data-tab="text"]');
  await page.click('#edit-text');
  await sleep(300);
  // Corrections: a sentence's text changed, one deleted, one split, one moved down, one typed at the end.
  const made = await sentences();
  const long = made.map((t, k) => (t.split(' ').length >= 4 ? k : -1)).filter((k) => k >= 0);
  const [fix, gone, cut, moved] = [long[1], long[3], long[5], long[7]];
  await page.evaluate(({ fix, gone, cut, moved }) => {
    const ed = window.aef.editor, v = window.aef.views[0];
    const at = (k) => ed.selAt(v, v.doc.sent[k][0]);
    ed.run('down', undefined, at(moved));
    ed.run('split', 2, at(cut));
    ed.run('delete', undefined, at(gone));
    ed.run('text', 'This sentence was corrected by hand.', at(fix));
    ed.run('add', 'A sentence typed by hand.', { view: v, bi: -1, si: -1 });
  }, { fix, gone, cut, moved });
  await saved();
  const corrected = await sentences();
  assert.equal(corrected.length, made.length + 1, '(split +1, deleted -1, typed +1)');
  assert.equal(corrected[moved + 1], made[moved], '(moved down)');

  // 1. The OCR reads the page as it was made: what was corrected stays, the rest is as it was.
  const original = await page.evaluate(() => fetch(`${window.aef.views[0].textUrl}?original=1`).then((r) => r.json()));
  assert.ok(original.original, 'the text as it was made, without the corrections');
  let delay = 1500;
  await page.setRequestInterception(true);
  page.on('request', async function stub(req) {
    if (!req.url().includes('/api/ocr-region/')) { req.continue().catch(() => {}); return; }
    const { original: _, ...doc } = original;
    await sleep(delay);
    const lines = [{ plan: ['Preparing the page picture', 'Reading the English text (OCR)', 'Making the sentences'] }, { at: 0 }, { at: 1 }, { at: 2 }, { doc }];
    req.respond({ status: 200, contentType: 'application/x-ndjson', body: lines.map((l) => JSON.stringify(l)).join('\n') + '\n' }).catch(() => {});
  });
  await page.click('#edit-bulk [data-op="read-page"]');
  await sleep(500);
  const during = await page.evaluate(() => ({
    title: document.querySelector('.page-read h4')?.textContent,
    steps: [...document.querySelectorAll('.page-read-steps li')].map((li) => `${li.className}:${li.textContent}`),
    bar: document.querySelector('.page-read [role=progressbar]')?.getAttribute('aria-valuenow'),
    status: document.querySelector('#edit-status').textContent,
  }));
  assert.match(during.title, /^Reading page \d+ again$/);
  assert.equal(during.steps[0], 'done:Your corrections kept: 4 sentences', JSON.stringify(during.steps));
  assert.ok(Number(during.bar) > 0, `the bar moves (${during.bar}%)`);
  assert.equal(during.status, 'Reading the page again…');
  await page.waitForSelector('.ocr-kept', { timeout: 8000 });
  const r1 = await review();
  assert.deepEqual([...r1.kept].sort(), [corrected[fix], corrected[cut - 1], corrected[cut], 'A sentence typed by hand.'].sort(), 'the corrected sentences are kept');
  const back = r1.rows.filter((r) => r.deleted);
  assert.deepEqual(back.map((r) => [r.text, r.on]), [[made[gone], false]], 'the deleted sentence comes back unticked');
  assert.ok(!r1.rows.some((r) => [made[fix], made[cut]].includes(r.text)), 'nothing read again where the corrections are');
  assert.equal(r1.rows.filter((r) => r.on).length, made.length - 3, 'the other sentences, read again');
  await accept();
  await saved();
  assert.deepEqual(await sentences(), corrected, 'read the same again: the page is as corrected, in the order as corrected');
  console.log('PASS: the steps are shown as the page is read; the corrected sentences stay where they are (and the order as corrected); deleted text comes back unticked');

  // 2. Stop: the page as it was.
  delay = 4000;
  await page.click('#edit-bulk [data-op="read-page"]');
  await sleep(400);
  await page.evaluate(() => [...document.querySelectorAll('.page-read .btn')].find((b) => b.textContent === 'Stop').click());
  await sleep(300);
  assert.equal(await page.$('.page-read'), null, 'the steps are gone');
  assert.ok(await page.$('#text-view .esent'), 'the sentences are listed again');
  await sleep(4000);
  assert.equal(await page.$('.ocr-preview'), null, 'what was read after Stop is not shown');
  assert.deepEqual(await sentences(), corrected);
  console.log('PASS: Stop leaves the page as it was');

  // 3. The OCR of this computer (when there is one): the steps come one after the other.
  page.removeAllListeners('request');
  await page.setRequestInterception(false);
  await page.click('#edit-bulk [data-op="read-page"]');
  const seen = new Set();
  let widths = [], result = null;
  for (let t = 0; t < 600 && !result; t++) {
    const now = await page.evaluate(() => ({
      done: document.querySelectorAll('.page-read-steps li.done').length,
      steps: document.querySelectorAll('.page-read-steps li').length,
      bar: Number(document.querySelector('.page-read [role=progressbar]')?.getAttribute('aria-valuenow') || -1),
      review: !!document.querySelector('.ocr-preview:not(.page-read)'),
      error: document.querySelector('#edit-status').classList.contains('err') && document.querySelector('#toast')?.textContent,
    }));
    if (now.review) result = 'review';
    else if (now.error) result = now.error;
    if (now.steps) seen.add(`${now.done}/${now.steps}`);
    if (now.bar >= 0) widths.push(now.bar);
    await sleep(150);
  }
  if (result !== 'review') {
    console.log(`SKIP: the OCR of this computer could not read the page (${result})`);
  } else {
    assert.ok(seen.size >= 3, `the steps one after the other: ${[...seen].join(', ')}`);
    assert.ok(widths.every((w, k) => !k || w >= widths[k - 1]) && widths.at(-1) > widths[0], `the bar only grows: ${widths[0]}% → ${widths.at(-1)}%`);
    const r3 = await review();
    assert.equal(r3.kept.length, 4);
    await accept();
    await saved();
    const after = await sentences();
    for (const s of [corrected[fix], corrected[cut - 1], corrected[cut], 'A sentence typed by hand.']) {
      assert.equal(after.filter((t) => t === s).length, 1, `kept once: “${s}”`);
    }
    console.log(`PASS: read with OCR, the steps shown one after the other (${[...seen].join(', ')}); the corrections kept, each once (${after.length} sentences)`);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await stopServer(server);
}

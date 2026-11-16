// New audio from sentences of several pages (js/recordings.js): what was chosen on a page stays chosen
// when the next page is shown (and is chosen again when the page comes back); "Pages from … to …" chooses
// whole pages, loading those not shown; one list, in the order of the book, goes to the new audio.
// Run: node web/tests/audio-pages-test.mjs
import assert from 'node:assert/strict';

process.env.PORT ||= '18991';
const { startServer, stopServer, openBrowser, gotoPage, sleep } = await import('./harness.mjs');

const server = await startServer();
const { browser, page } = await openBrowser({ width: 1500, height: 950 });
const errors = [];
try {
  page.on('pageerror', (e) => errors.push(e.message));
  await gotoPage(page, '#/1705/10');
  await page.waitForFunction(() => window.aef.views[0]?.text);
  const book = await page.evaluate(() => window.aef.book.slug);
  const countOf = (n) => page.evaluate(async (slug, n) => { const d = await (await fetch(`/api/text/${slug}/${n}`)).json(); return d.sent.length; }, book, n);
  const here = () => page.evaluate(() => window.aef.views.map((v) => v.page.n));
  const chosen = () => page.evaluate(() => window.aef.recordings.pickedSentences().map((s) => `${s.view.page.n}:${s.a}`));
  const goTo = async (n) => {
    await page.evaluate((n) => window.aef.go(window.aef.book.id, n), n);
    await page.waitForFunction((n) => window.aef.views.some((v) => String(v.page.n) === String(n) && v.text), { timeout: 15000 }, n);
    await sleep(300);
  };
  await page.evaluate(() => window.aef.recordings.startPicking({ newAudio: true }));
  const first = (await here())[0];

  // Two sentences on this page.
  await page.evaluate(() => { const r = window.aef.recordings, v = window.aef.views[0]; r.setOf(v).add(0); r.setOf(v).add(1); r.update(); });
  assert.equal((await chosen()).length, 2);

  // The next page: the two stay chosen, and more can be chosen there.
  const next = await page.evaluate((n) => { const pages = window.aef.book.pages; return pages[pages.findIndex((p) => p.n === n) + 1].n; }, first);
  await goTo(next);
  assert.equal((await chosen()).length, 2, 'what was chosen on the page before stays chosen');
  await page.evaluate(() => { const r = window.aef.recordings, v = window.aef.views[0]; r.setOf(v).add(0); r.update(); });
  const both = await chosen();
  assert.equal(both.length, 3);
  assert.ok(both[0].startsWith(`${first}:`) && both[2].startsWith(`${next}:`), `in the order of the book: ${both}`);
  assert.match(await page.$eval('#rec-count', (e) => e.textContent), /3 sentences chosen/);

  // Back: the page shows its two sentences chosen again.
  await goTo(first);
  assert.equal(await page.evaluate(() => window.aef.recordings.setOf(window.aef.views[0]).size), 2, 'chosen again on the page that comes back');
  assert.equal((await chosen()).length, 3);

  // Whole pages from … to …: loaded and chosen (those not shown too).
  await page.evaluate(() => window.aef.recordings.picked.forEach((s) => s.clear()));
  await page.evaluate(() => { window.aef.recordings.keptPicks = []; });
  const last = await page.evaluate((n) => { const pages = window.aef.book.pages; return pages[pages.findIndex((p) => p.n === n) + 2].n; }, first);
  await page.evaluate((a, b) => window.aef.recordings.pickPages(a, b), first, last);
  const all = await page.evaluate((a, b) => window.aef.book.pages.filter((p) => Number(p.n) >= Number(a) && Number(p.n) <= Number(b)).map((p) => p.n), first, last);
  let total = 0;
  for (const n of all) total += await countOf(await page.evaluate((n) => window.aef.book.pages.find((p) => p.n === n).path, n));
  assert.equal((await chosen()).length, total, `all the sentences of pages ${first}-${last}`);

  // Clear forgets everything, on the pages not shown too.
  await page.evaluate(() => document.querySelector('[data-pick="none"]').click());
  assert.equal((await chosen()).length, 0);
  assert.deepEqual(errors, []);
  console.log('PASS: sentences chosen on several pages stay chosen; Pages from … to … chooses whole pages; one list for the audio');
} finally {
  await browser.close();
  await stopServer(server);
}

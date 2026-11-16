// Ordering sentences with a reference (js/editor.js, the icon "Choose this sentence as a reference"):
// the icon is a switch (pressed again, ordering is off); a sentence clicked that is already the next
// one keeps its number and its paragraph, and ordering goes on from it; another one moves after the
// last one; with ordering off a click only selects.
// Run: node web/tests/reference-order-test.mjs
import assert from 'node:assert/strict';

process.env.PORT ||= '18981';
const { startServer, stopServer, openBrowser, gotoPage, sleep } = await import('./harness.mjs');

const server = await startServer();
const { browser, page } = await openBrowser();
const errors = [];
const sentences = () => page.evaluate(() => { const t = window.aef.views[0].text; return t.sent.map(([a, b]) => t.text(a, b)); });
const blocks = () => page.evaluate(() => window.aef.views[0].doc.blocks.map(([a, b]) => [a, b]));
try {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await gotoPage(page, '#/1705/10');
  await page.click('.panel [role=tab][data-tab="text"]');
  await page.click('#edit-text');
  await sleep(300);
  const before = await sentences();
  const bl = await blocks();
  assert.ok(before.length >= 8, 'a page with sentences');
  const row = (k) => page.evaluate((k) => {
    const doc = window.aef.views[0].doc;
    const bi = doc.blocks.findIndex(([a, b]) => k >= a && k < b);
    document.querySelector(`.esent[data-v="0"][data-b="${bi}"][data-s="${k - doc.blocks[bi][0]}"]`).click();
  }, k);
  const pressed = () => page.$eval('button[data-op="move-click"]', (b) => b.getAttribute('aria-pressed') === 'true' || b.classList.contains('on') || b.classList.contains('pressed'));

  await row(2); // the reference: sentence 3
  await page.click('button[data-op="move-click"]');
  assert.ok(await page.evaluate(() => !!window.aef.editor.moveByClick), 'ordering is on');

  // The next one (sentence 4) is clicked: it keeps its number, ordering goes on from it.
  await row(3);
  assert.deepEqual(await sentences(), before, 'a sentence that is already next stays where it is');
  assert.deepEqual(await blocks(), bl, 'its paragraph does not change');
  assert.equal(await page.evaluate(() => window.aef.editor.flatIndex(window.aef.editor.moveByClick)), 3, 'ordering goes on from it');

  // Another one (sentence 7) goes after sentence 4.
  await row(6);
  const moved = await sentences();
  assert.deepEqual(moved.slice(0, 5), [...before.slice(0, 4), before[6]], 'sentence 7 is now number 5');

  // The icon again: ordering is off. A click only selects (nothing moves).
  await page.click('button[data-op="move-click"]');
  assert.equal(await page.evaluate(() => window.aef.editor.moveByClick), null, 'ordering is off');
  await row(1);
  assert.deepEqual(await sentences(), moved, 'with ordering off a click moves nothing');

  assert.deepEqual(errors, []);
  console.log('PASS: the reference icon is a switch; the next sentence keeps its number and ordering goes on; others move after the last');
} finally {
  await browser.close();
  await stopServer(server);
}

// Help cards (js/help.js): pointing at a button shows a card that follows the pointer, with what it
// does and how to use it (from the table, or the button's own title); the browser's tip is set aside
// and put back; the "?" button switches the cards off and on; every icon button of the page has text.
// Run: node web/tests/help-test.mjs
import assert from 'node:assert/strict';

process.env.PORT ||= '18951';
const { startServer, stopServer, openBrowser, BASE, sleep } = await import('./harness.mjs');
const server = await startServer();
const { browser, page } = await openBrowser({ width: 1400, height: 900 });
const errors = [];
try {
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE + '#/1705/10');
  await page.waitForFunction(() => window.aef.views[0]?.text);
  const card = () => page.evaluate(() => { const t = document.querySelector('.help-tip'); return t && !t.hidden ? t.innerText : null; });
  const centre = async (sel) => { const r = await page.$eval(sel, (e) => { const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; }); return r; };

  let [x, y] = await centre('#btn-repeat');
  await page.mouse.move(x, y);
  await sleep(700);
  const text = await card();
  assert.ok(text && /Repeat each sentence/i.test(text) && /How to use it/i.test(text) && /for ever/.test(text), text);
  assert.equal(await page.$eval('#btn-repeat', (e) => e.getAttribute('title')), null, 'the browser’s own tip is set aside');
  const at = await page.$eval('.help-tip', (e) => [e.getBoundingClientRect().x, e.getBoundingClientRect().y]);
  await page.mouse.move(x + 6, y + 4);
  await sleep(100);
  const moved = await page.$eval('.help-tip', (e) => [e.getBoundingClientRect().x, e.getBoundingClientRect().y]);
  assert.ok(moved[0] !== at[0] || moved[1] !== at[1], 'the card follows the pointer');
  await page.mouse.move(5, 500);
  await sleep(200);
  assert.equal(await card(), null, 'gone when the pointer leaves');
  assert.ok((await page.$eval('#btn-repeat', (e) => e.getAttribute('title'))).startsWith('Repeat each'), 'the title is back');

  // A button not in the table: its own title.
  [x, y] = await centre('#copy-text').catch(() => [0, 0]);
  if (x) { await page.mouse.move(x, y); await sleep(500); assert.match(await card() || '', /Copy the page text|Copies all the text/); await page.mouse.move(5, 500); }

  // Off and on.
  await page.click('#btn-help');
  assert.equal(await page.$eval('#btn-help', (e) => e.getAttribute('aria-pressed')), 'false');
  [x, y] = await centre('#btn-zoom-in');
  await page.mouse.move(x, y); await sleep(700);
  assert.equal(await card(), null, 'off: no card');
  await page.click('#btn-help'); await page.mouse.move(5, 500); await sleep(300);
  [x, y] = await centre('#btn-zoom-in');
  await page.mouse.move(x, y); await sleep(700);
  assert.match(await card() || '', /Zoom in/);

  // Every icon button of the page says something (a title or a label), and the main ones have a "how to use".
  const bare = await page.evaluate(() => [...document.querySelectorAll('button.icon-btn')]
    .filter((b) => !b.hidden && !(b.getAttribute('title') || b.getAttribute('aria-label') || b.dataset.help)).map((b) => b.id || b.className));
  assert.deepEqual(bare, [], 'icon buttons with no name: ' + bare);
  const { HELP } = await page.evaluate(async () => { const m = await import('/web/js/help.js'); return { HELP: Object.keys(m.HELP) }; });
  const ids = await page.evaluate(() => [...document.querySelectorAll('.topbar button[id]')].map((b) => b.id));
  const missing = ids.filter((id) => !HELP.includes(id));
  assert.deepEqual(missing, [], 'top bar buttons without a help text: ' + missing);
  assert.deepEqual(errors, []);
  console.log('PASS: help cards follow the pointer, explain the button, switch off and on; every top bar button has help');
} finally {
  await browser.close();
  await stopServer(server);
}

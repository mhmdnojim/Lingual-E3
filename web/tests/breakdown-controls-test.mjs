// The breakdown dialog: A− / A+ change the size of its letters (kept), the repeat button goes once → 2 → 3 → ∞
// → once (kept), and with ∞ the sentence is said again and again until Stop.
// Run: node web/tests/breakdown-controls-test.mjs
import assert from 'node:assert/strict';

process.env.PORT ||= '8822';
const { startServer, stopServer, openBrowser, BASE, sleep } = await import('./harness.mjs');
const server = await startServer();
const { browser, page } = await openBrowser();
const errors = [];
try {
  page.on('pageerror', (e) => errors.push(e.message));
  await page.evaluateOnNewDocument(() => {
    window.spoken = [];
    speechSynthesis.speak = (u) => { window.spoken.push(u.text); setTimeout(() => u.onend?.({}), 30); };
  });
  await page.goto(BASE + '#/1705/25', { waitUntil: 'networkidle0' });
  await sleep(1200);
  await page.evaluate(() => {
    const v = window.aef.views[0], t = v.text;
    window.aef.breakdown.open({ view: v, a: t.sent[0][0], b: t.sent[0][1] });
  });
  await page.waitForSelector('.bd .bd-size');
  const size = () => page.$eval('.bd-sentence', (e) => parseFloat(getComputedStyle(e).fontSize));
  const before = await size();
  await page.click('.bd-size[title="Bigger letters"]');
  await page.click('.bd-size[title="Bigger letters"]');
  assert.ok(await size() > before + 3, 'bigger letters');
  await page.click('.bd-size[title="Smaller letters"]');
  assert.ok(await size() < before + 6 && await size() > before, 'one step smaller');
  const label = () => page.$eval('.bd-repeat b', (e) => e.textContent);
  assert.equal(await label(), '×1');
  const seen = [];
  for (let i = 0; i < 4; i++) { await page.click('.bd-repeat'); seen.push(await label()); }
  assert.deepEqual(seen, ['×2', '×3', '∞', '×1']);
  // ×2: the sentence is said twice.
  await page.evaluate(() => { window.spoken = []; });
  await page.click('.bd-sentence button');
  await sleep(1200);
  const once = await page.evaluate(() => window.spoken.length);
  assert.ok(once >= 1);
  await page.click('.bd-repeat'); // ×2: twice as many
  await page.evaluate(() => { window.spoken = []; });
  await page.click('.bd-sentence button');
  await sleep(2000);
  assert.equal(await page.evaluate(() => window.spoken.length), 2 * once, 'twice');
  // ∞: said again and again until another voice or Stop.
  await page.click('.bd-repeat'); await page.click('.bd-repeat'); // ×3, ∞
  assert.equal(await label(), '∞');
  await page.evaluate(() => { window.spoken = []; });
  await page.click('.bd-sentence button');
  await sleep(1500);
  const n = await page.evaluate(() => window.spoken.length);
  assert.ok(n >= 3, `again and again (${n})`);
  await page.evaluate(() => window.aef.breakdown.stop());
  await sleep(300);
  const stopped = await page.evaluate(() => window.spoken.length);
  await sleep(800);
  assert.equal(await page.evaluate(() => window.spoken.length), stopped, 'Stop ends it');
  // Kept for the next time.
  await page.evaluate(() => document.querySelector('#md-close').click());
  await page.evaluate(() => { const v = window.aef.views[0], t = v.text; window.aef.breakdown.open({ view: v, a: t.sent[0][0], b: t.sent[0][1] }); });
  await page.waitForSelector('.bd .bd-size');
  assert.equal(await label(), '∞');
  assert.ok(await size() > before, 'the size is kept');
  assert.deepEqual(errors, []);
  console.log('PASS: breakdown: letter size A−/A+, repeat ×1/×2/×3/∞, both kept');
} finally {
  await browser.close();
  await stopServer(server);
}

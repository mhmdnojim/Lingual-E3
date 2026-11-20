// Re-read text by area, when the OCR finds nothing: the review's buttons are at the top (no scrolling down to
// "Add selected sentences"), the side panel is wider while it is open and the editing buttons are folded,
// the page's sentence numbers do not cover the page, an area can be read with the AI (its lines go into the
// area's boxes to be checked), the panel can be dragged wider and the editing buttons folded by hand.
// Run: node web/tests/review-layout-test.mjs
import assert from 'node:assert/strict';

process.env.PORT ||= '18953';
const { startServer, stopServer, openBrowser, gotoPage, sleep } = await import('./harness.mjs');

const server = await startServer();
const { browser, page } = await openBrowser({ width: 1500, height: 950 });
const errors = [];
let aiCalls = 0;
try {
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('/api/ocr-region/')) { // the OCR finds nothing
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ words: [], sent: [], clause: [], blocks: [] }) }).catch(() => {});
    }
    if (url.endsWith('/api/layout-ai')) return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ready: true, can: true }) }).catch(() => {});
    if (url.includes('/api/ai-read/')) {
      aiCalls += 1;
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ lines: ['C. 大', 'D. 办法'] }) }).catch(() => {});
    }
    return req.continue().catch(() => {});
  });
  await gotoPage(page, '#/1705/10');
  await page.click('.panel [role=tab][data-tab="text"]');
  await page.click('#edit-text');
  await sleep(300);
  const panelWidth = () => page.$eval('#panel', (e) => Math.round(e.getBoundingClientRect().width));
  const before = await panelWidth();

  // A box where the OCR finds nothing.
  await page.evaluate(() => { const ed = window.aef.editor, v = window.aef.views[0]; ed.readArea(v, { x: 60, y: 80, w: 220, h: 60 }, ed.sel); });
  await page.waitForSelector('.ocr-preview', { timeout: 8000 });
  await sleep(500);

  // The buttons are the first thing in the review, and stay in view.
  assert.equal(await page.$eval('.ocr-preview', (e) => e.firstElementChild.className.includes('ocr-preview-actions')), true, 'the buttons come first');
  const inView = await page.$eval('.ocr-preview-actions.top .btn.primary', (b) => { const r = b.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
  assert.equal(inView, true, '"Add selected sentences" is in view without scrolling');
  assert.equal(await page.$eval('.ocr-preview-actions.top', (e) => getComputedStyle(e).position), 'sticky');

  // A wider panel while it is open; the editing buttons are folded.
  assert.ok(await panelWidth() >= 470 && await panelWidth() > before, `wider (${before} → ${await panelWidth()})`);
  assert.equal(await page.$eval('#edit-tools', (e) => getComputedStyle(e).display), 'none', 'the editing buttons are folded');
  // The numbers of the sentences do not cover the page.
  assert.equal(await page.$$eval('.edit-outlines .o:not(.quiet)', (g) => g.length), 0, 'sentence numbers are quiet');
  assert.equal(await page.$eval('.edit-outlines .o text', (t) => getComputedStyle(t).display), 'none');

  // Read the area with the AI: its lines are in the area's boxes, to be checked.
  await page.click('.ocr-ai-btn');
  await page.waitForFunction(() => document.querySelectorAll('.ocr-area .ocr-preview-line textarea').length >= 2 && [...document.querySelectorAll('.ocr-area textarea')].some((t) => t.value === 'C. 大'), { timeout: 5000 });
  assert.equal(aiCalls, 1);
  assert.deepEqual(await page.$$eval('.ocr-area textarea', (t) => t.map((x) => x.value)), ['C. 大', 'D. 办法']);

  // Cancel: the panel goes back.
  await page.click('.ocr-preview-actions.top .btn:last-child');
  await sleep(300);
  assert.equal(await panelWidth(), before, 'the width comes back');
  assert.notEqual(await page.$eval('#edit-tools', (e) => getComputedStyle(e).display), 'none', 'the buttons are back');

  // The editing buttons folded by hand (kept), and the panel dragged wider.
  await page.click('#edit-tools-toggle');
  assert.equal(await page.$eval('#edit-tools', (e) => getComputedStyle(e).display), 'none');
  await page.click('#edit-tools-toggle');
  const grip = await page.$eval('#panel-resize', (e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + 200]; });
  await page.mouse.move(...grip); await page.mouse.down(); await page.mouse.move(grip[0] - 150, grip[1], { steps: 6 }); await page.mouse.up();
  assert.ok(await panelWidth() >= before + 120, `dragged wider (${await panelWidth()})`);
  await page.reload(); await page.waitForFunction(() => window.aef?.views?.[0]?.text); await sleep(500);
  assert.ok(await panelWidth() >= before + 120, 'the width is kept');
  assert.deepEqual(errors, []);
  console.log('PASS: review buttons on top, panel wider and tools folded while it is open, numbers quiet, AI read of an area, draggable panel');
} finally {
  await browser.close();
  await stopServer(server);
}

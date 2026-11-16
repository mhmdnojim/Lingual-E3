// Text read again from several boxes is numbered in the order the boxes were drawn: the sentences of
// the first box before those of the second, whatever their places on the page (js/editor.js replaceAreas).
// Run: node web/tests/area-order-test.mjs
import assert from 'node:assert/strict';

process.env.PORT ||= '18971';
const { startServer, stopServer, openBrowser, BASE } = await import('./harness.mjs');

let server, browser;
try {
  server = await startServer();
  const opened = await openBrowser({ width: 1200, height: 800 });
  browser = opened.browser;
  const { page } = opened;
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.waitForFunction(() => !!window.aef);
  const result = await page.evaluate(async () => {
    const { OPS } = await import('/web/js/editor.js');
    const w = (t, x, y, line) => ({ t, box: [x, y, 60, 20], line, sp: true });
    const sentence = (text, x, y, line) => text.split(' ').map((t, k) => w(t, x + k * 70, y, line));
    // The page: a sentence high up (y 100), one low down (y 600), one in the middle that is not read again.
    const model = () => [[sentence('old top', 50, 100, 0), sentence('middle stays', 50, 350, 1), sentence('old bottom', 50, 600, 2)]];
    const rectTop = { x: 0, y: 80, w: 500, h: 60 }, rectBottom = { x: 0, y: 580, w: 500, h: 60 };
    const fresh = (text, x, y) => [[sentence(text, x, y, 0)]];
    const text = (m) => m.flat().map((s) => s.map((x) => x.t).join(' '));
    // Boxes drawn: the LOW one first, then the HIGH one (replacing the text of each).
    const m1 = model();
    OPS.replaceAreas(m1, 0, 0, { areas: [
      { rect: rectBottom, blocks: fresh('first box', 50, 600), keep: false },
      { rect: rectTop, blocks: fresh('second box', 50, 100), keep: false }] });
    // The other way round: the HIGH one first.
    const m2 = model();
    OPS.replaceAreas(m2, 0, 0, { areas: [
      { rect: rectTop, blocks: fresh('first box', 50, 100), keep: false },
      { rect: rectBottom, blocks: fresh('second box', 50, 600), keep: false }] });
    // Boxes over text that is not there (added, keep): the first box still first.
    const m3 = model();
    OPS.replaceAreas(m3, 0, 0, { areas: [
      { rect: { x: 0, y: 700, w: 500, h: 60 }, blocks: fresh('added low', 50, 700), keep: true },
      { rect: { x: 0, y: 20, w: 500, h: 40 }, blocks: fresh('added high', 50, 20), keep: true }] });
    return { lowFirst: text(m1), highFirst: text(m2), added: text(m3) };
  });
  const order = (list, a, b) => list.indexOf(a) < list.indexOf(b);
  assert.ok(order(result.lowFirst, 'first box', 'second box'), `the first box (low on the page) is numbered first: ${JSON.stringify(result.lowFirst)}`);
  assert.ok(order(result.highFirst, 'first box', 'second box'), `the first box (high on the page) is numbered first: ${JSON.stringify(result.highFirst)}`);
  assert.ok(result.lowFirst.includes('middle stays'), 'the sentence not read again stays');
  assert.ok(order(result.added, 'added low', 'added high'), `added: the first box's sentence first: ${JSON.stringify(result.added)}`);
  assert.deepEqual(errors, []);
  console.log('PASS: sentences read from several boxes are numbered in the order of the boxes');
} finally {
  await browser?.close();
  await stopServer(server);
}

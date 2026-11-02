// Text read again by area goes where it is on the page, so the sentences stay numbered one after
// the other: replacing (what was read wrongly) puts the new text where the old was, in the middle
// of its paragraph; adding (what was missed) puts it among the others by its place on the page.
// Run: node web/tests/area-reread-test.mjs
import assert from 'node:assert/strict';

process.env.PORT ||= '8823';
const { startServer, stopServer, openBrowser, gotoPage, sleep } = await import('./harness.mjs');

const server = await startServer();
const { browser, page } = await openBrowser();
const errors = [];
const sentences = () => page.evaluate(() => { const t = window.aef.views[0].text; return t.sent.map(([a, b]) => t.text(a, b)); });
const numbers = () => page.evaluate(() => [...document.querySelectorAll('#text-view .esent .num')].map((n) => Number(n.textContent)));
const saved = () => page.waitForFunction(() => window.aef.editor.status === 'saved' && window.aef.views[0].edited, { timeout: 5000 });
let read = null; // the words the OCR "finds" in the area
let found = null; // (or the page text it makes of them)
let byArea = null; // (or, for each of several areas [{rect, words}], the words in the one asked)
try {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (!req.url().includes('/api/ocr-region/')) { req.continue().catch(() => {}); return; }
    if (byArea) {
      const { x, y, w, h } = JSON.parse(req.postData()), mid = (r) => [r.x + r.w / 2, r.y + r.h / 2];
      const [cx, cy] = mid({ x, y, w, h });
      read = byArea.reduce((p, q) => (Math.hypot(...mid(q.rect).map((v, i) => v - [cx, cy][i])) < Math.hypot(...mid(p.rect).map((v, i) => v - [cx, cy][i])) ? q : p)).words;
    }
    const words = read.map((w, k) => [...w.slice(0, 4), w[4], k === 0 ? 0 : w[5] - read[0][5], w[6] ?? 1]);
    const doc = found || { words, sent: [[0, words.length]], clause: [[0, words.length]], blocks: [[0, 1]] };
    req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(doc) }).catch(() => {});
  });
  await gotoPage(page, '#/1705/10');
  await page.click('.panel [role=tab][data-tab="text"]');
  await page.click('#edit-text');
  await sleep(300);
  const made = await sentences();
  // Sentences in the middle of a paragraph, with no other words in their area (the first one: k).
  const alone = (middle = true) => page.evaluate((middle) => {
    const doc = window.aef.views[0].doc, out = [];
    const box = (s) => { const ws = doc.words.slice(...doc.sent[s]).filter((w) => w[2] > 0); return [Math.min(...ws.map((w) => w[0])), Math.min(...ws.map((w) => w[1])), Math.max(...ws.map((w) => w[0] + w[2])), Math.max(...ws.map((w) => w[1] + w[3]))]; };
    for (const [sa, sb] of doc.blocks) for (let s = middle ? sa + 1 : sa; s < (middle ? sb - 1 : sb); s++) {
      const [x0, y0, x1, y1] = box(s), [a, b] = doc.sent[s];
      if (b - a > 3 && doc.words.every((w, i) => (i >= a && i < b) || !(w[0] + w[2] / 2 >= x0 - 2 && w[0] + w[2] / 2 <= x1 + 2 && w[1] + w[3] / 2 >= y0 - 2 && w[1] + w[3] / 2 <= y1 + 2))) out.push(s);
    }
    return out;
  }, middle);
  const k = (await alone())[0] ?? -1;
  assert.ok(k > 0, 'a sentence in the middle of a paragraph');
  const areaOf = (s) => page.evaluate((k) => {
    const doc = window.aef.views[0].doc, ws = doc.words.slice(...doc.sent[k]).filter((w) => w[2] > 0);
    const x = Math.min(...ws.map((w) => w[0])) - 2, y = Math.min(...ws.map((w) => w[1])) - 2;
    return { rect: { x, y, w: Math.max(...ws.map((w) => w[0] + w[2])) + 2 - x, h: Math.max(...ws.map((w) => w[1] + w[3])) + 2 - y }, words: doc.words.slice(...doc.sent[k]) };
  }, s);
  const area = () => areaOf(k);
  const readArea = async (rect) => {
    await page.evaluate((rect) => { const ed = window.aef.editor; ed.readArea(window.aef.views[0], rect, ed.sel); }, rect);
    await page.waitForSelector('.ocr-preview .ocr-preview-line', { timeout: 5000 });
  };

  // 1. Replacing what was read wrongly: the new text takes the old one's number.
  const { rect, words } = await area();
  read = words.map((w, i) => (i === 0 ? [...w.slice(0, 4), 'Fixed', ...w.slice(5)] : w));
  await readArea(rect);
  assert.equal(await page.$eval('.ocr-replace', (c) => c.checked), true, '(replacing: there is text in the area)');
  await page.click('.ocr-preview .btn.primary');
  await saved();
  const fixed = [...made];
  fixed[k] = made[k].replace(/^\S+/, 'Fixed');
  assert.deepEqual(await sentences(), fixed, `sentence ${k + 1} read again: in its place, the others' numbers as before`);
  assert.deepEqual(await numbers(), made.map((_, i) => i + 1), 'numbered one after the other');
  console.log(`PASS: replacing the text of an area: the new sentence keeps number ${k + 1}, in the middle of its paragraph`);

  // 2. Adding what was missed (nothing there now): it goes back between its neighbours on the page.
  await page.evaluate((k) => { const ed = window.aef.editor, v = window.aef.views[0]; ed.run('delete', undefined, ed.selAt(v, v.doc.sent[k][0])); }, k);
  await saved();
  assert.equal((await sentences()).length, made.length - 1);
  await page.evaluate(() => { const ed = window.aef.editor, v = window.aef.views[0]; ed.sel = ed.selAt(v, v.doc.sent[0][0]); }); // (another sentence selected: not where it goes)
  read = words;
  await readArea(rect);
  assert.equal(await page.$eval('.ocr-replace', (c) => c.checked), false, '(adding: nothing in the area)');
  await page.click('.ocr-preview .btn.primary');
  await saved();
  assert.deepEqual(await sentences(), made, `the missed sentence back as number ${k + 1}, the ones after it numbered on`);
  assert.deepEqual(await numbers(), made.map((_, i) => i + 1), 'numbered one after the other');
  console.log(`PASS: adding a missed sentence by area: it goes back as number ${k + 1} (not after the selected sentence), the rest numbered on`);

  // 3. The handles of a sentence's frame let go: what is in the new frame is read, to use or not.
  const select = () => page.evaluate((k) => { const ed = window.aef.editor, v = window.aef.views[0]; ed.sel = ed.selAt(v, v.doc.sent[k][0]); ed.render(); }, k);
  const drag = async (px) => {
    const h = await page.$eval('.sent-frame .fh-e', (e) => { e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.mouse.move(h.x, h.y);
    await page.mouse.down();
    await page.mouse.move(h.x + px / 2, h.y, { steps: 3 });
    await page.mouse.move(h.x + px, h.y, { steps: 3 });
    await page.mouse.up();
  };
  const toastText = () => page.$eval('#toast', (t) => t.textContent);
  await select();
  const last = words.at(-1);
  read = words; // the same text there: nothing to review
  await drag(12);
  await page.waitForFunction(() => /read again in its new size/.test(document.querySelector('#toast')?.textContent), { timeout: 5000 });
  assert.match(await toastText(), new RegExp(`^Sentence ${k + 1} read again in its new size: the same text\\.`));
  assert.equal(await page.$('.ocr-preview'), null, '(nothing to review)');
  // A word more in the new frame (as "(2)" before a sentence): offered, then used.
  await select();
  read = [...words, [last[0] + last[2] + 4, last[1], 20, last[3], 'Extra', last[5], 1]];
  await drag(20);
  await page.waitForSelector('.ocr-preview .ocr-now', { timeout: 5000 });
  const offer = await page.evaluate(() => ({
    title: document.querySelector('.ocr-preview h4').textContent, now: document.querySelector('.ocr-now').textContent,
    rows: [...document.querySelectorAll('.ocr-preview-line textarea')].map((t) => t.value),
    buttons: [...document.querySelectorAll('.ocr-preview-actions .btn')].map((b) => b.textContent),
  }));
  assert.deepEqual(offer, { title: `Sentence ${k + 1} read again in its new size`, now: `Now: ${made[k]}`, rows: [`${made[k]} Extra`],
    buttons: ['Use the new text', 'Keep the text as it is'] });
  await page.click('.ocr-preview .btn.primary');
  await saved();
  const longer = [...made];
  longer[k] = `${made[k]} Extra`;
  assert.deepEqual(await sentences(), longer, `sentence ${k + 1} has the words of its new frame, in its place`);
  assert.deepEqual(await numbers(), made.map((_, i) => i + 1), 'numbered one after the other');
  // Kept: the text stays.
  await select();
  read = [...words, [last[0] + last[2] + 4, last[1], 20, last[3], 'Other', last[5], 1]];
  await drag(8);
  await page.waitForSelector('.ocr-preview .ocr-now', { timeout: 5000 });
  await page.evaluate(() => [...document.querySelectorAll('.ocr-preview-actions .btn')].find((b) => b.textContent === 'Keep the text as it is').click());
  await saved();
  assert.deepEqual(await sentences(), longer, 'kept: the text as it was');
  console.log(`PASS: a sentence's frame changed: its new frame read again; the same text: nothing to do; else used (sentence ${k + 1}, its number kept) or kept`);

  // 4. Paragraphs read in the area (the rows of a list of new words: its word, then its meaning): as read.
  const now = await area();
  const four = now.words.slice(0, 4).map((w, i) => [...w.slice(0, 4), ['One', 'Two', 'Three', 'Four'][i], 0, 1]);
  found = { words: four, sent: [[0, 1], [1, 2], [2, 3], [3, 4]], clause: [[0, 1], [1, 2], [2, 3], [3, 4]], blocks: [[0, 2], [2, 4]] };
  await readArea(now.rect);
  await page.click('.ocr-preview .btn.primary');
  await saved();
  const listed = [...longer.slice(0, k), 'One', 'Two', 'Three', 'Four', ...longer.slice(k + 1)];
  assert.deepEqual(await sentences(), listed, `the rows in the place of sentence ${k + 1}`);
  const blocks = await page.evaluate(() => window.aef.views[0].doc.blocks);
  assert.ok(blocks.some(([a, b]) => a === k && b === k + 2) && blocks.some(([a, b]) => a === k + 2 && b === k + 4),
    `a paragraph each, as read: ${JSON.stringify(blocks)}`);
  assert.deepEqual(await numbers(), listed.map((_, i) => i + 1), 'numbered one after the other');
  console.log(`PASS: paragraphs read in an area (a list's rows) stay paragraphs, as sentences ${k + 1}-${k + 4}`);
  // Added where there is nothing now (deleted): the same.
  for (let i = 0; i < 4; i++) {
    await page.evaluate((k) => { const ed = window.aef.editor, v = window.aef.views[0]; ed.run('delete', undefined, ed.selAt(v, v.doc.sent[k][0])); }, k);
    await saved();
  }
  await readArea(now.rect);
  assert.equal(await page.$eval('.ocr-replace', (c) => c.checked), false, '(adding: nothing in the area)');
  await page.click('.ocr-preview .btn.primary');
  await saved();
  assert.deepEqual(await sentences(), listed, 'added back in their place');
  const again = await page.evaluate(() => window.aef.views[0].doc.blocks);
  assert.ok(again.some(([a, b]) => a === k && b === k + 2) && again.some(([a, b]) => a === k + 2 && b === k + 4),
    `a paragraph each, as read: ${JSON.stringify(again)}`);
  console.log('PASS: paragraphs added where there was nothing: each where it is on the page, a paragraph as read');

  // 5. Several areas, drawn one after the other with "Re-read text by area", read at once.
  found = null;
  const [k1, k2] = (await alone(false)).filter((s) => s < k || s > k + 3);
  assert.ok(k2 > k1, 'two more sentences alone in their areas');
  const [a1, a2] = [await areaOf(k1), await areaOf(k2)];
  const before = await sentences();
  byArea = [{ rect: a1.rect, words: [[...a1.words[0].slice(0, 4), 'Alpha', ...a1.words[0].slice(5)], ...a1.words.slice(1)] },
    { rect: a2.rect, words: [[...a2.words[0].slice(0, 4), 'Beta', ...a2.words[0].slice(5)], ...a2.words.slice(1)] }];
  const drawBox = async (r) => { // with the mouse, on the page (scrolled to the box first)
    const at = await page.evaluate((r) => {
      const v = window.aef.views[0], spot = document.createElement('div');
      Object.assign(spot.style, { position: 'absolute', left: `${(100 * r.x) / v.W}%`, top: `${(100 * r.y) / v.H}%`, width: '1px', height: `${(100 * r.h) / v.H}%` });
      v.el.append(spot);
      spot.scrollIntoView({ block: 'center' });
      spot.remove();
      const b = v.el.getBoundingClientRect(), sx = b.width / v.W, sy = b.height / v.H;
      return { x0: b.left + r.x * sx, y0: b.top + r.y * sy, x1: b.left + (r.x + r.w) * sx, y1: b.top + (r.y + r.h) * sy };
    }, r);
    await page.mouse.move(at.x0, at.y0);
    await page.mouse.down();
    await page.mouse.move((at.x0 + at.x1) / 2, (at.y0 + at.y1) / 2, { steps: 3 });
    await page.mouse.move(at.x1, at.y1, { steps: 3 });
    await page.mouse.up();
  };
  const panel = () => page.evaluate(() => ({ areas: document.querySelectorAll('.read-areas-panel .order-list li').length,
    read: document.querySelector('.read-areas-panel [data-op="ocr-read"]')?.textContent, onPage: document.querySelectorAll('.order-areas rect').length }));
  await page.setViewport({ width: 1500, height: 620 }); // (a low screen: the review is taller than the panel)
  await page.evaluate(() => [...document.querySelectorAll('[data-op="ocr"]')].find((b) => b.offsetParent).click());
  await drawBox(a1.rect);
  await drawBox(a2.rect);
  assert.deepEqual(await panel(), { areas: 2, read: 'Read the 2 areas', onPage: 2 }, 'two boxes drawn, numbered on the page');
  await page.click('.read-areas-panel [data-op="ocr-back"]');
  assert.deepEqual(await panel(), { areas: 1, read: 'Read the area', onPage: 1 }, 'the last one taken back');
  await drawBox(a2.rect);
  assert.equal((await panel()).areas, 2);
  await page.keyboard.press('Enter'); // (reads them)
  await page.waitForSelector('.ocr-preview .ocr-area', { timeout: 5000 });
  const review = await page.evaluate(() => ({
    title: document.querySelector('.ocr-preview h4').textContent,
    areas: [...document.querySelectorAll('.ocr-area')].map((a) => ({ head: a.querySelector('h5').textContent,
      rows: [...a.querySelectorAll('.ocr-preview-line textarea')].map((t) => t.value.split(' ')[0]), replace: a.querySelector('.ocr-replace').checked })),
    onPage: document.querySelectorAll('.order-areas rect').length,
  }));
  assert.deepEqual(review, { title: 'Review the text found in 2 areas (2 sentences)', onPage: 2, areas: [
    { head: 'Area 1: 1 sentence', rows: ['Alpha'], replace: true }, { head: 'Area 2: 1 sentence', rows: ['Beta'], replace: true }] });
  await sleep(300);
  const button = await page.evaluate(() => { // in view in the panel, under the bar at its top
    const body = document.querySelector('#text-view').closest('.tab-body'), btn = document.querySelector('.ocr-preview .btn.primary');
    const bar = body.querySelector('.panel-actions:not([hidden])'), b = btn.getBoundingClientRect(), p = body.getBoundingClientRect();
    return { text: btn.textContent, taller: document.querySelector('.ocr-preview').offsetHeight > body.clientHeight - (bar?.offsetHeight || 0),
      inView: b.top >= (bar ? bar.getBoundingClientRect().bottom : p.top) && b.bottom <= p.bottom };
  });
  assert.deepEqual(button, { text: 'Add selected sentences', taller: true, inView: true }, 'scrolled down to its button');
  await page.setViewport({ width: 1500, height: 950 });
  await page.click('.ocr-preview .btn.primary');
  await saved();
  const both = [...before];
  both[k1] = before[k1].replace(/^\S+/, 'Alpha');
  both[k2] = before[k2].replace(/^\S+/, 'Beta');
  assert.deepEqual(await sentences(), both, `sentences ${k1 + 1} and ${k2 + 1} read again, each in its place`);
  assert.deepEqual(await numbers(), both.map((_, i) => i + 1), 'numbered one after the other');
  assert.equal(await page.$$eval('.order-areas rect', (r) => r.length), 0, '(the areas gone from the page)');
  await page.evaluate(() => window.aef.editor.undo());
  await saved();
  assert.deepEqual(await sentences(), before, 'one Undo takes back both');
  console.log(`PASS: several areas drawn one after the other (one taken back), read at once (Enter), reviewed each (the panel scrolled down to "Add selected sentences"), used each in its place (${k1 + 1}, ${k2 + 1}); one Undo`);

  // 6. The sentences found, on the page in their colors while they are reviewed; more areas drawn
  // from the review, what was changed in it kept; all added at once.
  const k3 = (await alone(false)).filter((s) => (s < k || s > k + 3) && s !== k1 && s !== k2)[0];
  assert.ok(k3 >= 0, 'a third sentence alone in its area');
  const a3 = await areaOf(k3);
  byArea.push({ rect: a3.rect, words: [[...a3.words[0].slice(0, 4), 'Gamma', ...a3.words[0].slice(5)], ...a3.words.slice(1)] });
  const onPage = () => page.evaluate(() => [...document.querySelectorAll('.found-outlines g')].map((g) => ({
    n: g.querySelector('text').textContent, color: g.style.getPropertyValue('--c'), off: g.classList.contains('off') })));
  const rowOf = (n) => `.ocr-preview-line[data-k="${n}"]`;
  await page.evaluate(() => [...document.querySelectorAll('[data-op="ocr"]')].find((b) => b.offsetParent).click());
  await drawBox(a1.rect);
  await drawBox(a2.rect);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.ocr-preview .ocr-area', { timeout: 5000 });
  const colors = await onPage();
  assert.deepEqual(colors.map((c) => [c.n, c.off]), [['1', false], ['2', false]], 'each sentence found outlined on the page, numbered as in the review');
  assert.ok(colors[0].color && colors[0].color !== colors[1].color, 'in colors of their own');
  assert.equal(await page.$eval(`${rowOf(0)} .ocr-n`, (n) => n.style.getPropertyValue('--c')), colors[0].color, '(its number in the review, in the same color)');
  await page.click(`${rowOf(1)} input`);
  assert.deepEqual((await onPage()).map((c) => c.off), [false, true], 'unticked: grey on the page');
  await page.$eval(`${rowOf(0)} textarea`, (t) => { t.value = 'Alpha changed in the review'; t.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('.ocr-preview [data-op="ocr-more"]');
  assert.deepEqual(await page.evaluate(() => ({ title: document.querySelector('.read-areas-panel h4').textContent,
    back: document.querySelector('.read-areas-panel [data-op="ocr-cancel"]').textContent })),
  { title: 'Re-read text by area: more areas', back: 'Back to the review' });
  assert.deepEqual((await onPage()).map((c) => c.off), [false, true], 'what was found stays on the page while more are drawn');
  await drawBox(a3.rect);
  assert.equal(await page.$$eval('.order-areas rect', (r) => r.length), 3, '(the new area numbered after the others)');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.ocr-area').length === 3, { timeout: 5000 });
  const kept = await page.evaluate(() => [...document.querySelectorAll('.ocr-preview-line[data-k]')].map((r) => [r.querySelector('textarea').value.split(' ')[0], r.querySelector('input').checked]));
  assert.deepEqual(kept, [['Alpha', true], ['Beta', false], ['Gamma', true]], 'the review goes on with the new area, as it was changed');
  assert.equal(await page.$eval(`${rowOf(0)} textarea`, (t) => t.value), 'Alpha changed in the review');
  assert.equal((await onPage()).length, 3);
  await page.click(`${rowOf(1)} input`); // (ticked again)
  await page.click('.ocr-preview .btn.primary');
  await saved();
  const three = [...before];
  three[k1] = 'Alpha changed in the review';
  three[k2] = before[k2].replace(/^\S+/, 'Beta');
  three[k3] = before[k3].replace(/^\S+/, 'Gamma');
  assert.deepEqual(await sentences(), three, `sentences ${k1 + 1}, ${k2 + 1} and ${k3 + 1} read again`);
  assert.equal(await page.$$eval('.found-outlines g', (g) => g.length), 0, '(gone from the page when used)');
  console.log('PASS: the sentences found are on the page in their colors (unticked: grey) while reviewed; more areas drawn from the review are added to it, its changes kept; all used at once');
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await stopServer(server);
}

// The designs of a book's pages (web/designs.py, js/designs.js): a PDF of 6 pages in two designs
// (pages of dialogues, pages of text). The first sample is a page of each, with the areas the app
// read on it as frames, numbered in their order (a dialogue without "A:", a list of new words).
// The owner changes them for the whole design (an area not read, a new one drawn, one removed, a
// page with no design), saves, the sample is read again so; then all the pages are made so.
// Run: node web/tests/designs-test.mjs
import assert from 'node:assert/strict';

process.env.PORT ||= '8826';
const { startServer, stopServer, openBrowser, sleep } = await import('./harness.mjs');
const BASE = `http://127.0.0.1:${process.env.PORT}/web/`;

/** A PDF of these pages, each [[x, y, size, text], …] (Helvetica; y from the bottom, of 792). */
function makePdf(pages) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (const items of pages) {
    const content = items.map(([x, y, size, t]) => `BT /F1 ${size} Tf ${x} ${y} Td (${t}) Tj ET`).join('\n');
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${objs.length} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    kids.push(`${objs.length} 0 R`);
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;
  let pdf = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => { const at = pdf.length; pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const PLACES = ['the park', 'the shop', 'school'];
const dialogue = (k) => [[60, 720, 18, `A: Where are you going, Tom ${k}?`], [60, 696, 18, `B: I am going to ${PLACES[k]}.`],
  [60, 672, 18, 'A: Can I come with you?'], [60, 648, 18, 'B: Yes, of course you can.'],
  [380, 720, 16, 'New Words'], [380, 698, 14, 'park  a green place'], [380, 680, 14, 'shop  a place to buy'], [380, 662, 14, 'come  to move here'],
  [60, 300, 16, `Read the dialogue ${k} again and answer the questions.`], [60, 280, 16, 'Then talk about it with a friend.']];
const text = (k) => [[160, 740, 30, `Grammar note ${k}`],
  ...Array.from({ length: 12 }, (_, i) => [60, 690 - i * 26, 15, `Line ${i + 1} of the grammar text, about verbs and their forms ${k}.`])];
const PDF = makePdf([dialogue(0), text(0), dialogue(1), text(1), dialogue(2), text(2)]);

const server = await startServer();
const { browser, page } = await openBrowser({ width: 1400, height: 1000 });
const errors = [];
const api = (method, url, body) => page.evaluate(async (m, u, b) => {
  const r = await fetch(u, { method: m, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}, method, url, body);
const waitSample = async (id) => {
  for (let i = 0; i < 200; i++) {
    const s = await api('GET', `/api/books/${id}/preview`);
    if (s.data?.state !== 'working') return s.data;
    await sleep(300);
  }
  throw new Error('the sample was not made');
};
const editor = () => page.evaluate(() => ({
  tabs: [...document.querySelectorAll('.design-tabs button')].map((b) => b.textContent),
  on: document.querySelector('.design-tabs [aria-selected="true"]')?.textContent,
  rows: [...document.querySelectorAll('.design-area')].map((li) => `${li.querySelector('.n').textContent}:${li.querySelector('select').value}`),
  frames: document.querySelectorAll('.design-editor svg .frame').length,
  page: document.querySelector('.design-side h4')?.textContent,
}));
try {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  const book = (await api('POST', '/api/books', { kind: 'pdf', title: 'Two designs', importOptions: { language: 'en' } })).data;
  await page.evaluate(async (u, bytes) => { await fetch(u, { method: 'PUT', body: new Uint8Array(bytes) }); }, `/api/books/${book.id}/source/pdf`, [...PDF]);
  await api('POST', `/api/books/${book.id}/preview`, { options: { language: 'en' } });
  let sample = await waitSample(book.id);
  const info = (await api('GET', `/api/books/${book.id}/designs`)).data;
  assert.equal(sample.state, 'ready', JSON.stringify(sample));
  assert.deepEqual(info.designs.map((d) => d.pages), [[1, 3, 5], [2, 4, 6]], 'the dialogue pages, the text pages');
  assert.deepEqual(info.other, []);
  const one = sample.pages.find((p) => p.n === info.designs[0].example);
  assert.ok(one && one.design === 0, 'the example of the first design is in the sample');
  assert.deepEqual(new Set(one.areas.map((a) => a.kind)), new Set(['dialogue', 'words', 'text']), JSON.stringify(one.areas));
  assert.ok(sample.pages.find((p) => p.n === info.designs[1].example), 'the example of the second design too');
  // Its areas suggested on every page of the sample; not used until the owner checks them: read whole, as before.
  assert.ok(sample.pages.every((p) => p.design != null && p.areas.length && !p.framed), JSON.stringify(sample.pages));
  assert.equal(sample.checked, false);
  assert.match(one.text, /A: Where are you going, Tom/);

  // The check of the sample: the designs, the frames on the pages.
  await page.goto('about:blank');
  await page.goto(`${BASE}#/`, { waitUntil: 'networkidle0' });
  await page.click('#library [data-scope="mine"]'); // (an unfinished book: in My books)
  await page.waitForSelector(`.book-card[data-id="${book.id}"] .bc-cover`, { timeout: 10000 });
  await page.click(`.book-card[data-id="${book.id}"] .bc-cover`);
  await page.waitForSelector('.sample-review .design-note', { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll('.sample-page svg.framed .frame').length > 0, { timeout: 10000 });
  assert.match(await page.$eval('.design-note h4', (h) => h.textContent), /found 2 designs/);
  assert.match(await page.$eval('.design-note p', (p) => p.textContent), /Until then every page is read whole/);

  // The editor: the first design's example, its areas in their order.
  await page.click('.design-note .btn');
  await page.waitForSelector('.design-editor', { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll('.design-editor svg .frame').length > 0, { timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector('.design-editor .btn.primary').disabled);
  await page.select('[aria-label="Layout editing scope"]', 'design');
  let e = await editor();
  assert.deepEqual(e.tabs, ['Design 1 · 3 pages', 'Design 2 · 3 pages']);
  assert.equal(e.on, 'Design 1 · 3 pages');
  assert.equal(e.frames, e.rows.length);
  const kinds = e.rows.map((r) => r.split(':')[1]);
  const below = await page.evaluate(() => { // (the area of the text under the dialogue: the lowest)
    const rects = [...document.querySelectorAll('.design-editor svg .frame rect')].map((r) => +r.getAttribute('y'));
    return rects.indexOf(Math.max(...rects));
  });
  assert.equal(kinds[below], 'text');
  // It is not read: on every page of the design.
  await page.select(`.design-area:nth-child(${below + 1}) select`, 'skip');
  e = await editor();
  assert.equal(e.rows[below], '×:skip');
  // A new area drawn on the page (where there is none), then removed with the Delete key.
  const box = await page.$eval('.design-editor svg.framed', (s) => { const b = s.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  await page.mouse.move(box.x + box.w * 0.55, box.y + box.h * 0.82);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w * 0.7, box.y + box.h * 0.88, { steps: 5 });
  await page.mouse.move(box.x + box.w * 0.9, box.y + box.h * 0.95, { steps: 5 });
  await page.mouse.up();
  e = await editor();
  assert.equal(e.rows.length, kinds.length + 1, 'drawn');
  assert.match(e.rows.at(-1), /:text$/);
  await page.keyboard.press('Delete');
  e = await editor();
  assert.equal(e.rows.length, kinds.length, 'removed');
  // The order: the last area read earlier.
  const order = e.rows.map((r) => r.split(':')[1]);
  await page.click(`.design-area:nth-child(${order.length}) button[aria-label="Read it earlier"]`);
  e = await editor();
  const moved = [...order.slice(0, -2), order.at(-1), order.at(-2)];
  assert.deepEqual(e.rows.map((r) => r.split(':')[1]), moved);
  // Another page of the design: the same frames. Page 5: no design (read whole).
  await page.click('.design-thumb[title="Page 3"]');
  await sleep(200);
  e = await editor();
  assert.equal(e.page, 'Page 3');
  assert.equal(e.frames, order.length);
  await page.click('.design-thumb[title="Page 5"]');
  await page.select('.design-side select', 'none');
  e = await editor();
  assert.deepEqual(e.tabs, ['Design 1 · 2 pages', 'Design 2 · 3 pages', 'No design · 1']);
  assert.equal(e.frames, 0);
  // Saved: the sample is read again so.
  await page.waitForFunction(() => !document.querySelector('.design-editor .btn.primary').disabled);
  await page.click('.design-editor .btn.primary');
  await page.waitForSelector('.sample-review .design-note', { timeout: 60000 });
  sample = (await api('GET', `/api/books/${book.id}/preview`)).data;
  const after = (await api('GET', `/api/books/${book.id}/designs`)).data;
  assert.deepEqual(after.designs.map((d) => d.pages), [[1, 3], [2, 4, 6]]);
  assert.deepEqual(after.other, [5]);
  assert.deepEqual(after.designs[0].areas.map((a) => a.kind), moved);
  const again = sample.pages.find((p) => p.n === after.designs[0].example);
  assert.ok(sample.checked && again.framed, 'used now');
  assert.match(again.text, /Where are you going/);
  assert.doesNotMatch(again.text, /\bA:|\bB:/, 'the dialogue without the speakers’ names');
  assert.doesNotMatch(again.text, /Read the dialogue/, 'the area not read');

  // All the pages: those of the design read by its areas; page 5 (no design) whole.
  await page.click('.sample-review .btn.primary');
  await page.waitForFunction(() => location.hash.startsWith('#/L'), { timeout: 60000 });
  const pageText = async (n) => {
    const d = (await api('GET', `/api/text/${book.id}/p${n}`)).data;
    return d.sent.map(([a, b]) => d.words.slice(a, b).map((w) => w[4]).join(' ')).join(' | ');
  };
  const three = await pageText(3);
  assert.match(three, /Where are you going, Tom 1/);
  assert.doesNotMatch(three, /Read the dialogue|\bA:/, 'page 3: as its design says');
  assert.match(await pageText(5), /Read the dialogue 2 again/, 'page 5: whole');
  assert.match(await pageText(4), /Grammar note 1/);
  assert.deepEqual(errors, []);
  console.log('designs-test: PASS');
} catch (err) {
  console.error('designs-test: FAIL', err);
  process.exitCode = 1;
} finally {
  await browser.close();
  await stopServer(server);
}

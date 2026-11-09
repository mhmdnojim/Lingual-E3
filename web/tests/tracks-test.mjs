// A book's audio and video (web/tracks.py, Settings → Audio and video): recordings added (only audio
// and video of the files chosen), each with a play button where its number is printed on the pages
// ("1.26 Watch or listen…" → …_1.26.mp3), served to the reader; the ones on no page told; in correction
// mode (Play buttons) one moved off its number, one taken away, one put by hand where the page is
// clicked (a recording on no page); all taken out.
// Run: node web/tests/tracks-test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PORT ||= '8834';
const { startServer, stopServer, openBrowser, sleep } = await import('./harness.mjs');
const BASE = `http://127.0.0.1:${process.env.PORT}/web/`;

function makePdf(lines) {
  const content = `BT /F1 22 Tf 30 TL 72 700 Td ${lines.map((l) => `(${l}) Tj T*`).join(' ')} ET`;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => { const at = pdf.length; pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'lb-tracks-'));
const files = ['AEF_SB_1.26.mp3', 'AEF_SB_1.27.mp3', 'AEF_SB_9.99.mp3', 'readme.txt'].map((n) => {
  const p = path.join(tmp, n);
  writeFileSync(p, Buffer.from(`ID3 ${n}`));
  return p;
});
const server = await startServer();
const { browser, page } = await openBrowser();
const errors = [];
const api = (method, url) => page.evaluate(async (m, u) => { const r = await fetch(u, { method: m }); return { status: r.status, data: await r.json().catch(() => null) }; }, method, url);
const state = () => page.$eval('.media-box p[aria-live]', (p) => p.textContent);
try {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  const book = await page.evaluate(async (pdf) => {
    const b = await (await fetch('/api/books', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'pdf', title: 'With audio', importOptions: { language: 'en' } }) })).json();
    await fetch(`/api/books/${b.id}/source/pdf`, { method: 'PUT', body: new Uint8Array(pdf) });
    await fetch(`/api/books/${b.id}/make`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language: 'en' }) });
    return b;
  }, [...makePdf(['1.26 Watch or listen to Jenny.', 'Then listen again, 1.27, and check.'])]);
  for (let i = 0; i < 100 && (await api('GET', `/api/books/${book.id}/job`)).data.status !== 'ready'; i++) await sleep(300);

  // Settings → Audio and video: the files (only the audio).
  await page.goto(`${BASE}#/${book.id}/1`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('.page-img')?.complete, { timeout: 15000 });
  await page.evaluate(async (id) => window.aef.library.settings(await (await fetch(`/api/books/${id}`)).json()), book.id);
  await page.waitForFunction(() => /None yet/.test(document.querySelector('.media-box p[aria-live]')?.textContent), { timeout: 5000 });
  await (await page.$('.media-box input[accept]')).uploadFile(...files);
  await page.waitForFunction(() => /with a play button/.test(document.querySelector('.media-box p[aria-live]').textContent), { timeout: 20000 });
  assert.match(await state(), /^3 recordings \(0 MB\): 2 with a play button on their page\. Not found on a page: AEF_SB_9\.99\.mp3\.$/);
  const full = (await api('GET', `/api/books/${book.id}`)).data;
  const spots = full.pages[0].a;
  assert.deepEqual(spots.map((a) => [a.t, a.title]), [['audio', 'Track 1.26'], ['audio', 'Track 1.27']]);
  const played = await page.evaluate(async (src) => { const r = await fetch(src); return [r.status, await r.text()]; }, spots[0].src);
  assert.deepEqual(played, [200, 'ID3 AEF_SB_1.26.mp3'], 'served to the reader');
  await page.click('#md-close');
  await page.waitForFunction(() => document.querySelectorAll('.page .hs-audio').length === 2, { timeout: 10000 });

  // Correction mode → Play buttons.
  const now = async () => (await api('GET', `/api/books/${book.id}`)).data.pages[0].a;
  const middle = (i) => page.$$eval('.page .hs-audio', (b, k) => { const r = b[k].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, i);
  await page.click('.panel [role=tab][data-tab="text"]');
  await page.click('#edit-text');
  await page.waitForFunction(() => !document.querySelector('#edit-bulk [data-op="buttons"]').hidden, { timeout: 5000 });
  await page.click('#edit-bulk [data-op="buttons"]');
  await page.waitForFunction(() => document.querySelectorAll('.page .hs-audio .hs-x').length === 2, { timeout: 5000 });
  // Its buttons right under the tools at the top of the panel: in sight also when the sentences are scrolled.
  const inSight = () => page.evaluate(() => {
    document.querySelector('.tab-body[data-tab="text"]').scrollTop = 1e6;
    const add = [...document.querySelectorAll('#edit-actions #pb-bar button')].find((b) => b.textContent === 'Add a play button…');
    const r = add?.getBoundingClientRect(), panel = document.querySelector('.tab-body[data-tab="text"]').getBoundingClientRect();
    return !!r && r.top >= panel.top && r.bottom <= panel.bottom;
  });
  assert.ok(await inSight(), 'Add a play button… in sight');
  // Moved (dragged off the number it covers): kept there, as put by hand.
  const before = (await now()).find((a) => a.title === 'Track 1.26');
  let m = await middle(0);
  await page.mouse.move(m.x, m.y);
  await page.mouse.down();
  await page.mouse.move(m.x + 40, m.y + 30, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(async (id) => (await (await fetch(`/api/books/${id}`)).json()).pages[0].a.some((a) => a.title === 'Track 1.26' && a.manual), { timeout: 5000 }, book.id);
  const after = (await now()).find((a) => a.title === 'Track 1.26');
  assert.ok(after.x > before.x + 20 && after.y > before.y + 15, `moved: ${JSON.stringify([before.x, before.y, after.x, after.y])}`);
  assert.equal(await page.$$eval('.page .hs-audio', (b) => b.length), 2);
  // Taken away (put in a wrong place): its ×.
  await page.evaluate(() => [...document.querySelectorAll('.page .hs-audio')].find((b) => b.title === 'Track 1.27').querySelector('.hs-x').click());
  await page.waitForFunction(() => document.querySelectorAll('.page .hs-audio').length === 1, { timeout: 5000 });
  assert.deepEqual((await now()).map((a) => a.title), ['Track 1.26']);
  // Put by hand: a recording on no page, chosen, then where the page is clicked.
  await page.evaluate(() => [...document.querySelectorAll('#pb-bar button')].find((b) => b.textContent === 'Add a play button…').click());
  await page.waitForFunction(() => document.querySelectorAll('.pb-item').length === 3, { timeout: 5000 });
  assert.deepEqual(await page.$$eval('.pb-item', (b) => b.map((x) => x.querySelector('b').textContent)), ['Track 1.27', 'Track 9.99', 'Track 1.26'], 'those on no page first');
  await page.type('.pb-chooser input[type=search]', '9.99');
  await page.waitForFunction(() => document.querySelectorAll('.pb-item').length === 1, { timeout: 5000 });
  await page.click('.pb-item');
  await page.waitForFunction(() => /Click on the page where the button of “Track 9\.99” goes/.test(document.querySelector('#pb-bar')?.textContent || ''), { timeout: 5000 });
  const spotAt = await page.evaluate(() => { const v = window.aef.views[0], r = v.el.getBoundingClientRect(); return { x: r.x + r.width * 0.5, y: r.y + r.height * 0.6, W: v.W, H: v.H }; });
  await page.mouse.click(spotAt.x, spotAt.y);
  await page.waitForFunction(() => document.querySelectorAll('.page .hs-audio').length === 2, { timeout: 5000 });
  const put = (await now()).find((a) => a.title === 'Track 9.99');
  assert.ok(put.manual && Math.abs(put.x - spotAt.W * 0.5) < 20 && Math.abs(put.y - spotAt.H * 0.6) < 40, `put where clicked: ${JSON.stringify(put)}`);
  assert.equal((await api('GET', `/api/books/${book.id}/tracks`)).data.unplaced.join(), 'AEF_SB_1.27.mp3');
  // Placed again (as after adding more files): what was changed by hand stays.
  await api('POST', `/api/books/${book.id}/tracks/place`);
  assert.deepEqual((await now()).map((a) => [a.title, a.x, a.y]).sort(), [['Track 1.26', after.x, after.y], ['Track 9.99', put.x, put.y]]);
  // Done: they play again (no × any more).
  await page.evaluate(() => [...document.querySelectorAll('#pb-bar button')].find((b) => b.textContent === 'Done with play buttons').click());
  await page.waitForFunction(() => !document.querySelector('.page .hs-x') && document.querySelector('#pb-bar').hidden, { timeout: 5000 });
  await page.click('#edit-done');

  // All taken out: no buttons.
  await page.evaluate(async (id) => window.aef.library.settings(await (await fetch(`/api/books/${id}`)).json()), book.id);
  await page.waitForFunction(() => /3 recordings/.test(document.querySelector('.media-box p[aria-live]')?.textContent), { timeout: 5000 });
  assert.match(await state(), /: 2 with a play button on their page\. Not found on a page: AEF_SB_1\.27\.mp3\.$/);
  await page.evaluate(() => [...document.querySelectorAll('.media-box button')].find((b) => b.textContent === 'Take them all out').click());
  await page.waitForFunction(() => /None yet/.test(document.querySelector('.media-box p[aria-live]').textContent), { timeout: 5000 });
  assert.deepEqual((await api('GET', `/api/books/${book.id}`)).data.pages[0].a, []);
  assert.deepEqual(errors, []);
  console.log('tracks-test: PASS');
} catch (err) {
  console.error('tracks-test: FAIL', err);
  process.exitCode = 1;
} finally {
  await browser.close();
  await stopServer(server);
  rmSync(tmp, { recursive: true, force: true });
}

// Replacing a picture on a page (js/pictures.js, web/pictures.py): in correction mode, a box drawn
// around a picture of a PDF book; a picture of one's own replaces it on the page and in the PDF
// (downloaded from Settings); then one made by an AI image service (a stand-in here: its key saved
// first, by the admin); each taken back. The disc's books do not have the tool.
// Run: node web/tests/picture-test.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

process.env.PORT ||= '8831';
const { startServer, stopServer, openBrowser, sleep } = await import('./harness.mjs');
const BASE = `http://127.0.0.1:${process.env.PORT}/web/`;

/** A PDF page with a red picture (100-300 across, 500-600 from the bottom) and a line of text under it. */
function makePdf() {
  const px = Buffer.alloc(20 * 10 * 3);
  for (let i = 0; i < px.length; i += 3) px.set([220, 30, 30], i);
  const content = 'q 200 0 0 100 100 500 cm /Im1 Do Q BT /F1 22 Tf 72 300 Td (A sentence under the picture.) Tj ET';
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Type /XObject /Subtype /Image /Width 20 /Height 10 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${px.length} >>\nstream\n${px.toString('latin1')}\nendstream`];
  let pdf = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => { const at = pdf.length; pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** A PNG of one colour (w × h). */
function png(w, h, [r, g, b]) {
  const crc = (buf) => { let c = ~0; for (const x of buf) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length); b.write(type, 4, 'latin1'); data.copy(b, 8); b.writeUInt32BE(crc(b.subarray(4, 8 + data.length)), 8 + data.length); return b; };
  const head = Buffer.alloc(13); head.writeUInt32BE(w); head.writeUInt32BE(h, 4); head.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows.set([r, g, b], y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

// The stand-in of the AI image service: for the right key, a green picture, then a yellow one.
const asked = [];
const colours = [[30, 180, 60], [230, 200, 40]];
let made = 0;
const ai = createServer((req, res) => {
  let body = '';
  req.setEncoding('latin1');
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    asked.push({ url: req.url, key: req.headers.authorization, body });
    const ok = req.headers.authorization === 'Bearer test-key';
    res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? { data: [{ b64_json: png(64, 32, colours[made++ % 2]).toString('base64') }] } : { error: { message: 'bad key' } }));
  });
});
await new Promise((ok) => ai.listen(0, '127.0.0.1', ok));

const tmp = mkdtempSync(path.join(os.tmpdir(), 'lb-pic-'));
const blue = path.join(tmp, 'blue.png');
writeFileSync(blue, png(300, 150, [30, 60, 220]));
const server = await startServer({ env: { LB_IMAGE_API: `http://127.0.0.1:${ai.address().port}` } });
const { browser, page } = await openBrowser({ width: 1400, height: 1000 });
const errors = [];
const api = (method, url, body) => page.evaluate(async (m, u, b) => {
  const r = await fetch(u, { method: m, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}, method, url, body);
/** The colour of the page picture (as served now) in the middle of the box, and the page's text. */
const look = (id, box) => page.evaluate(async (bid, b) => {
  const book = await (await fetch(`/api/books/${bid}`, { cache: 'no-store' })).json();
  const img = new Image();
  img.src = book.pages[0].img;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = await (await fetch(`/api/text/${bid}/p1`, { cache: 'no-store' })).json();
  return { color: [...g.getImageData(b.x + b.w / 2, b.y + b.h / 2, 1, 1).data].slice(0, 3), text: d.words.map((w) => w[4]).join(' ') };
}, id, box);
const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 50);
/** Draw a box on the page (page pixels) with the Replace a picture tool, and wait for the dialog. */
async function boxOn(box) {
  await page.click('#edit-bulk [data-op="picture"]');
  const r = await page.evaluate((b) => {
    const v = window.aef.views[0], at = v.el.getBoundingClientRect();
    return { x: at.x + (b.x / v.W) * at.width, y: at.y + (b.y / v.H) * at.height, w: (b.w / v.W) * at.width, h: (b.h / v.H) * at.height };
  }, box);
  await page.mouse.move(r.x + 2, r.y + 2);
  await page.mouse.down();
  await page.mouse.move(r.x + r.w / 2, r.y + r.h / 2, { steps: 4 });
  await page.mouse.move(r.x + r.w - 2, r.y + r.h - 2, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('#md-title')?.textContent === 'Replace a picture', { timeout: 5000 });
}
const reopened = () => page.waitForFunction(() => !document.querySelector('#media-dialog').open && window.aef.views[0]?.el.querySelector('.page-img')?.complete, { timeout: 30000 });
try {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  const book = (await api('POST', '/api/books', { kind: 'pdf', title: 'With a picture', importOptions: { language: 'en' } })).data;
  await page.evaluate(async (u, bytes) => { await fetch(u, { method: 'PUT', body: new Uint8Array(bytes) }); }, `/api/books/${book.id}/source/pdf`, [...makePdf()]);
  await api('POST', `/api/books/${book.id}/make`, { language: 'en' });
  for (let i = 0; i < 100 && (await api('GET', `/api/books/${book.id}/job`)).data.status !== 'ready'; i++) await sleep(300);
  const k = 1600 / 600; // (the page picture: 1600 wide)
  const box = { x: Math.round(100 * k), y: Math.round(200 * k), w: Math.round(200 * k), h: Math.round(100 * k) };
  let now = await look(book.id, box);
  assert.ok(near(now.color, [220, 30, 30]) && /A sentence under the picture/.test(now.text), JSON.stringify(now));

  // Correction mode: the tool, a box around the red picture, a picture of one's own.
  await page.goto(`${BASE}#/${book.id}/1`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('.page-img')?.complete, { timeout: 15000 });
  await page.click('.panel [role=tab][data-tab="text"]');
  await page.click('#edit-text');
  await page.waitForFunction(() => !document.querySelector('#edit-bulk [data-op="picture"]').hidden, { timeout: 5000 });
  await boxOn(box);
  await (await page.$('.pic-dialog input[type=file]')).uploadFile(blue);
  await page.waitForFunction(() => !document.querySelector('.pic-dialog .btn.primary').disabled, { timeout: 5000 });
  await page.click('.pic-dialog .btn.primary');
  await reopened();
  now = await look(book.id, box);
  assert.ok(near(now.color, [30, 60, 220]), `blue on the page: ${now.color}`);
  assert.match(now.text, /A sentence under the picture/, 'the text stays');
  const pdf = await page.evaluate(async (id) => {
    const b = await (await fetch(`/api/books/${id}`, { cache: 'no-store' })).json();
    const t = new TextDecoder('latin1').decode(await (await fetch(b.pdf)).arrayBuffer());
    return { dct: (t.match(/\/DCTDecode/g) || []).length, red: t.includes('/Width 20 /Height 10') };
  }, book.id);
  assert.deepEqual(pdf, { dct: 1, red: false }, 'in the PDF: the new picture (JPEG), the red one taken out');
  // The disc's books: no such tool.
  assert.equal(await page.evaluate(async () => { const s = await (await fetch('/api/me')).json(); return s.mode; }), 'local');

  // Made by AI: the key first (the admin), then the picture from words.
  await boxOn(box);
  await page.click('.pic-ways [data-way="ai"]');
  const button = (text) => page.evaluate((t) => [...document.querySelectorAll('.pic-dialog button')].find((b) => b.textContent === t)?.click(), text);
  const saveKey = async (key) => {
    await page.waitForSelector('.pic-dialog input[type=password]', { timeout: 5000 });
    await page.type('.pic-dialog input[type=password]', key);
    await button('Save the key');
    await page.waitForSelector('.pic-dialog textarea', { timeout: 5000 });
  };
  // A key of another AI (Kimi): refused, said plainly; changed for OpenAI's.
  await saveKey('sk-kimi-key');
  assert.deepEqual((await api('GET', '/api/picture-ai')).data, { ready: true, model: 'gpt-image-1', admin: true }, 'the key kept, never sent back');
  await button('Make a picture');
  await page.waitForFunction(() => /OpenAI did not accept the key/.test(document.querySelector('.pic-dialog [aria-live]')?.textContent), { timeout: 10000 });
  await page.click('.pic-dialog .pic-key');
  await saveKey('test-key');
  // No description: the old picture made again (with the page's text around it), shown first.
  await button('Make a picture');
  await page.waitForFunction(() => document.querySelectorAll('.pic-try').length === 1 && !document.querySelector('.pic-dialog .btn.primary').disabled, { timeout: 10000 });
  assert.ok(asked.at(-1).url.endsWith('/images/edits') && /name="image"/.test(asked.at(-1).body), 'from the old picture');
  assert.match(asked.at(-1).body, /Draw this picture again[\s\S]*A sentence under the picture/, 'with the page’s text around it');
  // Not liked: another (yellow); then a description; back to the first (green), which replaces it.
  await button('Make another');
  await page.waitForFunction(() => document.querySelectorAll('.pic-try').length === 2, { timeout: 10000 });
  await page.type('.pic-dialog textarea', 'A green field');
  await button('Make another');
  await page.waitForFunction(() => document.querySelectorAll('.pic-try').length === 3, { timeout: 10000 });
  assert.match(asked.at(-1).body, /A green field/, 'the description');
  assert.equal(await page.$eval('.pic-try[aria-pressed="true"] span', (s) => s.textContent), '3', 'the newest shown');
  await page.click('.pic-try[title="Picture 2"]');
  assert.equal(await page.$eval('.pic-try[aria-pressed="true"] span', (s) => s.textContent), '2');
  await page.click('.pic-try[title="Picture 1"]');
  assert.equal(await page.$eval('.pic-dialog .pic-before h4', (h) => h.textContent), 'Pictures replaced on this page');
  await page.click('.pic-dialog .btn.primary');
  await reopened();
  now = await look(book.id, box);
  assert.ok(near(now.color, [30, 180, 60]), `the first picture (green) on the page: ${now.color}`);
  const list = (await api('GET', `/api/books/${book.id}/pictures?n=1`)).data.pictures;
  assert.equal(list.length, 2);

  // Taken back, the last first: blue again; then red, as it was.
  await boxOn(box);
  await page.waitForSelector('.pic-before-row .btn', { timeout: 5000 });
  const rows = await page.$$('.pic-before-row .btn');
  await rows.at(-1).click();
  await reopened();
  assert.ok(near((await look(book.id, box)).color, [30, 60, 220]), 'the AI one taken back: blue');
  await api('DELETE', `/api/books/${book.id}/pictures/${list[0].id}`);
  assert.ok(near((await look(book.id, box)).color, [220, 30, 30]), 'and that one: red, as it was');
  const back = await page.evaluate(async (id) => {
    const b = await (await fetch(`/api/books/${id}`, { cache: 'no-store' })).json();
    return new TextDecoder('latin1').decode(await (await fetch(b.pdf)).arrayBuffer()).includes('/Width 20 /Height 10');
  }, book.id);
  assert.ok(back, 'the PDF as it was');
  assert.deepEqual(errors, []);
  console.log('picture-test: PASS');
} catch (err) {
  console.error('picture-test: FAIL', err);
  process.exitCode = 1;
} finally {
  await browser.close();
  await stopServer(server);
  ai.close();
  rmSync(tmp, { recursive: true, force: true });
}

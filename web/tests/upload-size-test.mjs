// Adding a big PDF (web/library.py limits, js/library.js tooBig): on this computer (you are the
// admin) a whole textbook of 70 MB is taken (the limit of the website's accounts, 60 MB, is not
// yours); a PDF over your limit is refused before it is sent, with its size and what to do; an
// upload that fails leaves no empty book behind.
// Run: node web/tests/upload-size-test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PORT ||= '8829';
const { startServer, stopServer, openBrowser, sleep } = await import('./harness.mjs');
const BASE = `http://127.0.0.1:${process.env.PORT}/web/`;

/** A one-page PDF with real text, and pad MB of padding in an object no page uses. */
function makePdf(text, pad = 0) {
  const content = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${pad * 2 ** 20} >>\nstream\n${' '.repeat(pad * 2 ** 20)}\nendstream`];
  let pdf = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => { const at = pdf.length; pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'lb-big-'));
const files = { big: path.join(tmp, 'textbook.pdf'), small: path.join(tmp, 'small.pdf'), fake: path.join(tmp, 'fake.pdf') };
writeFileSync(files.big, makePdf('A whole textbook.', 70));
writeFileSync(files.small, makePdf('Two megabytes.', 2));
writeFileSync(files.fake, Buffer.from('This is not a PDF at all.'));

const server = await startServer();
const { browser, page } = await openBrowser();
const errors = [];
const mine = () => page.evaluate(() => fetch('/api/books?scope=mine').then((r) => r.json()).then((b) => b.map((x) => x.title)));
/** Add a PDF through the Add dialog; then the dialog's message, or the step it went on to. */
async function add(title, file) {
  await page.click('#lib-add');
  await page.waitForSelector('.add-kind', { timeout: 10000 });
  await page.click('.add-kind [data-kind="pdf"]');
  await page.$eval('.lib-form input[type=text]', (i) => { i.value = ''; });
  await page.type('.lib-form input[type=text]', title);
  await (await page.$('.lib-form input[type=file][accept*="pdf"]')).uploadFile(file);
  await page.click('.lib-form button[type=submit]');
  for (let i = 0; i < 300; i++) {
    const now = await page.evaluate(() => ({
      msg: document.querySelector('#md-body .form-msg')?.textContent || '',
      title: document.querySelector('#md-title')?.textContent || '',
    }));
    if (now.msg || /^Sample|^Check the sample/.test(now.title)) return now;
    await sleep(200);
  }
  return {};
}
try {
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}#/`, { waitUntil: 'networkidle0' });
  await page.click('#library [data-scope="mine"]');
  const limits = await page.evaluate(() => window.aef.library.me.limits);
  assert.equal(limits.pdf_mb, 500, 'yours on this computer: 500 MB');
  assert.match(await page.evaluate(() => { document.querySelector('#lib-add').click(); return new Promise((r) => setTimeout(() => r(document.querySelector('#md-body').textContent), 300)); }), /at most 500 MB/);
  await page.keyboard.press('Escape');

  // A whole textbook of 70 MB: taken (it was "cut off" before: the limit was 60 MB for everyone).
  const big = await add('Big textbook', files.big);
  assert.equal(big.msg, '', JSON.stringify(big));
  assert.match(big.title, /Sample|Check the sample/);
  await page.keyboard.press('Escape');

  // The limits as the server says them when the book is added (not as when the page was opened:
  // the server may have been started again since, with others). Over the limit: said at once,
  // with its size; nothing sent, no book made.
  await page.evaluate(() => {
    window.aef.library.me.limits.pdf_mb = 60; // (as an older server said)
    const real = window.fetch;
    window.fetch = async (url, o) => {
      const r = await real(url, o);
      if (String(url) !== '/api/me' || !window.smallLimit) return r;
      const d = await r.json();
      return new Response(JSON.stringify({ ...d, limits: { ...d.limits, pdf_mb: 1 } }), { status: r.status, headers: { 'Content-Type': 'application/json' } });
    };
  });
  const before = await mine();
  const now = await add('Big textbook again', files.big);
  assert.equal(now.msg, '', 'the server says 500 MB now: taken');
  await page.keyboard.press('Escape');
  await page.evaluate(() => fetch(`/api/books?scope=mine`).then((r) => r.json())
    .then((b) => fetch(`/api/books/${b.find((x) => x.title === 'Big textbook again').id}`, { method: 'DELETE' })));
  await page.evaluate(() => { window.smallLimit = true; });
  const over = await add('Too big', files.small);
  assert.match(over.msg, /This PDF is 2\.0 MB: at most 1 MB/);
  assert.deepEqual(await mine(), before);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { window.smallLimit = false; });

  // The upload fails (not a PDF): the reason, and no empty book left.
  const fake = await add('Not a PDF', files.fake);
  assert.match(fake.msg, /not a PDF/);
  await sleep(300);
  assert.deepEqual(await mine(), before);
  assert.ok(before.includes('Big textbook'));
  assert.deepEqual(errors, []);
  console.log('upload-size-test: PASS');
} catch (err) {
  console.error('upload-size-test: FAIL', err);
  process.exitCode = 1;
} finally {
  await browser.close();
  await stopServer(server);
  rmSync(tmp, { recursive: true, force: true });
}

// End-to-end import review: every source page, independent edits, exclusion and persistence.
import assert from 'node:assert/strict';
process.env.PORT ||= '18938';
const { startServer, stopServer, openBrowser, sleep, BASE } = await import('./harness.mjs');

function fixturePdf() {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (let i = 1; i <= 3; i++) {
    const lines = [[50, 740, 24, 'Our reading page'], [50, 660, 15, 'First paragraph stays.'],
      [50, 300, 15, 'Delete this paragraph.'], [380, 660, 15, 'Right column stays.']];
    const content = lines.map(([x, y, size, text]) => `BT /F1 ${size} Tf ${x} ${y} Td (${text}) Tj ET`).join('\n');
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${objs.length} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    kids.push(`${objs.length} 0 R`);
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count 3 >>`;
  let pdf = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => { const n = pdf.length; pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; return n; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  return Buffer.from(pdf + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1');
}

let server, browser;
try {
  server = await startServer();
  const opened = await openBrowser({ width: 1500, height: 1000 });
  browser = opened.browser;
  const { page } = opened;
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const api = (method, url, body) => page.evaluate(async (m, u, b) => {
    const r = await fetch(u, { method: m, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
    const data = await r.json(); if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`); return data;
  }, method, url, body);
  const waitSample = async (id) => {
    for (let i = 0; i < 150; i++) {
      const data = await api('GET', `/api/books/${id}/preview`);
      if (data.state === 'error') throw new Error(data.error);
      if (data.state === 'ready') return data;
      await sleep(200);
    }
    throw new Error('Sample timed out');
  };
  await page.goto(BASE);
  const book = await api('POST', '/api/books', { kind: 'pdf', title: 'Paragraph review fixture', importOptions: { language: 'en' } });
  await page.evaluate(async (id, bytes) => {
    const r = await fetch(`/api/books/${id}/source/pdf`, { method: 'PUT', body: new Uint8Array(bytes) });
    if (!r.ok) throw new Error('Fixture upload failed');
  }, book.id, [...fixturePdf()]);
  await api('POST', `/api/books/${book.id}/preview`, { options: { language: 'en' } });
  await waitSample(book.id);
  await page.reload({ waitUntil: 'networkidle0' });
  await page.click('#library [data-scope="mine"]');
  await page.waitForSelector(`.book-card[data-id="${book.id}"] .bc-cover`);
  await page.click(`.book-card[data-id="${book.id}"] .bc-cover`);
  await page.waitForSelector('.design-note .btn');
  await page.click('.design-note .btn');
  await page.waitForFunction(() => document.querySelector('.design-editor')?.textContent.includes('Paragraph outlines are ready'));
  assert.equal(await page.$eval('.design-side h4', (e) => e.textContent), 'Page 1');
  assert.equal(await page.$$eval('.design-thumb', (items) => items.length), 3, 'All pages are available for navigation');
  assert.equal(await page.$eval('[aria-label="Layout editing scope"]', (e) => e.value), 'page');
  const count = await page.$$eval('.design-area', (items) => items.length);
  let removed = -1;
  for (let i = 0; i < count; i++) {
    await page.click(`.design-area:nth-child(${i + 1}) .n`);
    if ((await page.$eval('.design-paragraph-text', (e) => e.textContent)).includes('Delete this paragraph')) { removed = i; break; }
  }
  assert.ok(removed >= 0, 'Excluded paragraph has its own outline');
  await page.click(`.design-area:nth-child(${removed + 1}) button[aria-label="Remove this area"]`);
  assert.equal(await page.$$eval('.design-area', (items) => items.length), count - 1);
  await page.click('.design-area .n');
  await page.$eval('[aria-label="Width percent"]', (e) => { e.value = '30'; e.dispatchEvent(new Event('change')); });
  await page.click('.design-thumb[title="Page 2"]');
  await page.waitForFunction(() => document.querySelector('.design-side h4')?.textContent === 'Page 2'
    && document.querySelector('.design-editor')?.textContent.includes('Paragraph outlines are ready'));
  assert.equal(await page.$$eval('.design-area', (items) => items.length), count, 'Another page retains its own paragraphs');
  await page.select('.design-area:first-child select', 'heading');
  await page.click('.design-thumb[title="Page 1"]');
  assert.equal(await page.$$eval('.design-area', (items) => items.length), count - 1, 'Navigation retains edits');
  await page.click('.design-area .n');
  assert.equal(await page.$eval('[aria-label="Width percent"]', (e) => Number(e.value)), 30);
  await page.click('.design-editor .btn.primary');
  await page.waitForSelector('.sample-review', { timeout: 30000 });
  const saved = await api('GET', `/api/books/${book.id}/designs`);
  assert.equal(saved.pageAreas['1'].length, count - 1);
  assert.equal(saved.pageAreas['2'].length, count);
  assert.equal(saved.pageAreas['2'][0].kind, 'heading');
  await page.click('.design-note .btn');
  await page.waitForSelector('.design-editor');
  await page.waitForFunction(() => !document.querySelector('.design-editor .btn.primary').disabled);
  await page.click('.design-thumb[title="Page 1"]');
  assert.equal(await page.$$eval('.design-area', (items) => items.length), count - 1, 'Saved layouts reload');
  await api('POST', `/api/books/${book.id}/make`, {});
  for (let i = 0; i < 150; i++) {
    const job = await api('GET', `/api/books/${book.id}/job`);
    if (job.status === 'ready') break;
    if (job.status === 'error') throw new Error(job.error);
    if (i === 149) throw new Error('Making book timed out');
    await sleep(200);
  }
  const texts = [];
  for (const n of [1, 2]) {
    const doc = await api('GET', `/api/text/${book.id}/p${n}`);
    texts.push(doc.words.map((w) => w[4]).join(' '));
  }
  assert.doesNotMatch(texts[0], /Delete this paragraph/);
  assert.match(texts[1], /Delete this paragraph/);
  assert.deepEqual(errors, []);
  console.log('PASS: all pages, page-only resize/delete, text preview, navigation, save/reload, and final extraction');
} finally {
  await browser?.close();
  await stopServer(server);
}

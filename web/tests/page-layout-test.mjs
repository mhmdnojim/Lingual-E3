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
  // (a click is tried again when the editor redraws under it)
  const tap = async (sel) => { for (let i = 0; i < 6; i++) { try { await page.click(sel); return; } catch (e) { if (!/detached|not clickable/.test(e.message)) throw e; await sleep(250); } } throw new Error('could not click ' + sel); };
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
  await page.waitForFunction(() => !!window.aef);
  await page.evaluate(() => window.aef.goHome());
  await page.waitForFunction(() => document.body.classList.contains('lib-open'));
  const visibleScope = await Promise.all(['mine', 'public', 'local'].map(async (scope) => [scope,
    await api('GET', `/api/books?scope=${scope}&q=`)]));
  const bookScope = visibleScope.find(([, data]) => JSON.stringify(data).includes(book.id))?.[0];
  if (!bookScope) throw new Error(`Fixture book was not listed: ${JSON.stringify({ book, visibleScope })}`);
  await tap(`#library [role="tab"][data-scope="${bookScope}"]`);
  await page.waitForSelector(`.book-card[data-id="${book.id}"] .bc-cover`);
  await tap(`.book-card[data-id="${book.id}"] .bc-cover`);
  await page.waitForSelector('.design-editor');
  assert.equal(await page.$eval('.design-side h4', (e) => e.textContent), 'Page 1');
  assert.equal(await page.$$eval('.design-thumb', (items) => items.length), 3, 'All pages are available for navigation');
  assert.equal(await page.$eval('[aria-label="Apply page layout changes to"]', (e) => e.value), 'page');
  assert.ok(await page.$('.layout-tool-apply .btn.primary'), 'Apply and rebuild is directly below the page tool actions');
  const count = await page.$$eval('.design-area', (items) => items.length);
  assert.ok(count >= 2, 'Fixture has at least two areas to merge');
  await page.waitForFunction(() => /read using|Showing this page/.test(document.querySelector('.design-controls > .hint[aria-live="polite"]')?.textContent || ''), { timeout: 30000 });
  await sleep(600);
  await tap('.design-editor .frame[data-k="0"] > rect:first-child');
  await tap('#layout-tab-merge');
  const mergeNext = '[title="Combine the selected area box with the one after it"]';
  assert.equal(await page.$eval(mergeNext, (e) => e.disabled), false, 'Selecting an area enables merge with next');
  await tap(mergeNext);
  assert.equal(await page.$$eval('.design-area', (items) => items.length), count - 1, 'Merge with next combines the adjacent areas in the current layout');
  assert.match(await page.$eval('.design-controls > .hint[aria-live="polite"]', (e) => e.textContent), /Merged 2 areas/);
  await tap('[aria-label="Undo the last layout edit"]');
  assert.equal(await page.$$eval('.design-area', (items) => items.length), count, 'Undo restores merged areas');
  await tap('.design-area:nth-child(2) .n');
  const mergePrevious = '[title="Combine the selected area box with the one before it"]';
  assert.equal(await page.$eval(mergePrevious, (e) => e.disabled), false, 'Selecting an area enables merge with previous');
  await tap(mergePrevious);
  assert.equal(await page.$$eval('.design-area', (items) => items.length), count - 1, 'Merge with previous combines the adjacent areas in the current layout');
  await tap('[aria-label="Undo the last layout edit"]');
  assert.equal(await page.$$eval('.design-area', (items) => items.length), count, 'Undo restores the previous-area merge');
  await tap('.design-area:first-child .n');
  await tap('#layout-tab-merge');
  await tap(mergeNext);
  assert.equal(await page.$$eval('.design-area', (items) => items.length), count - 1, 'The selected merge is ready to apply');
  await tap('.layout-tool-apply .btn.primary');
  await page.waitForFunction(() => document.querySelector('.design-controls > .hint[aria-live="polite"]')?.textContent.match(/Book rebuilt\. Your page layout is still open\.|made again\. Your page layout is still open\./));
  const saved = await api('GET', `/api/books/${book.id}/designs`);
  assert.equal(saved.pageAreas['1'].length, count - 1, 'Apply saves the merged boxes before rebuilding the book');
  assert.ok(await page.$('.design-editor'), 'Applying the merge keeps the editor open');
  assert.deepEqual(errors, []);
  console.log('PASS: merge with next, merge with previous, undo, apply/rebuild, and stay in layout editor');
} finally {
  await browser?.close();
  await stopServer(server);
}

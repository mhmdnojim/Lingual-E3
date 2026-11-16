// AI layout with the owner's own words (web/js/designs.js, layout_ai.py): the Read tab has a box
// "Tell the AI what to do"; what is typed there is sent with "Analyze this page with AI" and kept
// for the book; with a scope of several pages, "Analyze N pages with AI" asks page after page and
// makes each answer that page's draft (listed under Apply). The AI itself is a stand-in here.
// Run: node web/tests/layout-ai-ask-test.mjs
import assert from 'node:assert/strict';

process.env.PORT ||= '18944';
const { startServer, stopServer, openBrowser, sleep, BASE } = await import('./harness.mjs');

function fixturePdf() {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (let i = 1; i <= 2; i++) {
    const lines = [[50, 740, 24, 'Our reading page'],
      [50, 690, 14, 'First paragraph has one sentence. It also has a second sentence.'],
      [50, 660, 14, 'Third sentence is here. And a fourth one follows.'],
      [50, 560, 14, 'Second paragraph starts here. It has two sentences.'],
      [50, 460, 14, 'A lonely third paragraph. With another sentence.'],
      [50, 300, 14, 'Fourth paragraph at the bottom. The last sentence.']];
    const content = lines.map(([x, y, size, text]) => `BT /F1 ${size} Tf ${x} ${y} Td (${text}) Tj ET`).join('\n');
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${objs.length} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    kids.push(`${objs.length} 0 R`);
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count 2 >>`;
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
  page.on('dialog', (d) => d.accept());
  // (the stand-in: AI is "ready"; its answer is two boxes — the top and the bottom half of the page)
  await page.evaluateOnNewDocument(() => {
    const real = window.fetch.bind(window);
    window.__asked = [];
    const json = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    window.fetch = async (url, o = {}) => {
      const u = String(url);
      if (u === '/api/layout-ai' && (!o.method || o.method === 'GET')) return json({ ready: true, can: true, model: 'stand-in', dailyLimit: 20 });
      const m = /^\/api\/books\/(L[0-9a-f]+)\/layout-ai\/(\d+)$/.exec(u);
      if (!m) return real(url, o);
      const sent = JSON.parse(o.body);
      window.__asked.push({ n: Number(m[2]), instruction: sent.instruction ?? null, refresh: sent.refresh });
      const source = await (await real(`/api/books/${m[1]}/layout/${m[2]}`, { method: 'POST' })).json();
      return json({ ...source, areas: [{ x: 0.05, y: 0.03, w: 0.9, h: 0.4, kind: 'paragraph' }, { x: 0.05, y: 0.5, w: 0.9, h: 0.4, kind: 'skip' }],
        ai: { model: 'stand-in', notes: ['Stand-in note.'], cached: false } });
    };
  });
  const api = (method, url, body) => page.evaluate(async (m, u, b) => {
    const r = await fetch(u, { method: m, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
    const data = await r.json(); if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`); return data;
  }, method, url, body);
  await page.goto(BASE);
  const book = await api('POST', '/api/books', { kind: 'pdf', title: 'AI ask fixture', importOptions: { language: 'en' } });
  await page.evaluate(async (id, bytes) => { await fetch(`/api/books/${id}/source/pdf`, { method: 'PUT', body: new Uint8Array(bytes) }); }, book.id, [...fixturePdf()]);
  await api('POST', `/api/books/${book.id}/layouts`, { options: { language: 'en' } });
  for (let i = 0; i < 150; i++) { if ((await api('GET', `/api/books/${book.id}/preview`)).state === 'ready') break; await sleep(200); }
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !!window.aef);
  await page.evaluate(() => window.aef.goHome());
  await page.waitForFunction(() => document.body.classList.contains('lib-open'));
  await page.click('#library [role="tab"][data-scope="mine"]');
  await page.waitForSelector(`.book-card[data-id="${book.id}"] .bc-cover`);
  await page.click(`.book-card[data-id="${book.id}"] .bc-cover`);
  await page.waitForSelector('.design-editor', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll('.design-area').length >= 5, { timeout: 20000 });
  const status = () => page.$eval('.design-controls > .hint[aria-live="polite"]', (e) => e.textContent);
  const tool = (label) => page.evaluate((l) => { const b = [...document.querySelectorAll('.layout-tool-actions button')].find((x) => x.textContent.trim().startsWith(l)); if (b && !b.disabled) b.click(); return !!b && !b.disabled; }, label);
  const areas = () => page.$$eval('.design-area', (rows) => rows.length);

  // The box is on the Read tab; what is typed there goes with the request.
  await page.waitForSelector('.layout-ai-ask');
  const ask = 'Read the table row by row. Leave out the second column.';
  await page.type('.layout-ai-ask', ask);
  assert.ok(await tool('Analyze this page with AI'), 'the AI button can be pressed');
  await page.waitForFunction(() => document.querySelector('.layout-ai-panel')?.textContent.includes('AI suggestion:'), { timeout: 20000 });
  assert.deepEqual(await page.evaluate(() => window.__asked), [{ n: 1, instruction: ask, refresh: false }]);
  assert.ok(await areas() >= 5, 'a suggestion only: the boxes stay until it is previewed');
  await page.evaluate(() => [...document.querySelectorAll('.layout-ai-panel button')].find((b) => b.textContent === 'Preview AI outlines').click());
  await page.waitForFunction(() => document.querySelectorAll('.design-area').length === 2);

  // A scope of several pages: one request a page, each answer that page's draft.
  await page.select('select[aria-label="Apply page layout changes to"]', 'all');
  await page.waitForFunction(() => [...document.querySelectorAll('.layout-tool-actions button')].some((b) => b.textContent.trim() === 'Analyze 2 pages with AI'));
  assert.ok(await tool('Analyze 2 pages with AI'));
  await page.waitForFunction(() => /AI made the boxes of 2 of 2 pages/.test(document.querySelector('.design-controls > .hint[aria-live="polite"]').textContent), { timeout: 30000 })
    .catch(async () => assert.fail(`status: ${await status()}; errors ${JSON.stringify(errors)}`));
  const asked = await page.evaluate(() => window.__asked);
  assert.deepEqual(asked.slice(1).map((a) => [a.n, a.instruction]), [[1, ask], [2, ask]]);
  assert.deepEqual(await page.$$eval('.layout-changed-page', (b) => b.map((x) => x.textContent)), ['1', '2'], 'both pages are drafts, listed under Apply');
  await page.evaluate(() => [...document.querySelectorAll('.layout-changed-page')].find((b) => b.textContent === '2').click());
  await page.waitForFunction(() => document.querySelectorAll('.design-area').length === 2 && /Page 2/.test(document.querySelector('.design-nav select')?.selectedOptions[0]?.textContent || ''), { timeout: 20000 });

  // Kept for the book: there again when the window is opened again.
  assert.ok(await page.evaluate((id, text) => Object.keys(localStorage).some((k) => k.includes(`layout-ai-ask-${id}`) && localStorage.getItem(k).includes(text)), book.id, ask), 'what was typed is kept for the book');

  assert.deepEqual(errors, []);
  console.log('PASS: the AI is told what to do in the owner’s words, on one page and on the pages of the scope');
} finally {
  await browser?.close();
  await stopServer(server);
}

// Real app + loopback OpenAI stand-in: credentials, streaming, draft review, cache, and failures.
import assert from 'node:assert/strict';
import http from 'node:http';
process.env.PORT ||= '18946';
const { startServer, stopServer, openBrowser, BASE, sleep } = await import('./harness.mjs');
const providerPort = Number(process.env.PORT) + 1;
let requests = 0, invalid = false, lastRequest;
const provider = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  requests++;
  lastRequest = JSON.parse(body);
  assert.equal(req.headers.authorization, 'Bearer test-layout-key');
  assert.equal(lastRequest.store, false);
  const source = lastRequest.input[0].content[0].text;
  const tokens = JSON.parse(source.slice(source.indexOf('\n') + 1));
  const groups = new Map();
  for (const [id, x, y] of tokens) {
    const key = `${x > 550 ? 'right' : 'left'}-${Math.round(y / 10)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(id);
  }
  const areas = [...groups.values()].map((ids, i) => ({ kind: i === 0 ? 'heading' : 'paragraph', word_ids: ids }));
  if (invalid) areas[0].word_ids.push(areas[0].word_ids[0]);
  const data = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text',
    text: JSON.stringify({ areas, notes: ['Synthetic suggestion: review the paragraph boundaries.'] }) }] }],
    usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140 } };
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data));
});

function pdf() {
  const content = [[50, 740, 24, 'Our reading page'], [50, 650, 15, 'First paragraph stays.'],
    [380, 650, 15, 'Right column stays.']].map(([x, y, size, text]) => `BT /F1 ${size} Tf ${x} ${y} Td (${text}) Tj ET`).join('\n');
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [5 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 3 0 R >> >> >>'];
  let text = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => { const n = text.length; text += `${i + 1} 0 obj\n${o}\nendobj\n`; return n; });
  const xref = text.length;
  return Buffer.from(text + `xref\n0 6\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`
    + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1');
}

let browser, app;
try {
  await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(providerPort, '127.0.0.1', resolve); });
  app = await startServer({ env: { LB_LAYOUT_API: `http://127.0.0.1:${providerPort}/v1`, OPENAI_API_KEY: '' } });
  const opened = await openBrowser({ width: 1500, height: 1000 });
  browser = opened.browser;
  const { page } = opened, errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const api = (method, url, body) => page.evaluate(async (m, u, b) => {
    const r = await fetch(u, { method: m, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
    const data = await r.json(); if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`); return data;
  }, method, url, body);
  await page.goto(BASE);
  const initial = await api('GET', '/api/layout-ai');
  assert.equal(initial.ready, false);
  const book = await api('POST', '/api/books', { title: 'AI layout fixture', kind: 'pdf', importOptions: { language: 'en' } });
  await page.evaluate(async (id, bytes) => { await fetch(`/api/books/${id}/source/pdf`, { method: 'PUT', body: new Uint8Array(bytes) }); }, book.id, [...pdf()]);
  await api('POST', `/api/books/${book.id}/preview`, { options: { language: 'en' } });
  for (let i = 0; i < 120; i++) {
    const sample = await api('GET', `/api/books/${book.id}/preview`);
    if (sample.state === 'ready') break;
    if (sample.state === 'error') throw new Error(sample.error);
    await sleep(200);
  }
  await page.reload({ waitUntil: 'networkidle0' });
  await page.click('#library [data-scope="mine"]');
  await page.waitForSelector(`.book-card[data-id="${book.id}"] .bc-cover`);
  await page.click(`.book-card[data-id="${book.id}"] .bc-cover`);
  await page.waitForSelector('.design-note .btn'); await page.click('.design-note .btn');
  await page.waitForFunction(() => document.querySelector('.design-editor')?.textContent.includes('Paragraph outlines are ready'));
  assert.equal(await page.$eval('[data-action="analyze-layout-ai"]', (b) => b.disabled), true);
  assert.equal(requests, 0, 'No API request on upload, navigation, or opening settings');
  await page.click('.layout-ai-settings summary');
  await page.type('[aria-label="AI layout API key"]', 'test-layout-key');
  const saveSettings = async () => {
    await page.evaluate(() => [...document.querySelectorAll('.layout-ai-settings button')].find((b) => b.textContent === 'Save AI settings').click());
    await page.waitForFunction(() => !document.querySelector('[data-action="analyze-layout-ai"]').disabled);
  };
  await saveSettings();
  assert.equal(await page.$eval('[aria-label="AI layout API key"]', (e) => e.value), '');
  const info = await api('GET', '/api/layout-ai');
  assert.equal(info.ready, true); assert.ok(!JSON.stringify(info).includes('test-layout-key'));
  const kinds = () => page.$$eval('.design-area select', (items) => items.map((e) => e.value));
  const before = await kinds();
  await page.click('[data-action="analyze-layout-ai"]');
  await page.waitForFunction(() => document.querySelector('.layout-ai-panel')?.textContent.includes('AI suggestion:'));
  assert.equal(requests, 1);
  assert.deepEqual(await kinds(), before, 'AI suggestions are not applied before explicit preview');
  assert.equal(lastRequest.input[0].content[1].type, 'input_image');
  assert.equal(lastRequest.text.format.strict, true);
  await page.evaluate(() => [...document.querySelectorAll('.layout-ai-panel button')].find((b) => b.textContent === 'Preview AI outlines').click());
  assert.equal((await kinds())[0], 'heading');
  await page.evaluate(() => [...document.querySelectorAll('.design-nav button')].find((b) => b.textContent === 'Undo').click());
  assert.deepEqual(await kinds(), before, 'Undo restores the previous layout');
  await page.click('[data-action="analyze-layout-ai"]');
  await page.waitForFunction(() => document.querySelector('.layout-ai-panel')?.textContent.includes('Loaded from cache'));
  assert.equal(requests, 1, 'Reopening a completed suggestion is free of new API requests');
  await page.evaluate(() => [...document.querySelectorAll('.layout-ai-panel button')].find((b) => b.textContent === 'Discard suggestion').click());
  invalid = true;
  await page.evaluate(() => [...document.querySelectorAll('.design-nav button')].find((b) => b.textContent === 'Analyze again (new paid request)').click());
  await page.waitForFunction(() => document.querySelector('.layout-ai-panel')?.textContent.includes('repeated or invented'));
  assert.equal(requests, 2);
  assert.deepEqual(await kinds(), before, 'Invalid AI output cannot damage user outlines');
  const settings = await api('GET', `/api/books/${book.id}/designs`);
  assert.deepEqual(settings.pageAreas, {}, 'Neither suggestions nor previews are saved without Save layouts');
  assert.deepEqual(errors, []);
  console.log('PASS: explicit AI requests, private key settings, source-word schema, streamed suggestions, preview/undo, cache reuse, and invalid-result recovery');
} finally {
  await browser?.close();
  await stopServer(app);
  await new Promise((resolve) => provider.close(resolve));
}

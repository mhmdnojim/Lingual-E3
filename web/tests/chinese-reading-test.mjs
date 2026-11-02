// Reading a Chinese book aloud: Chinese books keep their own "read which language" (中+EN at
// first), so "EN" chosen in an English book does not silence them; with "EN" chosen in a Chinese
// book, a Chinese sentence is skipped and the app says so (not silence). The voice is a recorder.
// Run: node web/tests/chinese-reading-test.mjs
import assert from 'node:assert/strict';

process.env.PORT ||= '8820';
const { startServer, stopServer, openBrowser, BASE, sleep } = await import('./harness.mjs');

const server = await startServer();
const { browser, page } = await openBrowser();
try {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('aef3.speechLanguageMode', '"en"'); // (chosen before, in an English book)
    window.spoken = [];
    speechSynthesis.speak = (u) => { window.spoken.push({ text: u.text, lang: u.lang }); setTimeout(() => { u.onstart?.(); u.onend?.(); }, 20); };
  });
  await page.goto(BASE + '#/', { waitUntil: 'networkidle0' });
  const id = await page.evaluate(async () => {
    const j = async (method, url, body) => (await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    const book = await j('POST', '/api/books', { kind: 'text', title: '中文', importOptions: { language: 'zh-Hans' } });
    await j('PUT', `/api/books/${book.id}/source/text`, { text: '我每天六点起床。\n\nI get up at six.' });
    await j('POST', `/api/books/${book.id}/make`, {});
    for (let i = 0; i < 60; i++) {
      if ((await (await fetch(`/api/books/${book.id}`)).json()).status === 'ready') return book.id;
      await new Promise((ok) => setTimeout(ok, 400));
    }
    return null;
  });
  const read = (startsWith) => page.evaluate((s) => {
    window.spoken = [];
    const a = window.aef, v = a.views[0], t = v.text;
    const k = t.sent.findIndex(([x, y]) => t.text(x, y).startsWith(s));
    a.reader.stop();
    a.reader.start(v, t.unit('sentence', k), false);
  }, startsWith).then(() => sleep(600)).then(() => page.evaluate(() => {
    window.aef.reader.stop();
    return { spoken: window.spoken.map((u) => `${u.lang}:${u.text.trim()}`), toast: document.querySelector('#toast')?.textContent || '' };
  }));
  const mode = () => page.$eval('#speech-language-mode', (s) => s.value);

  await page.goto(`${BASE}#/${id}/1`, { waitUntil: 'networkidle0' });
  await sleep(800);
  assert.equal(await mode(), 'both', 'a Chinese book: 中+EN at first (EN chosen in an English book does not count)');
  let r = await read('我'); // (from it to the end of the page)
  assert.deepEqual(r.spoken, ['zh-CN:我每天六点起床。', 'en-US:I get up at six.'], 'the Chinese read by a Chinese voice, the English by an English one');
  console.log('PASS: a Chinese book reads its Chinese, though "EN" was chosen in an English book');

  await page.click('#lang-seg [data-lang="en"]');
  await sleep(300);
  r = await read('我');
  assert.deepEqual(r.spoken, ['en-US:I get up at six.'], '"EN" chosen: the Chinese sentence is not read');
  assert.match(r.toast, /The Chinese is not read: “EN” \(English only\) is chosen in the top bar/, 'and the app says so');
  console.log('PASS: "EN" chosen in a Chinese book: a Chinese sentence skipped, and the app says why and what to do');

  const disc = await page.evaluate(async () => (await (await fetch('/api/books?scope=local')).json())[0]);
  await page.goto(`${BASE}#/${disc.id}/${disc.firstPage || 1}`, { waitUntil: 'networkidle0' });
  await sleep(600);
  assert.equal(await mode(), 'en', 'an English book: its own choice, as it was');
  await page.goto(`${BASE}#/${id}/1`, { waitUntil: 'networkidle0' });
  await sleep(600);
  assert.equal(await mode(), 'en', 'the Chinese book: "EN", as chosen in it');
  assert.deepEqual(errors, []);
  console.log('PASS: Chinese books and the others each keep their own choice');
} finally {
  await browser.close();
  stopServer(server);
}

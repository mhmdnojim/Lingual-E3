// Transcription by ElevenLabs (js/transcription.js, web/transcription.py), with a stand-in for it:
// the Script tab's "Transcribe a file…" opens Speech recognition; its key saved by the admin (a
// wrong one first: told plainly; never sent back); any file transcribed: its lines with the
// speakers, to download, translated as a book's script (under every line, when pointing; its
// language found by itself); then a book's recordings all transcribed from its Settings, the lines
// of one shown in the Script tab when it is played (with the translation buttons); then a book of
// the disc's (Levels 1–3: here Level 3's Workbook) recordings without a script on the disc written
// again by ElevenLabs, and its new lines shown instead of the old ones.
// Run: node web/tests/speech-test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PORT ||= '8836';
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

// The stand-in of ElevenLabs: for the right key, a short dialogue (two speakers); else "invalid key".
const asked = [];
const said = (...items) => items.flatMap(([text, start, who], i) => [
  ...(i ? [{ text: ' ', type: 'spacing', start, end: start }] : []), { text, type: 'word', start, end: start + 0.3, speaker_id: who }]);
const eleven = createServer((req, res) => {
  let body = '';
  req.setEncoding('latin1');
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    asked.push({ url: req.url, key: req.headers['xi-api-key'], body });
    const ok = req.headers['xi-api-key'] === 'el-key';
    res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? { language_code: 'en', words: said(['Hi', 0, 'speaker_0'], ['Jenny.', 0.4, 'speaker_0'], ['Hello', 1, 'speaker_1'],
      ['Rob!', 1.4, 'speaker_1'], ['How', 2, 'speaker_0'], ['are', 2.4, 'speaker_0'], ['you?', 2.8, 'speaker_0']) }
      : { detail: { status: 'invalid_api_key', message: 'Invalid API key' } }));
  });
});
await new Promise((ok) => eleven.listen(0, '127.0.0.1', ok));

const tmp = mkdtempSync(path.join(os.tmpdir(), 'lb-speech-'));
const voice = path.join(tmp, 'voice message.mp3');
writeFileSync(voice, Buffer.from('ID3 a voice message'));
const track = path.join(tmp, 'AEF_SB_1.26.mp3');
writeFileSync(track, Buffer.from('ID3 track 1.26'));
const server = await startServer({ env: { LB_SPEECH_API: `http://127.0.0.1:${eleven.address().port}/v1`, ELEVENLABS_API_KEY: '' } });
const { browser, page } = await openBrowser();
const errors = [];
const api = (method, url) => page.evaluate(async (m, u) => { const r = await fetch(u, { method: m }); return { status: r.status, data: await r.json().catch(() => null) }; }, method, url);
const text = (sel) => page.$eval(sel, (n) => n.textContent);
try {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  const before = (await api('GET', '/api/speech-ai')).data;
  assert.equal(before.ready, false);
  assert.equal(before.engine, 'local');

  // A book with a recording added (its button on the page), not transcribed yet.
  const book = await page.evaluate(async (pdf, mp3) => {
    const b = await (await fetch('/api/books', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'pdf', title: 'With audio', importOptions: { language: 'en' } }) })).json();
    await fetch(`/api/books/${b.id}/source/pdf`, { method: 'PUT', body: new Uint8Array(pdf) });
    await fetch(`/api/books/${b.id}/make`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language: 'en' }) });
    return b;
  }, [...makePdf(['1.26 Watch or listen to Jenny.'])]);
  for (let i = 0; i < 100 && (await api('GET', `/api/books/${book.id}/job`)).data.status !== 'ready'; i++) await sleep(300);
  await page.evaluate(async (id, bytes) => {
    await fetch(`/api/books/${id}/tracks?name=AEF_SB_1.26.mp3`, { method: 'PUT', body: new Uint8Array(bytes) });
    await fetch(`/api/books/${id}/tracks/place`, { method: 'POST' });
  }, book.id, [...readFileSync(track)]);

  // The Script tab, nothing played yet: Transcribe a file… → Speech recognition.
  await page.goto(`${BASE}#/${book.id}/1`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('.page-img')?.complete, { timeout: 15000 });
  await page.click('[role="tab"][data-tab="listen"]');
  await page.waitForFunction(() => [...document.querySelectorAll('#cue-head button')].some((b) => b.textContent === 'Transcribe a file…'), { timeout: 5000 });
  await page.evaluate(() => [...document.querySelectorAll('#cue-head button')].find((b) => b.textContent === 'Transcribe a file…').click());
  await page.waitForSelector('.speech-dialog .speech-key, .speech-dialog input[type="password"]', { timeout: 5000 });
  if (await page.$('.speech-dialog .speech-key')) await page.click('.speech-dialog .speech-key'); // (this computer's Whisper installed: the way shown first)
  const saveKey = async (key) => {
    await page.waitForSelector('.speech-dialog input[type="password"]', { timeout: 5000 });
    await page.type('.speech-dialog input[type="password"]', key);
    await page.evaluate(() => [...document.querySelectorAll('.speech-dialog button')].find((b) => b.textContent === 'Save the key').click());
    await page.waitForSelector('.speech-dialog .speech-ways [data-engine="eleven"][aria-checked="true"]', { timeout: 5000 });
  };
  await saveKey('a-wrong-key');
  const info = (await api('GET', '/api/speech-ai')).data;
  assert.deepEqual([info.ready, info.engine, 'key' in info, JSON.stringify(info).includes('wrong')], [true, 'eleven', false, false], 'the key is never sent back');

  // Any file: a wrong key told plainly; with the right one, its lines (with the speakers).
  const transcribe = async () => {
    await (await page.$('.speech-file input[type="file"]')).uploadFile(voice);
    await page.evaluate(() => [...document.querySelectorAll('.speech-file button')].find((b) => b.textContent === 'Transcribe').click());
  };
  await transcribe();
  await page.waitForFunction(() => /did not accept the key/.test(document.querySelector('.speech-file .hint[aria-live]').textContent), { timeout: 10000 });
  await page.click('.speech-dialog .speech-key');
  await saveKey('el-key');
  await transcribe();
  await page.waitForFunction(() => document.querySelectorAll('.speech-lines li').length === 3, { timeout: 10000 });
  const lines = await page.$$eval('.speech-lines li', (li) => li.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  assert.ok(/Speaker A.*Hi Jenny\./.test(lines[0]) && /Speaker B.*Hello Rob!/.test(lines[1]) && /Speaker A.*How are you\?/.test(lines[2]), lines.join(' | '));
  assert.match(await text('.speech-file .hint[aria-live]'), /^3 lines\./);
  assert.equal(await page.$('.speech-file > .field select'), null, 'its language is found by itself: no list to choose it');

  // Translated as a book's script: the two buttons and the language (the same as the disc's scripts).
  assert.deepEqual(await page.$$eval('.speech-tools > *', (n) => n.filter((x) => !x.hidden).map((x) => x.className.split(' ').pop())),
    ['cue-tr-under', 'cue-tr-point', 'repeat-btn', 'cue-lang']);
  const trAsked = [];
  const fakeTranslator = (r) => {
    if (r.isInterceptResolutionHandled()) return;
    if (r.method() === 'POST' && r.url().endsWith('/api/translate')) {
      const b = JSON.parse(r.postData());
      trAsked.push(b);
      r.respond({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ translations: b.paragraphs.map((p) => p.map((x) => `[${b.lang}] ${x}`)), fetched: 0, missing: 0, none: [], wordContext: false }) });
    } else r.continue();
  };
  await page.setRequestInterception(true);
  page.on('request', fakeTranslator);
  await page.select('.speech-tools select.cue-lang', 'ar');
  await page.click('.speech-tools .cue-tr-under');
  await page.waitForFunction(() => /\[ar\] Hi Jenny\./.test(document.querySelector('.speech-lines').textContent), { timeout: 10000 });
  const fileScript = `AU-${createHash('sha256').update(readFileSync(voice)).digest('hex').slice(0, 32)}`;
  assert.deepEqual([trAsked[0].book, trAsked[0].page, trAsked[0].from], ['files', fileScript, 'en'], 'kept under the file (its content), from the language found');
  await page.click('.speech-tools .cue-tr-under'); // (off again)
  page.off('request', fakeTranslator);
  await page.setRequestInterception(false);
  const kept = await page.evaluate(async (id) => (await fetch('/api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lang: 'ar', from: 'en', book: 'files', page: id, paragraphs: [['Hi Jenny.']], cachedOnly: true }) })).status, fileScript);
  assert.equal(kept, 200, 'the server keeps the translations of a file');
  assert.ok(await page.$$eval('.speech-result button', (b) => b.map((x) => x.textContent).includes('Download subtitles (SRT)')));
  const sent = asked.at(-1);
  assert.equal(sent.key, 'el-key');
  assert.match(sent.body, /name="model_id"\r\n\r\nscribe_v2\r\n/);
  assert.match(sent.body, /name="diarize"\r\n\r\ntrue\r\n/);
  assert.doesNotMatch(sent.body, /name="language_code"/, 'its language found by ElevenLabs');
  assert.match(sent.body, /ID3 a voice message/);
  await page.click('#md-close');

  // The book's recordings, all transcribed from its Settings → Audio and video.
  await page.evaluate(async (id) => window.aef.library.settings(await (await fetch(`/api/books/${id}`)).json()), book.id);
  await page.waitForFunction(() => [...document.querySelectorAll('.media-box button')].some((b) => b.textContent === 'Transcribe them all' && !b.hidden), { timeout: 5000 });
  await page.evaluate(() => [...document.querySelectorAll('.media-box button')].find((b) => b.textContent === 'Transcribe them all').click());
  await page.waitForFunction(() => /Their scripts: 1 of 1 written down\.$/.test(document.querySelector('.media-box p.hint:not([hidden]):last-of-type')?.textContent || ''), { timeout: 15000 });
  assert.match(asked.at(-1).body, /name="language_code"\r\n\r\nen\r\n/, 'the book\'s language');
  assert.match(asked.at(-1).body, /ID3 track 1\.26/);
  assert.equal((await api('GET', `/api/books/${book.id}/tracks`)).data.transcripts.done, 1);
  await page.click('#md-close');

  // Played: its lines in the Script tab.
  await page.waitForSelector('.page .hs-audio', { timeout: 10000 });
  await page.click('.page .hs-audio');
  await page.click('[role="tab"][data-tab="listen"]');
  await page.waitForFunction(() => /Hi Jenny\./.test(document.querySelector('.tab-body[data-tab="listen"] .cue-list')?.textContent || ''), { timeout: 10000 });
  assert.ok(await page.$('#cue-head .speech-btn'), 'Speech recognition next to Transcribe');
  assert.deepEqual(await page.$$eval('.tab-body[data-tab="listen"] :is(.cue-tr-under, .cue-tr-point, .cue-lang)', (n) => n.map((x) => x.hidden)),
    [false, false, false], 'a recording added to a book: its script translated like the disc\'s');
  assert.equal(asked.length, 3, 'each transcribed once');

  // A book of the disc: its recordings and videos without a script on the disc, written again by ElevenLabs.
  const disc = (await api('GET', '/api/books?scope=local')).data.find((b) => /Workbook/.test(b.title));
  const before2 = (await api('GET', `/api/disc-scripts/${disc.id}`)).data;
  assert.ok(before2.files > 0 && before2.transcripts.done === 0 && before2.engine === 'eleven', JSON.stringify(before2));
  await page.evaluate((b) => window.aef.library.discScripts(b), disc);
  await page.waitForFunction((n) => new RegExp(`^${n} of its recordings and videos have no script on the disc: 0 of them written by ElevenLabs\\.$`)
    .test(document.querySelector('.disc-scripts p.hint')?.textContent || ''), { timeout: 5000 }, before2.files);
  await page.evaluate(() => [...document.querySelectorAll('.disc-scripts button')].find((b) => b.textContent === 'Transcribe them all').click());
  await page.waitForFunction((n) => new RegExp(`: ${n} of them written by ElevenLabs\\.$`).test(document.querySelector('.disc-scripts p.hint')?.textContent || ''),
    { timeout: 90000 }, before2.files);
  assert.equal(asked.length, 3 + before2.files, 'each sent once');
  assert.ok(await page.$eval('.disc-scripts', (d) => [...d.querySelectorAll('button')].find((b) => b.textContent === 'Transcribe them all').hidden), 'all done');
  await page.click('#md-close');
  // Played: ElevenLabs's lines instead of the ones this computer wrote before.
  const wb = (await api('GET', `/api/books/${disc.id}`)).data;
  const old = wb.pages.flatMap((p) => p.a || []).find((a) => a.t === 'audio' && a.auto);
  await page.evaluate((a, slug) => window.aef.audio.play(a, { book: slug, language: 'en' }), old, wb.slug);
  await page.waitForFunction(() => /Hi Jenny\./.test(document.querySelector('.tab-body[data-tab="listen"] .cue-list')?.textContent || ''), { timeout: 10000 });
  assert.deepEqual(errors, []);
  console.log('speech-test: PASS');
} catch (err) {
  console.error('speech-test: FAIL', err);
  process.exitCode = 1;
} finally {
  await browser.close();
  await stopServer(server);
  eleven.close();
  rmSync(tmp, { recursive: true, force: true });
}

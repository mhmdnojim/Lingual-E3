// Isolated real-server/IndexedDB regression. No online TTS generation or user data.
// Run: node web/tests/offline-page-test.mjs
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { startServer, stopServer, openBrowser, gotoPage, BASE } from './harness.mjs';

let server, browser;
try {
  server = await startServer();
  const opened = await openBrowser();
  browser = opened.browser;
  const { page } = opened;
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const voices = [
    { voiceURI: 'aria-test', name: 'Microsoft Aria Online (Natural) (en-US)', lang: 'en-US', localService: false },
    { voiceURI: 'guy-test', name: 'Microsoft Guy Online (Natural) (en-US)', lang: 'en-US', localService: false },
    { voiceURI: 'device-test', name: 'Microsoft David', lang: 'en-US', localService: true },
  ];
  await page.evaluateOnNewDocument((voices) => {
    Object.defineProperty(window.speechSynthesis, 'getVoices', { value: () => voices });
    localStorage.setItem('aef3.voice', JSON.stringify('aria-test'));
  }, voices);
  await page.setRequestInterception(true);
  let failDelete = false;
  page.on('request', (request) => {
    if (request.url().includes('/api/voices')) return request.respond({ contentType: 'application/json', body: JSON.stringify([
      { id: 'en-US-AriaNeural', name: 'Aria', locale: 'en-US', gender: 'Female' },
      { id: 'en-US-GuyNeural', name: 'Guy', locale: 'en-US', gender: 'Male' },
    ]) });
    if (failDelete && request.method() === 'DELETE' && request.url().includes('/api/recordings/')) {
      return request.respond({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Test: file in use' }) });
    }
    request.continue();
  });
  await gotoPage(page, '#/1705/25');
  await page.waitForFunction(() => window.aef?.views[0]?.text && window.aef.recordings.voiceList?.length);
  const fixture = await page.evaluate(() => {
    const app = window.aef, v = app.views[0];
    return { book: app.book.slug, bookId: app.book.id, bookType: app.book.type, page: v.page.n, path: v.page.path,
      otherPath: app.book.pages.find((p) => String(p.n) === '27').path,
      sentences: v.text.sent.slice(0, 3).map(([a, b], i) => ({ path: v.page.path, a, b,
        text: v.text.text(a, b), start: i, end: i + 1, words: v.text.words.slice(a, b).map(() => [i, i + 1]) })) };
  });
  const ids = ['r20261011-120000-0001', 'r20261011-120000-0002', 'r20261011-120000-0003', 'r20261011-120000-0004', 'r20261011-120000-0005'];
  const make = (id, extra) => ({ ...fixture, id, created: '2026-10-11T12:00:00', title: 'Audio fixture',
    voice: 'en-US-AriaNeural', voiceName: 'Aria', languageMode: 'en', rate: 0, gap: 0, duration: 3,
    file: `/web/recordings/${id}.mp3`, ...extra });
  const records = [
    make(ids[0], { title: 'American English File 2e Level 3 offline audio' }), // legacy: no type flag
    make(ids[1], { title: 'Guy English page 25', voice: 'en-US-GuyNeural', voiceName: 'Guy', offlineVoiceOnly: true }),
    make(ids[2], { title: 'Other page', offlineVoiceOnly: true, page: '27', path: fixture.otherPath,
      sentences: fixture.sentences.map((s) => ({ ...s, path: fixture.otherPath })) }),
    make(ids[3], { title: 'Ordinary saved conversation' }),
  ];
  const folder = path.join(server.data, 'recordings');
  mkdirSync(folder, { recursive: true });
  const seed = (rec) => {
    writeFileSync(path.join(folder, rec.id + '.json'), JSON.stringify(rec));
    writeFileSync(path.join(folder, rec.id + '.mp3'), Buffer.from('ID3 fixture media'));
    writeFileSync(path.join(folder, rec.id + '.srt'), 'fixture subtitles');
    writeFileSync(path.join(folder, rec.id + '.vtt'), 'WEBVTT\n');
  };
  records.forEach(seed);
  const served = await fetch(new URL(records[0].file, BASE));
  assert.equal(served.status, 200);
  assert.match(served.headers.get('cache-control'), /no-store/);
  await served.arrayBuffer();
  await page.evaluate(async (records) => {
    const { offlineAudio } = await import('/web/js/offline-audio.js');
    for (const rec of records) await offlineAudio.put({ id: rec.id, recording: rec,
      summary: { ...rec, count: rec.sentences.length, text: rec.sentences.map((s) => s.text).join(' '), paths: [rec.path], first: rec.sentences[0] },
      blob: new Blob(['ID3 fixture media'], { type: 'audio/mpeg' }), importedAt: '2026-10-11T12:00:00' });
    await window.aef.recordings.load();
    await window.aef.recordings.loadOffline();
  }, records);
  const badge = () => page.$eval('#offline-voice-badge', (n) => n.textContent);
  const navigate = async (n) => {
    await page.evaluate(async (n) => { await window.aef.go('1705', String(n)); await window.aef.pageReady; }, n);
  };
  assert.equal(await badge(), 'OFFLINE');
  assert.equal(await page.$$eval('.page-offline-item', (nodes) => nodes.length), 2);
  assert.equal(await page.$$eval('.rec-spot', (nodes) => nodes.length), 1, 'Only ordinary audio has a paragraph icon');
  await navigate(26);
  assert.equal(await badge(), 'ONLINE');
  await page.evaluate(async () => {
    const { speech } = await import('/web/js/speech.js'); speech.setVoice('device-test'); window.aef.updateVoiceOfflineStatus();
  });
  assert.equal(await badge(), 'ONLINE', 'A device voice is not a downloaded page file');
  await navigate(25);
  assert.equal(await badge(), 'OFFLINE');
  console.log('PASS: page-specific badge, legacy offline packages, no offline paragraph icons');
  await page.evaluate(() => { window.aef.spreadOn = true; });
  await navigate(24);
  assert.equal(await badge(), 'ONLINE', 'Other half of a spread must not inherit downloaded status');
  await navigate(25);
  assert.equal(await badge(), 'OFFLINE', 'Same spread, different focused page updates its badge');
  await page.evaluate(() => { window.aef.spreadOn = false; });
  await navigate(25);

  await page.evaluate(() => window.aef.showTab('audio'));
  await page.waitForFunction((id) => window.aef.recordings.selectedRec?.id === id, {}, ids[3]);
  assert.ok(await page.$$eval('.rec-frame rect', (nodes) => nodes.length > 0), 'Ordinary audio still has its editable paragraph frame');
  const removePageFile = async (id) => {
    await page.click(`.page-offline-item[data-id="${id}"] [data-page-offline-act="remove"]`);
    await page.waitForFunction((id) => !window.aef.recordings.offlineItems.has(id), {}, id);
    for (const ext of ['.mp3', '.json', '.srt', '.vtt']) assert.equal(existsSync(path.join(folder, id + ext)), false, `Deleted disk ${id}${ext}`);
    assert.equal((await fetch(new URL(`/web/recordings/${id}.mp3`, BASE))).status, 404);
    assert.equal(await page.evaluate(async (id) => !!(await (await import('/web/js/offline-audio.js')).offlineAudio.get(id)), id), false);
  };
  // Mimic references to the old package left over from an earlier app version.
  await page.evaluate(async (id) => {
    const r = window.aef.recordings, rec = await r.loadFull(id);
    r.selectedId = r.modeId = r.spotFocusId = id; r.selectedRec = r.framedRec = rec;
    r.assetFor(rec); r.updateRecordingFrame(); r.updateRecordingSelection();
  }, ids[0]);
  assert.equal(await page.$$eval('.rec-frame rect, .rec-selected rect', (nodes) => nodes.length), 0, 'Legacy packages never outline the whole page');
  await removePageFile(ids[0]);
  assert.equal(await badge(), 'OFFLINE');
  assert.equal(await page.evaluate(() => window.aef.recordings.pageOfflineId), ids[1]);
  assert.equal(await page.evaluate(async () => (await import('/web/js/speech.js')).speech.currentVoice('en').voiceURI), 'guy-test');
  assert.equal(await page.evaluate((id) => window.aef.recordings.offlineUrls.has(id) || window.aef.recordings.assets.has(id)
    || window.aef.recordings.full.has(id) || window.aef.recordings.selectedId === id || window.aef.recordings.modeId === id, ids[0]), false);
  const hit = await page.evaluate(async () => {
    const r = window.aef.recordings, view = window.aef.views[0], [a, b] = view.text.sent[0];
    const original = r.playFrom; let played;
    r.playFrom = (found) => { played = found.rec.id; };
    try { await r.playOfflineForUnit(view, { a, b, mode: 'sentence' }, false); } finally { r.playFrom = original; }
    return played;
  });
  assert.equal(hit, ids[1], 'Sentence playback uses remaining offline voice');
  await page.evaluate(async () => {
    const { speech } = await import('/web/js/speech.js');
    speech.setVoice('aria-test');
    window.aef.recordings.voiceList = window.aef.recordings.voiceList.filter((v) => v.name !== 'Guy');
    window.aef.recordings.syncPageOfflineVoice();
  });
  assert.equal(await page.evaluate(() => window.aef.recordings.pageOfflineId), ids[1], 'Cached voice remains usable without a browser voice counterpart');
  await removePageFile(ids[1]);
  assert.equal(await badge(), 'ONLINE');
  assert.equal(await page.$eval('#rec-page-offline-section', (n) => n.hidden), true);
  assert.ok(existsSync(path.join(folder, ids[2] + '.mp3')), 'Another page is untouched');
  console.log('PASS: deletes disk + IndexedDB + object URLs; switches voice; last package restores Online');

  page.on('dialog', (dialog) => dialog.accept());
  await page.evaluate((id) => window.aef.recordings.remove(window.aef.recordings.list.find((r) => r.id === id)), ids[3]);
  assert.equal(existsSync(path.join(folder, ids[3] + '.mp3')), false);
  assert.equal(await page.evaluate((id) => window.aef.recordings.offlineItems.has(id), ids[3]), false);
  assert.equal(await page.$$eval('.rec-spot', (nodes) => nodes.length), 0);
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.aef?.views[0]?.text);
  assert.equal(await badge(), 'ONLINE');
  await navigate(27);
  assert.equal(await badge(), 'OFFLINE');
  failDelete = true;
  assert.equal(await page.evaluate((id) => window.aef.recordings.deleteRecording(id), ids[2]), false);
  assert.ok(existsSync(path.join(folder, ids[2] + '.mp3')));
  assert.equal(await badge(), 'OFFLINE');
  failDelete = false;
  await page.evaluate((id) => window.aef.recordings.deleteRecording(id), ids[2]);
  assert.equal(await badge(), 'ONLINE');
  const orphan = make(ids[4], { title: 'Old app offline audio' }); seed(orphan);
  await navigate(25);
  await page.evaluate(() => window.aef.recordings.load());
  assert.equal(await page.$$eval('.page-offline-item', (nodes) => nodes.length), 1, 'Server-only leftovers remain deletable');
  assert.equal(await badge(), 'ONLINE');
  await page.evaluate((id) => window.aef.recordings.removeOffline(id), ids[4]);
  assert.equal(existsSync(path.join(folder, ids[4] + '.mp3')), false);
  const localOnly = make('r20261011-120000-0006', { offlineVoiceOnly: true });
  await page.evaluate(async (rec) => {
    const { offlineAudio } = await import('/web/js/offline-audio.js');
    await offlineAudio.put({ id: rec.id, recording: rec, summary: rec, serverCopy: false, blob: new Blob(['ID3 local']) });
    await window.aef.recordings.loadOffline();
  }, localOnly);
  failDelete = true;
  assert.equal(await page.evaluate((id) => window.aef.recordings.deleteRecording(id), localOnly.id), true,
    'A known browser-only package can be removed without reaching the server');
  assert.equal(await badge(), 'ONLINE');
  failDelete = false;
  assert.deepEqual(errors, []);
  console.log('PASS: ordinary recording deletion, refresh persistence, failed deletion/retry, server-only cleanup');
} finally {
  await browser?.close();
  await stopServer(server);
}

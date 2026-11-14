// Real app/server, simulated mic and ElevenLabs SDK. No provider charges or private keys.
// Run: node web/tests/assistant-test.mjs
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
process.env.PORT ||= '8847';
const { startServer, stopServer, openBrowser, gotoPage, sleep } = await import('./harness.mjs');
const base = `http://127.0.0.1:${process.env.PORT}`;
let server, browser;
try {
  server = await startServer();
  assert.equal((await fetch(base + '/api/assistant-token')).status, 405);
  const noKey = await fetch(base + '/api/assistant-token', { method: 'POST' });
  assert.equal(noKey.status, 503);
  assert.match((await noKey.json()).error, /API key/);
  assert.equal((await fetch(base + '/api/assistant-token', { method: 'POST', headers: { Origin: 'https://outside.example' } })).status, 403);
  const opened = await openBrowser({ width: 1280, height: 900 });
  browser = opened.browser;
  const { page } = opened, errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let tokens = 0;
  await page.evaluateOnNewDocument(() => {
    window.tutor = { starts: 0, ends: 0, micCalls: 0, tracksStopped: 0, messages: [], contexts: [], volumes: [], mutes: [], activities: 0 };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
      window.tutor.micCalls++;
      if (window.tutor.micError) throw new DOMException('test microphone error', window.tutor.micError);
      return { getTracks: () => [{ stop: () => window.tutor.tracksStopped++ }] };
    }});
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { value: async () => [{ kind: 'audioinput', deviceId: 'physical', label: 'Physical microphone' }] });
  });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (request.url().includes('/api/assistant-token')) {
      tokens++;
      return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ conversationToken: 'short-lived-test' }) });
    }
    if (request.url().includes('@elevenlabs/client/')) return request.respond({ status: 200, contentType: 'application/javascript',
      headers: { 'Access-Control-Allow-Origin': '*' }, body: `export const Conversation = {async startSession(options) {
        const t = window.tutor; t.starts++; t.options = options;
        if (t.delay) await new Promise(resolve => { t.finishConnect = resolve; });
        return {endSession: async () => {t.ends++; options.onDisconnect();},
          sendUserMessage: s => t.messages.push(s), sendContextualUpdate: s => t.contexts.push(s),
          setVolume: o => t.volumes.push(o.volume), setMicMuted: b => t.mutes.push(b),
          sendUserActivity: () => t.activities++};
      }};` });
    request.continue();
  });
  await gotoPage(page, '#/1705/25');
  await page.waitForFunction(() => window.aef?.views?.[0]?.text);
  await page.evaluate(async () => {
    const { speech, settings } = await import('/web/js/speech.js');
    speech.supported = true;
    speech.speak = (text, callbacks) => { window.lesson = { text, callbacks }; };
    speech.stop = () => {};
    settings.repeat = 3;
    settings.trOrder = 'after';
    window.testSpeech = speech;
  });
  await page.click('#btn-assistant');
  await page.click('#btn-assistant');
  assert.equal(tokens, 0, 'opening the panel must not request credentials');
  assert.equal(await page.evaluate(() => tutor.micCalls), 0);
  assert.equal(await page.$eval('#assistant-pop', n => n.hidden), false);
  await page.click('#assistant-start');
  assert.equal(tokens, 0, 'no active sentence: do not connect');
  assert.match(await page.$eval('#assistant-status', n => n.textContent), /Select a sentence/);

  // A word highlighted by saved audio, with no live Reader active, resolves to its full sentence.
  const select = async (index) => page.evaluate((i) => {
    const app = aef, view = app.views[0], unit = view.text.sentenceUnit(i);
    app.reader.stop();
    app.focus = { view, w: unit.a };
    app.markPanel('active', view, { a: unit.a, b: unit.a + 1, mode: 'word' });
    view.showActive(unit);
    return view.text.text(unit.a, unit.b);
  }, index);
  const first = await select(2);
  await page.click('#assistant-start');
  await page.waitForFunction(() => tutor.messages.length === 1);
  const initial = await page.evaluate(() => ({ starts: tutor.starts, stopped: tutor.tracksStopped,
    vars: tutor.options.dynamicVariables, message: tutor.messages[0], tools: Object.keys(tutor.options.clientTools) }));
  assert.equal(initial.starts, 1);
  assert.equal(initial.stopped, 1);
  assert.equal(initial.vars.current_sentence, first);
  assert.match(initial.message, /No greeting, introduction, or opening question/);
  assert.deepEqual(initial.tools, ['point_at_text']);
  // WebRTC may add an audio element of its own; that must never silence itself.
  await page.evaluate(() => {
    const audio = document.createElement('audio');
    audio.id = 'fake-tutor-audio';
    Object.defineProperty(audio, 'paused', { value: false });
    document.body.append(audio);
    aef.assistant.checkSentence();
  });
  assert.equal(await page.evaluate(() => Boolean(aef.assistant.lessonPlaying())), false);
  await page.click('#btn-assistant');
  await page.click('#assistant-close');
  assert.equal(await page.evaluate(() => aef.assistant.busy && tutor.ends === 0), true);
  await page.click('#btn-assistant');
  assert.equal(tokens, 1, 'reopening never restarts');
  await page.click('#assistant-mute');
  assert.equal(await page.evaluate(() => tutor.mutes.at(-1)), true);
  await page.click('#assistant-mute');
  await page.click('#assistant-settings summary');
  await page.select('#assistant-teaching', 'gentle');
  await sleep(500);
  assert.equal(await page.evaluate(() => tutor.messages.length), 1, 'style updates do not repeat the explanation');
  assert.match(await page.evaluate(() => tutor.contexts.at(-1)), /gentle/);

  const pointing = await page.evaluate(() => {
    const fn = tutor.options.clientTools.point_at_text;
    const missing = fn({ text: 'not on this page xxxxx' });
    const found = fn({ text: tutor.options.dynamicVariables.current_sentence });
    return { missing, found, count: document.querySelectorAll('.tutor-range-box').length };
  });
  assert.equal(pointing.missing, 'not found on screen');
  assert.equal(pointing.found, 'highlighted');
  assert.ok(pointing.count > 0);
  if (process.env.ASSISTANT_SCREENSHOT) {
    mkdirSync(path.dirname(process.env.ASSISTANT_SCREENSHOT), { recursive: true });
    await page.screenshot({ path: process.env.ASSISTANT_SCREENSHOT });
  }

  // Real unitClick -> Reader queue -> onEnd: one sentence, no repeats, no tutor over speech.
  await page.evaluate(() => {
    const view = aef.views[0];
    aef.unitClick(view, view.text.unitAt(view.text.sentenceUnit(5).a, 'word'), true);
  });
  await page.waitForFunction(() => aef.reader.state === 'playing' && !aef.assistant.playPending);
  await sleep(450);
  assert.equal(await page.evaluate(() => aef.reader.queue.length), 1);
  assert.equal(await page.evaluate(() => tutor.messages.length), 1);
  assert.equal(await page.evaluate(() => tutor.volumes.at(-1)), 0);
  assert.ok(await page.evaluate(() => tutor.activities > 0));
  await page.evaluate(() => lesson.callbacks.onEnd());
  await page.waitForFunction(() => tutor.messages.length === 2);
  assert.equal(await page.evaluate(() => aef.reader.state), 'idle');
  assert.equal(await page.evaluate(() => tutor.volumes.at(-1)), 1);
  await sleep(500);
  assert.equal(await page.evaluate(() => tutor.messages.length), 2);

  // Saved MP3 sentence boundary: stop at its end and keep its highlight on late timeupdates.
  const clip = await page.evaluate(async () => {
    const app = aef, recs = app.recordings, view = app.views[0];
    const unit = view.text.sentenceUnit(8);
    const sentence = { path: view.page.path, text: view.text.text(unit.a, unit.b), start: 1, end: 2, words: [], a: unit.a, b: unit.b };
    const rec = { id: 'tutor-test-clip', title: 'Test clip', book: view.book.slug, sentences: [sentence, { ...sentence, start: 2, end: 3 }] };
    const play = app.audio.play, pause = app.audio.pause;
    app.audio.play = async () => {};
    let pauses = 0;
    app.audio.pause = () => pauses++;
    try {
      await recs.playFrom({ rec, k: 0, t: 1, end: null }, false);
      const end = recs.stopAt;
      recs.follow(rec, 2000);
      recs.follow(rec, 2005);
      return { end, pauses, repeats: recs.ended({ rec }), keptBoundary: recs.stopAt };
    } finally {
      app.audio.play = play; app.audio.pause = pause;
      recs.stopAt = null; recs.loop = null;
    }
  });
  assert.deepEqual(clip, { end: 2, pauses: 2, repeats: false, keptBoundary: 2 });

  await page.click('#assistant-stop');
  assert.equal(await page.evaluate(() => tutor.ends), 1);
  assert.equal(await page.$$eval('.tutor-range-box', n => n.length), 0);
  assert.equal(await page.$eval('#assistant-start', n => n.hidden), false);

  // Cancellation while connecting: late SDK resolution must be ended, never revived.
  await page.evaluate(() => { tutor.delay = true; });
  await page.click('#assistant-start');
  await page.waitForFunction(() => tutor.finishConnect);
  await page.click('#assistant-stop');
  await page.evaluate(() => tutor.finishConnect());
  await page.waitForFunction(() => tutor.ends === 2);
  assert.equal(await page.evaluate(() => aef.assistant.busy), false);
  assert.equal(await page.evaluate(() => tutor.messages.length), 2);
  await page.evaluate(() => { tutor.delay = false; tutor.micError = 'NotAllowedError'; });
  const before = tokens;
  await page.click('#assistant-start');
  await page.waitForFunction(() => document.querySelector('#assistant-status').textContent.includes('Microphone blocked'));
  assert.equal(tokens, before, 'microphone refusal does not spend a session');
  assert.equal(await page.evaluate(() => aef.assistant.busy), false);

  // Ordinary reading still queues the rest of the page after tutor End.
  await page.evaluate(() => {
    const view = aef.views[0];
    aef.reader.start(view, view.text.sentenceUnit(2));
  });
  assert.ok(await page.evaluate(() => aef.reader.queue.length > 1));
  await page.evaluate(() => aef.reader.stop());
  assert.deepEqual(errors, []);
  console.log('PASS: tutor panel, selected sentence, playback handoff, no repeats, pointer, settings, cancellation, mic errors, endpoint guards.');
} finally {
  if (browser) await browser.close();
  await stopServer(server);
}

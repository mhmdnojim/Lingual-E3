// Breaking a sentence down: its button stays with the sentence while the pointer crosses the next
// one on the way to it (the button at the end of the line, after that sentence); a double click on a
// sentence of the page opens it; on a phone a finger held on a sentence (page, Text list) — a tap
// still reads it.
// Run: node web/tests/breakdown-test.mjs
import assert from 'node:assert/strict';

process.env.PORT ||= '8821';
const { startServer, stopServer, openBrowser, BASE, sleep } = await import('./harness.mjs');
const { KnownDevices } = await import('puppeteer-core');

const server = await startServer();
const { browser, page } = await openBrowser();
const errors = [];
const silent = () => { window.spoken = []; speechSynthesis.speak = (u) => { window.spoken.push(u.text); }; };
const panel = (p) => p.evaluate(() => {
  const d = document.querySelector('#media-dialog');
  return d.open && document.querySelector('#md-title').textContent === 'Break down the sentence'
    ? document.querySelector('.bd-sentence .bd-text').textContent.replace(/\s+/g, '') : null;
});
const close = (p) => p.evaluate(() => document.querySelector('#md-close').click()).then(() => sleep(200));
try {
  page.on('pageerror', (e) => errors.push(e.message));
  await page.evaluateOnNewDocument(silent);
  await page.goto(BASE + '#/1705/25', { waitUntil: 'networkidle0' });
  await sleep(1200);
  // Two sentences, the first ending on a line where the second goes on.
  const pair = await page.evaluate(() => {
    const v = window.aef.views[0], t = v.text;
    for (let s = 0; s + 1 < t.sent.length; s++) {
      const [a, b] = t.sent[s], [c, d] = t.sent[s + 1];
      if (t.words[b - 1][5] === t.words[c][5] && b - a > 2 && d - c > 2) return { s, a, b, c, d, text: t.text(a, b).replace(/\s+/g, '') };
    }
    return null;
  });
  assert.ok(pair, 'a line with the end of one sentence and the start of the next');
  const button = () => page.evaluate(() => { const b = document.querySelector('.page .bd-btn'); return b && b.isConnected ? 'shown' : null; });
  await page.evaluate(({ a, c }) => {
    const v = window.aef.views[0], t = v.text, bd = window.aef.breakdown;
    bd.track('hover', v, t.unit('sentence', t.w2s[a]));   // the first sentence pointed at
    bd.track('hover', v, t.unit('sentence', t.w2s[c]));   // the pointer crosses the next one …
    document.querySelector('.page .bd-btn').dispatchEvent(new PointerEvent('pointerenter')); // … and reaches the button
  }, pair);
  await sleep(500);
  assert.equal(await button(), 'shown');
  await page.evaluate(() => document.querySelector('.page .bd-btn').click());
  await sleep(500);
  assert.equal(await panel(page), pair.text, 'the panel of the sentence the button was for, not the one crossed');
  await close(page);
  // Pointing at the next one and staying there: the button goes to it.
  await page.evaluate(({ c }) => {
    const v = window.aef.views[0], t = v.text, bd = window.aef.breakdown;
    document.querySelector('.page .bd-btn').dispatchEvent(new PointerEvent('pointerleave'));
    bd.track('hover', v, t.unit('sentence', t.w2s[c]));
  }, pair);
  await sleep(600);
  assert.equal(await page.evaluate(() => window.aef.breakdown.shown?.a), pair.c, 'pointed at a moment: the button goes to the next sentence');
  console.log('PASS: the button stays with its sentence while the pointer crosses the next one on the way to it');

  // A double click on a sentence of the page: its breakdown (the reading started by the first click paused).
  const center = (p, w) => p.evaluate((k) => {
    const r = window.aef.views[0].gHits.querySelector(`[data-w="${k}"]`).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, w);
  const at = await center(page, pair.a + 1);
  await page.mouse.click(at.x, at.y, { clickCount: 1 });
  await page.mouse.click(at.x, at.y, { clickCount: 2 });
  await sleep(600);
  assert.equal(await panel(page), pair.text, 'a double click: the sentence broken down');
  assert.notEqual(await page.evaluate(() => window.aef.reader.state), 'playing', '(not reading at the same time)');
  await close(page);
  console.log('PASS: a double click on a sentence of the page breaks it down');

  // The panel's top stays where it is while it gets longer: the meanings come, "word by word" opened.
  let meaning = (k) => `meaning ${k >> 1}`, sentenceTr = 'La phrase.'; // (two words, one meaning: a part)
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (!req.url().includes('/api/translate')) { req.continue().catch(() => {}); return; }
    const b = JSON.parse(req.postData());
    const body = req.url().includes('/api/translate-word')
      ? (b.items ? { wordContext: true, translations: b.items.map((_, k) => meaning(k)) } : { wordContext: true, text: `alone: ${b.word}` })
      : { translations: b.paragraphs.map((p) => p.map(() => sentenceTr)) };
    setTimeout(() => req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {}), 300);
  });
  await page.evaluate(() => window.aef.translator.setLang('fr', false));
  await page.mouse.click(at.x, at.y, { clickCount: 1 });
  await page.mouse.click(at.x, at.y, { clickCount: 2 });
  const top = () => page.evaluate(() => Math.round(document.querySelector('#media-dialog').getBoundingClientRect().top));
  await sleep(100);
  const tops = [await top()];
  await page.waitForSelector('.bd-more', { timeout: 5000 });
  tops.push(await top());
  const height = await page.evaluate(() => document.querySelector('#media-dialog').offsetHeight);
  await page.click('.bd-more');
  await page.waitForFunction(() => document.querySelector('.bd-sub span[dir]')?.textContent.startsWith('alone:'), { timeout: 5000 });
  tops.push(await top());
  assert.ok(await page.evaluate((h) => document.querySelector('#media-dialog').offsetHeight > h, height), '(longer: the words of the part)');
  assert.deepEqual(tops, [tops[0], tops[0], tops[0]], `the top stays: ${tops.join(', ')}`);
  await close(page);
  console.log(`PASS: the panel's top stays where it is (${tops[0]}px) while it gets longer (the meanings, word by word)`);

  // A part pointed at: its meaning marked in the translation, at its own place — the same meaning
  // twice ("of" … "of"), a meaning inside another word ("an" in "and").
  meaning = (k) => (k % 2 === 0 ? 'of' : k === 1 ? 'an' : `w${k}`);
  sentenceTr = 'and of an of b';
  await page.evaluate(() => window.aef.translator.setLang('de', false)); // (another language: asked again)
  await page.mouse.click(at.x, at.y, { clickCount: 1 });
  await page.mouse.click(at.x, at.y, { clickCount: 2 });
  await page.waitForSelector('.bd-words tr:nth-child(3) .bd-en', { timeout: 5000 });
  await page.waitForFunction(() => document.querySelector('.bd-translation .bd-text').textContent === 'and of an of b', { timeout: 5000 });
  const marked = (row) => page.evaluate((row) => {
    document.querySelectorAll('.bd-words tr')[row].dispatchEvent(new PointerEvent('pointerenter'));
    const line = document.querySelector('.bd-translation .bd-text'), m = line.querySelector('mark');
    return m ? `${line.textContent.slice(0, line.textContent.indexOf(m.textContent, line.firstChild.textContent.length))}[${m.textContent}]` : null;
  }, row);
  assert.deepEqual([await marked(0), await marked(1), await marked(2)], ['and [of]', 'and of [an]', 'and of an [of]'],
    'each part at its own place in the translation');
  console.log('PASS: a part pointed at is marked at its own place in the translation (the same meaning twice, “an” not in “and”)');

  // Heard: the word being said is marked, with what it is in the other line (voices that say where they are).
  await page.evaluate(() => {
    window.said = [];
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    speechSynthesis.getVoices = () => [{ name: 'Test English', lang: 'en-US', localService: true, voiceURI: 'test-en', default: true },
      { name: 'Test German', lang: 'de-DE', localService: true, voiceURI: 'test-de', default: false }];
    speechSynthesis.speak = (u) => { window.said.push(u); };
    speechSynthesis.dispatchEvent(new Event('voiceschanged'));
  });
  const now = () => page.evaluate(() => {
    const line = document.querySelector('.bd-translation .bd-text'), m = line.querySelector('mark');
    return {
      sentence: [...document.querySelectorAll('.bd-sentence .w.on')].map((s) => s.textContent),
      translation: m ? `${line.firstChild.nodeType === 3 && line.firstChild !== m ? line.firstChild.textContent : ''}[${m.textContent}]` : null,
      row: [...document.querySelectorAll('.bd-words tr')].findIndex((r) => r.classList.contains('on')),
    };
  });
  const third = await page.evaluate(({ a }) => { const t = window.aef.views[0].text; return { at: t.text(a, a + 2).length + 1, text: t.words[a + 2][4] }; }, pair);
  await page.click('.bd-sentence .icon-btn');
  await page.evaluate((c) => window.said.at(-1).onboundary({ name: 'word', charIndex: c }), third.at);
  assert.deepEqual(await now(), { sentence: [third.text], translation: 'and of an [of]', row: 2 }, 'the sentence said: its 3rd word, and its meaning');
  await page.evaluate(() => window.said.at(-1).onend());
  await sleep(50);
  assert.deepEqual(await now(), { sentence: [], translation: null, row: -1 }, '(said: nothing marked)');
  await page.click('.bd-translation .icon-btn');
  await page.evaluate(() => window.said.at(-1).onboundary({ name: 'word', charIndex: 7, charLength: 2 }));
  const second = await page.evaluate(({ a }) => window.aef.views[0].text.words[a + 1][4], pair);
  assert.deepEqual(await now(), { sentence: [second], translation: 'and of [an]', row: 1 }, 'the translation said: “an”, and the word it is the meaning of');
  await page.evaluate(() => window.said.at(-1).onboundary({ name: 'word', charIndex: 0 }));
  assert.deepEqual(await now(), { sentence: [], translation: '[and]', row: -1 }, '“and”: the meaning of no part, only itself');
  console.log('PASS: heard, the word being said is marked with what it is in the other line (sentence → meaning, translation → words)');
  await close(page);

  // Offline mode (Settings → Translation): nothing saved yet — said, with the way back online; one
  // click switches it off and translates the sentence with the internet.
  const asked = []; // (cachedOnly of each request: true, only what is saved)
  meaning = (k) => `online ${k}`;
  sentenceTr = 'Online sentence.';
  const saved = (req, b) => (b.cachedOnly ? { wordContext: true, translations: (b.items || []).map(() => ''), text: '' } : null);
  page.removeAllListeners('request');
  page.on('request', (req) => {
    if (!req.url().includes('/api/translate')) { req.continue().catch(() => {}); return; }
    const b = JSON.parse(req.postData());
    asked.push(!!b.cachedOnly);
    const body = req.url().includes('/api/translate-word')
      ? saved(req, b) || (b.items ? { wordContext: true, translations: b.items.map((_, k) => meaning(k)) } : { wordContext: true, text: `alone: ${b.word}` })
      : { translations: b.paragraphs.map((p) => p.map(() => (b.cachedOnly ? '' : sentenceTr))) };
    req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
  });
  await page.evaluate(() => { window.aef.translator.setLang('es', false); window.aef.translator.setOfflineOnly(true); });
  await page.mouse.click(at.x, at.y, { clickCount: 1 });
  await page.mouse.click(at.x, at.y, { clickCount: 2 });
  await page.waitForFunction(() => !document.querySelector('.bd-offline')?.hidden, { timeout: 5000 });
  const offline = await page.evaluate(() => ({ cells: [...document.querySelectorAll('.bd-tr span[dir]')].map((s) => s.textContent),
    note: document.querySelector('.bd-offline').textContent }));
  assert.ok(offline.cells.every((c) => c === 'not saved offline yet') && /Offline mode is on/.test(offline.note), JSON.stringify(offline));
  assert.ok(asked.length && asked.every((c) => c === true), 'offline: only what is saved asked');
  await page.click('.bd-offline .btn');
  await page.waitForFunction(() => document.querySelector('.bd-tr span[dir]')?.textContent.startsWith('online'), { timeout: 5000 });
  await page.waitForFunction(() => document.querySelector('.bd-translation .bd-text').textContent === 'Online sentence.', { timeout: 5000 });
  assert.deepEqual(await page.evaluate(() => ({ off: window.aef.translator.offlineOnly, box: document.querySelector('#tr-offline').checked,
    note: document.querySelector('.bd-offline').hidden })), { off: false, box: false, note: true }, 'offline mode off (also in Settings)');
  assert.ok(asked.includes(false), 'the internet asked');
  await close(page);
  console.log('PASS: offline mode: “not saved offline yet” said with the way back online; Translate online gets the meanings');
  page.removeAllListeners('request');
  await page.setRequestInterception(false);

  // A phone: a finger held on a sentence (page, Text list) breaks it down; a tap reads it.
  const phone = await browser.newPage();
  phone.on('pageerror', (e) => errors.push(e.message));
  await phone.evaluateOnNewDocument(silent);
  await phone.emulate(KnownDevices['iPhone 13']);
  await phone.goto(BASE + '#/1705/25', { waitUntil: 'networkidle0' });
  await sleep(1200);
  const cdp = await phone.createCDPSession();
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y]) => ({ x, y })) });
  const press = async ({ x, y }, ms) => { await touch('touchStart', [[x, y]]); await sleep(ms); await touch('touchEnd', []); await sleep(500); };
  const word = await center(phone, pair.a + 1);
  await press(word, 750);
  assert.equal(await panel(phone), pair.text, 'a finger held on a sentence of the page');
  assert.deepEqual(await phone.evaluate(() => window.spoken), [], '(not read: it was held, not tapped)');
  await close(phone);
  await press(word, 60);
  assert.equal(await panel(phone), null, 'a tap: no panel');
  assert.ok((await phone.evaluate(() => window.spoken)).length > 0, 'a tap reads it');
  await phone.evaluate(() => window.aef.reader.stop());
  await phone.evaluate(() => { window.aef.setPanelOpen(true); window.aef.showTab('text'); });
  await sleep(500);
  const inList = await phone.evaluate((a) => {
    const span = document.querySelector(`#text-view .sline .w[data-w="${a + 1}"]`) || document.querySelector('#text-view .sline .w');
    span.scrollIntoView({ block: 'center' });
    const r = span.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, sentence: span.closest('.sline').textContent };
  }, pair.a);
  await sleep(300);
  await press(inList, 750);
  assert.ok(await panel(phone), 'a finger held on a sentence of the Text list');
  await close(phone);
  await phone.close();
  assert.deepEqual(errors, []);
  console.log('PASS: on a phone, a finger held on a sentence (page or Text list) breaks it down; a tap still reads it');
} finally {
  await browser.close();
  stopServer(server);
}

// The Translator page (js/translator.js): opens from the library, translates what is written or
// dictated into the other language (the server answer is a stand-in), keeps the conversation.
// Run: node web/tests/translator-test.mjs
import assert from 'node:assert/strict';

process.env.PORT ||= '18961';
const { startServer, stopServer, openBrowser, BASE, sleep } = await import('./harness.mjs');

const server = await startServer();
const { browser, page } = await openBrowser({ width: 1200, height: 900 });
const errors = [];
try {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.evaluateOnNewDocument(() => {
    // A stand-in microphone: says "good morning" as soon as it starts.
    window.SpeechRecognition = class {
      start() { setTimeout(() => { this.onresult?.({ results: [[{ transcript: 'good morning' }]] }); this.onend?.(); }, 30); }
      abort() {}
    };
  });
  await page.setRequestInterception(true);
  const asked = [];
  page.on('request', (r) => {
    if (!r.url().endsWith('/api/translator')) return r.continue();
    const body = JSON.parse(r.postData());
    asked.push(body);
    r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: `<${body.lang}> ${body.text}` }) });
  });
  await page.goto(BASE + '#/');
  await page.waitForSelector('#lib-translator', { visible: true });
  await page.click('#lib-translator');
  await page.waitForSelector('.translator');
  assert.ok(await page.$$eval('.translator select option', (o) => o.length > 20), 'the languages are listed');

  // Written: first language -> second.
  await page.select('.tr-langs select:first-child', 'en');
  await page.select('.tr-langs select:last-child', 'ar');
  await page.type('.tr-input', 'Hello');
  await page.click('.tr-actions .btn:nth-child(3)');
  await page.waitForSelector('.tr-msg');
  assert.equal(await page.$eval('.tr-result', (e) => e.textContent), '<ar> Hello');
  assert.deepEqual(asked[0], { text: 'Hello', lang: 'ar', from: 'en' });
  assert.equal(await page.$eval('.tr-input', (e) => e.value), '', 'the box is emptied');

  // Spoken by the second side: translated into the first language.
  await page.click('.tr-actions .btn:nth-child(2)');
  await page.waitForFunction(() => document.querySelectorAll('.tr-msg').length === 2);
  assert.deepEqual(asked[1], { text: 'good morning', lang: 'en', from: 'ar' });
  assert.ok(await page.$eval('.tr-msg.right', (e) => !!e), 'the second side is on the right');

  // The conversation stays after closing and opening again; remove one message.
  await page.keyboard.press('Escape');
  await sleep(200);
  await page.click('#lib-translator');
  await page.waitForSelector('.tr-msg');
  assert.equal(await page.$$eval('.tr-msg', (m) => m.length), 2, 'kept on this device');
  await page.click('.tr-msg .tr-tools button[aria-label="Remove this message"]');
  assert.equal(await page.$$eval('.tr-msg', (m) => m.length), 1);
  assert.deepEqual(errors, []);
  console.log('PASS: the Translator opens from the library, translates written and spoken text, keeps the conversation');
} finally {
  await browser.close();
  await stopServer(server);
}

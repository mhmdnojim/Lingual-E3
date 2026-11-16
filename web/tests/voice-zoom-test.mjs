// (1) A voice that makes no sound (a Chinese voice that is not installed): another voice of the language is
//     tried, the one that speaks is kept; when none speaks, reading stops with a message and does not
//     race through the sentences to the end of the page (js/speech.js). The voices are stand-ins here.
// (2) Ctrl + mouse wheel zooms the pages around the pointer: the point under it stays under it (js/main.js zoomBy).
// Run: node web/tests/voice-zoom-test.mjs
import assert from 'node:assert/strict';

process.env.PORT ||= '18961';
const { startServer, stopServer, openBrowser, sleep, BASE } = await import('./harness.mjs');

let server, browser;
try {
  server = await startServer();
  const opened = await openBrowser({ width: 1400, height: 900 });
  browser = opened.browser;
  const { page } = opened;
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.evaluateOnNewDocument(() => {
    const voices = [
      { name: 'Silent Chinese', lang: 'zh-CN', voiceURI: 'silent', localService: true },
      { name: 'Working Chinese', lang: 'zh-CN', voiceURI: 'working', localService: true },
    ];
    const fake = {
      getVoices: () => (localStorage.getItem('__only') ? voices.slice(0, 1) : voices),
      addEventListener() {}, cancel() {}, resume() {}, pending: false, speaking: false,
      speak(u) {
        setTimeout(() => {
          if (u.voice?.voiceURI === 'working') { u.onstart?.({}); u.onboundary?.({ name: 'word', charIndex: 0 }); }
          u.onend?.({});
        }, 20);
      },
    };
    Object.defineProperty(window, 'speechSynthesis', { value: fake, configurable: true });
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } }; // (the real one takes only real voices)
  });
  await page.goto(BASE);
  await page.waitForFunction(() => !!window.aef);

  const run = (only) => page.evaluate(async (only) => {
    window.__only = only;
    const { speech } = await import('/web/js/speech.js');
    speech.onVoices(() => {});
    const events = [];
    await new Promise((resolve) => {
      speech.speak('你好吗', {
        onStart: () => events.push('start'), onSwitched: (v) => events.push(`switched:${v.name}`),
        onEnd: () => { events.push('end'); resolve(); }, onError: (e) => { events.push(`error:${e.error}:${e.language}`); resolve(); },
      });
      setTimeout(resolve, 3000);
    });
    return events;
  }, only);

  // Both voices exist: the first makes no sound, the second speaks; it is the one kept.
  await page.evaluate(() => { window.__only = false; });
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !!window.aef);
  const both = await run(false);
  assert.deepEqual(both, ['switched:Working Chinese', 'start', 'end'], JSON.stringify(both));
  assert.equal(await page.evaluate(() => localStorage.getItem('aef3.mandarinVoice')), '"working"', 'the voice that speaks is kept');

  // Only the silent one: reading stops with an error (it does not go on).
  await page.evaluate(() => { localStorage.removeItem('aef3.mandarinVoice'); localStorage.setItem('__only', '1'); });
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !!window.aef);
  const only = await run(true);
  assert.deepEqual(only, ['error:silent:zh'], JSON.stringify(only));

  // Ctrl + wheel: the point of the page under the pointer stays there.
  const disc = await page.evaluate(() => fetch('/api/books?scope=local').then((r) => r.json()));
  await page.evaluate((b) => { location.hash = `#/${b.id}/${b.firstPage}`; }, disc[0]);
  await page.waitForSelector('#stage .page-img', { timeout: 20000 });
  await sleep(800);
  const mark = async (fx, fy) => page.evaluate(async (fx, fy) => {
    const r = document.querySelector('#stage .page-img').getBoundingClientRect();
    return { x: r.left + fx * r.width, y: r.top + fy * r.height };
  }, fx, fy);
  // zoom in twice first (so there is room to scroll), then measure at a point off the middle
  await page.evaluate(() => { window.aef.zoomBy(1.6); });
  await sleep(300);
  const at = await mark(0.3, 0.4);
  await page.mouse.move(at.x, at.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel({ deltaY: -100 });
  await page.keyboard.up('Control');
  await sleep(500);
  const after = await mark(0.3, 0.4);
  assert.ok(Math.abs(after.x - at.x) < 6 && Math.abs(after.y - at.y) < 6, `the point stayed under the pointer: ${JSON.stringify(at)} → ${JSON.stringify(after)}`);

  assert.deepEqual(errors, []);
  console.log('PASS: a silent voice is replaced or reading stops; Ctrl + wheel zooms around the pointer');
} finally {
  await browser?.close();
  await stopServer(server);
}

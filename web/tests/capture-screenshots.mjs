// Takes the screenshots used in the rebuild guide.
//   node capture-screenshots.mjs [output folder]   (default: ../../guide/src/images)
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KnownDevices } from 'puppeteer-core';
import { BASE, gotoPage, openBrowser, sleep, startServer, stopServer, wordCenter } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] || path.join(here, '..', '..', 'guide', 'src', 'images'));
mkdirSync(OUT, { recursive: true });

const server = await startServer();
let { browser, page } = await openBrowser();
const shot = async (name) => { await page.screenshot({ path: path.join(OUT, `${name}.png`) }); console.log('saved', name); };
const hoverWord = async (i) => { const c = await wordCenter(page, i); await page.mouse.move(c.x, c.y); await sleep(200); return c; };

try {
  // The library (home screen) and the form to add a book.
  await page.goto(BASE + '#/', { waitUntil: 'networkidle0' });
  await page.click('#library [data-scope="local"]');
  await sleep(800);
  await shot('library');
  await page.click('#lib-add');
  await sleep(300);
  await page.click('.add-kind [data-kind="text"]');
  await page.type('.lib-form input[type=text]', 'The Seaplane Race');
  await page.type('.lib-form textarea', 'Once the boat passed through the bay, he entered open water. It was a lovely day.\n\nThe seaplane was faster.');
  await shot('add-book');
  await page.keyboard.press('Escape');

  await gotoPage(page, '#/1705/25'); // a fresh browser profile, so default settings
  await shot('app-main');

  // Zoom to page width so highlights are easy to see.
  await page.click('#btn-fit');
  await sleep(500);
  await page.$eval('#stage', (s) => { s.scrollTop = 140; });
  await sleep(300);
  await hoverWord(40);
  await shot('mode-sentence-hover');
  const c = await hoverWord(40);
  await page.mouse.click(c.x, c.y);
  await sleep(400);
  await shot('mode-sentence-reading');
  await page.click('#reading-stop');

  await page.click('#mode-seg [data-mode="clause"]');
  await hoverWord(60);
  await shot('mode-clause');
  await page.click('#mode-seg [data-mode="word"]');
  await hoverWord(61);
  await shot('mode-word');
  await page.click('#mode-seg [data-mode="sentence"]');
  await page.mouse.move(5, 300);

  await page.click('#btn-voice');
  await sleep(300);
  await shot('voice-settings');
  await page.click('#btn-voice');

  await page.click('#btn-fit');
  await sleep(2600); // let the "Fit whole page" message fade
  await page.click('#read-page');
  await sleep(700);
  await shot('read-page-aloud');
  await page.click('#reading-stop');

  await page.click('.hs.hs-audio');
  await sleep(1200);
  const cues = await page.$$('#cue-list .cue');
  await cues[3].click();
  await sleep(800);
  await shot('audio-transcript');
  await page.click('#pl-close');

  await page.click('.hs.hs-swf');
  await sleep(3000);
  await shot('answer-key');
  await page.keyboard.press('Escape');

  await page.type('#search-input', 'seaplane');
  await sleep(900);
  await shot('search');
  await page.$eval('#search-input', (i) => { i.value = ''; i.dispatchEvent(new Event('input')); });

  await page.click('.hs.hs-link');
  await sleep(1000);
  await shot('page-link-back');

  await gotoPage(page, '#/1705/12');
  await page.click('.hs.hs-video');
  await sleep(3500);
  await shot('video');
  await page.keyboard.press('Escape');

  await gotoPage(page, '#/1705/24');
  await page.click('#btn-spread');
  await page.click('#btn-pages');
  await sleep(1500);
  await shot('spread-pages');
  await page.click('#drawer [data-dtab="resources"]');
  await sleep(300);
  await shot('resources');
  await page.click('#drawer [data-dtab="pages"]');
  await page.click('#btn-pages');
  await page.click('#btn-spread');

  // My audio (needs the internet to create; the test audio is deleted afterwards).
  await gotoPage(page, '#/1705/25');
  await page.click('.panel [role=tab][data-tab="audio"]');
  await page.click('#rec-new');
  await sleep(200);
  await (await page.$$('#rec-view .pblock .pblock-box input'))[1].click();
  await sleep(300);
  await shot('rec-pick');
  await page.click('#rec-create');
  await page.waitForFunction(() => document.querySelector('.rec-form option[value]'), { timeout: 20000 });
  await page.$eval('.rec-form input[type=text]', (i) => { i.value = 'His trip began in the Miami River'; });
  await page.$eval('.rec-form input[max="10"]', (i) => { i.value = '1'; i.dispatchEvent(new Event('input')); });
  await sleep(200);
  await shot('rec-dialog');
  await page.click('.rec-form .btn.primary');
  await sleep(2500);
  await shot('rec-creating');
  await page.waitForFunction(() => !document.querySelector('#media-dialog').open, { timeout: 120000 });
  await sleep(600);
  await page.click('.rec-spot');
  await sleep(6000);
  await shot('rec-playing');
  await page.click('.panel [role=tab][data-tab="audio"]');
  await sleep(300);
  await shot('rec-list');
  await page.click('#pl-close');
  for (const id of await page.evaluate(() => window.aef.recordings.list.filter((r) => r.title === 'His trip began in the Miami River').map((r) => r.id))) {
    await page.evaluate((i) => fetch(`/api/recordings/${i}`, { method: 'DELETE' }), id);
  }
  await page.evaluate(() => window.aef.recordings.load());

  // Translation (needs the internet the first time; saved in the test's own folder).
  await gotoPage(page, '#/1705/25');
  await page.click('.panel [role=tab][data-tab="text"]');
  await page.click('#btn-translate');
  await sleep(300);
  await page.select('#tr-lang', 'ar');
  await page.waitForFunction(() => document.querySelectorAll('#text-view .tr').length > 20, { timeout: 40000 });
  await shot('tr-menu');
  await page.keyboard.press('Escape');
  await page.click('#btn-fit');
  await sleep(500);
  await page.$eval('#stage', (s) => { s.scrollTop = 140; });
  await sleep(300);
  await page.evaluate(() => { window.realSpeak = speechSynthesis.speak; speechSynthesis.speak = () => {}; });
  const t = await hoverWord(40);
  await page.mouse.click(t.x, t.y);
  await sleep(300);
  await hoverWord(120);
  await sleep(500);
  await shot('tr-panel');
  await page.click('#reading-stop');
  await page.evaluate(() => { speechSynthesis.speak = window.realSpeak; });
  await page.keyboard.press('l'); // translations off again
  await page.click('#btn-fit');
  await sleep(2600);

  // Quick correction in the Text list: double-click a sentence (cancelled again).
  await page.evaluate(() => document.querySelectorAll('#text-view .sline')[6].scrollIntoView({ block: 'center' }));
  const q = await page.evaluateHandle(() => document.querySelectorAll('#text-view .sline')[6].querySelector('.w'));
  await q.click({ count: 2 });
  await sleep(300);
  const lines = await page.$$('#text-view .sline');
  await lines[8].hover(); // shows the dots of another sentence too
  await sleep(400);
  await shot('list-edit');
  await page.keyboard.press('Escape');

  // Text corrections (on Workbook p.10, restored afterwards).
  page.on('dialog', (d) => d.accept());
  await gotoPage(page, '#/1706/10');
  await shot('workbook');
  await page.click('.panel [role=tab][data-tab="text"]');
  await page.click('#edit-text');
  await sleep(300);
  const w = await wordCenter(page, 120);
  await page.mouse.click(w.x, w.y);
  await sleep(800);
  await page.hover('#edit-tools [data-op="mergePrev"]'); // shows the button's tooltip area
  await shot('editor');
  await page.keyboard.press('Enter'); // the selected sentence's text box
  await sleep(300);
  await shot('editor-text');
  await page.keyboard.press('Escape');
  await sleep(200);
  // A drag in progress: the moving sentence follows the pointer, the blue line shows where it goes.
  const hb = await (await page.$('.esent.sel .handle')).boundingBox();
  const dropY = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#text-view .esent')];
    const i = rows.findIndex((r) => r.classList.contains('sel'));
    return rows[Math.min(rows.length - 1, i + 4)].getBoundingClientRect().top + 4;
  });
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 60, dropY, { steps: 8 });
  await sleep(200);
  await shot('editor-drag');
  await page.keyboard.press('Escape'); // cancel the drag
  await page.mouse.up();
  await sleep(200);
  await page.click('#edit-tools [data-op="split"]');
  await sleep(300);
  await shot('editor-split');
  await page.click('.esent.sel [data-op="split-cancel"]');
  await page.click('#edit-tools [data-op="mark"]');
  await sleep(200);
  const pg = await page.$eval('.page', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await page.mouse.move(pg.x + pg.w * 0.12, pg.y + pg.h * 0.62);
  await page.mouse.down();
  await page.mouse.move(pg.x + pg.w * 0.55, pg.y + pg.h * 0.66, { steps: 4 });
  await shot('editor-mark');
  await page.mouse.up();
  await sleep(600);
  await page.click('#edit-reset');
  await sleep(800);
  await page.click('#edit-done');
  await gotoPage(page, '#/1707/6');
  await shot('teachers-book-blank');
  await browser.close();

  ({ browser, page } = await openBrowser({ scheme: 'dark' }));
  await gotoPage(page, '#/1707/150');
  const d = await wordCenter(page, 40);
  await page.mouse.move(d.x, d.y);
  await page.mouse.click(d.x, d.y);
  await sleep(400);
  await shot('dark-mode');
  await browser.close();

  // A phone (iPhone size): reading, with the panel at the bottom; then the page with a translation popup.
  ({ browser, page } = await openBrowser());
  const iphone = KnownDevices['iPhone 13'];
  await page.emulate({ ...iphone, viewport: { ...iphone.viewport, deviceScaleFactor: 1.5 } });
  await gotoPage(page, '#/1705/25');
  await page.evaluate(() => { speechSynthesis.speak = () => {}; });
  await page.touchscreen.tap(...Object.values(await wordCenter(page, 40)));
  await sleep(600);
  await shot('phone');
  await page.click('#reading-stop');
  await page.evaluate(() => { window.aef.translator.setLang('ar'); window.aef.translator.setList(false); });
  await page.click('.panel [role=tab][data-tab="text"]'); // the open tab closes the panel
  await sleep(1500);
  await page.touchscreen.tap(...Object.values(await wordCenter(page, 120)));
  await sleep(1200);
  await page.click('#reading-stop');
  await shot('phone-page');
} finally {
  await browser.close();
  await stopServer(server);
}

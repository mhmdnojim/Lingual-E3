// The Contents tab of the page list (js/contents.js): the books of the level, each opening to its
// lessons; a click on a lesson goes to the page where it starts. And the owner's check of a list
// made by the app (doubts: a page out of order, a page the book has not).
// Run: node web/tests/contents-test.mjs   (needs the disc books of this folder, as ui-test does)
import assert from 'node:assert/strict';

process.env.PORT ||= '18951';
const { startServer, stopServer, openBrowser, sleep, BASE } = await import('./harness.mjs');

let server, browser;
try {
  server = await startServer();
  const opened = await openBrowser({ width: 1400, height: 900 });
  browser = opened.browser;
  const { page } = opened;
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.waitForFunction(() => !!window.aef);
  const disc = await page.evaluate(() => fetch('/api/books?scope=local').then((r) => r.json()));
  assert.ok(disc.length >= 1, 'the disc books are here');
  const withLessons = [];
  for (const b of disc) { const full = await page.evaluate((id) => fetch(`/api/books/${id}`).then((r) => r.json()), b.id); if (full.lessons?.length) withLessons.push(full); }
  assert.ok(withLessons.length >= 1, 'a disc book has lessons');
  const book = withLessons[0];
  const lesson = book.lessons[1];
  const firstPage = Number(/\d+/.exec(lesson.pages)[0]);

  await page.evaluate((id, n) => { location.hash = `#/${id}/${n}`; }, book.id, book.firstPage);
  await page.waitForSelector('#btn-pages');
  await page.click('#btn-pages');
  await page.click('#drawer [data-dtab=contents]');
  await page.waitForSelector('.ct-book .ct-head');
  const heads = await page.$$eval('.ct-book .ct-head .ct-name b', (n) => n.map((x) => x.textContent));
  assert.ok(heads.length >= 1, `books shown: ${heads}`);
  // the book itself is open: its units; open the unit of the lesson and click it
  await page.waitForSelector('.ct-group');
  const unit = await page.evaluate((u) => { const g = [...document.querySelectorAll('.ct-group')].find((b) => b.textContent.includes(u)); g?.click(); return !!g; }, lesson.unit);
  assert.ok(unit, `the unit ${lesson.unit} is listed`);
  const clicked = await page.evaluate((title) => { const b = [...document.querySelectorAll('.ct-item')].find((x) => x.textContent.includes(title)); b?.click(); return !!b; }, lesson.title);
  assert.ok(clicked, `the lesson ${lesson.title} is listed`);
  await page.waitForFunction((n) => location.hash.endsWith(`/${n}`), { timeout: 10000 }, firstPage);

  // The doubts about a list: out of order, a page the book has not, two lines on one page.
  const doubts = await page.evaluate(async () => {
    const { doubts } = await import('/web/js/contents.js');
    return doubts([{ title: 'A', page: 1 }, { title: 'B', page: 5 }, { title: 'C', page: 3 }, { title: 'D', page: 99 }, { title: '', page: 5 }], [1, 2, 3, 4, 5]);
  });
  assert.deepEqual(doubts.map(Boolean), [false, false, true, true, true]);

  assert.deepEqual(errors, []);
  console.log('PASS: Contents tab: books of the level, units, lessons that go to their pages, doubts in a list');
} finally {
  await browser?.close();
  await stopServer(server);
}

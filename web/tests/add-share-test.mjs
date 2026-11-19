// Add a book → "Who can see this book?": Only me (default) / Everyone (licence and confirmation asked,
// sent with the book so it is public as soon as it is made).
// Run: node web/tests/add-share-test.mjs
import assert from 'node:assert/strict';

process.env.PORT ||= '18952';
const { startServer, stopServer, openBrowser, BASE, sleep } = await import('./harness.mjs');
const server = await startServer();
const { browser, page } = await openBrowser({ width: 1300, height: 950 });
const errors = [];
try {
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setRequestInterception(true);
  const posted = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/api/books')) {
      posted.push(JSON.parse(r.postData()));
      return r.respond({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'stop here' }) });
    }
    r.continue();
  });
  await page.goto(BASE + '#/'); await sleep(1500);
  await page.click('#lib-add');
  await page.waitForSelector('.add-who');
  assert.equal(await page.$eval('.add-who input[value="private"]', (e) => e.checked), true, 'private is the default');
  assert.equal(await page.$eval('.add-who .share-box', (e) => e.hidden), true);
  await page.click('.add-who input[value="public"]');
  assert.equal(await page.$eval('.add-who .share-box', (e) => e.hidden), false, 'licence and confirmation shown');
  // A text book with Everyone but no licence: refused before sending.
  await page.click('.add-kind [data-kind="text"]');
  const titleSel = await page.evaluate(() => { const i = [...document.querySelectorAll('.add-form input')].find((x) => x.closest('label')?.textContent.startsWith('Title')); i.setAttribute('data-t', '1'); return 'input[data-t]'; });
  await page.type(titleSel, 'Shared book');
  await page.evaluate(() => { const t = document.querySelector('.add-form textarea'); t.value = 'Hello there. This is a page.'; t.dispatchEvent(new Event('input')); });
  await page.click('.add-bar .btn.primary');
  await sleep(600);
  assert.match(await page.$eval('.form-msg', (e) => e.textContent), /licence/);
  assert.equal(posted.length, 0);
  await page.select('.add-who select', 'own');
  await page.click('.add-bar .btn.primary'); await sleep(300);
  assert.match(await page.$eval('.form-msg', (e) => e.textContent), /confirm/);
  await page.click('.add-who .share-box input[type=checkbox]');
  await page.click('.add-bar .btn.primary'); await sleep(600);
  assert.equal(posted.length, 1);
  assert.deepEqual([posted[0].shareWhenReady, posted[0].license, posted[0].rights], [true, 'own', true]);
  assert.deepEqual(errors, []);
  console.log('PASS: Add a book asks who can see it; Everyone needs a licence and a confirmation and is sent with the book');
} finally {
  await browser.close();
  await stopServer(server);
}

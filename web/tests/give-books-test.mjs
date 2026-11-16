// Admin → Give books (js/give-books.js, library.give): only an admin may give; the part lists the
// accounts; nothing chosen is refused. (The copying itself: test_give_books.py.)
// Run: node web/tests/give-books-test.mjs
import assert from 'node:assert/strict';

process.env.PORT ||= '8841';
const { startServer, stopServer, openBrowser } = await import('./harness.mjs');
const base = `http://127.0.0.1:${process.env.PORT}`;
const client = () => {
  let cookie = '';
  return async (method, p, body) => {
    const r = await fetch(base + p, { method, redirect: 'manual',
      headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
};
const server = await startServer({ args: ['--public'], env: { LB_ADMIN_EMAIL: 'boss@example.com', LB_ADMIN_SETUP_TOKEN: 'owner-code-1', LB_PUBLIC_URL: 'https://books.example.com' } });
const { browser, page } = await openBrowser({ width: 1280, height: 900 });
const errors = [];
try {
  page.on('pageerror', (e) => errors.push(e.message));
  const boss = client(), ann = client();
  await boss('POST', '/api/signup', { email: 'boss@example.com', name: 'Boss', password: 'secret-123', adminSetupCode: 'owner-code-1' });
  const a = (await ann('POST', '/api/signup', { email: 'ann@example.com', name: 'Ann', password: 'secret-123' })).data.user;
  assert.equal((await ann('POST', '/api/admin/book-gifts', { books: ['Labc0000001'], users: [a.id] })).status, 403, 'a user cannot give');
  const none = await boss('POST', '/api/admin/book-gifts', { books: [], users: [a.id] });
  assert.equal(none.status, 400, 'nothing chosen');
  const unknown = await boss('POST', '/api/admin/book-gifts', { books: ['Labc0000001'], users: [a.id] });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.data.copies, 0);
  assert.match(unknown.data.problems[0], /not found/);

  await page.goto(`${base}/web/#/`, { waitUntil: 'load' });
  await page.waitForSelector('#lib-account .btn:not(.primary)', { visible: true, timeout: 15000 });
  await page.click('#lib-account .btn:not(.primary)');
  await page.waitForSelector('.lib-form input[type=email]', { visible: true });
  await page.type('.lib-form input[type=email]', 'boss@example.com');
  await page.type('.lib-form input[type=password][required]', 'secret-123');
  await page.click('.lib-form button[type=submit]');
  await page.waitForFunction(() => !document.querySelector('#library [data-scope="admin"]').hidden, { timeout: 10000 });
  await page.click('#library [data-scope="admin"]');
  await page.waitForSelector('[data-admin-tab="give"]');
  await page.click('[data-admin-tab="give"]');
  await page.waitForSelector('.give .give-col');
  assert.ok(await page.$eval('.give', (e) => /Ann/.test(e.textContent)), 'the accounts are listed');
  assert.equal(await page.$eval('.give-go button', (b) => b.disabled), true, 'nothing chosen: Give is off');
  assert.deepEqual(errors, []);
  console.log('PASS: Give books: only admins; the part lists the accounts; nothing chosen is refused');
} finally {
  await browser.close();
  await stopServer(server);
}

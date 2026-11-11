// Offline use of a website (web/sw.js, js/offline-lock.js): a book opened online is shown again
// without the network (the app's files, the page's picture and text come from the service
// worker's cache); the app says how long it still works; when the plan's offline time is over,
// or the device's clock was moved back, the whole app locks until the server is reached again,
// and then opens at once; an account whose "Offline use" is switched off gets no service worker.
// Run: node web/tests/offline-lock-test.mjs
import assert from 'node:assert/strict';

process.env.PORT ||= '8835';
const { startServer, stopServer, openBrowser, sleep } = await import('./harness.mjs');
const base = `http://127.0.0.1:${process.env.PORT}`;

const client = () => {
  let cookie = '';
  return async (method, p, body, raw) => {
    const r = await fetch(base + p, { method, redirect: 'manual',
      headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': raw ? 'application/octet-stream' : 'application/json' },
      body: raw || (body !== undefined ? JSON.stringify(body) : undefined) });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
};

const server = await startServer({ args: ['--public'], env: {
  LB_ADMIN_EMAIL: 'boss@example.com', LB_REQUIRE_SUBSCRIPTION: '1', LB_ADMIN_SETUP_TOKEN: 'owner-code-1',
  LB_PUBLIC_URL: 'https://books.example.com' } });
const { browser, page } = await openBrowser({ width: 1100, height: 800 });
const errors = [];
try {
  const boss = client(), ann = client();
  await boss('POST', '/api/signup', { email: 'boss@example.com', name: 'Boss', password: 'secret-123', adminSetupCode: 'owner-code-1' });
  await ann('POST', '/api/signup', { email: 'ann@example.com', name: 'Ann', password: 'secret-123' });
  // A short text book of the admin's, shared.
  const book = (await boss('POST', '/api/books', { kind: 'text', title: 'Offline lesson' })).data;
  await boss('PUT', `/api/books/${book.id}/source/text`, undefined, Buffer.from(JSON.stringify({ text: 'Reading works offline. The lock comes later.' })));
  await boss('POST', `/api/books/${book.id}/make`, {});
  for (let i = 0; i < 120; i++) {
    const j = (await boss('GET', `/api/books/${book.id}/job`)).data;
    if (j.status === 'ready') break;
    await sleep(500);
  }
  await boss('PUT', `/api/books/${book.id}`, { visibility: 'public', license: 'own' });

  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  const logIn = async (p, email) => {
    await p.goto(`${base}/web/#/`, { waitUntil: 'load' });
    await p.waitForSelector('#lib-account .btn:not(.primary)', { visible: true, timeout: 15000 });
    await p.click('#lib-account .btn:not(.primary)');
    await p.waitForSelector('.lib-form input[type=email]', { visible: true, timeout: 10000 });
    await p.type('.lib-form input[type=email]', email);
    await p.type('.lib-form input[type=password][required]', 'secret-123');
    await p.click('.lib-form button[type=submit]');
    await p.waitForFunction(() => window.aef?.me?.user, { timeout: 10000 });
  };
  const pageShown = (p) => p.waitForFunction(() => { const i = document.querySelector('.page-img'); return i && i.naturalWidth > 0; }, { timeout: 20000 });

  // Online: the book opens; the service worker is there and keeps what was shown.
  await logIn(page, 'boss@example.com');
  const lease = await page.evaluate(() => JSON.parse(localStorage.getItem('aef3.lease')));
  assert.ok(lease && lease.until > lease.at + 3 * 86400 - 60, `the lease (3 days by default): ${JSON.stringify(lease)}`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.goto(`${base}/web/#/${book.id}/p1`, { waitUntil: 'load' });
  await pageShown(page);
  await page.waitForFunction(async (id) => Boolean(await caches.match(`/lib/${id}/pages/1.webp`, { ignoreSearch: true }))
    && Boolean(await caches.match(`/api/text/${id}/p1`, { ignoreSearch: true })), { timeout: 15000 }, book.id);

  // Offline: the same page again, and the sign of how long the app still works.
  await page.setOfflineMode(true);
  await page.reload({ waitUntil: 'load' });
  await pageShown(page);
  await page.evaluate(() => window.aef.offlineLock.tick());
  await page.waitForFunction(() => /Offline · works (3 d 0 h|2 d 23 h) more/.test(document.querySelector('#offline-pill')?.textContent || ''), { timeout: 10000 });
  assert.ok(await page.$eval('#offline-lock', (b) => b.hidden).catch(() => true), 'not locked while the time runs');

  // The time is over: locked. The server reached again: open at once.
  await page.evaluate(() => { const l = JSON.parse(localStorage.getItem('aef3.lease')); l.until = Math.floor(Date.now() / 1000) - 5; localStorage.setItem('aef3.lease', JSON.stringify(l)); });
  await page.evaluate(() => window.aef.offlineLock.tick());
  await page.waitForFunction(() => !document.querySelector('#offline-lock')?.hidden && /time the app may stay offline is over/.test(document.querySelector('#offline-lock').textContent), { timeout: 10000 });
  assert.ok(await page.$eval('body', (b) => b.classList.contains('offline-locked')));
  await page.setOfflineMode(false);
  await page.evaluate(() => [...document.querySelectorAll('#offline-lock button')].find((b) => b.textContent === 'Try again').click());
  await page.waitForFunction(() => document.querySelector('#offline-lock')?.hidden, { timeout: 10000 });
  const fresh = await page.evaluate(() => JSON.parse(localStorage.getItem('aef3.lease')));
  assert.ok(fresh.until > Math.floor(Date.now() / 1000) + 3 * 86400 - 120, 'a new lease from the server');

  // The clock moved back: locked too.
  await page.setOfflineMode(true);
  await page.evaluate(() => { const l = JSON.parse(localStorage.getItem('aef3.lease')); l.at = Math.floor(Date.now() / 1000) + 3600; localStorage.setItem('aef3.lease', JSON.stringify(l)); });
  await page.evaluate(() => window.aef.offlineLock.tick());
  await page.waitForFunction(() => /clock of this device was moved back/.test(document.querySelector('#offline-lock')?.textContent || ''), { timeout: 10000 });
  await page.setOfflineMode(false);

  // Ann, "Offline use" switched off: no service worker for her.
  const users = (await boss('GET', '/api/admin/users')).data.users;
  const annId = users.find((u) => u.name === 'Ann').id;
  await boss('POST', '/api/admin/features', { users: [annId], feature: 'offline', value: false });
  const ctx = await browser.createBrowserContext();
  const annPage = await ctx.newPage();
  annPage.on('pageerror', (e) => errors.push(`ann: ${e.message}`));
  await logIn(annPage, 'ann@example.com');
  await sleep(1500);
  assert.equal(await annPage.evaluate(() => navigator.serviceWorker.getRegistrations().then((r) => r.length)), 0);
  assert.equal(await annPage.evaluate(() => window.aef.me.features.offline), false);
  await ctx.close();
  assert.deepEqual(errors, []);
  console.log('offline-lock-test: PASS');
} catch (err) {
  const where = String(err.stack || '').split(/\r?\n/).filter((l) => l.includes('offline-lock-test.mjs')).slice(0, 2).join(' | ');
  const state = await page.evaluate(() => ({ online: navigator.onLine, user: window.aef?.me?.user?.name, pill: document.querySelector('#offline-pill')?.textContent,
    lock: document.querySelector('#offline-lock')?.textContent?.slice(0, 120), hidden: document.querySelector('#offline-lock')?.hidden,
    lease: localStorage.getItem('aef3.lease'), sw: Boolean(navigator.serviceWorker.controller) })).catch((e) => String(e));
  console.error('offline-lock-test: FAIL', err.message, '| at', where, '| state', JSON.stringify(state));
  process.exitCode = 1;
} finally {
  await browser.close();
  await stopServer(server);
}

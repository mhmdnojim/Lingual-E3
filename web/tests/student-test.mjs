// A student's computer (web/student.py, server.py --student): two real servers — the website
// (--public, with a shared book) and the student's copy pointed at it. In the browser: no disc, no
// public library; "Log in to the website" with the website account; the Website tab lists the
// book; Download brings it into My books and it opens; the website unreachable: the lease keeps
// the app going, and when the lease is over the app locks; the website back: "Try again" opens it.
// Run: node web/tests/student-test.mjs
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

process.env.PORT ||= '8837';
const { startServer, stopServer, openBrowser, sleep } = await import('./harness.mjs');
const sitePort = Number(process.env.PORT) + 1;
const site = `http://127.0.0.1:${sitePort}`;
const base = `http://127.0.0.1:${process.env.PORT}`;

const client = () => {
  let cookie = '';
  return async (method, p, body, raw) => {
    const r = await fetch(site + p, { method, redirect: 'manual',
      headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': raw ? 'application/octet-stream' : 'application/json' },
      body: raw || (body !== undefined ? JSON.stringify(body) : undefined) });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
};

const siteServer = await startServer({ port: sitePort, args: ['--public'], env: {
  LB_ADMIN_EMAIL: 'boss@example.com', LB_REQUIRE_SUBSCRIPTION: '1', LB_ADMIN_SETUP_TOKEN: 'owner-code-1', LB_PUBLIC_URL: 'https://books.example.com' } });
const student = await startServer({ args: ['--student', site] });
const { browser, page } = await openBrowser({ width: 1100, height: 800 });
const errors = [];
try {
  const boss = client(), ann = client();
  await boss('POST', '/api/signup', { email: 'boss@example.com', name: 'Boss', password: 'secret-123', adminSetupCode: 'owner-code-1' });
  await ann('POST', '/api/signup', { email: 'ann@example.com', name: 'Ann', password: 'secret-123' }); // (her free trial: 3 days)
  const book = (await boss('POST', '/api/books', { kind: 'text', title: 'Student lesson' })).data;
  await boss('PUT', `/api/books/${book.id}/source/text`, undefined, Buffer.from(JSON.stringify({ text: 'This lesson was downloaded. It opens without internet.' })));
  await boss('POST', `/api/books/${book.id}/make`, {});
  for (let i = 0; i < 120; i++) {
    if ((await boss('GET', `/api/books/${book.id}/job`)).data.status === 'ready') break;
    await sleep(500);
  }
  const shared = await boss('PUT', `/api/books/${book.id}`, { visibility: 'public', license: 'own', rights: true });
  assert.equal(shared.status, 200, JSON.stringify(shared.data));
  const seen = (await ann('GET', '/api/books?scope=public')).data;
  assert.ok(Array.isArray(seen) && seen.some((b) => b.id === book.id), `Ann sees the shared book on the website: ${JSON.stringify(seen)}`);

  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(`${base}/web/#/`, { waitUntil: 'load' });
  await page.waitForFunction(() => !document.querySelector('#library [data-scope="site"]')?.hidden, { timeout: 15000 }); // (the library drawn)
  const tabs = await page.$$eval('#library [role=tab]:not([hidden])', (t) => t.map((x) => x.dataset.scope));
  assert.deepEqual(tabs, ['mine', 'site'], `no disc, no public library: ${tabs}`);
  assert.equal(await page.$eval('#lib-account', (b) => b.textContent.trim()), 'Log in to the website');

  // Log in with the website account (the website counts this computer as a device).
  await page.click('#lib-account .btn');
  await page.waitForSelector('.lib-form input[type=email]', { visible: true, timeout: 10000 });
  await page.type('.lib-form input[type=email]', 'ann@example.com');
  await page.type('.lib-form input[type=password][required]', 'wrong-pass');
  await page.click('.lib-form button[type=submit]');
  await page.waitForFunction(() => /Wrong e-mail or password/.test(document.querySelector('.lib-form .form-msg')?.textContent || ''), { timeout: 10000 });
  await page.$eval('.lib-form input[type=password][required]', (i) => { i.value = ''; });
  await page.type('.lib-form input[type=password][required]', 'secret-123');
  await page.click('.lib-form button[type=submit]');
  await page.waitForFunction(() => window.aef?.me?.user?.name === 'Ann', { timeout: 10000 });
  const users = (await boss('GET', '/api/admin/users')).data.users;
  const annId = users.find((u) => u.name === 'Ann').id;
  const devices = (await boss('GET', `/api/admin/users/${annId}`)).data.devices;
  assert.ok(devices.some((d) => d.name === 'Lingua Books app on Windows'), JSON.stringify(devices)); // (and the test's own API client)

  // The Website tab: the book, downloaded, then open.
  await page.click('#library [data-scope="site"]');
  await page.waitForSelector(`[data-download="${book.id}"]`, { timeout: 15000 });
  await page.click(`[data-download="${book.id}"]`);
  await page.waitForFunction((id) => /on this computer/.test(document.querySelector(`.site-book[data-book="${id}"]`)?.textContent || ''), { timeout: 30000 }, book.id);
  await page.goto(`${base}/web/#/${book.id}/p1`, { waitUntil: 'load' });
  await page.waitForFunction(() => { const i = document.querySelector('.page-img'); return i && i.naturalWidth > 0; }, { timeout: 20000 });
  const text = await fetch(`${base}/api/text/${book.id}/p1`).then((r) => r.json());
  assert.ok(text.words.some((w) => w[4] === 'downloaded.'), 'the text is here');

  // The website unreachable: the lease keeps the app going; the lease over: locked; back: open.
  const config = path.join(student.data, 'server-config.json');
  const saved = JSON.parse(readFileSync(config, 'utf-8'));
  writeFileSync(config, JSON.stringify({ ...saved, studentSite: 'http://127.0.0.1:1' }));
  await fetch(`${base}/api/student/refresh`, { method: 'POST' });
  let me = await fetch(`${base}/api/me`).then((r) => r.json());
  assert.ok(!me.student.online && !me.locked && me.user, JSON.stringify(me.student));
  await page.evaluate(() => window.aef.offlineLock.tick());
  await page.waitForFunction(() => /Offline · works/.test(document.querySelector('#offline-pill')?.textContent || ''), { timeout: 10000 });
  const lease = { ...JSON.parse(readFileSync(config, 'utf-8')).studentLease, until: Math.floor(Date.now() / 1000) - 5 };
  writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf-8')), studentLease: lease }));
  assert.equal((await fetch(`${base}/api/text/${book.id}/p1`)).status, 423, 'the books refused while locked');
  await page.evaluate(() => window.aef.offlineLock.tick());
  await page.waitForFunction(() => !document.querySelector('#offline-lock')?.hidden && /stay offline is over/.test(document.querySelector('#offline-lock').textContent), { timeout: 10000 });
  writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf-8')), studentSite: site }));
  await page.evaluate(() => [...document.querySelectorAll('#offline-lock button')].find((b) => b.textContent === 'Try again').click());
  await page.waitForFunction(() => document.querySelector('#offline-lock')?.hidden, { timeout: 10000 });
  assert.equal((await fetch(`${base}/api/text/${book.id}/p1`)).status, 200);

  // Logged out: the website frees the device; the books are refused.
  await fetch(`${base}/api/logout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const left = (await boss('GET', `/api/admin/users/${annId}`)).data.devices;
  assert.ok(!left.some((d) => d.name === 'Lingua Books app on Windows'), `the computer unlinked: ${JSON.stringify(left)}`);
  assert.equal((await fetch(`${base}/api/text/${book.id}/p1`)).status, 423);
  assert.deepEqual(errors, []);
  console.log('student-test: PASS');
} catch (err) {
  const where = String(err.stack || '').split(/\r?\n/).filter((l) => l.includes('student-test.mjs')).slice(0, 2).join(' | ');
  const state = await page.evaluate(() => ({ user: window.aef?.me?.user?.name, student: window.aef?.me?.student, lock: document.querySelector('#offline-lock')?.textContent?.slice(0, 100),
    body: document.querySelector('#lib-body')?.textContent?.slice(0, 200) })).catch((e) => String(e));
  console.error('student-test: FAIL', err.message, '| at', where, '| state', JSON.stringify(state));
  process.exitCode = 1;
} finally {
  await browser.close();
  await stopServer(student);
  await stopServer(siteServer);
}

// Plans, the free trial and "I paid" on a website (web/plans.py, js/plans.js): the admin sets the
// free trial and makes a plan in Admin → Plans and payments, with a payment QR picture; a new
// account gets the trial by itself; without a plan the library says so and shows the plans; the
// user presses "I paid" with a note; the admin sees the request and approves it; the user has
// access (the plan's days and offline time). A user cannot change plans or approve anything.
// Run: node web/tests/plans-test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PORT ||= '8833';
const { startServer, stopServer, openBrowser, sleep } = await import('./harness.mjs');
const base = `http://127.0.0.1:${process.env.PORT}`;
// (a 1 × 1 PNG)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'lb-plans-'));
const qr = path.join(tmp, 'qr.png');
writeFileSync(qr, PNG);

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

const server = await startServer({ args: ['--public'], env: {
  LB_ADMIN_EMAIL: 'boss@example.com', LB_REQUIRE_SUBSCRIPTION: '1', LB_ADMIN_SETUP_TOKEN: 'owner-code-1',
  LB_PUBLIC_URL: 'https://books.example.com' } });
const { browser, page } = await openBrowser({ width: 1280, height: 900 });
const errors = [];
try {
  const boss = client(), ann = client(), bob = client();
  await boss('POST', '/api/signup', { email: 'boss@example.com', name: 'Boss', password: 'secret-123', adminSetupCode: 'owner-code-1' });
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
  };
  const says = (p, sel, re) => p.waitForFunction((s, src) => new RegExp(src).test(document.querySelector(s)?.textContent || ''), { timeout: 10000 }, sel, re.source);

  // The admin: the free trial of 2 days, a plan with its QR picture.
  await logIn(page, 'boss@example.com');
  await page.waitForFunction(() => !document.querySelector('#library [data-scope="admin"]').hidden, { timeout: 10000 });
  await page.click('#library [data-scope="admin"]');
  await page.waitForSelector('[data-admin-tab="plans"]', { timeout: 10000 });
  await page.click('[data-admin-tab="plans"]');
  await says(page, '.plans-admin', /No plans yet/);
  await page.$eval('.plans-admin input[aria-label="Days of the free trial"]', (i) => { i.value = '2'; });
  await page.evaluate(() => [...document.querySelectorAll('.plans-admin button')].find((b) => b.textContent === 'Save').click());
  await sleep(400);
  await page.evaluate(() => [...document.querySelectorAll('.plans-admin button')].find((b) => b.textContent === 'New plan').click());
  await page.waitForSelector('.plan-form', { timeout: 10000 });
  await page.type('.plan-form input[type=text]', 'One month');
  await page.type('.plan-form input[placeholder^="As it is shown"]', '¥30');
  await page.click('.plan-form button[type=submit]');
  await page.waitForSelector('.plan-qr-edit', { timeout: 10000 });
  await (await page.$('.plan-qr-edit [data-qr="1"] input[type=file]')).uploadFile(qr);
  await page.type('.plan-qr-edit [data-qr="1"] input[type=text]', 'WeChat Pay');
  await page.evaluate(() => document.querySelector('.plan-qr-edit [data-qr="1"] button').click());
  await page.waitForSelector('.plan-qr-edit [data-qr="1"] .plan-qr-small', { timeout: 10000 });
  await page.keyboard.press('Escape');
  const made = (await boss('GET', '/api/admin/plans')).data;
  assert.equal(made.trialDays, 2);
  assert.deepEqual(made.plans.map((p) => [p.name, p.price, p.days, p.qr.length, p.qr[0]?.label]), [['One month', '¥30', 30, 1, 'WeChat Pay']]);
  const plan = made.plans[0].id;

  // A new account: the free trial by itself. Bob's trial is taken away: he has no plan.
  let r = await ann('POST', '/api/signup', { email: 'ann@example.com', name: 'Ann', password: 'secret-123' });
  assert.equal(r.status, 200);
  let me = (await ann('GET', '/api/me')).data.subscription;
  assert.ok(me.active && Math.abs(me.expiresAt - (Date.now() / 1000 + 2 * 86400)) < 60, JSON.stringify(me));
  await bob('POST', '/api/signup', { email: 'bob@example.com', name: 'Bob', password: 'secret-123' });
  const users = Object.fromEntries((await boss('GET', '/api/admin/users')).data.users.map((u) => [u.name, u.id]));
  const trial = (await boss('GET', `/api/admin/users/${users.Bob}`)).data.grants[0];
  assert.equal(trial.label, 'Free trial');
  await boss('POST', `/api/admin/users/${users.Bob}`, { action: 'revoke-plan', grant: trial.id });
  assert.equal((await bob('GET', '/api/books?scope=public')).status, 403, 'no plan: no books');
  assert.equal((await bob('GET', '/api/plans')).status, 200, 'the plans are seen without one');
  assert.equal((await bob('POST', '/api/admin/plans', { name: 'Free', days: 999 })).status, 403);
  assert.equal((await bob('GET', '/api/admin/plans')).status, 403);

  // Bob in the browser: "A plan is needed" → the plans → "I paid" with a note.
  const ctx = await browser.createBrowserContext();
  const bobPage = await ctx.newPage();
  bobPage.on('pageerror', (e) => errors.push(`user: ${e.message}`));
  await logIn(bobPage, 'bob@example.com');
  await says(bobPage, '#lib-body', /A plan is needed[\s\S]*See the plans/); // (logged in: the plans, not "Create an account")
  await bobPage.evaluate(() => [...document.querySelectorAll('#lib-body button')].find((b) => b.textContent === 'See the plans').click());
  await bobPage.waitForSelector(`.plan-card[data-plan="${plan}"]`, { timeout: 10000 });
  const card = await bobPage.$eval('.plan-card', (c) => ({ text: c.textContent, qr: c.querySelector('.plan-qrs img')?.naturalWidth }));
  assert.match(card.text, /One month.*¥30.*30 days.*All shared books.*offline up to 3 days.*WeChat Pay/);
  await bobPage.waitForFunction(() => document.querySelector('.plan-qrs img')?.naturalWidth > 0, { timeout: 10000 });
  await bobPage.click(`[data-paid="${plan}"]`);
  await bobPage.type('.plan-paid textarea', 'By WeChat at 14:05');
  await bobPage.evaluate(() => [...document.querySelectorAll('.plan-paid button')].find((b) => b.textContent === 'Send to the admin').click());
  await says(bobPage, '.plan-card', /waiting for the admin/);
  assert.equal((await bob('POST', `/api/plans/${plan}/paid`, {})).status, 400, 'one open request per plan');
  const request = (await bob('GET', '/api/plans')).data.requests[0];
  assert.equal((await bob('POST', `/api/admin/payment-requests/${request.id}`, { action: 'approve' })).status, 403, 'not by himself');

  // The admin sees it and approves; Bob has the plan.
  await page.click('[data-admin-tab="books"]');
  await says(page, '.admin', /Reports \(/);
  await page.click('[data-admin-tab="plans"]');
  await says(page, '.plans-admin', /Payments to check \(1\)[\s\S]*Bob[\s\S]*By WeChat at 14:05/);
  await page.type('.plans-admin input[aria-label="Amount received"]', '¥30');
  await page.click(`[data-approve="${request.id}"]`);
  await says(page, '.plans-admin', /Payments to check \(0\)[\s\S]*Approved[\s\S]*Recorded: ¥30/);
  me = (await bob('GET', '/api/me')).data.subscription;
  assert.ok(me.active && me.offlineMinutes === 4320 && Math.abs(me.expiresAt - (Date.now() / 1000 + 30 * 86400)) < 60, JSON.stringify(me));
  assert.equal((await bob('GET', '/api/books?scope=public')).status, 200);
  assert.equal((await boss('POST', `/api/admin/payment-requests/${request.id}`, { action: 'approve' })).status, 400, 'never twice');
  // Statistics: Bob's use today (his page and the approved payment), everyone and him alone.
  await bob('POST', '/api/activity', { what: 'read' });
  await page.click('[data-admin-tab="stats"]');
  await page.waitForSelector('.stats-tiles', { timeout: 10000 });
  const tiles = await page.$eval('.stats-body', (b) => b.textContent);
  assert.match(tiles, /1Accounts active[\s\S]*3Signed up[\s\S]*1Payments approved[\s\S]*¥30Money recorded/, tiles); // (the number, then its label)
  await page.select('.stats-admin select[aria-label="Whose"]', String(users.Bob));
  await page.waitForFunction(() => /Day by day/.test(document.querySelector('.stats-body')?.textContent || ''), { timeout: 10000 });
  assert.match(await page.$eval('.stats-body', (b) => b.textContent), /1Days active/);
  assert.equal((await bob('GET', '/api/admin/stats')).status, 403);
  await ctx.close();
  assert.deepEqual(errors, []);
  console.log('plans-test: PASS');
} catch (err) {
  console.error('plans-test: FAIL', err);
  process.exitCode = 1;
} finally {
  await browser.close();
  await stopServer(server);
  rmSync(tmp, { recursive: true, force: true });
}

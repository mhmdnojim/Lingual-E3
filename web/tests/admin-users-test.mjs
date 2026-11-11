// The Users tab of the Admin page on a website (web/admin_users.py, js/admin-users.js): the owner
// (LB_ADMIN_EMAIL) sees every account, finds one, gives it plan days without a code, makes it an
// admin and a user again, blocks it (it cannot log in) and unblocks it, gives it a new password,
// and deletes it. A helper admin sees no "Make admin" and cannot change the owner's account; the
// server refuses it too, and refuses a helper admin's change of an API key. The Admin page's
// other parts (Books and reports, Access codes) are still there.
// Run: node web/tests/admin-users-test.mjs
import assert from 'node:assert/strict';

process.env.PORT ||= '8831';
const { startServer, stopServer, openBrowser, sleep } = await import('./harness.mjs');
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

const server = await startServer({ args: ['--public'], env: {
  LB_ADMIN_EMAIL: 'boss@example.com', LB_REQUIRE_SUBSCRIPTION: '1', LB_ADMIN_SETUP_TOKEN: 'owner-code-1',
  LB_PUBLIC_URL: 'https://books.example.com' } });
const { browser, page } = await openBrowser({ width: 1280, height: 900 });
const errors = [];
try {
  const boss = client(), ann = client(), bob = client();
  assert.equal((await boss('POST', '/api/signup', { email: 'boss@example.com', name: 'Boss', password: 'secret-123', adminSetupCode: 'owner-code-1' })).data.user.role, 'owner');
  assert.equal((await ann('POST', '/api/signup', { email: 'ann@example.com', name: 'Ann', password: 'secret-123' })).data.user.role, 'user');
  assert.equal((await bob('POST', '/api/signup', { email: 'bob@example.com', name: 'Bob', password: 'secret-123' })).status, 200);
  const users = (await boss('GET', '/api/admin/users')).data.users;
  const id = Object.fromEntries(users.map((u) => [u.name, u.id]));
  assert.equal((await ann('GET', '/api/admin/users')).status, 403, 'a user sees no accounts');

  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  const logIn = async (p, email) => {
    // (not "network idle": a website that asks for a plan keeps asking the server while nobody is logged in)
    await p.goto(`${base}/web/#/`, { waitUntil: 'load' });
    await p.waitForSelector('#lib-account .btn:not(.primary)', { visible: true, timeout: 15000 });
    await p.click('#lib-account .btn:not(.primary)');
    await p.waitForSelector('.lib-form input[type=email]', { visible: true, timeout: 10000 });
    await p.type('.lib-form input[type=email]', email);
    await p.type('.lib-form input[type=password][required]', 'secret-123');
    await p.click('.lib-form button[type=submit]');
    await p.waitForFunction(() => !document.querySelector('#library [data-scope="admin"]').hidden, { timeout: 10000 });
    await p.click('#library [data-scope="admin"]');
    await p.waitForSelector('.users-table tbody tr[data-user]', { timeout: 10000 });
  };
  const rows = (p) => p.$$eval('.users-table tbody tr[data-user]', (r) => r.map((x) => x.textContent));
  /** Open an account's page; then the text of the dialog. */
  const open = async (p, uid) => {
    await p.click(`.users-table tr[data-user="${uid}"] button`);
    await p.waitForFunction(() => /^User: /.test(document.querySelector('#md-title')?.textContent || ''), { timeout: 10000 });
    return p.$eval('#md-body', (b) => b.textContent);
  };
  const button = (p, label) => p.evaluate((l) => {
    const b = [...document.querySelectorAll('#md-body button')].find((x) => x.textContent === l);
    if (b) b.click();
    return Boolean(b);
  }, label);
  /** Wait until the account's page says this. */
  const says = (p, re) => p.waitForFunction((src) => new RegExp(src).test(document.querySelector('#md-body')?.textContent || ''), { timeout: 10000 }, re.source);

  // The owner: every account, the roles, finding one.
  await logIn(page, 'boss@example.com');
  const listed = await rows(page);
  assert.equal(listed.length, 3);
  assert.ok(listed.some((t) => /Boss.*You.*Owner/.test(t)), listed.join(' | '));
  await page.type('.users-tools input', 'ann');
  assert.equal((await rows(page)).length, 1);

  // Plan days without a code: 30, then they show; the server agrees.
  let text = await open(page, id.Ann);
  assert.match(text, /Free trial/); // (a new account's free days, given by itself)
  await page.click('.give-days [data-days="30"]');
  assert.match(await page.$eval('.give-until', (x) => x.textContent), /Access until/);
  assert.ok(await button(page, 'Give the days'));
  await says(page, /Given by Boss/);
  assert.equal((await ann('GET', '/api/me')).data.subscription.active, true, 'Ann has a plan now');

  // Features: Translation off for Ann (the server refuses it, her page hides it), on again;
  // off for everyone (Bob too), on again; for the chosen users.
  await boss('POST', `/api/admin/users/${id.Bob}`, { action: 'give-days', days: 5, books: '*' }); // (Bob has a plan too)
  const translate = (who) => who('POST', '/api/translate', { lang: 'fr', book: 'L0000000000', page: 'p1', paragraphs: [] });
  await page.click('.user-features input[data-feature="translation"]');
  await says(page, /off here/);
  let refused = await translate(ann);
  assert.ok(refused.status === 403 && refused.data.feature === 'translation', JSON.stringify(refused));
  assert.equal((await ann('GET', '/api/me')).data.features.translation, false);
  assert.notEqual((await translate(bob)).data.feature, 'translation', 'Bob is not touched');
  assert.equal((await ann('POST', '/api/books', { kind: 'text', title: 'Still allowed' })).status, 200);
  assert.ok(await button(page, 'As for everyone again'));
  await page.waitForFunction(() => !/off here/.test(document.querySelector('#md-body').textContent), { timeout: 10000 });
  assert.notEqual((await translate(ann)).data.feature, 'translation');
  let all = await boss('POST', '/api/admin/features', { users: 'everyone', feature: 'add_books', value: false });
  assert.equal(all.data.features.find((f) => f.key === 'add_books').on, false);
  refused = await bob('POST', '/api/books', { kind: 'text', title: 'No' });
  assert.ok(refused.status === 403 && /switched off adding books/.test(refused.data.error), JSON.stringify(refused));
  assert.equal((await boss('POST', '/api/books', { kind: 'text', title: 'Admins always' })).status, 200);
  await boss('POST', '/api/admin/features', { users: [id.Bob], feature: 'add_books', value: true });
  assert.equal((await bob('GET', '/api/me')).data.features.add_books, true, 'his own setting counts first');
  await boss('POST', '/api/admin/features', { users: 'everyone', feature: 'add_books', value: null });
  assert.equal((await ann('POST', '/api/admin/features', { users: 'everyone', feature: 'words', value: false })).status, 403);

  // Paid AI: off until an amount is given; given here, the server counts it.
  assert.deepEqual((await ann('GET', '/api/me')).data.ai, { scripts: 0, pictures: 0, layout: 0 });
  assert.equal((await ann('GET', '/api/speech-ai')).data.can, false);
  await page.type('.ai-kind[data-ai="scripts"] input[type=number]', '30');
  await page.click('[data-give-ai="scripts"]');
  await says(page, /30 minutes left/);
  await page.type('.ai-kind[data-ai="pictures"] input[type=number]', '2');
  await page.click('[data-give-ai="pictures"]');
  await says(page, /2 pictures left/);
  assert.deepEqual((await ann('GET', '/api/me')).data.ai, { scripts: 30, pictures: 2, layout: 0 });
  assert.equal((await ann('GET', '/api/speech-ai')).data.can, true);
  const pic = (await ann('GET', '/api/picture-ai')).data;
  assert.ok(pic.admin && pic.left === 2 && !pic.owner, JSON.stringify(pic));
  assert.equal((await ann('PUT', '/api/picture-ai', { key: 'sk-x' })).status, 403, 'an amount is not a right to change the key');

  // Admin, then a user again.
  assert.ok(await button(page, 'Make admin'));
  await says(page, /RoleAdmin/);
  assert.ok(await button(page, 'Remove admin'));
  await says(page, /RoleUser/);

  // Blocked: she cannot log in; unblocked: she can.
  assert.ok(await button(page, 'Block'));
  await says(page, /StatusBlocked/);
  const blocked = await client()('POST', '/api/login', { email: 'ann@example.com', password: 'secret-123' });
  assert.match(blocked.data.error, /blocked/);
  assert.equal((await ann('GET', '/api/me')).data.user, null, 'logged out everywhere at once');
  assert.ok(await button(page, 'Unblock'));
  await says(page, /StatusCan log in/);

  // A new password.
  await page.type('#md-body input[aria-label="New password"]', 'brand-new-1');
  assert.ok(await button(page, 'Set the new password'));
  await sleep(500);
  assert.equal((await client()('POST', '/api/login', { email: 'ann@example.com', password: 'brand-new-1' })).status, 200);
  await page.keyboard.press('Escape');

  // Bob, a helper admin: no "Make admin", the owner's account not changed; the server says no too.
  await page.$eval('.users-tools input', (i) => { i.value = ''; i.dispatchEvent(new Event('input')); });
  text = await open(page, id.Bob);
  assert.ok(await button(page, 'Make admin'));
  await says(page, /RoleAdmin/);
  await page.keyboard.press('Escape');
  const ctx = await browser.createBrowserContext();
  const bobPage = await ctx.newPage();
  bobPage.on('pageerror', (e) => errors.push(`helper: ${e.message}`));
  await logIn(bobPage, 'bob@example.com');
  text = await open(bobPage, id.Ann);
  assert.ok(/Block/.test(text) && !/Make admin/.test(text), text);
  await bobPage.keyboard.press('Escape');
  text = await open(bobPage, id.Boss);
  assert.match(text, /owner’s account cannot be changed/);
  assert.equal((await bob('POST', `/api/admin/users/${id.Ann}`, { action: 'make-admin' })).status, 403);
  assert.equal((await bob('POST', `/api/admin/users/${id.Boss}`, { action: 'block' })).status, 403);
  const key = await bob('PUT', '/api/picture-ai', { key: 'sk-test' });
  assert.ok(key.status === 403 && /owner/.test(key.data.error), 'only the owner changes the API keys');
  assert.equal((await bob('GET', '/api/admin/services')).status, 403, 'a helper admin: no API page');
  assert.ok(!(await bobPage.$('[data-admin-tab="api"]')), 'no API part for a helper admin');
  assert.equal((await boss('PUT', '/api/picture-ai', { key: '' })).status, 200);
  await ctx.close();

  // Deleted: gone from the list and from the server.
  await open(page, id.Ann);
  assert.ok(await button(page, 'Delete the account'));
  await page.waitForFunction((uid) => !document.querySelector(`.users-table tr[data-user="${uid}"]`), { timeout: 10000 }, id.Ann);
  assert.equal((await boss('GET', `/api/admin/users/${id.Ann}`)).status, 404);

  // The API part: only the owner; a key saved, told by its last 4 characters only, taken out.
  await page.click('[data-admin-tab="api"]');
  await page.waitForSelector('.service[data-service="speechKey"]', { timeout: 10000 });
  await page.type('.service[data-service="speechKey"] input[type=password]', 'sk_test_elevenlabs_key_1234');
  await page.click('[data-save="speechKey"]');
  await page.waitForFunction(() => /Key saved …1234/.test(document.querySelector('.service[data-service="speechKey"]')?.textContent || ''), { timeout: 10000 });
  const told = await boss('GET', '/api/admin/services');
  assert.ok(!JSON.stringify(told.data).includes('sk_test_elevenlabs'), 'the key is never sent back');
  assert.equal((await ann('GET', '/api/admin/services')).status, 403);
  await boss('PUT', '/api/admin/services', { speechKey: '' });

  // The other parts of the Admin page.
  await page.click('[data-admin-tab="books"]');
  await page.waitForFunction(() => /Reports \(0\)/.test(document.querySelector('.admin')?.textContent || ''), { timeout: 10000 });
  await page.click('[data-admin-tab="codes"]');
  await page.waitForSelector('.subscription-code-form', { timeout: 10000 });
  assert.deepEqual(errors, []);
  console.log('admin-users-test: PASS');
} catch (err) {
  console.error('admin-users-test: FAIL', err);
  process.exitCode = 1;
} finally {
  await browser.close();
  await stopServer(server);
}

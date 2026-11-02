// Real browser + HTTP smoke test, using isolated data and an in-memory PDF ZIP.
// Run: node web/tests/migration-test.mjs (requires web/tests/node_modules).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, stopServer, openBrowser, BASE, sleep } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const origin = new URL(BASE).origin;
const fixture = execFileSync('python', ['-c',
  `import base64,json,sys
sys.path.insert(0,sys.argv[1])
from test_migration import archive,simple_pdf,itools_entries
entries = dict(itools_entries(1))
entries['Original/web/data/text/BO-test/page-1.json'] = json.dumps({'words':[[40,100,200,80,'Hello.',0,0]]})
entries['Original/.shared/books/BO-test/pages/page-1/index.json'] = json.dumps({'page_assets':[{'type':'audio','lon':50,'lat':2000,'link':'resource://audio/lesson.mp3'}]})
entries['Original/.shared/assets/audio/lesson.mp3'] = b'ID3 inert media fixture'
print(json.dumps({'zip':base64.b64encode(archive([('OldApp/lesson.pdf',simple_pdf()),('OldApp/empty.marker',b''),('OldApp/launcher.exe',b'MZ inert test')])).decode(),'pdf':base64.b64encode(simple_pdf()).decode(),'itools':base64.b64encode(archive(list(entries.items()))).decode()}))`, here], { encoding: 'utf8' });
const data = JSON.parse(fixture);
let server, publicServer, browser;
try {
  server = await startServer();
  const opened = await openBrowser();
  browser = opened.browser;
  const { page, problems } = opened;
  const click = async (label) => {
    const found = await page.evaluate((label) => {
      const button = [...document.querySelectorAll('.migration-dialog button')].find((b) => b.textContent.trim() === label);
      if (!button || button.disabled) return false;
      button.click(); return true;
    }, label);
    assert.ok(found, `Enabled button: ${label}`);
  };
  const stage = async (label) => {
    await page.waitForFunction((label) => document.querySelector('.migration-content')?.textContent.includes(label),
      { timeout: 60000 }, label);
  };
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.click('#lib-migrate');
  await page.waitForSelector('.migration-dialog[open]');
  await page.type('.migration-form input[type=text]', 'Browser migration test');
  await page.$eval('.migration-source input[accept]', (input, base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer(); dt.items.add(new File([bytes], 'old-app.zip', { type: 'application/zip' }));
    input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  }, data.zip);
  await click('1. Upload and inspect');
  await stage('Choose what to import');
  assert.equal(await page.$$eval('.migration-step', (nodes) => nodes.length), 6);
  assert.equal(await page.$$eval('.migration-candidate', (nodes) => nodes.length), 1);
  await click('Generate sample pages');
  await stage('Check the sample pages');
  assert.match(await page.$eval('.migration-sample textarea', (t) => t.value), /migration sample page/);
  assert.equal(await page.$$eval('.migration-content button', (nodes) => nodes.find((n) => n.textContent === 'Convert selected books').disabled), true);

  // Changing reviewed settings disables approval until a fresh sample exists.
  await page.$eval('.migration-review input[type=checkbox]', (input) => {
    input.checked = false; input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  assert.ok(await page.$eval('.migration-review .hint:not([hidden])', (n) => !!n));
  await page.$eval('.migration-review input[type=checkbox]', (input) => {
    input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.$eval('.migration-content > label.check input', (input) => {
    input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click('Convert selected books');
  await stage('Your books are ready');
  assert.match(await page.$eval('.migration-total', (n) => n.textContent), /100%/);
  if (process.env.MIGRATION_SCREENSHOT) await page.screenshot({ path: process.env.MIGRATION_SCREENSHOT });
  const exportURL = await page.$eval('.migration-content a[download]', (n) => n.href);
  const zip = await fetch(exportURL);
  assert.equal(zip.status, 200);
  assert.equal(Buffer.from(await zip.arrayBuffer()).subarray(0, 2).toString(), 'PK');
  const reportURL = exportURL.replace(/export$/, 'report');
  const report = await (await fetch(reportURL)).json();
  assert.equal(report.results.length, 1);
  const book = report.results[0];
  await click(`Open ${book.title}`);
  await page.waitForFunction(() => document.querySelector('.page-img')?.naturalWidth > 0);
  assert.match(page.url(), new RegExp(book.id));
  await page.waitForFunction(() => document.querySelectorAll('.hits rect').length > 0);
  console.log('PASS: ZIP upload -> inspection -> sample review -> approval -> conversion -> export -> reader');

  // Folder paths and zero-byte marker files go through the same real HTTP uploader.
  await page.click('#brand');
  await page.click('#lib-migrate');
  await page.waitForSelector('.migration-form');
  await page.type('.migration-form input[type=text]', 'Folder migration test');
  await click('Choose folder');
  await page.$eval('input[webkitdirectory]', (input, pdf) => {
    const dt = new DataTransfer();
    for (const [name, body] of [['Folder/lesson.pdf', Uint8Array.from(atob(pdf), (c) => c.charCodeAt(0))], ['Folder/empty.marker', '']]) {
      const f = new File([body], name.split('/').pop());
      Object.defineProperty(f, 'webkitRelativePath', { value: name }); dt.items.add(f);
    }
    input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  }, data.pdf);
  await click('1. Upload and inspect');
  await stage('Choose what to import');
  await click('Generate sample pages');
  await stage('Check the sample pages');
  await page.click('[aria-label="Close importer"]');
  await page.click('#lib-migrate');
  await page.waitForSelector('.migration-job');
  await page.evaluate(() => [...document.querySelectorAll('.migration-job')].find((n) => n.textContent.includes('Folder migration test')).click());
  await stage('Check the sample pages');
  assert.match(await page.$eval('.migration-sample textarea', (t) => t.value), /migration sample page/);
  await page.setViewport({ width: 390, height: 844 });
  assert.ok(await page.$eval('.migration-dialog', (n) => n.getBoundingClientRect().width <= window.innerWidth));
  page.once('dialog', (dialog) => dialog.accept());
  await click('Remove import files');
  await page.waitForSelector('.migration-form');
  await page.waitForFunction(() => !document.querySelector('.migration-jobs')?.textContent.includes('Loading'));
  assert.ok(!(await page.$eval('.migration-jobs', (n) => n.textContent)).includes('Folder migration test'));
  console.log('PASS: folder paths, empty files, saved-job reopening and mobile dialog');

  // Report is useful even for an unsupported application; never pretend it converted.
  const unsupported = await (await fetch(origin + '/api/migrations', { method: 'POST', body: JSON.stringify({ title: 'Unsupported', input: 'folder' }) })).json();
  await fetch(`${origin}/api/migrations/${unsupported.id}/source?name=app.exe`, { method: 'PUT', body: 'MZ inert' });
  await fetch(`${origin}/api/migrations/${unsupported.id}/analyze`, { method: 'POST', body: '{}' });
  await page.waitForFunction(async (url) => (await (await fetch(url)).json()).state === 'planned', {}, `/api/migrations/${unsupported.id}`);
  const unsupportedReport = await fetch(`${origin}/api/migrations/${unsupported.id}/report`);
  assert.equal(unsupportedReport.status, 200);
  assert.equal((await unsupportedReport.json()).results.length, 0);
  assert.deepEqual(problems, []);
  console.log('PASS: unsupported-app report, no browser errors');

  // Exercise the public-site boundary too, not just direct Python ownership checks.
  const publicOrigin = 'http://127.0.0.1:8796';
  publicServer = await startServer({ port: 8796, args: ['--public'] });
  const client = () => {
    let cookie = '';
    return async (route, method = 'GET', value, raw = false, headers = {}) => {
      const response = await fetch(publicOrigin + route, { method,
        headers: { Cookie: cookie, ...headers },
        body: value === undefined ? undefined : raw ? value : JSON.stringify(value) });
      const set = response.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
      return response;
    };
  };
  const owner = client(), stranger = client(), anonymous = client();
  assert.equal((await anonymous('/api/migrations')).status, 401);
  assert.equal((await owner('/api/signup', 'POST', { name: 'Owner', email: 'migration-owner@example.com', password: 'private-migration-test' })).status, 200);
  assert.equal((await stranger('/api/signup', 'POST', { name: 'Stranger', email: 'migration-stranger@example.com', password: 'private-migration-test' })).status, 200);
  const privateJob = await (await owner('/api/migrations', 'POST', { title: 'Private import', input: 'zip' })).json();
  const jobURL = `/api/migrations/${privateJob.id}`;
  assert.equal((await owner(jobURL + '/source?name=old-app.zip', 'PUT', Buffer.from(data.itools, 'base64'), true)).status, 200);
  assert.equal((await owner(jobURL + '/analyze', 'POST', {})).status, 200);
  const waitJob = async (wanted) => {
    for (let i = 0; i < 100; i++) {
      const job = await (await owner(jobURL)).json();
      assert.notEqual(job.state, 'error', job.error);
      if (job.state === wanted) return job;
      await sleep(150);
    }
    throw new Error(`Public import did not reach ${wanted}`);
  };
  await waitJob('planned');
  assert.equal((await owner(jobURL + '/sample', 'POST', {})).status, 200);
  const review = await waitJob('review');
  const preview = review.sample.pages[0].image;
  for (const route of [jobURL, jobURL + '/report', preview]) {
    assert.equal((await stranger(route)).status, 403);
    assert.equal((await anonymous(route)).status, 401);
  }
  assert.equal((await stranger(jobURL + '/cancel', 'POST', {})).status, 403);
  assert.equal((await owner(jobURL + '/convert', 'POST', { approved: true, sampleToken: review.sample.token })).status, 200);
  const ready = await waitJob('ready');
  assert.equal((await stranger(jobURL + '/export')).status, 403);
  const partial = await owner(jobURL + '/export', 'GET', undefined, false, { Range: 'bytes=0-3' });
  assert.equal(partial.status, 206);
  assert.equal((await partial.arrayBuffer()).byteLength, 4);
  const privateBook = ready.results[0].id;
  const bookData = await (await owner(`/api/books/${privateBook}`)).json();
  const media = bookData.pages[0].a[0].src;
  assert.equal((await stranger(media)).status, 404); // private files deliberately conceal their existence
  assert.equal((await anonymous(media)).status, 404);
  assert.equal((await owner(media)).status, 200);
  assert.equal((await owner(media, 'GET', undefined, false, { Range: 'bytes=0-2' })).status, 206);
  assert.equal((await owner('/web/library/migrations/' + privateJob.id + '/source/OldApp/launcher.exe')).status, 404);
  console.log('PASS: website accounts, private samples/export/media, byte ranges and inert source isolation');
} finally {
  await browser?.close();
  await stopServer(publicServer);
  await stopServer(server);
}

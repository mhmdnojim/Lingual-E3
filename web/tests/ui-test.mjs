// End-to-end test of every feature in headless Edge/Chrome.
//   cd web\tests && npm install && node ui-test.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KnownDevices } from 'puppeteer-core';
import { BASE, gotoPage, openBrowser, sleep, startServer, stopServer, wordCenter } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const results = [];
function check(name, ok, detail = '') {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function editorChecks(page) {
  const TEXT_API = '/api/text/BO-ea8a794c762bd/';
  const rows = () => page.$$eval('#text-view .esent', (r) => r.length);
  const saved = async () => {
    try {
      await page.waitForFunction(() => document.querySelector('#edit-status').textContent === 'Saved', { timeout: 5000 });
    } catch {
      check('corrections are saved', false, await page.$eval('#edit-status', (s) => s.textContent));
    }
  };
  page.on('response', async (r) => {
    if (r.url().includes('/api/') && !r.ok()) console.log(`  API ${r.request().method()} ${r.status()} ${await r.text().catch(() => '')}`);
  });
  const selText = () => page.$eval('#text-view .esent.sel', (r) => r.querySelector('textarea')?.value ?? r.querySelector('.etext').firstChild.textContent);
  // Distance (px) between the middle of the visible text list and the middle of an element / the active words.
  const offCentre = (selector) => page.evaluate((sel) => {
    const tb = document.querySelector('#text-view').closest('.tab-body'), box = tb.getBoundingClientRect();
    const top = box.top + [...tb.querySelectorAll('.panel-actions')].find((x) => !x.hidden).offsetHeight;
    const els = [...document.querySelectorAll(sel)];
    if (!els.length) return 9999;
    const mid = (els[0].getBoundingClientRect().top + els[els.length - 1].getBoundingClientRect().bottom) / 2;
    return Math.round(Math.abs(mid - (top + box.bottom) / 2));
  }, selector);
  const reload = async () => {
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.querySelector('.page-img')?.complete && window.aef?.views[0]?.text, { timeout: 15000 });
    await sleep(300);
  };
  page.on('console', (m) => { if (m.type() === 'warn' || m.type() === 'warning') console.log(`  console: ${m.text()}`); });
  const openEditor = async () => { await page.click('.panel [role=tab][data-tab="text"]'); await page.click('#edit-text'); };
  page.on('dialog', (d) => d.accept());

  await gotoPage(page, '#/1706/10');
  const path = await page.evaluate(() => window.aef.views[0].page.path);
  await page.evaluate((u) => fetch(u, { method: 'DELETE' }), TEXT_API + path); // start clean
  await reload();
  const sentences = await page.evaluate(() => window.aef.views[0].text.sent.length);
  const cr = await wordCenter(page, 300);
  await page.mouse.click(cr.x, cr.y); // start reading there
  await sleep(300);
  const readingText = await page.evaluate(() => { const t = window.aef.views[0].text; return t.text(...t.sent[t.w2s[300]]); });
  await openEditor();
  await sleep(300);
  check('correction mode lists every sentence', (await rows()) === sentences, `${sentences} sentences`);
  check('correction mode opens on the sentence being read', (await selText()) === readingText, readingText);
  check('…and keeps it in the middle of the list', (await offCentre('.esent.sel')) < 40, `${await offCentre('.esent.sel')}px from the middle`);

  // Select by clicking the page; the list centres it.
  const c = await wordCenter(page, 120);
  await page.mouse.click(c.x, c.y);
  await sleep(700);
  const centred = await offCentre('.esent.sel');
  check('clicking the page selects the sentence, centred in the list', centred < 40, `${centred}px from the middle`);
  const original = await selText();

  // The selected sentence is shown as it is; the tools are in a bar at the top of the panel.
  const plain = await page.$eval('#text-view .esent.sel', (r) => !r.querySelector('textarea, button'));
  const bar = await page.$eval('#edit-tools', (t) => { const r = t.getBoundingClientRect(); return r.height > 0 && t.querySelectorAll('button[data-op]').length; });
  check('correction mode: the tools are in a bar at the top, the selected sentence stays plain text', plain && bar === 10, `${bar} buttons`);

  // Change the text: Enter (or a double click) turns the selected sentence into a box.
  await page.keyboard.press('Enter');
  await sleep(200);
  const boxOpen = !!(await page.$('.esent.sel textarea'));
  await page.$eval('.esent.sel textarea', (t) => { t.value = 'This sentence was corrected by hand.'; });
  await page.focus('.esent.sel textarea');
  await page.keyboard.press('Enter');
  await saved();
  check('Enter opens the text box; Enter again saves and closes it', boxOpen && !(await page.$('.esent.sel textarea')));
  const fixed = await page.evaluate(() => window.aef.views[0].text.text(...window.aef.views[0].text.sent[window.aef.editor.flatIndex(window.aef.editor.sel)]));
  check('editing a sentence changes it and saves', fixed === 'This sentence was corrected by hand.', fixed);

  const tool = async (op) => { await page.click(`#edit-tools [data-op="${op}"]`); await sleep(150); };
  let n = await rows();
  await tool('split');
  await page.click('.esent.sel .chip[data-k="3"]');
  await sleep(150);
  check('split makes two sentences', (await rows()) === n + 1 && (await selText()) === 'corrected by hand.', await selText());
  await tool('mergePrev');
  check('merge joins them again', (await rows()) === n && (await selText()) === 'This sentence was corrected by hand.');
  // Double click another sentence: selected, with its text box; Esc closes it unchanged.
  const other = (await page.$$('#text-view .esent'))[5];
  const otherText = await other.$eval('.etext', (e) => e.firstChild.textContent);
  await other.evaluate((r) => r.scrollIntoView({ block: 'center' })); // not under the bar at the top
  await sleep(200);
  await other.click({ count: 2 });
  await sleep(300);
  const dblBox = await page.$eval('.esent.sel textarea', (t) => t.value).catch(() => '');
  await page.keyboard.press('Escape');
  await sleep(200);
  check('double-click a sentence to change its text; Esc leaves it as it was', dblBox === otherText && (await selText()) === otherText
    && !(await page.$('.esent.sel textarea')));
  const firstRow = (await page.$$('#text-view .esent'))[0];
  await firstRow.evaluate((r) => r.click());
  await sleep(200);
  const greyed = await page.$$eval('#edit-tools [data-op]', (bs) => bs.filter((b) => b.disabled).map((b) => b.dataset.op).join(' '));
  check('buttons that do not fit the selected sentence are greyed out', /mergePrev/.test(greyed) && /\bup\b/.test(greyed) && !/mergeNext|down|delete/.test(greyed), greyed);
  await page.evaluate(() => { // back to the corrected sentence
    const rs = [...document.querySelectorAll('#text-view .esent')];
    rs.find((r) => r.querySelector('.etext')?.firstChild.textContent === 'This sentence was corrected by hand.').click();
  });
  await sleep(300);
  const order = () => page.$$eval('#text-view .esent', (rs) => rs.map((r) => r.querySelector('textarea')?.value ?? r.querySelector('.etext').firstChild.textContent));
  const before = await order();
  const at = before.indexOf('This sentence was corrected by hand.');
  await tool('down');
  const after = await order();
  check('move down swaps it with the next sentence', after[at + 1] === before[at] && after[at] === before[at + 1], `position ${at + 1} → ${at + 2}`);
  await tool('up');
  check('move up puts it back', JSON.stringify(await order()) === JSON.stringify(before));

  // Drag the sentence by its handle and drop it between two others (before the 3rd row below).
  const fixedText = 'This sentence was corrected by hand.';
  const from = (await order()).indexOf(fixedText);
  const hb = await (await page.$('.esent.sel .handle')).boundingBox();
  const targetTop = await page.$$eval('#text-view .esent', (rs, k) => rs[k].getBoundingClientRect().top, from + 3);
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2, targetTop + 4, { steps: 10 });
  await sleep(150);
  const lineShown = await page.$eval('#text-view', (tv) => !!tv.querySelector('.drop-line'));
  await page.mouse.up();
  await sleep(300);
  const dragged = await order();
  check('dragging shows where the sentence will go', lineShown);
  check('drag and drop puts the sentence between two others', dragged[from + 2] === fixedText, `row ${from + 1} → ${dragged.indexOf(fixedText) + 1}`);
  await page.click('#edit-undo');
  await sleep(200);
  check('undo puts it back', JSON.stringify(await order()) === JSON.stringify(before));
  await tool('add');
  await page.keyboard.type('A brand new sentence.');
  await page.keyboard.press('Enter');
  await sleep(200);
  check('add inserts a new sentence (not on the page yet)', (await rows()) === n + 1 && (await selText()) === 'A brand new sentence.' &&
    !!(await page.$('.esent.sel')) && (await page.evaluate(() => window.aef.views[0].text.rects(...Object.values(window.aef.editor.unitOf(window.aef.editor.sel)).slice(2)).length)) === 0);
  await tool('mark');
  const p = await page.$eval('.page', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await page.mouse.move(p.x + p.w * 0.1, p.y + p.h * 0.9);
  await page.mouse.down();
  await page.mouse.move(p.x + p.w * 0.6, p.y + p.h * 0.93, { steps: 5 });
  await page.mouse.up();
  await sleep(200);
  check('mark on page gives the sentence a place on the image', (await page.$$eval('.hl-active rect', (r) => r.length)) > 0);
  await tool('delete');
  check('delete removes the sentence', (await rows()) === n);
  await page.click('#edit-undo');
  await sleep(150);
  check('undo brings it back', (await rows()) === n + 1);
  await tool('delete');
  const blocks = await page.$$eval('#text-view .eblock', (b) => b.length);
  await page.click('#text-view .eblock .esent:not(:first-child)'); // a sentence inside a paragraph
  await sleep(150);
  await tool('paragraph');
  check('new paragraph splits the paragraph', (await page.$$eval('#text-view .eblock', (b) => b.length)) === blocks + 1);
  await tool('paragraph');
  check('join paragraph joins it back', (await page.$$eval('#text-view .eblock', (b) => b.length)) === blocks);
  await saved();

  // Done: back to reading on the same sentence, highlighted and centred.
  await (await page.$$('#text-view .esent'))[20].click();
  await sleep(500);
  const chosen = await selText();
  await page.click('#edit-done');
  await sleep(500);
  const kept = await page.$$eval('#text-view .w.active', (s) => s.map((x) => x.textContent).join('').trim());
  check('Done goes back to reading on the same sentence', kept === chosen, kept);
  check('…centred in the text list', (await offCentre('#text-view .w.active')) < 40, `${await offCentre('#text-view .w.active')}px from the middle`);

  // Saved on the server: survives a reload, used by search.
  await reload();
  await openEditor();
  check('corrections are still there after reloading', !!(await page.$('.badge-edited')) &&
    (await page.evaluate(() => window.aef.views[0].text.fullText())).includes('This sentence was corrected by hand.'));
  await page.click('#edit-done');
  await page.type('#search-input', 'corrected by hand');
  await sleep(900);
  check('search finds the corrected text', (await page.$$eval('#search-results li', (l) => l.length)) === 1);
  await page.$eval('#search-input', (i) => { i.value = ''; });

  // Restore the original text.
  await openEditor();
  await page.click('#edit-reset');
  await sleep(600);
  const restored = await page.evaluate(() => !window.aef.views[0].edited && !window.aef.views[0].text.fullText().includes('corrected by hand'));
  check('restore brings back the original OCR text', restored && (await page.evaluate((u) => fetch(u).then((r) => r.json()).then((d) => !d.edited), TEXT_API + path)));
  await page.click('#edit-done');
  check('the original sentence is unchanged', original.length > 0);
}

/** A one-page PDF with real text (Helvetica), to test PDF books without a file on disk. */
function makePdf(lines) {
  const content = `BT /F1 26 Tf 30 TL 72 700 Td ${lines.map((l) => `(${l}) Tj T*`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => { const at = pdf.length; pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/**
 * Lingua Books as a public website (server.py --public): a second test server. Accounts, private
 * and shared books (text, PDF, photos), reports and the admin; the disc's content is never served.
 */
async function websiteChecks(browser, problems) {
  const port = 8797, base = `http://127.0.0.1:${port}`;
  const srv = await startServer({ port, args: ['--public'], env: { LB_ADMIN_EMAIL: 'boss@example.com', LB_CONTACT_EMAIL: 'help@example.com' } });
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lb-files-'));
  try {
    // ---- Through the API (like any program would): each "client" keeps its own login cookie.
    const client = () => {
      let cookie = '';
      return async (method, p, body, raw) => {
        const r = await fetch(base + p, { method, redirect: 'manual',
          headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': raw ? 'application/octet-stream' : 'application/json' },
          body: raw || (body !== undefined ? JSON.stringify(body) : undefined) });
        const set = r.headers.get('set-cookie');
        if (set) cookie = set.split(';')[0];
        const type = r.headers.get('content-type') || '';
        return { status: r.status, data: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
      };
    };
    const anon = client(), boss = client(), ann = client();
    const ready = async (who, id) => {
      for (let i = 0; i < 120; i++) {
        const j = (await who('GET', `/api/books/${id}/job`)).data;
        if (j.status === 'ready' || j.status === 'error') return j;
        await sleep(500);
      }
      return { status: 'timeout' };
    };
    let r = await anon('GET', '/api/me');
    check('Website: anyone can visit (no account needed to read), the disc is not there', r.data.mode === 'public' && !r.data.user && !r.data.disc);
    r = await anon('POST', '/api/books', { kind: 'text', title: 'X' });
    check('…adding a book needs an account', r.status === 401 && r.data.account);
    r = await boss('POST', '/api/signup', { email: 'boss@example.com', name: 'Boss', password: 'secret-123' });
    const r2 = await ann('POST', '/api/signup', { email: 'ann@example.com', name: 'Ann', password: 'short' });
    const r3 = await ann('POST', '/api/signup', { email: 'ann@example.com', name: 'Ann', password: 'another-pass' });
    check('…sign up: the admin (LB_ADMIN_EMAIL) and a user; a short password is refused', r.data.user?.admin && r2.status === 400 && r3.status === 200 && !r3.data.user.admin);
    const bad = await anon('POST', '/api/login', { email: 'ann@example.com', password: 'wrong-pass' });
    check('…a wrong password is refused', bad.status === 400);

    const pdfBook = (await ann('POST', '/api/books', { kind: 'pdf', title: 'A PDF lesson' })).data;
    await ann('PUT', `/api/books/${pdfBook.id}/source/pdf`, undefined, makePdf(['Reading is fun.', 'This PDF has two sentences of text.']));
    await ann('POST', `/api/books/${pdfBook.id}/make`, {});
    const pj = await ready(ann, pdfBook.id);
    const pdoc = (await ann('GET', `/api/text/${pdfBook.id}/p1`)).data;
    const psents = (pdoc.sent || []).map(([a, b]) => pdoc.words.slice(a, b).map((w) => w[4]).join(' '));
    check('…a PDF book: its page is drawn and its words come from the PDF', pj.status === 'ready' && psents.includes('Reading is fun.'), psents.join(' | '));
    const notPdf = await ann('PUT', `/api/books/${pdfBook.id}/source/pdf`, undefined, Buffer.from('hello'));
    check('…a file that is not a PDF is refused', notPdf.status === 400, notPdf.data.error);

    const textBook = (await ann('POST', '/api/books', { kind: 'text', title: 'Ann’s lesson', author: 'Ann' })).data;
    await ann('PUT', `/api/books/${textBook.id}/source/text`, undefined, Buffer.from(JSON.stringify({ text: 'Hello world. This is my lesson.\n\nIt has two paragraphs. Good luck!' })));
    await ann('POST', `/api/books/${textBook.id}/make`, {});
    const tj = await ready(ann, textBook.id);
    const id = textBook.id;
    check('…a text book is made into pages', tj.status === 'ready' && tj.book.pageCount === 1);
    const priv = [await anon('GET', `/api/books/${id}`), await boss('GET', '/api/books?scope=public'), await anon('GET', `/lib/${id}/pages/1.webp`)];
    check('…a book is private at first: nobody else sees it or its pages', priv[0].status === 404 && !priv[1].data.some((b) => b.id === id) && priv[2].status === 404);
    const noRights = await ann('PUT', `/api/books/${id}`, { visibility: 'public', license: 'own' });
    const shared = await ann('PUT', `/api/books/${id}`, { visibility: 'public', license: 'own', rights: true });
    check('…sharing it needs a licence and “I may share it”', noRights.status === 400 && shared.data.visibility === 'public' && shared.data.licenseName === 'My own work');
    const seen = [await anon('GET', '/api/books?scope=public'), await anon('GET', `/api/books/${id}`), await anon('GET', `/lib/${id}/pages/1.webp`), await anon('GET', `/api/text/${id}/p1`)];
    check('…then anyone finds it, opens it, sees its pages and text', seen[0].data.some((b) => b.id === id) && seen[1].data.pages[0].w === 1200
      && seen[2].data.subarray(0, 4).toString() === 'RIFF' && seen[3].data.sent.length >= 4);
    const edit = await anon('PUT', `/api/text/${id}/p1`, seen[3].data);
    const others = await client()('PUT', `/api/books/${id}`, { title: 'Mine now' });
    check('…only its owner (or an admin) changes it', edit.status === 401 && others.status === 401);
    const quit = await boss('POST', '/api/quit', {});
    check('…and the website cannot be stopped from outside', quit.status === 403 && (await anon('GET', '/api/version')).status === 200);
    const secret = ['/web/data/books.json', '/.shared/assets/misc/', '/web/vendor/ruffle/ruffle.js', '/web/library/library.db', '/web/server.py',
      '/web/server-config.json', '/web/tools/build_data.py', '/web/edits/x.json', '/windows/oup.exe'];
    const codes = await Promise.all(secret.map((p) => anon('GET', p).then((x) => x.status)));
    const discList = (await boss('GET', '/api/books?scope=local')).data;
    check('…the disc’s books and the server’s files are never served on a website', codes.every((c) => c === 404) && discList.length === 0, codes.join(' '));

    // ---- In the browser: a visitor, an account, photos of pages, sharing, a report, the admin.
    const page = await browser.newPage();
    page.on('pageerror', (e) => problems.push(`website page error: ${e.message}`));
    page.on('dialog', (d) => d.accept());
    await page.goto(`${base}/web/`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.querySelectorAll('.book-card').length > 0, { timeout: 10000 }).catch(() => {});
    const cards = await page.$$eval('.book-card h3', (h) => h.map((x) => x.textContent));
    await page.click(`.book-card[data-id="${id}"] .bc-cover`);
    await page.waitForFunction(() => document.querySelector('.page-img')?.complete, { timeout: 15000 });
    await sleep(500);
    const visitor = await page.evaluate(() => ({ readonly: document.body.classList.contains('readonly'), words: document.querySelectorAll('.hits rect').length,
      pencil: !!document.querySelector('#edit-text')?.offsetParent }));
    check('Website in the browser: a visitor sees the public library and reads a book (no correcting)', cards.includes('Ann’s lesson') && visitor.readonly
      && !visitor.pencil && visitor.words > 5, JSON.stringify(visitor));
    // Report it (About tab of the page list).
    await page.evaluate(() => window.aef.setDrawer(true));
    await page.click('#drawer [role=tab][data-dtab="resources"]');
    await sleep(200);
    const about = await page.$eval('#about-box', (b) => b.textContent);
    await page.evaluate(() => [...document.querySelectorAll('#about-box button')].find((b) => /Report/.test(b.textContent)).click());
    await sleep(200);
    await page.type('.lib-form textarea', 'Copied from a course book.');
    await page.click('.lib-form button[type=submit]');
    await sleep(500);
    const reports = (await boss('GET', '/api/admin/reports')).data;
    check('…its About tab shows its licence; “Report a problem” reaches the admins', /My own work/.test(about) && reports.some((x) => x.book === id && /course book/.test(x.note)));

    // Sign up in the app, then add photos of a page (made here, read with OCR).
    await page.click('#book-title');
    await sleep(400);
    await page.click('#lib-account .btn.primary'); // Sign up
    await page.type('.lib-form input[type=email]', 'cara@example.com');
    await page.type('.lib-form input[autocomplete=name]', 'Cara');
    await page.type('.lib-form input[type=password]', 'cara-pass-1');
    await page.click('.lib-form button[type=submit]');
    await page.waitForFunction(() => /Cara/.test(document.querySelector('#lib-account').textContent), { timeout: 10000 }).catch(() => {});
    const signedUp = /Cara/.test(await page.$eval('#lib-account', (a) => a.textContent));
    const png = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 1400; c.height = 900;
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#111'; g.font = '56px Arial';
      ['Learning with Lingua Books.', 'Every sentence can be heard.', 'Photos of pages work too.'].forEach((t, i) => g.fillText(t, 80, 200 + i * 110));
      return c.toDataURL('image/png').split(',')[1];
    });
    const photo = path.join(tmp, 'page-1.png');
    writeFileSync(photo, Buffer.from(png, 'base64'));
    await page.click('#lib-add');
    await sleep(300);
    await page.click('.add-kind [data-kind="images"]');
    await page.type('.lib-form input[type=text]', 'Photo lesson');
    await (await page.$('.lib-form input[type=file][multiple]')).uploadFile(photo);
    await page.click('.lib-form button[type=submit]');
    await page.waitForFunction(() => location.hash.startsWith('#/L'), { timeout: 120000 }).catch(() => {});
    await page.waitForFunction(() => document.querySelector('.page-img')?.complete && document.querySelectorAll('#text-view .sline').length, { timeout: 20000 }).catch(() => {});
    const ocrText = await page.$$eval('#text-view .sline', (ls) => ls.map((l) => [...l.querySelectorAll('.w')].map((w) => w.textContent).join('').trim()));
    check('…sign up in the app; add photos of a page: the words are read (OCR) and clickable', signedUp && ocrText.some((t) => /Lingua Books/.test(t)) && ocrText.length >= 3,
      ocrText.join(' | '));
    // Share it with everyone (settings: licence + "I may share it").
    const photoId = (await page.evaluate(() => location.hash)).split('/')[1];
    await page.evaluate(() => window.aef.setDrawer(true));
    await page.click('#drawer [role=tab][data-dtab="resources"]');
    await page.evaluate(() => [...document.querySelectorAll('#about-box button')].find((b) => /Settings/.test(b.textContent)).click());
    await sleep(200);
    await page.click('.share-toggle input');
    await page.select('.share-box select', 'public-domain');
    await page.click('.share-box .check input');
    await page.click('.lib-form button[type=submit]');
    await sleep(600);
    const pub = (await anon('GET', '/api/books?scope=public')).data;
    check('…share it: licence and “I may share it”, then it is in the public library', pub.some((b) => b.id === photoId && b.licenseName === 'Public domain'));

    // The admin hides the reported book on the Admin page.
    const adminCtx = await browser.createBrowserContext(); // a separate window: its own cookies (login)
    const adminPage = await adminCtx.newPage();
    adminPage.on('pageerror', (e) => problems.push(`admin page error: ${e.message}`));
    adminPage.on('dialog', (d) => d.accept());
    await adminPage.goto(`${base}/web/#/`, { waitUntil: 'networkidle0' });
    await adminPage.click('#lib-account .btn:not(.primary)'); // Log in
    await adminPage.type('.lib-form input[type=email]', 'boss@example.com');
    await adminPage.type('.lib-form input[type=password]', 'secret-123');
    await adminPage.click('.lib-form button[type=submit]');
    await adminPage.waitForFunction(() => !document.querySelector('#library [data-scope="admin"]').hidden, { timeout: 10000 }).catch(() => {});
    await adminPage.click('#library [data-scope="admin"]');
    await adminPage.waitForFunction(() => document.querySelector('.admin-table'), { timeout: 10000 }).catch(() => {});
    const listed = await adminPage.$$eval('.admin-table', (t) => t[0]?.textContent || '');
    await adminPage.evaluate(() => [...document.querySelectorAll('.admin-table')[0].querySelectorAll('button')].find((b) => b.textContent === 'Hide').click());
    await sleep(600);
    const hiddenNow = (await anon('GET', `/api/books/${id}`)).status;
    check('…the admin sees the report on the Admin page and hides the book: nobody else can open it', /Ann’s lesson/.test(listed) && /Copied from a course book/.test(listed)
      && hiddenNow === 404 && (await ann('GET', `/api/books/${id}`)).data.hidden);
    await adminCtx.close();
    await page.close();
  } finally {
    stopServer(srv);
    rmSync(tmp, { recursive: true, force: true });
  }
  // Reachable from other devices without a login: it does not start.
  const refused = spawnSync('python', [path.resolve(here, '..', 'server.py'), '--no-browser', '--host', '0.0.0.0', '--port', '8796'],
    { timeout: 20000, encoding: 'utf-8' });
  check('…and the server refuses to be reachable from other devices without a login', refused.status === 1 && /not started/.test(refused.stdout));
}

/** The library on this computer: the disc's books are there; a text lesson is added through the form. */
async function libraryChecks(page) {
  await page.goto(BASE + '#/', { waitUntil: 'networkidle0' });
  await sleep(500);
  const home = await page.evaluate(() => ({ open: !document.querySelector('#library').hidden,
    tabs: [...document.querySelectorAll('#library [role=tab]:not([hidden])')].map((t) => t.dataset.scope) }));
  await page.click('#library [data-scope="local"]');
  await sleep(500);
  const disc = await page.$$eval('.book-card h3', (h) => h.map((x) => x.textContent));
  check('Library: the home screen; on this computer the disc’s three books are there', home.open && home.tabs.includes('local')
    && ['Student Book', 'Workbook', "Teacher's Book"].every((b) => disc.includes(b)), disc.join(', '));
  await page.click('#lib-add');
  await sleep(300);
  await page.click('.add-kind [data-kind="text"]');
  await page.type('.lib-form input[type=text]', 'My first lesson');
  await page.type('.lib-form textarea', 'Hello world. This is my first lesson in Lingua Books.\n\nThe second paragraph is here. It is short.');
  await page.click('.lib-form button[type=submit]');
  await page.waitForFunction(() => location.hash.startsWith('#/L'), { timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => document.querySelector('.page-img')?.complete && document.querySelectorAll('#text-view .sline').length, { timeout: 15000 }).catch(() => {});
  const lesson = await page.evaluate(() => ({ title: document.querySelector('#book-name').textContent, lines: document.querySelectorAll('#text-view .sline').length,
    words: document.querySelectorAll('.hits rect').length, readonly: document.body.classList.contains('readonly') }));
  check('…add a text lesson: set into a page, every sentence clickable, yours to correct', lesson.title === 'My first lesson' && lesson.lines === 5
    && lesson.words === 21 && !lesson.readonly, JSON.stringify(lesson));
  // Delete it again (settings).
  await page.click('#book-title');
  await sleep(500);
  await page.click('#library [data-scope="mine"]');
  await sleep(500);
  page.once('dialog', (d) => d.accept().catch(() => {})); // (an earlier check may answer it already)
  await page.click('.book-card .bc-edit');
  await sleep(200);
  await page.evaluate(() => [...document.querySelectorAll('.lib-form button')].find((b) => /Delete/.test(b.textContent)).click());
  await sleep(600);
  check('…and delete it again', (await page.$$('.book-card')).length === 0);
}

/** How far (px) the sentence being read is from the middle of the page area that can be seen. */
const activeOffMiddle = (page) => page.evaluate(() => {
  const it = window.aef.reader.active;
  if (!it) return 9999;
  const st = document.querySelector('#stage').getBoundingClientRect();
  const pill = document.querySelector('#reading-pill');
  const bottom = pill.hidden ? st.bottom : pill.getBoundingClientRect().top - 8;
  const rs = [...document.querySelectorAll('.hl-active rect')].map((r) => r.getBoundingClientRect());
  const mid = (Math.min(...rs.map((r) => r.top)) + Math.max(...rs.map((r) => r.bottom))) / 2;
  return Math.round(Math.abs(mid - (st.top + bottom) / 2));
});

/**
 * Following the reading: the sentence being read stays in the middle of the page, unless the
 * person scrolls away (then "Back to the reading", and it follows again after the wait).
 */
async function followChecks(page) {
  await gotoPage(page, '#/1705/25');
  await page.evaluate(() => {
    window.realSpeak = speechSynthesis.speak;
    speechSynthesis.speak = () => {}; // silent: the test says when a sentence is finished
    const a = window.aef;
    a.zoom = { mode: 'custom', w: a.fitWidth() * 1.8 }; // zoomed in: room to scroll the reading off the screen
    a.applyZoom();
  });
  // The Follow tab of the settings: jump at once (so the test does not wait for scrolling).
  await page.click('#btn-voice');
  await page.click('#voice-pop [role=tab][data-ptab="follow"]');
  const tab = await page.evaluate(() => !document.querySelector('#voice-pop .pop-body[data-ptab="follow"]').hidden
    && document.querySelector('#follow-on').checked && document.querySelectorAll('#follow-where button').length === 3);
  const setRange = (sel, v) => page.$eval(sel, (i, val) => { i.value = val; i.dispatchEvent(new Event('input', { bubbles: true })); }, v);
  await setRange('#follow-speed', '0');
  const speedOut = await page.$eval('#follow-speed-out', (o) => o.textContent);
  await page.keyboard.press('Escape');
  await page.click('#btn-voice'); // close it
  await sleep(200);
  check('Follow tab in the settings: on, where on the page, speed, wait, the Text list', tab && speedOut === 'jump at once');

  const offMiddle = () => activeOffMiddle(page);
  const scrollTop = () => page.$eval('#stage', (s) => Math.round(s.scrollTop));
  // Start reading a sentence in the lower half of the page.
  await page.evaluate(() => {
    const a = window.aef, v = a.views[0], t = v.text;
    const s = t.sent.findIndex(([x, y]) => (t.rects(x, y)[0] || { y: 0 }).y > 1000); // the middle of the page
    a.reader.start(v, t.unit('sentence', s), true);
  });
  await sleep(400);
  const first = await offMiddle();
  await page.evaluate(() => window.aef.reader.finished());
  await sleep(400);
  const second = await offMiddle();
  check('Following: the sentence being read is in the middle of the page, also the next one', first < 40 && second < 40, `${first}px, ${second}px from the middle`);

  // The person scrolls away: the page stays where they put it; "Back to the reading" appears.
  const st = await page.$eval('#stage', (s) => { const r = s.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 3 }; });
  await page.mouse.move(st.x, st.y);
  await page.mouse.wheel({ deltaY: -500 });
  await sleep(300);
  const away = await scrollTop();
  await page.evaluate(() => window.aef.reader.finished());
  await sleep(400);
  const stayed = Math.abs((await scrollTop()) - away) < 3;
  check('…when you scroll the page yourself it stays there (the next sentence does not pull it back)', stayed, `scrolled to ${away}px`);
  // The reading is now below the screen: the box at the top middle shows the word being read, word by word.
  const badge = () => page.evaluate(() => {
    const b = document.querySelector('#follow-back'), st = document.querySelector('#stage').getBoundingClientRect();
    if (b.hidden) return null;
    const r = b.getBoundingClientRect();
    return { word: document.querySelector('#follow-word').textContent, down: b.classList.contains('down'),
      top: Math.round(r.top - st.top), middle: Math.abs(r.left + r.width / 2 - (st.left + st.width / 2)) < 4 };
  });
  const words = [];
  for (let k = 0; k < 3; k++) {
    await page.evaluate((k) => { const a = window.aef, it = a.reader.active; a.showWord(it.view, it.unit.a + k); }, k);
    await sleep(80);
    words.push(await badge());
  }
  const expected = await page.evaluate(() => { const it = window.aef.reader.active;
    return [0, 1, 2].map((k) => it.view.text.words[it.unit.a + k][4].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')); });
  check('…the word being read shows at the top middle of the page, word by word, with an arrow down to where it is',
    words.every((b, k) => b && b.word === expected[k] && b.down && b.top < 30 && b.middle), words.map((b) => b?.word).join(' → '));
  await page.click('#follow-back');
  await sleep(300);
  check('…a click on it brings the reading back to the middle (and the box goes)', (await offMiddle()) < 40 && await page.$eval('#follow-back', (b) => b.hidden));

  // After the wait it follows again by itself.
  await page.click('#btn-voice');
  await setRange('#follow-wait', '1');
  await page.click('#btn-voice');
  await page.mouse.move(st.x, st.y);
  await page.mouse.wheel({ deltaY: -500 });
  await sleep(250);
  const during = await offMiddle();
  await sleep(1300);
  check('…and after the wait (here 1 s) it follows again by itself', during > 100 && (await offMiddle()) < 40, `${during}px away, then back`);

  // Switched off (button in the reading bar): the page is not moved.
  await page.click('#reading-follow');
  const off = await page.$eval('#reading-follow', (b) => b.getAttribute('aria-pressed'));
  await page.mouse.move(st.x, st.y);
  await page.mouse.wheel({ deltaY: -500 });
  await sleep(1400);
  const at = await scrollTop();
  await page.evaluate(() => window.aef.reader.finished());
  await sleep(400);
  const notMoved = Math.abs((await scrollTop()) - at) < 3;
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('f'); // on again: back to the reading at once
  await sleep(400);
  check('…the button in the reading bar (or F) switches following off and on', off === 'false' && notMoved
    && (await page.$eval('#reading-follow', (b) => b.getAttribute('aria-pressed'))) === 'true' && (await offMiddle()) < 40);

  // Near the top.
  await page.click('#btn-voice');
  await page.click('#follow-where [data-where="top"]');
  await page.click('#btn-voice');
  await page.evaluate(() => {
    const a = window.aef, v = a.views[0], t = v.text;
    a.reader.start(v, t.unit('sentence', t.sent.findIndex(([x, y]) => (t.rects(x, y)[0] || { y: 0 }).y > 1100)), true);
  });
  await sleep(400);
  const nearTop = await page.evaluate(() => {
    const st = document.querySelector('#stage').getBoundingClientRect();
    const top = Math.min(...[...document.querySelectorAll('.hl-active rect')].map((r) => r.getBoundingClientRect().top));
    return (top - st.top) / st.height;
  });
  check('…“Near the top” puts the sentence near the top of the page', nearTop > 0.08 && nearTop < 0.3, `${Math.round(nearTop * 100)}% down`);

  // Back to the usual settings.
  await page.click('#btn-voice');
  await page.click('#follow-where [data-where="center"]');
  await setRange('#follow-speed', '500');
  await setRange('#follow-wait', '4');
  await page.click('#btn-voice');
  await page.click('#reading-stop');
  await page.evaluate(() => {
    speechSynthesis.speak = window.realSpeak;
    const a = window.aef;
    a.zoom = { mode: 'page', w: a.pageW };
    a.applyZoom();
  });
}

/** Phones: the layout at iPhone size, and the app used with touches only (tap, swipe, pinch, double tap). */
async function phoneChecks(browser, problems) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => problems.push(`phone page error: ${e.message}`));
  await page.emulate(KnownDevices['iPhone 13']);
  await gotoPage(page, '#/1705/25');
  const cdp = await page.createCDPSession();
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
  const tap = async (x, y) => { await touch('touchStart', [[x, y]]); await touch('touchEnd', []); };
  const swipe = async (x1, x2, y) => {
    await touch('touchStart', [[x1, y]]);
    for (let k = 1; k <= 6; k++) { await touch('touchMove', [[x1 + ((x2 - x1) * k) / 6, y]]); await sleep(16); }
    await touch('touchEnd', []);
    await sleep(900);
  };
  const pageNo = () => page.$eval('#page-input', (i) => i.value);

  const lay = await page.evaluate(() => {
    const vis = [...document.querySelectorAll('.topbar .icon-btn, .topbar select, .topbar .page-field, .topbar .seg, .topbar .search-field')]
      .filter((b) => b.offsetParent).map((b) => b.getBoundingClientRect());
    let overlap = 0;
    for (const a of vis) for (const b of vis) if (a !== b && a.left < b.left && a.right > b.left + 1 && a.bottom > b.top + 1 && b.bottom > a.top + 1) overlap++;
    return {
      fits: document.documentElement.scrollWidth <= innerWidth && vis.every((r) => r.left >= 0 && r.right <= innerWidth),
      overlap, rows: new Set(vis.map((r) => Math.round(r.top / 30))).size,
      hotspotsOut: [...document.querySelectorAll('.hs')].filter((h) => h.getBoundingClientRect().right > innerWidth || h.getBoundingClientRect().left < 0).length,
      pageFitsWidth: Math.abs(window.aef.pageW - window.aef.fitWidth()) < 2,
      sheetBelow: document.querySelector('#panel').getBoundingClientRect().top > document.querySelector('#stage').getBoundingClientRect().bottom - 2,
    };
  });
  check('Phone (iPhone size): everything fits the screen, top bar in two rows, panel at the bottom', lay.fits && !lay.overlap && lay.rows === 2
    && !lay.hotspotsOut && lay.pageFitsWidth && lay.sheetBelow, JSON.stringify(lay));

  // A tap on a sentence on the page reads it, and shows its translation (Arabic: saved in the test folder).
  await page.evaluate(() => { speechSynthesis.speak = () => {}; window.aef.translator.setLang('ar'); window.aef.translator.setPage(true); });
  await page.waitForFunction(() => document.querySelectorAll('#text-view .tr').length > 20, { timeout: 30000 }).catch(() => {});
  const c = await wordCenter(page, 40);
  await tap(c.x, c.y);
  await sleep(600);
  const read = await page.evaluate(() => window.aef.reader.busy && window.aef.reader.active?.unit.a <= 40 && window.aef.reader.active?.unit.b > 40);
  const tip = await page.$eval('.tr-tip', (t) => (t.hidden ? '' : t.textContent));
  check('Phone: a tap on a sentence reads it and shows its translation', read && /[؀-ۿ]/.test(tip), tip.slice(0, 30));
  await page.evaluate(() => { window.aef.reader.stop(); window.aef.translator.setPage(false); window.aef.translator.setList(false); });

  // Swipe to turn the page; pinch to zoom.
  await swipe(330, 60, 420);
  const next = await pageNo();
  await swipe(60, 330, 420);
  check('Phone: swipe left / right turns the page', next === '26' && (await pageNo()) === '25', `25 → ${next} → ${await pageNo()}`);
  const w0 = await page.evaluate(() => window.aef.pageW);
  await touch('touchStart', [[160, 400], [230, 400]]);
  for (let k = 1; k <= 6; k++) { await touch('touchMove', [[160 - k * 15, 400], [230 + k * 15, 400]]); await sleep(30); }
  await touch('touchEnd', []);
  await sleep(300);
  const w1 = await page.evaluate(() => window.aef.pageW);
  await touch('touchStart', [[70, 400], [320, 400]]);
  for (let k = 1; k <= 6; k++) { await touch('touchMove', [[70 + k * 15, 400], [320 - k * 15, 400]]); await sleep(30); }
  await touch('touchEnd', []);
  await sleep(300);
  const back = await page.evaluate(() => ({ w: window.aef.pageW, mode: window.aef.zoom.mode }));
  check('Phone: pinch with two fingers zooms in, and back to the width of the screen', w1 > w0 * 1.6 && back.mode === 'width',
    `${w0} → ${w1} → ${back.w} px (${back.mode})`);

  // The panel sheet: the open tab closes it, a tab opens it, its bar drags it taller.
  await page.click('.panel [role=tab][data-tab="text"]');
  const closed = await page.evaluate(() => document.body.classList.contains('panel-closed'));
  await page.click('.panel [role=tab][data-tab="text"]');
  const open = await page.evaluate(() => !document.body.classList.contains('panel-closed'));
  const h0 = await page.$eval('#panel', (p) => p.getBoundingClientRect().height);
  const hb = await (await page.$('#sheet-handle')).boundingBox();
  await touch('touchStart', [[hb.x + hb.width / 2, hb.y + 9]]);
  for (let k = 1; k <= 6; k++) { await touch('touchMove', [[hb.x + hb.width / 2, hb.y + 9 - k * 25]]); await sleep(16); }
  await touch('touchEnd', []);
  await sleep(300);
  const h1 = await page.$eval('#panel', (p) => p.getBoundingClientRect().height);
  check('Phone: the panel at the bottom opens and closes from its tabs, and its bar drags it taller', closed && open && h1 > h0 + 100,
    `${Math.round(h0)} → ${Math.round(h1)} px`);

  // Text list: a double tap on a sentence opens it for correcting.
  const lw = await page.evaluate(() => { const r = document.querySelectorAll('#text-view .sline .w')[12].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await tap(lw.x, lw.y);
  await sleep(120);
  await tap(lw.x, lw.y);
  await sleep(400);
  check('Phone: a double tap on a sentence in the list opens it for correcting', !!(await page.$('#text-view .qedit textarea')));
  await page.keyboard.press('Escape');

  // Following the reading on a phone: in the middle of the page above the panel; a swipe pauses it.
  // (The pinch above counts as looking around: following waits until that is a few seconds ago.)
  await page.waitForFunction(() => !window.aef.follower.stage.busy(), { timeout: 10000 });
  await page.evaluate(() => {
    const a = window.aef, v = a.views[0], t = v.text;
    const s = t.sent.findIndex(([x, y]) => (t.rects(x, y)[0] || { y: 0 }).y > 1000); // the middle of the page
    a.reader.start(v, t.unit('sentence', s), true);
  });
  await sleep(1000);
  const centred = await activeOffMiddle(page);
  // (On the page, above the reading bar.)
  const sy = await page.$eval('#stage', (st) => Math.round(st.getBoundingClientRect().top + 40));
  await touch('touchStart', [[200, sy]]);
  for (let k = 1; k <= 6; k++) { await touch('touchMove', [[200, sy + k * 30]]); await sleep(16); }
  await touch('touchEnd', []);
  await sleep(400);
  const swiped = await page.$eval('#stage', (s) => s.scrollTop);
  await page.evaluate(() => window.aef.reader.finished());
  await sleep(900);
  const kept = Math.abs((await page.$eval('#stage', (s) => s.scrollTop)) - swiped) < 3;
  // The word box only when the word being read is off the screen (here it is still on it).
  const boxRight = await page.evaluate(() => {
    const it = window.aef.reader.active, st = document.querySelector('#stage').getBoundingClientRect();
    const pr = it.view.el.getBoundingClientRect(), box = it.view.unitBox({ a: it.unit.a, b: it.unit.a + 1 });
    const top = pr.top + box.y, off = top + box.h < st.top || top > document.querySelector('#reading-pill').getBoundingClientRect().top;
    return off === !document.querySelector('#follow-back').hidden;
  });
  check('Phone: the sentence being read stays in the middle of the page; swiping the page yourself pauses that',
    centred < 40 && kept && boxRight, `${centred}px from the middle; swiped to ${swiped}px, kept ${kept}, word box right ${boxRight}`);
  await page.evaluate(() => window.aef.reader.stop());

  // Settings: as wide as the screen.
  await page.click('#btn-voice');
  await sleep(200);
  const pop = await page.$eval('#voice-pop', (p) => { const r = p.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.width > innerWidth * 0.9; });
  check('Phone: the settings box fits the screen', pop);
  await page.close();
}

/** The normal Text list (no correction mode): one sentence per line, translation button, drag, double click. */
async function textListChecks(page) {
  const TEXT_API = '/api/text/BO-ea8a794c762bd/';
  const lines = () => page.$$eval('#text-view .sline', (ls) => ls.map((l) => [...l.querySelectorAll('.w')].map((w) => w.textContent).join('').trim()));
  const layout = () => page.evaluate(() => {
    const ls = [...document.querySelectorAll('#text-view .sline')];
    let shared = 0;
    for (let i = 1; i < ls.length; i++) if (ls[i].getBoundingClientRect().top < ls[i - 1].getBoundingClientRect().bottom - 1) shared++;
    return { lines: ls.length, sentences: window.aef.views.reduce((n, v) => n + (v.text?.sent.length || 0), 0), shared };
  });

  // The translation button in the Text tab (Arabic of p.25 is saved in the test's folder already).
  await gotoPage(page, '#/1705/25');
  await page.click('.panel [role=tab][data-tab="text"]');
  let lay = await layout();
  check('Text list: every sentence is on a line of its own', lay.lines === lay.sentences && lay.shared === 0, `${lay.lines} lines, ${lay.sentences} sentences, ${lay.shared} sharing a line`);
  const nums = await page.$$eval('#text-view .sline .grip .num', (ns) => ns.map((x) => (x.offsetWidth ? x.textContent : '')));
  check('…and numbered, without opening correction mode', nums.length === lay.sentences && nums.every((x, i) => x === String(i + 1)), `1 … ${nums.length}`);
  await page.click('#tr-toggle');
  const on = await page.waitForFunction(() => document.querySelectorAll('#text-view .tr').length > 20, { timeout: 15000 }).then(() => true, () => false);
  const pressed = await page.$eval('#tr-toggle', (b) => b.getAttribute('aria-pressed'));
  lay = await layout();
  await page.click('#tr-toggle');
  await sleep(300);
  const off = (await page.$$('#text-view .tr')).length === 0 && (await page.$eval('#tr-toggle', (b) => b.getAttribute('aria-pressed'))) === 'false';
  check('the translation button in the Text tab shows and hides the translations', on && pressed === 'true' && off);
  check('…each translation under its own sentence', lay.shared === 0);

  await gotoPage(page, '#/1706/10');
  const path = await page.evaluate(() => window.aef.views[0].page.path);
  const before = await lines();

  // Drag: the first sentence of a paragraph with 3+ sentences, dropped after its third one.
  const target = await page.evaluate(() => {
    const ls = [...document.querySelectorAll('#text-view .sline')];
    const i = ls.findIndex((l, k) => l.dataset.s === '0' && ls[k + 2]?.dataset.b === l.dataset.b && ls[k + 3]?.dataset.b === l.dataset.b
      && l.getBoundingClientRect().top > 200);
    return i;
  });
  const rows = await page.$$('#text-view .sline');
  // In the middle of the list, so the list does not scroll by itself while dragging (it does near its edges).
  await rows[target].evaluate((r) => r.scrollIntoView({ block: 'center' }));
  await sleep(300);
  await rows[target].hover();
  await sleep(250); // the dots fade in
  const g = await (await rows[target].$('.grip')).boundingBox();
  const r3 = await rows[target + 2].boundingBox();
  const gripShown = await rows[target].$eval('.grip', (x) => getComputedStyle(x.querySelector('.i')).display !== 'none' && !x.querySelector('.num').offsetWidth);
  await page.mouse.move(g.x + 8, g.y + 9);
  await page.mouse.down();
  const toY = r3.y + r3.height - 4;
  for (let k = 1; k <= 12; k++) { await page.mouse.move(g.x + 8, g.y + 9 + ((toY - g.y - 9) * k) / 12); await sleep(25); }
  const lineShown = !!(await page.$('#text-view .drop-line'));
  await page.mouse.up();
  await sleep(700);
  const after = await lines();
  const moved = after[target + 2] === before[target] && after[target] === before[target + 1] && after[target + 1] === before[target + 2];
  check('drag a sentence by the dots on its left (no correction mode needed)', gripShown && lineShown && moved,
    `number turned into dots: ${gripShown}, drop line: ${lineShown}, “${before[target].slice(0, 25)}” now 3rd in its paragraph: ${moved}`);
  await sleep(600);
  const squash = (t) => t.replace(/\s+/g, '');
  const savedOrder = await page.evaluate((u) => fetch(u).then((r) => r.json())
    .then((d) => d.sent.map(([a, b]) => d.words.slice(a, b).map((x) => x[4]).join(''))), TEXT_API + path);
  check('…the new order is saved', JSON.stringify(savedOrder) === JSON.stringify(after.map(squash)));
  check('…still one sentence per line, and no reading started', (await layout()).shared === 0 && !(await page.evaluate(() => window.aef.reader.busy)));
  await page.keyboard.down('Control');
  await page.keyboard.press('z');
  await page.keyboard.up('Control');
  await sleep(500);
  check('Ctrl+Z undoes it in the Text list too', JSON.stringify(await lines()) === JSON.stringify(before));

  // Double click: correct the sentence right in the list.
  await page.evaluate(() => { window.realSpeak = speechSynthesis.speak; speechSynthesis.speak = () => {}; });
  const wordsOf = (k) => page.evaluateHandle((i) => document.querySelectorAll('#text-view .sline')[i].querySelector('.w'), k);
  const k = target + 1;
  await (await wordsOf(k)).click({ count: 2 });
  await sleep(500);
  const boxText = await page.$eval('#text-view .qedit textarea', (t) => t.value).catch(() => '');
  check('double-click a sentence opens it for correcting, right in the list', boxText === before[k], boxText.slice(0, 40));
  check('…and does not start reading', !(await page.evaluate(() => window.aef.reader.busy)));
  await page.$eval('#text-view .qedit textarea', (t) => { t.value = 'This sentence was corrected in the list.'; });
  await page.keyboard.press('Enter');
  await sleep(900);
  const changed = await lines();
  const savedText = await page.evaluate((u) => fetch(u).then((r) => r.json()).then((d) => d.words.map((w) => w[4]).join(' ')), TEXT_API + path);
  check('Enter saves the correction', changed[k] === 'This sentence was corrected in the list.' && !(await page.$('.qedit'))
    && savedText.includes('This sentence was corrected in the list.'));
  await (await wordsOf(k + 1)).click({ count: 2 });
  await sleep(300);
  await page.$eval('#text-view .qedit textarea', (t) => { t.value = 'Something else'; });
  await page.keyboard.press('Escape');
  await sleep(300);
  check('Esc cancels it', !(await page.$('.qedit')) && (await lines())[k + 1] === before[k + 1]);
  await (await wordsOf(k + 1)).click({ count: 2 });
  await sleep(300);
  await page.click('#text-view .qedit [data-q="more"]');
  await sleep(500);
  const toolsOn = await page.evaluate(() => window.aef.editor.active);
  const selected = await page.$eval('#text-view .esent.sel .etext', (t) => t.firstChild.textContent).catch(() => '');
  check('“More tools” opens correction mode on that sentence', toolsOn && selected === before[k + 1], selected.slice(0, 40));
  await page.click('#edit-done');
  await sleep(400);

  // A single click still reads (a moment later, in case it is a double click).
  const w = await wordsOf(k + 3);
  await w.click();
  await sleep(600);
  check('a single click in the list still reads the sentence', await page.evaluate(() => window.aef.reader.busy));
  await page.click('#reading-stop');
  await page.evaluate(() => { speechSynthesis.speak = window.realSpeak; });

  // Back to the original text.
  await page.evaluate((u) => fetch(u, { method: 'DELETE' }), TEXT_API + path);
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.aef?.views[0]?.text, { timeout: 15000 });
}

async function audioChecks(page) {
  await gotoPage(page, '#/1705/25');
  await page.click('.panel [role=tab][data-tab="audio"]');
  const before = await page.evaluate(() => window.aef.recordings.list.length);
  const count = () => page.$eval('#rec-count', (c) => c.textContent);
  await page.click('#rec-new');
  await sleep(200);
  await (await page.$$('#rec-view .pblock .pblock-box input'))[1].click(); // the "His trip began…" paragraph
  await sleep(150);
  check('“New audio”: the box of a paragraph chooses all its sentences', (await count()) === '11 sentences chosen', await count());
  check('chosen sentences are marked on the page', (await page.$$eval('.hl-pick rect', (r) => r.length)) > 10);
  // First and last sentence, clicked on the page: everything in between is chosen.
  await page.click('#rec-view [data-pick="none"]');
  const expected = await page.evaluate(() => { const t = window.aef.views[0].text; return t.w2s[300] - t.w2s[40] + 1; });
  let p = await wordCenter(page, 40);
  await page.mouse.click(p.x, p.y);
  await sleep(100);
  const waiting = await count();
  p = await wordCenter(page, 300);
  await page.mouse.click(p.x, p.y);
  await sleep(150);
  check('clicking the first and the last sentence chooses everything in between', waiting === 'Now click the last sentence' &&
    (await count()) === `${expected} sentences chosen`, `${waiting} → ${await count()}`);
  await page.keyboard.down('Control');
  p = await wordCenter(page, 120);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up('Control');
  await sleep(150);
  check('Ctrl+click drops a single sentence', (await count()) === `${expected - 1} sentences chosen`, await count());

  // The same in the list: the first three sentences of the paragraph.
  await page.click('#rec-view [data-pick="none"]');
  await (await page.$$('#rec-view .prow input'))[1].click();
  await sleep(100);
  await (await page.$$('#rec-view .prow input'))[3].click();
  await sleep(150);
  check('…also in the list', (await count()) === '3 sentences chosen', await count());

  await page.click('#rec-create');
  const ready = await page.waitForFunction(() => document.querySelector('.rec-form option[value]') || !document.querySelector('.rec-error').hidden,
    { timeout: 20000 }).then(() => page.$eval('.rec-error', (e) => e.hidden)).catch(() => false);
  if (!ready) {
    check('(skipped: creating audio needs the internet)', true, await page.$eval('.rec-error', (e) => e.textContent).catch(() => ''));
    await page.click('#md-close');
    await page.click('#rec-cancel');
    return;
  }
  await page.$eval('.rec-form input[type=text]', (i) => { i.value = 'Test audio'; });
  await page.$eval('.rec-form input[max="10"]', (i) => { i.value = '0.5'; i.dispatchEvent(new Event('input')); });
  await page.click('.rec-form .btn.primary');
  await page.waitForFunction(() => !document.querySelector('#media-dialog').open, { timeout: 120000 });
  await sleep(400);
  const rec = await page.evaluate(() => window.aef.recordings.list[0]);
  check('the MP3 is created and listed', (await page.evaluate(() => window.aef.recordings.list.length)) === before + 1 && rec.title === 'Test audio' && rec.count === 3,
    `${rec.title}, ${rec.count} sentences, ${rec.duration} s`);
  check('a play icon appears next to the paragraph', (await page.$$('.rec-spot')).length >= 1);
  const link = await page.$eval(`#rec-view .rec[data-id="${rec.id}"] a[download]`, (a) => `${a.getAttribute('href')} ${a.getAttribute('download')}`);
  check('it can be downloaded as an MP3', /\.mp3 Test audio\.mp3$/.test(link), link);

  // Play from the icon: the sentence being read is highlighted on the page and in the text.
  await page.click(`.rec-spot`);
  await sleep(2000);
  const playing = await page.$eval('#audio', (a) => !a.paused && a.currentTime > 0.5);
  const full = await page.evaluate((id) => window.aef.recordings.full.get(id), rec.id);
  const shown = await page.$$eval('#text-view .w.active', (s) => s.map((x) => x.textContent).join('').trim());
  check('the icon plays it, highlighting the sentence being read', playing && shown === full.sentences[0].text, shown);
  await page.$eval('#audio', (a, t) => { a.currentTime = t; }, full.sentences[2].start + 0.4);
  await sleep(500);
  const third = await page.$$eval('#text-view .w.active', (s) => s.map((x) => x.textContent).join('').trim());
  check('the highlight follows the audio (jump to sentence 3)', third === full.sentences[2].text, third);
  check('the current word is highlighted too', (await page.$$('#text-view .w.cur')).length === 1);

  // Clicking a sentence that is in the MP3 plays the MP3 from there (not the live voice).
  const clickWord = async (w) => { const q = await wordCenter(page, w); await page.mouse.click(q.x, q.y); await sleep(700); };
  const state = () => page.evaluate(() => {
    const a = document.querySelector('#audio');
    return { src: a.getAttribute('src'), t: a.currentTime, paused: a.paused, live: !document.querySelector('#reading-pill').hidden };
  });
  await clickWord(full.sentences[0].a + 1);
  let st = await state();
  check('clicking a sentence that has an MP3 plays the MP3 from that sentence', st.src === rec.file && !st.paused && !st.live &&
    st.t >= full.sentences[0].start && st.t < full.sentences[0].start + 1.5, `${st.t.toFixed(1)} s`);
  await clickWord(full.sentences[0].a + 1);
  check('clicking it again pauses the MP3', (await state()).paused);
  await clickWord(full.sentences[2].a + 1);
  st = await state();
  check('clicking another of its sentences jumps there', !st.paused && st.t >= full.sentences[2].start - 0.1 && st.t < full.sentences[2].start + 1.5, `${st.t.toFixed(1)} s`);
  await page.click('#pl-close');
  await clickWord(full.sentences[1].a + 1);
  st = await state();
  check('…also when the player was closed', st.src === rec.file && !st.paused && st.t >= full.sentences[1].start - 0.1 && st.t < full.sentences[1].start + 1.5,
    `${st.t.toFixed(1)} s`);
  // Repeat each sentence (2 times) with the MP3: at the end of sentence 2 it goes back to its start once, then on.
  await page.$eval('#repeat-input', (i) => { i.value = '2'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  const s1 = full.sentences[1], s2 = full.sentences[2];
  // (The MP3 has a short pause after each sentence: s1.end … s2.start.)
  await page.evaluate((t) => { document.querySelector('#audio').currentTime = t; }, s1.end - 0.3);
  await sleep(1300);
  const again = (await state()).t;
  await page.evaluate((t) => { document.querySelector('#audio').currentTime = t; }, s1.end - 0.3);
  await sleep(1300);
  const onward = (await state()).t;
  check('Repeat with an MP3: the sentence plays again from its start, then the MP3 goes on',
    again >= s1.start && again < s1.start + 1.5 && onward >= s2.start && onward < s2.start + 1.5,
    `sentence ${s1.start.toFixed(1)}–${s1.end.toFixed(1)} s: ${again.toFixed(1)} s, then ${onward.toFixed(1)} s (next sentence from ${s2.start.toFixed(1)} s)`);
  await page.$eval('#repeat-input', (i) => { i.value = '1'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await clickWord(300);
  st = await state();
  check('a sentence without an MP3 is read with the live voice', st.live && st.paused);
  await page.click('#reading-stop');
  const srt = await (await fetch(new URL(rec.srt, BASE))).text();
  check('the MP3 has subtitles (.srt) with the time of every sentence', (srt.match(/-->/g) || []).length === 3 && srt.includes(full.sentences[0].text),
    srt.split('\n').slice(0, 2).join(' '));

  // Rename and delete from the list.
  await page.click('.panel [role=tab][data-tab="audio"]');
  page.once('dialog', (d) => d.accept('Renamed audio'));
  await page.click(`#rec-view .rec[data-id="${rec.id}"] [data-act="rename"]`);
  await sleep(400);
  check('it can be renamed', (await page.$eval(`#rec-view .rec[data-id="${rec.id}"] .rec-title`, (t) => t.textContent)) === 'Renamed audio');
  page.once('dialog', (d) => d.accept());
  await page.click(`#rec-view .rec[data-id="${rec.id}"] [data-act="delete"]`);
  await sleep(500);
  const gone = (await fetch(new URL(rec.file, BASE))).status; // from here, not the page: a 404 is expected
  check('deleting removes it from the list, the page and the disk', (await page.evaluate(() => window.aef.recordings.list.length)) === before &&
    !(await page.$(`.rec-spot`)) && gone === 404 && (await page.$eval('#player', (p) => p.hidden)));
}

async function translationChecks(page, problems) {
  await gotoPage(page, '#/1705/25');
  await page.click('#btn-translate'); // no language yet: the settings open on the Translation tab
  await sleep(300);
  const asked = await page.evaluate(() => !document.querySelector('#voice-pop').hidden
    && document.querySelector('#voice-pop [role=tab][data-ptab="translation"]').getAttribute('aria-selected') === 'true'
    && !document.querySelector('#voice-pop .pop-body[data-ptab="translation"]').hidden);
  check('Translation settings are a tab of the settings (voice and speed) box', asked);
  await page.select('#tr-lang', 'ar'); // choosing the first language turns both on
  const online = await page.waitForFunction(() => document.querySelectorAll('#text-view .tr').length > 20 || document.querySelector('.tr-note.err'),
    { timeout: 40000 }).then(async () => !(await page.$('.tr-note.err'))).catch(() => false);
  if (!online) {
    check('(skipped: translating needs the internet the first time)', true);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.aef.translator.setOn(false));
    return;
  }
  const n = await page.$$eval('#text-view .tr', (t) => t.length);
  const sentences = await page.evaluate(() => window.aef.views[0].text.sent.length);
  check('Translation: every sentence gets its translation under it', n === sentences, `${n} of ${sentences}, Arabic`);
  check('…shown right to left for Arabic', (await page.$eval('#text-view .tr', (t) => t.dir)) === 'rtl');
  await page.keyboard.press('Escape');
  const hoverWord = async (w) => { const q = await wordCenter(page, w); await page.mouse.move(q.x, q.y); };
  await hoverWord(40);
  await sleep(500);
  const tip = await page.$eval('.tr-tip', (t) => (t.hidden ? '' : t.textContent));
  check('pointing at a sentence on the page shows its translation', /[؀-ۿ]/.test(tip), tip.slice(0, 40));
  // The popup must leave every line of the sentence visible (word 40: a sentence of 3 lines).
  const tipPlace = (w) => page.evaluate((w) => {
    const t = window.aef.views[0].text, [a, b] = t.sent[t.w2s[w]];
    const tip = document.querySelector('.tr-tip');
    if (tip.hidden) return 'hidden';
    const k = tip.getBoundingClientRect();
    const rs = [];
    for (let i = a; i < b; i++) { const r = document.querySelector(`.hits rect[data-w="${i}"]`)?.getBoundingClientRect(); if (r) rs.push(r); }
    const covered = rs.filter((r) => r.right > k.left && r.left < k.right && r.bottom > k.top && r.top < k.bottom).length;
    const lines = new Set(rs.map((r) => Math.round(r.top / 10))).size;
    return covered ? `covers ${covered} words` : k.top >= Math.max(...rs.map((r) => r.bottom)) ? `below, ${lines} lines` : k.bottom <= Math.min(...rs.map((r) => r.top)) ? `above, ${lines} lines` : 'beside';
  }, w);
  const below = await tipPlace(40);
  const zoom = await page.evaluate(() => { // page width: bigger text, as in the user's screenshot
    const a = window.aef, old = a.zoom;
    a.zoom = { mode: 'width', w: a.pageW };
    a.applyZoom();
    return old;
  });
  await sleep(500);
  // A sentence of 2+ lines in the lower part of the page, scrolled to the bottom of the window: no room below it.
  const low = await page.evaluate(() => {
    const t = window.aef.views[0].text;
    for (let s = t.sent.length - 1; s >= 0; s--) {
      const [a, b] = t.sent[s], rs = t.rects(a, b);
      if (rs.length >= 2 && rs[0].y > 1400 && rs[0].y < 2200 && document.querySelector(`.hits rect[data-w="${a}"]`)) return a;
    }
    return -1;
  });
  const toBottom = () => page.evaluate((w) => {
    const st = document.querySelector('#stage'), t = window.aef.views[0].text, [a, b] = t.sent[t.w2s[w]];
    const r = document.querySelector(`.hits rect[data-w="${b - 1}"]`).getBoundingClientRect();
    st.scrollTop += r.bottom - (st.getBoundingClientRect().bottom - 40);
  }, low);
  await toBottom();
  await sleep(300);
  await hoverWord(low);
  await sleep(400);
  const above = await tipPlace(low);
  await page.$eval('#stage', (s) => { s.scrollTop += 300; }); // the sentence moves up: room below it again
  await sleep(300);
  await hoverWord(low);
  await sleep(400);
  const scrolled = await tipPlace(low);
  check('the popup never covers the sentence: below it, or above it when there is no room',
    /^below/.test(below) && /^above/.test(above) && /^below/.test(scrolled), `${below}; ${above}; after scrolling ${scrolled}`);
  await page.evaluate((z) => { window.aef.zoom = z; window.aef.applyZoom(); }, zoom);
  await sleep(500);
  await page.click('#mode-seg [data-mode="word"]');
  await hoverWord(45);
  await page.waitForFunction(() => { const t = document.querySelector('.tr-tip'); return !t.hidden && t.textContent.includes('→') && !t.textContent.includes('…'); },
    { timeout: 15000 }).catch(() => {});
  const wordTip = await page.$eval('.tr-tip', (t) => (t.hidden ? '' : t.textContent));
  check('in Word mode the popup also translates the word', /Rickenbacker → \S/.test(wordTip), wordTip.slice(0, 30));
  check('…and does not cover the sentence either', /^(below|above)/.test(await tipPlace(45)));
  await page.click('#btn-translate'); // the button at the top: the page popup only
  await hoverWord(46);
  await sleep(400);
  const noTip = await page.$eval('.tr-tip', (t) => t.hidden);
  const listKept = (await page.$$('#text-view .tr')).length === n;
  await page.click('#btn-translate');
  await hoverWord(45);
  await sleep(600);
  check('the translate button at the top switches only the popup on the page (the list keeps its translations)',
    noTip && listKept && !(await page.$eval('.tr-tip', (t) => t.hidden)));
  await page.click('#mode-seg [data-mode="sentence"]');
  await page.evaluate(() => { window.realSpeak = speechSynthesis.speak; speechSynthesis.speak = () => {}; });
  const q = await wordCenter(page, 40);
  await page.mouse.click(q.x, q.y);
  await sleep(300);
  check('the translation of the sentence being read is highlighted', (await page.$$('#text-view .tr.active')).length === 1);
  await page.click('#reading-stop');
  await page.evaluate(() => { speechSynthesis.speak = window.realSpeak; });
  const text = await page.evaluate(() => window.aef.pageText());
  check('copying and saving the page include the translations', /Once the boat passed[^\n]*\n[^\n]*[؀-ۿ]/.test(text));
  await page.mouse.move(5, 400);
  await page.keyboard.press('l');
  await sleep(200);
  const off = (await page.$$('#text-view .tr')).length === 0;
  const t0 = Date.now();
  await page.keyboard.press('l');
  await page.waitForFunction((k) => document.querySelectorAll('#text-view .tr').length === k, { timeout: 5000 }, n).catch(() => {});
  check('L switches translations off and on; the second time they come from the saved file', off &&
    (await page.$$('#text-view .tr')).length === n && Date.now() - t0 < 2000, `${Date.now() - t0} ms`);

  // Google busy ("too many requests"), made up here so the test does not really overload it.
  const busy = (r) => r.respond({ status: 429, contentType: 'application/json',
    body: JSON.stringify({ error: 'Google’s translator is busy (too many requests).', busy: true, wait: 2 }) });
  const isTranslate = (r) => r.method() === 'POST' && r.url().endsWith('/api/translate');
  let calls = 0;
  const once = (r) => (isTranslate(r) && calls++ === 0 ? busy(r) : r.continue());
  await page.setRequestInterception(true);
  page.on('request', once);
  await page.select('#tr-lang', 'fr');
  const waited = await page.waitForFunction(() => /Trying again in 0:0\d/.test(document.querySelector('.tr-note')?.textContent || ''), { timeout: 5000 })
    .then(() => true, () => false);
  const back = await page.waitForFunction((k) => document.querySelectorAll('#text-view .tr').length === k, { timeout: 30000 }, n)
    .then(() => true, () => false);
  check('Google busy: the Text list says so, waits and then translates by itself', waited && back, `${calls} requests`);
  page.off('request', once);

  let bookCalls = 0;
  const fake = (r) => {
    if (!isTranslate(r)) return r.continue();
    if (++bookCalls === 2) return busy(r);
    const { paragraphs } = JSON.parse(r.postData());
    return r.respond({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ translations: paragraphs.map((p) => p.map((s) => `[fr] ${s}`)), fetched: 0 }) });
  };
  page.on('request', fake);
  await page.click('#btn-voice');
  await page.click('#voice-pop [role=tab][data-ptab="translation"]');
  await sleep(300);
  await page.click('#tr-book');
  const status = () => page.$eval('#tr-status', (s) => s.textContent);
  const paused = await page.waitForFunction(() => /goes on by itself in 0:0\d/.test(document.querySelector('#tr-status').textContent), { timeout: 15000 })
    .then(status, () => '');
  const went = await page.waitForFunction(() => /\((4|5|6) of \d+\)/.test(document.querySelector('#tr-status').textContent), { timeout: 20000 })
    .then(() => true, () => false);
  await page.click('#tr-book'); // Stop
  const stopped = await page.waitForFunction(() => /Stopped after/.test(document.querySelector('#tr-status').textContent), { timeout: 5000 })
    .then(status, () => '');
  check('Translate the whole book: when Google is busy it waits and goes on by itself (no stop)', !!paused && went && !!stopped,
    `${bookCalls} requests; ${stopped.slice(0, 22)}`);
  page.off('request', fake);
  await page.setRequestInterception(false);
  await page.keyboard.press('Escape');
  // The made-up 429 answers are not errors of the app.
  problems.splice(0, problems.length, ...problems.filter((p) => !/HTTP 429: .*\/api\/translate$/.test(p)));
  await page.select('#tr-lang', 'ar');
  await page.keyboard.press('l'); // off again for the other tests
  await page.click('#btn-translate');
  check('…both are off now', await page.evaluate(() => !window.aef.translator.listOn && !window.aef.translator.pageOn));
}

/** Everything at desktop size (the main window of the app). */
async function desktopChecks(browser, page, problems) {
  // Page, text layer and hotspots
  await gotoPage(page, '#/1705/25');
  const words = await page.$$eval('.hits rect', (r) => r.length);
  check('page 25 shows clickable words', words > 100, `${words} words`);
  const hs = await page.$$eval('.hs', (b) => b.length);
  check('hotspot buttons are shown', hs === 7, `${hs} buttons`);
  check('text panel lists the page text', (await page.$$eval('#text-view p', (p) => p.length)) > 10);

  // Sentence mode: hover + click
  let c = await wordCenter(page, 40);
  await page.mouse.move(c.x, c.y);
  await sleep(150);
  const hoverText = await page.$$eval('#text-view .w.hover', (s) => s.map((x) => x.textContent).join('').trim());
  check('hovering a word highlights its sentence', hoverText.startsWith('Once the boat passed') && hoverText.endsWith('water.'), hoverText);
  await page.mouse.click(c.x, c.y);
  await sleep(300);
  check('clicking a sentence starts reading it', await page.$eval('#reading-pill', (p) => !p.hidden));
  const label = await page.$eval('#reading-label', (l) => l.textContent);
  check('reading goes on to the end of the page', /1 of \d{2,}/.test(label), label);
  check('the sentence being read is highlighted', (await page.$$eval('.hl-active rect', (r) => r.length)) > 0);
  await page.mouse.click(c.x, c.y);
  await sleep(200);
  check('clicking the same sentence pauses', await page.$eval('#reading-pill', (p) => p.classList.contains('paused')),
    await page.$eval('#reading-label', (l) => l.textContent));
  await page.mouse.click(c.x, c.y);
  await sleep(200);
  check('clicking it again continues', await page.$eval('#reading-pill', (p) => !p.classList.contains('paused') && !p.hidden));
  // A sentence low on the page: reading restarts there and the text list centres it.
  c = await wordCenter(page, 300);
  await page.mouse.click(c.x, c.y);
  await sleep(900);
  const centred = await page.evaluate(() => {
    const tb = document.querySelector('#text-view').closest('.tab-body'), box = tb.getBoundingClientRect();
    const top = box.top + [...tb.querySelectorAll('.panel-actions')].find((x) => !x.hidden).offsetHeight;
    const act = [...document.querySelectorAll('#text-view .w.active')];
    const mid = (act[0].getBoundingClientRect().top + act[act.length - 1].getBoundingClientRect().bottom) / 2;
    return Math.round(Math.abs(mid - (top + box.bottom) / 2));
  });
  check('clicking another sentence reads from there, centred in the text list', centred < 40, `${centred}px from the middle`);
  await page.keyboard.press('Space');
  await sleep(150);
  check('Space pauses too', await page.$eval('#reading-pill', (p) => p.classList.contains('paused')));
  await page.click('#reading-stop');

  // Smooth flow: up to 10 sentences go to the voice in one request (no wait after every
  // sentence), and the highlight still moves on as the voice reports its position.
  await page.evaluate(() => {
    window.realSpeak = speechSynthesis.speak;
    window.spoken = [];
    speechSynthesis.speak = (u) => { window.spoken.push(u); }; // silent: the test plays the voice's part
  });
  c = await wordCenter(page, 40);
  await page.mouse.click(c.x, c.y);
  await sleep(200);
  const chunk = await page.evaluate(() => window.spoken.map((u) => u.text));
  check('reading sends several sentences to the voice in one go', chunk.length === 1 && chunk[0].includes('Rutledge increased the boat') && chunk[0].includes('Who would win?'),
    `${chunk.length} request, ${chunk[0]?.length} characters`);
  await page.evaluate(() => {
    const u = window.spoken[0];
    u.onboundary({ name: 'word', charIndex: u.text.indexOf('Rutledge increased') + 2 });
  });
  await sleep(200);
  const moved = await page.$$eval('#text-view .w.active', (s) => s.map((x) => x.textContent).join('').trim());
  check('…and the highlight moves to the next sentence as it is read', moved.startsWith('Rutledge increased the boat'), moved.slice(0, 50));
  await page.click('#reading-stop');
  await page.evaluate(() => { speechSynthesis.speak = window.realSpeak; });

  // Pause between sentences. The voice is silenced, so the test decides when a sentence ends.
  await page.evaluate(() => { window.realSpeak = speechSynthesis.speak; speechSynthesis.speak = () => {}; });
  const setGap = (v) => page.$eval('#gap-input', (i, val) => { i.value = val; i.dispatchEvent(new Event('input', { bubbles: true })); }, v);
  await setGap('1.5');
  const gapShown = await page.$eval('#gap-out', (o) => o.textContent);
  c = await wordCenter(page, 40);
  await page.mouse.click(c.x, c.y);
  await sleep(200);
  await page.evaluate(() => window.aef.reader.finished()); // as if the voice reached the end of the sentence
  await sleep(300);
  const waiting = await page.$eval('#reading-label', (l) => l.textContent);
  await sleep(1600);
  const afterWait = await page.$eval('#reading-label', (l) => l.textContent);
  check('pause between sentences waits, then reads the next one', gapShown === '1.5 s' && /Next sentence in [12] s/.test(waiting) && /· 2 of \d+/.test(afterWait),
    `${waiting} → ${afterWait}`);
  await page.evaluate(() => window.aef.reader.finished());
  await sleep(200);
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Space');
  await sleep(150);
  const pausedInWait = (await page.$eval('#reading-label', (l) => l.textContent)).startsWith('Paused');
  await page.keyboard.press('Space');
  await sleep(150);
  check('pausing during the wait, then continuing, goes on to the next sentence',
    pausedInWait && /· 3 of \d+/.test(await page.$eval('#reading-label', (l) => l.textContent)));
  await page.click('#reading-stop');
  await setGap('0');

  // Repeat each sentence: 3 times, then the next one; ∞ again and again. (The voice is still silenced.)
  await page.evaluate(() => { window.spoken = []; speechSynthesis.speak = (u) => { window.spoken.push(u.text); }; });
  const setRepeat = (v) => page.$eval('#repeat-input', (i, val) => { i.value = val; i.dispatchEvent(new Event('input', { bubbles: true })); }, v);
  const readingLabel = () => page.$eval('#reading-label', (l) => l.textContent);
  await setRepeat('3');
  const repShown = await page.$eval('#repeat-out', (o) => o.textContent);
  c = await wordCenter(page, 40);
  await page.mouse.click(c.x, c.y);
  await sleep(200);
  const labels = [await readingLabel()];
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.aef.reader.finished()); // as if the voice reached the end of the sentence
    await sleep(150);
    labels.push(await readingLabel());
  }
  let spoken = await page.evaluate(() => window.spoken);
  check('Repeat each sentence (3 times): the same sentence is read 3 times, then the next one',
    repShown === '3 times' && spoken.length === 4 && spoken[0] === spoken[1] && spoken[1] === spoken[2] && spoken[3] !== spoken[0]
    && /· 1 of \d+ · 1st time of 3/.test(labels[0]) && /3rd time of 3/.test(labels[2]) && /· 2 of \d+ · 1st time of 3/.test(labels[3]),
    `${labels[0]} → ${labels[2]} → ${labels[3]}`);
  await setRepeat('11');
  const infShown = await page.$eval('#repeat-out', (o) => o.textContent);
  for (let i = 0; i < 5; i++) { await page.evaluate(() => window.aef.reader.finished()); await sleep(100); }
  spoken = await page.evaluate(() => window.spoken);
  const infLabel = await readingLabel();
  check('Repeat ∞: the sentence is read again and again until you stop', /∞/.test(infShown) && spoken.slice(3).every((x) => x === spoken[3])
    && spoken.length === 9 && /2 of \d+ · 6th time, ∞/.test(infLabel), infLabel);
  await page.click('#reading-stop');
  await setRepeat('1');
  await page.evaluate(() => { speechSynthesis.speak = window.realSpeak; });
  // The repeat button in the top bar: once → 2 → 3 → 4 → 5 → ∞ → once; the slider shows the same.
  const seen = [], sliderSeen = [];
  for (let i = 0; i < 6; i++) {
    await page.click('#btn-repeat');
    seen.push(await page.evaluate(() => { const b = document.querySelector('#repeat-badge'); return b.hidden ? '1' : b.textContent; }));
    sliderSeen.push(await page.$eval('#repeat-out', (o) => o.textContent));
  }
  check('the repeat button goes 2, 3, 4, 5, ∞, then once (the same setting as the slider)',
    seen.join(' ') === '2 3 4 5 ∞ 1' && sliderSeen[4].startsWith('∞') && sliderSeen[5] === 'once', seen.join(' '));
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('r');
  const byKey = await page.$eval('#repeat-out', (o) => o.textContent);
  await setRepeat('1');
  check('…R does the same', byKey === '2 times', byKey);
  await sleep(1600); // let the message fade

  // Clause and word modes
  await page.click('#mode-seg [data-mode="clause"]');
  c = await wordCenter(page, 60);
  await page.mouse.move(c.x, c.y);
  await sleep(150);
  const clause = await page.$$eval('#text-view .w.hover', (s) => s.map((x) => x.textContent).join('').trim());
  check('clause mode highlights part of a sentence', clause === "Rutledge increased the boat's speed to over 90 miles an hour", clause);
  await page.click('#mode-seg [data-mode="word"]');
  c = await wordCenter(page, 61);
  await page.mouse.move(c.x, c.y);
  await sleep(150);
  check('word mode highlights one word', (await page.$$eval('#text-view .w.hover', (s) => s.length)) === 1);
  await page.click('#mode-seg [data-mode="sentence"]');

  // Audio + transcript
  await page.click('.hs.hs-audio');
  await page.waitForFunction(() => !document.querySelector('#player').hidden, { timeout: 5000 });
  await sleep(1500);
  const playing = await page.$eval('#audio', (a) => !a.paused && a.currentTime > 0);
  check('audio button plays the recording', playing);
  const cues = await page.$$('#cue-list .cue');
  check('audio script is shown', cues.length === 7, `${cues.length} lines`);
  await cues[3].click();
  await sleep(600);
  const t = await page.$eval('#audio', (a) => a.currentTime);
  check('clicking a script line jumps to it', t > 15 && t < 17, `${t.toFixed(1)} s`);
  await page.click('#pl-close');

  // Answer key (Flash via Ruffle)
  await page.click('.hs.hs-swf');
  await page.waitForSelector('#media-dialog[open]');
  await sleep(3000);
  const ruffle = await page.$eval('#md-body', (b) => !!b.querySelector('ruffle-player') && !b.querySelector('.swf-note'));
  check('answer key opens in Ruffle', ruffle);
  await page.keyboard.press('Escape');

  // Search
  await page.type('#search-input', 'seaplane');
  await sleep(800);
  const found = await page.$$eval('#search-results li', (l) => l.length);
  check('search finds pages', found >= 3, `${found} pages`);

  // Page link + back
  await page.click('.hs.hs-link');
  await sleep(800);
  check('page link jumps to page 104', (await page.evaluate(() => location.hash)) === '#/1705/104');
  check('back button appears', await page.$eval('#btn-back', (b) => !b.hidden));

  // Video
  await gotoPage(page, '#/1705/12');
  await page.click('.hs.hs-video');
  await page.waitForSelector('#media-dialog[open] video');
  await sleep(2500);
  const video = await page.$eval('#md-body video', (v) => ({ ready: v.readyState, err: v.error?.code || 0, w: v.videoWidth }));
  check('video plays', video.ready >= 2 && !video.err && video.w > 0, `${video.w}px wide`);
  check('video script is shown', (await page.$$eval('#md-body .cue', (c) => c.length)) > 5);
  await page.keyboard.press('Escape');

  // Two-page view
  await gotoPage(page, '#/1705/24');
  await page.click('#btn-spread');
  await sleep(800);
  const spread = await page.$$eval('.page', (p) => p.map((x) => x.dataset.page).join(','));
  check('two-page view shows 24 and 25', spread === '24,25', spread);
  await page.click('#btn-spread');

  // My audio: a natural-voice MP3 of chosen sentences (deleted again at the end)
  await audioChecks(page);

  // Translation (Arabic, in the test's own folder)
  await translationChecks(page, problems);

  // Text corrections (Workbook p.10; removed again at the end)
  await editorChecks(page);

  // The Text list without correction mode: one sentence per line, translation button, drag, double click
  await textListChecks(page);

  // Other books
  await gotoPage(page, '#/1706/10');
  check('Workbook page loads with text', (await page.$$eval('.hits rect', (r) => r.length)) > 100);
  await gotoPage(page, '#/1707/150');
  check("Teacher's Book page loads with text", (await page.$$eval('.hits rect', (r) => r.length)) > 100);
  await gotoPage(page, '#/1707/6');
  check('blank Teacher\'s Book page says it is not on the disc', !!(await page.$('.page-blank')));
}

const server = await startServer();
const { browser, page, problems } = await openBrowser();
try {
  // ONLY=phone, ONLY=library or ONLY=website runs just those checks (quicker while working on one part).
  const only = process.env.ONLY;
  if (!only) await desktopChecks(browser, page, problems);

  // Following the reading (the sentence being read stays in view)
  if (!only || only === 'follow') await followChecks(page);

  // The library on this computer
  if (!only || only === 'library') await libraryChecks(page);

  // Phones (iPhone size, touch only)
  if (!only || only === 'phone') await phoneChecks(browser, problems);

  // Lingua Books as a public website (accounts, sharing, reports, the admin)
  if (!only || only === 'website') await websiteChecks(browser, problems);

  check('no errors in the browser', problems.length === 0, problems.slice(0, 5).join(' | '));
} finally {
  await browser.close();
  stopServer(server);
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

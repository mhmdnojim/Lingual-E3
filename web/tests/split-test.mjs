// Splitting a sentence into several (correction mode, Split): the words after an end of a sentence
// (。？！ . ? !) start new ones to begin with; a click on a word, in the list or on the page, makes
// it start one (again: not any more); each new sentence is shown in its color on the page with the
// number it will have; Split (or Enter) makes them, one step to undo.
// Run: node web/tests/split-test.mjs
import assert from 'node:assert/strict';

process.env.PORT ||= '8825';
const { startServer, stopServer, openBrowser, gotoPage, sleep } = await import('./harness.mjs');

const server = await startServer();
const { browser, page } = await openBrowser();
const errors = [];
const sentences = () => page.evaluate(() => { const t = window.aef.views[0].text; return t.sent.map(([a, b]) => t.text(a, b)); });
const saved = () => page.waitForFunction(() => window.aef.editor.status === 'saved' && window.aef.views[0].edited, { timeout: 5000 });
try {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await gotoPage(page, '#/1705/10');
  await page.click('.panel [role=tab][data-tab="text"]');
  await page.click('#edit-text');
  await sleep(300);
  // A sentence of 8 words or more, all on the page: its first words made "One two. Three four! Five six seven".
  const k = await page.evaluate(() => {
    const d = window.aef.views[0].doc;
    return d.sent.findIndex(([a, b]) => b - a >= 8 && d.words.slice(a, b).every((w) => w[2] > 0));
  });
  assert.ok(k >= 0, 'a sentence of 8 words');
  await page.evaluate((k) => {
    const ed = window.aef.editor, v = window.aef.views[0], [a, b] = v.doc.sent[k];
    const rest = v.doc.words.slice(a + 7, b).map((w) => w[4]);
    ed.select(v, ...Object.values(ed.selAt(v, a)).slice(1));
    ed.run('text', ['One', 'two.', 'Three', 'four!', 'Five', 'six', 'seven', ...rest].join(' '));
  }, k);
  await saved();
  const before = await sentences();
  const whole = before[k];
  await page.click('#edit-tools [data-op="split"]');
  await sleep(200);
  const state = () => page.evaluate(() => ({
    starts: [...document.querySelectorAll('.esent.sel .chip.start')].map((c) => c.textContent),
    pieces: [...document.querySelectorAll('.esent.sel .split-pieces li')].map((li) => li.textContent.split(' ').slice(0, 2).join(' ')),
    button: document.querySelector('.esent.sel [data-op="split-apply"]').textContent,
    onPage: [...document.querySelectorAll('.found-outlines g text')].map((t) => t.textContent),
  }));
  assert.deepEqual(await state(), { starts: ['Three', 'Five'], pieces: ['One two.', 'Three four!', 'Five six'],
    button: 'Split into 3 sentences', onPage: [String(k + 1), String(k + 2), String(k + 3)] }, 'after . and ! to begin with, on the page with their numbers');
  // A word in the list: not a start any more; a word on the page: a start.
  await page.click('.esent.sel .chip[data-k="4"]');
  const six = await page.evaluate((k) => {
    const v = window.aef.views[0], w = v.doc.sent[k][0] + 5, r = v.el.querySelector(`.hits rect[data-w="${w}"]`);
    r.scrollIntoView({ block: 'center' });
    const b = r.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }, k);
  await page.mouse.click(six.x, six.y);
  await sleep(150);
  assert.deepEqual(await state(), { starts: ['Three', 'six'], pieces: ['One two.', 'Three four!', 'six seven'],
    button: 'Split into 3 sentences', onPage: [String(k + 1), String(k + 2), String(k + 3)] }, 'Five taken back (in the list), six marked (on the page)');
  await page.keyboard.press('Enter'); // (Split)
  await saved();
  const after = await sentences();
  assert.equal(after.length, before.length + 2, 'three sentences of one');
  assert.deepEqual(after.slice(k, k + 3).map((s) => s.split(' ').slice(0, 2).join(' ')), ['One two.', 'Three four!', 'six seven']);
  assert.equal(after[k + 1], 'Three four! Five');
  assert.equal(after.slice(k, k + 3).join(' '), whole, 'the same words, in order');
  assert.equal(await page.$$eval('.found-outlines g', (g) => g.length), 0, '(the colors gone from the page)');
  await page.evaluate(() => window.aef.editor.undo());
  await saved();
  assert.deepEqual(await sentences(), before, 'one Undo joins them again');
  console.log('PASS: Split: the words after . ! start new sentences to begin with; a click (in the list, or on the page) adds or takes back a start; each new sentence in its color on the page; Enter splits into all of them; one Undo');
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await stopServer(server);
}

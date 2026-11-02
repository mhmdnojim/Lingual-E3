// The books of several levels in one app (web/levels.json): a made-up level in a temporary folder,
// served under /levels/<id>/, next to this folder's books; and no way out of its folders. The
// library shows them in their branches (a main branch, its sub-branches …), which admins make,
// rename, move, copy (links to the same book) and delete, like folders and files; and as a tree
// on the left, to go through them and drop books and branches into them.
// Run: node web/tests/levels-test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.PORT ||= '8818';
const { startServer, stopServer, openBrowser, PORT, BASE, sleep } = await import('./harness.mjs');
const tmp = await mkdtemp(path.join(os.tmpdir(), 'lingua-levels-'));
const level = path.join(tmp, 'Level 9');
const slug = 'BO-0123456789abc', page = 'PA-0123456789abc', audio = 'AU-0123456789abc';
const put = async (rel, data) => {
  const file = path.join(level, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
};
await put(`.shared/assets/audio/${audio}/track.mp3`, Buffer.concat([Buffer.from('ID3'), Buffer.alloc(1000, 1)]));
await put('.shared/assets/document/DO-0123456789abc/AEF2e_9_Grammar.pdf', '%PDF-1.4 test');
await put('web/data/books.json', {
  page: { w: 1984, h: 2496 },
  books: [{ id: '9901', slug, title: 'American English File 2e Level 9', type: 'Student Book ', cover: `/web/data/thumbs/${slug}/${page}.webp`,
    pages: [{ n: '1', path: page, txt: true, a: [{ t: 'audio', x: 10, y: 10, title: 'Track 1',
      src: `/.shared/assets/audio/${audio}/track.mp3`, script: `/web/data/scripts/${audio}.json` }] }] }],
  resources: [{ title: 'Grammar', src: '/.shared/assets/document/DO-0123456789abc/AEF2e_9_Grammar.pdf' }],
});
await put(`web/data/pages/${slug}/${page}.webp`, 'RIFF0000WEBP');
await put(`web/data/thumbs/${slug}/${page}.webp`, 'RIFF0000WEBP');
await put(`web/data/text/${slug}/${page}.json`, { words: [[0, 0, 10, 10, 'Hello.', 0, 0]], sent: [[0, 1]], clause: [[0, 1]], blocks: [[0, 1]] });
await put(`web/data/search/${slug}.json`, [{ p: '1', t: 'Hello.' }]);
await put(`web/data/scripts/${audio}.json`, [{ t: 0, x: 'Hello.' }]);
await put('web/edits/secret.json', { secret: true }); // the level folder's own files: never served
await put('web/server-config.json', { secret: true });
const levels = path.join(tmp, 'levels.json');
const branch = (name) => ['Test Courses', 'Test Course', name];
await writeFile(levels, JSON.stringify({ levels: [{ id: '9', name: 'Level 9', folder: level, branch: branch('Level 9') },
  { id: '3', name: 'Level 3', folder: '.', branch: branch('Level 3') }] }));

const server = await startServer({ env: { AEF_LEVELS_FILE: levels } });
const base = `http://127.0.0.1:${PORT}`;
const json = async (url) => (await fetch(base + url)).json();
// Exactly as given (fetch would clean up "..").
const raw = (p, headers = {}) => new Promise((resolve) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p, headers }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', () => resolve(0));
});
try {
  const list = await json('/api/books?scope=local');
  assert.equal(list[0].title, 'Level 9 Student Book', 'the levels in the order of the list, each book with its level');
  const tree = await json('/api/branches');
  const pathOf = (id) => { const b = tree.find((x) => x.id === id); return b ? [...pathOf(b.parent), b.name] : []; };
  assert.deepEqual(pathOf(list[0].branch), branch('Level 9'), 'each level in its branch (made from web/levels.json)');
  assert.deepEqual(pathOf(list.at(-1).branch), branch('Level 3'));
  assert.equal(list[0].cover, `/levels/9/web/data/thumbs/${slug}/${page}.webp`);
  assert.ok(list.slice(1).every((b) => b.title.startsWith('Level 3')), 'this folder\'s books are Level 3');
  console.log('PASS: the library lists the books of every level, with the level in their name');

  const book = await json('/api/books/9901');
  const p = book.pages[0], a = p.a[0];
  assert.equal(p.img, `/levels/9/web/data/pages/${slug}/${page}.webp`);
  assert.equal(a.src, `/levels/9/.shared/assets/audio/${audio}/track.mp3`);
  assert.equal(a.script, `/levels/9/web/data/scripts/${audio}.json`);
  assert.equal(book.resources[0].src, '/levels/9/.shared/assets/document/DO-0123456789abc/AEF2e_9_Grammar.pdf');
  assert.ok(!Object.keys(book).some((k) => k.startsWith('_')), 'nothing of the server\'s own is sent');
  for (const url of [book.cover, p.img, p.thumb, a.src, a.script, book.resources[0].src]) assert.equal(await raw(url), 200, url);
  assert.equal(await raw(a.src, { Range: 'bytes=10-19' }), 206, 'part of a recording (seeking)');
  assert.deepEqual((await json(`/api/text/${slug}/${page}`)).words[0][4], 'Hello.');
  assert.equal((await json(`/api/search/${slug}`))[0].t, 'Hello.');
  const t = await json(`/api/transcript?src=${encodeURIComponent(a.src)}`);
  assert.match(t.error || '', /already has a script/, 'speech recognition finds the recording in its level');
  console.log('PASS: its pages, text, search, recordings, scripts and documents come from its own folder');

  for (const url of ['/levels/9/web/edits/secret.json', '/levels/9/web/server-config.json', '/levels/8/web/data/books.json',
    '/levels/9/.shared/../web/edits/secret.json', '/levels/9/.shared/%2e%2e/web/edits/secret.json',
    '/levels/9/web/data/../../web/server-config.json', '/levels/9/web/data/..%2f..%2fweb/edits/secret.json',
    '/.shared/../web/server-config.json', '/web/data/%2e%2e/server-config.json', '/web/levels.json']) {
    assert.equal(await raw(url), 404, url);
  }
  console.log('PASS: nothing else of a level folder (or of this one) is served, also not with ..');

  // Branches: made by admins (here: on this computer, everyone is), books put in them, found by them.
  const send = (method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => ({ ...(await r.json()), code: r.status }));
  const chinese = await send('POST', '/api/branches', { name: '  Chinese   Courses ', parent: null });
  const hsk = await send('POST', '/api/branches', { name: 'HSK', parent: chinese.id });
  const hsk1 = await send('POST', '/api/branches', { name: 'HSK 1', parent: hsk.id });
  assert.deepEqual([chinese.name, hsk.parent, hsk1.parent], ['Chinese Courses', chinese.id, hsk.id]);
  assert.equal((await send('POST', '/api/branches', { name: 'hsk', parent: chinese.id })).code, 400, 'not two of one name in one branch');
  assert.equal((await send('PUT', `/api/branches/${hsk.id}`, { parent: hsk1.id })).code, 400, 'not into itself');
  const added = await send('POST', '/api/books', { kind: 'text', title: 'Lesson one', branch: hsk1.id });
  assert.equal(added.branch, hsk1.id);
  assert.equal((await send('PUT', `/api/books/${added.id}`, { branch: 99999 })).code, 400, 'only a branch there is');
  assert.equal((await json('/api/books?scope=mine&q=chinese%20courses'))[0]?.id, added.id, 'found by the names of its branches');
  assert.equal((await send('DELETE', `/api/branches/${hsk.id}`)).code, 200);
  assert.equal((await json('/api/books?scope=mine'))[0].branch, hsk1.id);
  assert.equal((await json('/api/branches')).find((x) => x.id === hsk1.id).parent, chinese.id, 'a branch deleted: what was in it goes up');
  console.log('PASS: admins make branches in branches, move and delete them; a book is put in one and found by it');

  // Copies (links: the same book in one more branch, with its own name); the disc's books renamed and moved.
  const again = await send('POST', '/api/links', { book: added.id, branch: chinese.id, title: 'Lesson 1 again' });
  assert.equal(again.code, 200);
  const mine = await json('/api/books?scope=mine');
  assert.deepEqual(mine.map((b) => [b.title, b.branch, b.link ?? null]), [['Lesson one', hsk1.id, null], ['Lesson 1 again', chinese.id, again.id]]);
  assert.equal((await send('PUT', '/api/books/9901', { title: 'Student Book Nine', branch: chinese.id })).code, 200);
  const nine = (await json('/api/books?scope=local')).find((b) => b.id === '9901');
  assert.deepEqual([nine.title, nine.branch], ['Student Book Nine', chinese.id]);
  assert.equal((await json('/api/books/9901')).type, 'Student Book Nine', 'its new name in the reader too');
  await send('PUT', '/api/books/9901', { title: '', branch: list[0].branch });
  assert.equal((await json('/api/books/9901')).type, 'Level 9 Student Book', 'its own name again');
  const copied = await send('POST', `/api/branches/${hsk1.id}/copy`, { parent: chinese.id });
  assert.equal(copied.name, 'HSK 1 (copy)');
  const inCopy = (await json('/api/books?scope=mine')).filter((b) => b.branch === copied.id);
  assert.deepEqual(inCopy.map((b) => [b.id, b.title]), [[added.id, 'Lesson one']], 'a branch copied: copies of its books');
  await send('DELETE', `/api/links/${inCopy[0].link}`);
  await send('DELETE', `/api/branches/${copied.id}`);
  assert.equal((await json('/api/books?scope=mine')).length, 2);
  console.log('PASS: copies of books (each with its own name), the disc\'s books renamed and moved, a branch copied');

  // In the browser: the main branch, in it the course, in it its levels, in a level its books; Back goes up.
  // Like files: new branches, rename, move, new parent branch, cut and paste (Ctrl+X), copy and paste, delete.
  const { browser, page: tab } = await openBrowser({ width: 1200, height: 800 });
  try {
    const errors = [];
    tab.on('pageerror', (e) => errors.push(e.message));
    tab.on('dialog', (d) => d.accept());
    const cards = () => tab.$$eval('#lib-body .book-card', (xs) => xs.map((x) => `${x.classList.contains('folder-card') ? '/' : ''}${x.querySelector('h3').textContent}`));
    const hash = () => decodeURIComponent(new URL(tab.url()).hash);
    const crumbs = () => tab.$eval('.lib-crumbs', (n) => [...n.querySelectorAll('.crumb')].map((c) => c.textContent).join(' › '));
    const open = async (name) => { await tab.click(`.folder-card[data-folder="${name}"] .bc-cover`); await sleep(600); };
    const button = async (text) => {
      await tab.evaluate((t) => [...document.querySelectorAll('#lib-body button, #md-body button')].find((x) => x.textContent.trim().startsWith(t)).click(), text);
      await sleep(600);
    };
    const choose = async (label) => { // (in the menu that is open)
      await tab.evaluate((l) => [...document.querySelectorAll('.lib-menu button')].find((b) => b.querySelector('span').textContent === l).click(), label);
      await sleep(600);
    };
    const menu = async (title, label) => { // the ⋮ menu of the card with this name
      await tab.evaluate((t) => [...document.querySelectorAll('#lib-body .book-card')].find((c) => c.querySelector('h3').textContent === t)
        .querySelector('.bc-more').click(), title);
      await sleep(200);
      await choose(label);
    };
    const fill = (name, where) => tab.evaluate((n, w) => {
      if (n !== null) document.querySelector('#md-body input.input').value = n;
      const select = document.querySelector('#md-body select');
      if (w) select.value = [...select.options].find((o) => o.textContent === w).value;
      document.querySelector('#md-body button[type=submit]').click();
    }, name, where).then(() => sleep(900));
    await tab.goto(BASE + '#/', { waitUntil: 'networkidle0' });
    await tab.click('#library [data-scope="local"]');
    await sleep(600);
    assert.deepEqual(await cards(), ['/Test Courses'], 'the main branch (Chinese Courses has no book of this tab)');
    await open('Test Courses');
    assert.deepEqual(await cards(), ['/Test Course']);
    await open('Test Course');
    assert.deepEqual(await cards(), ['/Level 3', '/Level 9']);
    await open('Level 3');
    assert.deepEqual(await cards(), ['Student Book', 'Workbook', "Teacher's Book"], 'in a level: its books, without its name');
    assert.equal(hash(), '#/@/Test Courses/Test Course/Level 3');
    assert.equal(await crumbs(), 'On this computer › Test Courses › Test Course › Level 3');
    await tab.goBack();
    await sleep(600);
    assert.deepEqual(await cards(), ['/Level 3', '/Level 9'], 'Back: the course');
    console.log('PASS: the library in branches: the main branch, the course, its levels, their books; Back goes up');

    await button('New sub-branch');
    assert.match(await tab.$eval('#md-title', (t) => t.textContent), /New sub-branch in Test Course/);
    await fill('Old levels');
    assert.deepEqual(await cards(), ['/Level 3', '/Level 9', '/Old levels'], 'a new branch (empty: admins see it)');
    assert.equal(await tab.$eval('.folder-card[data-folder="Old levels"] .bc-meta', (m) => m.textContent), 'Empty');
    await menu('Level 9', 'Move to…');
    await fill(null, 'Test Courses › Test Course › Old levels');
    assert.deepEqual(await cards(), ['/Level 3', '/Old levels'], 'a level moved into it');
    await open('Old levels');
    assert.deepEqual(await cards(), ['/Level 9']);
    await button('This branch');
    await choose('Rename…');
    await fill('Earlier levels');
    assert.equal(hash(), '#/@/Test Courses/Test Course/Earlier levels', 'renamed: still in it');
    await button('This branch');
    await choose('New parent branch…');
    await fill('Archive');
    assert.equal(await crumbs(), 'On this computer › Test Courses › Test Course › Archive › Earlier levels', 'a new branch around it');
    await tab.evaluate(() => [...document.querySelectorAll('.lib-crumbs button.crumb')].find((c) => c.textContent === 'Test Course').click());
    await sleep(600);
    assert.deepEqual(await cards(), ['/Archive', '/Level 3']);

    // Cut a book with Ctrl+X, paste it in another branch; copy it (menu), paste the copy, rename the copy.
    await open('Level 3');
    await tab.evaluate(() => [...document.querySelectorAll('#lib-body .book-card')].find((c) => c.querySelector('h3').textContent === 'Workbook')
      .querySelector('.bc-title').focus());
    await tab.keyboard.down('Control');
    await tab.keyboard.press('x');
    await tab.keyboard.up('Control');
    await sleep(700);
    assert.equal(await tab.$eval('#lib-body .book-card.is-cut h3', (h) => h.textContent), 'Workbook', 'cut: faded until pasted');
    await tab.goBack();
    await sleep(600);
    await button('Paste');
    assert.deepEqual(await cards(), ['/Archive', '/Level 3', 'Level 3 Workbook'], 'pasted: moved here');
    await menu('Level 3 Workbook', 'Copy');
    await open('Archive');
    await button('Paste');
    assert.deepEqual(await cards(), ['/Earlier levels', 'Level 3 Workbook'], 'a copy pasted');
    assert.ok(await tab.$$eval('#lib-body .book-card .badge', (b) => b.some((x) => x.textContent === 'Copy')));
    await menu('Level 3 Workbook', 'Rename…');
    await fill('Workbook to keep');
    assert.deepEqual(await cards(), ['/Earlier levels', 'Workbook to keep'], 'only the copy renamed');
    await tab.evaluate(() => [...document.querySelectorAll('.lib-crumbs button.crumb')].find((c) => c.textContent === 'Test Course').click());
    await sleep(600);
    assert.deepEqual(await cards(), ['/Archive', '/Level 3', 'Level 3 Workbook'], 'the book itself as it was');

    // Copy a branch (its books: copies), then delete a copy of a book.
    await menu('Level 3', 'Copy');
    await button('Paste');
    assert.deepEqual(await cards(), ['/Archive', '/Level 3', '/Level 3 (copy)', 'Level 3 Workbook']);
    await open('Level 3 (copy)');
    assert.deepEqual(await cards(), ['Level 3 Student Book', "Level 3 Teacher's Book"], '(their whole names: not in Level 3)');
    await menu('Level 3 Student Book', 'Delete this copy');
    assert.deepEqual(await cards(), ["Level 3 Teacher's Book"], 'a copy deleted');
    await tab.goBack();
    await sleep(600);
    await open('Level 3');
    assert.deepEqual(await cards(), ['Student Book', "Teacher's Book"], 'the books themselves stay');
    await tab.goBack();
    await sleep(600);
    console.log('PASS: like files: new branch, move to, rename, new parent branch, cut and paste, copy and paste (books, branches), delete a copy');

    // The tree on the left: every branch (the open one marked, the ones it is in open); a click opens one
    // and unfolds or folds it, › only that, the keys go through it; a book or branch dragged onto it goes
    // into it (Ctrl: a copy).
    const tree = () => tab.$$eval('#lib-tree [role=treeitem]', (xs) => xs.filter((x) => !x.parentElement.closest('[aria-expanded="false"]'))
      .map((x) => `${'-'.repeat(x.getAttribute('aria-level') - 1)}${x.getAttribute('aria-selected') === 'true' ? '*' : ''}${x.querySelector('.tree-name').textContent}`));
    const inTree = (name, act) => tab.evaluate((n, a) => {
      const row = [...document.querySelectorAll('#lib-tree .tree-row')].find((r) => r.querySelector('.tree-name').textContent === n);
      if (a === 'twisty') row.querySelector('.tree-twisty').click();
      else if (a === 'focus') row.parentElement.focus();
      else row.click();
    }, name, act).then(() => sleep(700));
    const key = (k) => tab.keyboard.press(k).then(() => sleep(400));
    const focused = () => tab.evaluate(() => document.activeElement.querySelector('.tree-name')?.textContent);
    const drag = (from, to, ctrlKey = false) => tab.evaluate((f, t, ctrl) => { // (a card, or tree:<branch>, onto a branch of the tree)
      const find = (name) => (name.startsWith('tree:') ? [...document.querySelectorAll('#lib-tree .tree-row')].find((r) => r.querySelector('.tree-name').textContent === name.slice(5))
        : [...document.querySelectorAll('#lib-body .book-card')].find((c) => c.querySelector('h3').textContent === name));
      const source = find(f), target = find(`tree:${t}`), dataTransfer = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
      for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, ctrlKey: ctrl }));
      source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
    }, from, to, ctrlKey).then(() => sleep(1000));
    assert.deepEqual(await tree(), ['On this computer', '-Test Courses', '--*Test Course', '---Archive', '----Earlier levels', '-----Level 9', '---Level 3', '---Level 3 (copy)']);
    await inTree('Level 9');
    assert.equal(hash(), '#/@/Test Courses/Test Course/Archive/Earlier levels/Level 9', 'a branch of the tree clicked: opened');
    assert.deepEqual(await cards(), ['Student Book']);
    assert.ok((await tree()).includes('-----*Level 9'));
    await inTree('Archive', 'twisty');
    assert.deepEqual(await tree(), ['On this computer', '-Test Courses', '--Test Course', '---Archive', '---Level 3', '---Level 3 (copy)'], '▸: closed in the tree');
    assert.equal(hash(), '#/@/Test Courses/Test Course/Archive/Earlier levels/Level 9', '(still open on the right)');
    await inTree('Archive', 'focus');
    await key('ArrowRight');
    await key('ArrowDown');
    assert.equal(await focused(), 'Earlier levels', '→ opens it, ↓ goes down');
    await key('Enter');
    assert.equal(hash(), '#/@/Test Courses/Test Course/Archive/Earlier levels', 'Enter: opened');
    assert.equal(await focused(), 'Earlier levels');
    await key('ArrowLeft');
    assert.ok(!(await tree()).includes('-----Level 9'), '← closes it');
    await key('ArrowLeft');
    assert.equal(await focused(), 'Archive', '← again: up');
    await inTree('Earlier levels');
    assert.ok((await tree()).includes('-----Level 9'), 'a click on a folded branch: unfolded');
    assert.equal(hash(), '#/@/Test Courses/Test Course/Archive/Earlier levels');
    await inTree('Earlier levels');
    assert.ok(!(await tree()).includes('-----Level 9'), 'clicked again: folded');
    await inTree('Test Course');
    assert.deepEqual(await tree(), ['On this computer', '-Test Courses', '--*Test Course'], 'another branch, unfolded: opened and folded');
    assert.equal(hash(), '#/@/Test Courses/Test Course');
    await inTree('Test Course');
    assert.deepEqual(await tree(), ['On this computer', '-Test Courses', '--*Test Course', '---Archive', '----Earlier levels', '---Level 3', '---Level 3 (copy)']);
    assert.deepEqual(await cards(), ['/Archive', '/Level 3', '/Level 3 (copy)', 'Level 3 Workbook']);
    await drag('Level 3 Workbook', 'Level 3');
    assert.deepEqual(await cards(), ['/Archive', '/Level 3', '/Level 3 (copy)'], 'a book dragged onto a branch of the tree: moved into it');
    await drag('tree:Level 3 (copy)', 'Archive');
    assert.deepEqual(await cards(), ['/Archive', '/Level 3'], 'a branch dragged in the tree: moved');
    await drag('tree:Archive', 'Level 3 (copy)');
    assert.deepEqual(await cards(), ['/Archive', '/Level 3'], 'not into a branch in it');
    await inTree('Level 3');
    await drag('Workbook', 'Archive', true);
    assert.deepEqual(await cards(), ['Student Book', 'Workbook', "Teacher's Book"], 'Ctrl: a copy (the book stays)');
    await inTree('Archive');
    assert.deepEqual(await cards(), ['/Earlier levels', '/Level 3 (copy)', 'Workbook to keep', 'Level 3 Workbook']);
    await tab.click('#lib-tree-btn');
    assert.equal(await tab.$eval('#lib-tree', (t) => getComputedStyle(t).display), 'none', 'the button hides the tree');
    await tab.click('#lib-tree-btn');
    assert.equal(await tab.$eval('#lib-tree', (t) => getComputedStyle(t).display), 'block');
    await inTree('Test Course');
    console.log('PASS: the tree of branches: click, ▸, the keys, drag and drop (moved; Ctrl: a copy; not into itself), hidden and shown');

    await tab.click('#library [data-scope="mine"]');
    await sleep(600);
    assert.deepEqual(await cards(), ['/Chinese Courses']);
    await open('Chinese Courses');
    assert.deepEqual(await cards(), ['/HSK 1', 'Lesson 1 again']);
    await open('HSK 1');
    assert.deepEqual(await cards(), ['Lesson one']);
    await menu('Lesson one', 'Settings and sharing…');
    assert.equal(await tab.$eval('#md-body select', (s) => s.selectedOptions[0].textContent), 'Chinese Courses › HSK 1', 'its branch in its settings');
    await tab.keyboard.press('Escape');
    await sleep(300);
    await tab.click('#lib-add');
    await sleep(400);
    assert.equal(await tab.$eval('#md-body select', (s) => s.selectedOptions[0].textContent), 'Chinese Courses › HSK 1', 'a book added in the open branch');
    await tab.mouse.click(5, 400); // (outside the dialog)
    await sleep(300);
    assert.ok(await tab.$eval('#media-dialog', (d) => d.open), 'a click outside "Add a book": it stays open (× closes it)');
    await tab.keyboard.press('Escape');
    await sleep(300);
    await tab.click('#library [data-scope="local"]');
    await sleep(600);
    assert.equal(hash(), '#/@/Test Courses/Test Course', 'each tab in its own branch');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
  console.log('PASS: your own books: their branch in their settings, added in the open branch; each tab in its own branch');
} finally {
  stopServer(server);
  await rm(tmp, { recursive: true, force: true });
}

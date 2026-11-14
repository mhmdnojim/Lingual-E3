// The page-layout editor's tools (web/js/designs.js), as the owner uses them:
//  - the open tab is clearly marked;
//  - "Draw areas in reading order": the first box drawn is number 1, then 2 …; boxes not numbered follow, faded;
//  - "Merge in chosen order": the areas chosen are numbered 1, 2 on the page; "Finish merge" joins them;
//  - sentences: numbered on the page (every sentence on the Merge tab), chosen by a click in the order
//    chosen, merged into the first one chosen, the result shown first;
//  - "Draw boxes to read": boxes read again with OCR, checked (numbered sentences), used to replace or add;
//  - Apply shows the pages changed and its progress by the button;
//  - "Play this page aloud" highlights each sentence; "Dictate" writes into the selected area's text.
// Run: node web/tests/layout-tools-test.mjs
import assert from 'node:assert/strict';

process.env.PORT ||= '18940';
const { startServer, stopServer, openBrowser, sleep, BASE } = await import('./harness.mjs');

function fixturePdf() {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (let i = 1; i <= 2; i++) {
    const lines = [[50, 740, 24, 'Our reading page'],
      [50, 690, 14, 'First paragraph has one sentence. It also has a second sentence.'],
      [50, 660, 14, 'Third sentence is here. And a fourth one follows.'],
      [50, 560, 14, 'Second paragraph starts here. It has two sentences.'],
      [50, 460, 14, 'A lonely third paragraph. With another sentence.'],
      [50, 300, 14, 'Fourth paragraph at the bottom. The last sentence.']];
    const content = lines.map(([x, y, size, text]) => `BT /F1 ${size} Tf ${x} ${y} Td (${text}) Tj ET`).join('\n');
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${objs.length} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    kids.push(`${objs.length} 0 R`);
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count 2 >>`;
  let pdf = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => { const n = pdf.length; pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; return n; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  return Buffer.from(pdf + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1');
}

let server, browser;
try {
  server = await startServer();
  const opened = await openBrowser({ width: 1500, height: 1000 });
  browser = opened.browser;
  const { page } = opened;
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  // (stand-ins: the browser's dictation, and speech that takes a moment per sentence)
  await page.evaluateOnNewDocument(() => {
    const Fake = class { constructor() { window.__rec = this; } start() { this.started = true; } stop() { this.started = false; this.onend?.(); } };
    window.webkitSpeechRecognition = Fake; window.SpeechRecognition = Fake; // (a browser has one of the two names, or both)
  });
  const api = (method, url, body) => page.evaluate(async (m, u, b) => {
    const r = await fetch(u, { method: m, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
    const data = await r.json(); if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`); return data;
  }, method, url, body);
  await page.goto(BASE);
  const book = await api('POST', '/api/books', { kind: 'pdf', title: 'Layout tools fixture', importOptions: { language: 'en' } });
  await page.evaluate(async (id, bytes) => { await fetch(`/api/books/${id}/source/pdf`, { method: 'PUT', body: new Uint8Array(bytes) }); }, book.id, [...fixturePdf()]);
  await api('POST', `/api/books/${book.id}/layouts`, { options: { language: 'en' } });
  for (let i = 0; i < 150; i++) { if ((await api('GET', `/api/books/${book.id}/preview`)).state === 'ready') break; await sleep(200); }
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !!window.aef);
  await page.evaluate(() => window.aef.goHome());
  await page.waitForFunction(() => document.body.classList.contains('lib-open'));
  await page.click('#library [role="tab"][data-scope="mine"]');
  await page.waitForSelector(`.book-card[data-id="${book.id}"] .bc-cover`);
  await page.click(`.book-card[data-id="${book.id}"] .bc-cover`);
  await page.waitForSelector('.design-editor', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll('.design-area').length >= 5, { timeout: 20000 });

  const shot = (name) => (process.env.SHOTS ? page.screenshot({ path: `${process.env.SHOTS}/${name}.png` }) : null); // (SHOTS=folder: pictures to look at)
  const ui = {
    status: () => page.$eval('.design-controls > .hint[aria-live="polite"]', (e) => e.textContent),
    areas: () => page.$$eval('.design-area', (rows) => rows.map((r) => ({ n: r.querySelector('.n').textContent, text: r.querySelector('.design-area-content').textContent, faded: r.classList.contains('unordered') }))),
    frameLabels: () => page.$$eval('.frames .frame', (gs) => gs.map((g) => g.querySelector('text').textContent)),
    tab: async (name) => { await page.click(`#layout-tab-${name}`); await sleep(150); },
    action: async (label) => {
      const ok = await page.evaluate((l) => { const b = [...document.querySelectorAll('.layout-tool-action')].find((x) => x.textContent.trim().startsWith(l)); if (!b || b.disabled) return false; b.click(); return true; }, label);
      if (!ok) await shot('shot-fail');
      assert.ok(ok, `the button "${label}" is there and enabled; the buttons are: ${await page.$$eval('.layout-tool-action', (b) => b.map((x) => `${x.textContent.trim()}${x.disabled ? ' (off)' : ''}`).join(' | '))}; errors: ${errors.join(' ; ')}`);
      await sleep(150);
    },
    drag: async (x0, y0, x1, y1) => {
      const r = await page.$eval('.design-stage svg.framed', (s) => { const b = s.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
      await page.mouse.move(r.x + r.w * x0, r.y + r.h * y0);
      await page.mouse.down();
      await page.mouse.move(r.x + r.w * x1, r.y + r.h * y1, { steps: 5 });
      await page.mouse.up();
      await sleep(120);
    },
  };
  for (let i = 0; i < 5; i++) await page.click('.design-editor [aria-label="Zoom out"]'); // (the whole page in view: boxes can be drawn anywhere on it)
  await sleep(300);
  const first = await ui.areas();
  assert.ok(first.length >= 5, `areas found: ${first.length}`);

  // ---- The open tab is clearly marked.
  const looks = await page.$$eval('.layout-tool-tab', (tabs) => tabs.map((t) => [t.textContent, t.getAttribute('aria-selected'), getComputedStyle(t).backgroundColor]));
  const marked = looks.filter(([, selected]) => selected === 'true');
  assert.equal(marked.length, 1);
  assert.notEqual(marked[0][2], 'rgba(0, 0, 0, 0)', 'the open tab is filled');
  assert.ok(looks.filter(([, selected]) => selected !== 'true').every(([, , bg]) => bg === 'rgba(0, 0, 0, 0)'), 'the other tabs are not');
  await ui.tab('order');
  assert.equal(await page.$eval('#layout-tab-order', (t) => t.getAttribute('aria-selected')), 'true');
  assert.notEqual(await page.$eval('#layout-tab-order', (t) => getComputedStyle(t).backgroundColor), 'rgba(0, 0, 0, 0)');

  // ---- Draw areas in reading order: the first box drawn is number 1 (not the last one of the page).
  const before = first.length;
  await ui.action('Draw areas in reading order');
  await ui.drag(0.05, 0.6, 0.9, 0.66);   // "Fourth paragraph at the bottom…" first
  let rows = await ui.areas();
  assert.equal(rows.length, before + 1);
  assert.equal(rows[0].n, '1', 'the box drawn first is number 1');
  assert.ok(rows.slice(1).every((r) => r.faded), 'the boxes not numbered yet are faded');
  assert.match(await ui.status(), /Box 1 numbered/);
  await shot('shot-1-order');
  await ui.drag(0.05, 0.05, 0.9, 0.12);   // then the heading
  rows = await ui.areas();
  assert.equal(rows.length, before + 2);
  assert.deepEqual(rows.slice(0, 2).map((r) => r.n), ['1', '2']);
  assert.match(await page.$eval('.design-area:nth-child(1) .design-area-content', (e) => e.textContent), /Fourth paragraph|last sentence/i, 'number 1 is the box drawn first (the bottom paragraph)');
  // A click on a box that has no number yet gives it the next number.
  const clicked = await page.$eval('.frames .frame:nth-of-type(5) > rect:first-child', (r) => { const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
  await page.mouse.click(clicked.x, clicked.y);
  await sleep(150);
  rows = await ui.areas();
  assert.equal(rows.filter((r) => !r.faded).length, 3, 'the clicked box is number 3');
  // Delete the boxes I did not number; Undo brings them back.
  await ui.action('Delete the');
  rows = await ui.areas();
  assert.equal(rows.length, 3, 'only the 3 boxes numbered are left');
  await ui.action('Finish ordering');
  await page.click('[aria-label="Undo the last layout edit"]'); // (the deletion)
  await sleep(150);
  assert.equal((await ui.areas()).length, before + 2, 'Undo brings the deleted boxes back');
  await page.click('[aria-label="Undo the last layout edit"]'); await page.click('[aria-label="Undo the last layout edit"]'); await page.click('[aria-label="Undo the last layout edit"]');
  await page.click('[aria-label="Undo the last layout edit"]').catch(() => {});
  await sleep(150);
  assert.equal((await ui.areas()).length, before, 'Undo takes the numbered boxes back too');

  // ---- Merge in chosen order: the areas chosen are numbered on the page; Finish merge joins them.
  await ui.tab('merge');
  await ui.action('Merge in chosen order');
  const clickFrame = async (k) => {
    const c = await page.$eval(`.frames .frame[data-k="${k}"] > rect:first-child`, (r) => { const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
    await page.mouse.click(c.x, c.y); await sleep(120);
  };
  await clickFrame(3); await clickFrame(1);
  const picks = await page.$$eval('.frames .frame.merge-picked', (gs) => gs.map((g) => [g.dataset.k, g.querySelector('.merge-pick text').textContent]));
  assert.deepEqual(picks.sort(), [['1', '2'], ['3', '1']], 'area 4 was chosen first (1), area 2 second (2)');
  assert.match(await ui.status(), /4 → 2/);
  await shot('shot-2-merge-areas');
  const finish = await page.$eval('.layout-tool-action.primary', (b) => b.textContent);
  assert.match(finish, /Finish merge: join 2 areas/);
  await ui.action('Finish merge');
  assert.equal((await ui.areas()).length, before - 1, 'the two areas became one');
  assert.match(await ui.status(), /draft: press Apply changes/);
  await page.click('[aria-label="Undo the last layout edit"]');
  await sleep(150);

  // ---- Sentences: every sentence numbered on the page; a click chooses it; numbers follow the order chosen.
  await page.waitForFunction(() => document.querySelectorAll('.layout-sentence-hit').length >= 8, { timeout: 15000 });
  const numbers = await page.$$eval('.frames .layout-sentence-number text', (t) => t.map((x) => x.textContent));
  assert.ok(numbers.length >= 8, `sentence numbers on the page: ${numbers.join(',')}`);
  const hit = (n) => `.layout-sentence-hit[data-sentence="${n}"]`;
  const ids = await page.$$eval('.layout-sentence-hit', (h) => [...new Set(h.map((x) => x.dataset.sentence))]);
  const rowsText = await page.$$eval('.layout-sentence-merge-row', (r) => r.map((x) => x.textContent));
  const nth = (word) => rowsText.findIndex((t) => t.includes(word));
  const fourth = ids[nth('And a fourth one follows.')], second = ids[nth('First paragraph has one sentence.')];
  await page.click(hit(fourth)); await sleep(120);
  await page.click(hit(second)); await sleep(120);
  const pickedNumbers = await page.$$eval('.frames .layout-sentence-number.picked text', (t) => t.map((x) => x.textContent));
  assert.deepEqual(pickedNumbers.sort(), ['1', '2'], 'the sentences chosen are numbered 1, 2 on the page');
  await shot('shot-3-sentences');
  assert.match(await page.$eval('.layout-merge-preview', (e) => e.textContent), /And a fourth one follows\. First paragraph has one sentence\./, 'the result is shown first, in the order chosen');
  await ui.action('Merge selected sentences (2)');
  assert.match(await ui.status(), /Merged 2 sentences in the order you chose them/);
  rows = await ui.areas();
  assert.ok(rows.some((r) => r.text.includes('And a fourth one follows. First paragraph has one sentence.')), 'the first chosen sentence now holds the second');
  await page.click('[aria-label="Undo the last layout edit"]');
  await sleep(150);

  // ---- Draw boxes to read: two boxes, read with OCR, checked, used.
  await ui.tab('read');
  await ui.action('Draw boxes to read');
  await ui.drag(0.04, 0.27, 0.9, 0.33);
  await ui.drag(0.04, 0.4, 0.9, 0.45);
  assert.equal(await page.$$eval('.layout-reread-box', (g) => g.length), 2, 'two boxes drawn on the page (A and B)');
  assert.deepEqual(await page.$$eval('.layout-reread-box text', (t) => t.map((x) => x.textContent)), ['A', 'B']);
  await ui.action('Read 2 boxes');
  await page.waitForSelector('.layout-ocr-review-box', { timeout: 60000 });
  const reviewBoxes = await page.$$eval('.layout-ocr-review-box', (b) => b.map((x) => x.textContent));
  assert.equal(reviewBoxes.length, 2, 'each box is checked on its own');
  await shot('shot-4-reread');
  const reviewNumbers = await page.$$eval('.layout-ocr-review-row .layout-merge-order', (t) => t.map((x) => x.textContent));
  assert.deepEqual(reviewNumbers, reviewNumbers.map((_, i) => String(i + 1)), 'its sentences are numbered one after the other');
  assert.ok((await page.$$('.frames .layout-sentence-number')).length >= 2, 'the sentences found are numbered on the page');
  const areasBefore = (await ui.areas()).length;
  await page.evaluate(() => [...document.querySelectorAll('.layout-ocr-review .btn.primary')].find((b) => /Use selected sentences/.test(b.textContent)).click());
  await sleep(200);
  assert.match(await ui.status(), /2 boxes used in the layout draft/);
  assert.ok((await ui.areas()).length >= areasBefore, 'boxes replaced an area or were added');

  // ---- Apply: the pages changed are listed; the progress is by the button.
  const changed = await page.$$eval('.layout-changed-page', (b) => b.map((x) => x.textContent));
  assert.deepEqual(changed, ['1'], 'page 1 has changes not applied yet');
  assert.match(await page.$eval('.layout-tool-apply .btn.primary', (b) => b.textContent), /Apply changes & build the book \(1 page changed\)/);
  await page.click('.layout-tool-apply .btn.primary');
  await page.waitForFunction(() => /Book rebuilt/.test(document.querySelector('.design-controls > .hint[aria-live="polite"]')?.textContent || ''), { timeout: 120000 });
  assert.equal(await page.$$eval('.layout-changed-page', (b) => b.length), 0, 'applied: nothing is waiting any more');
  assert.equal(await page.$eval('.layout-tool-apply .rec-progress', (b) => b.hidden), true);

  // ---- The book is made now: Apply makes again only the page with changes.
  const status = () => page.$eval('.design-controls > .hint[aria-live="polite"]', (e) => e.textContent);
  await page.waitForFunction(() => /Book rebuilt/.test(document.querySelector('.design-controls > .hint[aria-live="polite"]')?.textContent || '') && document.querySelectorAll('.design-area').length > 1, { timeout: 30000 });
  await sleep(800);
  const madeBefore = (await api('GET', `/api/books/${book.id}`)).updated;
  await ui.tab('merge');
  const before2 = (await ui.areas()).length;
  await page.$eval('.design-area:first-child .n', (e) => e.click());
  await ui.action('Merge with next area');
  assert.equal((await ui.areas()).length, before2 - 1, 'merged in the draft');
  assert.match(await page.$eval('.layout-tool-apply .btn.primary', (b) => b.textContent), /Apply changes to page 1$/);
  await sleep(1100); // (the book's time stamp counts seconds)
  await page.click('.layout-tool-apply .btn.primary');
  await page.waitForFunction(() => /Page 1 made again/.test(document.querySelector('.design-controls > .hint[aria-live="polite"]')?.textContent || ''), { timeout: 120000 });
  const job = await api('GET', `/api/books/${book.id}/job`);
  assert.deepEqual(job.job.pages, [1], 'only page 1 was made again');
  assert.equal(job.status, 'ready');
  assert.ok(job.book.updated > madeBefore, 'the book knows it changed');
  assert.equal(await page.$$eval('.layout-changed-page', (b) => b.length), 0);
  await sleep(800);
  assert.equal((await ui.areas()).length, before2 - 1, 'the merged layout is kept after applying');

  // ---- Read this page again: a real new reading of the page (not the book's saved text).
  await ui.tab('read');
  await ui.action('Read this page again');
  await page.waitForFunction(() => /read using PDF text/.test(document.querySelector('.design-controls > .hint[aria-live="polite"]')?.textContent || ''), { timeout: 60000 });
  assert.equal((await ui.areas()).length, before2, 'the areas were found again');

  // ---- Read the selected area again: its text is replaced at once.
  await page.$eval('.design-area:nth-child(2) .n', (e) => e.click()); // (not by its place on the screen: the pinned tools can be over it)
  await ui.action('Read the selected area again');
  await page.waitForFunction(() => /Area 2 read again: \d+ sentence/.test(document.querySelector('.design-controls > .hint[aria-live="polite"]')?.textContent || ''), { timeout: 60000 });
  assert.equal(await page.$('.layout-ocr-review'), null, 'no extra step');
  assert.match(await page.$eval('.layout-tool-apply .btn.primary', (b) => b.textContent), /Apply changes to page 1$/);
  void status;


  // ---- Audio: the book's recordings are added here; a play button is put, dragged, listened to.
  await ui.tab('audio');
  await page.waitForSelector('.layout-panel-host .media-box', { timeout: 5000 });
  assert.match(await page.$eval('.layout-panel-host .media-box', (e) => e.textContent), /Add a folder….*Add files…/s);
  {
    const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
    const wav = Buffer.alloc(44 + 800); wav.write('RIFF', 0); wav.writeUInt32LE(36 + 800, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
    wav.write('data', 36); wav.writeUInt32LE(800, 40);
    const file = path.join(os.tmpdir(), 'Fixture_1.01.wav'); fs.writeFileSync(file, wav);
    const input = await page.$('.layout-panel-host .media-box input[type=file]:not([webkitdirectory])');
    await input.uploadFile(file);
  }
  await page.waitForFunction(() => /1 recording/.test(document.querySelector('.layout-panel-host .media-box')?.textContent || ''), { timeout: 30000 });
  // Scripts: every recording with its state; some or all can be written; pause and cancel are there.
  await page.waitForSelector('.layout-audio-step .media-scripts:not([hidden]) .media-script-row', { timeout: 10000 });
  assert.match(await page.$eval('.media-script-sum', (e) => e.textContent), /0 of 1 written/);
  assert.match(await page.$eval('.media-script-row .media-script-state', (e) => e.textContent), /Not written yet/);
  assert.equal(await page.$eval('.media-script-buttons .btn.primary', (b) => b.disabled), true, 'nothing chosen: nothing to write');
  await page.click('.media-script-all input');
  assert.equal(await page.$eval('.media-script-buttons .btn.primary', (b) => b.disabled), false, 'one chosen');
  assert.ok(await page.$eval('.media-script-buttons', (e) => /Pause/.test(e.textContent) && /Cancel/.test(e.textContent)), 'pause and cancel');
  await page.click('.media-script-all input');
  await shot('shot-8-scripts');
  await ui.action('Add a play button here…');
  await page.waitForSelector('.layout-audio-step select[aria-label="Choose a saved recording"]', { timeout: 10000 });
  await page.evaluate(() => [...document.querySelectorAll('.layout-audio-step .btn')].find((b) => /^Then click on the page/.test(b.textContent.trim())).click());
  const pageBox = await page.$eval('.design-editor svg.framed', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await page.mouse.click(pageBox.x + pageBox.w * 0.7, pageBox.y + pageBox.h * 0.6);
  await page.waitForSelector('.layout-play-marker', { timeout: 10000 });
  const placed = (await api('GET', `/api/books/${book.id}`)).pages[0].a;
  assert.equal(placed.length, 1, 'the play button is on page 1');
  await page.mouse.move(pageBox.x + pageBox.w * 0.7, pageBox.y + pageBox.h * 0.6); await page.mouse.down();
  await page.mouse.move(pageBox.x + pageBox.w * 0.3, pageBox.y + pageBox.h * 0.8, { steps: 6 }); await page.mouse.up();
  await page.waitForFunction(() => /Play button saved/.test(document.querySelector('.design-controls > .hint[aria-live="polite"]')?.textContent || ''), { timeout: 10000 });
  const moved = (await api('GET', `/api/books/${book.id}`)).pages[0].a;
  assert.ok(moved.length === 1 && moved[0].x < placed[0].x - 50 && moved[0].y > placed[0].y + 20, 'dragging the button moved it');
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('.layout-button-row .btn')].some((b) => b.textContent.trim() === 'Listen')), 'it can be listened to from the list');
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('.layout-tool-action')].some((b) => /Make new audio/.test(b.textContent) && !b.disabled)), 'new audio can be made for a finished book');
  await shot('shot-6-audio');

  // ---- Play this page aloud: each sentence highlighted as it is read.
  await page.evaluate(() => {
    window.__said = [];
    window.speechSynthesis.speak = (u) => { window.__said.push(u.text); setTimeout(() => u.onend?.(), 700); };
  });
  await ui.tab('read');
  await ui.action('Play this page aloud');
  await page.waitForSelector('.layout-active-sentence', { timeout: 5000 });
  assert.match(await ui.status(), /each one highlighted as it is read/);
  assert.ok(await page.$('.layout-sentence-number.active'), 'the sentence being read has its number marked');
  await shot('shot-5-play');
  await ui.action('Stop reading');

  // ---- Audio tab: play mode (a click on a sentence reads from it); new audio made inside the window.
  const centerOf = async (n) => page.$$eval('.layout-sentence-hit', (els, k) => { const r = els[k].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, n);
  await page.click('.layout-tool-apply .btn.primary'); // (new audio is made from the sentences of the book: apply what was read again)
  await page.waitForFunction(() => /Page 1 made again/.test(document.querySelector('.design-controls > .hint[aria-live="polite"]')?.textContent || ''), { timeout: 120000 });
  await ui.tab('audio');
  await ui.action('Play mode');
  await page.waitForSelector('.layout-sentence-hit', { timeout: 10000 });
  await page.evaluate(() => { window.__said = []; });
  const hitCount = await page.$$eval('.layout-sentence-hit', (els) => els.length);
  assert.ok(hitCount >= 2, 'every sentence of the page can be clicked');
  {
    const c = await centerOf(1);
    await page.mouse.click(c.x, c.y);
  }
  await page.waitForFunction(() => window.__said.length > 0, { timeout: 5000 });
  assert.ok(await page.$('.layout-active-sentence'), 'the sentence clicked is being read');
  await ui.action('Stop reading');
  await ui.action('Play mode: on');
  await ui.action('Make new audio (natural voice)…');
  await page.waitForSelector('.layout-sentence-hit', { timeout: 10000 });
  {
    const c = await centerOf(0);
    await page.mouse.click(c.x, c.y);
  }
  await page.waitForFunction(() => [...document.querySelectorAll('.layout-tool-panel .layout-tool-action, .layout-panel-host .btn')].some((b) => /Create audio… \(1\)/.test(b.textContent) && !b.disabled), { timeout: 10000 }).catch(async () => {
    assert.fail(`no Create audio button: ${await page.$eval('.design-controls', (e) => e.textContent.slice(0, 600))}`);
  });
  await page.evaluate(() => [...document.querySelectorAll('.layout-panel-host .btn, .layout-tool-panel .btn')].find((b) => /Create audio… \(1\)/.test(b.textContent)).click());
  await page.waitForSelector('.layout-panel-host .rec-form', { timeout: 10000 }).catch(async (e) => { assert.fail(`no form: ${await page.$eval('.design-controls', (x) => x.textContent.slice(0, 500))} | errors ${JSON.stringify(errors)}`); });
  assert.ok(await page.$('.layout-panel-host .rec-form [data-role="audio-voice"]'), 'the voice choices are in the layout window itself');
  assert.ok(await page.$('.design-editor'), 'the layout window is still open');
  await shot('shot-7-new-audio');
  await page.evaluate(() => [...document.querySelectorAll('.layout-panel-host .rec-form .btn')].find((b) => b.textContent.trim() === 'Cancel').click());
  await page.waitForFunction(() => !document.querySelector('.layout-panel-host .rec-form'), { timeout: 5000 });
  assert.ok(await page.$('.design-editor'), 'cancel keeps the layout window open');
  {
    // the title and the close button of the window are in view
    const box = await page.$eval('#md-close', (b) => { const r = b.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, right: r.right }; });
    assert.ok(box.top >= 0 && box.bottom <= (await page.evaluate(() => innerHeight)), 'the window’s close button is visible');
  }

  // ---- Dictate: the microphone writes into the text of the selected area.
  await ui.tab('text');
  await page.click('.design-area:nth-child(2) .n');
  await ui.action('Dictate');
  assert.equal(await page.evaluate(() => window.__rec.started), true, 'listening');
  assert.ok(await page.$('.design-area-text-editor'), 'the text of the box is open for writing');
  await page.evaluate(() => window.__rec.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'Dictated words go here.' }], { isFinal: true })] }));
  assert.match(await page.$eval('.design-area-text-editor', (t) => t.value), /Dictated words go here\./);
  await ui.action('Stop dictation');
  assert.equal(await page.evaluate(() => window.__rec.started), false, 'the microphone is off');

  assert.deepEqual(errors, []);
  console.log('PASS: open tab marked, reading order from 1, numbered merge picks, sentence merge, boxes read again, apply progress, play aloud, dictation');
} finally {
  await browser?.close();
  await stopServer(server);
}

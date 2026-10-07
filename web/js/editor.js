// Text corrections: change, split, merge, move, add and delete sentences, start or join
// paragraphs, and mark where a sentence is on the page. Each page is saved on the local
// server (web/edits/), so corrections survive a rebuild of web/data.
import { $, $$, el, icon, toast, forgetJSON } from './util.js';
import { clauseRanges } from './segment.js';

const MAX_UNDO = 80;

// ---------------------------------------------------------------- Page text <-> editable model
// model = [block, ...], block = [sentence, ...], sentence = [word, ...]
// word  = {t: text, box: [x, y, w, h] or null (not on the page image), line, sp: space after}

export function toModel(doc) {
  if (!doc) return [];
  return doc.blocks.map(([sa, sb]) => {
    const sents = [];
    for (let s = sa; s < sb; s++) {
      const [a, b] = doc.sent[s];
      sents.push(doc.words.slice(a, b).map((w) => ({
        t: w[4], box: w[2] > 0 || w[3] > 0 ? [w[0], w[1], w[2], w[3]] : null, line: w[5], sp: w[6],
      })));
    }
    return sents;
  }).filter((block) => block.length);
}

export function toDoc(model) {
  const words = [], sent = [], clause = [], blocks = [];
  for (const block of model) {
    const first = sent.length;
    for (const s of block) {
      if (!s.length) continue;
      const a = words.length;
      for (const w of s) {
        words.push(w.box ? [...w.box.map((v) => Math.round(v)), w.t, w.line, w.sp ?? 1] : [0, 0, 0, 0, w.t, -1, w.sp ?? 1]);
      }
      sent.push([a, words.length]);
      for (const [ca, cb] of clauseRanges(s.map((w) => w.t))) clause.push([a + ca, a + cb]);
    }
    if (sent.length > first) blocks.push([first, sent.length]);
  }
  return { words, sent, clause, blocks };
}

export const sentenceText = (words) =>
  words.map((w, k) => w.t + (w.sp || k === words.length - 1 ? ' ' : '')).join('').trim();

const tokensOf = (text) => text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Give corrected words the page boxes of the old words. Unchanged words keep their own box
 * (matched with a longest-common-subsequence alignment); changed, joined or split words share
 * the boxes of the old words they replace, in proportion to their length.
 */
export function alignWords(old, tokens) {
  const n = old.length, m = tokens.length;
  const A = old.map((w) => norm(w.t)), B = tokens.map(norm);
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = A[i] && A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0, gi = 0, gj = 0;
  const gap = (i1, j1) => out.push(...fillGap(old.slice(gi, i1), tokens.slice(gj, j1)));
  while (i < n && j < m) {
    if (A[i] && A[i] === B[j]) {
      gap(i, j);
      out.push({ ...old[i], t: tokens[j], box: old[i].box && [...old[i].box] });
      gi = ++i;
      gj = ++j;
    } else if (L[i + 1][j] >= L[i][j + 1]) i++;
    else j++;
  }
  gap(n, m);
  return out;
}

function fillGap(oldSeg, toks) {
  if (!toks.length) return [];
  const boxed = oldSeg.filter((w) => w.box);
  if (!boxed.length) return toks.map((t) => ({ t, box: null, line: -1, sp: 1 }));
  if (boxed.length === toks.length) return toks.map((t, k) => ({ t, box: [...boxed[k].box], line: boxed[k].line, sp: 1 }));
  // Spread the new words over the old boxes by character position.
  const oLen = boxed.map((w) => Math.max(1, w.t.length));
  const oStart = [];
  let O = 0;
  for (const l of oLen) { oStart.push(O); O += l; }
  const nLen = toks.map((t) => Math.max(1, t.length));
  const N = nLen.reduce((a, b) => a + b, 0);
  let pos = 0;
  return toks.map((t, k) => {
    const s = (pos / N) * O, e = ((pos + nLen[k]) / N) * O;
    pos += nLen[k];
    let mid = 0;
    oStart.forEach((st, q) => { if (st <= (s + e) / 2) mid = q; });
    const line = boxed[mid].line;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    boxed.forEach((w, q) => {
      if (w.line !== line) return;
      const a = Math.max(s, oStart[q]), b = Math.min(e, oStart[q] + oLen[q]);
      if (b <= a) return;
      const [x, y, bw, bh] = w.box;
      x0 = Math.min(x0, x + (bw * (a - oStart[q])) / oLen[q]);
      x1 = Math.max(x1, x + (bw * (b - oStart[q])) / oLen[q]);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y + bh);
    });
    const box = x1 > x0 ? [x0, y0, x1 - x0, y1 - y0] : [...boxed[mid].box];
    return { t, box, line, sp: 1 };
  });
}

/** Lay the words of a sentence out inside a box drawn on the page (one or more lines). */
function layoutInBox(words, rect, lineH, firstLine) {
  const rows = Math.max(1, Math.min(words.length, Math.round(rect.h / (lineH * 1.3))));
  const lens = words.map((w) => w.t.length + 1);
  const perRow = lens.reduce((a, b) => a + b, 0) / rows;
  let acc = 0;
  const rowOf = lens.map((l) => {
    const r = Math.min(rows - 1, Math.floor((acc + l / 2) / perRow));
    acc += l;
    return r;
  });
  const rowH = rect.h / rows;
  const out = words.map((w) => ({ ...w }));
  for (let r = 0; r < rows; r++) {
    const idx = out.map((_, k) => k).filter((k) => rowOf[k] === r);
    const chars = idx.reduce((a, k) => a + lens[k], 0) || 1;
    let x = rect.x;
    for (const k of idx) {
      const w = (rect.w * lens[k]) / chars;
      out[k].box = [x, rect.y + r * rowH + rowH * 0.1, Math.max(4, w - 6), rowH * 0.8];
      out[k].line = firstLine + r;
      x += w;
    }
  }
  return out;
}

function lineHeight(doc) {
  const hs = (doc?.words || []).filter((w) => w[3] > 0).map((w) => w[3]).sort((a, b) => a - b);
  return hs.length ? hs[Math.floor(hs.length / 2)] : 32;
}

function removeSentence(model, bi, si) {
  model[bi].splice(si, 1);
  if (!model[bi].length) model.splice(bi, 1);
}

/** Corrections. Each changes the model in place and returns the sentence to select ({bi, si} or null). */
export const OPS = {
  text(model, bi, si, text) {
    const toks = tokensOf(text);
    if (!toks.length) return OPS.delete(model, bi, si);
    model[bi][si] = alignWords(model[bi][si], toks);
    return { bi, si };
  },
  delete(model, bi, si) {
    const blockGone = model[bi].length === 1;
    removeSentence(model, bi, si);
    if (!model.length) return null;
    if (!blockGone) return { bi, si: Math.min(si, model[bi].length - 1) };
    return bi < model.length ? { bi, si: 0 } : { bi: bi - 1, si: model[bi - 1].length - 1 };
  },
  split(model, bi, si, k) {
    const s = model[bi][si];
    if (!(k > 0 && k < s.length)) return { bi, si };
    model[bi].splice(si, 1, s.slice(0, k), s.slice(k));
    return { bi, si: si + 1 };
  },
  mergeNext(model, bi, si) {
    const block = model[bi];
    if (si < block.length - 1) {
      block[si] = block[si].concat(block[si + 1]);
      block.splice(si + 1, 1);
    } else if (bi < model.length - 1) {
      // The sentence goes on in the next paragraph: join the two paragraphs.
      const next = model[bi + 1];
      block[si] = block[si].concat(next[0]);
      block.push(...next.slice(1));
      model.splice(bi + 1, 1);
    }
    return { bi, si };
  },
  mergePrev(model, bi, si) {
    if (si > 0) return OPS.mergeNext(model, bi, si - 1);
    if (bi > 0) return OPS.mergeNext(model, bi - 1, model[bi - 1].length - 1);
    return { bi, si };
  },
  // Move = swap places with the sentence before/after it in reading order, also across
  // paragraphs (the paragraphs keep their places; the two sentences change places).
  up(model, bi, si) {
    if (si > 0) {
      const block = model[bi];
      [block[si - 1], block[si]] = [block[si], block[si - 1]];
      return { bi, si: si - 1 };
    }
    if (bi === 0) return { bi, si };
    const prev = model[bi - 1], last = prev.length - 1;
    [prev[last], model[bi][0]] = [model[bi][0], prev[last]];
    return { bi: bi - 1, si: last };
  },
  down(model, bi, si) {
    const block = model[bi];
    if (si < block.length - 1) {
      [block[si], block[si + 1]] = [block[si + 1], block[si]];
      return { bi, si: si + 1 };
    }
    if (bi === model.length - 1) return { bi, si };
    [block[si], model[bi + 1][0]] = [model[bi + 1][0], block[si]];
    return { bi: bi + 1, si: 0 };
  },
  // Drag and drop: put sentence (bi, si) before sentence `si` of paragraph `bi` of the target
  // (si = paragraph length means at its end).
  moveTo(model, bi, si, { bi: tb, si: ts }) {
    if (tb === bi && (ts === si || ts === si + 1)) return { bi, si }; // dropped where it already is
    const [s] = model[bi].splice(si, 1);
    if (tb === bi && ts > si) ts--;
    if (!model[bi].length) {
      model.splice(bi, 1);
      if (tb > bi) tb--;
    }
    model[tb].splice(ts, 0, s);
    return { bi: tb, si: ts };
  },
  paragraph(model, bi, si) {
    if (si > 0) { // start a new paragraph with this sentence
      model.splice(bi + 1, 0, model[bi].splice(si));
      return { bi: bi + 1, si: 0 };
    }
    if (bi > 0) { // join this paragraph to the previous one
      const n = model[bi - 1].length;
      model[bi - 1].push(...model[bi]);
      model.splice(bi, 1);
      return { bi: bi - 1, si: n };
    }
    return { bi, si };
  },
  add(model, bi, si, text) { // after sentence (bi, si); bi = -1 adds at the end of the page
    const words = tokensOf(text).map((t) => ({ t, box: null, line: -1, sp: 1 }));
    if (!words.length) return bi < 0 ? null : { bi, si };
    if (!model.length) { model.push([words]); return { bi: 0, si: 0 }; }
    if (bi < 0) {
      const last = model.length - 1;
      model[last].push(words);
      return { bi: last, si: model[last].length - 1 };
    }
    model[bi].splice(si + 1, 0, words);
    return { bi, si: si + 1 };
  },
  mark(model, bi, si, { rect, lineH }) {
    const maxLine = Math.max(0, ...model.flat(2).map((w) => w.line));
    model[bi][si] = layoutInBox(model[bi][si], rect, lineH, maxLine + 1);
    return { bi, si };
  },
};

const docJSON = (doc) => JSON.stringify({ words: doc.words, sent: doc.sent, clause: doc.clause, blocks: doc.blocks });

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight + 2}px`;
}

// ---------------------------------------------------------------- The editor panel

export class TextEditor {
  constructor(app) {
    this.app = app;
    this.active = false;
    this.sel = null;        // {view, bi, si}
    this.splitting = false;
    this.editingText = false; // the selected sentence shows its text box
    this.adding = null;     // {view, bi, si}: add after this sentence (bi = -1: at the end)
    this.marking = null;    // selection being marked on the page
    this.history = new Map(); // page -> earlier versions (JSON), for Undo
    this.timers = new Map();  // view -> pending save
    this.saving = new Set();  // views with a save in progress
    this.saveAgain = new Set(); // views changed again while saving
    this.status = '';
    this.box = $('#text-view');
    this.bind();
  }

  key(view) { return `${view.book.slug}/${view.page.path}`; }

  bind() {
    $('#edit-text').addEventListener('click', () => this.start());
    $('#edit-done').addEventListener('click', () => this.stop());
    $('#edit-undo').addEventListener('click', () => this.undo());
    $('#edit-reset').addEventListener('click', () => this.reset());
    // The tools for the selected sentence, at the top of the panel.
    $('#edit-tools').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-op]');
      if (b && !b.disabled) this.tool(b.dataset.op, b);
    });
    this.box.addEventListener('click', (e) => this.onClick(e));
    // A double click changes the text: no word selection.
    this.box.addEventListener('mousedown', (e) => {
      if (this.active && e.detail > 1 && e.target.closest('.esent') && !e.target.closest('textarea')) e.preventDefault();
    });
    this.box.addEventListener('keydown', (e) => this.onKey(e));
    this.box.addEventListener('input', (e) => { if (e.target.matches('textarea')) autosize(e.target); });
    // Safety net: save typed text when focus leaves for somewhere else.
    this.box.addEventListener('focusout', (e) => {
      if (this.active && e.target.matches('.esent textarea')) setTimeout(() => this.commitText(), 250);
      if (this.inline?.ta === e.target) setTimeout(() => { if (this.inline?.ta === e.target && document.activeElement !== e.target) this.saveInline(); }, 250);
    });
    addEventListener('beforeunload', () => { this.commitText(); this.flush(true); });
    this.bindDrag();
  }

  // ---------- Mode ----------

  /** Books of others (shared with everyone) can be read, not corrected. */
  allowed() {
    if (this.app.book?.canEdit !== false) return true;
    toast('Only the owner of this book can correct its text.');
    return false;
  }

  start() {
    if (this.active || !this.allowed()) return;
    this.saveInline();
    // Start on the sentence being read or last used (or the one in the middle of the list).
    const focus = this.app.currentFocus();
    this.app.reader.stop();
    this.app.recordings.stopPicking();
    this.active = true;
    document.body.classList.add('editing');
    $('#read-actions').hidden = true;
    $('#edit-actions').hidden = false;
    this.app.showTab('text');
    this.app.setPanelOpen(true);
    this.app.applyMode();
    this.editingText = false;
    this.sel = focus ? this.selAt(focus.view, focus.w) : null;
    this.render();
    this.showSelection(false, false);
  }

  stop() {
    if (!this.active) return;
    this.commitText();
    // Go back to reading on the same sentence.
    const keep = this.sel ? { view: this.sel.view, unit: this.unitOf(this.sel) } : null;
    this.cancelMarking();
    this.flush();
    this.active = false;
    this.sel = null;
    this.splitting = false;
    this.editingText = false;
    this.adding = null;
    document.body.classList.remove('editing');
    this.box.classList.remove('editing');
    $('#read-actions').hidden = false;
    $('#edit-actions').hidden = true;
    this.app.views.forEach((v) => v.showActive(null));
    this.app.applyMode();
    this.app.renderPanelText();
    if (keep && this.app.views.includes(keep.view)) this.app.setFocus(keep.view, keep.unit, false);
  }

  /** The pages on screen changed (called after their text has loaded). */
  pagesChanged() {
    this.inline = null;
    this.sel = null;
    this.splitting = false;
    this.editingText = false;
    this.adding = null;
    this.marking = null;
    document.body.classList.remove('marking');
    if (this.active) this.render();
  }

  /** Esc: cancel what is in progress. Returns true if something was cancelled. */
  escape() {
    if (this.drag) { this.cancelDrag(); return true; }
    if (this.inline) { this.cancelInline(); return true; }
    if (this.marking) { this.cancelMarking(); this.render(); return true; }
    if (this.splitting || this.adding || this.editingText) {
      this.splitting = false;
      this.adding = null;
      this.editingText = false;
      this.render();
      return true;
    }
    return false;
  }

  // ---------- Selection ----------

  flatIndex(sel) { return sel.view.doc.blocks[sel.bi][0] + sel.si; }

  unitOf(sel) { return sel.view.text.sentenceUnit(this.flatIndex(sel)); }

  currentText(sel) {
    const [a, b] = sel.view.doc.sent[this.flatIndex(sel)];
    return sel.view.text.text(a, b);
  }

  /** The sentence ({view, bi, si}) that contains word w, or null. */
  selAt(view, w) {
    const s = view?.text?.w2s[w] ?? -1;
    if (s < 0) return null;
    const bi = view.doc.blocks.findIndex(([a, b]) => s >= a && s < b);
    return bi < 0 ? null : { view, bi, si: s - view.doc.blocks[bi][0] };
  }

  /** Select the sentence that contains word w (a click on the page). */
  selectAtWord(view, w) {
    const sel = this.selAt(view, w);
    if (sel) this.select(sel.view, sel.bi, sel.si, true);
  }

  select(view, bi, si, fromPage = false) {
    this.commitText();
    this.cancelMarking();
    this.splitting = false;
    this.editingText = false;
    this.adding = null;
    this.sel = { view, bi, si };
    this.render();
    this.showSelection(!fromPage);
  }

  /** Select the next (dir 1) or previous (dir -1) sentence, across paragraphs and pages. */
  step(dir) {
    const all = [];
    for (const view of this.app.views) {
      (view.doc?.blocks || []).forEach(([sa, sb], bi) => { for (let si = 0; si < sb - sa; si++) all.push({ view, bi, si }); });
    }
    if (!all.length) return;
    const cur = this.sel ? all.findIndex((x) => x.view === this.sel.view && x.bi === this.sel.bi && x.si === this.sel.si) : -1;
    const next = all[Math.max(0, Math.min(all.length - 1, cur < 0 ? 0 : cur + dir))];
    this.select(next.view, next.bi, next.si);
  }

  showSelection(scrollPage, smooth = true) {
    this.app.views.forEach((v) => v.showActive(null));
    if (!this.sel) return;
    const unit = this.unitOf(this.sel);
    this.sel.view.showActive(unit);
    const row = this.box.querySelector('.esent.sel');
    if (row) this.app.centerInPanel(row, row, smooth);
    if (scrollPage) this.app.reveal(this.sel.view, unit);
  }

  // ---------- Drag and drop (move a sentence by its handle) ----------

  // Pointer events (not the browser's HTML drag and drop, which can end without a drop):
  // works the same with a mouse, a pen or a finger, and the app controls every step.
  bindDrag() {
    let press = null; // {handle, row, x, y, id}: the handle is pressed, the drag starts after 5 px
    this.box.addEventListener('pointerdown', (e) => {
      // In correction mode the number of a sentence is its handle; in the Text list, the dots on its left.
      const handle = e.button === 0 && !this.inline && this.app.book?.canEdit !== false
        && e.target.closest(this.active ? '.esent .handle' : '.sline .grip');
      if (!handle) return;
      e.preventDefault(); // no text selection, and the sentence box keeps its focus
      press = { handle, row: handle.closest(this.active ? '.esent' : '.sline'), x: e.clientX, y: e.clientY, id: e.pointerId };
      handle.setPointerCapture(e.pointerId);
    });
    this.box.addEventListener('pointermove', (e) => {
      if (!press || e.pointerId !== press.id) return;
      if (!this.drag) {
        if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < 5) return;
        this.beginDrag(press.row);
      }
      this.dragMove(e.clientX, e.clientY);
    });
    const finish = (e, cancel) => {
      if (!press || (e && e.pointerId !== press.id)) return;
      press = null;
      if (this.drag) this.finishDrag(cancel);
    };
    this.box.addEventListener('pointerup', (e) => finish(e, false));
    this.box.addEventListener('pointercancel', (e) => finish(e, true));
    this.cancelDrag = () => finish(null, true);
  }

  beginDrag(row) {
    this.drag = { view: this.app.views[Number(row.dataset.v)], bi: Number(row.dataset.b), si: Number(row.dataset.s), row };
    row.classList.add('dragging');
    document.body.classList.add('dragging-sentence');
    const text = row.querySelector('textarea')?.value ?? row.querySelector('.etext')?.firstChild?.textContent
      ?? [...row.querySelectorAll('.w')].map((w) => w.textContent).join('').trim();
    this.ghost = el('div', { class: 'drag-ghost' }, text);
    document.body.append(this.ghost);
    // Keep scrolling while the pointer rests near the top or bottom of the list.
    this.scrollTimer = setInterval(() => {
      if (this.drag && this.autoScroll(this.lastY)) this.dragMove(this.lastX, this.lastY);
    }, 30);
  }

  dragMove(x, y) {
    this.lastX = x;
    this.lastY = y;
    this.ghost.style.transform = `translate(${x + 16}px, ${y - 14}px)`;
    this.dropAt = this.dropTarget(y);
    this.showDropLine(this.dropAt?.y ?? null);
  }

  finishDrag(cancel) {
    const from = this.drag, to = this.dropAt;
    this.endDrag();
    // The click that follows the drop must not select another sentence.
    this.justDragged = true;
    setTimeout(() => { this.justDragged = false; }, 0);
    if (cancel || !from || !to) return;
    this.commitText();
    this.run('moveTo', { bi: to.bi, si: to.si }, from);
  }

  /**
   * Where a dragged sentence would go for a pointer at clientY: before the row whose middle is
   * below the pointer. Between two paragraphs, the upper half of the gap means "end of the
   * paragraph above", the lower half "start of the paragraph below".
   */
  dropTarget(y) {
    const vi = this.app.views.indexOf(this.drag.view);
    const rows = [...this.box.querySelectorAll(`${this.active ? '.esent' : '.sline'}[data-v="${vi}"]`)];
    if (!rows.length) return null;
    const r = (row) => row.getBoundingClientRect();
    let k = rows.findIndex((row) => y < r(row).top + r(row).height / 2);
    if (k < 0) k = rows.length;
    const prev = rows[k - 1], next = rows[k];
    const after = (row) => ({ bi: Number(row.dataset.b), si: Number(row.dataset.s) + 1, y: r(row).bottom + 2 });
    const before = (row) => ({ bi: Number(row.dataset.b), si: Number(row.dataset.s), y: r(row).top - 2 });
    if (prev && next && prev.dataset.b !== next.dataset.b) {
      return y < (r(prev).bottom + r(next).top) / 2 ? after(prev) : before(next);
    }
    return next ? before(next) : after(prev);
  }

  showDropLine(y) {
    if (y == null) { this.dropLine?.remove(); return; }
    if (!this.dropLine) this.dropLine = el('div', { class: 'drop-line' });
    if (!this.dropLine.isConnected) this.box.append(this.dropLine);
    this.dropLine.style.top = `${y - this.box.getBoundingClientRect().top}px`;
  }

  /** Scroll the list while dragging near its top or bottom edge. Returns true if it scrolled. */
  autoScroll(y) {
    if (y == null) return false;
    const sc = this.box.closest('.tab-body');
    const b = sc.getBoundingClientRect();
    const bar = [...sc.querySelectorAll('.panel-actions')].find((x) => !x.hidden);
    const top = b.top + (bar ? bar.offsetHeight : 0);
    const before = sc.scrollTop;
    if (y < top + 50) sc.scrollTop -= Math.ceil((top + 50 - y) / 4);
    else if (y > b.bottom - 50) sc.scrollTop += Math.ceil((y - (b.bottom - 50)) / 4);
    return sc.scrollTop !== before;
  }

  endDrag() {
    clearInterval(this.scrollTimer);
    this.drag?.row.classList.remove('dragging');
    document.body.classList.remove('dragging-sentence');
    this.ghost?.remove();
    this.ghost = null;
    this.showDropLine(null);
    this.drag = null;
    this.dropAt = null;
  }

  // ---------- Quick correction in the Text list (double click; no correction mode) ----------

  editInline(view, bi, si) {
    if (this.active || !view?.doc || !this.allowed()) return;
    this.saveInline();
    const vi = this.app.views.indexOf(view);
    const line = this.box.querySelector(`.sline[data-v="${vi}"][data-b="${bi}"][data-s="${si}"]`);
    if (!line) return;
    this.app.reader.stop();
    const sel = { view, bi, si };
    const ta = el('textarea', { rows: '2', 'aria-label': 'Sentence text', spellcheck: 'true' });
    ta.value = this.currentText(sel);
    const qb = (q, label, cls = '') => el('button', { class: `tbtn ${cls}`, dataset: { q } }, label);
    const more = el('button', { class: 'tbtn', dataset: { q: 'more' }, title: 'Split, merge, delete, add, mark on the page… (E)', html: `${icon('pencil')}<span>More tools</span>` });
    line.append(el('div', { class: 'qedit' }, ta,
      el('div', { class: 'etools' }, qb('save', 'Save', 'primary'), qb('cancel', 'Cancel'), more,
        el('span', { class: 'ehint qhint' }, 'Enter saves · Esc cancels'))));
    line.classList.add('editing-line');
    this.inline = { ...sel, line, ta };
    autosize(ta);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    // The sentence stays highlighted on the page and in the middle of the list.
    const unit = this.unitOf(sel);
    this.app.focus = { view, w: unit.a };
    view.showActive(unit);
    this.app.reveal(view, unit);
    this.app.centerInPanel(line, line);
  }

  /** Apply what was typed (if it changed) and close the box. */
  saveInline() {
    const q = this.inline;
    if (!q) return;
    this.inline = null;
    if (tokensOf(q.ta.value).join(' ') === tokensOf(this.currentText(q)).join(' ')) { this.closeInline(q); return; }
    const deleting = !tokensOf(q.ta.value).length;
    this.run('text', q.ta.value, q);
    toast(deleting ? 'Sentence deleted. Ctrl+Z brings it back.' : 'Saved. Ctrl+Z undoes it.');
  }

  cancelInline() {
    const q = this.inline;
    this.inline = null;
    if (q) this.closeInline(q);
  }

  closeInline(q) {
    q.line.querySelector('.qedit')?.remove();
    q.line.classList.remove('editing-line');
  }

  inlineTool(op) {
    const q = this.inline;
    if (op === 'save') this.saveInline();
    else if (op === 'cancel') this.cancelInline();
    else if (op === 'more' && q) { // the full correction tools, on this sentence
      this.saveInline();
      const block = q.view.doc.blocks[q.bi];
      if (block && q.si < block[1] - block[0]) this.app.focus = { view: q.view, w: q.view.doc.sent[block[0] + q.si][0] };
      this.start();
    }
  }

  // ---------- Making a correction ----------

  run(op, arg, sel = this.sel) {
    if (!sel) return;
    const { view } = sel;
    const before = docJSON(view.doc);
    const model = toModel(view.doc);
    const next = OPS[op](model, sel.bi, sel.si, arg);
    const doc = toDoc(model);
    if (docJSON(doc) === before) { this.render(); return; }
    // Remember the selection too, so Undo returns to the sentence that was being changed.
    const selBefore = !this.active ? { bi: sel.bi, si: sel.si } : this.sel?.view === view ? { bi: this.sel.bi, si: this.sel.si } : null;
    this.pushUndo(view, { doc: before, sel: selBefore });
    view.applyDoc(doc, true);
    this.splitting = false;
    this.editingText = false;
    this.adding = null;
    this.scheduleSave(view);
    const moved = next ? { view, ...next } : null;
    if (!this.active) { // a correction made in the Text list (drag, double click)
      this.app.textChanged(view, moved && this.unitOf(moved));
      return;
    }
    this.sel = moved;
    this.render();
    this.showSelection(true);
  }

  /** Apply text typed in the selected sentence's box, if it changed. */
  commitText() {
    const ta = this.box.querySelector('.esent.sel textarea');
    if (!this.active || !ta || !this.sel || !this.sel.view.doc) return;
    if (tokensOf(ta.value).join(' ') !== tokensOf(this.currentText(this.sel)).join(' ')) this.run('text', ta.value);
  }

  tool(op, btn) {
    if (op === 'add-end') {
      this.commitText();
      this.adding = { view: this.app.views[Number(btn.dataset.v)], bi: -1, si: -1 };
      this.render();
      return;
    }
    if (op === 'add-save') { this.saveAdd(); return; }
    if (op === 'add-cancel' || op === 'split-cancel') { this.escape(); return; }
    if (op === 'split-at') { this.run('split', Number(btn.dataset.k)); return; }
    this.commitText();
    if (!this.sel) return;
    if (op === 'edit') { this.splitting = false; this.adding = null; this.editingText = true; this.render(); return; }
    this.editingText = false;
    if (op === 'split') { this.splitting = !this.splitting; this.adding = null; this.render(); return; }
    if (op === 'add') { this.splitting = false; this.adding = { ...this.sel }; this.render(); return; }
    if (op === 'mark') {
      if (this.marking) { this.cancelMarking(); this.render(); } else this.startMarking();
      return;
    }
    this.run(op);
    if (op === 'delete') toast('Sentence deleted. Ctrl+Z (or Undo) brings it back.');
  }

  saveAdd() {
    const text = this.box.querySelector('.eadd textarea')?.value || '';
    const where = this.adding;
    this.adding = null;
    if (!where || !text.trim()) { this.render(); return; }
    this.run('add', text, where);
    toast('Sentence added. Use “Mark on page” to show where it is on the page.');
  }

  startMarking() {
    const sel = this.sel;
    this.cancelMarking();
    this.marking = sel;
    document.body.classList.add('marking');
    this.render();
    sel.view.startMarking((rect) => {
      this.marking = null;
      document.body.classList.remove('marking');
      if (rect) this.run('mark', { rect, lineH: lineHeight(sel.view.doc) }, sel);
      else this.render();
    });
  }

  cancelMarking() {
    if (!this.marking) return;
    this.marking.view.stopMarking();
    this.marking = null;
    document.body.classList.remove('marking');
  }

  // ---------- Undo, save, restore ----------

  pushUndo(view, entry) {
    const h = this.history.get(this.key(view)) || [];
    h.push(entry);
    if (h.length > MAX_UNDO) h.shift();
    this.history.set(this.key(view), h);
    this.lastView = view;
  }

  undo() {
    if (this.inline) return;
    this.cancelMarking();
    const has = (v) => v && this.history.get(this.key(v))?.length;
    const view = [this.sel?.view, this.lastView, ...this.app.views].find((v) => this.app.views.includes(v) && has(v));
    if (!view) { toast('Nothing to undo on this page.'); return; }
    const entry = this.history.get(this.key(view)).pop();
    view.applyDoc(JSON.parse(entry.doc), true);
    const s = entry.sel;
    const block = s && view.doc.blocks[s.bi];
    const back = block && s.si < block[1] - block[0] ? { view, ...s } : null;
    this.splitting = false;
    this.adding = null;
    this.scheduleSave(view);
    if (!this.active) {
      this.app.textChanged(view, back && this.unitOf(back));
      toast('Undone.');
      return;
    }
    this.sel = back;
    this.render();
    this.showSelection(false);
  }

  scheduleSave(view) {
    clearTimeout(this.timers.get(view));
    this.timers.set(view, setTimeout(() => this.save(view), 400));
    this.setStatus('saving');
  }

  /** Save every page that has unsaved corrections now (closing = the browser tab is closing). */
  flush(closing = false) {
    for (const [view, t] of this.timers) { clearTimeout(t); this.save(view, closing); }
  }

  /** Save one page. Saves of the same page run one at a time, so the newest version always wins. */
  async save(view, closing = false) {
    this.timers.delete(view);
    if (this.saving.has(view)) { this.saveAgain.add(view); return; }
    this.saving.add(view);
    let ok = false;
    try {
      const body = JSON.stringify(view.doc);
      // keepalive lets the last save finish while the tab closes (browsers allow it for small bodies only).
      const r = await fetch(view.textUrl, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, keepalive: closing && body.length < 60000,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`);
      ok = true;
      view.edited = true;
      forgetJSON(`/api/search/${view.book.slug}`);
    } catch (err) {
      console.warn('Saving the corrections failed:', err);
      this.setStatus('error');
    } finally {
      this.saving.delete(view);
      if (this.saveAgain.delete(view)) this.save(view);
      else if (ok && !this.timers.size && !this.saving.size) this.setStatus('saved');
    }
  }

  async reset() {
    const changed = (v) => v.edited || this.timers.has(v) || this.saving.has(v);
    const view = this.sel?.view || this.app.views.find(changed) || this.app.views[0];
    if (!view || !changed(view)) { toast('This page has no corrections.'); return; }
    if (!confirm(`Restore the original text of page ${view.page.n}?\n\nAll corrections on this page will be removed.`)) return;
    clearTimeout(this.timers.get(view));
    this.timers.delete(view);
    this.saveAgain.delete(view);
    while (this.saving.has(view)) await new Promise((r) => setTimeout(r, 50)); // let a running save finish first
    try {
      const r = await fetch(view.textUrl, { method: 'DELETE' });
      if (!r.ok) throw new Error();
    } catch { this.setStatus('error'); return; }
    await view.loadText();
    this.history.delete(this.key(view));
    forgetJSON(`/api/search/${view.book.slug}`);
    if (this.sel?.view === view) this.sel = null;
    this.render();
    this.showSelection(false);
    this.setStatus('restored');
  }

  setStatus(s) {
    this.status = s;
    this.updateStatus();
    if (s === 'error' && !this.active) toast('The correction was not saved: is the app window still open?');
  }

  updateStatus() {
    const el2 = $('#edit-status');
    const text = { saving: 'Saving…', saved: 'Saved', restored: 'Original text restored', error: 'Not saved: is the app window still open?' }[this.status] || '';
    el2.textContent = text;
    el2.classList.toggle('err', this.status === 'error');
    $('#edit-undo').disabled = !this.app.views.some((v) => this.history.get(this.key(v))?.length);
  }

  // ---------- Panel ----------

  onClick(e) {
    const q = this.inline && e.target.closest('button[data-q]');
    if (q) { this.inlineTool(q.dataset.q); return; }
    if (!this.active || this.justDragged) return;
    const btn = e.target.closest('button[data-op]');
    if (btn) { this.tool(btn.dataset.op, btn); return; }
    if (e.target.closest('textarea')) return;
    const row = e.target.closest('.esent');
    if (!row) return;
    if (!row.classList.contains('sel')) {
      this.select(this.app.views[Number(row.dataset.v)], Number(row.dataset.b), Number(row.dataset.s));
    }
    if (e.detail >= 2 && !this.splitting && !this.editingText) this.tool('edit'); // double click: change its text
  }

  onKey(e) {
    if (this.inline && e.target === this.inline.ta) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.saveInline(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.cancelInline(); }
      return;
    }
    if (!this.active) return;
    const ta = e.target.closest('textarea');
    if (!ta) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (ta.closest('.eadd')) { this.saveAdd(); return; }
      this.commitText(); // a change closes the box by itself
      if (this.editingText) { this.editingText = false; this.render(); }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (ta.closest('.eadd')) this.escape();
      else { this.editingText = false; this.render(); } // leave the text as it was
    }
  }

  render() {
    if (!this.active) return;
    const out = [el('p', { class: 'edit-hint' }, this.marking
      ? 'Drag a box on the page around the selected sentence. Esc cancels.'
      : 'Click a sentence (here or on the page), then use the buttons above. Double-click a sentence (or press Enter) to change its text; drag it by the dots on its left to move it. Changes are saved automatically.')];
    this.app.views.forEach((view, vi) => {
      const head = el('h4', { class: 'page-head' }, `Page ${view.page.n}`);
      if (view.edited) head.append(el('span', { class: 'badge-edited' }, 'corrected'));
      out.push(head);
      const model = toModel(view.doc);
      if (!model.length) out.push(el('div', { class: 'empty' }, 'There is no text on this page.'));
      let num = 0;
      model.forEach((block, bi) => {
        const b = el('div', { class: 'eblock' });
        block.forEach((words, si) => {
          num++;
          const isSel = this.sel?.view === view && this.sel.bi === bi && this.sel.si === si;
          b.append(this.renderSentence({ vi, bi, si, words, num, isSel }));
          if (this.adding?.view === view && this.adding.bi === bi && this.adding.si === si) b.append(this.renderAdd());
        });
        out.push(b);
      });
      out.push(this.adding?.view === view && this.adding.bi === -1 ? this.renderAdd()
        : el('button', { class: 'link-btn add-end', dataset: { op: 'add-end', v: vi } }, '+ Add a sentence at the end of this page'));
    });
    this.box.classList.add('editing');
    this.box.replaceChildren(...out);
    this.box.querySelectorAll('textarea').forEach(autosize);
    const ta = this.box.querySelector('.eadd textarea') || (this.editingText && this.box.querySelector('.esent.sel textarea'));
    if (ta) {
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
    this.updateStatus();
    this.updateTools();
  }

  /** The buttons at the top: only those that make sense for the selected sentence can be used. */
  updateTools() {
    const s = this.sel?.view.doc ? this.sel : null;
    const blocks = s ? s.view.doc.blocks : [];
    const first = !s || (s.bi === 0 && s.si === 0);
    const last = !s || (s.bi === blocks.length - 1 && s.si === blocks[s.bi][1] - blocks[s.bi][0] - 1);
    const [a, b] = s ? s.view.doc.sent[this.flatIndex(s)] : [0, 0];
    const off = { edit: !s, split: b - a < 2, mergePrev: first, mergeNext: last, up: first, down: last, paragraph: first, mark: !s, add: !s, delete: !s };
    for (const btn of $$('#edit-tools [data-op]')) btn.disabled = !!off[btn.dataset.op];
    const press = { edit: this.editingText, split: this.splitting, mark: !!this.marking, add: !!this.adding && this.adding.bi >= 0 };
    for (const [op, on] of Object.entries(press)) $(`#edit-tools [data-op="${op}"]`).setAttribute('aria-pressed', String(!!on));
    const para = $('#edit-tools [data-op="paragraph"]'), join = s && s.si === 0;
    para.title = join ? 'Join this paragraph to the one above' : 'New paragraph from this sentence';
    para.setAttribute('aria-label', join ? 'Join paragraph' : 'New paragraph');
    $('#edit-sel').textContent = s ? `${this.app.views.length > 1 ? `p.${s.view.page.n} · ` : ''}sentence ${this.flatIndex(s) + 1}` : 'click a sentence';
  }

  renderSentence({ vi, bi, si, words, num, isSel }) {
    const placed = words.some((w) => w.box);
    const row = el('div', { class: `esent${isSel ? ' sel' : ''}`, dataset: { v: vi, b: bi, s: si } },
      el('span', { class: 'enum handle', title: 'Drag to move this sentence', html: `<span class="num">${num}</span>${icon('grip')}` }));
    // Every sentence is shown as it is; the selected one turns into a box only to split it or change its text.
    if (!isSel || (!this.splitting && !this.editingText)) {
      row.append(el('span', { class: 'etext' }, sentenceText(words),
        placed ? null : el('span', { class: 'nobox', title: 'Not marked on the page yet' }, 'not on page')));
      return row;
    }
    const body = el('div', { class: 'ebody' });
    if (this.splitting) {
      body.append(
        el('div', { class: 'ehint' }, 'Click the word that should start the new sentence:'),
        el('div', { class: 'chips' }, ...words.map((w, k) => el('button', { class: 'chip', disabled: k === 0, dataset: { op: 'split-at', k } }, w.t))),
        el('div', { class: 'etools' }, el('button', { class: 'tbtn', dataset: { op: 'split-cancel' } }, 'Cancel')));
    } else {
      const ta = el('textarea', { rows: '2', 'aria-label': 'Sentence text', spellcheck: 'true' });
      ta.value = sentenceText(words);
      body.append(ta, el('div', { class: 'ehint' }, `Enter saves · Esc cancels${placed ? '' : ' · This sentence is not marked on the page yet.'}`));
    }
    row.append(body);
    return row;
  }

  renderAdd() {
    return el('div', { class: 'eadd' },
      el('textarea', { rows: '2', placeholder: 'Type the new sentence, then press Enter', 'aria-label': 'New sentence' }),
      el('div', { class: 'etools' },
        el('button', { class: 'tbtn primary', dataset: { op: 'add-save' } }, 'Add'),
        el('button', { class: 'tbtn', dataset: { op: 'add-cancel' } }, 'Cancel')));
  }
}

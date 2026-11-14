// Text corrections: change, split, merge, move, add and delete sentences, start or join
// paragraphs, and mark where a sentence is on the page. Each page is saved on the local
// server (web/edits/), so corrections survive a rebuild of web/data.
import { $, $$, el, icon, toast, forgetJSON } from './util.js';
import { clauseRanges, tokenize } from './segment.js';
import { replacePicture } from './pictures.js';
import { PlayButtons } from './playbuttons.js';

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

// The words of typed text (Chinese: one per character, see tokenize()).
const tokensOf = (text) => tokenize(text).map((w) => w.t);
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
  const gap = (i1, j1) => out.push(...fillGap(old.slice(gi, i1), tokens.slice(gj, j1), old[gi - 1], old[i1]));
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

function fillGap(oldSeg, toks, prev, next) {
  if (!toks.length) return [];
  const boxed = oldSeg.filter((w) => w.box);
  if (!boxed.length) return placeBetween(toks, prev, next); // (typed where there was nothing)
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

/**
 * Words typed in where there were none on the page (between the words prev and next, either may
 * be missing): their boxes are guessed — in the room between the two words on their line, else
 * just before the next word, else just after the one before — so that they are highlighted when
 * read. Without a word with a box beside them they get none.
 */
function placeBetween(toks, prev, next) {
  const p = prev?.box, q = next?.box;
  const lens = toks.map((t) => Math.max(1, t.length)), chars = lens.reduce((a, b) => a + b, 0) + toks.length - 1;
  let x0, x1, ref, line;
  if (p && q && prev.line === next.line && q[0] - (p[0] + p[2]) > 12) {
    [x0, x1, ref, line] = [p[0] + p[2] + 6, q[0] - 6, q, next.line];
  } else if (q) {
    const cw = q[2] / Math.max(1, next.t.length);
    [x1, ref, line] = [q[0] - cw, q, next.line];
    x0 = Math.max(0, x1 - chars * cw);
  } else if (p) {
    const cw = p[2] / Math.max(1, prev.t.length);
    [x0, ref, line] = [p[0] + p[2] + cw, p, prev.line];
    x1 = x0 + chars * cw;
  } else return toks.map((t) => ({ t, box: null, line: -1, sp: 1 }));
  const unit = (x1 - x0) / chars;
  let x = x0;
  return toks.map((t, k) => {
    const box = [x, ref[1], Math.max(4, lens[k] * unit), ref[3]];
    x += (lens[k] + 1) * unit;
    return { t, box, line, sp: 1 };
  });
}

/** Words of a sentence without a box (typed in earlier): their boxes guessed beside the others. */
function placeMissing(words) {
  const out = [...words];
  for (let k = 0; k < out.length;) {
    if (out[k].box) { k++; continue; }
    let e = k;
    while (e < out.length && !out[e].box) e++;
    const placed = placeBetween(out.slice(k, e).map((w) => w.t), out[k - 1], out[e]);
    placed.forEach((w, q) => { out[k + q] = { ...out[k + q], box: w.box, line: w.line }; });
    k = e;
  }
  return out;
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

/** Sentences typed by hand for an area of the page: laid out in it one under the other (a paragraph). */
function layoutTyped(texts, rect, lineH) {
  const sents = texts.map((text) => tokenize(text).map(({ t, sp }) => ({ t, box: null, line: -1, sp })));
  const size = (words) => words.reduce((n, w) => n + w.t.length + 1, 0);
  const total = sents.reduce((n, words) => n + size(words), 0) || 1;
  let y = rect.y, line = 0;
  return sents.map((words) => {
    const part = { x: rect.x, y, w: rect.w, h: Math.max(lineH * 1.3, (rect.h * size(words)) / total) };
    y += part.h;
    const out = layoutInBox(words, part, lineH, line);
    line = Math.max(...out.map((w) => w.line)) + 1;
    return out;
  });
}

/**
 * Sentences in reading order: by line from the top (sentences starting less than half a line
 * apart are on one line), then from the left. Sentences not on the page keep their order, last.
 */
function readingOrder(sents, lineH) {
  const start = (s) => s.find((w) => w.box)?.box;
  const placed = sents.filter(start).sort((a, b) => start(a)[1] - start(b)[1]);
  const rows = [];
  for (const s of placed) {
    const row = rows[rows.length - 1];
    if (row && start(s)[1] - start(row[0])[1] < lineH / 2) row.push(s);
    else rows.push([s]);
  }
  return [...rows.flatMap((row) => row.sort((a, b) => start(a)[0] - start(b)[0])), ...sents.filter((s) => !start(s))];
}

function lineHeight(doc) {
  const hs = (doc?.words || []).filter((w) => w[3] > 0).map((w) => w[3]).sort((a, b) => a - b);
  return hs.length ? hs[Math.floor(hs.length / 2)] : 32;
}

function removeSentence(model, bi, si) {
  model[bi].splice(si, 1);
  if (!model[bi].length) model.splice(bi, 1);
}

function whereIs(model, s) {
  const bi = model.findIndex((block) => block.includes(s));
  return bi < 0 ? null : { bi, si: model[bi].indexOf(s) };
}

/**
 * A sentence (with its boxes) put among the others where it is on the page: after the sentence
 * that starts just before it in its column (the same width of the page), or before the one that
 * starts just after it when that one is much nearer (at the top of a column under a title); right
 * after or before the text it goes on from, or on to, on the same line. In that sentence's
 * paragraph, or in a paragraph of its own when there is space between them. Nothing in its
 * column: before the first paragraph that starts lower on the page.
 */
function placeOnPage(model, n, lineH) {
  const boxes = (s) => s.filter((w) => w.box).map((w) => w.box);
  const nb = boxes(n);
  if (!nb.length) { if (model.length) model[model.length - 1].push(n); else model.push([n]); return; }
  const left = Math.min(...nb.map((b) => b[0])), right = Math.max(...nb.map((b) => b[0] + b[2]));
  const top = Math.min(...nb.map((b) => b[1])), bottom = Math.max(...nb.map((b) => b[1] + b[3]));
  // a starts before b on the page: on a line above, or on the same line further left
  const sameLine = (a, b) => Math.abs(a[1] - b[1]) <= lineH / 2;
  const earlier = (a, b) => (sameLine(a, b) ? a[0] < b[0] : a[1] < b[1]);
  const [head, end] = [nb[0], nb[nb.length - 1]];
  let before = null, after = null, from = null, to = null;
  for (const s of model.flat()) {
    const sb = boxes(s);
    if (!sb.length) continue;
    // The text going on from it, or on to it, on the same line (a word's space or so between them).
    const [h, e] = [sb[0], sb[sb.length - 1]];
    if (sameLine(e, head) && e[0] < head[0] && head[0] - e[0] - e[2] < lineH && (!from || e[0] > from.x)) from = { s, x: e[0] };
    if (sameLine(h, end) && h[0] > end[0] && h[0] - end[0] - end[2] < lineH && (!to || h[0] < to.x)) to = { s, x: h[0] };
    if (Math.max(...sb.map((b) => b[0] + b[2])) <= left || Math.min(...sb.map((b) => b[0])) >= right) continue; // (another column)
    if (earlier(h, head)) { if (!before || earlier(before.start, h)) before = { s, start: h, gap: top - Math.max(...sb.map((b) => b[1] + b[3])) }; }
    else if (!after || earlier(h, after.start)) after = { s, start: h, gap: Math.min(...sb.map((b) => b[1])) - bottom };
  }
  if (from) before = { s: from.s, gap: -lineH };
  else if (to) [before, after] = [null, { s: to.s, gap: -lineH }];
  const apart = (gap) => gap > lineH * 0.6; // (a line's space or more between them)
  if (before && (!after || after.gap * 2 > before.gap)) { // (the one after: when it is much nearer)
    const { bi, si } = whereIs(model, before.s);
    if (si === model[bi].length - 1 && apart(before.gap)) model.splice(bi + 1, 0, [n]);
    else model[bi].splice(si + 1, 0, n);
  } else if (after) {
    const { bi, si } = whereIs(model, after.s);
    if (si === 0 && apart(after.gap)) model.splice(bi, 0, [n]);
    else model[bi].splice(si, 0, n);
  } else {
    const at = model.findIndex((block) => Math.min(...block.flatMap(boxes).map((b) => b[1])) > top);
    model.splice(at < 0 ? model.length : at, 0, [n]);
  }
}

/** Corrections. Each changes the model in place and returns the sentence to select ({bi, si} or null). */
export const OPS = {
  text(model, bi, si, text) {
    const toks = tokenize(text);
    if (!toks.length) return OPS.delete(model, bi, si);
    const old = model[bi][si];
    // Spaces as typed (none in Chinese); after the last word, as before (to the next sentence).
    model[bi][si] = alignWords(old, toks.map((w) => w.t))
      .map((w, k) => ({ ...w, sp: k === toks.length - 1 ? old[old.length - 1].sp ?? 1 : toks[k].sp }));
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
  /** The sentence cut before each of these words (their places in it): as many sentences, in its paragraph (the first new one selected). */
  splitAt(model, bi, si, starts) {
    const pieces = cutAt(model[bi][si], new Set(starts));
    if (pieces.length < 2) return { bi, si };
    model[bi].splice(si, 1, ...pieces);
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
  // Move the clicked sentence directly after the current end of the ordered sequence.
  moveAfter(model, bi, si, { bi: tb, si: ts }) {
    const moving = model[bi]?.[si], anchor = model[tb]?.[ts];
    if (!moving || !anchor || moving === anchor) return { bi, si };
    removeSentence(model, bi, si);
    const targetBlock = model.findIndex((block) => block.includes(anchor));
    if (targetBlock < 0) return null;
    const targetSentence = model[targetBlock].indexOf(anchor);
    model[targetBlock].splice(targetSentence + 1, 0, moving);
    return { bi: targetBlock, si: targetSentence + 1 };
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
    const words = tokenize(text).map(({ t, sp }) => ({ t, box: null, line: -1, sp }));
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
  ocr(model, bi, si, doc) {
    const added = toModel(doc).flat();
    if (!added.length) return bi < 0 ? null : { bi, si };
    let line = Math.max(-1, ...model.flat(2).map((w) => w.line)) + 1;
    const lines = new Map();
    for (const sentence of added) for (const word of sentence) if (word.line >= 0) {
      if (!lines.has(word.line)) lines.set(word.line, line++);
      word.line = lines.get(word.line);
    }
    if (!model.length) model.push(added);
    else if (bi < 0) model[model.length - 1].push(...added);
    else model[bi].splice(si + 1, 0, ...added);
    return bi < 0 ? { bi: model.length - 1, si: model[model.length - 1].length - added.length }
      : { bi, si: si + 1 };
  },
  // The chosen sentences ([{bi, si}], in any order) all at once.
  deleteMany(model, bi, si, list) {
    for (const p of inOrder(list).reverse()) removeSentence(model, p.bi, p.si);
    return null;
  },
  mergeMany(model, bi, si, list) { // into one sentence, in reading order, where the first one is
    const [first, ...rest] = inOrder(list);
    model[first.bi][first.si] = inOrder(list).flatMap((p) => model[p.bi][p.si]);
    for (const p of rest.reverse()) removeSentence(model, p.bi, p.si);
    return { bi: first.bi, si: first.si };
  },
  mergeOrdered(model, bi, si, list) { // keep the first picked sentence as the anchor; append later picks in click order
    const ordered = list.map((p) => ({ ...p, words: model[p.bi]?.[p.si] })).filter((p) => p.words);
    if (ordered.length < 2) return { bi, si };
    const merged = ordered.flatMap((p) => p.words);
    const anchor = ordered[0];
    model[anchor.bi][anchor.si] = merged;
    for (const p of inOrder(ordered.slice(1)).reverse()) removeSentence(model, p.bi, p.si);
    const targetBlock = model.findIndex((block) => block.includes(merged));
    return targetBlock < 0 ? null : { bi: targetBlock, si: model[targetBlock].indexOf(merged) };
  },
  moveMany(model, bi, si, list) { // after sentence (bi, si), in reading order
    const target = model[bi][si];
    const moving = inOrder(list).map((p) => model[p.bi][p.si]);
    for (const p of inOrder(list).reverse()) removeSentence(model, p.bi, p.si);
    const tb = model.findIndex((block) => block.includes(target));
    const ts = model[tb].indexOf(target);
    model[tb].splice(ts + 1, 0, ...moving);
    return { bi: tb, si: ts + 1 };
  },
  /**
   * Order the page by areas drawn on it, [rect] in the order wanted: the sentences in each area
   * (most of their words in it; the first area drawn wins) become one paragraph, in reading order
   * inside it. The areas' paragraphs, one after the other, go where the first of their sentences
   * was; the other sentences keep their places.
   */
  orderAreas(model, bi, si, { areas, lineH }) {
    const areaOf = areaMembers(model, areas);
    if (!areaOf.size) return null;
    const groups = areas.map((_, a) => readingOrder(model.flat().filter((s) => areaOf.get(s) === a), lineH)).filter((g) => g.length);
    const out = [];
    let at = -1;
    for (const block of model) {
      let rest = [];
      for (const s of block) {
        if (!areaOf.has(s)) rest.push(s);
        else if (at < 0) { // the first sentence of an area: the areas go here
          if (rest.length) out.push(rest);
          rest = [];
          at = out.length;
          out.push(...groups);
        }
      }
      if (rest.length) out.push(rest);
    }
    model.splice(0, model.length, ...out);
    return { bi: at, si: 0 };
  },
  // The selected sentence's place on the page, changed with the handles of its frame: its words
  // move and stretch from box `from` to box `to`.
  fit(model, bi, si, { from, to }) {
    const kx = to.w / Math.max(1, from.w), ky = to.h / Math.max(1, from.h);
    model[bi][si] = placeMissing(model[bi][si].map((w) => (w.box ? { // (words typed in without a box: given one too)
      ...w, box: [to.x + (w.box[0] - from.x) * kx, to.y + (w.box[1] - from.y) * ky, Math.max(1, w.box[2] * kx), Math.max(1, w.box[3] * ky)],
    } : w)));
    return { bi, si };
  },
  /**
   * Text read again from an area of the page (blocks of sentences, with their boxes). Replacing
   * (keep false): the words inside the area (what was read wrongly) go, and the new sentences take
   * their place in the order of the page. Adding (keep), or nothing there before (what was
   * missed): each new sentence goes where it is on the page, after the sentence just before it in
   * its column or before the one just after it. Either way the sentences are numbered one after
   * the other, the new ones among the rest. Several paragraphs read (the rows of a list of new
   * words): paragraphs of their own, as read.
   */
  replaceArea(model, bi, si, { rect, blocks, keep = false, spare = null }) {
    const maxLine = Math.max(-1, ...model.flat(2).map((w) => w.line)); // lines of their own
    const freshBlocks = blocks.map((block) => block.map((s) => s.map((w) => ({ ...w, line: w.line < 0 ? -1 : maxLine + 1 + w.line }))));
    const fresh = freshBlocks.flat();
    const there = (w) => inRect(w, rect) && !spare?.has(w); // (spare: words put in by another area, kept)
    // Where the text read wrongly was: before the first sentence with words in the area (after it when it begins before the area).
    const mark = [];
    const first = keep ? null : model.flat().find((s) => s.some(there));
    if (first) {
      const b = model.findIndex((block) => block.includes(first));
      model[b].splice(model[b].indexOf(first) + (there(first.find((w) => w.box)) ? 0 : 1), 0, mark);
    }
    if (!keep) {
      for (let b = model.length - 1; b >= 0; b--) {
        for (let s = model[b].length - 1; s >= 0; s--) {
          if (model[b][s] === mark) continue;
          model[b][s] = model[b][s].filter((w) => !there(w));
          if (!model[b][s].length) model[b].splice(s, 1);
        }
        if (!model[b].length) model.splice(b, 1);
      }
    }
    if (first) {
      const at = whereIs(model, mark);
      if (!fresh.length) { removeSentence(model, at.bi, at.si); return null; }
      const block = model[at.bi];
      if (freshBlocks.length === 1) block.splice(at.si, 1, ...fresh); // (in the paragraph it was in)
      else model.splice(at.bi, 1, ...[block.slice(0, at.si), ...freshBlocks, block.slice(at.si + 1)].filter((b) => b.length));
    } else {
      const hs = model.flat(2).filter((w) => w.box).map((w) => w.box[3]).sort((p, q) => p - q);
      const lineH = hs.length ? hs[Math.floor(hs.length / 2)] : 32;
      if (freshBlocks.length === 1) for (const s of fresh) placeOnPage(model, s, lineH);
      else {
        for (const block of freshBlocks) { // (each paragraph where all of it is on the page)
          const all = block.flat();
          placeOnPage(model, all, lineH);
          const { bi, si } = whereIs(model, all);
          model.splice(bi, 1, ...[model[bi].slice(0, si), block, model[bi].slice(si + 1)].filter((b) => b.length));
        }
      }
    }
    return fresh.length ? whereIs(model, fresh[0]) : null;
  },
  /** Several areas read again, one after the other (replaceArea each: [{rect, blocks, keep}]): one step to undo. */
  replaceAreas(model, bi, si, { areas }) {
    const spare = new Set();
    let firstNew = null;
    for (const area of areas) {
      const before = new Set(model.flat(2));
      const at = OPS.replaceArea(model, bi, si, { ...area, spare });
      model.flat(2).forEach((w) => { if (!before.has(w)) spare.add(w); });
      if (at && !firstNew) firstNew = model[at.bi][at.si];
    }
    return firstNew ? whereIs(model, firstNew) : null;
  },
  /**
   * The whole page read again (sentences: [{words, block: its paragraph as read, first: the
   * first of it}], in reading order) takes the place of its text, except the sentences the user
   * corrected (corrected(): compared with the text as it was made, original). Each new sentence
   * goes where the old sentence it covers most was, so the page keeps its order (as corrected)
   * and the corrected sentences their places; one on no old sentence goes after the new one
   * before it (the first ones: before the first placed one). Paragraphs: as read, and where a
   * corrected sentence started one.
   */
  rereadPage(model, bi, si, { original, sentences }) {
    const old = model.flatMap((block) => block.map((s, k) => ({ s, first: k === 0 })));
    const { kept } = corrected(model, original);
    const anchors = sentences.map(({ words }) => {
      const votes = new Map();
      for (const w of words) {
        let best = -1, most = 0.3;
        if (w.box) old.forEach(({ s }, i) => s.forEach((v) => { const o = v.box ? overlap(v.box, w.box) : 0; if (o > most) [best, most] = [i, o]; }));
        if (best >= 0) votes.set(best, (votes.get(best) || 0) + 1);
      }
      return votes.size ? [...votes].sort((p, q) => q[1] - p[1] || p[0] - q[0])[0][0] : -1;
    });
    let at = anchors.find((a) => a >= 0);
    const top = (s) => Math.min(...s.filter((w) => w.box).map((w) => w.box[1]));
    const pos = anchors.map((a, j) => {
      if (at === undefined) { // nothing of the page where they are: by their height on the page
        const k = old.findIndex(({ s }) => top(s) > top(sentences[j].words));
        return (k < 0 ? old.length : k) - 0.5;
      }
      if (a >= 0) at = a;
      return at;
    });
    const maxLine = Math.max(-1, ...[...kept].flat().map((w) => w.line)); // (new lines of their own)
    const items = [
      ...old.flatMap(({ s, first }, i) => (kept.has(s) ? [{ s, first, key: i, sub: 0 }] : [])),
      ...sentences.map(({ words, block, first }, j) => ({
        s: words.map((w) => ({ ...w, line: w.line < 0 ? -1 : maxLine + 1 + w.line })), block, first, fresh: true, key: pos[j], sub: 1 + j,
      })),
    ].sort((p, q) => p.key - q.key || p.sub - q.sub);
    const out = [];
    let block; // (the paragraph as read of the last new sentence in the paragraph going on)
    for (const it of items) {
      const start = !out.length || (it.fresh ? (block === undefined ? it.first : it.block !== block) : it.first);
      if (start) { out.push([]); block = undefined; }
      out[out.length - 1].push(it.s);
      if (it.fresh) block = it.block;
    }
    model.splice(0, model.length, ...out);
    return out.length ? { bi: 0, si: 0 } : null;
  },
};

/** How much two boxes [x, y, w, h] overlap: 0 (not) to 1 (the smaller one inside the other). */
function overlap(a, b) {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return w <= 0 || h <= 0 ? 0 : (w * h) / Math.max(1, Math.min(a[2] * a[3], b[2] * b[3]));
}

const wordKey = (w) => `${w.t}|${w.box.map(Math.round).join(',')}`;

/**
 * What the corrections of a page (model) changed, compared with its text as it was made
 * (original doc; null: there was none, everything was typed). kept: the sentences the user
 * corrected — text changed or typed, read again by area, put in another place, split or joined —
 * which stay as they are when the page is read again; deleted: the boxes of words as made that
 * are gone (deleted, with nothing in their place).
 */
export function corrected(model, original) {
  const sentences = model.flat().filter((s) => s.length);
  if (!original) return { kept: new Set(sentences), deleted: [] };
  const made = toModel(original).flat();
  const from = new Map(); // word as made -> the sentence it was in
  made.forEach((s, k) => s.forEach((w) => { if (w.box) from.set(wordKey(w), k); }));
  const kept = new Set(sentences.filter((s) => {
    const was = new Set(s.map((w) => (w.box ? from.get(wordKey(w)) : undefined)));
    return was.size !== 1 || was.has(undefined) || made[[...was][0]].length !== s.length;
  }));
  const now = sentences.flat().filter((w) => w.box);
  const deleted = made.flat().filter((w) => w.box && !now.some((v) => overlap(v.box, w.box) > 0.3)).map((w) => w.box);
  return { kept, deleted };
}

/**
 * The sentences of a page read again (doc), without what was read in the places of the kept
 * sentences, or what says the same as one typed without a place on the page: [{words, block,
 * deleted}] (block: its paragraph; deleted: most of it where the user deleted text before).
 */
function freshSentences(doc, kept, deleted) {
  const keptWords = [...kept].flat().filter((w) => w.box);
  const said = new Set([...kept].filter((s) => !s.some((w) => w.box)).map((s) => norm(sentenceText(s))).filter((t) => t.length > 3));
  return toModel(doc).flatMap((block, b) => block.map((s) => s.filter((w) => !w.box || !keptWords.some((k) => overlap(k.box, w.box) > 0.4)))
    .filter((s) => s.length && !said.has(norm(sentenceText(s))))
    .map((words) => {
      const boxed = words.filter((w) => w.box);
      return { words, block: b, deleted: boxed.length > 0 && boxed.filter((w) => deleted.some((d) => overlap(d, w.box) > 0.4)).length * 2 >= boxed.length };
    }));
}

const inOrder = (list) => [...list].sort((p, q) => p.bi - q.bi || p.si - q.si);
/** Is the middle of a word inside a box drawn on the page? */
const inRect = (w, r) => !!w.box && w.box[0] + w.box[2] / 2 >= r.x && w.box[0] + w.box[2] / 2 <= r.x + r.w
  && w.box[1] + w.box[3] / 2 >= r.y && w.box[1] + w.box[3] / 2 <= r.y + r.h;
const boxOf = (w) => (w[2] > 0 || w[3] > 0 ? w.slice(0, 4) : null); // a word of a page document
// The colors of the sentences OCR found, being reviewed (not the orange of the areas drawn).
const FOUND_COLORS = ['#2563eb', '#16a34a', '#db2777', '#7c3aed', '#0891b2', '#ca8a04', '#dc2626', '#4f46e5'];

// The end of a sentence in a word: 。！？ or . ! ? (and the quotes or brackets after it); not "Mr.", "e.g." or "……".
const SENTENCE_END = /[。！？!?.]["'”’）」』》)\]]*$/;
const NOT_AN_END = /^(mr|mrs|ms|dr|st|vs|etc|e\.g|i\.e|no|p|pp|a\.m|p\.m)\.$|(\.\.\.|…)["'”’）」』》)\]]*$/i;

/** Where a sentence (words) would be split to begin with: the word after each end of a sentence in it. */
function sentenceStarts(words) {
  return new Set(words.map((_, k) => k).filter((k) => k > 0 && SENTENCE_END.test(words[k - 1].t) && !NOT_AN_END.test(words[k - 1].t)));
}

/** A sentence (words) cut before the words at these places (starts): [words, …]. */
function cutAt(words, starts) {
  const cuts = [...starts].filter((k) => k > 0 && k < words.length).sort((p, q) => p - q);
  return [0, ...cuts].map((a, i) => words.slice(a, [...cuts, words.length][i]));
}

/** The boxes of the lines of a sentence ({box, line} words): [{x, y, w, h}], one for each line. */
function lineBoxes(words) {
  const lines = new Map();
  for (const { box, line } of words) {
    if (!box) continue;
    const [x, y, w, h] = box, b = lines.get(line);
    if (!b) lines.set(line, { x0: x, y0: y, x1: x + w, y1: y + h });
    else Object.assign(b, { x0: Math.min(b.x0, x), y0: Math.min(b.y0, y), x1: Math.max(b.x1, x + w), y1: Math.max(b.y1, y + h) });
  }
  return [...lines.values()].map((b) => ({ x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 }));
}

/** Which area drawn on the page each sentence is in: Map(sentence -> area number), for the
 * sentences with most of their words in one (the first area drawn wins). */
function areaMembers(model, areas) {
  const areaOf = new Map();
  for (const s of model.flat()) {
    const boxed = s.filter((w) => w.box);
    const a = areas.findIndex((r) => boxed.length && boxed.filter((w) => inRect(w, r)).length * 2 >= boxed.length);
    if (a >= 0) areaOf.set(s, a);
  }
  return areaOf;
}

const docJSON = (doc) => JSON.stringify({ words: doc.words, sent: doc.sent, clause: doc.clause, blocks: doc.blocks });

/** Each line of JSON of an answer, as it comes (the steps of reading a page). */
async function eachLine(response, use) {
  let rest = '';
  const take = (text, end) => {
    const lines = (rest + text).split('\n');
    rest = end ? '' : lines.pop();
    for (const line of lines) if (line.trim()) use(JSON.parse(line));
  };
  if (!response.body?.getReader) { take(await response.text(), true); return; } // (older browsers: all at the end)
  const reader = response.body.getReader(), decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    take(done ? decoder.decode() : decoder.decode(value, { stream: true }), done);
    if (done) return;
  }
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight + 2}px`;
}

// ---------------------------------------------------------------- The editor panel

export class TextEditor {
  constructor(app) {
    this.app = app;
    this.active = false;
    this.returnToLayout = null; // returning from the layout editor keeps its unsaved page boxes
    this.sel = null;        // {view, bi, si}
    this.pendingTool = null; // a page-layout action waiting for the user to choose a sentence
    this.moveByClick = null; // selected sentence awaiting a destination click
    this.mergeSequence = null; // {view, list}: anchor and following sentences in the order to merge
    this.splitting = false;
    this.editingText = false; // the selected sentence shows its text box
    this.adding = null;     // {view, bi, si}: add after this sentence (bi = -1: at the end)
    this.marking = null;    // selection being marked on the page
    this.markingMode = null;
    this.ocrPreview = null;
    this.pageRead = null;   // the whole page being read again: {view, steps, at, stop}
    this.checked = new Map(); // view -> the sentences (numbers on the page) chosen with their boxes
    this.lastChecked = null;  // {view, s}: Shift+click chooses everything from there
    this.boxing = null;     // {op, hint}: a box is being drawn on a page to choose sentences
    this.ordering = null;   // {view, areas}: ordering the page by areas (drawn one after the other)
    this.readingAreas = null; // {view, sel, areas}: areas drawn one after the other, to read again with OCR
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
    for (const bar of ['#edit-tools', '#edit-bulk']) {
      $(bar).addEventListener('click', (e) => {
        const b = e.target.closest('button[data-op]');
        if (b && !b.disabled) this.tool(b.dataset.op, b);
      });
    }
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

  start({ returnToLayout = null, initialTool = null } = {}) {
    if (this.active || !this.allowed()) return;
    this.returnToLayout = returnToLayout;
    $('#edit-done').innerHTML = `${icon('check')}${returnToLayout ? 'Return to page layouts' : 'Done'}`;
    $('#edit-done').title = returnToLayout ? 'Finish correcting and return to the page layout editor' : 'Finish correcting (E)';
    this.saveInline();
    // Start on the sentence being read or last used (or the one in the middle of the list).
    const focus = this.app.currentFocus();
    this.app.reader.stop();
    this.app.recordings.stopPicking();
    if (this.app.words?.collecting) this.app.words.setCollecting(false);
    this.active = true;
    document.body.classList.add('editing');
    $('#read-actions').hidden = true;
    $('#edit-actions').hidden = false;
    this.app.showTab('text');
    this.app.setPanelOpen(true);
    this.app.applyMode();
    this.editingText = false;
    const selectFirst = ['edit', 'split', 'mergePrev', 'mergeNext', 'merge-checked', 'move-click', 'add'].includes(initialTool);
    this.pendingTool = selectFirst ? initialTool : null;
    this.sel = selectFirst ? null : focus ? this.selAt(focus.view, focus.w) : null;
    this.render();
    this.showSelection(false, false);
    if (initialTool === 'merge-area') this.tool('check-area');
    else if (this.pendingTool) toast('Click the sentence to apply this action.');
    else if (['read-page', 'ocr', 'order-areas', 'picture', 'buttons'].includes(initialTool)) this.tool(initialTool);
  }

  stop() {
    if (!this.active) return;
    const returnToLayout = this.returnToLayout;
    this.returnToLayout = null;
    this.commitText();
    // Go back to reading on the same sentence.
    const keep = this.sel ? { view: this.sel.view, unit: this.unitOf(this.sel) } : null;
    this.playButtons?.stop();
    this.playButtons = null;
    this.cancelMarking();
    this.stopOrdering();
    this.stopPageRead(false);
    this.ocrPreview = null;
    this.flush();
    this.active = false;
    this.sel = null;
    this.pendingTool = null;
    this.moveByClick = null;
    this.mergeSequence = null;
    this.splitting = false;
    this.editingText = false;
    this.adding = null;
    this.checked.clear();
    document.body.classList.remove('editing');
    this.box.classList.remove('editing');
    $('#read-actions').hidden = false;
    $('#edit-actions').hidden = true;
    $('#edit-done').innerHTML = `${icon('check')}Done`;
    $('#edit-done').title = 'Finish correcting (E)';
    this.app.views.forEach((v) => { v.showActive(null); v.showOutlines([]); v.showFrame(null); v.showAreas([]); v.showFound([]); });
    this.app.applyMode();
    this.app.renderPanelText();
    if (keep && this.app.views.includes(keep.view)) this.app.setFocus(keep.view, keep.unit, false);
    if (returnToLayout) returnToLayout();
  }

  /** The pages on screen changed (called after their text has loaded). */
  pagesChanged() {
    this.inline = null;
    this.sel = null;
    this.moveByClick = null;
    this.mergeSequence = null;
    this.splitting = false;
    this.editingText = false;
    this.adding = null;
    this.marking = null;
    this.markingMode = null;
    this.stopPageRead(false);
    this.ocrPreview = null;
    this.boxing = null;
    this.ordering = null;
    this.readingAreas = null;
    this.checked.clear();
    this.lastChecked = null;
    document.body.classList.remove('marking');
    if (this.active) this.render();
  }

  /** Esc: cancel what is in progress. Returns true if something was cancelled. */
  escape() {
    if (this.playButtons) { // (putting a button: not any more; else the tool stops)
      if (!this.playButtons.escape()) { this.playButtons.stop(); this.playButtons = null; this.render(); }
      return true;
    }
    if (this.mergeSequence) { this.mergeSequence = null; this.render(); toast('Merge sequence canceled.'); return true; }
    if (this.moveByClick) { this.moveByClick = null; this.render(); toast('Move sequence ended. Use Undo to reverse the moves.'); return true; }
    if (this.pageRead) { this.cancelPageRead(); return true; }
    if (this.ocrPreview) { this.ocrPreview = null; this.render(); return true; }
    if (this.drag) { this.cancelDrag(); return true; }
    if (this.inline) { this.cancelInline(); return true; }
    if (this.ordering) { this.stopOrdering(); this.render(); return true; }
    if (this.readingAreas?.base) { this.tool('ocr-cancel'); return true; } // (drawing more areas: back to the review)
    if (this.marking || this.boxing || this.readingAreas) { this.cancelMarking(); this.render(); return true; }
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

  /** Select the sentence that contains word w (a click on the page); with Ctrl or Shift, choose it. */
  selectAtWord(view, w, e) {
    if (this.splitting && this.sel?.view === view && e?.target?.dataset?.w != null) { // splitting: a word of the sentence on the page
      const [a, b] = view.doc.sent[this.flatIndex(this.sel)], k = Number(e.target.dataset.w);
      if (k >= a && k < b) { this.toggleSplit(k - a); return; }
    }
    const sel = this.selAt(view, w);
    if (!sel) return;
    if (this.moveSequence(sel)) return;
    if (this.mergeSequence && this.mergeSequenceClick(sel)) return;
    if (e && (e.ctrlKey || e.metaKey || e.shiftKey)) this.toggleCheck(view, view.text.w2s[w], e.shiftKey);
    else this.select(sel.view, sel.bi, sel.si, true);
  }

  /** A click picks the next sentence to place after the reference/current last moved sentence. */
  moveSequence(source) {
    if (!this.moveByClick) return false;
    const cursor = this.moveByClick;
    if (source.view !== cursor.view) {
      toast('Choose sentences from the same page as the reference.');
      return true;
    }
    if (source.bi === cursor.bi && source.si === cursor.si) {
      toast('That sentence is already the reference or the last one moved. Click another sentence.');
      return true;
    }
    this.run('moveAfter', { bi: cursor.bi, si: cursor.si }, source);
    this.moveByClick = this.sel ? { ...this.sel } : null;
    if (this.sel) toast(`Moved it to position ${this.flatIndex(this.sel) + 1}. Click the next sentence to place it after this one.`);
    return true;
  }

  /** A click adds the next sentence after the merge anchor, in the chosen order. */
  mergeSequenceClick(source) {
    const sequence = this.mergeSequence;
    if (!sequence) return false;
    if (source.view !== sequence.view) {
      toast('Choose sentences from the same page as the merge anchor.');
      return true;
    }
    if (sequence.list.some((p) => p.bi === source.bi && p.si === source.si)) {
      toast('That sentence is already in the merge order. Choose another one.');
      return true;
    }
    sequence.list.push({ bi: source.bi, si: source.si });
    this.render();
    toast(`Sentence ${this.flatIndex(source) + 1} added to the merge order (${sequence.list.length} picked).`);
    return true;
  }

  /** First press starts an ordered merge at the selected sentence; the next press applies it. */
  mergeTool() {
    if (!this.mergeSequence) {
      if (!this.sel) { toast('Select the sentence that should come first, then click Merge in order.'); return; }
      this.commitText();
      this.mergeSequence = { view: this.sel.view, list: [{ bi: this.sel.bi, si: this.sel.si }] };
      this.render();
      toast(`Sentence ${this.flatIndex(this.sel) + 1} is the anchor. Click the following sentences in order, then click Finish merge.`);
      return;
    }
    if (this.mergeSequence.list.length < 2) {
      toast('Choose at least one following sentence before finishing the merge.');
      return;
    }
    const sequence = this.mergeSequence;
    const list = sequence.list.map((p) => ({ ...p }));
    const firstNumber = this.flatIndex({ view: sequence.view, ...list[0] }) + 1;
    this.mergeSequence = null;
    this.run('mergeOrdered', list, { view: sequence.view, ...list[0] });
    toast(`Merged ${list.length} sentences in the picked order, starting with sentence ${firstNumber}.`);
  }

  // ---------- Choosing several sentences (their boxes in the list, Ctrl+click on the page) ----------

  checkSet(view) {
    if (!this.checked.has(view)) this.checked.set(view, new Set());
    return this.checked.get(view);
  }

  anyChecked() { return [...this.checked.values()].some((set) => set.size); }

  /** The chosen sentences of each page: [{view, list: [{bi, si}]}]. */
  checkedByView() {
    return this.app.views.map((view) => {
      const set = this.checked.get(view);
      const list = [];
      (view.doc?.blocks || []).forEach(([sa, sb], bi) => { for (let s = sa; s < sb; s++) if (set?.has(s)) list.push({ bi, si: s - sa }); });
      return { view, list };
    }).filter((x) => x.list.length);
  }

  /** Choose or drop sentence s (its number on the page); range: everything from the one chosen last. */
  toggleCheck(view, s, range = false) {
    const set = this.checkSet(view);
    const from = range && this.lastChecked?.view === view ? this.lastChecked.s : null;
    if (from != null) {
      const on = !set.has(s) || set.has(from);
      for (let k = Math.min(from, s); k <= Math.max(from, s); k++) if (on) set.add(k); else set.delete(k);
    } else if (set.has(s)) set.delete(s);
    else set.add(s);
    this.lastChecked = { view, s };
    this.render();
  }

  /** Choose every sentence with a word inside a box drawn on the page. */
  checkArea(view, rect) {
    const set = this.checkSet(view);
    const before = set.size;
    view.doc?.words.forEach((w, k) => {
      if (inRect({ box: boxOf(w) }, rect) && view.text.w2s[k] >= 0) set.add(view.text.w2s[k]);
    });
    toast(set.size > before ? `${set.size - before} sentence${set.size - before === 1 ? '' : 's'} chosen.` : 'No sentence is in that area.');
    this.render();
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
    if (this.pendingTool) {
      const op = this.pendingTool;
      this.pendingTool = null;
      this.tool(op);
    }
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
    const beforeDoc = view.doc || { words: [], sent: [], clause: [], blocks: [] };
    const before = docJSON(beforeDoc);
    const model = toModel(beforeDoc);
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
    this.checked.clear(); // (the sentence numbers have changed)
    this.lastChecked = null;
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
    if (op === 'merge-checked') { this.mergeTool(); return; }
    if (this.mergeSequence) { toast('Finish the merge or press Esc to cancel it first.'); return; }
    if (op === 'ocr') { this.startOcr(); return; }
    if (this.bulkTool(op, btn)) return;
    if (op === 'add-end') {
      this.commitText();
      this.adding = { view: this.app.views[Number(btn.dataset.v)], bi: -1, si: -1 };
      this.render();
      return;
    }
    if (op === 'add-save') { this.saveAdd(); return; }
    if (op === 'add-cancel' || op === 'split-cancel') { this.escape(); return; }
    if (op === 'split-at') { this.toggleSplit(Number(btn.dataset.k)); return; }
    if (op === 'split-apply') { this.applySplit(); return; }
    if (op === 'split-clear') { this.splitStarts?.clear(); this.render(); return; }
    this.commitText();
    if (!this.sel) return;
    if (op === 'move-click') {
      this.moveByClick = { ...this.sel };
      this.render();
      toast('Now click sentences to move them here in order. Each one is placed after the previous one. Esc ends the sequence.');
      return;
    }
    if (op === 'edit') { this.splitting = false; this.adding = null; this.editingText = true; this.render(); return; }
    this.editingText = false;
    if (op === 'split') { // (to begin with: a new sentence after each end of a sentence in it)
      this.splitting = !this.splitting;
      this.splitStarts = this.splitting ? sentenceStarts(this.selWords()) : null;
      this.adding = null;
      this.render();
      return;
    }
    if (op === 'add') { this.splitting = false; this.adding = { ...this.sel }; this.render(); return; }
    if (op === 'mark') {
      if (this.marking) { this.cancelMarking(); this.render(); } else this.startMarking();
      return;
    }
    this.run(op);
    if (op === 'delete') toast('Sentence deleted. Ctrl+Z (or Undo) brings it back.');
  }

  /** The words of the selected sentence ({t, box, line, sp}). */
  selWords() {
    return toModel(this.sel.view.doc)[this.sel.bi][this.sel.si];
  }

  /** Splitting: the word at place k of the sentence starts a new sentence, or not any more. */
  toggleSplit(k) {
    if (!this.splitting || !this.splitStarts || !(k > 0)) return;
    if (this.splitStarts.has(k)) this.splitStarts.delete(k);
    else this.splitStarts.add(k);
    this.render();
  }

  /** Split the selected sentence before every word marked: as many sentences, one step to undo. */
  applySplit() {
    const n = this.sel && this.splitStarts ? cutAt(this.selWords(), this.splitStarts).length : 0;
    if (n < 2) { toast('Click the word that starts each new sentence first.'); return; }
    this.run('splitAt', [...this.splitStarts]);
    this.splitStarts = null;
    toast(`Split into ${n} sentences. Ctrl+Z (or Undo) joins them again.`);
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
    this.stopOrdering();
    this.cancelMarking();
    this.marking = sel;
    this.markingMode = 'mark';
    document.body.classList.add('marking');
    this.render();
    sel.view.startMarking((rect) => {
      this.marking = null;
      this.markingMode = null;
      document.body.classList.remove('marking');
      if (rect) this.run('mark', { rect, lineH: lineHeight(sel.view.doc) }, sel);
      else this.render();
    });
  }

  cancelMarking() {
    if (this.readingAreas) {
      this.readingAreas = null;
      this.app.views.forEach((v) => { v.stopMarking(); v.showAreas([]); });
      document.body.classList.remove('marking');
    }
    if (this.boxing) {
      this.boxing = null;
      this.app.views.forEach((v) => v.stopMarking());
      document.body.classList.remove('marking');
    }
    if (!this.marking) return;
    this.marking.view.stopMarking();
    this.marking = null;
    this.markingMode = null;
    document.body.classList.remove('marking');
  }

  /** Re-read text by area: draw boxes on the page, one after the other, then read them all (readAreas). */
  startOcr() {
    if (!this.allowed()) return;
    if (this.readingAreas) { this.cancelMarking(); this.render(); return; } // (pressed again: cancel)
    if (!this.app.views.length) return;
    this.commitText();
    this.stopOrdering();
    this.cancelMarking();
    this.stopPageRead(false);
    this.ocrPreview = null;
    this.readingAreas = { view: null, sel: this.sel, areas: [] };
    document.body.classList.add('marking');
    this.waitForArea(this.readingAreas);
    this.render();
  }

  /** Read the areas drawn, one after the other, and show what was found in each to review (more areas: with what was found before). */
  readDrawnAreas() {
    const o = this.readingAreas;
    if (!o?.areas.length) { toast('Draw at least one box on the page first.'); return; }
    this.cancelMarking();
    this.readAreas(o.view, o.areas, o.sel?.view === o.view ? o.sel : { view: o.view, bi: -1, si: -1 }, o.base?.read, null, o.base);
  }

  /** The review open: draw more areas, to read and add to it (what was found and changed stays). */
  drawMoreAreas() {
    const p = this.ocrPreview, section = this.box.querySelector('.ocr-preview');
    if (!p?.areas || p.whole || p.frame) return;
    if (section?.preview === p) p.restore = this.reviewState(section);
    this.ocrPreview = null;
    this.readingAreas = { view: p.view, sel: p.sel, areas: [], base: p };
    document.body.classList.add('marking');
    this.waitForArea(this.readingAreas);
    this.render();
  }

  /** The areas drawn to read again: how much text each has now; read them, take one back, or cancel (more areas: back to the review). */
  renderReadingAreas() {
    const { view, areas, base } = this.readingAreas;
    const op = (name, label, cls = '', disabled = false) => el('button', { class: `tbtn ${cls}`, type: 'button', disabled, dataset: { op: name } }, label);
    const words = (r) => (view?.doc ? view.doc.words.filter((w) => inRect({ box: boxOf(w) }, r)).length : 0);
    const found = base ? this.ocrSentences(base).length : 0;
    return el('section', { class: 'order-panel read-areas-panel' },
      el('h4', {}, base ? 'Re-read text by area: more areas' : 'Re-read text by area'),
      el('p', { class: 'edit-hint' }, base
        ? `The ${found} sentence${found === 1 ? '' : 's'} found so far stay, with your changes (outlined on the page in their colors). Draw a box around text they do not have, as many as you need, then read them (or press Enter): they are added to the review.`
        : areas.length
          ? 'Draw the next box, as many as you need, one after the other. Then read them (or press Enter): you check what was found in each box before it is used.'
          : 'Draw a box on the page around text that was missed or read wrongly. You can draw several boxes, one after the other, and read them all at once.'),
      areas.length ? el('ol', { class: 'order-list', start: (base?.areas.length || 0) + 1 }, ...areas.map((r) => {
        const n = words(r);
        return el('li', {}, n ? `${n} word${n === 1 ? '' : 's'} there now` : 'no text there now');
      })) : null,
      el('div', { class: 'etools' }, op('ocr-read', areas.length > 1 ? `Read the ${areas.length} areas` : 'Read the area', 'primary', !areas.length),
        op('ocr-back', 'Take back the last box', '', !areas.length), op('ocr-cancel', base ? 'Back to the review' : 'Cancel')));
  }

  /**
   * Read the whole page again (OCR, read: which languages), showing each step as it goes. The
   * sentences the user corrected stay as they are (corrected()): what is read in their places is
   * left out, and text deleted before comes back unticked. Then the new sentences to review
   * (ocrPreview); they take the place of the rest of the page's text.
   */
  async readWholePage(read) {
    if (!this.allowed()) return;
    const view = this.sel?.view || this.app.views[0];
    if (!view) return;
    const sel = this.sel || { view, bi: -1, si: -1 };
    this.commitText();
    this.stopOrdering();
    this.cancelMarking();
    this.stopPageRead();
    const { lang, reads, first } = this.areaLanguages(view.book);
    read = reads.some(([v]) => v === read) ? read : reads.some(([v]) => v === this.areaRead) ? this.areaRead : first;
    this.areaRead = read;
    const job = this.pageRead = { view, stop: new AbortController(), steps: [{ name: 'Finding your corrections' }], at: 0, since: performance.now() };
    job.timer = setInterval(() => this.drawPageRead(), 250);
    const step = (k) => { [job.at, job.since, job.waiting] = [k, performance.now(), false]; this.drawPageRead(true); };
    this.ocrPreview = null;
    this.setStatus('reading-page');
    this.render();
    try {
      // What the corrections changed: against the text as it was made (none: nothing to keep).
      let original = view.doc;
      if (view.edited || this.timers.has(view) || this.saving.has(view)) {
        const r = await fetch(`${view.textUrl}?original=1`, { cache: 'no-store', signal: job.stop.signal });
        original = r.ok ? await r.json() : null;
        if (!r.ok && r.status !== 404) throw new Error('The text of the page could not be loaded. Try again.');
        if (original && !original.original) throw new Error('The app’s server is an older version: close the app and start it again.');
      }
      const model = toModel(view.doc);
      const { kept, deleted } = corrected(model, original);
      job.steps[0].name = kept.size ? `Your corrections kept: ${kept.size} sentence${kept.size === 1 ? '' : 's'}` : 'No corrected sentences on this page';
      step(1);
      const r = await fetch(`/api/ocr-region/${view.book.slug}/${view.page.path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: job.stop.signal,
        body: JSON.stringify({ x: 0, y: 0, w: view.W, h: view.H, language: lang, read, progress: true }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'The page could not be read.');
      let doc = null;
      await eachLine(r, (line) => {
        if (line.error) throw new Error(line.error);
        if (line.plan) {
          job.steps.push(...line.plan.map((name) => ({ name, long: /OCR/.test(name) })), { name: 'Leaving out the places of your corrections' });
          this.drawPageRead(true);
        }
        if (line.waiting) { job.waiting = true; this.drawPageRead(true); }
        if (line.at != null) step(1 + line.at);
        if (line.doc) doc = line.doc;
      });
      if (!doc) throw new Error('The page could not be read: the connection to the app was lost.');
      step(job.steps.length - 1);
      const sentences = freshSentences(doc, kept, deleted);
      const there = model.flat().filter((s) => !kept.has(s)).reduce((n, s) => n + s.length, 0);
      if (this.pageRead !== job) return;
      this.stopPageRead(false);
      if (!this.app.views.includes(view)) return;
      if (!sentences.length) toast(kept.size ? 'Nothing more was found on the page than your corrections.' : 'No text was found on the page: try reading other languages.');
      this.ocrPreview = { doc, sel, view, rect: { x: 0, y: 0, w: view.W, h: view.H }, there, read, reads,
        whole: { original, sentences, kept: model.flat().filter((s) => kept.has(s)).map(sentenceText) } };
      this.setStatus('');
      this.render();
    } catch (err) {
      if (this.pageRead !== job) return; // (stopped)
      this.stopPageRead(false);
      this.setStatus('error');
      toast(err.message || 'The page could not be read.');
      this.render();
    }
  }

  /** Stop reading the whole page again (render: show the page's sentences again). */
  stopPageRead(render = true) {
    const job = this.pageRead;
    if (!job) return;
    this.pageRead = null;
    clearInterval(job.timer);
    job.stop.abort();
    if (this.status === 'reading-page') this.setStatus('');
    if (render) this.render();
  }

  /** The Stop button, or Esc. */
  cancelPageRead() {
    this.stopPageRead();
    toast('Reading the page again was stopped. Its text was not changed.');
  }

  /** How far reading the whole page is: its steps (done, going on, to come) and a bar. */
  renderPageRead() {
    const job = this.pageRead;
    const fill = el('div', {});
    const bar = el('div', { class: 'rec-progress', role: 'progressbar', 'aria-label': 'Reading the page', 'aria-valuemin': '0', 'aria-valuemax': '100' }, fill);
    const list = el('ol', { class: 'page-read-steps', 'aria-live': 'polite' });
    job.ui = { fill, bar, list };
    this.drawPageRead(true);
    return el('section', { class: 'ocr-preview page-read' },
      el('h4', {}, `Reading page ${job.view.page.n} again`),
      el('p', { class: 'edit-hint' }, 'The sentences you corrected stay as they are: what is read in their places is left out. '
        + 'Text you deleted before comes back unticked. Nothing changes before you look at what was found.'),
      list, bar,
      el('div', { class: 'ocr-preview-actions' }, el('button', { class: 'btn', type: 'button', onclick: () => this.cancelPageRead() }, 'Stop')));
  }

  drawPageRead(steps = false) {
    const job = this.pageRead;
    if (!job?.ui) return;
    if (steps) {
      job.ui.list.replaceChildren(...job.steps.map((s, k) => el('li', { class: k < job.at ? 'done' : k === job.at ? 'now' : '' },
        k === job.at && job.waiting ? 'Waiting for another reading to finish…' : `${s.name}${k === job.at ? '…' : ''}`)));
    }
    // The steps done, and the one going on filling up slowly (reading with OCR takes the longest).
    const weight = (s) => (s.long ? 6 : 1);
    const total = job.steps.reduce((n, s) => n + weight(s), 0) + (job.steps.length > 1 ? 0 : 9); // (before the steps of the reading are known)
    const done = job.steps.slice(0, job.at).reduce((n, s) => n + weight(s), 0);
    const now = job.steps[job.at] ? weight(job.steps[job.at]) : 0;
    const part = job.waiting ? 0 : 0.9 * now * (1 - Math.exp(-(performance.now() - job.since) / (now > 1 ? 5000 : 1500)));
    const percent = Math.min(99, Math.round((100 * (done + part)) / total));
    job.ui.fill.style.width = `${percent}%`;
    job.ui.bar.setAttribute('aria-valuenow', String(percent));
  }

  /**
   * What an area can be read for: [read, label] — the languages of the book ('all'), only its
   * main language ('main'), or only English ('en'); and which is chosen first (the book's own
   * languages, as said when it was added).
   */
  areaLanguages(book) {
    const name = { 'zh-Hans': 'Chinese', 'zh-Hant': 'Chinese (Traditional)', es: 'Spanish', fr: 'French', de: 'German', ja: 'Japanese', ko: 'Korean', ar: 'Arabic' };
    const lang = book.disc ? 'en' : book.importOptions?.language || book.language || 'en';
    if (lang === 'en') return { lang, reads: [['all', 'English']], first: 'all' };
    const n = name[lang] || lang;
    return { lang, reads: [['all', `${n} and English`], ['main', `${n} only`], ['en', 'English only']],
      first: book.importOptions?.english === false ? 'main' : 'all' };
  }

  /** Read an area of a page again with OCR (read: which languages), and show what was found to review (readAreas). */
  readArea(view, rect, sel, read, frame = null) {
    return this.readAreas(view, [rect], sel, read, frame);
  }

  /**
   * Read areas of the page with OCR, one after the other, to review what was found in each
   * (ocrPreview.areas: [{rect, doc, there: how many words are there now}]). frame ({n, now}): the
   * new frame of sentence n (its text now), its handles let go: what is read there is one
   * sentence, offered in the place of its text (nothing to review when it is the same). base: the
   * review they are added to (more areas drawn), with what was changed in it.
   */
  async readAreas(view, rects, sel, read, frame = null, base = null) {
    const { lang, reads, first } = this.areaLanguages(view.book);
    read = reads.some(([v]) => v === read) ? read : reads.some(([v]) => v === this.areaRead) ? this.areaRead : first;
    this.areaRead = read;
    this.stopPageRead(false);
    this.ocrPreview = null;
    this.hotFound = null;
    const ask = this.areaAsk = {}; // (the last one asked is shown)
    const many = rects.length > 1;
    this.readingNote = many ? `Reading area 1 of ${rects.length}…` : '';
    this.setStatus('reading');
    this.render();
    try {
      const areas = [];
      for (const [k, rect] of rects.entries()) {
        if (many) { this.readingNote = `Reading area ${k + 1} of ${rects.length}…`; this.updateStatus(); }
        const r = await fetch(`/api/ocr-region/${view.book.slug}/${view.page.path}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...rect, language: lang, read }),
        });
        const doc = await r.json();
        if (ask !== this.areaAsk || !this.active) return;
        if (!r.ok) throw new Error(`${many ? `Area ${k + 1}: ` : ''}${doc.error || 'The selected area could not be read.'}`);
        // The words there now: replacing them is offered (and chosen when there are some).
        areas.push({ rect, doc, there: view.doc ? view.doc.words.filter((w) => inRect({ box: boxOf(w) }, rect)).length : 0 });
      }
      this.readingNote = '';
      if (frame) {
        const text = sentenceText(toModel(areas[0].doc).flat().flat());
        const said = !text ? 'nothing could be read there: its text stays as it is'
          : text.replace(/\s+/g, '') === frame.now.replace(/\s+/g, '') ? 'the same text' : '';
        if (said) { this.setStatus(''); this.render(); toast(`Sentence ${frame.n} read again in its new size: ${said}.`); return; }
      } else if (!areas.some((a) => a.doc.words?.length)) {
        toast(`No text was found in ${many ? 'those areas' : 'that area'}: type it yourself, or try a wider box or another language.`);
      }
      this.ocrPreview = { sel, view, areas: [...(base?.areas || []), ...areas], read, reads, frame, restore: base?.restore };
      this.setStatus('');
      this.render();
    } catch (err) {
      if (ask !== this.areaAsk) return;
      if (base) this.ocrPreview = base; // (the review as it was)
      this.readingNote = '';
      this.setStatus('error');
      toast(err.message || 'The selected area could not be read.');
      this.render();
    }
  }

  /** The selected sentence's frame changed on the page (to): its words read again there. */
  readFrame(view, to) {
    const s = this.sel;
    if (!s || s.view !== view || !view.doc?.blocks[s.bi]) return;
    const k = this.flatIndex(s), pad = lineHeight(view.doc) * 0.3; // (a little around it: OCR reads the letters whole)
    this.readArea(view, { x: to.x - pad, y: to.y - pad, w: to.w + 2 * pad, h: to.h + 2 * pad }, s, undefined,
      { n: k + 1, now: view.text.text(...view.doc.sent[k]) });
  }

  /** What a review of OCR shows, one row each: [{words, block (its paragraph as read), area (its number), deleted}]. */
  ocrSentences({ whole, frame, areas }) {
    if (whole) return whole.sentences;
    if (frame) return [{ words: toModel(areas[0].doc).flat().flat(), area: 0 }];
    return areas.flatMap(({ doc }, area) => toModel(doc).flatMap((block, b) => block.map((words) => ({ words, block: b, area }))));
  }

  // ---------- Ordering the page by areas ----------

  /** Start drawing areas: the sentences in each become a paragraph, in the order the areas are drawn. */
  startOrdering() {
    this.commitText();
    this.cancelMarking();
    this.stopPageRead(false);
    this.ocrPreview = null;
    this.ordering = { view: null, areas: [] };
    document.body.classList.add('marking');
    this.waitForArea(this.ordering);
    this.render();
  }

  /** Wait for the next area of o (ordering, or the areas to read again), on the page of the first one. */
  waitForArea(o) {
    for (const view of this.app.views) {
      view.stopMarking();
      view.showAreas(o.view === view ? [...(o.base?.areas.map((a) => a.rect) || []), ...o.areas] : []); // (more areas: after those read before)
      if (o.view && view !== o.view) continue;
      view.startMarking((rect) => {
        if (this.ordering !== o && this.readingAreas !== o) return;
        if (rect) { o.view = view; o.areas.push(rect); }
        this.waitForArea(o);
        this.render();
      });
    }
  }

  stopOrdering() {
    if (!this.ordering) return;
    this.ordering = null;
    this.app.views.forEach((v) => { v.stopMarking(); v.showAreas([]); });
    document.body.classList.remove('marking');
  }

  applyOrdering() {
    const o = this.ordering;
    if (!o?.areas.length) { toast('Draw at least one area on the page first.'); return; }
    this.stopOrdering();
    this.run('orderAreas', { areas: o.areas, lineH: lineHeight(o.view.doc) }, { view: o.view, bi: 0, si: 0 });
    toast('The sentences are in the order of the areas. Ctrl+Z (or Undo) puts them back.');
  }

  /** What each area drawn so far holds: [{n: sentences, first: its first sentence}], and the sentences in areas. */
  orderingPreview() {
    const { view, areas } = this.ordering;
    if (!view?.doc) return { parts: [], inAreas: new Set() };
    const model = toModel(view.doc);
    const areaOf = areaMembers(model, areas), lineH = lineHeight(view.doc);
    const flat = model.flat();
    const parts = areas.map((_, a) => {
      const sents = readingOrder(flat.filter((s) => areaOf.get(s) === a), lineH);
      return { n: sents.length, first: sents.length ? sentenceText(sents[0]) : '' };
    });
    return { parts, inAreas: new Set(flat.map((s, k) => (areaOf.has(s) ? k : -1)).filter((k) => k >= 0)) };
  }

  renderOrdering() {
    const { parts } = this.orderingPreview();
    const op = (name, label, cls = '', disabled = false) => el('button', { class: `tbtn ${cls}`, type: 'button', disabled, dataset: { op: name } }, label);
    return el('section', { class: 'order-panel' },
      el('h4', {}, 'Order by areas'),
      el('p', { class: 'edit-hint' }, parts.length
        ? 'Draw the next area, or apply. In each area the sentences go from the top, left to right; each area becomes a paragraph, where the first of its sentences is now.'
        : 'Draw a box around the first part of the page (a paragraph, a dialogue, a column…), then the next, in the order they should be read.'),
      parts.length ? el('ol', { class: 'order-list' }, ...parts.map((p) => el('li', {},
        p.n ? `${p.n} sentence${p.n === 1 ? '' : 's'}: “${p.first.slice(0, 48)}${p.first.length > 48 ? '…' : ''}”` : 'no sentence in it'))) : null,
      el('div', { class: 'etools' }, op('order-apply', 'Apply this order', 'primary', !parts.some((p) => p.n)),
        op('order-back', 'Take back the last area', '', !parts.length), op('order-cancel', 'Cancel')));
  }

  /** For tool op: let the user drag a box on one of the pages shown; done(view, rect) or done(null). */
  drawBox(op, hint, done) {
    this.stopOrdering();
    this.cancelMarking();
    this.boxing = { op, hint };
    document.body.classList.add('marking');
    for (const view of this.app.views) {
      view.startMarking((rect) => {
        this.cancelMarking();
        this.render();
        done(rect ? view : null, rect);
      });
    }
    this.render();
  }

  /** The tools for the whole page and for the chosen sentences. Returns true if op is one of them. */
  bulkTool(op, btn) {
    const chosen = this.checkedByView();
    const count = chosen.reduce((n, x) => n + x.list.length, 0);
    switch (op) {
      case 'order-areas':
        if (this.ordering) { this.stopOrdering(); this.render(); } else this.startOrdering();
        return true;
      case 'order-apply':
        this.applyOrdering();
        return true;
      case 'order-back': // take back the last area drawn
      case 'ocr-back': {
        const o = op === 'ocr-back' ? this.readingAreas : this.ordering;
        if (o?.areas.length) {
          o.areas.pop();
          if (!o.areas.length && !o.base) o.view = null;
          this.waitForArea(o);
          this.render();
        }
        return true;
      }
      case 'order-cancel':
        this.stopOrdering();
        this.render();
        return true;
      case 'ocr-read':
        this.readDrawnAreas();
        return true;
      case 'ocr-more':
        this.drawMoreAreas();
        return true;
      case 'ocr-cancel': { // (drawing more areas: back to the review)
        const base = this.readingAreas?.base;
        this.cancelMarking();
        if (base) this.ocrPreview = base;
        this.render();
        return true;
      }
      case 'ocr-type': { // the review of an area: a sentence typed by hand (in that area)
        const list = (btn?.closest('.ocr-area') || this.box).querySelector('.ocr-preview-rows');
        if (!list) return true;
        const text = el('textarea', { rows: 2, 'aria-label': 'Type the sentence', spellcheck: 'true', placeholder: 'Type the sentence (Chinese or English)…' });
        list.append(el('label', { class: 'ocr-preview-line', dataset: { typed: 1 } }, el('input', { type: 'checkbox', checked: true, 'aria-label': 'Use this sentence' }), text));
        text.focus();
        return true;
      }
      case 'read-page':
        this.readWholePage();
        return true;
      case 'check-area':
        this.commitText();
        if (this.boxing?.op === op) { this.cancelMarking(); this.render(); return true; } // pressed again: cancel
        this.drawBox(op, 'Drag a box around existing sentence entries to select them. This does not read text. To recognize missing words, use “Re-read text by area.” Esc cancels.',
          (view, rect) => { if (view) this.checkArea(view, rect); });
        return true;
      case 'buttons': // the page's play buttons moved, taken away, put by hand (js/playbuttons.js)
        this.commitText();
        if (this.playButtons) { this.playButtons.stop(); this.playButtons = null; } else {
          this.cancelMarking();
          this.stopOrdering();
          this.playButtons = new PlayButtons(this);
        }
        this.render();
        return true;
      case 'picture': // a picture of the page replaced (js/pictures.js): its box first
        this.commitText();
        if (this.boxing?.op === op) { this.cancelMarking(); this.render(); return true; } // pressed again: cancel
        this.drawBox(op, 'Drag a box around the picture to replace. Esc cancels.',
          (view, rect) => { if (view) replacePicture(this.app, view, rect); });
        return true;
      case 'check-all':
        for (const view of this.app.views) view.doc?.sent.forEach((_, s) => this.checkSet(view).add(s));
        this.render();
        return true;
      case 'check-none':
        this.checked.clear();
        this.lastChecked = null;
        this.render();
        return true;
      case 'delete-checked':
      case 'move-checked': {
        if (!count) return true;
        this.commitText();
        if (op === 'delete-checked') {
          for (const { view, list } of chosen) this.run('deleteMany', list, { view, bi: list[0].bi, si: list[0].si });
          toast(`${count} sentence${count === 1 ? '' : 's'} deleted. Ctrl+Z (or Undo) brings ${count === 1 ? 'it' : 'them'} back.`);
        } else {
          const s = this.sel;
          const set = s && this.checked.get(s.view);
          if (!s || chosen.length > 1 || chosen[0].view !== s.view || set.has(this.flatIndex(s))) {
            toast('Click the sentence to put them after (not one of the chosen ones), then press Move.');
            return true;
          }
          this.run('moveMany', chosen[0].list, s);
        }
        return true;
      }
      case 'merge-selected': {
        if (count < 2) { toast('Choose at least two sentences to merge.'); return true; }
        if (chosen.length !== 1) { toast('Choose sentences from one page at a time.'); return true; }
        this.commitText();
        const { view, list } = chosen[0];
        this.run('mergeMany', list, { view, ...list[0] });
        toast(`Merged ${count} selected sentences in page order.`);
        return true;
      }
      default:
        return false;
    }
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
    this.mergeSequence = null;
    if (this.inline) return;
    this.cancelMarking();
    const has = (v) => v && this.history.get(this.key(v))?.length;
    const view = [this.sel?.view, this.lastView, ...this.app.views].find((v) => this.app.views.includes(v) && has(v));
    if (!view) { toast('Nothing to undo on this page.'); return; }
    const entry = this.history.get(this.key(view)).pop();
    view.applyDoc(JSON.parse(entry.doc), true);
    this.checked.clear();
    this.lastChecked = null;
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
    const text = { reading: this.readingNote || 'Reading selected area…', 'reading-page': 'Reading the page again…', saving: 'Saving…', saved: 'Saved', restored: 'Original text restored', error: 'Not saved: is the app window still open?' }[this.status] || '';
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
    if (this.moveByClick) {
      const source = { view: this.app.views[Number(row.dataset.v)], bi: Number(row.dataset.b), si: Number(row.dataset.s) };
      this.moveSequence(source);
      return;
    }
    if (this.mergeSequence) {
      const source = { view: this.app.views[Number(row.dataset.v)], bi: Number(row.dataset.b), si: Number(row.dataset.s) };
      this.mergeSequenceClick(source);
      return;
    }
    if (e.target.closest('.echk')) { // its box: choose it (Shift: everything from the one chosen last)
      e.preventDefault(); // (the list is drawn again with the new state)
      const view = this.app.views[Number(row.dataset.v)];
      this.toggleCheck(view, view.doc.blocks[Number(row.dataset.b)][0] + Number(row.dataset.s), e.shiftKey);
      return;
    }
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
    const shown = this.box.querySelector('.ocr-preview');
    if (this.ocrPreview && shown?.preview === this.ocrPreview) this.ocrPreview.restore = this.reviewState(shown); // (drawn again: as it was)
    this.playButtons?.attach(); // (the page turned: its buttons too)
    this.playButtons?.draw(); // (under the tools at the top: always in sight)
    const out = this.ordering ? [this.renderOrdering()] : this.readingAreas ? [this.renderReadingAreas()] : [el('p', { class: `edit-hint${this.boxing || this.marking || this.moveByClick || this.mergeSequence ? ' now' : ''}` }, this.mergeSequence
      ? `Merge order: ${this.mergeSequence.list.map((p) => this.flatIndex({ view: this.mergeSequence.view, ...p }) + 1).join(' → ')}. Click sentences to add them in order, then click Finish merge. Esc cancels.` : this.moveByClick
      ? 'Click sentences in the order you want them placed after the reference. Each moves after the previous one; Esc ends the sequence.' : this.boxing ? this.boxing.hint : this.marking
      ? 'Drag a box on the page around the selected sentence. Esc cancels.'
      : 'Click a sentence (here or on the page), then use the buttons above. Double-click a sentence (or press Enter) to change its text; drag it by its number to move it, '
        + 'or the handles of its frame on the page to change its place. Tick the boxes (or Ctrl+click on the page) to choose several sentences. '
        + 'Missing or wrong text: re-read an area, or the whole page. Sentences in the wrong order: “Order by areas”. Changes are saved automatically.')];
    if (this.pageRead || this.ocrPreview) {
      out.push(this.pageRead ? this.renderPageRead() : this.renderOcrPreview());
      this.box.replaceChildren(...out);
      this.box.querySelectorAll('textarea').forEach(autosize);
      this.updateStatus();
      this.updateTools();
      this.updateBulk();
      this.showOutlines();
      // Bring the OCR result into view and put the caret in its first editable line.
      // The review can be below the editor instructions, so resetting the panel to the top
      // leaves the useful controls hidden on shorter screens. The review of areas, taller than
      // the panel: down to its buttons (Add selected sentences), to use it when it is checked.
      requestAnimationFrame(() => {
        const review = this.box.querySelector('.ocr-preview');
        const input = review?.querySelector('.ocr-preview-line:not(.was-deleted) textarea') || review?.querySelector('textarea');
        if (!review || !(this.pageRead || input && this.ocrPreview)) return;
        const body = this.box.closest('.tab-body');
        const bar = body?.querySelector('.panel-actions:not([hidden])'); // (it stays at the top)
        review.style.scrollMarginTop = `${(bar?.offsetHeight || 0) + 8}px`;
        const actions = !this.pageRead && !this.ocrPreview.whole && review.querySelector('.ocr-preview-actions');
        if (actions && body && review.offsetHeight > body.clientHeight - (bar?.offsetHeight || 0) - 16) {
          actions.style.scrollMarginBottom = '24px';
          actions.scrollIntoView({ block: 'end' });
          return; // (no caret in a line out of view)
        }
        review.scrollIntoView({ block: 'start' });
        if (!input) return;
        input.focus({ preventScroll: true });
        input.setSelectionRange(input.value.length, input.value.length);
      });
      return;
    }
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
    if (this.ordering || this.readingAreas) this.box.closest('.tab-body').scrollTop = 0; // its panel is at the top of the list: in view
    this.box.querySelectorAll('textarea').forEach(autosize);
    const ta = this.box.querySelector('.eadd textarea') || (this.editingText && this.box.querySelector('.esent.sel textarea'));
    if (ta) {
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
    this.updateStatus();
    this.updateTools();
    this.updateBulk();
    this.showOutlines();
  }

  /** On the pages: every sentence outlined with its number; the selected and the chosen ones stand out. */
  showOutlines() {
    const inAreas = this.ordering ? this.orderingPreview().inAreas : null;
    if (!this.ordering && !this.readingAreas) { // (the areas being reviewed: numbered on the page as drawn)
      const shown = this.ocrPreview?.areas?.length > 1 ? this.ocrPreview : null;
      for (const view of this.app.views) view.showAreas(shown?.view === view ? shown.areas.map((a) => a.rect) : []);
    }
    for (const view of this.app.views) {
      if (!view.text) { view.showOutlines([]); view.showFrame(null); continue; }
      const set = inAreas ? (this.ordering.view === view ? inAreas : null) : this.checked.get(view);
      const selected = this.sel?.view === view && view.doc?.blocks[this.sel.bi] ? this.flatIndex(this.sel) : -1;
      view.showOutlines(view.doc.sent.map(([a, b], s) => ({
        rects: view.text.rects(a, b, 0.08), n: s + 1, cls: `o${s === selected ? ' sel' : ''}${set?.has(s) ? ' chk' : ''}${this.mergeSequence?.view === view && this.mergeSequence.list.some((p) => view.doc.blocks[p.bi]?.[0] + p.si === s) ? ' merge-picked' : ''}`,
      })));
      // The frame: drag its handles to change the size and place of the sentence on the page.
      const words = selected >= 0 ? view.doc.words.slice(...view.doc.sent[selected]).filter((w) => w[2] > 0 || w[3] > 0) : [];
      if (!words.length || this.ordering || this.readingAreas || this.boxing || this.marking || this.ocrPreview || this.pageRead || this.splitting) {
        view.showFrame(null); // (splitting: its new sentences shown instead, in their colors)
        continue;
      }
      const x = Math.min(...words.map((w) => w[0])), y = Math.min(...words.map((w) => w[1]));
      const from = { x, y, w: Math.max(...words.map((w) => w[0] + w[2])) - x, h: Math.max(...words.map((w) => w[1] + w[3])) - y };
      const sel = this.sel;
      view.showFrame(from, (to) => { this.run('fit', { from, to }, sel); this.readFrame(view, to); });
    }
    this.showFound();
  }

  /** The bar for the whole page and the chosen sentences. */
  updateBulk() {
    const n = this.checkedByView().reduce((k, x) => k + x.list.length, 0);
    $('#bulk-count').textContent = n ? `${n} chosen:` : '';
    const off = { 'delete-checked': !n, 'move-checked': !n || !this.sel, 'check-none': !n };
    for (const [op, disabled] of Object.entries(off)) $(`#edit-bulk [data-op="${op}"]`).disabled = disabled;
    const merge = $('#edit-bulk [data-op="merge-checked"]');
    const mergeOrder = this.mergeSequence?.list || [];
    merge.disabled = this.mergeSequence ? mergeOrder.length < 2 : !this.sel;
    merge.setAttribute('aria-pressed', String(!!this.mergeSequence));
    merge.innerHTML = `${icon('merge-down')}${this.mergeSequence ? `Finish merge (${mergeOrder.length})` : 'Merge in order'}`;
    merge.title = this.mergeSequence
      ? `Finish in this order: ${mergeOrder.map((p) => this.flatIndex({ view: this.mergeSequence.view, ...p }) + 1).join(' → ')}`
      : 'Use the selected sentence as the start, then click following sentences in the order they should be joined';
    const mergeSelected = $('#edit-bulk [data-op="merge-selected"]');
    mergeSelected.disabled = n < 2 || this.checkedByView().length !== 1;
    $$('#edit-bulk .bulk-chosen').forEach((x) => { x.hidden = !n; });
    $('#edit-bulk [data-op="check-area"]').setAttribute('aria-pressed', String(this.boxing?.op === 'check-area'));
    const picture = $('#edit-bulk [data-op="picture"]'); // (pictures: of the library's books, by their owner)
    picture.hidden = !(this.app.book?.library && this.app.book?.canEdit);
    picture.setAttribute('aria-pressed', String(this.boxing?.op === 'picture'));
    const buttons = $('#edit-bulk [data-op="buttons"]'); // (play buttons: of the library's books, by their owner)
    buttons.hidden = picture.hidden;
    buttons.setAttribute('aria-pressed', String(!!this.playButtons));
    $('#edit-bulk [data-op="order-areas"]').setAttribute('aria-pressed', String(!!this.ordering));
    $$('[data-op="ocr"]').forEach((b) => b.setAttribute('aria-pressed', String(!!this.readingAreas)));
  }

  renderOcrPreview() {
    const { there, view, sel, read, reads, whole, frame, areas, restore } = this.ocrPreview;
    // (The whole page: without what was read in the places of the corrected sentences. A sentence's frame: one sentence.)
    const sentences = this.ocrSentences(this.ocrPreview);
    // Each sentence with its number and color, as it is outlined on the page (showFound); what
    // was ticked or changed in the review before (restore) stays.
    const rows = sentences.map(({ words, deleted }, i) => {
      const was = restore?.rows.get(i);
      const check = el('input', { type: 'checkbox', checked: was ? was.on : !deleted, 'aria-label': `Include recognized sentence ${i + 1}` });
      const text = el('textarea', { rows: 2, 'aria-label': `Edit recognized sentence ${i + 1}`, spellcheck: 'true' });
      text.value = was ? was.text : sentenceText(words);
      return el('label', { class: `ocr-preview-line${deleted ? ' was-deleted' : ''}${check.checked ? '' : ' off'}`, dataset: { k: i } }, check,
        el('span', { class: `ocr-n${whole ? ' plain' : ''}`, style: whole ? '' : `--c: ${FOUND_COLORS[i % FOUND_COLORS.length]}` }, String(i + 1)), text,
        deleted ? el('span', { class: 'ocr-note' }, 'You deleted the text here before: tick it to bring it back.') : null);
    });
    const typedRow = (was = null) => {
      const text = el('textarea', { rows: 2, 'aria-label': 'Type the sentence', spellcheck: 'true', placeholder: 'Type the sentence (Chinese or English)…' });
      text.value = was?.text || '';
      return el('label', { class: 'ocr-preview-line', dataset: { typed: 1 } }, el('input', { type: 'checkbox', checked: was ? was.on : true, 'aria-label': 'Use this sentence' }),
        el('span', { class: 'ocr-n plain' }), text);
    };
    if (!rows.length && whole) rows.push(typedRow()); // nothing found: type the text yourself
    // Which languages to read (read again when changed).
    const language = el('select', { class: 'select' }, ...(reads || []).map(([v, label]) => el('option', { value: v, selected: v === read }, label)));
    language.addEventListener('change', () => (whole ? this.readWholePage(language.value) : this.readAreas(view, areas.map((a) => a.rect), sel, language.value, frame)));
    // Replace the text (what was read wrongly) or add to it (what was missed).
    const replace = el('input', { type: 'checkbox', class: 'ocr-replace', checked: restore?.replace ?? (there > 0 || !!whole || !!frame) });
    const n = (k, one) => `${k} ${one}${k === 1 ? '' : 's'}`;
    if (frame) { // a sentence's new frame: its text there, or the one it has
      const section = el('section', { class: 'ocr-preview' },
        el('h4', {}, `Sentence ${frame.n} read again in its new size`),
        reads?.length > 1 ? el('label', { class: 'field' }, el('span', {}, 'Read in the frame'), language) : null,
        el('p', { class: 'ocr-now' }, el('b', {}, 'Now: '), frame.now),
        el('p', { class: 'edit-hint' }, 'Below: what is in its frame on the page now. Correct it if needed, then use it: it takes the place of the '
          + 'sentence’s text, and of other words inside the frame (they become part of it).'),
        el('div', { class: 'ocr-preview-rows' }, ...rows),
        el('label', { class: 'check ocr-replace-row', hidden: true }, replace),
        el('div', { class: 'ocr-preview-actions' },
          el('button', { class: 'btn primary', type: 'button', onclick: () => this.acceptOcrPreview(section) }, 'Use the new text'),
          el('button', { class: 'btn', type: 'button', onclick: () => { this.ocrPreview = null; this.render(); } }, 'Keep the text as it is')));
      return section;
    }
    // The areas: what was found in each (numbered as on the page), to replace its text or add to it.
    const parts = whole ? [] : areas.map((a, k) => {
      const own = rows.filter((_, i) => sentences[i].area === k);
      const typed = (restore?.areas[k]?.typed || []).map((t) => typedRow(t));
      return el('div', { class: 'ocr-area', dataset: { area: k } },
        areas.length > 1 ? el('h5', {}, `Area ${k + 1}: ${n(own.length, 'sentence')}`) : null,
        el('div', { class: 'ocr-preview-rows' }, ...(own.length || typed.length ? [...own, ...typed] : [typedRow()])),
        el('button', { class: 'link-btn', type: 'button', dataset: { op: 'ocr-type' } }, '+ Type a sentence yourself'),
        el('label', { class: 'check ocr-replace-row' }, el('input', { type: 'checkbox', class: 'ocr-replace', checked: restore?.areas[k]?.replace ?? a.there > 0 }),
          ` Replace the text in this area${a.there ? ` (${n(a.there, 'word')} now)` : ' (there is none)'}`));
    });
    const section = el('section', { class: 'ocr-preview' },
      el('h4', {}, whole ? `Review the text read again on page ${view.page.n} (${n(sentences.length, 'sentence')})`
        : areas.length > 1 ? `Review the text found in ${areas.length} areas (${n(sentences.length, 'sentence')})`
          : `Review text found in the selected area (${sentences.length} sentences)`),
      reads?.length > 1 ? el('label', { class: 'field' }, el('span', {}, whole ? 'Read on the page' : areas.length > 1 ? 'Read in the areas' : 'Read in the area'), language) : null,
      whole?.kept.length ? el('details', { class: 'ocr-kept' },
        el('summary', {}, `Your corrections stay as they are: ${n(whole.kept.length, 'sentence')}`),
        el('ol', {}, ...whole.kept.map((t) => el('li', {}, t)))) : null,
      el('p', { class: 'edit-hint' }, 'Uncheck anything you do not want (pinyin, page numbers…). You can edit the text now or later, or type a sentence yourself. '
        + (whole ? 'Replacing: they take the place of the page’s text you did not correct; your corrected sentences keep their places among them. Adding: they are inserted after the current selection.'
          : `Each sentence found is outlined on the page in its color, with its number (unticked: grey). Text the boxes missed: “Draw more areas”, then read them; all of it is added together. Replacing: they take the place of the text in the area. Adding: the text in the area stays. Either way they go where they are on the page, and the sentences are numbered again in that order.${
            areas.length > 1 ? ' The areas are numbered on the page as you drew them.' : ''}`)),
      ...(whole ? [el('div', { class: 'ocr-preview-rows' }, ...rows),
        el('button', { class: 'link-btn', type: 'button', dataset: { op: 'ocr-type' } }, '+ Type a sentence yourself'),
        el('label', { class: 'check ocr-replace-row' }, replace, ` Replace the text you did not correct${there ? ` (${n(there, 'word')} now)` : ' (there is none)'}`)] : parts),
      el('div', { class: 'ocr-preview-actions' },
        el('button', { class: 'btn primary', type: 'button', onclick: () => this.acceptOcrPreview(section) }, 'Add selected sentences'),
        whole ? null : el('button', { class: 'btn', type: 'button', dataset: { op: 'ocr-more' } }, '+ Draw more areas'),
        el('button', { class: 'btn', type: 'button', onclick: () => { this.ocrPreview = null; this.render(); } }, 'Cancel')));
    // Ticking and pointing at a sentence: shown on the page at once.
    const row = (e) => e.target.closest?.('.ocr-preview-line[data-k]');
    section.addEventListener('change', (e) => {
      const r = row(e);
      if (r) { r.classList.toggle('off', !r.querySelector('input').checked); this.showFound(); }
    });
    for (const [type, on] of [['pointerover', true], ['focusin', true], ['pointerout', false], ['focusout', false]]) {
      section.addEventListener(type, (e) => {
        const r = row(e), k = r && on ? Number(r.dataset.k) : null;
        if (k !== this.hotFound) { this.hotFound = k; this.showFound(); }
      });
    }
    section.preview = this.ocrPreview; // (what it shows: its state is kept when it is drawn again)
    return section;
  }

  /** What the review (section) shows now: [ticked, text] of each sentence, the areas' choices and sentences typed in. */
  reviewState(section) {
    const line = (r) => ({ on: r.querySelector('input').checked, text: r.querySelector('textarea').value });
    return {
      rows: new Map([...section.querySelectorAll('.ocr-preview-line[data-k]')].map((r) => [Number(r.dataset.k), line(r)])),
      areas: [...section.querySelectorAll('.ocr-area')].map((a) => ({ replace: a.querySelector('.ocr-replace').checked,
        typed: [...a.querySelectorAll('.ocr-preview-line[data-typed]')].map(line).filter((t) => t.text.trim()) })),
      replace: section.querySelector('.ocr-replace')?.checked,
    };
  }

  /**
   * On the page, while text read again from areas is reviewed (also while more areas are drawn):
   * each sentence found outlined in its color with its number in the review; unticked: grey.
   */
  showFound() {
    const p = this.ocrPreview || this.readingAreas?.base;
    const list = p && !p.whole ? this.ocrSentences(p) : [];
    const rows = this.box.querySelectorAll('.ocr-preview-line[data-k]');
    const on = rows.length ? new Map([...rows].map((r) => [Number(r.dataset.k), r.querySelector('input').checked]))
      : new Map([...(p?.restore?.rows || [])].map(([k, r]) => [k, r.on]));
    // Splitting a sentence: the sentences it will be, numbered as they will be.
    const split = !p && this.splitting && this.sel?.view.doc?.blocks[this.sel.bi] ? this.sel : null;
    const pieces = split ? cutAt(this.selWords(), this.splitStarts || new Set()) : [];
    for (const view of this.app.views) {
      view.showFound(p?.view === view ? list.map(({ words }, k) => ({ rects: lineBoxes(words), n: k + 1, color: FOUND_COLORS[k % FOUND_COLORS.length],
        off: on.get(k) === false, hot: this.hotFound === k }))
        : split?.view === view ? pieces.map((words, k) => ({ rects: lineBoxes(words), n: this.flatIndex(split) + 1 + k, color: FOUND_COLORS[k % FOUND_COLORS.length] }))
          : []);
    }
  }

  acceptOcrPreview(section) {
    const pending = this.ocrPreview;
    if (!pending) return;
    const { whole, frame } = pending;
    const sentences = this.ocrSentences(pending);
    const s = (k) => (k === 1 ? '' : 's');
    // The sentences ticked in a part of the review (the page, or an area), with their paragraphs as read.
    const take = (part) => {
      const chosen = [], typed = [], blocks = [];
      part.querySelectorAll('.ocr-preview-line').forEach((row) => {
        if (!row.querySelector('input').checked) return;
        const text = row.querySelector('textarea').value.trim();
        if (!text) return;
        if (row.dataset.typed) { typed.push(text); return; }
        const found = sentences[Number(row.dataset.k)];
        const model = [[found.words.map((w) => ({ ...w, box: w.box && [...w.box] }))]];
        OPS.text(model, 0, 0, text);
        if (model[0]?.[0]?.length) { chosen.push(model[0][0]); blocks.push(found.block); }
      });
      return { chosen, typed, blocks };
    };
    this.ocrPreview = null;
    if (whole) {
      const { chosen, typed, blocks } = take(section);
      // (Sentences typed by hand: a paragraph at its end, not marked on the page.)
      chosen.push(...typed.map((text) => tokenize(text).map(({ t, sp }) => ({ t, box: null, line: -1, sp }))));
      if (section.querySelector('.ocr-replace').checked) {
        const list = chosen.map((words, k) => ({ words, block: blocks[k] ?? -1, first: k === 0 || blocks[k] !== blocks[k - 1] }));
        this.run('rereadPage', { original: whole.original, sentences: list }, { view: pending.view, bi: 0, si: 0 });
        toast(`The page was read again: ${chosen.length} sentence${s(chosen.length)} in the place of the text you did not correct`
          + `${whole.kept.length ? `, your ${whole.kept.length} corrected sentence${s(whole.kept.length)} kept` : ''}. Ctrl+Z (or Undo) takes it back.`);
        return;
      }
      if (!chosen.length) { this.render(); toast('Select or enter at least one sentence to add.'); return; }
      this.run('ocr', toDoc([chosen]), pending.sel);
      toast(`Added ${chosen.length} sentence${s(chosen.length)}. You can still edit, delete, or reorder them.`);
      return;
    }
    // Each area: its paragraphs as read (sentences typed by hand go in the area, one under the
    // other, in its last paragraph), replacing its text or added to it.
    const lineH = lineHeight(pending.view.doc);
    const list = (frame ? [section] : [...section.querySelectorAll('.ocr-area')]).map((part, k) => {
      const { chosen, typed, blocks } = take(part);
      const { rect } = pending.areas[k];
      if (typed.length) chosen.push(...layoutTyped(typed, rect, lineH));
      const paras = [];
      chosen.forEach((x, i) => (i && (blocks[i] === undefined || blocks[i] === blocks[i - 1]) ? paras[paras.length - 1].push(x) : paras.push([x])));
      return { rect, blocks: paras, keep: !part.querySelector('.ocr-replace').checked, n: chosen.length };
    });
    if (frame) {
      if (!list[0].n) { this.render(); toast(`Sentence ${frame.n} keeps its text.`); return; }
      this.run('replaceArea', list[0], { view: pending.view, bi: 0, si: 0 });
      toast(`Sentence ${frame.n} now has the text of its new size. Ctrl+Z (or Undo) takes it back.`);
      return;
    }
    const todo = list.filter((a) => a.n || !a.keep); // (an area with nothing to add stays as it is)
    if (!todo.length) { this.render(); toast('Select or enter at least one sentence to add.'); return; }
    this.run('replaceAreas', { areas: todo }, { view: pending.view, bi: 0, si: 0 });
    const n = todo.reduce((k, a) => k + a.n, 0), replaced = todo.filter((a) => !a.keep).length;
    toast(list.length > 1
      ? `${n} sentence${s(n)} from ${todo.length} area${s(todo.length)}, each where it is on the page${replaced ? ` (the text replaced in ${replaced})` : ''}. Ctrl+Z (or Undo) takes it all back.`
      : todo[0].keep ? `Added ${n} sentence${s(n)} where ${n === 1 ? 'it is' : 'they are'} on the page. Ctrl+Z (or Undo) takes it back.`
        : n ? `The text of the area was replaced (${n} sentence${s(n)}), in its place among the others. Ctrl+Z (or Undo) takes it back.`
          : 'The text in the area was removed. Ctrl+Z (or Undo) brings it back.');
  }

  /** The buttons at the top: only those that make sense for the selected sentence can be used. */
  updateTools() {
    const s = this.sel?.view.doc ? this.sel : null;
    const blocks = s ? s.view.doc.blocks : [];
    const first = !s || (s.bi === 0 && s.si === 0);
    const last = !s || (s.bi === blocks.length - 1 && s.si === blocks[s.bi][1] - blocks[s.bi][0] - 1);
    const [a, b] = s ? s.view.doc.sent[this.flatIndex(s)] : [0, 0];
    const off = { edit: !s, split: b - a < 2, mergePrev: first, mergeNext: last, up: first, down: last, paragraph: first, mark: !s, ocr: false, add: !s, delete: !s, 'move-click': !s };
    for (const btn of $$('#edit-tools [data-op]')) btn.disabled = !!off[btn.dataset.op];
    const press = { edit: this.editingText, split: this.splitting, mark: !!this.marking, add: !!this.adding && this.adding.bi >= 0, 'move-click': !!this.moveByClick };
    for (const [op, on] of Object.entries(press)) $(`#edit-tools [data-op="${op}"]`).setAttribute('aria-pressed', String(!!on));
    const para = $('#edit-tools [data-op="paragraph"]'), join = s && s.si === 0;
    para.title = join ? 'Join this paragraph to the one above' : 'New paragraph from this sentence';
    para.setAttribute('aria-label', join ? 'Join paragraph' : 'New paragraph');
    $('#edit-sel').textContent = s ? `${this.app.views.length > 1 ? `p.${s.view.page.n} · ` : ''}sentence ${this.flatIndex(s) + 1}` : 'click a sentence';
  }

  renderSentence({ vi, bi, si, words, num, isSel }) {
    const placed = words.some((w) => w.box);
    const checked = !!this.checked.get(this.app.views[vi])?.has(num - 1);
    const inMerge = this.mergeSequence?.view === this.app.views[vi]
      ? this.mergeSequence.list.findIndex((p) => p.bi === bi && p.si === si) : -1;
    const row = el('div', { class: `esent${isSel ? ' sel' : ''}${checked ? ' chk' : ''}${inMerge >= 0 ? ' merge-picked' : ''}`, dataset: { v: vi, b: bi, s: si } },
      el('input', { type: 'checkbox', class: 'echk', checked, 'aria-label': `Choose sentence ${num}`, title: 'Choose this sentence (Shift: all from the one chosen last)' }),
      el('span', { class: 'enum handle', title: 'Drag to move this sentence', html: `<span class="num">${num}</span>${inMerge >= 0 ? `<span class="merge-order" title="Merge position ${inMerge + 1}">${inMerge + 1}</span>` : ''}${icon('grip')}` }));
    // Every sentence is shown as it is; the selected one turns into a box only to split it or change its text.
    if (!isSel || (!this.splitting && !this.editingText)) {
      row.append(el('span', { class: 'etext' }, sentenceText(words),
        placed ? null : el('span', { class: 'nobox', title: 'Not marked on the page yet' }, 'not on page')));
      return row;
    }
    const body = el('div', { class: 'ebody' });
    if (this.splitting) {
      // Each word marked starts a new sentence (the words after 。？！ to begin with); each new
      // sentence in its color, here and on the page (showFound), with the number it will have.
      const starts = this.splitStarts || new Set(), pieces = cutAt(words, starts);
      const color = (i) => FOUND_COLORS[i % FOUND_COLORS.length];
      let piece = 0;
      body.append(
        el('div', { class: 'ehint' }, 'Click the word that starts each new sentence, here or on the page (again: not any more). '
          + 'The words after 。？！ . ? ! are marked to begin with.'),
        el('div', { class: 'chips split-chips' }, ...words.map((w, k) => {
          if (starts.has(k) && k > 0) piece++;
          return el('button', { class: `chip${starts.has(k) && k > 0 ? ' start' : ''}`, disabled: k === 0, style: `--c: ${color(piece)}`,
            'aria-pressed': String(starts.has(k)), title: k ? 'Starts a new sentence (click again: not any more)' : 'The sentence starts here', dataset: { op: 'split-at', k } }, w.t);
        })),
        el('ol', { class: 'split-pieces', start: num }, ...pieces.map((p, i) => el('li', { style: `--c: ${color(i)}` }, sentenceText(p)))),
        el('div', { class: 'etools' },
          el('button', { class: 'tbtn primary', disabled: pieces.length < 2, dataset: { op: 'split-apply' } },
            pieces.length < 2 ? 'Split' : `Split into ${pieces.length} sentences`),
          el('button', { class: 'tbtn', disabled: !starts.size, dataset: { op: 'split-clear' } }, 'Clear the marks'),
          el('button', { class: 'tbtn', dataset: { op: 'split-cancel' } }, 'Cancel')));
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

// Clause splitting and the words of typed text in the browser, used after text corrections.
// Same rules as split_clauses() and cjk_words() in web/tools/segment_text.py — keep them in step.

const CLAUSE_END = /[,;:，、；：]["'”’)\]）」』]*$|[—–]$/;
// Chinese (Japanese, Korean) characters, and their full-width punctuation.
const CJK_CHARS = '぀-ヿ㐀-䶿一-鿿豈-﫿가-힯';
const CJK = new RegExp(`[${CJK_CHARS}]`, 'u');
const CJK_OPEN = '（《〈「『【', CJK_CLOSE = '。，、；：！？）》〉」』】';
// One character with the brackets before it and the punctuation after it, a run of other
// letters (pinyin, English), or punctuation alone.
const CJK_PIECE = new RegExp(`[${CJK_OPEN}]*(?:[${CJK_CHARS}]|[^${CJK_OPEN}${CJK_CLOSE}${CJK_CHARS}]+)[${CJK_CLOSE}]*`
  + `|[${CJK_OPEN}${CJK_CLOSE}]+`, 'gu');
const cjkEdge = (ch) => !!ch && (CJK.test(ch) || CJK_OPEN.includes(ch) || CJK_CLOSE.includes(ch));

/** Does text contain Chinese (Japanese, Korean) characters? */
export const hasCJK = (text) => CJK.test(text);

/**
 * The words of typed text, [{t, sp}] (sp: a space after it): split at spaces, and Chinese one
 * word per character with its punctuation, without spaces between them, like the pages.
 */
export function tokenize(text) {
  const out = [];
  for (const chunk of String(text).split(/\s+/).filter(Boolean)) {
    const pieces = CJK.test(chunk) || [...chunk].every(cjkEdge) ? chunk.match(CJK_PIECE) : [chunk];
    pieces.forEach((t, k) => {
      const prev = out[out.length - 1];
      const punct = [...t].every((ch) => CJK_CLOSE.includes(ch) || CJK_OPEN.includes(ch));
      if (punct && prev && CJK_CLOSE.includes(t[0])) { prev.t += t; return; } // "人" + "。" -> "人。"
      if (prev && [...prev.t].every((ch) => CJK_OPEN.includes(ch))) { prev.t += t; prev.sp = 1; return; } // "（" + "你"
      if (prev && k > 0) prev.sp = 0; // typed together
      out.push({ t, sp: 1 });
    });
  }
  out.forEach((w, k) => { // no spaces in Chinese, even if they were typed
    const next = out[k + 1];
    if (next && cjkEdge(w.t.at(-1)) && cjkEdge(next.t[0])) w.sp = 0;
  });
  return out;
}
const DASHES = new Set(['-', '—', '–']);
// Words that usually start a new clause. Coordinators need longer pieces on
// both sides so "Rutledge and Adam" is not split.
const SUBORDINATORS = new Set(('because although though while whereas unless until if when whenever ' +
  'where wherever since which who whom whose before after').split(' '));
const COORDINATORS = new Set(['and', 'but', 'or', 'so', 'yet']);

const isBreak = (tok) => CLAUSE_END.test(tok) || DASHES.has(tok);

/** Clause ranges [start, end) for the tokens of one sentence. */
export function clauseRanges(tokens) {
  const n = tokens.length;
  if (!n) return [];
  // Words from i up to and including the next comma/colon/dash (or sentence end).
  const run = new Array(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) run[i] = isBreak(tokens[i]) || i === n - 1 ? 1 : 1 + run[i + 1];

  const cuts = [0];
  for (let i = 1; i < n; i++) {
    const prev = tokens[i - 1];
    const cur = tokens[i].toLowerCase().replace(/^["'“‘(]+|["'“‘(]+$/g, '');
    const before = i - cuts[cuts.length - 1], after = run[i];
    if (isBreak(prev)) cuts.push(i);
    else if (SUBORDINATORS.has(cur) && before >= 2 && after >= 2) cuts.push(i);
    else if (COORDINATORS.has(cur) && before >= 4 && after >= 4) cuts.push(i);
  }
  cuts.push(n);
  const ranges = [];
  for (let k = 0; k < cuts.length - 1; k++) if (cuts[k + 1] > cuts[k]) ranges.push([cuts[k], cuts[k + 1]]);
  // Fold one-word pieces ("However,") into the following clause.
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && last[1] - last[0] === 1) last[1] = r[1];
    else merged.push(r);
  }
  if (merged.length > 1 && merged[merged.length - 1][1] - merged[merged.length - 1][0] === 1) {
    const last = merged.pop();
    merged[merged.length - 1][1] = last[1];
  }
  return merged;
}

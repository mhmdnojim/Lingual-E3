// Clause splitting in the browser, used after text corrections.
// Same rules as split_clauses() in web/tools/segment_text.py — keep the two in step.

const CLAUSE_END = /[,;:]["'”’)\]]*$|[—–]$/;
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

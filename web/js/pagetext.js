// Model of one page's OCR text: words with boxes, grouped into sentences,
// clauses and blocks (see web/tools/segment_text.py for the file format).
// A word with width and height 0 has no place on the page image (e.g. text added by hand).

const X = 0, Y = 1, W = 2, H = 3, T = 4, LINE = 5, SPACE = 6;
const hasBox = (w) => w[W] > 0 || w[H] > 0;

export class PageText {
  constructor(doc) {
    this.words = doc.words;
    this.sent = doc.sent;
    this.clause = doc.clause;
    this.blocks = doc.blocks;
    const n = this.words.length;
    this.w2s = new Int32Array(n).fill(-1);
    this.w2c = new Int32Array(n).fill(-1);
    this.sent.forEach(([a, b], i) => { for (let w = a; w < b; w++) this.w2s[w] = i; });
    this.clause.forEach(([a, b], i) => { for (let w = a; w < b; w++) this.w2c[w] = i; });
  }

  get empty() { return this.words.length === 0; }

  /** The sentence / clause / word that contains word index w. */
  unitAt(w, mode) {
    if (w < 0 || w >= this.words.length) return null;
    if (mode === 'word') return { mode, i: w, a: w, b: w + 1 };
    const table = mode === 'clause' ? this.clause : this.sent;
    const i = mode === 'clause' ? this.w2c[w] : this.w2s[w];
    if (i < 0) return null;
    return { mode, i, a: table[i][0], b: table[i][1] };
  }

  sentenceUnit(i) {
    const [a, b] = this.sent[i];
    return { mode: 'sentence', i, a, b };
  }

  /** Unit number i of a mode ('sentence' or 'clause'), and how many there are. */
  unit(mode, i) {
    const table = mode === 'clause' ? this.clause : this.sent;
    return table[i] ? { mode, i, a: table[i][0], b: table[i][1] } : null;
  }

  count(mode) { return (mode === 'clause' ? this.clause : this.sent).length; }

  text(a, b) {
    let s = '';
    for (let k = a; k < b; k++) s += this.words[k][T] + (this.words[k][SPACE] && k < b - 1 ? ' ' : '');
    return s.trim();
  }

  /** Readable page text: one paragraph per block. */
  fullText() {
    return this.blocks
      .map(([sa, sb]) => {
        const parts = [];
        for (let i = sa; i < sb; i++) parts.push(this.text(...this.sent[i]));
        return parts.join(' ');
      })
      .join('\n');
  }

  /** Text for the speech engine plus where each word starts, for word highlighting. */
  speech(a, b) {
    let text = '';
    const starts = [];
    for (let k = a; k < b; k++) {
      const spoken = speakable(this.words[k][T]);
      starts.push({ w: k, at: text.length });
      text += spoken;
      if (this.words[k][SPACE] && spoken) text += ' ';
    }
    return { text: text.replace(/\s+/g, ' ').trim(), starts };
  }

  wordAtChar(starts, charIndex) {
    let found = starts.length ? starts[0].w : -1;
    for (const s of starts) {
      if (s.at <= charIndex) found = s.w;
      else break;
    }
    return found;
  }

  /** One rectangle per text line covered by words a..b (page pixel units). */
  rects(a, b, pad = 0.18) {
    const out = [];
    let cur = null;
    for (let k = a; k < b; k++) {
      const w = this.words[k];
      if (!hasBox(w)) continue;
      if (!cur || cur.line !== w[LINE]) {
        cur = { line: w[LINE], x0: w[X], y0: w[Y], x1: w[X] + w[W], y1: w[Y] + w[H] };
        out.push(cur);
      } else {
        cur.x0 = Math.min(cur.x0, w[X]);
        cur.y0 = Math.min(cur.y0, w[Y]);
        cur.x1 = Math.max(cur.x1, w[X] + w[W]);
        cur.y1 = Math.max(cur.y1, w[Y] + w[H]);
      }
    }
    return out.map((r) => {
      const p = Math.max(3, (r.y1 - r.y0) * pad);
      return { x: r.x0 - p, y: r.y0 - p, w: r.x1 - r.x0 + 2 * p, h: r.y1 - r.y0 + 2 * p };
    });
  }

  /** Click targets: each word's box widened to meet its neighbours on the same line. */
  hitRects() {
    const ws = this.words;
    return ws.map((w, k) => {
      if (!hasBox(w)) return { x: 0, y: 0, w: 0, h: 0 };
      const prev = ws[k - 1], next = ws[k + 1];
      const padY = Math.max(4, w[H] * 0.22);
      let x0 = w[X] - 4, x1 = w[X] + w[W] + 4;
      if (prev && hasBox(prev) && prev[LINE] === w[LINE]) x0 = Math.min(x0, (prev[X] + prev[W] + w[X]) / 2);
      if (next && hasBox(next) && next[LINE] === w[LINE]) x1 = Math.max(x1, (w[X] + w[W] + next[X]) / 2);
      return { x: x0, y: w[Y] - padY, w: x1 - x0, h: w[H] + 2 * padY };
    });
  }

  /** Index of the first sentence whose text contains the query (case-insensitive). */
  findSentence(query) {
    const q = normalize(query);
    for (let i = 0; i < this.sent.length; i++) {
      if (normalize(this.text(...this.sent[i])).includes(q)) return i;
    }
    return -1;
  }
}

export function normalize(s) {
  return s.toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[—–]/g, '-').replace(/\s+/g, ' ');
}

export function speakable(t) {
  return t
    .replace(/[•·■●▪►]/g, '')
    // Exercise gap numbers glued to the next word: "2was", "14couldn't" (but not "21st", "10am").
    .replace(/^\d{1,2}(?=[a-z]{2})(?!(?:st|nd|rd|th|am|pm)\b)/, '')
    .replace(/^p\.(\d)/i, 'page $1')
    .replace(/^pp\.(\d)/i, 'pages $1')
    .replace(/[—–]/g, ', ')
    .replace(/^=$/, 'equals')
    .replace(/^[+/]$/, '')
    .trim();
}

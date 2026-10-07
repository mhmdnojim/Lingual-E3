// Full-text search over the OCR text of one book or all three.
import { $, el, escapeHtml, getJSON } from './util.js';

const MAX_RESULTS = 300;

// Same-length normalisation so match positions map back onto the original text.
function fold(s) {
  return s.toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[—–]/g, '-').replace(/\s/g, ' ');
}

export class Search {
  constructor(app) {
    this.app = app;
    this.input = $('#search-input');
    this.allBox = $('#search-all');
    this.list = $('#search-results');
    this.meta = $('#search-meta');
    this.runId = 0;
    let timer;
    this.input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.run(), 220);
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { clearTimeout(timer); this.run(true); }
      if (e.key === 'Escape') { this.input.value = ''; this.run(); this.input.blur(); }
    });
    this.allBox.addEventListener('change', () => this.run());
    this.showHint();
  }

  showHint() {
    this.meta.textContent = '';
    this.list.replaceChildren(el('li', { class: 'empty' }, 'Type in the search box at the top to find words or phrases in the book.'));
  }

  async run(openFirst = false) {
    const q = this.input.value.trim().replace(/\s+/g, ' ');
    const id = ++this.runId;
    if (q.length < 2) { this.showHint(); return; }
    this.app.showTab('search');
    const books = this.allBox.checked && this.app.book?.disc ? this.app.discList : [this.app.book];
    const needle = fold(q);
    const results = [];
    let total = 0;
    for (const book of books) {
      const pages = (await getJSON(`/api/search/${book.slug}`)) || []; // includes text corrections
      if (id !== this.runId) return;
      for (const p of pages) {
        const hay = fold(p.t);
        let at = hay.indexOf(needle);
        let first = -1, count = 0;
        while (at >= 0) {
          if (first < 0) first = at;
          count++;
          at = hay.indexOf(needle, at + needle.length);
        }
        if (!count) continue;
        total += count;
        if (results.length < MAX_RESULTS) results.push({ book, page: p.p, count, snippet: snippet(p.t, first, q.length) });
      }
    }
    this.meta.textContent = total ? `${total} match${total === 1 ? '' : 'es'} on ${results.length} page${results.length === 1 ? '' : 's'}` : '';
    if (!results.length) {
      this.list.replaceChildren(el('li', { class: 'empty' }, `No matches for “${q}”.`));
      return;
    }
    const multi = books.length > 1;
    this.list.replaceChildren(...results.map((r) => {
      const li = el('li', { tabindex: '0', html:
        `<div class="r-page">${multi ? escapeHtml(r.book.type) + ' · ' : ''}Page ${escapeHtml(r.page)}${r.count > 1 ? ` · ${r.count} matches` : ''}</div>` +
        `<div class="r-snip">${r.snippet}</div>` });
      const go = () => this.app.go(r.book.id, r.page, { find: q });
      li.addEventListener('click', go);
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      return li;
    }));
    if (openFirst) this.list.firstElementChild?.click();
  }
}

function snippet(text, at, len) {
  const start = Math.max(0, at - 60), end = Math.min(text.length, at + len + 80);
  const pre = (start > 0 ? '…' : '') + text.slice(start, at);
  const post = text.slice(at + len, end) + (end < text.length ? '…' : '');
  return `${escapeHtml(pre)}<mark>${escapeHtml(text.slice(at, at + len))}</mark>${escapeHtml(post)}`.replace(/\n/g, ' ');
}

// One rendered book page: the stitched page image, an SVG text layer with
// invisible word targets and highlight rectangles, and the hotspot buttons.
import { PageText } from './pagetext.js';
import { el, icon } from './util.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const HOTSPOT = {
  audio: { cls: 'hs-audio', icon: 'headphones' },
  video: { cls: 'hs-video', icon: 'video' },
  swf: { cls: 'hs-swf', icon: 'key' },
  link: { cls: 'hs-link', icon: 'arrow' },
};

function svg(tag, attrs = {}) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

export class PageView {
  /**
   * @param {object} book   a book from /api/books/<id>
   * @param {object} page   one of its pages: {n, path, w, h, img, thumb, a: hotspots (disc books)}
   * @param {object} hooks  {onHover(view, unit), onClick(view, unit, event), onHotspot(view, asset)}
   */
  constructor(book, page, hooks) {
    this.book = book;
    this.page = page;
    this.hooks = hooks;
    this.text = null;
    this.mode = 'sentence';

    // Page coordinates (word boxes, hotspots) are in pixels of the page image: w × h.
    this.W = page.w || 1984;
    this.H = page.h || 2496;
    this.el = el('div', { class: 'page', dataset: { page: page.n }, style: `aspect-ratio: ${this.W} / ${this.H}` });
    this.loading = el('div', { class: 'page-loading' }, 'Loading page…');
    this.img = el('img', {
      class: 'page-img', alt: `${book.type}, page ${page.n}`, decoding: 'async', draggable: 'false',
      src: page.img,
    });
    this.img.addEventListener('load', () => this.loading.remove());
    this.img.addEventListener('error', () => { this.loading.textContent = 'This page image is missing.'; });

    this.svg = svg('svg', { class: 'text-layer', viewBox: `0 0 ${this.W} ${this.H}`, preserveAspectRatio: 'none' });
    this.gPick = svg('g', { class: 'hl-pick' }); // sentences chosen for a new audio
    this.gActive = svg('g', { class: 'hl-active' });
    this.gWord = svg('g', { class: 'hl-word' });
    this.gFlash = svg('g', { class: 'hl-flash' });
    this.gHover = svg('g', { class: 'hl-hover' });
    this.gHits = svg('g', { class: 'hits' });
    this.gMark = svg('g', { class: 'mark' });
    this.svg.append(this.gPick, this.gActive, this.gWord, this.gFlash, this.gHover, this.gHits, this.gMark);

    this.hotspots = el('div', { class: 'hotspots' });
    this.recSpots = el('div', { class: 'rec-spots' }); // play buttons of "My audio" recordings
    this.el.append(this.loading, this.img, this.svg, this.hotspots, this.recSpots, el('div', { class: 'page-num' }, `Page ${page.n}`));
    if (page.blank) {
      this.el.append(el('div', { class: 'page-blank' }, `Page ${page.n} is not included on the original disc.`));
    }

    this.renderHotspots();
    this.bindPointer();
    this.ready = this.loadText();
  }

  get textUrl() { return `/api/text/${this.book.slug}/${this.page.path}`; }

  /** Load the page text: the corrected version if there is one, else the OCR text. */
  async loadText() {
    let doc = null;
    try {
      const r = await fetch(this.textUrl, { cache: 'no-store' });
      if (r.ok) doc = await r.json();
    } catch { /* server not reachable */ }
    this.applyDoc(doc);
    return this;
  }

  /** Use a text document (also after each correction): rebuild the click targets. */
  applyDoc(doc, edited = doc?.edited) {
    this.doc = doc;
    this.edited = !!edited;
    this.text = doc ? new PageText(doc) : null;
    this.gHits.replaceChildren();
    for (const g of [this.gActive, this.gWord, this.gHover]) g.replaceChildren();
    if (!this.text) return;
    const frag = document.createDocumentFragment();
    this.text.hitRects().forEach((r, i) => {
      frag.append(svg('rect', { x: r.x, y: r.y, width: r.w, height: r.h, 'data-w': i }));
    });
    this.gHits.append(frag);
  }

  /** Let the user drag a box on the page; calls done({x, y, w, h}) in page pixels, or done(null). */
  startMarking(done) {
    this.stopMarking();
    const layer = el('div', { class: 'mark-layer' });
    let start = null;
    const toPage = (e) => {
      const r = this.el.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * this.W, y: ((e.clientY - r.top) / r.height) * this.H };
    };
    const box = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
    layer.addEventListener('pointerdown', (e) => {
      start = toPage(e);
      layer.setPointerCapture(e.pointerId);
    });
    layer.addEventListener('pointermove', (e) => {
      if (start) this.draw(this.gMark, [box(start, toPage(e))]);
    });
    layer.addEventListener('pointerup', (e) => {
      if (!start) return;
      const r = box(start, toPage(e));
      this.stopMarking();
      done(r.w > 12 && r.h > 8 ? r : null);
    });
    this.markLayer = layer;
    this.el.append(layer);
  }

  stopMarking() {
    this.markLayer?.remove();
    this.markLayer = null;
    this.gMark.replaceChildren();
  }

  renderHotspots() {
    this.buttons = new Map();
    for (const a of this.page.a || []) { // (only the disc's pages have them)
      const kind = HOTSPOT[a.t];
      if (!kind) continue;
      const label = a.t === 'link' ? `p.${a.page}` : '';
      // Buttons at the edge of the page grow inwards, so wide ones (p.104) stay on the screen.
      const edge = a.x / this.W > 0.9 ? ' hs-r' : a.x / this.W < 0.1 ? ' hs-l' : '';
      const b = el('button', {
        class: `hs ${kind.cls}${edge}`,
        title: a.title,
        'aria-label': a.title,
        style: `left:${(a.x / this.W) * 100}%;top:${(a.y / this.H) * 100}%`,
        html: icon(kind.icon) + (label ? `<span>${label}</span>` : ''),
      });
      b.addEventListener('click', (e) => { e.stopPropagation(); this.hooks.onHotspot(this, a, b); });
      this.buttons.set(a, b);
      this.hotspots.append(b);
    }
  }

  bindPointer() {
    let lastW = -1;
    // A finger cannot point without touching: on a touch screen there is no hover, a tap is a click.
    this.gHits.addEventListener('pointerdown', (e) => { this.touch = e.pointerType === 'touch'; });
    this.gHits.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      const w = Number(e.target.dataset?.w ?? -1);
      if (w === lastW) return;
      lastW = w;
      this.hooks.onHover(this, this.text?.unitAt(w, this.mode) || null);
    });
    this.gHits.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'touch') return;
      lastW = -1;
      this.hooks.onHover(this, null);
    });
    this.gHits.addEventListener('click', (e) => {
      const w = Number(e.target.dataset?.w ?? -1);
      const unit = this.text?.unitAt(w, this.mode);
      if (unit) this.hooks.onClick(this, unit, e);
    });
  }

  setMode(mode) { this.mode = mode; }

  draw(group, rects) {
    group.replaceChildren(...rects.map((r) => svg('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 6 })));
  }

  showHover(unit) { this.draw(this.gHover, unit && this.text ? this.text.rects(unit.a, unit.b) : []); }
  showActive(unit) { this.draw(this.gActive, unit && this.text ? this.text.rects(unit.a, unit.b) : []); }
  showWord(w) { this.draw(this.gWord, w >= 0 && this.text ? this.text.rects(w, w + 1, 0.1) : []); }
  flash(unit) {
    this.gFlash.replaceChildren();
    // Restart the CSS animation on a fresh element.
    requestAnimationFrame(() => this.draw(this.gFlash, unit && this.text ? this.text.rects(unit.a, unit.b) : []));
  }

  /** Bounding box of a unit in CSS pixels relative to the page element. */
  unitBox(unit) {
    if (!this.text) return null;
    const rs = this.text.rects(unit.a, unit.b);
    if (!rs.length) return null;
    const s = this.el.clientWidth / this.W;
    const y0 = Math.min(...rs.map((r) => r.y)), y1 = Math.max(...rs.map((r) => r.y + r.h));
    const x0 = Math.min(...rs.map((r) => r.x)), x1 = Math.max(...rs.map((r) => r.x + r.w));
    return { x: x0 * s, y: y0 * s, w: (x1 - x0) * s, h: (y1 - y0) * s };
  }

  markPlaying(asset, on) {
    this.buttons.get(asset)?.classList.toggle('playing', on);
  }

  /** Highlight the sentences chosen for a new audio (a list of units). */
  showPicks(units) {
    this.draw(this.gPick, this.text ? units.flatMap((u) => this.text.rects(u.a, u.b, 0.12)) : []);
  }

  /** Play buttons for recordings: [{id, title, x, y}] in page pixels; onPlay(id) on click. */
  setRecSpots(spots, onPlay) {
    this.recButtons = new Map();
    this.recSpots.replaceChildren(...spots.map((s) => {
      const b = el('button', {
        class: 'rec-spot', title: `My audio: ${s.title}`, 'aria-label': `Play my audio: ${s.title}`,
        style: `left:${(s.x / this.W) * 100}%;top:${(s.y / this.H) * 100}%`, html: icon('wave'),
      });
      b.addEventListener('click', (e) => { e.stopPropagation(); onPlay(s.id); });
      this.recButtons.set(s.id, b);
      return b;
    }));
  }

  markRecPlaying(id, on) {
    this.recButtons?.get(id)?.classList.toggle('playing', on);
  }
}

// One rendered book page: the stitched page image, an SVG text layer with
// invisible word targets and highlight rectangles, and the hotspot buttons.
import { PageText } from './pagetext.js';
import { el, icon } from './util.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
export const HOLD_MS = 500; // a finger held this long on a sentence (not moving): "hold" (the sentence broken down)

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
   * @param {object} hooks  {onHover(view, unit), onClick(view, unit, event), onHold(view, unit, event)
   *                        (a finger held on it, a double click), onHotspot(view, asset)}
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
    this.gCollected = svg('g', { class: 'collected', 'aria-hidden': 'true' }); // new words collected from the page (words.js)
    this.gEdit = svg('g', { class: 'edit-outlines', 'font-size': Math.round(this.W / 75) }); // correcting: every sentence
    this.gAreas = svg('g', { class: 'order-areas', 'font-size': Math.round(this.W / 28) }); // ordering by areas
    this.gFound = svg('g', { class: 'found-outlines', 'font-size': Math.round(this.W / 55) }); // text read again, to review
    this.gRecFrame = svg('g', { class: 'rec-frame', 'aria-hidden': 'true' }); // the full passage included in a generated audio
    this.gRecSelected = svg('g', { class: 'rec-selected', 'aria-hidden': 'true' }); // sentences of selected saved audio
    this.gActive = svg('g', { class: 'hl-active' });
    this.gWord = svg('g', { class: 'hl-word' });
    this.gFlash = svg('g', { class: 'hl-flash' });
    this.gHover = svg('g', { class: 'hl-hover' });
    this.gHits = svg('g', { class: 'hits' });
    this.gMark = svg('g', { class: 'mark' });
    this.svg.append(this.gPick, this.gCollected, this.gEdit, this.gAreas, this.gFound, this.gRecSelected, this.gActive, this.gWord, this.gRecFrame, this.gFlash, this.gHover, this.gHits, this.gMark);

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
    for (const g of [this.gActive, this.gWord, this.gHover, this.gEdit]) g.replaceChildren();
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

  /**
   * Correction mode → Play buttons (js/playbuttons.js): the page's audio and video buttons are
   * dragged to another place (hooks.moved(view, a, x, y)) and taken away by their ×
   * (hooks.removed(view, a)), instead of playing. hooks null: as usual.
   */
  editHotspots(hooks) {
    this.hsEdit = hooks;
    this.el.classList.toggle('hs-editing', !!hooks);
    this.setHotspots(this.page.a || []);
  }

  /** The page's buttons as they are now (put, moved or taken away by hand). */
  setHotspots(list) {
    this.page.a = list;
    this.hotspots.replaceChildren();
    this.renderHotspots();
  }

  /** The next click on the page: done({x, y}) — where a play button shows its middle there. */
  pickPoint(done) {
    this.stopMarking();
    const layer = el('div', { class: 'mark-layer pick-layer' });
    layer.addEventListener('click', (e) => {
      const r = this.el.getBoundingClientRect();
      this.stopMarking();
      // (a play button is drawn 10 px above its place: --hs-y-offset)
      done({ x: ((e.clientX - r.left) / r.width) * this.W, y: ((e.clientY - r.top + 10) / r.height) * this.H });
    });
    this.markLayer = layer;
    this.el.append(layer);
  }

  /** A play button dragged to another place (correction mode → Play buttons). */
  dragHotspot(b, a) {
    b.addEventListener('pointerdown', (e) => {
      if (!this.hsEdit || e.target.closest('.hs-x') || e.button > 0) return;
      e.preventDefault();
      e.stopPropagation();
      const r = this.el.getBoundingClientRect(), kx = this.W / r.width, ky = this.H / r.height;
      const start = { x: e.clientX, y: e.clientY };
      const at = (ev) => ({ x: Math.min(Math.max(a.x + (ev.clientX - start.x) * kx, 0), this.W), y: Math.min(Math.max(a.y + (ev.clientY - start.y) * ky, 0), this.H) });
      let moved = false;
      b.setPointerCapture(e.pointerId);
      const move = (ev) => {
        if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
        moved = true;
        b.classList.add('dragging');
        const p = at(ev);
        b.style.left = `${(p.x / this.W) * 100}%`;
        b.style.top = `${(p.y / this.H) * 100}%`;
      };
      const up = (ev) => {
        b.removeEventListener('pointermove', move);
        b.removeEventListener('pointerup', up);
        b.removeEventListener('pointercancel', up);
        b.classList.remove('dragging');
        if (!moved || ev.type === 'pointercancel') { b.style.left = `${(a.x / this.W) * 100}%`; b.style.top = `${(a.y / this.H) * 100}%`; return; }
        const p = at(ev);
        this.hsEdit?.moved(this, a, Math.round(p.x), Math.round(p.y));
      };
      b.addEventListener('pointermove', move);
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
    });
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
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.hsEdit) { // (changed by hand: they do not play)
          if (e.target.closest('.hs-x')) this.hsEdit.removed(this, a);
          return;
        }
        this.hooks.onHotspot(this, a, b);
      });
      if (this.hsEdit && (a.t === 'audio' || a.t === 'video')) {
        b.append(el('span', { class: 'hs-x', title: 'Take this button away from the page', 'aria-label': `Take the button of ${a.title} away` }, '×'));
        this.dragHotspot(b, a);
      }
      this.buttons.set(a, b);
      this.hotspots.append(b);
    }
  }

  bindPointer() {
    let lastW = -1, hold = null;
    const unitOf = (e) => this.text?.unitAt(Number(e.target.dataset?.w ?? -1), this.mode) || null;
    const letGo = () => { clearTimeout(hold?.timer); if (hold && !hold.fired) hold = null; };
    // A finger cannot point without touching: on a touch screen there is no hover, a tap is a click.
    // A finger held on a sentence (HOLD_MS, not moving) is onHold — as a double click with a mouse.
    this.gHits.addEventListener('pointerdown', (e) => {
      this.touch = e.pointerType === 'touch';
      clearTimeout(hold?.timer);
      hold = null;
      const unit = e.pointerType !== 'mouse' && unitOf(e);
      if (!unit) return;
      hold = { x: e.clientX, y: e.clientY, id: e.pointerId };
      hold.timer = setTimeout(() => { hold.fired = true; this.hooks.onHold?.(this, unit, e); }, HOLD_MS);
    });
    this.gHits.addEventListener('pointermove', (e) => {
      if (hold && !hold.fired && e.pointerId === hold.id && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 10) letGo();
    });
    for (const type of ['pointerup', 'pointercancel']) this.gHits.addEventListener(type, letGo); // (the page scrolled, swiped)
    this.el.addEventListener('contextmenu', (e) => { if (this.touch) e.preventDefault(); }); // (a finger held: not the phone's menu)
    this.gHits.addEventListener('dblclick', (e) => {
      const unit = !this.touch && unitOf(e);
      if (unit) this.hooks.onHold?.(this, unit, e);
    });
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
      if (hold?.fired) { hold = null; return; } // (the finger was held: not a tap)
      const unit = unitOf(e);
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

  /** Correcting: an outline around every sentence with its number, [{rects, n, cls}]; [] removes them. */
  showOutlines(items) {
    this.gEdit.replaceChildren(...items.filter((it) => it.rects.length).map(({ rects, n, cls }) => {
      const g = svg('g', { class: cls });
      for (const r of rects) g.append(svg('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 4 }));
      const label = svg('text', { x: rects[0].x, y: rects[0].y - 3 });
      label.textContent = n;
      g.append(label);
      return g;
    }));
  }

  /**
   * Text read again with OCR, being reviewed: each sentence found outlined in its color, with its
   * number in the review ([{rects, n, color, off: not ticked, hot: pointed at in the review}]).
   */
  showFound(items) {
    this.gFound.replaceChildren(...items.filter((it) => it.rects.length).map(({ rects, n, color, off, hot }) => {
      const g = svg('g', { class: `${off ? 'off' : ''}${hot ? ' hot' : ''}`, style: `--c: ${color}` });
      for (const r of rects) g.append(svg('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 4 }));
      const label = svg('text', { x: rects[0].x, y: rects[0].y - 4 });
      label.textContent = n;
      g.append(label);
      return g;
    }));
  }

  /** Ordering by areas: the areas drawn so far, with their numbers ([rect]). */
  showAreas(areas) {
    const size = Math.round(this.W / 28);
    this.gAreas.replaceChildren(...areas.map((r, k) => {
      const g = svg('g');
      g.append(svg('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 8 }));
      const label = svg('text', { x: r.x + size * 0.4, y: r.y + size * 1.05 });
      label.textContent = k + 1;
      g.append(label);
      return g;
    }));
  }

  /**
   * Correcting: a frame with handles around the selected sentence (rect in page units; null
   * removes it). Dragging a handle changes its size, the top one moves it: onChange(new rect).
   */
  showFrame(rect, onChange) {
    this.frame?.remove();
    this.frame = null;
    if (!rect) return;
    const f = el('div', { class: 'sent-frame' });
    const place = (r) => Object.assign(f.style, {
      left: `${(r.x / this.W) * 100}%`, top: `${(r.y / this.H) * 100}%`, width: `${(r.w / this.W) * 100}%`, height: `${(r.h / this.H) * 100}%`,
    });
    place(rect);
    for (const h of ['move', 'n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
      const handle = el('span', { class: `fh fh-${h}`, title: h === 'move' ? 'Drag to move the sentence on the page' : 'Drag to change the size of the sentence on the page' });
      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        handle.setPointerCapture(e.pointerId);
        const k = this.W / this.el.getBoundingClientRect().width; // page units per screen pixel
        const sx = e.clientX, sy = e.clientY, min = 6;
        let r = rect;
        const move = (ev) => {
          const dx = (ev.clientX - sx) * k, dy = (ev.clientY - sy) * k;
          r = { ...rect };
          if (h === 'move') { r.x += dx; r.y += dy; }
          if (h.includes('w')) { r.x = Math.min(rect.x + rect.w - min, rect.x + dx); r.w = rect.x + rect.w - r.x; }
          if (h.includes('e') && h !== 'move') r.w = Math.max(min, rect.w + dx);
          if (h.includes('n')) { r.y = Math.min(rect.y + rect.h - min, rect.y + dy); r.h = rect.y + rect.h - r.y; }
          if (h.includes('s')) r.h = Math.max(min, rect.h + dy);
          place(r);
        };
        const up = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          handle.removeEventListener('pointercancel', up);
          if (['x', 'y', 'w', 'h'].some((p) => Math.abs(r[p] - rect[p]) > 0.5)) onChange(r);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
      });
      f.append(handle);
    }
    this.frame = f;
    this.el.append(f);
  }

  /** The new words collected from this page ([{mode, a, b, color}]: the colour of their category), marked while collecting. */
  showCollected(items) {
    this.gCollected.replaceChildren(...(this.text ? items.flatMap((u) => this.text.rects(u.a, u.b, 0.08)
      .map((r) => svg('rect', { class: u.mode, x: r.x, y: r.y, width: r.w, height: r.h, rx: 6, style: `fill:${u.color};stroke:${u.color}` }))) : []));
  }

  /** Highlight the sentences chosen for a new audio (a list of units). */
  showPicks(units) {
    this.draw(this.gPick, this.text ? units.flatMap((u) => this.text.rects(u.a, u.b, 0.12)) : []);
  }

  /** Highlight saved-audio sentences without starting playback or entering My audio mode. */
  showRecordingSelection(units) {
    this.draw(this.gRecSelected, this.text ? units.flatMap((u) => this.text.rects(u.a, u.b, 0.12)) : []);
  }

  /** Outline the whole paragraphs represented by a generated recording. */
  showRecordingFrame(rects) {
    this.gRecFrame.replaceChildren(...rects.map((r) => svg('rect', {
      class: [r.saved && 'saved-coverage', r.selected && 'selected-coverage'].filter(Boolean).join(' '),
      x: r.x, y: r.y, width: r.w, height: r.h, rx: Math.max(6, this.W / 260),
    })));
  }

  /**
   * The button that breaks a sentence down (breakdown.js), beside the sentence ({a, b}; null:
   * none), where it covers no word and no button of the page (so that it never takes their
   * clicks): after the sentence, else in the margin after or before its line, else before the
   * sentence, else above or below its end. onClick() when clicked. Returns the button (or null).
   */
  showBreakdown(unit, onClick) {
    const t = this.text, rs = unit && t ? t.rects(unit.a, unit.b) : [];
    if (!rs.length) { this.bdBtn?.remove(); this.bdBtn = null; return null; }
    if (!this.bdBtn) {
      this.bdBtn = el('button', { class: 'bd-btn', type: 'button', title: 'Break this sentence down: each word and its meaning (B)',
        'aria-label': 'Break this sentence down', html: icon('breakdown') });
      this.bdBtn.addEventListener('pointerdown', (e) => e.stopPropagation()); // (not a click on the page)
      this.bdBtn.addEventListener('click', (e) => { e.stopPropagation(); this.bdClick?.(); });
    }
    if (!this.bdBtn.isConnected) this.el.append(this.bdBtn);
    this.bdClick = onClick;
    // What it must not cover (page pixels): the words, and the buttons on the page.
    const er = this.el.getBoundingClientRect(), k = this.W / (er.width || 1);
    const boxes = t.words.filter((w) => w[2] > 0).map(([x, y, w, h]) => [x, y, x + w, y + h]);
    for (const b of [...this.hotspots.children, ...this.recSpots.children]) {
      const r = b.getBoundingClientRect();
      if (r.width) boxes.push([(r.left - er.left) * k, (r.top - er.top) * k, (r.right - er.left) * k, (r.bottom - er.top) * k]);
    }
    const s = (er.width ? 32 * k : 60) / 2; // half the button (and a little room), in page pixels
    const free = ([cx, cy]) => cx - s >= 0 && cx + s <= this.W && cy - s >= 0 && cy + s <= this.H
      && !boxes.some(([x0, y0, x1, y1]) => cx + s > x0 && cx - s < x1 && cy + s > y0 && cy - s < y1);
    const first = rs[0], last = rs[rs.length - 1], my = last.y + last.h / 2;
    const line = t.words.filter((w) => w[2] > 0 && w[5] === t.words[unit.b - 1][5] && w[5] >= 0);
    const lineL = line.length ? Math.min(...line.map((w) => w[0])) : first.x;
    const lineR = line.length ? Math.max(...line.map((w) => w[0] + w[2])) : last.x + last.w;
    const spots = [[last.x + last.w + s, my], [lineR + s * 1.3, my], [lineL - s * 1.3, my], [first.x - s, first.y + first.h / 2],
      [last.x + last.w - s, last.y - s], [last.x + last.w - s, last.y + last.h + s]];
    const [cx, cy] = spots.find(free) || spots[0];
    Object.assign(this.bdBtn.style, { left: `${(cx / this.W) * 100}%`, top: `${(cy / this.H) * 100}%` });
    return this.bdBtn;
  }

  /** Play buttons for recordings: [{id, title, x, y}] in page pixels; onPlay(id) on click. */
  setRecSpots(spots, onPlay) {
    this.recButtons = new Map();
    this.recSpots.replaceChildren(...spots.map((s) => {
      const b = el('button', {
        class: 'rec-spot', title: `My audio: ${s.title}`, 'aria-label': `Play my audio: ${s.title}`,
        'aria-pressed': 'false', dataset: { title: s.title },
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

  markRecMode(id, on) {
    this.recButtons?.forEach((button, key) => {
      const active = on && key === id;
      button.classList.toggle('mode', active);
      button.setAttribute('aria-pressed', String(active));
      button.setAttribute('aria-label', `${active ? 'Exit' : 'Play'} My audio: ${button.dataset.title || ''}`);
      button.title = active ? 'Exit My audio mode' : `My audio: ${button.dataset.title || ''}`;
    });
  }
}

// Lingua Books: the designs of a book's pages (web/designs.py). A textbook repeats a few designs of
// page (in every unit the same page of dialogues, of grammar …); on the pages of each design the app
// reads the same areas (frames), in their numbered order. They are shown on the pages of the sample,
// and changed here before all the pages are made (js/library.js): what is in each area (text, a
// dialogue, a list of new words, or nothing to read), their order, new ones; which pages have which design.
import { el } from './util.js';

const NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

/** What can be in an area: how it is read (web/designs.py KINDS). */
export const KINDS = [['text', 'Text'], ['dialogue', 'Dialogue (without the speakers’ names)'],
  ['words', 'New words (each word, then its meaning)'], ['skip', 'Don’t read']];
const WIDE = 1000; // (the areas are drawn on a page 1000 wide)
const SMALLEST = 0.01; // (an area smaller than this, drawn by a slip, is not one)
const clamp = (v) => Math.min(1, Math.max(0, v));

/** The areas drawn on a page as tall as h (1000 wide): numbered in the order they are read, those not read dashed. */
function frames(areas, h, selected = -1) {
  let n = 0;
  const out = areas.map((a, k) => {
    const read = a.kind !== 'skip';
    if (read) n += 1;
    const x = a.x * WIDE, y = a.y * h;
    return svg('g', { class: `frame ${a.kind}${k === selected ? ' on' : ''}`, 'data-k': k },
      svg('rect', { x, y, width: a.w * WIDE, height: a.h * h }),
      svg('circle', { cx: x, cy: y, r: 24 }),
      svg('text', { x, y, dy: '0.36em' }, read ? String(n) : '×'));
  });
  if (selected >= 0 && areas[selected]) { // the corners of the one selected: to change its size
    const a = areas[selected];
    for (const [hx, hy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      out.push(svg('rect', { class: 'handle', 'data-h': `${hx}${hy}`, x: (a.x + hx * a.w) * WIDE - 9, y: (a.y + hy * a.h) * h - 9, width: 18, height: 18 }));
    }
  }
  return out;
}

/**
 * A page's picture in an SVG 1000 wide (as tall as the page), with a group for the frames on it:
 * picture and frames grow and shrink together. ready(h) when the page's height is known.
 */
function pageSvg(cls, label, ready) {
  const image = svg('image', { width: WIDE, height: 1414, preserveAspectRatio: 'none' });
  const g = svg('g', { class: 'frames' });
  const pic = svg('svg', { class: cls, viewBox: `0 0 ${WIDE} 1414`, role: 'img', 'aria-label': label }, image, g);
  let wanted = null;
  const load = (src) => {
    const probe = new Image();
    wanted = src;
    probe.onload = () => {
      if (wanted !== src) return; // (another page was asked for meanwhile)
      const h = (WIDE * probe.naturalHeight) / probe.naturalWidth || 1414;
      image.setAttribute('height', h);
      image.setAttribute('href', src);
      pic.setAttribute('viewBox', `0 0 ${WIDE} ${h}`);
      ready(h);
    };
    probe.src = src;
  };
  return { pic, g, load };
}

/** A page's picture with its areas on it (as frames, not to be changed). */
export function framed(src, areas, label = '') {
  const page = pageSvg('framed', label, (h) => page.g.replaceChildren(...frames(areas, h)));
  page.load(src);
  return page.pic;
}

/**
 * The editor of the designs. info: as GET /api/books/<id>/designs gives it ({designs: [{pages,
 * example, areas}], other, token}); picture(n, small): the address of page n's picture; first: the
 * page to show first. onSave(designs) when they are saved, onCancel(), onAgain() (find the designs again).
 * Returns the node to show.
 */
export function designEditor({ info, picture, first, onSave, onCancel, onAgain }) {
  const designs = structuredClone(info.designs);
  let other = [...info.other];
  let at = first ?? designs[0]?.example ?? other[0];
  let sel = -1; // (the area selected)
  let tall = 1414; // (the page's height, the width being 1000)
  let drag = null;
  const designOf = (n) => designs.findIndex((d) => d.pages.includes(n));
  const mine = () => designs[designOf(at)] || null;

  const page = pageSvg('framed big', 'The page, with its areas', (h) => { tall = h; drawFrames(); });
  const pic = page.pic;
  const tabs = el('div', { class: 'design-tabs', role: 'tablist', 'aria-label': 'Designs of page' });
  const side = el('div', { class: 'design-side' });
  const strip = el('div', { class: 'design-strip', 'aria-label': 'The pages of this design' });
  const msg = el('p', { class: 'form-msg', role: 'alert' });
  const save = el('button', { class: 'btn primary', type: 'button', title: 'From now on the pages of each design are read by its areas' },
    'Use these designs, and read the sample again');
  const node = el('div', { class: 'lib-form design-editor', tabindex: '-1' },
    el('p', { class: 'hint' }, 'The app reads the areas (frames) of a page in their numbered order, and leaves out what is in an area '
      + 'marked “Don’t read”. They are the same on every page of the design: change them once for all.'),
    tabs,
    el('div', { class: 'design-main' }, el('div', { class: 'design-stage' }, pic), side),
    strip, msg,
    el('div', { class: 'form-buttons' },
      el('button', { class: 'btn', type: 'button', onclick: () => onCancel() }, 'Cancel'),
      el('button', {
        class: 'btn', type: 'button', title: 'Look at all the pages again, and find their designs (the changes made here go)',
        onclick: () => { if (confirm('Find the designs of the pages again? The areas you changed go.')) onAgain(); },
      }, 'Find the designs again'),
      el('span', { class: 'push' }), save));

  function show(n) {
    at = n;
    sel = -1;
    page.load(picture(n));
    renderAll();
  }

  function renderAll() {
    renderTabs();
    drawFrames();
    renderSide();
    renderStrip();
  }

  function renderTabs() {
    const k = designOf(at);
    const tab = (label, on, go) => el('button', { type: 'button', role: 'tab', class: 'btn small', 'aria-selected': String(on), onclick: go }, label);
    tabs.replaceChildren(...designs.map((d, i) => tab(`Design ${i + 1} · ${d.pages.length} page${d.pages.length === 1 ? '' : 's'}`, i === k, () => show(d.example))),
      other.length ? tab(`No design · ${other.length}`, k < 0, () => show(other[0])) : '');
  }

  function drawFrames() {
    const d = mine();
    pic.classList.toggle('off', !d); // (a page of no design: its areas cannot be drawn)
    page.g.replaceChildren(...frames(d?.areas || [], tall, sel));
  }

  function renderSide() {
    const k = designOf(at);
    const d = mine();
    const which = el('select', { class: 'select', 'aria-label': 'The design of this page' },
      ...designs.map((x, i) => el('option', { value: i, selected: i === k }, `Design ${i + 1}`)),
      el('option', { value: 'none', selected: k < 0 }, 'No design: the whole page is read'),
      el('option', { value: 'new' }, d ? 'A new design: only this page (with these areas)' : 'A new design: only this page'));
    which.addEventListener('change', () => { moveTo(at, which.value); renderAll(); });
    const list = el('ol', { class: 'design-areas' });
    let n = 0;
    (d?.areas || []).forEach((a, i) => {
      const read = a.kind !== 'skip';
      if (read) n += 1;
      const kind = el('select', { class: 'select', 'aria-label': `What is in area ${read ? n : ''}` },
        ...KINDS.map(([v, label]) => el('option', { value: v, selected: v === a.kind }, label)));
      kind.addEventListener('change', () => { a.kind = kind.value; drawFrames(); renderSide(); });
      const move = (by) => {
        const j = i + by;
        if (j < 0 || j >= d.areas.length) return;
        [d.areas[i], d.areas[j]] = [d.areas[j], d.areas[i]];
        sel = j;
        drawFrames();
        renderSide();
      };
      list.append(el('li', { class: `design-area ${a.kind}${i === sel ? ' on' : ''}`, onclick: (e) => { if (e.target === e.currentTarget || e.target.classList.contains('n')) { sel = i; drawFrames(); renderSide(); } } },
        el('span', { class: 'n' }, read ? String(n) : '×'), kind,
        el('button', { class: 'icon-btn', type: 'button', title: 'Read it earlier', 'aria-label': 'Read it earlier', disabled: i === 0, onclick: () => move(-1) }, '↑'),
        el('button', { class: 'icon-btn', type: 'button', title: 'Read it later', 'aria-label': 'Read it later', disabled: i === d.areas.length - 1, onclick: () => move(1) }, '↓'),
        el('button', { class: 'icon-btn', type: 'button', title: 'Remove this area', 'aria-label': 'Remove this area', onclick: () => remove(i) }, '✕')));
    });
    const state = !d ? 'This page has no design: it is read whole, as the app finds it. To choose what is read on it, give it a design.'
      : d.areas === null ? 'The app has not read a page of this design yet: its areas come from the first one it reads (save, and the sample reads one). Or draw them.'
        : !d.areas.length ? 'No areas: the whole page is read, as the app finds it. Draw areas to choose what is read, and in which order.' : '';
    side.replaceChildren(
      el('h4', {}, `Page ${at}`, d && d.example === at ? el('span', { class: 'hint' }, ' · the one the app read') : ''),
      el('label', { class: 'field' }, el('span', {}, 'Its design'), which),
      state ? el('p', { class: 'hint' }, state) : '',
      d?.areas?.length ? el('h4', {}, 'Areas, in the order they are read') : '', list,
      d ? el('p', { class: 'hint' }, 'Draw an area: drag on the page where there is none. Move one: drag it. '
        + 'Its size: drag its corners. Remove the one selected: the Delete key.') : '');
  }

  function renderStrip() {
    const d = mine();
    const pages = d ? d.pages : other;
    strip.replaceChildren(el('span', { class: 'hint' }, d ? `The ${pages.length} page${pages.length === 1 ? '' : 's'} of design ${designOf(at) + 1}:` : 'The pages of no design:'),
      ...pages.map((n) => el('button', { type: 'button', class: 'design-thumb', 'aria-current': n === at ? 'page' : null, title: `Page ${n}`, onclick: () => show(n) },
        el('img', { src: picture(n, true), alt: '', loading: 'lazy' }), el('span', {}, String(n)))));
    strip.querySelector('[aria-current]')?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  }

  /** Page n into design k (its index), 'none' (no design) or 'new' (a design of its own). */
  function moveTo(n, k) {
    const from = designs[designOf(n)];
    const to = k === 'new' ? { pages: [], example: n, areas: from?.areas ? structuredClone(from.areas) : [] } : designs[+k];
    if (from === to) return;
    if (from) {
      from.pages = from.pages.filter((p) => p !== n);
      if (from.example === n) from.example = from.pages[0];
      if (!from.pages.length) designs.splice(designs.indexOf(from), 1);
    } else other = other.filter((p) => p !== n);
    if (k === 'new') designs.push(to);
    if (to) to.pages = [...to.pages, n].sort((a, b) => a - b);
    else other = [...other, n].sort((a, b) => a - b);
    sel = -1;
  }

  function remove(i) {
    mine().areas.splice(i, 1);
    sel = -1;
    drawFrames();
    renderSide();
  }

  // Drawing, moving, sizing an area on the page.
  const point = (e) => {
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(pic.getScreenCTM().inverse());
    return { x: clamp(p.x / WIDE), y: clamp(p.y / tall) };
  };
  pic.addEventListener('pointerdown', (e) => {
    const d = mine();
    if (!d || e.button > 0) return;
    node.focus({ preventScroll: true }); // (the Delete key)
    const p = point(e);
    const handle = e.target.closest('[data-h]');
    const frame = e.target.closest('[data-k]');
    if (handle && sel >= 0) drag = { mode: handle.dataset.h, from: p, a: { ...d.areas[sel] } };
    else if (frame) {
      sel = +frame.dataset.k;
      drag = { mode: 'move', from: p, a: { ...d.areas[sel] } };
      renderSide();
    } else {
      sel = -1;
      drag = { mode: 'draw', from: p, a: null };
    }
    pic.setPointerCapture(e.pointerId);
    drawFrames();
    e.preventDefault();
  });
  pic.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const d = mine();
    const p = point(e);
    const dx = p.x - drag.from.x, dy = p.y - drag.from.y;
    if (drag.mode === 'draw') {
      if (!drag.a && Math.hypot(dx, dy) < SMALLEST) return;
      d.areas ??= [];
      if (!drag.a) { drag.a = { x: p.x, y: p.y, w: 0, h: 0, kind: 'text' }; d.areas.push(drag.a); sel = d.areas.length - 1; }
      Object.assign(drag.a, { x: Math.min(p.x, drag.from.x), y: Math.min(p.y, drag.from.y), w: Math.abs(dx), h: Math.abs(dy) });
    } else if (drag.mode === 'move') {
      const a = drag.a;
      Object.assign(d.areas[sel], { x: clamp(Math.min(a.x + dx, 1 - a.w)), y: clamp(Math.min(a.y + dy, 1 - a.h)) });
    } else { // a corner: '00' top left … '11' bottom right
      const a = drag.a;
      let [x0, y0, x1, y1] = [a.x, a.y, a.x + a.w, a.y + a.h];
      if (drag.mode[0] === '0') x0 = p.x; else x1 = p.x;
      if (drag.mode[1] === '0') y0 = p.y; else y1 = p.y;
      Object.assign(d.areas[sel], { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) });
    }
    drawFrames();
  });
  const done = () => {
    if (!drag) return;
    const d = mine();
    if (drag.mode === 'draw' && drag.a && (drag.a.w < SMALLEST || drag.a.h < SMALLEST)) { d.areas.pop(); sel = -1; }
    else if (sel >= 0 && d?.areas[sel] && (d.areas[sel].w < SMALLEST || d.areas[sel].h < SMALLEST)) Object.assign(d.areas[sel], drag.a);
    drag = null;
    drawFrames();
    renderSide();
  };
  pic.addEventListener('pointerup', done);
  pic.addEventListener('pointercancel', done);
  node.addEventListener('keydown', (e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel >= 0 && !e.target.closest('select, input, textarea')) {
      e.preventDefault();
      remove(sel);
    }
  });
  save.addEventListener('click', async () => {
    msg.textContent = '';
    save.disabled = true;
    try {
      await onSave(designs.map((d) => ({ pages: d.pages, example: d.example, areas: d.areas })));
    } catch (err) {
      msg.textContent = err.message;
      save.disabled = false;
    }
  });
  show(at);
  return node;
}

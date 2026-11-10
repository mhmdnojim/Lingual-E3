// Lingua Books: the designs of a book's pages (web/designs.py). A textbook repeats a few designs of
// page (in every unit the same page of dialogues, of grammar …); on the pages of each design the app
// reads the same areas (frames), in their numbered order. They are shown on the pages of the sample,
// and changed here before all the pages are made (js/library.js): what is in each area (text, a
// dialogue, a list of new words, or nothing to read), their order, new ones; which pages have which design.
import { el } from './util.js';
import { layoutAISettings } from './layout-ai.js';

const NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

/** What can be in an area: how it is read (web/designs.py KINDS). */
export const KINDS = [['text', 'Text (automatic paragraphs)'], ['paragraph', 'One paragraph'], ['heading', 'Heading (read together)'],
  ['rows', 'Separate exercise lines'], ['dialogue', 'Dialogue (without the speakers’ names)'],
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
export function designEditor({ info, picture, first, onSave, onCancel, onAgain, onPage,
  aiInfo = null, onConfigureAI, onAnalyze }) {
  const designs = structuredClone(info.designs);
  let other = [...info.other];
  const numbers = [...new Set(info.pages || [...designs.flatMap((d) => d.pages), ...other])].sort((a, b) => a - b);
  const records = new Map(Object.entries(info.pageAreas || {}).map(([n, areas]) => [Number(n), { areas: structuredClone(areas), custom: true, edited: true }]));
  const loaded = new Map(), loading = new Set(), history = [];
  const suggestions = new Map(), analyzed = new Set(), aiErrors = new Map();
  let aiBusy = null, aiPhase = -1, aiMessage = '', aiStarted = 0, aiTimer = null;
  let scope = onPage ? 'page' : 'design';
  let at = first ?? (onPage ? numbers[0] : designs[0]?.example ?? other[0]);
  let sel = -1; // (the area selected)
  let tall = 1414; // (the page's height, the width being 1000)
  let drag = null;
  const designOf = (n) => designs.findIndex((d) => d.pages.includes(n));
  const template = () => designs[designOf(at)] || null;
  const mine = () => {
    if (scope === 'design') return template();
    if (!records.has(at)) records.set(at, { areas: structuredClone(template()?.areas || []), custom: false });
    return records.get(at);
  };
  const remember = () => {
    const d = mine();
    if (!d) return;
    history.push({ d, areas: structuredClone(d.areas), at, scope, sel, custom: d.custom, edited: d.edited });
    if (history.length > 30) history.shift();
    if (scope === 'page') { d.custom = true; d.edited = true; }
    else for (const n of d.pages) if (!records.get(n)?.edited) records.delete(n);
  };

  const page = pageSvg('framed big', 'The page, with its areas', (h) => { tall = h; drawFrames(); });
  const pic = page.pic;
  const tabs = el('div', { class: 'design-tabs', role: 'tablist', 'aria-label': 'Designs of page' });
  const side = el('div', { class: 'design-side' });
  const strip = el('div', { class: 'design-strip', 'aria-label': 'The pages of this design' });
  const msg = el('p', { class: 'form-msg', role: 'alert' });
  const status = el('p', { class: 'hint', 'aria-live': 'polite' });
  const navigator = el('div', { class: 'design-nav' });
  const aiPanel = el('div', { class: 'layout-ai-panel', 'aria-live': 'polite' });
  const aiSettings = aiInfo ? layoutAISettings(aiInfo, onConfigureAI, (next) => {
    aiInfo = next; renderNavigation(); renderAI();
  }) : '';
  const save = el('button', { class: 'btn primary', type: 'button', title: 'From now on the pages of each design are read by its areas' },
    'Save layouts and preview reading');
  const node = el('div', { class: 'lib-form design-editor', tabindex: '-1' },
    el('p', { class: 'hint' }, 'Review every page before making the book. Click a paragraph outline to select it; drag it or its corners to move or resize it. '
      + 'Page changes apply only to that page. Text outside a reviewed page’s outlines is excluded. Save when finished.'),
    navigator, tabs, aiSettings, aiPanel, status,
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
    if (!numbers.includes(n)) return;
    at = n;
    drag = null;
    sel = -1;
    page.load(loaded.get(n)?.picture || picture(n));
    renderAll();
    if (onPage && scope === 'page' && !loaded.has(n) && !loading.has(n)) readPage(n);
  }

  async function readPage(n, replace = false) {
    if (loading.has(n)) return;
    const individual = scope === 'page';
    loading.add(n);
    renderNavigation();
    if (n === at) status.textContent = `Reading page ${n} and finding its paragraphs… You can browse other pages while this finishes.`;
    try {
      const data = await onPage(n);
      loaded.set(n, data);
      const r = records.get(n);
      if (replace || !r?.custom) {
        const custom = individual && scope === 'page';
        if (r) Object.assign(r, { areas: structuredClone(data.areas), custom });
        else records.set(n, { areas: structuredClone(data.areas), custom });
      }
      if (at === n && node.isConnected) {
        if (data.picture) page.load(data.picture);
        status.textContent = 'Paragraph outlines are ready. Check their boundaries and reading order. Changes are kept here until you save.';
      }
    } catch (err) {
      if (at === n) status.textContent = `${err.message} You can still draw and edit outlines, or retry finding paragraphs.`;
    } finally {
      loading.delete(n);
      if (at === n) renderAll(); else renderNavigation();
    }
  }

  function renderAI() {
    if (aiBusy !== null) {
      const seconds = Math.floor((Date.now() - aiStarted) / 1000);
      const names = ['Prepare image and OCR', 'Analyze with OpenAI', 'Validate outlines and coverage'];
      aiPanel.replaceChildren(el('p', { class: 'hint' }, `AI layout · page ${aiBusy} · ${seconds}s: ${aiMessage}`),
        el('div', { class: 'rec-progress offline-progress busy' }, el('div')),
        el('ol', { class: 'layout-ai-steps' }, ...names.map((name, i) => el('li', {}, `${i < aiPhase ? '✓' : i === aiPhase ? '…' : '○'} ${name}`))));
      return;
    }
    const result = suggestions.get(at);
    if (!result) {
      aiPanel.replaceChildren(...(aiErrors.has(at) ? [el('p', { class: 'hint' }, aiErrors.get(at))] : []));
      return;
    }
    const kept = result.areas.filter((a) => a.kind !== 'skip').length;
    aiPanel.replaceChildren(
      el('p', { class: 'hint' }, `AI suggestion: ${kept} readable areas. ${result.ai?.cached ? 'Loaded from cache; no new API request.' : 'Review the suggestion before saving.'}`),
      ...(result.ai?.notes || []).map((note) => el('p', { class: 'hint' }, note)),
      el('div', { class: 'form-buttons' },
        el('button', { type: 'button', class: 'btn small', onclick: () => {
          scope = 'page'; remember();
          Object.assign(mine(), { areas: structuredClone(result.areas), custom: true, edited: true });
          loaded.set(at, result); sel = -1; suggestions.delete(at);
          status.textContent = 'AI outlines are shown as an editable draft. Adjust them, or Undo, then Save layouts when ready.';
          renderAll();
        } }, 'Preview AI outlines'),
        el('button', { type: 'button', class: 'btn small', onclick: () => { suggestions.delete(at); renderAI(); } }, 'Discard suggestion')));
  }

  async function analyze(refresh = false) {
    if (!onAnalyze || aiBusy !== null || !aiInfo?.ready || !aiInfo?.can) return;
    const n = at;
    aiBusy = n; aiPhase = 0; aiMessage = 'Preparing this page…'; aiStarted = Date.now();
    renderNavigation(); renderAI();
    aiTimer = setInterval(() => { if (node.isConnected) renderAI(); }, 1000);
    try {
      const result = await onAnalyze(n, refresh, (phase, message) => { aiPhase = phase; aiMessage = message; if (node.isConnected) renderAI(); });
      if (!Array.isArray(result?.areas)) throw new Error('The server returned no usable AI outlines.');
      suggestions.set(n, result); analyzed.add(n); aiErrors.delete(n);
      if (at === n) status.textContent = 'AI analysis finished. Your current outlines stay until you preview the suggestion.';
    } catch (error) {
      aiErrors.set(n, `${error.message} Your current outlines are kept.`);
      if (at === n) status.textContent = `${error.message} Your current outlines are kept.`;
    } finally {
      clearInterval(aiTimer); aiTimer = null; aiBusy = null;
      if (node.isConnected) { renderNavigation(); renderAI(); }
    }
  }

  function renderNavigation() {
    const i = numbers.indexOf(at);
    const choice = el('select', { class: 'select', 'aria-label': 'Go to source page' },
      ...numbers.map((n) => el('option', { value: n, selected: n === at }, `Page ${n}${records.get(n)?.custom ? ' · own layout' : ''}`)));
    choice.addEventListener('change', () => show(Number(choice.value)));
    const edit = el('select', { class: 'select', 'aria-label': 'Layout editing scope' },
      el('option', { value: 'page', selected: scope === 'page' }, 'Edit this page only'),
      el('option', { value: 'design', selected: scope === 'design', disabled: !template() }, 'Edit all pages of this design'));
    edit.addEventListener('change', () => {
      scope = edit.value; sel = -1;
      if (scope === 'page' && loaded.has(at)) mine().custom = true;
      renderAll();
      if (scope === 'page' && onPage && !loaded.has(at) && !loading.has(at)) readPage(at);
    });
    navigator.replaceChildren(
      el('button', { type: 'button', class: 'btn small', disabled: i <= 0, onclick: () => show(numbers[i - 1]) }, '← Previous'),
      choice, el('span', { class: 'hint' }, `${i + 1} / ${numbers.length}`),
      el('button', { type: 'button', class: 'btn small', disabled: i + 1 >= numbers.length, onclick: () => show(numbers[i + 1]) }, 'Next →'),
      onPage ? edit : '',
      onPage ? el('button', { type: 'button', class: 'btn small', disabled: loading.has(at), onclick: () => {
        scope = 'page'; remember(); readPage(at, true);
      } }, loading.has(at) ? 'Finding paragraphs…' : 'Find paragraphs on this page') : '',
      onAnalyze ? el('button', { type: 'button', class: 'btn small', disabled: aiBusy !== null || loading.has(at) || !aiInfo?.ready || !aiInfo?.can,
        title: 'Send this page image and OCR words to OpenAI. API usage is billed for a new analysis.', onclick: () => analyze(false),
        dataset: { action: 'analyze-layout-ai' } }, 'Analyze layout with AI') : '',
      onAnalyze && analyzed.has(at) ? el('button', { type: 'button', class: 'link-btn', disabled: aiBusy !== null || !aiInfo?.ready || !aiInfo?.can,
        onclick: () => analyze(true) }, 'Analyze again (new paid request)') : '',
      el('button', { type: 'button', class: 'btn small', disabled: !history.length, onclick: () => {
        const old = history.pop();
        old.d.areas = old.areas; old.d.custom = old.custom; old.d.edited = old.edited;
        scope = old.scope; at = old.at; sel = old.sel;
        page.load(loaded.get(at)?.picture || picture(at)); renderAll();
      } }, 'Undo'));
    save.disabled = loading.size > 0 || aiBusy !== null;
  }

  function renderAll() {
    renderNavigation();
    renderAI();
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
      kind.addEventListener('change', () => { remember(); a.kind = kind.value; renderAll(); });
      const move = (by) => {
        const j = i + by;
        if (j < 0 || j >= d.areas.length) return;
        remember();
        [d.areas[i], d.areas[j]] = [d.areas[j], d.areas[i]];
        sel = j;
        drawFrames();
        renderAll();
      };
      list.append(el('li', { class: `design-area ${a.kind}${i === sel ? ' on' : ''}`, onclick: (e) => { if (e.target === e.currentTarget || e.target.classList.contains('n')) { sel = i; drawFrames(); renderSide(); } } },
        el('span', { class: 'n' }, read ? String(n) : '×'), kind,
        el('button', { class: 'icon-btn', type: 'button', title: 'Read it earlier', 'aria-label': 'Read it earlier', disabled: i === 0, onclick: () => move(-1) }, '↑'),
        el('button', { class: 'icon-btn', type: 'button', title: 'Read it later', 'aria-label': 'Read it later', disabled: i === d.areas.length - 1, onclick: () => move(1) }, '↓'),
        el('button', { class: 'icon-btn', type: 'button', title: 'Remove this area', 'aria-label': 'Remove this area', onclick: () => remove(i) }, '✕')));
    });
    const state = scope === 'page' && !d.areas.length ? 'This page has no readable outlines. Add an area to include its text; saving it empty excludes all text on this page.'
      : !d ? 'This page has no design: it is read whole, as the app finds it. To choose what is read on it, give it a design.'
      : d.areas === null ? 'The app has not read a page of this design yet: its areas come from the first one it reads (save, and the sample reads one). Or draw them.'
        : !d.areas.length ? 'No areas: the whole page is read, as the app finds it. Draw areas to choose what is read, and in which order.' : '';
    const data = loaded.get(at);
    const outside = scope === 'page' && data ? data.words.filter((w) => {
      const x = (w.x + w.w / 2) / data.width, y = (w.y + w.h / 2) / data.height;
      return !d.areas.some((a) => x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h);
    }).length : 0;
    side.replaceChildren(
      el('h4', {}, `Page ${at}`, d && d.example === at ? el('span', { class: 'hint' }, ' · the one the app read') : ''),
      el('p', { class: 'hint' }, scope === 'page' ? 'Editing only this page. Deleting an outline excludes that paragraph.' : 'Editing the shared design. Pages with their own layout keep their individual changes.'),
      el('label', { class: 'field' }, el('span', {}, 'Its design'), which),
      state ? el('p', { class: 'hint' }, state) : '',
      outside ? el('p', { class: 'hint' }, `${outside} detected words are outside the outlines and will be left out. Draw an area around any text you want to include.`) : '',
      d?.areas?.length ? el('h4', {}, 'Areas, in the order they are read') : '', list,
      d ? el('p', { class: 'hint' }, 'Draw an area: drag on the page where there is none. Move one: drag it. '
        + 'Its size: drag its corners. Remove the one selected: the Delete key.') : '', selectedControls(d));
  }

  function selectedControls(d) {
    const a = d?.areas?.[sel];
    if (!a) return '';
    const box = el('div', { class: 'design-selected' }, el('h4', {}, 'Selected paragraph'));
    for (const [key, label] of [['x', 'Left'], ['y', 'Top'], ['w', 'Width'], ['h', 'Height']]) {
      const input = el('input', { type: 'number', class: 'input', min: key === 'w' || key === 'h' ? 1 : 0,
        max: 100, step: 0.1, value: Number(a[key] * 100).toFixed(1), 'aria-label': `${label} percent` });
      input.addEventListener('change', () => {
        if (!input.value || !Number.isFinite(Number(input.value))) return;
        remember(); a[key] = Math.max(key === 'w' || key === 'h' ? SMALLEST : 0, clamp(Number(input.value) / 100));
        a.w = Math.min(a.w, 1 - a.x); a.h = Math.min(a.h, 1 - a.y);
        if (a.w < SMALLEST) { a.w = SMALLEST; a.x = 1 - a.w; }
        if (a.h < SMALLEST) { a.h = SMALLEST; a.y = 1 - a.h; }
        renderAll();
      });
      box.append(el('label', { class: 'field' }, el('span', {}, `${label} (%)`), input));
    }
    const data = loaded.get(at);
    const text = data?.words.filter((w) => {
      const x = (w.x + w.w / 2) / data.width, y = (w.y + w.h / 2) / data.height;
      return x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h;
    }).map((w) => w.t).join(' ');
    box.append(el('p', { class: 'design-paragraph-text' }, text || (data ? 'No text found inside this outline.' : 'Load this page’s text to see the paragraph here.')));
    return box;
  }

  function renderStrip() {
    strip.replaceChildren(el('span', { class: 'hint' }, `All ${numbers.length} selected pages:`),
      ...numbers.map((n) => el('button', { type: 'button', class: 'design-thumb', 'aria-current': n === at ? 'page' : null, title: `Page ${n}`, onclick: () => show(n) },
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
    remember();
    mine().areas.splice(i, 1);
    sel = -1;
    drawFrames();
    renderAll();
  }

  // Drawing, moving, sizing an area on the page.
  const point = (e) => {
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(pic.getScreenCTM().inverse());
    return { x: clamp(p.x / WIDE), y: clamp(p.y / tall) };
  };
  pic.addEventListener('pointerdown', (e) => {
    const d = mine();
    if (!d || e.button > 0 || loading.has(at)) return;
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
    if (!drag.remembered && Math.hypot(dx, dy) > 0.001) { remember(); drag.remembered = true; }
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
    renderAll();
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
      await onSave(designs.map((d) => ({ pages: d.pages, example: d.example, areas: d.areas })),
        Object.fromEntries([...records].filter(([, r]) => r.custom).map(([n, r]) => [String(n), r.areas])));
    } catch (err) {
      msg.textContent = err.message;
      save.disabled = false;
    }
  });
  show(at);
  return node;
}

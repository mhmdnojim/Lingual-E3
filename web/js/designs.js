// Lingua Books: the designs of a book's pages (web/designs.py). A textbook repeats a few designs of
// page (in every unit the same page of dialogues, of grammar …); on the pages of each design the app
// reads the same areas (frames), in their numbered order. They are shown on the pages of the sample,
// and changed here before all the pages are made (js/library.js): what is in each area (text, a
// dialogue, a list of new words, or nothing to read), their order, and new ones. Existing page groups
// provide starting suggestions only; edits made here are saved to the page being edited.
import { el, icon, store, toast } from './util.js';
import { speech } from './speech.js';

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
const splitSentenceText = (text) => String(text || '').split(/\r?\n/).flatMap((line) =>
  (line.match(/[^.!?。！？]+[.!?。！？]*/gu) || []).map((part) => part.trim()).filter(Boolean));
const joinSentenceParts = (parts) => parts.reduce((text, part) => {
  if (!text) return part;
  return `${text}${/[\p{Script=Han}]$/u.test(text) || /^[\p{Script=Han}]/u.test(part) ? '' : ' '}${part}`;
}, '');

/** The areas drawn on a page as tall as h (1000 wide): numbered in the order they are read, those not read dashed. */
function frames(areas, h, selected = -1, reference = -1, mergePicked = [], fade = -1) {
  let n = 0;
  const out = areas.map((a, k) => {
    const read = a.kind !== 'skip';
    if (read) n += 1;
    const x = a.x * WIDE, y = a.y * h;
    const label = read ? String(n) : '×';
    const labelH = 20;
    const labelW = Math.max(22, label.length * 9 + 10);
    const boxW = a.w * WIDE;
    const boxH = a.h * h;
    // Selected boxes have corner resize handles. Keep a normal-width box's label centered
    // along its top edge. For a narrow box, place the label beside it so neither corner handle
    // can cover the number.
    const narrowSelected = k === selected && boxW < labelW + 18;
    const labelX = narrowSelected
      ? (x + boxW + labelW + 10 <= WIDE ? x + boxW + 10 : Math.max(0, x - labelW - 10))
      : k === selected
        ? Math.max(0, Math.min(WIDE - labelW, x + (boxW - labelW) / 2))
        : Math.max(0, Math.min(WIDE - labelW, x + boxW - labelW));
    const labelY = narrowSelected
      ? Math.max(0, Math.min(h - labelH, y + (boxH - labelH) / 2))
      : y;
    // (the areas picked to be merged: numbered 1, 2, 3 … in the order they were picked)
    const pickAt = mergePicked.indexOf(k);
    const pick = pickAt >= 0 ? [svg('g', { class: 'merge-pick', transform: `translate(${Math.min(WIDE - 16, x + 18)} ${Math.min(h - 16, y + 18 + labelH)})` },
      svg('circle', { r: 15 }), svg('text', { dy: '0.35em' }, String(pickAt + 1)))] : [];
    return svg('g', { class: `frame ${a.kind}${k === selected ? ' on' : ''}${k === reference ? ' reference' : ''}${mergePicked.includes(k) ? ' merge-picked' : ''}${fade >= 0 && k >= fade ? ' unordered' : ''}`, 'data-k': k },
      svg('rect', { x, y, width: a.w * WIDE, height: a.h * h }),
      svg('rect', { class: 'frame-label', x: labelX, y: labelY, width: labelW, height: labelH, rx: 6 }),
      svg('text', { x: labelX + labelW / 2, y: labelY + labelH / 2, dy: '0.35em' }, label), ...pick);
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
function pageSvg(cls, label, ready, failed = () => {}) {
  const image = svg('image', { width: WIDE, height: 1414, preserveAspectRatio: 'none' });
  const g = svg('g', { class: 'frames' });
  const pic = svg('svg', { class: cls, viewBox: `0 0 ${WIDE} 1414`, role: 'img', 'aria-label': label }, image, g);
  let wanted = null;
  const load = (src, fallback = null) => {
    wanted = src;
    const attempt = (url, isFallback = false) => {
      const probe = new Image();
      probe.onload = () => {
        if (wanted !== src) return; // (another page was asked for meanwhile)
        const h = (WIDE * probe.naturalHeight) / probe.naturalWidth || 1414;
        image.setAttribute('height', h);
        image.setAttribute('href', url);
        pic.setAttribute('viewBox', `0 0 ${WIDE} ${h}`);
        ready(h);
      };
      probe.onerror = () => {
        if (wanted !== src) return;
        if (!isFallback && fallback && fallback !== src) attempt(fallback, true);
        else failed(url);
      };
      probe.src = url;
    };
    attempt(src);
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
 * page to show first. Edits, rereads, ordering, merging and page assets are handled in this stage;
 * onSave(designs, pageAreas) persists and rebuilds without replacing the editor. Returns its node.
 */
export function designEditor({ info, picture, fallbackPicture = null, pageKey = null, first, onSave, onCancel, onPage,
  aiInfo = null, built = () => false, mediaPanel = null, onNewAudio = null, onAnalyze, onReadArea = null, onReplacePicture = null, onLoadButtons = null, onChangeButton = null, onBeforeSave = null,
  dictationLanguage = 'en-US' }) {
  const designs = structuredClone(info.designs);
  const other = [...info.other];
  const numbers = [...new Set(info.pages || [...designs.flatMap((d) => d.pages), ...other])].sort((a, b) => a - b);
  const records = new Map(Object.entries(info.pageAreas || {}).map(([n, areas]) => [Number(n), { areas: structuredClone(areas), custom: true, edited: true }]));
  const loaded = new Map(), loading = new Set(), history = [];
  const suggestions = new Map(), analyzed = new Set(), aiErrors = new Map();
  let aiBusy = null, aiPhase = -1, aiMessage = '', aiStarted = 0, aiTimer = null;
  const requestedPage = Number(first);
  const rememberedPage = pageKey ? Number(store.get(`layout-page-${pageKey}`, NaN)) : NaN;
  const defaultPage = numbers[0] ?? designs[0]?.example ?? other[0] ?? 1;
  let at = numbers.includes(requestedPage) ? requestedPage
    : numbers.includes(rememberedPage) ? rememberedPage : defaultPage;
  let sel = -1; // (the area selected)
  let tall = 1414; // (the page's height, the width being 1000)
  let zoom = 100, showBoxes = true, areaDrawing = false, areaOrderMode = false,
    mergeAreaMode = false, mergePicked = [], mergeMode = false, pictureMode = false, pictureRect = null,
    pictureFile = null, pictureFit = 'cover', editAreaText = false, newTextArea = false,
    audioButtons = [], audioTracks = [], buttonSize = null, buttonState = 'idle',
    buttonTarget = null, loadingButtons = false, readingAll = null, rereadingArea = false, speaking = false,
    areaReview = null, sentenceMergeOrder = [], activeSentenceId = null, speechRun = 0;
  let activeToolTab = 'read';
  // Audio tab: playMode: a click on a sentence reads from it; audioPick: sentences chosen for a new audio ({ ids, anchor, host }).
  let playMode = false, audioPick = null;
  const audioClick = () => activeToolTab === 'audio' && (playMode || audioPick) && !audioPick?.host && !areaReview && !mergeMode && !mergeAreaMode;
  let areaOrderCursor = null, focusSelectionPending = false;
  let drag = null;
  // "Draw areas in reading order": the boxes drawn (or clicked) in this run are numbered 1, 2, 3 …
  // and go to the front of the page's areas; those not numbered follow them, faded.
  let orderRun = false, orderCount = 0;
  const ordering = () => orderRun && areaDrawing;
  // "Draw boxes to read": boxes drawn on the page to be read again with OCR (then checked and used).
  let rereadDraw = false, rereadBoxes = [];
  const dirty = new Set(); // the pages with changes not applied to the book yet
  // Dictation: the microphone writes into the text of the selected area.
  let dictating = false, recognizer = null, dictationEditor = null;
  let applying = false; // the book is being rebuilt
  const designOf = (n) => designs.findIndex((d) => d.pages.includes(n));
  const template = () => designs[designOf(at)] || null;
  const hasSavedBoxes = (n) => Object.hasOwn(info.pageAreas || {}, String(n))
    || (Array.isArray(designs[designOf(n)]?.areas) && designs[designOf(n)].areas.length > 0);
  const mine = () => {
    if (!records.has(at)) records.set(at, { areas: structuredClone(template()?.areas || []), custom: false });
    return records.get(at);
  };
  const remember = () => {
    const d = mine();
    if (!d) return;
    history.push({ d, areas: structuredClone(d.areas), at, sel, custom: d.custom, edited: d.edited, orderCount });
    if (history.length > 30) history.shift();
    d.custom = true; d.edited = true;
    dirty.add(at);
  };

  const page = pageSvg('framed big', 'The page, with its areas', (h) => { tall = h; drawFrames(); }, () => {
    if (node?.isConnected) status.textContent = `The image for page ${at} could not be loaded. Try changing pages and back, or close and reopen the layout editor.`;
  });
  const pic = page.pic;
  const stage = el('div', { class: 'design-stage', title: 'Hold Ctrl and scroll over the page to zoom around the pointer.' }, pic);
  const side = el('div', { class: 'design-side' });
  const strip = el('div', { class: 'design-strip', 'aria-label': 'Pages in this book' });
  // The page strip: the mouse wheel scrolls it sideways, and it can be dragged with the mouse.
  strip.addEventListener('wheel', (e) => {
    if (strip.scrollWidth <= strip.clientWidth) return;
    e.preventDefault();
    strip.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  }, { passive: false });
  let stripDrag = null, stripMoved = false;
  strip.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' || e.button > 0) return; // (touch scrolls by itself)
    stripDrag = { x: e.clientX, left: strip.scrollLeft }; stripMoved = false;
  });
  strip.addEventListener('pointermove', (e) => {
    if (!stripDrag) return;
    const dx = e.clientX - stripDrag.x;
    if (!stripMoved && Math.abs(dx) > 5) { stripMoved = true; strip.classList.add('dragging'); strip.setPointerCapture?.(e.pointerId); }
    if (stripMoved) strip.scrollLeft = stripDrag.left - dx;
  });
  const stripEnd = () => { stripDrag = null; strip.classList.remove('dragging'); };
  strip.addEventListener('pointerup', stripEnd);
  strip.addEventListener('pointercancel', stripEnd);
  strip.addEventListener('click', (e) => { if (stripMoved) { e.stopPropagation(); e.preventDefault(); stripMoved = false; } }, true);
  const msg = el('p', { class: 'form-msg', role: 'alert' });
  const status = el('p', { class: 'hint', 'aria-live': 'polite' });
  const areaOrderHint = el('p', { class: 'hint area-order-hint', 'aria-live': 'polite' });
  const navigator = el('div', { class: 'design-nav' });
  const reviewBox = el('div', { class: 'layout-review-host' }); // (what OCR read again, to check: under the status, not inside the tools)
  const panelBox = el('div', { class: 'layout-panel-host' });   // (the sentences to merge, the AI suggestion: they scroll; only the buttons stay pinned)
  const aiPanel = el('div', { class: 'layout-ai-panel', 'aria-live': 'polite' });
  let node = null;
  const scopeSelect = el('select', { class: 'select', 'aria-label': 'Apply page layout changes to' },
    el('option', { value: 'page' }, 'This page only'),
    el('option', { value: 'range' }, 'Page range'),
    el('option', { value: 'specific' }, 'Specific pages'),
    el('option', { value: 'all' }, 'All pages'));
  const rangeStart = el('input', { class: 'input', type: 'number', min: numbers[0] || 1, max: numbers.at(-1) || 1, value: at, 'aria-label': 'First page in range' });
  const rangeEnd = el('input', { class: 'input', type: 'number', min: numbers[0] || 1, max: numbers.at(-1) || 1, value: at, 'aria-label': 'Last page in range' });
  const specificPages = el('input', { class: 'input', type: 'text', value: String(at), placeholder: '3, 5, 8-10', 'aria-label': 'Page numbers in the selected scope' });
  const copyBoxesToScope = el('input', { type: 'checkbox', 'aria-label': 'Copy this page’s box layout to every selected page' });
  const copyBoxesField = el('label', { class: 'field layout-copy-scope' }, copyBoxesToScope,
    el('span', {}, 'Copy this page’s box layout to every selected page'));
  const scopeHint = el('p', { class: 'hint layout-scope-hint' }, 'Scope applies to reading or box changes. Picture and audio edits stay on this page.');
  const scopeFields = el('div', { class: 'layout-scope-fields' },
    el('label', { class: 'field' }, el('span', {}, 'From page'), rangeStart),
    el('label', { class: 'field' }, el('span', {}, 'To page'), rangeEnd),
    el('label', { class: 'field' }, el('span', {}, 'Page numbers or ranges'), specificPages));
  const scopePanel = el('section', { class: 'layout-scope' },
    el('h3', { html: icon('sliders') }, 'Apply to'),
    el('label', { class: 'field' }, el('span', {}, 'Scope'), scopeSelect),
    scopeFields, copyBoxesField, scopeHint);
  const syncScopeFields = () => {
    scopeFields.querySelectorAll('.field').forEach((field, i) => { field.hidden = scopeSelect.value === 'specific' ? i !== 2 : scopeSelect.value === 'range' ? i > 1 : true; });
    updateScopeControls();
  };
  scopeSelect.addEventListener('change', () => { syncScopeFields(); renderToolPanel(); });
  [rangeStart, rangeEnd, specificPages].forEach((field) => field.addEventListener('input', updateScopeControls));
  copyBoxesToScope.addEventListener('change', updateScopeControls);
  syncScopeFields();
  const toolTabs = el('div', { class: 'layout-tool-tabs', role: 'tablist', 'aria-label': 'Page editing tools' });
  const toolActions = el('div', { class: 'layout-tool-actions', role: 'tabpanel', 'aria-label': 'Selected page editing actions' });
  const toolNote = el('p', { class: 'hint layout-tool-note', 'aria-live': 'polite' });
  const save = el('button', { class: 'btn primary', type: 'button', title: 'Save every draft change of this layout and rebuild the book with it', html: icon('check') },
    'Apply changes & rebuild book');
  const applyBar = el('div', { class: 'rec-progress', hidden: true, role: 'progressbar', 'aria-label': 'Rebuilding the book' }, el('div'));
  const applyInfo = el('div', { class: 'layout-apply-info', 'aria-live': 'polite' });
  const applyRow = el('div', { class: 'layout-tool-apply' }, save, applyBar, applyInfo);
  const toolPanel = el('section', { class: 'layout-tool-panel' }, toolTabs, toolActions, applyRow);
  const toolNames = [['read', 'Read'], ['order', 'Order'], ['merge', 'Merge'], ['audio', 'Audio'], ['pictures', 'Pictures'], ['text', 'Text']];
  for (const [key, label] of toolNames) {
    toolTabs.append(el('button', { class: 'layout-tool-tab', type: 'button', role: 'tab', id: `layout-tab-${key}`,
      'aria-controls': 'layout-tool-actions', 'aria-selected': String(activeToolTab === key), tabindex: activeToolTab === key ? '0' : '-1',
      onclick: () => {
        const previousTab = activeToolTab;
        if (previousTab !== key) stopSpeech();
        activeToolTab = key;
        if (key !== 'order') {
          if (previousTab === 'order' || areaDrawing || areaOrderMode) status.textContent = '';
          areaDrawing = false; areaOrderMode = false; areaOrderCursor = null; orderRun = false;
        }
        if (key !== 'read') { rereadDraw = false; rereadBoxes = []; }
        if (key !== 'text') stopDictation();
        if (key !== 'merge') { mergeAreaMode = false; mergeMode = false; mergePicked = []; }
        if (key !== 'pictures') { pictureMode = false; pictureRect = null; }
        if (key !== 'text') { editAreaText = false; newTextArea = false; }
        if (key !== 'audio') { buttonState = 'idle'; buttonTarget = null; playMode = false; audioPick = null; }
        if (key === 'audio') loadButtons(at);
        if (key === 'merge' && onPage && !loaded.has(at) && !loading.has(at)) readPage(at);
        renderAll();
      } }, label));
  }
  toolActions.id = 'layout-tool-actions';
  toolActions.setAttribute('aria-labelledby', `layout-tab-${activeToolTab}`);
  toolTabs.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...toolTabs.querySelectorAll('[role="tab"]')];
    const current = tabs.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
    tabs[next]?.click(); tabs[next]?.focus();
  });
  const zoomLabel = el('span', { class: 'hint', 'aria-live': 'polite' }, '100%');
  const zoomBy = (amount) => { zoom = Math.max(50, Math.min(200, zoom + amount)); renderZoom(); };
  const renderZoom = () => { pic.style.width = `${zoom}%`; zoomLabel.textContent = `${zoom}%`; };
  const zoomAtPointer = (event) => {
    if (!event.ctrlKey || !pic.contains(event.target)) return;
    const pageRect = pic.getBoundingClientRect(), stageRect = stage.getBoundingClientRect();
    if (event.clientX < pageRect.left || event.clientX > pageRect.right || event.clientY < pageRect.top || event.clientY > pageRect.bottom) return;
    event.preventDefault();
    const pointerX = stage.scrollLeft + event.clientX - stageRect.left;
    const pointerY = stage.scrollTop + event.clientY - stageRect.top;
    const pageContentX = stage.scrollLeft + pageRect.left - stageRect.left;
    const pageContentY = stage.scrollTop + pageRect.top - stageRect.top;
    const localX = event.clientX - pageRect.left, localY = event.clientY - pageRect.top;
    zoom = Math.max(50, Math.min(200, zoom + (event.deltaY < 0 ? 10 : -10)));
    renderZoom();
    const next = pic.getBoundingClientRect();
    stage.scrollLeft = pointerX - (pageContentX + localX * (next.width / pageRect.width));
    stage.scrollTop = pointerY - (pageContentY + localY * (next.height / pageRect.height));
  };
  stage.addEventListener('wheel', zoomAtPointer, { passive: false });
  const setAreaDrawing = (on) => {
    areaDrawing = on;
    if (!on) orderRun = false;
    if (on) { areaOrderMode = false; areaOrderCursor = null; mergeAreaMode = false; mergeMode = false; mergePicked = []; pictureMode = false; rereadDraw = false; }
    status.textContent = on ? 'Draw boxes around the page areas in the order they should be read. Each box becomes one area.' : '';
    renderAll();
  };
  const setAreaOrder = (on) => {
    areaOrderMode = on; areaOrderCursor = null;
    if (on) { areaDrawing = false; mergeAreaMode = false; mergeMode = false; mergePicked = []; pictureMode = false; }
    status.textContent = on ? 'Click the reference area, then click the areas in the order they should follow it. Press this icon again to finish.' : '';
    renderAll();
  };
  /** Start (or finish) numbering the boxes: the first one drawn or clicked is number 1, the next 2 … */
  const setOrderRun = (on) => {
    orderRun = on; orderCount = 0;
    setAreaDrawing(on);
    const left = mine().areas.length;
    status.textContent = on
      ? (left ? `Draw a box, or click one of the ${left} boxes already here: it becomes number 1. Then number 2, 3 … in the order they are read. Boxes you do not number follow after yours.`
        : 'Draw the box that is read first: it becomes number 1. Then draw number 2, 3 … in the order they are read.')
      : 'Reading order kept in the draft. Press Apply changes to use it in the book.';
    renderAll();
  };
  /** The box is the next one in the reading order: it goes to the front, after the boxes numbered before it. */
  function takeNext(area) {
    const d = mine();
    const from = d.areas.indexOf(area);
    if (from < 0) return;
    d.areas.splice(from, 1);
    d.areas.splice(orderCount, 0, area);
    sel = orderCount; orderCount += 1; sentenceMergeOrder = []; focusSelectionPending = true;
    const left = d.areas.length - orderCount;
    status.textContent = `Box ${orderCount} numbered.${left ? ` ${left} not numbered yet: they will follow after number ${orderCount}.` : ''} Draw or click the next box, or press Finish ordering.`;
  }
  function pickExisting(k) {
    const d = mine();
    const area = d.areas[k];
    if (!area) return;
    if (k < orderCount) { status.textContent = `That box is number ${k + 1} already. Click a box that has no number yet.`; return; }
    remember();
    takeNext(area);
  }
  function dropUnnumbered() {
    const d = mine();
    const left = d.areas.length - orderCount;
    if (left <= 0 || !confirm(`Delete the ${left} boxes you did not number? Undo brings them back.`)) return;
    remember();
    d.areas.splice(orderCount);
    sel = -1; areaOrderCursor = null;
    status.textContent = `${left} boxes deleted. Only the ${orderCount} boxes you numbered are left.`;
    renderAll();
  }
  const action = (label, fn, symbol, { pressed, disabled = false, title = label, danger = false, primary = false } = {}) =>
    el('button', { class: `btn small layout-tool-action${danger ? ' danger' : ''}${primary ? ' primary' : ''}`, type: 'button', title, disabled,
      ...(pressed == null ? {} : { 'aria-pressed': String(pressed) }), ...(symbol ? { html: icon(symbol) } : {}), onclick: () => fn() }, label); // (fn gets no click event: some take a page list or a sentence)
  const stopSpeech = () => {
    speechRun += 1;
    speech.stop();
    speaking = false;
    activeSentenceId = null;
  };
  function sentenceRecordsForArea(data, area, areaIndex) {
    if (!area || area.kind === 'skip') return [];
    const source = data?.sentences || [];
    const within = (word) => {
      const x = (word.x + word.w / 2) / data.width, y = (word.y + word.h / 2) / data.height;
      return x >= area.x && x <= area.x + area.w && y >= area.y && y <= area.y + area.h;
    };
    const found = source.map((sentence) => {
      const words = (sentence.words || []).filter(within);
      return words.length * 2 >= (sentence.words || []).length ? { sentence, words } : null;
    }).filter(Boolean);
    if (typeof area.text === 'string') {
      // Keep sentence geometry from the page OCR document when an area has corrected text.
      // After a rebuild this document contains the corrected words; before it, matching by
      // sentence order still gives the playback highlight a useful position in the box.
      return splitSentenceText(area.text).map((text, localIndex) => ({
        id: `${areaIndex}:${localIndex}`, areaIndex, localIndex, text,
        words: found[localIndex]?.sentence.words || [], bounds: found[localIndex]?.sentence.bounds || [],
        ...(found[localIndex]?.sentence.text?.trim() === text.trim() ? placeOf(found[localIndex].sentence) : {}),
      }));
    }
    return found.map(({ sentence }, localIndex) => ({
      id: `${areaIndex}:${localIndex}`, areaIndex, localIndex, text: sentence.text,
      words: sentence.words || [], bounds: sentence.bounds || [], ...placeOf(sentence),
    }));
  }
  /** Where a sentence is in the page's text (its words a to b): new audio is made from them. */
  const placeOf = (sentence) => (Number.isInteger(sentence.a) ? { a: sentence.a, b: sentence.b, speak: sentence.speak || [] } : {});
  function pageSentenceRecords(data = loaded.get(at), areas = mine()?.areas || []) {
    const result = [];
    for (let areaIndex = 0; areaIndex < areas.length; areaIndex++) {
      for (const sentence of sentenceRecordsForArea(data, areas[areaIndex], areaIndex)) {
        result.push({ ...sentence, n: result.length + 1 });
      }
    }
    return result;
  }
  function focusPlayingSentence(sentence) {
    if (Number.isInteger(sentence?.areaIndex) && sentence.areaIndex !== sel) {
      sel = sentence.areaIndex;
      renderToolPanel();
      renderSide();
    }
    activeSentenceId = sentence?.id || null;
    drawFrames();
    const row = [...side.querySelectorAll('[data-layout-sentence]')].find((item) => item.dataset.layoutSentence === activeSentenceId);
    if (row) {
      side.querySelectorAll('.layout-sentence-playing').forEach((item) => item.classList.remove('layout-sentence-playing'));
      row.classList.add('layout-sentence-playing');
      row.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    }
    const active = pic.querySelector('.layout-active-sentence');
    if (active) {
      const r = active.getBoundingClientRect(), s = stage.getBoundingClientRect(), margin = 48;
      if (r.top < s.top + margin) stage.scrollBy({ top: r.top - s.top - margin, behavior: 'smooth' });
      else if (r.bottom > s.bottom - margin) stage.scrollBy({ top: r.bottom - s.bottom + margin, behavior: 'smooth' });
      if (r.left < s.left + margin) stage.scrollBy({ left: r.left - s.left - margin, behavior: 'smooth' });
      else if (r.right > s.right - margin) stage.scrollBy({ left: r.right - s.right + margin, behavior: 'smooth' });
    }
  }
  /** The sentences OCR found in a box: from the server's sentences, else cut from its lines. */
  const reviewSentences = (read) => {
    const sentences = Array.isArray(read?.sentences) ? read.sentences.map((sentence) => ({ ...sentence, selected: true })) : [];
    if (!sentences.length && read?.words?.length) {
      const lines = new Map();
      for (const word of [...read.words].sort((x, y) => (x.line ?? 0) - (y.line ?? 0) || x.x - y.x)) {
        const key = word.line ?? 0;
        lines.set(key, [...(lines.get(key) || []), word.t]);
      }
      sentences.push(...splitSentenceText([...lines.values()].map((line) => line.join(' ')).join('\n'))
        .map((text) => ({ text, selected: true, words: [], bounds: [] })));
    }
    return sentences;
  };
  /** The areas a box covers (most of each one). */
  const coveredAreas = (areas, box) => areas.filter((a) => {
    if (a.kind === 'skip') return false;
    const w = Math.min(a.x + a.w, box.x + box.w) - Math.max(a.x, box.x);
    const h = Math.min(a.y + a.h, box.y + box.h) - Math.max(a.y, box.y);
    return w > 0 && h > 0 && (w * h) / (a.w * a.h) >= 0.6;
  });
  /** The one area a box was drawn around: its text is then replaced; for none (or several) the box becomes a new area. */
  const bestArea = (areas, box) => { const covered = coveredAreas(areas, box); return covered.length === 1 ? covered[0] : null; };
  /** Use the sentences chosen in the review: each box replaces its area's text, or is added as a new area. */
  function applyReview() {
    const review = areaReview;
    const d = records.get(review?.page);
    if (!d || at !== review.page) { areaReview = null; status.textContent = 'The page changed while the boxes were being checked. Read them again.'; renderAll(); return; }
    remember();
    let changed = 0, lastIndex = -1;
    for (const item of review.items) {
      const corrected = item.sentences.filter((x) => x.selected && x.text.trim()).map((x) => x.text.trim());
      if (!corrected.length) continue;
      const text = corrected.join('\n');
      const target = item.mode === 'replace' && item.target && d.areas.includes(item.target) ? item.target : null;
      if (target) { target.text = text; lastIndex = d.areas.indexOf(target); }
      else {
        const below = d.areas.findIndex((a) => a.y > item.bounds.y + item.bounds.h / 2); // (new areas go where they are on the page)
        const index = below < 0 ? d.areas.length : below;
        d.areas.splice(index, 0, { x: item.bounds.x, y: item.bounds.y, w: item.bounds.w, h: item.bounds.h, kind: 'text', text });
        lastIndex = index;
      }
      changed += 1;
    }
    areaReview = null; sentenceMergeOrder = [];
    if (lastIndex >= 0) { sel = lastIndex; focusSelectionPending = true; }
    status.textContent = changed
      ? `${changed} box${changed === 1 ? '' : 'es'} used in the layout draft. Press Apply changes to save ${changed === 1 ? 'it' : 'them'} in the book.`
      : 'No sentence was chosen: nothing changed.';
    renderAll();
  }
  function areaReviewPanel() {
    if (!areaReview) return null;
    const review = areaReview;
    const d = records.get(review.page);
    const useButton = el('button', { class: 'btn small primary', type: 'button', onclick: applyReview }, 'Use selected sentences in layout');
    const refresh = () => { useButton.disabled = !review.items.some((item) => item.sentences.some((x) => x.selected && x.text.trim())); };
    let number = 0;
    const blocks = review.items.map((item, k) => {
      const letter = String.fromCharCode(65 + (item.key % 26));
      const mode = el('select', { class: 'select', 'aria-label': `What to do with box ${letter}` },
        ...(item.target ? [el('option', { value: 'replace' }, `Replace the text of area ${d.areas.indexOf(item.target) + 1}`)] : []),
        el('option', { value: 'add' }, 'Add as a new area'));
      mode.value = item.mode;
      const warn = el('p', { class: 'hint' }, '');
      const sayWarn = () => {
        const over = (item.covers || []).filter((a) => d.areas.includes(a)).map((a) => d.areas.indexOf(a) + 1);
        warn.textContent = item.mode === 'add' && over.length
          ? `This box covers area${over.length === 1 ? '' : 's'} ${over.join(', ')}: ${over.length === 1 ? 'its' : 'their'} text would be read twice. ${over.length === 1 ? 'Replace that area instead' : 'Delete those areas afterwards'}, or delete ${over.length === 1 ? 'it' : 'them'} later.` : '';
      };
      mode.addEventListener('change', () => { item.mode = mode.value; sayWarn(); });
      sayWarn();
      const rows = item.sentences.map((sentence) => {
        number += 1;
        const check = el('input', { type: 'checkbox', checked: sentence.selected, 'aria-label': `Use sentence ${number}` });
        check.addEventListener('change', () => { sentence.selected = check.checked; refresh(); drawFrames(); });
        const text = el('textarea', { class: 'input', rows: 2, 'aria-label': `Recognized sentence ${number}` }, sentence.text);
        text.addEventListener('input', () => { sentence.text = text.value; refresh(); });
        return el('div', { class: 'layout-ocr-review-row' }, el('label', { class: 'check' }, check, el('span', { class: 'layout-merge-order' }, String(number))), text);
      });
      return el('div', { class: 'layout-ocr-review-box' },
        el('b', {}, review.items.length > 1 ? `Box ${letter}: ${item.sentences.length} sentence${item.sentences.length === 1 ? '' : 's'}` : `${item.sentences.length} sentence${item.sentences.length === 1 ? '' : 's'} found`),
        el('label', { class: 'field' }, el('span', {}, 'Use it to'), mode), warn,
        el('div', { class: 'layout-ocr-review-rows' }, ...rows),
        el('button', { class: 'btn small', type: 'button', onclick: () => {
          item.sentences.push({ text: '', selected: true, words: [], bounds: [] });
          renderToolPanel(); drawFrames();
          reviewBox.querySelectorAll('.layout-ocr-review-box')[k]?.querySelector('.layout-ocr-review-row:last-child textarea')?.focus();
        } }, '+ Add sentence manually'));
    });
    const section = el('section', { class: 'layout-ocr-review', 'aria-label': 'Check the sentences read' },
      el('h4', {}, 'Check what was read'),
      el('p', { class: 'hint' }, 'Each sentence is numbered here and on the page. Untick a wrong sentence, or correct its text. A box that matches an area replaces that area’s text; any other box becomes a new area.'),
      ...blocks,
      el('div', { class: 'form-buttons' }, useButton,
        el('button', { class: 'btn small', type: 'button', onclick: () => { areaReview = null; status.textContent = 'Reading cancelled. Nothing was changed.'; renderAll(); } }, 'Cancel')));
    refresh();
    return section;
  }
  /** OCR the boxes (fractions of page n) one after the other, then show what was found to be checked. */
  async function readForReview(n, jobs) {
    if (!onReadArea) { status.textContent = 'Reading a box again is not available for this book.'; return; }
    rereadingArea = true; rereadDraw = false;
    areaDrawing = false; orderRun = false; areaOrderMode = false; mergeAreaMode = false; mergeMode = false; pictureMode = false;
    areaReview = null;
    renderAll();
    const items = [];
    let failed = '';
    try {
      for (let i = 0; i < jobs.length; i++) {
        status.textContent = `Reading ${jobs.length > 1 ? `box ${i + 1} of ${jobs.length}` : 'the box'} on page ${n} with OCR…`;
        renderToolPanel();
        try {
          const sentences = reviewSentences(await onReadArea(n, jobs[i].bounds));
          if (at !== n) return;
          if (sentences.length) items.push({ key: i, bounds: jobs[i].bounds, target: jobs[i].target, covers: jobs[i].covers || (jobs[i].target ? [jobs[i].target] : []),
            mode: jobs[i].target ? 'replace' : 'add', sentences });
        } catch (error) { failed = error.message; }
      }
      if (!items.length) throw new Error(failed || 'No text was recognized in the box. Nothing was changed.');
      rereadBoxes = [];
      areaReview = { page: n, items };
      const total = items.reduce((sum, item) => sum + item.sentences.length, 0);
      status.textContent = `Found ${total} sentence${total === 1 ? '' : 's'} in ${items.length} box${items.length === 1 ? '' : 'es'}. Check them below (they are numbered on the page too). The layout changes only when you press “Use selected sentences in layout”.`;
    } catch (error) {
      if (at === n) status.textContent = error.message;
    } finally {
      rereadingArea = false;
      if (node?.isConnected) renderAll();
    }
  }
  const rereadSelectedArea = async () => {
    const area = mine()?.areas?.[sel];
    if (!area) { status.textContent = 'Select the existing area you want to read again first: click its number in the list, or its box on the page.'; return; }
    if (!onReadArea) { status.textContent = 'Reading an area again is not available for this book.'; return; }
    const n = at, number = sel + 1;
    rereadingArea = true; areaReview = null;
    status.textContent = `Reading area ${number} of page ${n} again with OCR…`;
    renderAll();
    try {
      const sentences = reviewSentences(await onReadArea(n, { x: area.x, y: area.y, w: area.w, h: area.h }))
        .map((x) => x.text.trim()).filter(Boolean);
      if (at !== n || !mine().areas.includes(area)) return;
      if (!sentences.length) throw new Error('No text was recognized in this area. Nothing was changed.');
      remember();
      area.text = sentences.join('\n');
      sel = mine().areas.indexOf(area); sentenceMergeOrder = [];
      status.textContent = `Area ${number} read again: ${sentences.length} sentence${sentences.length === 1 ? '' : 's'}, shown below (Undo takes it back). Press Apply to save it${built() ? `: page ${n} is then renumbered in reading order` : ''}.`;
    } catch (error) {
      if (at === n) status.textContent = error.message;
    } finally {
      rereadingArea = false;
      if (node?.isConnected) renderAll();
    }
  };
  const readDrawnBoxes = async () => {
    if (!rereadBoxes.length) return;
    const areas = mine().areas;
    await readForReview(at, rereadBoxes.map((box) => ({ bounds: { ...box }, target: bestArea(areas, box), covers: coveredAreas(areas, box) })));
  };
  const setRereadDraw = (on) => {
    rereadDraw = on;
    if (on) { areaDrawing = false; orderRun = false; areaOrderMode = false; areaOrderCursor = null; mergeAreaMode = false; mergeMode = false; mergePicked = []; pictureMode = false; areaReview = null; }
    status.textContent = on ? 'Drag a box around text to read it again (text that is missing, badly read, or new). Draw as many boxes as you need, then press Read boxes.' : '';
    renderAll();
  };
  const recognitionClass = () => window.SpeechRecognition || window.webkitSpeechRecognition;
  function stopDictation() {
    const was = dictating;
    dictating = false;
    try { recognizer?.stop(); } catch { /* it had not started */ }
    recognizer = null; dictationEditor = null;
    if (was && node?.isConnected) renderToolPanel();
  }
  /** The microphone writes what is said into the text of the selected area (the browser's speech recognition). */
  function toggleDictation() {
    if (dictating) {
      stopDictation();
      status.textContent = 'Dictation stopped. Check the text below, then press Save text in layout.';
      return;
    }
    const Recognition = recognitionClass();
    if (!Recognition) { status.textContent = 'This browser cannot take dictation. Use Microsoft Edge or Google Chrome.'; return; }
    if (!mine()?.areas?.[sel]) { status.textContent = 'Select the box to dictate into first: click its number in the list, or the box on the page.'; return; }
    editAreaText = true; newTextArea = false;
    renderAll();
    const editor = side.querySelector('.design-area-text-editor');
    if (!editor) return;
    dictationEditor = editor;
    const before = editor.value.trim();
    let spokenFinal = '';
    const listener = new Recognition();
    recognizer = listener;
    listener.lang = dictationLanguage;
    listener.continuous = true;
    listener.interimResults = true;
    listener.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const heard = event.results[i][0].transcript;
        if (event.results[i].isFinal) spokenFinal += `${heard} `; else interim += heard;
      }
      editor.value = [before, `${spokenFinal}${interim}`.trim()].filter(Boolean).join('\n');
      editor.scrollTop = editor.scrollHeight;
    };
    listener.onerror = (event) => {
      status.textContent = ({ 'not-allowed': 'The microphone is blocked: allow it for this site in the browser.', 'service-not-allowed': 'Dictation is not allowed in this browser.',
        'no-speech': 'Nothing was heard. Speak, or press Dictate again.', 'audio-capture': 'No microphone was found.', network: 'Dictation needs the internet.' })[event.error]
        || `Dictation stopped (${event.error}).`;
    };
    listener.onend = () => { if (recognizer === listener) { dictating = false; recognizer = null; dictationEditor = null; if (node?.isConnected) renderToolPanel(); } };
    try {
      listener.start();
      dictating = true;
      status.textContent = 'Listening… speak the text of this box. Press Stop dictation when you are done, then Save text in layout.';
    } catch (error) { status.textContent = error.message; recognizer = null; }
    renderToolPanel();
  }
  const beginMergeArea = () => {
    const on = !mergeAreaMode;
    mergeAreaMode = on; pictureRect = null;
    if (on) { areaDrawing = false; areaOrderMode = false; areaOrderCursor = null; mergeMode = false; mergePicked = []; pictureMode = false; }
    status.textContent = mergeAreaMode ? 'Drag around the areas to combine. Only overlapping or fully enclosed area boxes will be merged.' : '';
    renderAll();
  };
  const beginPicture = () => {
    if (pictureMode) { pictureMode = false; pictureRect = null; status.textContent = ''; renderAll(); return; }
    areaDrawing = false; areaOrderMode = false; mergeAreaMode = false;
    pictureMode = true; pictureRect = null; pictureFile = null;
    status.textContent = 'Drag around the picture you want to replace.';
    renderAll();
  };
  const mergeAreas = (indices) => {
    const d = mine();
    const order = [...new Set(indices)].filter((i) => i >= 0 && i < d.areas.length);
    const unique = [...order].sort((a, b) => a - b);
    if (unique.length < 2) { status.textContent = 'Choose at least two areas to merge.'; return; }
    remember();
    const picked = order.map((i) => d.areas[i]);
    const merged = { x: Math.min(...picked.map((a) => a.x)), y: Math.min(...picked.map((a) => a.y)),
      w: Math.max(...picked.map((a) => a.x + a.w)) - Math.min(...picked.map((a) => a.x)),
      h: Math.max(...picked.map((a) => a.y + a.h)) - Math.min(...picked.map((a) => a.y)), kind: picked.find((a) => a.kind !== 'skip')?.kind || picked[0].kind,
      parts: picked.map(({ x, y, w, h, kind }) => ({ x, y, w, h, kind })) };
    if (picked.some((a) => typeof a.text === 'string')) {
      merged.text = picked.filter((a) => a.kind !== 'skip').map((a) => textInArea(loaded.get(at), a)).filter(Boolean).join('\n');
    }
    const first = unique[0];
    d.areas = d.areas.filter((_, i) => !unique.includes(i));
    d.areas.splice(first, 0, merged);
    sel = first; focusSelectionPending = true; mergeMode = false; mergeAreaMode = false; mergePicked = [];
    sentenceMergeOrder = [];
    status.textContent = `Merged ${unique.length} areas into one reading area (area ${first + 1}). This is a draft: press Apply changes to save it in the book.`;
    renderAll();
  };
  const mergeWith = (offset) => {
    const d = mine();
    const otherIndex = sel + offset;
    if (sel < 0 || otherIndex < 0 || otherIndex >= d.areas.length) {
      status.textContent = 'Select an area first, then choose the previous or next area to merge with.';
      return;
    }
    mergeMode = false; mergeAreaMode = false; mergePicked = [];
    mergeAreas(offset < 0 ? [otherIndex, sel] : [sel, otherIndex]);
  };
  const beginMergeChosen = () => {
    mergeMode = !mergeMode; mergePicked = [];
    if (mergeMode) { areaDrawing = false; areaOrderMode = false; areaOrderCursor = null; mergeAreaMode = false; pictureMode = false; }
    status.textContent = mergeMode ? 'Click the areas in the order you want to join them: each gets a number 1, 2, 3 … on the page. Then press Finish merge.' : '';
    renderAll();
  };
  const toggleMergeArea = (i) => {
    if (!mergeMode) return false;
    const pickedAt = mergePicked.indexOf(i);
    if (pickedAt >= 0) mergePicked.splice(pickedAt, 1);
    else mergePicked.push(i);
    sel = i; focusSelectionPending = true;
    status.textContent = `${mergePicked.length} area${mergePicked.length === 1 ? '' : 's'} chosen${mergePicked.length ? `: ${mergePicked.map((k) => k + 1).join(' → ')}` : ''}. Click a numbered area again to let it go. Press Finish merge to join them in this order.`;
    renderAll();
    return true;
  };
  function mergeSelectedSentences(pageSentences) {
    const areas = mine()?.areas || [];
    const picked = sentenceMergeOrder.map((id) => pageSentences.find((sentence) => sentence.id === id)).filter(Boolean);
    if (picked.length < 2) { status.textContent = 'Select at least two sentences on this page to merge.'; return; }
    const anchor = picked[0];
    const selected = new Set(picked.map((sentence) => sentence.id));
    const mergedText = joinSentenceParts(picked.map((sentence) => sentence.text.trim()).filter(Boolean));
    if (!mergedText) { status.textContent = 'The selected sentences have no text to merge.'; return; }
    remember();
    const affected = new Set(picked.map((sentence) => sentence.areaIndex));
    for (const areaIndex of affected) {
      const area = areas[areaIndex];
      const ownSentences = pageSentences.filter((sentence) => sentence.areaIndex === areaIndex);
      const replacement = [];
      for (const sentence of ownSentences) {
        if (sentence.id === anchor.id) replacement.push(mergedText);
        else if (!selected.has(sentence.id)) replacement.push(sentence.text.trim());
      }
      area.text = replacement.filter(Boolean).join('\n');
    }
    sel = anchor.areaIndex;
    focusSelectionPending = true;
    sentenceMergeOrder = [];
    areaReview = null;
    status.textContent = `Merged ${picked.length} sentences in the order you chose them. The first one keeps its place; the others were taken out of their boxes. This is a draft: press Apply changes to save it in the book.`;
    renderAll();
  }
  const readAloud = async (fromId = null) => {
    fromId = typeof fromId === 'string' ? fromId : null; // (a click passes its event: then from the first sentence)
    const d = mine();
    if (!d?.areas?.length || !speech.supported) {
      status.textContent = 'This page has no reading areas yet, or this browser does not support speech.';
      return;
    }
    if (speaking) {
      stopSpeech();
      if (!fromId) { status.textContent = 'Reading stopped.'; renderAll(); return; }
    }
    const n = at;
    let data = loaded.get(n);
    while (loading.has(n) && at === n) await new Promise((resolve) => setTimeout(resolve, 80));
    data ||= loaded.get(n);
    if ((!data?.words?.length) && d.areas.some((a) => typeof a.text !== 'string')) data = await readPage(n, false);
    if (at !== n) return;
    const queue = pageSentenceRecords(data, d.areas).filter((sentence) => sentence.text.trim());
    if (!queue.length) { status.textContent = 'No recognized sentences are inside the page areas yet.'; return; }
    speaking = true;
    const run = ++speechRun;
    let cursor = fromId ? Math.max(0, queue.findIndex((sentence) => sentence.id === fromId)) : 0;
    const next = () => {
      if (run !== speechRun || !node?.isConnected) return;
      if (cursor >= queue.length) {
        speaking = false; activeSentenceId = null; drawFrames(); renderAll();
        status.textContent = 'Finished reading the page.';
        return;
      }
      const sentence = queue[cursor++];
      focusPlayingSentence(sentence);
      if (!speech.speak(sentence.text, { onEnd: next, onError: () => {
        if (run !== speechRun) return;
        speaking = false; activeSentenceId = null; status.textContent = 'Speech playback stopped because the selected voice could not read this sentence.'; renderAll();
      } })) {
        speaking = false; activeSentenceId = null; status.textContent = 'This browser does not support speech playback.'; renderAll();
      }
    };
    const voice = speech.currentVoice('en');
    const hasNatural = speech.voices.some((v) => /natural/i.test(v.name));
    status.textContent = `Reading ${queue.length - cursor} sentence${queue.length - cursor === 1 ? '' : 's'} in the area order, each one highlighted as it is read. `
      + (voice ? `Voice: “${voice.name}”${/natural/i.test(voice.name) ? ' (natural)' : ''}. ` : '')
      + (!hasNatural && speech.voices.length ? 'No “Natural” voice is installed in this browser: Microsoft Edge has them (choose one in the app’s voice settings). ' : '')
      + 'Press ▶ by a sentence in the list to start from it.';
    renderAll();
    next();
  };
  const buttonCache = new Map();
  // The book's audio and video (Add a folder, Add files …): made once; after a change the buttons are read again.
  let mediaNode = null;
  const media = () => {
    if (!mediaNode && mediaPanel) mediaNode = mediaPanel(() => { buttonCache.clear(); if (node?.isConnected) loadButtons(at); });
    return mediaNode;
  };
  let preview = null; // (a recording being listened to from the list)
  const stopPreview = () => { try { preview?.el.pause(); } catch { /* not started */ } preview = null; };
  const togglePreview = (button) => {
    const same = preview?.button === button;
    stopPreview();
    if (same) { renderToolPanel(); return; }
    if (button.t === 'video') { window.open(button.src, '_blank', 'noopener'); return; }
    const sound = new Audio(button.src);
    preview = { button, el: sound };
    sound.addEventListener('ended', () => { if (preview?.el === sound) { preview = null; if (node?.isConnected) renderToolPanel(); } });
    sound.play().catch((error) => { status.textContent = `This recording could not be played: ${error.message}`; preview = null; renderToolPanel(); });
    renderToolPanel();
  };
  async function loadButtons(n = at) {
    if (buttonCache.has(n)) {
      ({ buttons: audioButtons = [], tracks: audioTracks = [], size: buttonSize = null } = buttonCache.get(n));
      return;
    }
    if (!onLoadButtons) return;
    loadingButtons = true; renderToolPanel();
    try {
      const result = await onLoadButtons(n);
      buttonCache.set(n, result || { buttons: [], tracks: [] });
      if (at === n) ({ buttons: audioButtons = [], tracks: audioTracks = [], size: buttonSize = null } = result || {});
    } catch (error) {
      if (at === n) status.textContent = error.message;
    } finally { loadingButtons = false; if (node?.isConnected) renderAll(); }
  }
  function beginPlaceButton() {
    buttonState = buttonState === 'placing' ? 'idle' : 'placing';
    buttonTarget = null;
    if (buttonState === 'placing') loadButtons(at);
    status.textContent = buttonState === 'placing' ? 'Choose a recording below, then click its position on the page.' : '';
    renderAll();
  }
  async function changeButton(method, button, pointOnPage = null) {
    if (!onChangeButton || !button) return;
    const data = loaded.get(at) || buttonSize || await readPage(at, false);
    if (!data) return;
    const x = pointOnPage ? pointOnPage.x * data.width : button.x;
    const y = pointOnPage ? pointOnPage.y * data.height : button.y;
    try {
      const list = await onChangeButton(at, method, button, { x, y });
      audioButtons = list || [];
      buttonCache.set(at, { buttons: audioButtons, tracks: audioTracks, size: buttonSize });
      buttonState = 'idle'; buttonTarget = null;
      status.textContent = method === 'DELETE' ? 'Play button removed from this page.' : 'Play button saved on this page.';
    } catch (error) { status.textContent = error.message; }
    renderAll();
  }
  function removeAudioButton(button) { return changeButton('DELETE', button); }
  /** Choose (or let go) a sentence to merge; the numbers 1, 2, 3 … on the page and in the list follow the order chosen. */
  function toggleSentencePick(id, on = null) {
    const pos = sentenceMergeOrder.indexOf(id);
    if (pos >= 0 && on !== true) sentenceMergeOrder.splice(pos, 1);
    else if (pos < 0 && on !== false) sentenceMergeOrder.push(id);
    const keep = panelBox.querySelector('.layout-sentence-merge-list')?.scrollTop ?? 0;
    const n = sentenceMergeOrder.length;
    status.textContent = n ? `${n} sentence${n === 1 ? '' : 's'} chosen, numbered in the order you chose them. The first one keeps its place; the others join it.` : '';
    renderToolPanel(); drawFrames();
    const list = panelBox.querySelector('.layout-sentence-merge-list');
    if (list) list.scrollTop = keep;
  }
  function sentenceMergePanel() {
    const all = pageSentenceRecords(loaded.get(at), mine().areas);
    const picked = sentenceMergeOrder.map((id) => all.find((x) => x.id === id)).filter(Boolean);
    const joined = joinSentenceParts(picked.map((x) => x.text.trim()).filter(Boolean));
    const list = el('ol', { class: 'layout-sentence-merge-list' }, ...all.map((sentence) => {
      const pos = sentenceMergeOrder.indexOf(sentence.id);
      const check = el('input', { type: 'checkbox', checked: pos >= 0, 'aria-label': `Select sentence ${sentence.n} to merge` });
      check.addEventListener('change', () => toggleSentencePick(sentence.id, check.checked));
      const row = el('li', { class: `layout-sentence-merge-row${pos >= 0 ? ' merge-picked' : ''}`, dataset: { layoutSentence: sentence.id } });
      row.append(el('label', { class: 'check' }, check, el('span', { class: 'layout-merge-order' }, pos >= 0 ? String(pos + 1) : '')),
        el('div', {}, el('small', {}, `Sentence ${sentence.n} · Area ${sentence.areaIndex + 1}`), el('span', {}, sentence.text)));
      return row;
    }));
    const empty = loading.has(at) ? 'Reading this page… its sentences will appear here.'
      : 'No recognized sentence text is available yet for this page.';
    return el('section', { class: 'layout-sentence-merge' },
      el('h4', {}, `Sentences on page ${at}`),
      el('p', { class: 'hint' }, 'Click a sentence on the page, or tick it here. They are numbered 1, 2, 3 in the order you choose; the first one keeps its place and the others join it.'),
      all.length ? list : el('p', { class: 'hint' }, empty),
      !all.length && !loading.has(at) && onPage ? action('Read this page now', () => readPage(at, false), 'transcribe') : null,
      el('p', { class: 'hint layout-merge-preview', 'aria-live': 'polite' }, picked.length >= 2
        ? `They will become one sentence: “${joined}”` : 'Choose two or more sentences to see how they will read when joined.'),
      el('div', { class: 'form-buttons' },
        action(`Merge selected sentences (${picked.length})`, () => mergeSelectedSentences(all), 'check', {
          primary: picked.length >= 2, disabled: picked.length < 2,
          title: 'Join the chosen sentences in the order chosen, including sentences from different areas' }),
        picked.length ? action('Clear my choice', () => { sentenceMergeOrder = []; status.textContent = ''; renderToolPanel(); drawFrames(); }, 'stop') : null));
  }
  /** A click on a sentence of the page (Audio tab): play mode reads from it; choosing sentences for a new audio picks it. */
  function audioSentenceClick(id, e = {}) {
    if (playMode) { readAloud(id); return; }
    if (!audioPick) return;
    const all = pageSentenceRecords(loaded.get(at), mine().areas);
    const s = all.find((x) => x.id === id);
    if (!s) return;
    if (!Number.isInteger(s.a) || !loaded.get(at)?.k) {
      status.textContent = 'This page was read again or changed here, and is not in the book yet. Press Apply (the red button) first, then choose the sentences.';
      return;
    }
    const ids = audioPick.ids, has = ids.includes(id);
    if (e.ctrlKey || e.metaKey) { if (has) ids.splice(ids.indexOf(id), 1); else ids.push(id); audioPick.anchor = null; }
    else if (audioPick.anchor && ids.includes(audioPick.anchor)) {
      const i = all.findIndex((x) => x.id === audioPick.anchor), j = all.indexOf(s);
      for (const x of all.slice(Math.min(i, j), Math.max(i, j) + 1)) if (Number.isInteger(x.a) && !ids.includes(x.id)) ids.push(x.id);
      audioPick.anchor = null;
    } else if (has) { ids.splice(ids.indexOf(id), 1); if (audioPick.anchor === id) audioPick.anchor = null; }
    else { ids.push(id); audioPick.anchor = id; }
    status.textContent = audioPick.anchor ? 'Now click the last sentence.' : `${ids.length} sentence${ids.length === 1 ? '' : 's'} chosen.`;
    renderToolPanel(); drawFrames();
  }
  function audioPickPanel() {
    if (audioPick.host) return audioPick.host.node;
    const all = pageSentenceRecords(loaded.get(at), mine().areas);
    const chosen = all.filter((x) => audioPick.ids.includes(x.id)).sort((x, y) => x.a - y.a);
    const list = el('ol', { class: 'layout-sentence-merge-list' }, ...all.map((sentence) => {
      const on = audioPick.ids.includes(sentence.id);
      const check = el('input', { type: 'checkbox', checked: on, disabled: !Number.isInteger(sentence.a), 'aria-label': `Use sentence ${sentence.n} in the new audio` });
      check.addEventListener('change', () => audioSentenceClick(sentence.id, { ctrlKey: true }));
      const row = el('li', { class: `layout-sentence-merge-row${on ? ' merge-picked' : ''}`, dataset: { layoutSentence: sentence.id } });
      row.append(el('label', { class: 'check' }, check), el('div', {}, el('small', {}, `Sentence ${sentence.n} · Area ${sentence.areaIndex + 1}`), el('span', {}, sentence.text)));
      return row;
    }));
    return el('section', { class: 'layout-sentence-merge' },
      el('h4', {}, `New audio from page ${at}`),
      el('p', { class: 'hint' }, 'Choose the sentences on the page (first and last), or tick them here. Then press Create audio to choose the voices.'),
      all.length ? list : el('p', { class: 'hint' }, loading.has(at) ? 'Reading this page… its sentences will appear here.' : 'No recognized sentence text is available for this page.'),
      el('div', { class: 'form-buttons' },
        action(`Create audio… (${chosen.length})`, () => {
          const data = loaded.get(at);
          if (!chosen.length || !data?.k) { status.textContent = 'Choose at least one sentence of the finished book page first.'; return; }
          const node2 = el('div', { class: 'layout-audio-form' });
          const host = { node: node2, show: (body) => node2.replaceChildren(body),
            close: () => { audioPick.host = null; renderAll(); },
            done: (rec) => { audioPick = null; status.textContent = `Audio “${rec.title}” is ready. Play it in the reader from the icon next to its paragraph (My audio tab).`; toast(`Audio “${rec.title}” is ready.`); renderAll(); } };
          audioPick.host = host;
          onNewAudio({ page: data.k, sentences: chosen.map(({ a, b, text, speak }) => ({ a, b, text, speak })), host });
          renderAll();
        }, 'wave', { primary: chosen.length > 0, disabled: !chosen.length }),
        chosen.length ? action('Clear my choice', () => { audioPick.ids = []; audioPick.anchor = null; status.textContent = ''; renderToolPanel(); drawFrames(); }, 'stop') : null));
  }
  /** The Audio tab, in three clear steps: the files, the play buttons on this page, reading aloud. */
  function audioPanel() {
    const step = (n, title, ...body) => el('section', { class: 'layout-audio-step' },
      el('h4', {}, el('span', { class: 'layout-step-n' }, String(n)), title), ...body);
    const rows = audioButtons.map((b) => el('div', { class: 'layout-button-row' },
      el('span', {}, `${b.title || b.name || 'Recording'}${b.t === 'video' ? ' (video)' : ''}`),
      action(preview?.button === b ? 'Stop' : b.t === 'video' ? 'Watch' : 'Listen', () => togglePreview(b), preview?.button === b ? 'stop' : 'play'),
      action('Move', () => { buttonTarget = b; buttonState = 'moving'; status.textContent = 'Click the new position on the page for this play button.'; renderAll(); }, 'grip'),
      action('Remove', () => removeAudioButton(b), 'trash', { danger: true })));
    let placing = null;
    if (buttonState === 'placing') {
      if (audioTracks.length) {
        const track = el('select', { class: 'select', 'aria-label': 'Choose a saved recording' }, ...audioTracks.map((t) => el('option', { value: t.file }, `${t.title || t.name}${t.placed ? '' : ' (no button yet)'}`)));
        placing = el('div', { class: 'layout-place-box' }, el('label', { class: 'field' }, el('span', {}, 'Which file?'), track),
          el('button', { class: 'btn small primary', type: 'button', onclick: () => { buttonTarget = audioTracks.find((t) => t.file === track.value); status.textContent = 'Now click on the page where its play button should be.'; } }, 'Then click on the page…'));
      } else if (!loadingButtons) placing = el('p', { class: 'hint' }, 'There is no audio or video in this book yet. Add files in step 1 first.');
    }
    return el('div', { class: 'layout-audio-steps' },
      step(1, 'Add the book’s audio and video',
        el('p', { class: 'hint' }, 'Choose files, or a whole folder (for example the Student’s Book CD). A play button goes by itself where each file’s number is printed on the pages.'),
        media() || ''),
      step(2, `Play buttons on page ${at}`,
        loadingButtons ? el('p', { class: 'hint' }, 'Loading…') : '',
        rows.length ? el('div', { class: 'layout-button-list' }, ...rows) : el('p', { class: 'hint' }, loadingButtons ? '' : 'No play button on this page yet.'),
        placing || '',
        el('div', { class: 'form-buttons' },
          action(buttonState === 'idle' ? 'Add a play button here…' : 'Cancel', () => { if (buttonState === 'idle') beginPlaceButton(); else { buttonState = 'idle'; buttonTarget = null; status.textContent = ''; renderAll(); } },
            buttonState === 'idle' ? 'plus' : 'close', { disabled: !onLoadButtons || !onChangeButton, title: 'Choose a file, then click on the page where its play button belongs' })),
        el('p', { class: 'hint' }, 'You can also drag a ▶ on the page to move it.')),
      step(3, 'Read this page aloud',
        el('div', { class: 'form-buttons' },
          action(playMode ? 'Play mode: on' : 'Play mode', () => {
            playMode = !playMode; audioPick = null;
            if (!playMode) stopSpeech();
            status.textContent = playMode ? 'Play mode: click a sentence on the page and it is read aloud, then the sentences after it. Click another sentence to jump there.' : '';
            if (playMode && !loaded.has(at) && !loading.has(at) && onPage) readPage(at, false);
            renderAll();
          }, 'play', { pressed: playMode, title: 'Click a sentence on the page to hear it, as in the reader' }),
          playMode ? action(speaking ? 'Stop reading' : 'Play the whole page', readAloud, speaking ? 'stop' : 'play', { pressed: speaking,
            title: 'Read the page from its first sentence in the order of the boxes' }) : null,
          onNewAudio ? action(audioPick ? 'Cancel new audio' : 'Make new audio (natural voice)…', () => {
            if (audioPick) { audioPick = null; status.textContent = ''; renderAll(); return; }
            stopSpeech(); stopPreview(); playMode = false;
            audioPick = { ids: [], anchor: null, host: null };
            status.textContent = 'Click the first sentence on the page, then the last one: all between are chosen. Click a chosen sentence to take it out. Ctrl+click chooses just one.';
            if (!loaded.has(at) && !loading.has(at) && onPage) readPage(at, false);
            renderAll();
          }, 'wave', { disabled: !built(), pressed: !!audioPick,
            title: built() ? 'Choose sentences on this page, then the voices, and make the MP3 here'
              : 'Build the book first (Apply): new audio is made from its finished pages' }) : null),
        el('p', { class: 'hint' }, 'Play mode: click a sentence to hear it. New audio: make an MP3 of sentences with a natural voice.')));
  }
  function renderToolPanel() {
    toolActions.setAttribute('aria-labelledby', `layout-tab-${activeToolTab}`);
    toolTabs.querySelectorAll('[role="tab"]').forEach((tab) => {
      const selected = tab.id === `layout-tab-${activeToolTab}`;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    const items = [];
    let itemsMerge = null;
    if (activeToolTab === 'read') {
      const scopeLabel = scopeSelect.value === 'page' ? 'Read this page again' : 'Read selected pages again';
      items.push(action(readingAll ? 'Stop reading pages' : scopeLabel, readingAll ? () => { readingAll.cancel = true; } : readScopedPages,
        readingAll ? 'stop' : 'transcribe', { disabled: rereadingArea, title: 'Read the selected page scope with PDF text extraction or OCR', pressed: !!readingAll }));
      items.push(action(rereadingArea ? 'Reading…' : 'Read the selected area again', rereadSelectedArea, 'transcribe', {
        disabled: rereadingArea || sel < 0 || !onReadArea,
        title: sel < 0 ? 'First select an area: click its number in the list, or its box on the page' : 'Read the selected area with OCR again, then check the sentences found' }));
      items.push(action(rereadDraw ? `Stop drawing boxes (${rereadBoxes.length})` : 'Draw boxes to read', () => setRereadDraw(!rereadDraw), 'select-area', {
        pressed: rereadDraw, disabled: rereadingArea || !onReadArea,
        title: 'Drag boxes around text on the page (missing, badly read or new), then read them all with OCR and check what was found' }));
      if (rereadBoxes.length) {
        items.push(action(`Read ${rereadBoxes.length} box${rereadBoxes.length === 1 ? '' : 'es'} (OCR)`, readDrawnBoxes, 'transcribe', { primary: true, disabled: rereadingArea,
          title: 'Read the text inside the boxes you drew, then check the sentences found' }));
        items.push(action('Take back the last box', () => { rereadBoxes.pop(); renderAll(); }, 'stop'));
      }
      items.push(action(speaking ? 'Stop reading' : 'Play this page aloud', readAloud, speaking ? 'stop' : 'play', { pressed: speaking,
        title: 'Read every sentence in the current area order with the selected app voice and highlight it' }));
      if (onAnalyze) items.push(action('Analyze this page with AI', () => analyze(false), 'sliders', {
        disabled: aiBusy !== null || loading.has(at) || !aiInfo?.ready || !aiInfo?.can,
        title: 'Ask AI to suggest page areas. Review the suggestion before applying it.' }));
      if (onAnalyze && analyzed.has(at)) items.push(action('Analyze again', () => analyze(true), 'repeat', {
        disabled: aiBusy !== null || !aiInfo?.ready || !aiInfo?.can, title: 'Run a new AI layout analysis for this page' }));
      toolNote.textContent = `${aiInfo?.ready
        ? 'AI layout suggestions use the OpenAI key configured in Admin → API.'
        : 'To enable AI suggestions, configure OpenAI under Admin → API.'} “Read this page again” reads the page from the PDF text, or with OCR, and finds its areas again. “Read the selected area again” replaces that area’s text. Apply then saves it.`;
    } else if (activeToolTab === 'order') {
      items.push(action(ordering() ? `Finish ordering (${orderCount} numbered)` : 'Draw areas in reading order', () => setOrderRun(!ordering()),
        ordering() ? 'check' : 'select-area', { pressed: ordering(), primary: ordering(),
          title: 'Draw boxes (or click the ones already here) in the order they are read: the first is number 1, the next 2 …' }));
      if (ordering() && mine().areas.length > orderCount) {
        items.push(action(`Delete the ${mine().areas.length - orderCount} boxes I did not number`, dropUnnumbered, 'trash', { danger: true,
          title: 'Keep only the boxes you numbered in this run' }));
      }
      items.push(action('Reference, then click areas', () => setAreaOrder(!areaOrderMode), 'grip', { pressed: areaOrderMode,
        title: 'Choose a starting area, then click each area to place it after the previous one' }));
      items.push(action('Order boxes top to bottom', () => {
        const d = mine();
        if (d.areas.length < 2) return;
        remember();
        d.areas.sort((a, b) => a.y - b.y || a.x - b.x);
        sentenceMergeOrder = [];
        sel = -1; areaOrderCursor = null;
        status.textContent = 'Areas reordered from top to bottom, then left to right. Use Reference order for columns or a custom sequence.';
        renderAll();
      }, 'arrow-down', { disabled: mine().areas.length < 2, title: 'Sort the existing reading areas by page position' }));
      items.push(action('Clear this page’s areas', () => {
        const d = mine();
        if (!d.areas.length || !confirm(`Clear all ${d.areas.length} areas on page ${at}? Undo restores them.`)) return;
        remember(); d.areas = []; sel = -1; areaOrderCursor = null; setAreaDrawing(false);
      }, 'trash', { danger: true, title: 'Remove all paragraph boxes from the current page' }));
      toolNote.textContent = 'These boxes are the page’s reading areas. Their order here is the order used when the book is rebuilt.';
    } else if (activeToolTab === 'merge') {
      if (mergeMode) {
        items.push(action(`Finish merge: join ${mergePicked.length} area${mergePicked.length === 1 ? '' : 's'}`, () => mergeAreas(mergePicked), 'check', {
          primary: true, disabled: mergePicked.length < 2,
          title: 'Join the numbered areas into one reading area, in the order of their numbers' }));
        items.push(action('Cancel merge', () => { mergeMode = false; mergePicked = []; status.textContent = ''; renderAll(); }, 'stop'));
      } else {
        items.push(action('Merge in chosen order', beginMergeChosen, 'merge-down', { disabled: mine().areas.length < 2,
          title: 'Click the area boxes in the order you want: each gets a number 1, 2, 3 … Then press Finish merge' }));
      }
      items.push(action('Merge with previous area', () => mergeWith(-1), 'merge-up', { disabled: sel < 0 || sel === 0 || mergeMode,
        title: 'Combine the selected area box with the one before it' }));
      items.push(action('Merge with next area', () => mergeWith(1), 'merge-down', { disabled: sel < 0 || sel >= mine().areas.length - 1 || mergeMode,
        title: 'Combine the selected area box with the one after it' }));
      items.push(action(mergeAreaMode ? 'Cancel merge by area' : 'Merge areas inside a selection', beginMergeArea, 'select-area', { pressed: mergeAreaMode, disabled: mergeMode,
        title: 'Draw around two or more area boxes to combine them in place' }));
      toolNote.textContent = 'A merge is shown at once and Undo takes it back. Apply (the red button) saves it in the book: only the changed page is made again. '
        + 'Sentences: click a sentence on the page, or tick it in the list; they are numbered 1, 2, 3 in the order you choose, and the first one keeps its place.';
    } else if (activeToolTab === 'audio') {
      toolNote.textContent = 'Audio and video are saved at once: you do not need to press Apply for them.';
    } else if (activeToolTab === 'pictures') {
      items.push(action(pictureMode ? 'Cancel picture selection' : 'Select a picture area', beginPicture, 'image', { pressed: pictureMode,
        title: 'Drag a rectangle over the picture to replace it, without leaving page layouts' }));
      if (pictureRect) {
        const file = el('input', { class: 'input', type: 'file', accept: 'image/jpeg,image/png,image/webp', 'aria-label': 'Choose replacement picture' });
        file.addEventListener('change', () => { pictureFile = file.files?.[0] || null; });
        const fit = el('select', { class: 'select', 'aria-label': 'Fit picture' }, el('option', { value: 'cover' }, 'Fill the selected area'), el('option', { value: 'contain' }, 'Fit whole picture'));
        fit.value = pictureFit; fit.addEventListener('change', () => { pictureFit = fit.value; });
        items.push(el('label', { class: 'field' }, el('span', {}, 'Replacement picture'), file), fit,
          action('Replace selected picture', async () => {
            if (!pictureFile || !onReplacePicture) { status.textContent = 'Choose a replacement picture first.'; return; }
            const data = loaded.get(at) || await readPage(at, false);
            if (!data) return;
            const rect = { x: pictureRect.x * data.width, y: pictureRect.y * data.height,
              w: pictureRect.w * data.width, h: pictureRect.h * data.height };
            try {
              status.textContent = 'Replacing the picture on this page…'; renderAll();
              await onReplacePicture(at, rect, pictureFile, pictureFit);
              const current = loaded.get(at);
              if (current?.words) current.words = current.words.filter((word) => {
                const cx = word.x + word.w / 2, cy = word.y + word.h / 2;
                return cx < rect.x || cx > rect.x + rect.w || cy < rect.y || cy > rect.y + rect.h;
              });
              pictureRect = null; pictureFile = null; pictureMode = false;
              const source = picture(at);
              page.load(`${source}${source.includes('?') ? '&' : '?'}refresh=${Date.now()}`, fallbackPicture?.(at));
              status.textContent = 'Picture replaced on this page. The layout remains open.';
            } catch (error) { status.textContent = error.message; }
          }, 'check', { disabled: !onReplacePicture }));
      }
      toolNote.textContent = 'Select an area on the page, then choose an image. The page preview updates here after replacement.';
    } else {
      items.push(action('Edit text in selected area', () => {
        if (sel < 0) { status.textContent = 'Select a box on the page or in the area list first.'; return; }
        editAreaText = !editAreaText; renderAll();
      }, 'pencil', { pressed: editAreaText, title: 'Edit the OCR text for the selected box; the correction is saved with this page layout' }));
      items.push(action(dictating ? 'Stop dictation' : 'Dictate', toggleDictation, 'microphone', { pressed: dictating, disabled: !recognitionClass(),
        title: recognitionClass() ? 'Speak: the words are typed into the text of the selected box' : 'This browser cannot take dictation: use Microsoft Edge or Google Chrome' }));
      items.push(action('Add a text area', () => {
        areaDrawing = true; newTextArea = true; editAreaText = true; areaOrderMode = false;
        mergeAreaMode = false; pictureMode = false;
        status.textContent = 'Draw a box around the missing text. Then type the text in the editor below.'; renderAll();
      }, 'plus', { pressed: newTextArea, title: 'Draw a box and enter its text' }));
      items.push(action('Move areas by reference', () => setAreaOrder(!areaOrderMode), 'grip', { pressed: areaOrderMode,
        title: 'Choose a reference area, then click areas to place after it' }));
      toolNote.textContent = 'Edit the selected area’s text here. Use one line per paragraph; after saving, the book is rebuilt from these corrected words.';
    }
    toolActions.replaceChildren(...items);
    reviewBox.replaceChildren(...(areaReview ? [areaReviewPanel()] : []));
    panelBox.replaceChildren(...(activeToolTab === 'merge' ? [sentenceMergePanel()] : activeToolTab === 'read' ? [aiPanel]
      : activeToolTab === 'audio' ? [audioPick ? audioPickPanel() : null, audioPick?.host ? null : audioPanel()].filter(Boolean) : []));
    applyRow.hidden = activeToolTab === 'audio' && !dirty.size && !applying; // (audio is saved at once: no Apply here)
  }
  node = el('div', { class: 'design-editor', tabindex: '-1' },
    navigator,
    el('div', { class: 'design-workspace' },
      el('section', { class: 'design-page-pane' },
        el('div', { class: 'design-page-tools' },
          el('button', { class: 'btn small', type: 'button', title: 'Zoom out', 'aria-label': 'Zoom out', onclick: () => zoomBy(-10) }, '−'),
          zoomLabel,
          el('button', { class: 'btn small', type: 'button', title: 'Zoom in', 'aria-label': 'Zoom in', onclick: () => zoomBy(10) }, '+'),
          el('button', { class: 'btn small', type: 'button', title: 'Show or hide boxes', 'aria-pressed': 'true', onclick: (e) => {
            showBoxes = !showBoxes; e.currentTarget.setAttribute('aria-pressed', String(showBoxes)); drawFrames();
          } }, 'Boxes'),
          el('button', { class: 'btn small', type: 'button', title: 'Maximize editor', 'aria-pressed': 'false', onclick: (e) => {
            const expanded = node.classList.toggle('expanded'); e.currentTarget.setAttribute('aria-pressed', String(expanded));
            e.currentTarget.title = expanded ? 'Restore editor' : 'Maximize editor';
          } }, 'Maximize')),
        stage, strip),
      el('aside', { class: 'design-controls' },
        toolPanel, status, toolNote, areaOrderHint, reviewBox, panelBox, side,
        msg,
        el('div', { class: 'form-buttons' },
          el('button', { class: 'btn', type: 'button', onclick: () => onCancel() }, 'Cancel'),
          onPage ? el('button', { class: 'btn', type: 'button', title: 'Reread the selected pages and replace their automatic paragraph boxes',
            onclick: () => { if (confirm('Reread the selected pages and replace their page boxes? Unsaved box changes will be lost.')) readScopedPages(numbers); } }, 'Find boxes again') : '',
          el('span', { class: 'push' })))));

  // The status line stays just under the tools (the panel's height is told to the CSS): a message is never out of sight.
  const controls = node.querySelector('.design-controls');
  const tellPanelHeight = () => controls.style.setProperty('--tool-panel-h', `${toolPanel.offsetHeight}px`);
  if (typeof ResizeObserver === 'function') new ResizeObserver(tellPanelHeight).observe(toolPanel);
  tellPanelHeight();

  function show(n) {
    n = Number(n);
    if (!numbers.includes(n)) return;
    at = n;
    if (pageKey) store.set(`layout-page-${pageKey}`, n);
    if (scopeSelect.value === 'page') {
      rangeStart.value = String(n); rangeEnd.value = String(n); specificPages.value = String(n);
    }
    syncScopeFields();
    stopSpeech(); stopPreview();
    playMode = false; audioPick = null;
    drag = null;
    sel = -1;
    areaDrawing = false; areaOrderMode = false; areaOrderCursor = null; orderRun = false; orderCount = 0;
    rereadDraw = false; rereadBoxes = []; stopDictation();
    mergeAreaMode = false; mergeMode = false; mergePicked = []; pictureMode = false; pictureRect = null;
    areaReview = null; sentenceMergeOrder = []; activeSentenceId = null;
    editAreaText = false; newTextArea = false; buttonState = 'idle'; buttonTarget = null;
    if (activeToolTab === 'audio') {
      ({ buttons: audioButtons = [], tracks: audioTracks = [], size: buttonSize = null } = buttonCache.get(n) || { buttons: [], tracks: [], size: null });
      loadButtons(n);
    }
    status.textContent = hasSavedBoxes(n)
      ? 'Showing this page’s saved boxes. Use Read → Read this page again only if you want to refresh its text and boundaries.' : '';
    page.load(loaded.get(n)?.picture || picture(n), fallbackPicture?.(n));
    renderAll();
    if (onPage && !loaded.has(n) && !loading.has(n)) readPage(n);
  }

  async function readPage(n, replace = false) {
    if (loading.has(n)) return;
    loading.add(n);
    renderNavigation();
    if (n === at) status.textContent = `Reading page ${n} and finding its paragraphs… You can browse other pages while this finishes.`;
    try {
      const data = await onPage(n, replace); // (replace: read it again from the PDF or with OCR, not what the book has)
      loaded.set(n, data);
      let r = records.get(n);
      if (replace || !r?.custom) {
        if (replace) { rememberPage(n); r = records.get(n); }
        const custom = replace || !!r?.custom;
        if (r) Object.assign(r, { areas: structuredClone(data.areas), custom });
        else {
          r = { areas: structuredClone(data.areas), custom };
          records.set(n, r);
        }
      }
      if (at === n && node.isConnected) {
        if (data.picture) page.load(data.picture, fallbackPicture?.(n));
        const source = ({ saved: 'the book’s saved text (no new OCR)', pdf: 'PDF text', hidden: 'OCR text embedded in the PDF', scan: 'OCR', broken: 'OCR (the PDF text was unusable)', ocr: 'OCR', photo: 'OCR' })[data.how] || 'text extraction';
        status.textContent = `Page ${n} read using ${source}: ${data.words?.length || 0} words found. Check the text and paragraph boundaries below.`;
      }
      return data;
    } catch (err) {
      if (at === n) status.textContent = `${err.message} You can still draw and edit outlines, or retry finding paragraphs.`;
      return null;
    } finally {
      loading.delete(n);
      if (at === n) renderAll(); else renderNavigation();
    }
  }

  function scopeTargets(report = true) {
    msg.textContent = '';
    const fail = (text) => { if (report) msg.textContent = text; return null; };
    if (scopeSelect.value === 'page') return [at];
    if (scopeSelect.value === 'all') return [...numbers];
    if (scopeSelect.value === 'range') {
      const from = Number(rangeStart.value), to = Number(rangeEnd.value);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) return fail('Enter a valid page range, with the first page before the last.');
      const pages = numbers.filter((n) => n >= from && n <= to);
      return pages.length ? pages : fail('That page range does not include any pages in this book.');
    }
    const picked = new Set();
    for (const part of specificPages.value.split(',').map((s) => s.trim()).filter(Boolean)) {
      const match = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
      if (!match) return fail('Use page numbers separated by commas, such as 3, 5, 8-10.');
      const firstPage = Number(match[1]), lastPage = Number(match[2] || match[1]);
      if (firstPage > lastPage) return fail('In each page range, put the smaller page number first.');
      numbers.forEach((n) => { if (n >= firstPage && n <= lastPage) picked.add(n); });
    }
    const pages = [...picked].sort((a, b) => a - b);
    return pages.length ? pages : fail('None of those page numbers is in the selected book page range.');
  }

  function updateScopeControls() {
    const targets = scopeTargets(false);
    copyBoxesField.hidden = !targets || targets.length < 2;
    scopeHint.textContent = copyBoxesToScope.checked && !copyBoxesField.hidden
      ? `Saving will copy page ${at}’s box positions and reading order to every page in the scope, replacing their saved boxes.`
      : 'Whole-page rereading keeps each page’s own results. Sentence, picture, and audio edits stay on the current page.';
  }

  function rememberPage(n) {
    let d = records.get(n);
    if (!d) {
      d = { areas: structuredClone(designs[designOf(n)]?.areas || []), custom: false };
      records.set(n, d);
    }
    history.push({ d, areas: structuredClone(d.areas), at: n, sel: n === at ? sel : -1, custom: d.custom, edited: d.edited });
    if (history.length > 30) history.shift();
    dirty.add(n);
  }

  async function readScopedPages(pageOverride = null) {
    if (readingAll) { readingAll.cancel = true; return; }
    const todo = pageOverride || scopeTargets();
    if (!todo?.length || !onPage) return;
    const task = { cancel: false };
    readingAll = task;
    renderToolPanel();
    let done = 0, failed = 0;
    for (let i = 0; i < todo.length; i++) {
      const n = todo[i];
      if (task.cancel || !node.isConnected) break;
      while (loading.has(n) && !task.cancel) await new Promise((resolve) => setTimeout(resolve, 100));
      if (task.cancel) break;
      status.textContent = `Reading page ${n} (${i + 1} of ${todo.length}) in the selected scope…`;
      renderToolPanel();
      const data = await readPage(n, true);
      if (data) done += 1; else failed += 1;
      if (node.isConnected) {
        if (todo.length > 1) status.textContent = `Read ${done} of ${todo.length} selected pages${failed ? `; ${failed} failed` : ''}.`;
        renderToolPanel();
      }
    }
    if (readingAll === task) {
      readingAll = null;
      if (node.isConnected) {
        if (todo.length > 1 || task.cancel) status.textContent = task.cancel ? `Stopped after reading ${done} of ${todo.length} selected pages.`
          : failed ? `Finished with ${failed} page${failed === 1 ? '' : 's'} that could not be read. Retry the selected scope.`
            : `Finished reading all ${todo.length} selected page${todo.length === 1 ? '' : 's'}. Review the recognized text and outlines on each page.`;
        renderAll();
      }
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
          remember();
          Object.assign(mine(), { areas: structuredClone(result.areas), custom: true, edited: true });
          loaded.set(at, result); sel = -1; areaOrderCursor = null; suggestions.delete(at);
          status.textContent = 'AI outlines are shown as an editable draft. Adjust them, or Undo, then Save layouts when ready.';
          renderAll();
        } }, 'Preview AI outlines'),
        el('button', { type: 'button', class: 'btn small', onclick: () => { suggestions.delete(at); renderAI(); } }, 'Discard suggestion')));
  }

  async function analyze(refresh = false) {
    if (!onAnalyze || aiBusy !== null || !aiInfo?.ready || !aiInfo?.can) return;
    const n = at;
    aiBusy = n; aiPhase = 0; aiMessage = 'Preparing this page…'; aiStarted = Date.now();
    renderNavigation(); renderAI(); renderToolPanel();
    aiTimer = setInterval(() => { if (node.isConnected) renderAI(); }, 1000);
    try {
      const result = await onAnalyze(n, refresh, (phase, message) => { aiPhase = phase; aiMessage = message; if (node.isConnected) renderAI(); });
      if (!Array.isArray(result?.areas)) throw new Error('The server returned no usable AI outlines.');
      suggestions.set(n, result); loaded.set(n, result); analyzed.add(n); aiErrors.delete(n);
      if (at === n) status.textContent = 'AI analysis finished. Your current outlines stay until you preview the suggestion.';
    } catch (error) {
      aiErrors.set(n, `${error.message} Your current outlines are kept.`);
      if (at === n) status.textContent = `${error.message} Your current outlines are kept.`;
    } finally {
      clearInterval(aiTimer); aiTimer = null; aiBusy = null;
      if (node.isConnected) renderAll();
    }
  }

  /** The Apply button says how many pages have draft changes; the pages are listed to go to them (see the changes). */
  function renderApply() {
    const pages = [...dirty].sort((x, y) => x - y);
    save.innerHTML = icon('check');
    save.append(!built() ? `Apply changes & build the book${pages.length ? ` (${pages.length} page${pages.length === 1 ? '' : 's'} changed)` : ''}`
      : pages.length > 1 ? `Apply changes to ${pages.length} pages`
        : `Apply changes to page ${pages[0] ?? at}`);
    save.title = built() ? 'Save the layout and make again only the pages with changes; the other pages of the book stay as they are'
      : 'Save every draft change of this layout and build the book with it';
    save.classList.toggle('attention', pages.length > 0 && !applying);
    if (applying) return;
    applyBar.hidden = true;
    applyInfo.replaceChildren(pages.length
      ? el('div', { class: 'layout-changed-pages' }, el('span', { class: 'hint' }, 'Changes not applied yet, on page:'),
        ...pages.slice(0, 40).map((n) => el('button', { class: `link-btn layout-changed-page${n === at ? ' on' : ''}`, type: 'button', title: `Go to page ${n}`, onclick: () => show(n) }, String(n))),
        pages.length > 40 ? el('span', { class: 'hint' }, `… and ${pages.length - 40} more`) : null)
      : el('span', { class: 'hint' }, built() ? `No unapplied changes. Apply makes page ${at} again; the other pages stay as they are.`
        : 'No unapplied changes. Applying builds the whole book: a long book takes several minutes.'));
  }
  /** While the book is rebuilt: the progress, here by the button (not far down the side). */
  function showApplying(message) {
    applying = true;
    const pct = /\((\d+)%\)/.exec(message);
    applyBar.hidden = false;
    applyBar.classList.toggle('offline-progress', !pct);
    applyBar.classList.toggle('busy', !pct);
    applyBar.firstChild.style.width = pct ? `${pct[1]}%` : '';
    applyInfo.replaceChildren(el('span', { class: 'hint' }, `${message} Keep this window open${built() ? '.' : ': a long book takes several minutes.'}`));
  }
  function renderNavigation() {
    const i = numbers.indexOf(at);
    const choice = el('select', { class: 'select', 'aria-label': 'Go to source page' },
      ...numbers.map((n) => el('option', { value: n, selected: n === at }, `Page ${n}`)));
    choice.addEventListener('change', () => show(Number(choice.value)));
    navigator.replaceChildren(
      el('button', { type: 'button', class: 'btn small', disabled: i <= 0 || rereadingArea, onclick: () => show(numbers[i - 1]) }, '← Previous'),
      choice, el('span', { class: 'hint' }, `${i + 1} / ${numbers.length}`),
      el('button', { type: 'button', class: 'btn small', disabled: i + 1 >= numbers.length || rereadingArea, onclick: () => show(numbers[i + 1]) }, 'Next →'),
      el('button', { type: 'button', class: 'btn small', title: 'Undo the last layout edit', 'aria-label': 'Undo the last layout edit', disabled: !history.length, onclick: () => {
        const old = history.pop();
        old.d.areas = old.areas; old.d.custom = old.custom; old.d.edited = old.edited;
        at = old.at; sel = old.sel; areaOrderCursor = null; focusSelectionPending = sel >= 0;
        if (ordering()) orderCount = Math.min(old.orderCount ?? 0, old.areas.length);
        if (pageKey) store.set(`layout-page-${pageKey}`, at);
        page.load(loaded.get(at)?.picture || picture(at), fallbackPicture?.(at)); renderAll();
     } }, 'Undo'), scopePanel);
    choice.disabled = rereadingArea;
    save.disabled = loading.size > 0 || aiBusy !== null || rereadingArea || applying;
  }

  function renderAll() {
    if (dictating && !dictationEditor?.isConnected) stopDictation(); // (its text box went)
    renderNavigation();
    renderApply();
    renderAI();
    renderToolPanel();
    areaOrderHint.hidden = !(areaDrawing || areaOrderMode);
    if (ordering()) areaOrderHint.textContent = `Reading order: ${orderCount} box${orderCount === 1 ? '' : 'es'} numbered. Drag over the next paragraph, or click a box that has no number yet: it takes the next number.`;
    else if (areaDrawing) areaOrderHint.textContent = 'Drag over each paragraph or page section. Boxes are numbered in the order you draw them.';
    else if (areaOrderMode) areaOrderHint.textContent = areaOrderCursor
      ? 'Reference set. Click the next area to move it after the reference; each next click goes after the last area moved. Press the button again to finish.'
      : 'Click the area that should come first as your reference, then click areas in the order they should follow.';
    drawFrames();
    renderSide();
    renderStrip();
    if (focusSelectionPending) {
      focusSelectionPending = false;
      focusSelectionIntoView();
    }
  }

  function focusSelectionIntoView() {
    if (sel < 0) return;
    const keepVisible = (container, target) => {
      if (!container || !target) return;
      const c = container.getBoundingClientRect(), t = target.getBoundingClientRect(), margin = 24;
      let top = container.scrollTop, left = container.scrollLeft;
      if (t.height > c.height - margin * 2) top += (t.top + t.bottom - c.top - c.bottom) / 2;
      else if (t.top < c.top + margin) top += t.top - c.top - margin;
      else if (t.bottom > c.bottom - margin) top += t.bottom - c.bottom + margin;
      if (t.width > c.width - margin * 2) left += (t.left + t.right - c.left - c.right) / 2;
      else if (t.left < c.left + margin) left += t.left - c.left - margin;
      else if (t.right > c.right - margin) left += t.right - c.right + margin;
      container.scrollTo({ top: Math.max(0, top), left: Math.max(0, left), behavior: 'smooth' });
    };
    keepVisible(stage, pic.querySelector(`.frame[data-k="${sel}"]`));
    keepVisible(side.querySelector('.design-areas'), side.querySelector(`.design-area[data-area-index="${sel}"]`));
  }

  function drawFrames() {
    const d = mine();
    pic.classList.toggle('off', !d); // (a page of no design: its areas cannot be drawn)
    const ref = d?.areas?.indexOf(areaOrderCursor) ?? -1;
    const overlays = showBoxes ? frames(d?.areas || [], tall, sel, ref, mergePicked, ordering() ? orderCount : -1) : [];
    const data = loaded.get(at);
    let sentenceRecords = [];
    if (areaReview && areaReview.page === at) {
      let number = 0;
      for (const item of areaReview.items) {
        item.sentences.forEach((sentence, i) => { number += 1; sentenceRecords.push({ ...sentence, id: `review:${item.key}:${i}`, n: number }); });
      }
    } else if (activeToolTab === 'merge' || audioClick()) sentenceRecords = pageSentenceRecords(data, d?.areas || []); // every sentence on the page
    else if (sel >= 0) sentenceRecords = pageSentenceRecords(data, d?.areas || []).filter((sentence) => sentence.areaIndex === sel);
    const pickable = (activeToolTab === 'merge' && !areaReview && !mergeMode && !mergeAreaMode) || audioClick();
    const pickedIds = audioClick() && audioPick ? audioPick.ids : sentenceMergeOrder;
    if (showBoxes && data?.width && data?.height) {
      for (const sentence of sentenceRecords) {
        const bounds = sentence.bounds || [];
        const first = bounds[0];
        if (!first) continue;
        const pickAt = pickable ? pickedIds.indexOf(sentence.id) : -1;
        if (pickable) { // (a click on the sentence chooses it, a second click lets it go)
          for (const b of bounds) overlays.push(svg('rect', { class: `layout-sentence-hit${pickAt >= 0 ? ' picked' : ''}`, 'data-sentence': sentence.id,
            x: b.x / data.width * WIDE, y: b.y / data.height * tall, width: b.w / data.width * WIDE, height: b.h / data.height * tall, rx: 3 }));
        }
        if (sentence.id === activeSentenceId) {
          for (const b of bounds) overlays.push(svg('rect', { class: 'layout-active-sentence', x: b.x / data.width * WIDE,
            y: b.y / data.height * tall, width: b.w / data.width * WIDE, height: b.h / data.height * tall,
            rx: 3, 'pointer-events': 'none' }));
        }
        const label = String(pickAt >= 0 ? pickAt + 1 : sentence.n || sentence.localIndex + 1);
        const x = first.x / data.width * WIDE, y = first.y / data.height * tall;
        const badgeX = Math.max(11, x - 11), badgeY = Math.max(11, y + 9);
        overlays.push(svg('g', { class: `layout-sentence-number${sentence.id === activeSentenceId ? ' active' : ''}${sentence.selected === false ? ' off' : ''}${pickAt >= 0 ? ' picked' : ''}`,
          transform: `translate(${badgeX} ${badgeY})`, 'pointer-events': 'none' },
        svg('circle', { r: pickAt >= 0 ? 13 : 10 }), svg('text', { dy: '0.35em' }, label)));
      }
    }
    const lettered = [...rereadBoxes, ...(areaReview?.page === at ? areaReview.items.map((item) => item.bounds) : [])];
    lettered.forEach((r, i) => overlays.push(svg('g', { class: 'layout-reread-box', 'pointer-events': 'none' },
      svg('rect', { x: r.x * WIDE, y: r.y * tall, width: r.w * WIDE, height: r.h * tall }),
      svg('g', { transform: `translate(${Math.min(WIDE - 14, r.x * WIDE + 16)} ${Math.min(tall - 14, r.y * tall + 16)})` },
        svg('circle', { r: 14 }), svg('text', { dy: '0.35em' }, String.fromCharCode(65 + (i % 26)))))));
    const currentRect = drag?.mode === 'special' ? drag.rect : null;
    const drawn = currentRect || pictureRect;
    if (drawn) overlays.push(svg('rect', { class: 'layout-special-area', x: drawn.x * WIDE, y: drawn.y * tall,
      width: drawn.w * WIDE, height: drawn.h * tall, 'pointer-events': 'none' }));
    const size = buttonSize || data;
    if (activeToolTab === 'audio' && size && audioButtons.length) {
      for (const button of audioButtons) {
        const moving = drag?.mode === 'button' && drag.button === button && drag.p;
        const x = moving ? drag.p.x * WIDE : button.x / size.width * WIDE, y = moving ? drag.p.y * tall : button.y / size.height * tall;
        overlays.push(svg('g', { class: `layout-play-marker${moving ? ' moving' : ''}`, transform: `translate(${x} ${y})`, 'pointer-events': 'none' },
          svg('circle', { r: 15 }), svg('text', { dy: '0.35em' }, '▶')));
      }
    }
    page.g.replaceChildren(...overlays);
  }

  function textInArea(data, area) {
    if (typeof area.text === 'string') return area.text;
    if (!data?.words) return '';
    const words = data.words.filter((w) => {
      const x = (w.x + w.w / 2) / data.width, y = (w.y + w.h / 2) / data.height;
      return x >= area.x && x <= area.x + area.w && y >= area.y && y <= area.y + area.h;
    });
    const lines = new Map();
    for (const word of words) {
      const key = word.line ?? 0;
      lines.set(key, [...(lines.get(key) || []), word.t]);
    }
    return [...lines.values()].map((line) => line.join(' ')).join('\n');
  }

  function renderSide() {
    const d = mine();
    const list = el('ol', { class: 'design-areas' });
    const data = loaded.get(at);
    let n = 0;
    (d?.areas || []).forEach((a, i) => {
      const read = a.kind !== 'skip';
      if (read) n += 1;
      const text = textInArea(data, a);
      const kind = el('select', { class: 'select', 'aria-label': `What is in area ${read ? n : ''}` },
        ...KINDS.map(([v, label]) => el('option', { value: v, selected: v === a.kind }, label)));
      kind.addEventListener('change', () => { remember(); a.kind = kind.value; renderAll(); });
      const move = (by) => {
        const j = i + by;
        if (j < 0 || j >= d.areas.length) return;
        remember();
        [d.areas[i], d.areas[j]] = [d.areas[j], d.areas[i]];
        sentenceMergeOrder = [];
        sel = j; focusSelectionPending = true;
        drawFrames();
        renderAll();
      };
      list.append(el('li', { class: `design-area ${a.kind}${i === sel ? ' on' : ''}${a === areaOrderCursor ? ' reference' : ''}${mergePicked.includes(i) ? ' merge-picked' : ''}${ordering() && i >= orderCount ? ' unordered' : ''}`, dataset: { areaIndex: i }, onclick: (e) => {
        if (e.target.closest('textarea')) return;
        const rowHit = e.target === e.currentTarget || e.target.classList.contains('n') || e.target.closest('.design-area-content');
        if (ordering() && rowHit) { if (i >= orderCount) pickExisting(i); else { sel = i; focusSelectionPending = true; } renderAll(); return; }
        if (mergeMode && rowHit) { toggleMergeArea(i); return; }
        if (areaOrderMode && rowHit) { orderArea(i); return; }
        if (rowHit) {
          if (sel !== i) areaReview = null;
          sel = i; focusSelectionPending = true; drawFrames(); renderAll();
        }
      }, ondblclick: (e) => { // (double-click the text: edit it)
        if (e.target.closest('select, button') || !e.target.closest('.design-area-content')) return;
        if (ordering() || mergeMode || areaOrderMode) return;
        window.getSelection?.()?.removeAllRanges();
        const box = e.target.closest('.design-area-content');
        if (box.querySelector('textarea')) return;
        sel = i; areaReview = null; drawFrames();
        const editor = el('textarea', { class: 'input design-area-inline-editor', rows: Math.min(8, Math.max(2, text.split('\n').length)), 'aria-label': `Text of area ${read ? n : i + 1}` }, text);
        let finished = false;
        const finish = (keep) => {
          if (finished) return;
          finished = true;
          const value = editor.value.trim();
          if (keep && value !== text.trim()) {
            remember();
            if (value) a.text = value; else delete a.text;
            sentenceMergeOrder = [];
            status.textContent = `Text of area ${read ? n : i + 1} changed. Press Apply to save it in the book (Undo takes it back).`;
          }
          renderAll();
        };
        editor.addEventListener('blur', () => finish(true));
        editor.addEventListener('keydown', (ev) => {
          ev.stopPropagation();
          if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
          else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); finish(true); }
        });
        box.replaceChildren(editor);
        box.classList.remove('empty');
        status.textContent = `Editing area ${read ? n : i + 1}: type, then click outside or press Ctrl+Enter to keep it. Esc cancels.`;
        editor.focus();
      } },
        el('span', { class: 'n' }, read ? String(n) : '×'),
        el('div', { class: 'design-area-details' },
          el('div', { class: `design-area-content${text ? '' : ' empty'}`, title: text || '' }, text || (loading.has(at) ? 'Reading this page…' : 'No text detected in this area yet.')),
          el('label', { class: 'design-area-kind' }, el('span', {}, 'Read as'), kind)),
        el('button', { class: 'icon-btn', type: 'button', title: 'Read it earlier', 'aria-label': 'Read it earlier', disabled: i === 0, onclick: () => move(-1) }, '↑'),
        el('button', { class: 'icon-btn', type: 'button', title: 'Read it later', 'aria-label': 'Read it later', disabled: i === d.areas.length - 1, onclick: () => move(1) }, '↓'),
        el('button', { class: 'icon-btn', type: 'button', title: 'Remove this area', 'aria-label': 'Remove this area', onclick: () => remove(i) }, '✕')));
    });
    const state = !d.areas.length ? 'This page has no readable outlines. Add areas to include its text; saving it empty excludes all text on this page.' : '';
    const outside = data ? data.words.filter((w) => {
      const x = (w.x + w.w / 2) / data.width, y = (w.y + w.h / 2) / data.height;
      return !d.areas.some((a) => x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h);
    }).length : 0;
    const fullText = data ? [...new Map(data.words.map((w) => [w.line ?? 0, null])).keys()]
      .map((line) => data.words.filter((w) => (w.line ?? 0) === line).map((w) => w.t).join(' ')).join('\n') : '';
    side.replaceChildren(
      el('h4', {}, `Page ${at}`),
      el('p', { class: 'hint' }, data
        ? `Recognized page text (${data.words?.length || 0} words). Each box below shows its text.`
        : loading.has(at) ? 'This page is being read now. Its recognized text and paragraph outlines will appear here.'
          : hasSavedBoxes(at) ? 'Saved page boxes are shown. Read this page again to refresh the recognized text or detect missing areas.'
            : 'No page text is loaded yet. Use Read to recognize this page.'),
      data ? el('details', { class: 'layout-page-transcript' },
        el('summary', {}, 'Show all recognized page text'), el('pre', {}, fullText || 'No text was recognized on this page.')) : '',
      state ? el('p', { class: 'hint' }, state) : '',
      outside ? el('p', { class: 'hint' }, `${outside} detected words are outside the outlines and will be left out. Draw an area around any text you want to include.`) : '',
      d?.areas?.length ? el('h4', {}, 'Reading order: each area is read in sequence') : '',
      d?.areas?.length ? el('p', { class: 'hint' }, 'The text below is what was found in each box. “Read as” changes how the words become spoken sentences; it does not replace the detected text.') : '',
      d?.areas?.length ? el('details', { class: 'design-kind-help' },
        el('summary', {}, 'What do the “Read as” choices do?'),
        el('ul', {},
          el('li', {}, 'Text: keep normal sentence and paragraph grouping.'),
          el('li', {}, 'One paragraph: keep the sentences together as one paragraph.'),
          el('li', {}, 'Heading: read the whole heading together.'),
          el('li', {}, 'Separate exercise lines: keep each printed line separate.'),
          el('li', {}, 'Dialogue: remove speaker labels such as A: and B:.'),
          el('li', {}, 'New words: read each word with its meaning.'),
          el('li', {}, 'Don’t read: exclude this box from speech.'))) : '', list,
      el('p', { class: 'hint' }, 'Draw areas in order, or choose Reference order and click a starting area followed by the areas to move after it. Drag an area to move it, drag its corners to resize it, or select it to edit its bounds and text preview.'), selectedControls(d));
  }

  function orderArea(i) {
    const d = mine();
    const picked = d?.areas?.[i];
    if (!picked) return;
    if (sel !== i) { sentenceMergeOrder = []; areaReview = null; }
    if (!areaOrderCursor) {
      areaOrderCursor = picked;
      sel = i; focusSelectionPending = true;
      status.textContent = 'Reference selected. Now click the areas to place after it, one by one.';
      renderAll();
      return;
    }
    if (picked === areaOrderCursor) {
      status.textContent = 'That is already the reference. Click another area to move it after this one.';
      renderAll();
      return;
    }
    remember();
    d.areas.splice(i, 1);
    const anchor = d.areas.indexOf(areaOrderCursor);
    if (anchor < 0) { areaOrderCursor = null; renderAll(); return; }
    d.areas.splice(anchor + 1, 0, picked);
    areaOrderCursor = picked;
    sel = anchor + 1; focusSelectionPending = true;
    status.textContent = 'Area moved. Click the next area to place after it, or turn off Reference order to finish.';
    renderAll();
  }

  function selectedControls(d) {
    const a = d?.areas?.[sel];
    if (!a) return '';
    const box = el('div', { class: 'design-selected' }, el('h4', {}, 'Selected area'), el('b', { class: 'design-text-heading' }, editAreaText ? 'Edit recognized text' : 'Text in this box'));
    const data = loaded.get(at);
    const text = textInArea(data, a);
    box.append(el('p', { class: 'design-paragraph-text' }, text || (data ? 'No text found inside this outline.' : 'Load this page’s text to see the paragraph here.')));
    const sentences = pageSentenceRecords(data, d.areas).filter((sentence) => sentence.areaIndex === sel);
    if (sentences.length) box.append(el('div', { class: 'layout-area-sentences' },
      el('b', {}, `Sentences in reading order (${sentences.length})`),
      el('ol', {}, ...sentences.map((sentence) => el('li', { class: sentence.id === activeSentenceId ? 'layout-sentence-playing' : '',
        dataset: { layoutSentence: sentence.id } }, el('span', { class: 'layout-sentence-index' }, sentence.n), sentence.text,
      el('button', { class: 'icon-btn layout-sentence-play', type: 'button', title: 'Read from this sentence', 'aria-label': `Read from sentence ${sentence.n}`,
        html: icon('play'), onclick: (e) => { e.stopPropagation(); readAloud(sentence.id); } }))))));
    if (editAreaText) {
      const editor = el('textarea', { class: 'input design-area-text-editor', rows: 6, 'aria-label': 'Corrected text for this page area' }, text);
      box.append(el('p', { class: 'hint design-paragraph-text' }, 'Correct or replace the text here. Put each paragraph on its own line; saving the book layout uses this text for the area.'), editor,
        el('div', { class: 'form-buttons design-paragraph-text' },
          el('button', { class: 'btn small primary', type: 'button', onclick: () => {
            remember();
            if (editor.value.trim()) a.text = editor.value.trim(); else delete a.text;
            editAreaText = false; newTextArea = false;
            status.textContent = 'Text correction saved in this page layout. Save boxes and process book to apply it to the book.';
            renderAll();
          } }, 'Save text in layout'),
          typeof a.text === 'string' ? el('button', { class: 'btn small', type: 'button', onclick: () => {
            remember(); delete a.text; editAreaText = false;
            status.textContent = 'This area will use its OCR text again after the book is processed.'; renderAll();
          } }, 'Use OCR text again') : null));
    }
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
    return box;
  }

  function renderStrip() {
    strip.replaceChildren(el('span', { class: 'hint' }, `Pages (${numbers.length}):`),
      ...numbers.map((n) => el('button', { type: 'button', class: 'design-thumb', 'aria-current': n === at ? 'page' : null, title: `Page ${n}`, onclick: () => show(n) },
        el('img', { src: picture(n, true), alt: '', loading: 'lazy' }), el('span', {}, String(n)))));
    strip.querySelector('[aria-current]')?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  }

  function remove(i) {
    remember();
    sentenceMergeOrder = [];
    const d = mine();
    if (d.areas[i] === areaOrderCursor) areaOrderCursor = null;
    d.areas.splice(i, 1);
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
    const hit = e.target.closest('[data-sentence]');
    if (hit && activeToolTab === 'merge' && !mergeMode && !mergeAreaMode && !areaReview) { toggleSentencePick(hit.dataset.sentence); e.preventDefault(); return; }
    if (hit && audioClick()) { audioSentenceClick(hit.dataset.sentence, e); e.preventDefault(); return; }
    const markerSize = buttonSize || loaded.get(at);
    if (activeToolTab === 'audio' && buttonState === 'idle' && markerSize && onChangeButton) { // (drag a play button to move it)
      const near = audioButtons.map((b) => ({ b, far: Math.hypot((b.x / markerSize.width - p.x) * WIDE, (b.y / markerSize.height - p.y) * tall) }))
        .sort((x, y) => x.far - y.far)[0];
      if (near && near.far <= 20) {
        drag = { mode: 'button', button: near.b, from: p, p: null };
        pic.setPointerCapture(e.pointerId);
        e.preventDefault(); return;
      }
    }
    if (buttonState === 'placing' || buttonState === 'moving') {
      if (buttonTarget) {
        const method = buttonState === 'placing' ? 'POST' : 'PUT';
        void changeButton(method, buttonTarget, p);
      } else status.textContent = 'Choose a recording or a Move action first.';
      e.preventDefault(); return;
    }
    if (mergeMode && frame) { toggleMergeArea(+frame.dataset.k); e.preventDefault(); return; }
    if (areaOrderMode) {
      if (frame) orderArea(+frame.dataset.k);
      else status.textContent = 'Click an existing area box to set or move it in the reading order.';
      e.preventDefault();
      return;
    }
    if (pictureMode || mergeAreaMode || rereadDraw) {
      const special = rereadDraw ? 'reread' : pictureMode ? 'picture' : 'merge';
      drag = { mode: 'special', special, from: p, rect: null };
    } else if (areaDrawing) {
      sel = -1;
      drag = { mode: 'draw', from: p, a: null, clickFrame: ordering() && frame ? +frame.dataset.k : -1 };
    } else if (handle && sel >= 0) drag = { mode: handle.dataset.h, from: p, a: { ...d.areas[sel] } };
    else if (frame) {
      const nextSel = +frame.dataset.k;
      if (sel !== nextSel) areaReview = null;
      sel = nextSel; focusSelectionPending = true;
      drag = { mode: 'move', from: p, a: { ...d.areas[sel] } };
      renderToolPanel();
      renderSide();
    } else {
      sel = -1;
      drag = { mode: 'draw', from: p, a: null };
      renderToolPanel();
      renderSide();
    }
    pic.setPointerCapture(e.pointerId);
    drawFrames();
    e.preventDefault();
  });
  pic.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = point(e);
    const dx = p.x - drag.from.x, dy = p.y - drag.from.y;
    if (drag.mode === 'button') {
      if (drag.p || Math.hypot(dx * WIDE, dy * tall) > 4) { drag.p = p; drawFrames(); }
      e.preventDefault(); return;
    }
    if (drag.mode === 'special') {
      if (Math.hypot(dx, dy) < SMALLEST) return;
      drag.rect = { x: Math.min(p.x, drag.from.x), y: Math.min(p.y, drag.from.y), w: Math.abs(dx), h: Math.abs(dy) };
      drawFrames(); e.preventDefault(); return;
    }
    const d = mine();
    if (!drag.remembered && Math.hypot(dx, dy) > 0.001) { remember(); drag.remembered = true; }
    if (drag.mode === 'draw') {
      if (!drag.a && Math.hypot(dx, dy) < SMALLEST) return;
      d.areas ??= [];
      if (!drag.a) { drag.a = { x: p.x, y: p.y, w: 0, h: 0, kind: 'text' }; d.areas.push(drag.a); sel = d.areas.length - 1; focusSelectionPending = true; }
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
  const done = async () => {
    if (!drag) return;
    const d = mine();
    if (drag.mode === 'button') {
      const { button, p } = drag;
      drag = null;
      if (p) await changeButton('PUT', button, p); // (not moved: nothing changes)
      else drawFrames();
      return;
    }
    if (drag.mode === 'special') {
      const { special, rect } = drag;
      drag = null;
      if (!rect || rect.w < SMALLEST || rect.h < SMALLEST) { drawFrames(); renderAll(); return; }
      if (special === 'picture') {
        pictureRect = rect; pictureMode = false;
        status.textContent = 'Choose a replacement image in the Pictures tab, then replace it here.';
      } else if (special === 'reread') {
        rereadBoxes.push(rect);
        status.textContent = `${rereadBoxes.length} box${rereadBoxes.length === 1 ? '' : 'es'} drawn. Draw another, or press Read ${rereadBoxes.length === 1 ? 'box' : 'boxes'} (OCR).`;
      } else if (special === 'merge') {
        mergeAreaMode = false;
        const hits = d.areas.map((a, i) => ({ a, i })).filter(({ a }) => a.x < rect.x + rect.w && a.x + a.w > rect.x && a.y < rect.y + rect.h && a.y + a.h > rect.y).map(({ i }) => i);
        if (hits.length >= 2) mergeAreas(hits);
        else status.textContent = 'That selection contains fewer than two area boxes. Try a larger selection.';
      }
      renderAll(); return;
    }
    if (drag.mode === 'draw' && drag.a && (drag.a.w < SMALLEST || drag.a.h < SMALLEST)) { d.areas.pop(); sel = -1; }
    else if (sel >= 0 && d?.areas[sel] && (d.areas[sel].w < SMALLEST || d.areas[sel].h < SMALLEST)) Object.assign(d.areas[sel], drag.a);
    const finished = drag;
    drag = null;
    if (ordering() && finished.mode === 'draw') { // (Draw areas in reading order: the box drawn, or clicked, takes the next number)
      if (finished.a && finished.a.w >= SMALLEST && finished.a.h >= SMALLEST) takeNext(finished.a);
      else if (!finished.a && finished.clickFrame >= 0) pickExisting(finished.clickFrame);
    }
    if (newTextArea && sel >= 0) { areaDrawing = false; newTextArea = false; editAreaText = true; }
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
  function applyBoxScope() {
    const targets = scopeTargets();
    if (!targets?.length) return false;
    if (targets.length < 2 || !copyBoxesToScope.checked) return true;
    if (!confirm(`Copy the box positions and reading order from page ${at} to ${targets.length} pages? This replaces page-specific box edits on those pages.`)) return false;
    const sourceAreas = structuredClone(mine().areas || []);
    for (const n of targets) { records.set(n, { areas: structuredClone(sourceAreas), custom: true, edited: true }); dirty.add(n); }
    return true;
  }
  save.addEventListener('click', async () => {
    msg.textContent = '';
    save.disabled = true;
    stopDictation();
    const finish = () => { applying = false; save.disabled = false; renderAll(); };
    try {
      if (!applyBoxScope()) { finish(); return; }
      // A finished book: only the pages with changes are made again (this page when nothing changed).
      const pages = built() ? (dirty.size ? [...dirty] : [at]).sort((x, y) => x - y) : null;
      if (onBeforeSave && await onBeforeSave(pages) === false) { finish(); return; }
      showApplying('Saving the layout…');
      const saved = await onSave(designs.map((d) => ({ pages: d.pages, example: d.example, areas: d.areas })),
        Object.fromEntries([...records].filter(([, r]) => r.custom).map(([n, r]) => [String(n), r.areas])),
        (message) => { status.textContent = message; save.disabled = true; showApplying(message); }, pages);
      if (saved !== false) {
        dirty.clear();
        history.length = 0; // (what was applied is in the book now)
        // The pages made again: their new sentences and numbers (in reading order) and picture are shown.
        for (const n of pages || [...loaded.keys()]) loaded.delete(n);
        sentenceMergeOrder = []; activeSentenceId = null;
      }
      finish();
      if (saved !== false && node.isConnected) {
        page.load(picture(at), fallbackPicture?.(at));
        const done = status.textContent;
        await readPage(at, false);
        if (node.isConnected) status.textContent = done;
      }
    } catch (err) {
      msg.textContent = err.message;
      finish();
      applyInfo.append(el('p', { class: 'form-msg', role: 'alert' }, err.message)); // (here, where the button is)
    }
  });
  show(at);
  return node;
}

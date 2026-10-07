/* Rebuild guide: code rendering, source browser, contents, and live demos.
   window.GUIDE is injected by build_guide.py:
   { files: {path: code}, info: {path: {desc, lang}}, tree: [...], examples: {...}, stats: {...} } */
(() => {
  'use strict';
  const G = window.GUIDE || { files: {}, info: {}, tree: [], examples: {}, stats: {} };
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const store = {
    get(k, d) { try { const v = localStorage.getItem('aef3guide.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('aef3guide.' + k, JSON.stringify(v)); } catch { /* storage blocked */ } },
  };

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('Copied');
  }

  function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    a.download = name;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  // ---------------------------------------------------------------- Syntax highlighting

  const KEYWORDS = {
    py: 'def class return if elif else for while in not and or is None True False import from as with try except finally raise pass continue break lambda yield global assert del',
    js: 'const let var function return if else for while do switch case break continue new class extends constructor this super import export from default async await try catch finally throw typeof instanceof in of null undefined true false static get set',
    ps1: 'function param if else elseif foreach for while return try catch finally throw continue break switch in',
    bat: 'echo if else exit errorlevel where cd title pause not',
  };
  const RULES = {
    py: [['com', /#[^\n]*/], ['str', /[rbfu]{0,2}(?:"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')/], ['num', /\b\d[\d_]*(?:\.\d+)?\b/], ['word', /[A-Za-z_]\w*/]],
    js: [['com', /\/\/[^\n]*|\/\*[\s\S]*?\*\//], ['str', /`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/], ['num', /\b\d+(?:\.\d+)?\b/], ['word', /[A-Za-z_$][\w$]*/]],
    ps1: [['com', /<#[\s\S]*?#>|#[^\n]*/], ['str', /"(?:`.|[^"`])*"|'[^'\n]*'/], ['var', /\$[\w:]+/], ['kw', /-(?:eq|ne|lt|gt|le|ge|and|or|not|match|like|band|shl|shr)\b/], ['num', /\b\d+\b/], ['word', /[A-Za-z_][\w-]*/]],
    css: [['com', /\/\*[\s\S]*?\*\//], ['str', /"[^"\n]*"|'[^'\n]*'/], ['kw', /@[\w-]+/], ['prop', /[\w-]+(?=\s*:\s*[^:;{]*;)/], ['num', /#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|em|rem|%|s|ms|vh|vw|deg|fr)?\b/]],
    html: [['com', /<!--[\s\S]*?-->/], ['tag', /<\/?[\w-]+|\/?>/], ['attr', /[\w:-]+(?==)/], ['str', /"[^"]*"/]],
    json: [['prop', /"(?:\\.|[^"\\])*"(?=\s*:)/], ['str', /"(?:\\.|[^"\\])*"/], ['num', /-?\b\d+(?:\.\d+)?\b/], ['kw', /\b(?:true|false|null)\b/]],
    bat: [['com', /^\s*(?:rem|::)[^\n]*/], ['str', /"[^"\n]*"/], ['var', /%[\w~]+%?/], ['word', /[A-Za-z_]\w*/]],
    md: [['kw', /^#{1,6} [^\n]*/], ['str', /`[^`\n]+`/]],
    xml: [['com', /<!--[\s\S]*?-->/], ['str', /<!\[CDATA\[[\s\S]*?\]\]>/], ['tag', /<\/?[\w:-]+|\/?>/], ['attr', /[\w:-]+(?==)/], ['num', /'[^']*'|"[^"]*"/]],
    txt: [],
  };
  const compiled = {};

  function grammar(lang) {
    if (!compiled[lang]) {
      const rules = RULES[lang] || [];
      // Make inner groups non-capturing so the matched rule is the first defined group.
      const src = rules.map(([, r]) => '(' + r.source.replace(/\\\\|\\\(|\((?!\?)/g, (m) => (m === '(' ? '(?:' : m)) + ')').join('|');
      compiled[lang] = {
        rules,
        re: rules.length ? new RegExp(src, lang === 'bat' ? 'gmi' : 'gm') : null,
        kw: new Set((KEYWORDS[lang] || '').split(' ')),
      };
    }
    return compiled[lang];
  }

  function tokenize(code, lang) {
    const g = grammar(lang);
    if (!g.re) return [{ t: null, s: code }];
    const out = [];
    let last = 0, m;
    g.re.lastIndex = 0;
    while ((m = g.re.exec(code))) {
      if (!m[0]) { g.re.lastIndex++; continue; }
      if (m.index > last) out.push({ t: null, s: code.slice(last, m.index) });
      let k = 1;
      while (m[k] === undefined) k++;
      let type = g.rules[k - 1][0];
      if (type === 'word') type = g.kw.has(m[0]) ? 'kw' : code[g.re.lastIndex] === '(' ? 'fn' : null;
      out.push({ t: type, s: m[0] });
      last = g.re.lastIndex;
    }
    if (last < code.length) out.push({ t: null, s: code.slice(last) });
    return out;
  }

  function highlightLines(code, lang) {
    const lines = [[]];
    for (const tok of tokenize(code, lang)) {
      tok.s.split('\n').forEach((part, i) => {
        if (i) lines.push([]);
        if (part) lines[lines.length - 1].push(tok.t ? `<span class="t-${tok.t}">${esc(part)}</span>` : esc(part));
      });
    }
    return lines.map((l) => l.join(''));
  }

  const LANG_BY_EXT = { py: 'py', js: 'js', mjs: 'js', ps1: 'ps1', css: 'css', html: 'html', json: 'json', bat: 'bat', md: 'md', xml: 'xml', txt: 'txt', webmanifest: 'json', sh: 'txt' };
  const langOf = (path) => G.info[path]?.lang || LANG_BY_EXT[path.split('.').pop().toLowerCase()] || 'txt';

  /** A rendered code block. */
  function codeBlock({ code, lang, start = 1, path = '', label = '', hl = null, tall = false, nonum = false }) {
    const wrap = document.createElement('div');
    wrap.className = 'code' + (tall ? ' tall' : '') + (nonum ? ' nonum' : '');
    const lines = highlightLines(code.replace(/\s+$/, ''), lang);
    const end = start + lines.length - 1;
    const head = document.createElement('div');
    head.className = 'code-head';
    head.innerHTML = `<span class="path">${esc(label || path || lang)}</span>` +
      (path && !nonum ? `<span class="lines">lines ${start}–${end}</span>` : '');
    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => copy(code));
    head.append(copyBtn);
    if (path && G.files[path] && !tall) {
      const open = document.createElement('button');
      open.textContent = 'Open full file';
      open.addEventListener('click', () => openSource(path, [start, end]));
      head.append(open);
    }
    const pre = document.createElement('pre');
    pre.innerHTML = lines.map((l, i) => {
      const n = start + i;
      const on = hl && n >= hl[0] && n <= hl[1];
      return `<span class="ln${on ? ' hl' : ''}" data-n="${n}">${l || ' '}</span>`;
    }).join('');
    wrap.append(head, pre);
    return wrap;
  }

  /** Find a block of code in a file: from the line containing `from` to the end of its block. */
  function extract(path, from, to, count) {
    const code = G.files[path];
    if (code == null) return null;
    const lines = code.split('\n');
    const s = lines.findIndex((l) => l.includes(from));
    if (s < 0) return null;
    let start = s;
    while (start > 0 && /^\s*(\/\/|#(?!!)|\/\*\*|\*|<#)/.test(lines[start - 1])) start--; // include the comment above
    let e = s;
    if (to) {
      e = lines.findIndex((l, i) => i >= s && l.includes(to));
      if (e < 0) e = s;
    } else if (count) {
      e = Math.min(lines.length - 1, s + count - 1);
    } else {
      const ind = lines[s].match(/^\s*/)[0].length;
      for (let i = s + 1; i < lines.length; i++) {
        const l = lines[i];
        if (!l.trim()) continue;
        const li = l.match(/^\s*/)[0].length;
        if (li <= ind) {
          if (/^\s*([}\])]|<\/)/.test(l)) e = i;
          break;
        }
        e = i;
      }
    }
    const block = lines.slice(start, e + 1);
    const pad = Math.min(...block.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
    return { start: start + 1, end: e + 1, text: block.map((l) => l.slice(pad)).join('\n') };
  }

  function renderSnippets() {
    for (const el of $$('.snip')) {
      const path = el.dataset.file;
      const part = el.dataset.from ? extract(path, el.dataset.from, el.dataset.to, Number(el.dataset.n) || 0)
        : G.files[path] != null ? { start: 1, end: G.files[path].split('\n').length, text: G.files[path] } : null;
      if (!part) {
        el.innerHTML = `<div class="code"><div class="snip-missing">Could not find “${esc(el.dataset.from || '')}” in ${esc(path)}</div></div>`;
        continue;
      }
      el.replaceWith(codeBlock({ code: part.text, lang: langOf(path), start: part.start, path, label: el.dataset.title ? `${path} — ${el.dataset.title}` : path }));
    }
    for (const el of $$('script.codeblock')) {
      const code = el.textContent.replace(/^\n/, '');
      el.replaceWith(codeBlock({ code, lang: el.dataset.lang || 'txt', label: el.dataset.title || '', nonum: true }));
    }
    for (const el of $$('.example')) {
      const data = G.examples[el.dataset.key];
      const code = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      el.replaceWith(codeBlock({ code: code ?? '(missing)', lang: el.dataset.lang || 'json', label: el.dataset.title || '', nonum: true }));
    }
  }

  // ---------------------------------------------------------------- Source browser & file tree

  let currentSource = null;
  function buildSourceBrowser() {
    const list = $('#srcb-list');
    if (!list) return;
    const groups = {};
    for (const path of Object.keys(G.files)) {
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '(main folder)';
      (groups[dir] = groups[dir] || []).push(path);
    }
    for (const [dir, paths] of Object.entries(groups)) {
      const h = document.createElement('div');
      h.className = 'grp';
      h.textContent = dir;
      list.append(h);
      for (const p of paths) {
        const b = document.createElement('button');
        b.textContent = p.split('/').pop();
        b.dataset.path = p;
        b.title = G.info[p]?.desc || p;
        b.addEventListener('click', () => showSource(p));
        list.append(b);
      }
    }
    showSource(Object.keys(G.files).find((p) => p.endsWith('main.js')) || Object.keys(G.files)[0]);
  }

  function showSource(path, hl) {
    const view = $('#srcb-view');
    if (!view || G.files[path] == null) return;
    currentSource = path;
    $$('#srcb-list button').forEach((b) => b.classList.toggle('on', b.dataset.path === path));
    const lines = G.files[path].split('\n').length;
    const info = document.createElement('div');
    info.className = 'srcb-info';
    info.innerHTML = `<b>${esc(path)}</b> <span class="muted">· ${lines} lines</span><br><span class="muted">${esc(G.info[path]?.desc || '')}</span>`;
    const block = codeBlock({ code: G.files[path], lang: langOf(path), path, tall: true, hl });
    const dl = document.createElement('button');
    dl.textContent = 'Download';
    dl.addEventListener('click', () => download(path.split('/').pop(), G.files[path]));
    block.querySelector('.code-head').append(dl);
    view.replaceChildren(info, block);
    if (hl) {
      const line = block.querySelector(`.ln[data-n="${hl[0]}"]`);
      const pre = block.querySelector('pre');
      if (line) pre.scrollTop = line.offsetTop - 60;
    }
  }

  function openSource(path, hl) {
    showSource(path, hl);
    $('#source-code')?.scrollIntoView({ behavior: 'smooth' });
  }

  function renderTree() {
    const host = $('#file-tree');
    if (!host) return;
    const build = (nodes) => {
      const ul = document.createElement('ul');
      for (const n of nodes) {
        const li = document.createElement('li');
        const row = document.createElement('div');
        row.className = 'row';
        const name = document.createElement('span');
        const kind = n.children ? 'dir' : n.kind;
        name.className = `name ${kind === 'code' ? 'file' : kind}`;
        name.textContent = n.name + (n.children ? '/' : '');
        if (kind === 'code' && G.files[n.path]) name.addEventListener('click', () => openSource(n.path));
        const desc = document.createElement('span');
        desc.className = 'desc';
        desc.textContent = n.desc || '';
        row.append(name, desc);
        li.append(row);
        if (n.children) {
          if (n.kind === 'gen') name.classList.add('gen');
          if (n.kind === 'orig') name.classList.add('orig');
          li.append(build(n.children));
        }
        ul.append(li);
      }
      return ul;
    };
    host.append(build(G.tree));
  }

  // ---------------------------------------------------------------- Contents, search, theme

  function buildToc() {
    const toc = $('#toc-list');
    const heads = $$('main h2[id], main h3[id]');
    const items = heads.map((h, i) => {
      const li = document.createElement('li');
      li.className = h.tagName === 'H2' ? 'lvl2' : 'lvl3';
      const a = document.createElement('a');
      a.href = '#' + h.id;
      a.textContent = h.dataset.toc || h.textContent;
      li.append(a);
      toc.append(li);
      // Text of the section, for the contents filter.
      const next = heads.slice(i + 1).find((x) => h.tagName === 'H3' || x.tagName === 'H2');
      const r = document.createRange();
      r.setStartBefore(h);
      if (next) r.setEndBefore(next); else r.setEndAfter($('main').lastElementChild);
      return { h, li, a, text: r.toString().toLowerCase() };
    });
    toc.addEventListener('click', () => document.body.classList.remove('toc-open'));

    $('#toc-search').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      let shown = 0;
      for (const it of items) {
        const hit = !q || it.text.includes(q);
        it.li.classList.toggle('hidden', !hit);
        if (hit) shown++;
      }
      $('#toc-empty').hidden = shown > 0;
    });

    let ticking = false;
    const spy = () => {
      ticking = false;
      let cur = items[0];
      for (const it of items) if (it.h.getBoundingClientRect().top < 110) cur = it;
      items.forEach((it) => it.a.classList.toggle('active', it === cur));
    };
    addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(spy); } }, { passive: true });
    spy();
  }

  function initTheme() {
    const saved = store.get('theme', null);
    if (saved) document.documentElement.dataset.theme = saved;
    $('#theme-toggle').addEventListener('click', () => {
      const dark = document.documentElement.dataset.theme
        ? document.documentElement.dataset.theme === 'dark'
        : matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.dataset.theme = dark ? 'light' : 'dark';
      store.set('theme', document.documentElement.dataset.theme);
    });
    $('#toc-toggle').addEventListener('click', () => document.body.classList.toggle('toc-open'));
  }

  function initLightbox() {
    document.addEventListener('click', (e) => {
      const img = e.target.closest('figure img');
      if (!img) return;
      const box = document.createElement('div');
      box.className = 'lightbox';
      const cap = img.closest('figure').querySelector('figcaption')?.textContent || '';
      box.innerHTML = `<img src="${img.src}" alt=""><p>${esc(cap)}</p>`;
      const close = () => box.remove();
      box.addEventListener('click', close);
      document.addEventListener('keydown', function onKey(ev) { if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } });
      document.body.append(box);
    });
  }

  function initChecklist() {
    const items = $$('.checklist li[data-check]');
    const bar = $('#check-progress div');
    const done = store.get('checks', {});
    const update = () => {
      const n = items.filter((li) => li.querySelector('input').checked).length;
      if (bar) bar.style.width = `${(n / Math.max(1, items.length)) * 100}%`;
      const label = $('#check-count');
      if (label) label.textContent = `${n} of ${items.length} done`;
    };
    for (const li of items) {
      const box = li.querySelector('input');
      box.checked = !!done[li.dataset.check];
      li.classList.toggle('done', box.checked);
      box.addEventListener('change', () => {
        done[li.dataset.check] = box.checked;
        li.classList.toggle('done', box.checked);
        store.set('checks', done);
        update();
      });
    }
    update();
  }

  function fillStats() {
    for (const el of $$('[data-stat]')) {
      const v = el.dataset.stat.split('.').reduce((o, k) => (o == null ? o : o[k]), G.stats);
      if (v != null) el.textContent = typeof v === 'number' ? v.toLocaleString('en-US') : v;
    }
  }

  // ---------------------------------------------------------------- Speech helper (for demos)

  const TTS = {
    ok: 'speechSynthesis' in window,
    voices() { return this.ok ? speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang)) : []; },
    fillSelect(sel) {
      const fill = () => {
        const vs = this.voices().sort((a, b) => (/natural/i.test(b.name) - /natural/i.test(a.name)) || a.name.localeCompare(b.name));
        sel.innerHTML = vs.length ? vs.map((v, i) => `<option value="${i}">${esc(v.name.replace(/^Microsoft /, ''))} (${v.lang})</option>`).join('') : '<option>No English voices</option>';
        sel._voices = vs;
      };
      fill();
      if (this.ok) speechSynthesis.addEventListener('voiceschanged', fill);
    },
    /** Speak a list of words; onWord(i) gets the index of the word being spoken. */
    speak(words, { voice, rate = 1, onWord, onEnd } = {}) {
      if (!this.ok) { toast('This browser cannot speak. Use Edge or Chrome.'); return; }
      let text = '';
      const starts = [];
      words.forEach((w) => { starts.push(text.length); text += w + ' '; });
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text.trim());
      if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = 'en-US';
      u.rate = rate;
      u.onboundary = (e) => {
        if (e.name && e.name !== 'word') return;
        let k = 0;
        for (let i = 0; i < starts.length; i++) if (starts[i] <= e.charIndex) k = i;
        onWord?.(k);
      };
      u.onend = () => onEnd?.();
      u.onerror = () => onEnd?.();
      speechSynthesis.speak(u);
    },
    stop() { if (this.ok) speechSynthesis.cancel(); },
  };

  // ---------------------------------------------------------------- Demo: tiles

  function tileDemo(root) {
    const grid = $('.grid-overlay', root), info = $('.out', root), sel = $('select', root);
    const show = (cell) => {
      const z = Number(sel.value), n = 2 ** z, c = Number(cell.dataset.c), row = Number(cell.dataset.r);
      $$('.on', grid).forEach((d) => d.classList.remove('on'));
      cell.classList.add('on');
      info.textContent =
        `File:      <page folder>/${z}/${c}/${row}.png\n` +
        `Column:    ${c}   (counted from the LEFT)\n` +
        `Row:       ${row}   (counted from the BOTTOM: TMS layout)\n` +
        `Paste at:  x = ${c} × 124 = ${c * 124}\n` +
        `           y = (${n} − 1 − ${row}) × 156 = ${(n - 1 - row) * 156}\n` +
        `Zoom ${z}:    ${n} × ${n} tiles → ${n * 124} × ${n * 156} px page`;
    };
    const build = () => {
      const n = 2 ** Number(sel.value);
      grid.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
      grid.style.gridTemplateRows = `repeat(${n}, 1fr)`;
      grid.replaceChildren();
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          const d = document.createElement('div');
          d.dataset.c = c;
          d.dataset.r = n - 1 - r;
          grid.append(d);
        }
      }
      show(grid.children[grid.children.length - n]); // bottom-left tile = row 0
    };
    grid.addEventListener('pointerover', (e) => { if (e.target.dataset.c) show(e.target); });
    sel.addEventListener('change', build);
    build();
  }

  // ---------------------------------------------------------------- Demo: coordinates

  function coordDemo(root) {
    const pageEl = $('.page-demo', root), out = $('.out', root);
    const lonIn = $('[name=lon]', root), latIn = $('[name=lat]', root);
    const cross = document.createElement('div');
    cross.className = 'crosshair';
    pageEl.append(cross);
    const W = 1984, H = 2496;
    const place = (lon, lat, title) => {
      const x = lon, y = H - lat;
      cross.style.left = `${(x / W) * 100}%`;
      cross.style.top = `${(y / H) * 100}%`;
      lonIn.value = Math.round(lon);
      latIn.value = Math.round(lat);
      out.textContent =
        (title ? `${title}\n\n` : '') +
        `Original (OpenLayers map units):  lon = ${Math.round(lon)}, lat = ${Math.round(lat)}\n` +
        `Image pixels (y from the top):    x = lon = ${Math.round(x)}\n` +
        `                                  y = 2496 − lat = ${Math.round(y)}\n` +
        `CSS position on the page:         left: ${((x / W) * 100).toFixed(2)}%;  top: ${((y / H) * 100).toFixed(2)}%`;
    };
    for (const a of G.examples.hotspots || []) {
      const b = document.createElement('button');
      b.className = `marker ${a.t}`;
      b.title = a.title;
      b.style.left = `${(a.lon / W) * 100}%`;
      b.style.top = `${((H - a.lat) / H) * 100}%`;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        $$('.marker', pageEl).forEach((m) => m.classList.remove('sel'));
        b.classList.add('sel');
        place(a.lon, a.lat, `${a.t.toUpperCase()}: ${a.title}`);
      });
      pageEl.append(b);
    }
    pageEl.addEventListener('click', (e) => {
      const r = pageEl.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * W, y = ((e.clientY - r.top) / r.height) * H;
      place(x, H - y, 'You clicked here');
    });
    const fromInputs = () => place(Number(lonIn.value) || 0, Number(latIn.value) || 0, 'Typed values');
    lonIn.addEventListener('input', fromInputs);
    latIn.addEventListener('input', fromInputs);
    $('.marker', pageEl)?.click();
  }

  // ---------------------------------------------------------------- Demo: sentence & clause splitting (port of segment_text.py)

  const ABBREV = new Set(['mr.', 'mrs.', 'ms.', 'dr.', 'st.', 'vs.', 'etc.', 'e.g.', 'i.e.', 'p.', 'pp.', 'a.m.', 'p.m.', 'no.', 'jr.', 'sr.', 'approx.', 'ex.', 'esp.', 'u.s.', 'u.k.']);
  const SENT_END = /([.!?]|\.\.\.|…)["'”’)\]]*$/;
  const CLAUSE_END = /[,;:]["'”’)\]]*$|[—–]$/;
  const DASHES = new Set(['-', '—', '–']);
  const SUBORD = new Set('because although though while whereas unless until if when whenever where wherever since which who whom whose before after'.split(' '));
  const COORD = new Set('and but or so yet'.split(' '));

  function isSentenceEnd(tok, nxt) {
    if (!SENT_END.test(tok)) return false;
    const low = tok.toLowerCase().replace(/^["'”’()[\]]+|["'”’()[\]]+$/g, '');
    if (ABBREV.has(low) || /^[A-Z]\.$/.test(tok)) return false;
    if (nxt == null) return true;
    return /^["'“‘([]?[A-Z0-9]/.test(nxt);
  }

  function splitClauses(tokens, a, b) {
    const isBreak = (t) => CLAUSE_END.test(t) || DASHES.has(t);
    const run = new Array(b - a + 1).fill(0);
    for (let i = b - 1; i >= a; i--) run[i - a] = isBreak(tokens[i]) || i === b - 1 ? 1 : 1 + run[i - a + 1];
    const cuts = [a];
    for (let i = a + 1; i < b; i++) {
      const prev = tokens[i - 1], cur = tokens[i].toLowerCase().replace(/^["'“‘(]+|["'“‘(]+$/g, '');
      const before = i - cuts[cuts.length - 1], after = run[i - a];
      if (isBreak(prev)) cuts.push(i);
      else if (SUBORD.has(cur) && before >= 2 && after >= 2) cuts.push(i);
      else if (COORD.has(cur) && before >= 4 && after >= 4) cuts.push(i);
    }
    cuts.push(b);
    const ranges = [];
    for (let k = 0; k < cuts.length - 1; k++) if (cuts[k + 1] > cuts[k]) ranges.push([cuts[k], cuts[k + 1]]);
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && last[1] - last[0] === 1) last[1] = r[1]; else merged.push(r);
    }
    if (merged.length > 1 && merged[merged.length - 1][1] - merged[merged.length - 1][0] === 1) {
      const last = merged.pop();
      merged[merged.length - 1][1] = last[1];
    }
    return merged;
  }

  function segmentText(text) {
    const words = [], sents = [], clauses = [], blocks = [];
    for (const para of text.split(/\n+/)) {
      const tokens = para.split(/\s+/).filter(Boolean);
      if (!tokens.length) continue;
      const base = words.length, firstSent = sents.length;
      words.push(...tokens);
      let s = 0;
      for (let i = 0; i < tokens.length; i++) {
        const nxt = i + 1 < tokens.length ? tokens[i + 1] : null;
        if (nxt == null || isSentenceEnd(tokens[i], nxt)) {
          sents.push([base + s, base + i + 1]);
          for (const c of splitClauses(tokens, s, i + 1)) clauses.push([base + c[0], base + c[1]]);
          s = i + 1;
        }
      }
      blocks.push([firstSent, sents.length]);
    }
    return { words, sents, clauses, blocks };
  }

  function segDemo(root) {
    const ta = $('textarea', root), view = $('.seg-out', root), list = $('.seg-list', root), counts = $('.counts', root);
    const voiceSel = $('select', root);
    TTS.fillSelect(voiceSel);
    let mode = 'sentence', doc = null, spans = [];
    $$('.seg button', root).forEach((b) => b.addEventListener('click', () => {
      mode = b.dataset.mode;
      $$('.seg button', root).forEach((x) => x.classList.toggle('on', x === b));
    }));
    const unitAt = (w) => {
      if (mode === 'word') return [w, w + 1];
      const table = mode === 'clause' ? doc.clauses : doc.sents;
      return table.find(([a, b]) => w >= a && w < b);
    };
    const mark = (cls, range) => {
      spans.forEach((s) => s.classList.remove(cls));
      if (range) for (let i = range[0]; i < range[1]; i++) spans[i].classList.add(cls);
    };
    const render = () => {
      doc = segmentText(ta.value);
      spans = [];
      view.replaceChildren();
      for (const [sa, sb] of doc.blocks) {
        const p = document.createElement('p');
        for (let s = sa; s < sb; s++) {
          const sEl = document.createElement('span');
          sEl.className = 's';
          const [a, b] = doc.sents[s];
          for (const [ca, cb] of doc.clauses.filter(([x, y]) => x >= a && y <= b)) {
            const cEl = document.createElement('span');
            cEl.className = 'c';
            for (let w = ca; w < cb; w++) {
              const wEl = document.createElement('span');
              wEl.className = 'w';
              wEl.dataset.i = w;
              wEl.textContent = doc.words[w] + ' ';
              spans[w] = wEl;
              cEl.append(wEl);
            }
            sEl.append(cEl);
          }
          p.append(sEl);
        }
        view.append(p);
      }
      list.innerHTML = doc.sents.map(([a, b]) => '<li>' + doc.clauses.filter(([x, y]) => x >= a && y <= b)
        .map(([x, y]) => `<span class="clause">${esc(doc.words.slice(x, y).join(' '))}</span>`).join('') + '</li>').join('');
      counts.textContent = `${doc.words.length} words · ${doc.sents.length} sentences · ${doc.clauses.length} clauses`;
    };
    view.addEventListener('pointerover', (e) => {
      const w = e.target.dataset?.i;
      mark('hover', w != null ? unitAt(Number(w)) : null);
    });
    view.addEventListener('pointerleave', () => mark('hover', null));
    view.addEventListener('click', (e) => {
      const w = e.target.dataset?.i;
      if (w == null) return;
      const [a, b] = unitAt(Number(w));
      TTS.speak(doc.words.slice(a, b), {
        voice: voiceSel._voices?.[voiceSel.value],
        onWord: (k) => mark('cur', [a + k, a + k + 1]),
        onEnd: () => mark('cur', null),
      });
    });
    ta.addEventListener('input', render);
    render();
  }

  // ---------------------------------------------------------------- Demo: text to speech with word highlighting

  function ttsDemo(root) {
    const ta = $('textarea', root), sel = $('select', root), rate = $('input[type=range]', root), rateOut = $('.rate', root), show = $('.tts-text', root);
    TTS.fillSelect(sel);
    if (!TTS.ok) $('.note', root).textContent = 'This browser has no speech support. Open the guide in Microsoft Edge or Google Chrome.';
    rate.addEventListener('input', () => { rateOut.textContent = `${Number(rate.value).toFixed(2)}×`; });
    const words = () => ta.value.split(/\s+/).filter(Boolean);
    const paint = (cur = -1) => { show.innerHTML = words().map((w, i) => `<span${i === cur ? ' class="cur"' : ''}>${esc(w)}</span>`).join(' '); };
    ta.addEventListener('input', () => paint());
    $('.speak', root).addEventListener('click', () => {
      TTS.speak(words(), { voice: sel._voices?.[sel.value], rate: Number(rate.value), onWord: (k) => paint(k), onEnd: () => paint() });
    });
    $('.stop', root).addEventListener('click', () => { TTS.stop(); paint(); });
    paint();
  }

  // ---------------------------------------------------------------- Demo: transcript sync

  function syncDemo(root) {
    const cues = G.examples.script || [];
    const list = $('.cues', root), slider = $('input[type=range]', root), time = $('.time', root), btn = $('.play', root);
    const dur = (cues.length ? cues[cues.length - 1].t : 0) + 8000;
    slider.max = dur;
    let ms = 0, timer = null, current = -1;
    const fmt = (t) => `${Math.floor(t / 60000)}:${String(Math.floor((t / 1000) % 60)).padStart(2, '0')}`;
    list.innerHTML = cues.map((c) => `<li><time>${fmt(c.t)}</time><span>${esc(c.x)}</span></li>`).join('');
    const items = [...list.children];
    const update = () => {
      // Same rule as Transcript.update() in web/js/media.js
      let i = -1;
      for (let k = 0; k < cues.length && cues[k].t <= ms + 120; k++) i = k;
      slider.value = ms;
      time.textContent = `${fmt(ms)} / ${fmt(dur)}`;
      if (i === current) return;
      items[current]?.classList.remove('active');
      current = i;
      if (items[i]) {
        items[i].classList.add('active');
        // Scroll only the list, never the whole guide.
        list.scrollTop = items[i].offsetTop - list.clientHeight / 2 + items[i].offsetHeight / 2;
      }
    };
    const stop = () => { clearInterval(timer); timer = null; btn.textContent = 'Play'; };
    btn.addEventListener('click', () => {
      if (timer) { stop(); return; }
      btn.textContent = 'Pause';
      timer = setInterval(() => { ms = Math.min(dur, ms + 100); update(); if (ms >= dur) stop(); }, 100);
    });
    slider.addEventListener('input', () => { ms = Number(slider.value); update(); });
    items.forEach((li, k) => li.addEventListener('click', () => { ms = cues[k].t; update(); }));
    update();
  }

  // ---------------------------------------------------------------- Demo: two-page grouping

  function spreadDemo(root) {
    const input = $('input', root), out = $('.out', root), total = 168;
    // Same rule as App.groupFor() in web/js/main.js (indexes are page number − 1).
    const groupFor = (idx) => {
      const start = idx === 0 ? 0 : idx % 2 === 1 ? idx : idx - 1;
      return start === 0 ? [0] : [start, start + 1].filter((i) => i < total);
    };
    const label = (g) => g.map((i) => i + 1).join('–');
    const run = () => {
      const p = Math.max(1, Math.min(total, Number(input.value) || 1));
      const g = groupFor(p - 1);
      const next = g[g.length - 1] + 1 < total ? groupFor(g[g.length - 1] + 1) : null;
      const prev = g[0] > 0 ? groupFor(g[0] - 1) : null;
      out.textContent = `You asked for page ${p}\nShown together: ${label(g)}\nNext button →   ${next ? label(next) : '(end of book)'}\nPrevious ←      ${prev ? label(prev) : '(start of book)'}`;
    };
    input.addEventListener('input', run);
    run();
  }

  // ---------------------------------------------------------------- Demo: HTTP Range requests

  function rangeDemo(root) {
    const size = $('[name=size]', root), header = $('[name=range]', root), out = $('.out', root);
    const run = () => {
      // Same logic as Handler.do_GET() in web/server.py
      const n = Number(size.value) || 0;
      const m = header.value.trim().match(/^bytes=(\d*)-(\d*)$/);
      if (!m) { out.textContent = '200 OK — no valid Range header, the whole file is sent'; return; }
      let start, end;
      if (m[1] === '') { start = Math.max(0, n - Number(m[2] || 0)); end = n - 1; }
      else { start = Number(m[1]); end = Math.min(m[2] ? Number(m[2]) : n - 1, n - 1); }
      if (start >= n || start > end) { out.textContent = `416 Range Not Satisfiable\nContent-Range: bytes */${n}`; return; }
      out.textContent = `206 Partial Content\nContent-Range: bytes ${start}-${end}/${n}\nContent-Length: ${end - start + 1}`;
    };
    size.addEventListener('input', run);
    header.addEventListener('input', run);
    $$('[data-range]', root).forEach((b) => b.addEventListener('click', () => { header.value = b.dataset.range; run(); }));
    run();
  }

  // ---------------------------------------------------------------- Start

  const DEMOS = { tiles: tileDemo, coords: coordDemo, seg: segDemo, tts: ttsDemo, sync: syncDemo, spread: spreadDemo, range: rangeDemo };

  initTheme();
  renderSnippets();
  renderTree();
  buildSourceBrowser();
  fillStats();
  buildToc();
  initLightbox();
  initChecklist();
  for (const el of $$('[data-demo]')) {
    try { DEMOS[el.dataset.demo]?.(el); } catch (err) { console.error('demo failed', el.dataset.demo, err); }
  }
  window.guide = { openSource, extract };
})();

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c != null && c !== false) node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const icon = (name) => `<svg class="i"><use href="#i-${name}"/></svg>`;

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('aef3.' + key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('aef3.' + key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

const jsonCache = new Map();
export function getJSON(url) {
  if (!jsonCache.has(url)) {
    const p = fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    jsonCache.set(url, p);
  }
  return jsonCache.get(url);
}

/** Drop a cached getJSON() result, e.g. after the data changed on the server. */
export function forgetJSON(url) { jsonCache.delete(url); }

export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

let toastTimer;
export function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

export function downloadText(filename, text) {
  const blob = new Blob([text.replace(/\n/g, '\r\n')], { type: 'text/plain;charset=utf-8' });
  const a = el('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/** True when keyboard focus is in a text field, so single-key shortcuts should not fire. */
export function typingInField() {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
}

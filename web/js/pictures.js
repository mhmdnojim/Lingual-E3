// Lingua Books: replacing a picture on a page of a book (web/pictures.py). In correction mode the
// owner draws a box around a picture (js/editor.js), then gives a new one: a picture of their own (a
// file, or a photo taken with the phone), or one an AI image service makes from what they write —
// from the old picture too, if they like (admins only: each picture costs money). It fills the box on
// the page and in the book's PDF; the words of the old picture leave the page's text; it can be taken back.
import { $, el, store, toast } from './util.js';
import { openDialog, closeDialog } from './media.js';
import { serverPhoto } from './library.js';

async function api(method, url, body) {
  const r = await fetch(url, {
    method, headers: body !== undefined && !(body instanceof Blob) ? { 'Content-Type': 'application/json' } : {},
    body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
  }).catch(() => null);
  if (!r) throw new Error('The app could not reach its server.');
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
  return d;
}

/** The part of the page in rect (the old picture), drawn on a canvas. */
function oldPicture(view, rect) {
  const img = view.el.querySelector('.page-img');
  const k = Math.min(1, 480 / Math.max(rect.w, rect.h));
  const canvas = el('canvas', { class: 'pic-old', width: Math.round(rect.w * k), height: Math.round(rect.h * k), 'aria-label': 'The picture now' });
  const sx = img.naturalWidth / view.W, sy = img.naturalHeight / view.H;
  canvas.getContext('2d').drawImage(img, rect.x * sx, rect.y * sy, rect.w * sx, rect.h * sy, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** The page's text around rect (not in it): the 60 words nearest it, in the order they are read — what
 * the picture goes with, for the AI (at most 400 characters). */
function textAround(view, rect) {
  const away = (w) => {
    const cx = w[0] + w[2] / 2, cy = w[1] + w[3] / 2;
    return Math.hypot(Math.max(rect.x - cx, 0, cx - rect.x - rect.w), Math.max(rect.y - cy, 0, cy - rect.y - rect.h));
  };
  const words = (view.doc?.words || []).map((w, k) => ({ w, k, d: away(w) })).filter((x) => x.w[2] > 0 && x.d > 0);
  const nearest = words.sort((a, b) => a.d - b.d).slice(0, 60).sort((a, b) => a.k - b.k);
  return nearest.map(({ w }) => w[4] + (w[6] ? ' ' : '')).join('').trim().slice(0, 400);
}

/** Replace the picture in rect (the page's pixels) on view's page: the dialog. */
export async function replacePicture(app, view, rect) {
  const book = app.book, n = view.page.n;
  const box = [rect.x, rect.y, rect.w, rect.h].map((v) => Math.round(v));
  const words = (view.doc?.words || []).filter((w) => w[2] > 0
    && rect.x <= w[0] + w[2] / 2 && w[0] + w[2] / 2 <= rect.x + rect.w && rect.y <= w[1] + w[3] / 2 && w[1] + w[3] / 2 <= rect.y + rect.h).length;
  let chosen = null; // (the new picture: a Blob)
  const shape = `${rect.w} / ${rect.h}`;
  const preview = el('img', { class: 'pic-new', alt: 'The new picture' });
  const empty = el('p', { class: 'hint pic-empty' }, 'Choose a picture, or let AI make one.');
  const newBox = el('div', { class: 'pic-frame', style: `aspect-ratio: ${shape}` }, empty, preview);
  preview.hidden = true;
  const msg = el('p', { class: 'form-msg', role: 'alert' });
  const go = el('button', { class: 'btn primary', type: 'button', disabled: true }, 'Replace the picture');
  const show = (blob) => {
    chosen = blob;
    if (preview.src.startsWith('blob:')) URL.revokeObjectURL(preview.src);
    preview.src = URL.createObjectURL(blob);
    preview.hidden = false;
    empty.hidden = true;
    go.disabled = false;
    msg.textContent = '';
  };

  // A picture of one's own.
  const file = el('input', { type: 'file', accept: 'image/*', 'aria-label': 'Choose a picture' });
  file.addEventListener('change', async () => { if (file.files[0]) show(await serverPhoto(file.files[0])); });
  const own = el('div', { class: 'pic-way' }, el('label', { class: 'field' }, el('span', {}, 'A picture of yours (or a photo)'), file));

  // Made by AI (pictures.py: OpenAI's images service), for admins: its key kept on the server.
  const ai = el('div', { class: 'pic-way' }, el('p', { class: 'hint' }, 'Asking whether AI can make pictures here…'));
  const info = await api('GET', '/api/picture-ai').catch(() => ({ ready: false, admin: false }));
  // Without a description the AI makes the old picture again, new (with the page's text around it);
  // each try is shown first, and kept: make another until one is liked, then Replace.
  const context = textAround(view, rect);
  const aiForm = () => {
    const prompt = el('textarea', { class: 'input', rows: 2, maxlength: 2000, placeholder: 'Only if you want: what should it show? For example: two teenagers talking in a school corridor, cheerful, colour illustration' });
    const like = el('input', { type: 'checkbox', checked: true });
    const make = el('button', { class: 'btn', type: 'button' }, 'Make a picture');
    const state = el('p', { class: 'hint', 'aria-live': 'polite' }, 'Without a description, the AI draws the old picture again, as a new one.');
    const tries = el('div', { class: 'pic-tries', 'aria-label': 'The pictures made: choose one' });
    const pick = (blob, button) => {
      show(blob);
      tries.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
    };
    const sync = () => { // (no description: only from the old picture)
      like.disabled = !prompt.value.trim();
      if (like.disabled) like.checked = true;
    };
    prompt.addEventListener('input', sync);
    sync();
    make.addEventListener('click', async () => {
      make.disabled = true;
      state.textContent = 'The AI is making the picture… (up to a minute)';
      try {
        const d = await api('POST', '/api/picture-ai', { book: book.id, page: n, box, prompt: prompt.value, like: like.checked, context });
        const blob = await (await fetch(d.image)).blob();
        const k = tries.childElementCount + 1;
        const button = el('button', { type: 'button', class: 'pic-try', title: `Picture ${k}`, 'aria-label': `Picture ${k}` },
          el('img', { src: URL.createObjectURL(blob), alt: '' }), el('span', {}, String(k)));
        button.addEventListener('click', () => pick(blob, button));
        tries.append(button);
        pick(blob, button);
        state.textContent = 'Like it? Replace the picture. If not: make another — or describe what you want, and make another.';
        make.textContent = 'Make another';
      } catch (err) {
        state.textContent = err.message;
      }
      make.disabled = false;
    });
    return [el('label', { class: 'field' }, el('span', {}, 'Describe it (only if you want)'), prompt),
      el('label', { class: 'check' }, like, ' Start from the old picture (with a description: the AI changes it as you say)'),
      el('div', { class: 'form-buttons' }, changeKey(), el('span', { class: 'push' }), make), state, tries];
  };
  const keyForm = () => {
    const key = el('input', { type: 'password', class: 'input', autocomplete: 'off', placeholder: 'sk-…', 'aria-label': 'The key' });
    const save = el('button', { class: 'btn', type: 'button' }, 'Save the key');
    const state = el('p', { class: 'hint', 'aria-live': 'polite' });
    save.addEventListener('click', async () => {
      if (!key.value.trim()) { key.focus(); return; }
      try {
        const d = await api('PUT', '/api/picture-ai', { key: key.value.trim() });
        if (d.ready) ai.replaceChildren(...aiForm());
      } catch (err) { state.textContent = err.message; }
    });
    return [el('p', { class: 'hint' }, 'To make pictures with AI the app needs a key of OpenAI (platform.openai.com → API keys; '
      + 'each picture costs a few cents). Keys of other AIs (Kimi, DeepSeek …) do not work: they cannot make pictures. '
      + 'The key is kept on this computer only (web/server-config.json), never shown again.'),
    el('label', { class: 'field' }, el('span', {}, 'The key'), key),
    el('div', { class: 'form-buttons' }, info.ready ? el('button', { class: 'btn', type: 'button', onclick: () => ai.replaceChildren(...aiForm()) }, 'Keep the one saved') : null, save),
    state];
  };
  // (a key saved: it can be changed — one of another AI, or a new one)
  const changeKey = () => el('button', { class: 'link-btn pic-key', type: 'button', onclick: () => ai.replaceChildren(...keyForm()) }, 'Change the key');
  ai.replaceChildren(...(!info.admin ? [el('p', { class: 'hint' }, 'Only an admin can make pictures with AI: each one costs money.')]
    : info.ready ? aiForm() : keyForm()));

  const ways = el('div', { class: 'seg pic-ways', role: 'radiogroup', 'aria-label': 'Where the new picture comes from' },
    ...[['own', 'A picture of yours'], ['ai', 'Made by AI']].map(([k, label]) =>
      el('button', { type: 'button', role: 'radio', dataset: { way: k }, onclick: () => setWay(k) }, label)));
  const setWay = (k) => {
    ways.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.way === k)));
    own.hidden = k !== 'own';
    ai.hidden = k !== 'ai';
    store.set('pictureWay', k); // (the next time: the same way first)
  };
  setWay(store.get('pictureWay', 'own') === 'ai' ? 'ai' : 'own');

  const fit = el('div', { class: 'pic-fit', role: 'radiogroup' },
    ...[['cover', 'Fill the box (its edges cut if needed)'], ['contain', 'The whole picture (white around it)']].map(([v, label]) =>
      el('label', { class: 'check' }, el('input', { type: 'radio', name: 'pic-fit', value: v, checked: v === 'cover' }), ` ${label}`)));
  fit.addEventListener('change', () => { preview.style.objectFit = $('input:checked', fit).value; });
  preview.style.objectFit = 'cover';

  // The pictures replaced on this page before: each can be taken back.
  const before = el('div', { class: 'pic-before' });
  const listBefore = async () => {
    const d = await api('GET', `/api/books/${book.id}/pictures?n=${encodeURIComponent(n)}`).catch(() => ({ pictures: [] }));
    before.replaceChildren(...(d.pictures.length ? [el('h4', {}, 'Pictures replaced on this page'), ...d.pictures.map((p) => el('div', { class: 'pic-before-row' },
      el('span', {}, `${new Date(p.at * 1000).toLocaleString()} · ${p.box[2]} × ${p.box[3]}`),
      el('button', { class: 'btn small', type: 'button', onclick: async () => {
        try { await api('DELETE', `/api/books/${book.id}/pictures/${p.id}`); } catch (err) { toast(err.message); return; }
        closeDialog();
        toast('The old picture is back, on the page and in the PDF. Its words can be read again with “Re-read text by area”.');
        app.reloadBook();
      } }, 'Take it back')))] : []));
  };
  listBefore();

  go.addEventListener('click', async () => {
    if (!chosen) return;
    go.disabled = true;
    msg.textContent = '';
    const how = $('input:checked', fit).value;
    try {
      const q = new URLSearchParams({ x: box[0], y: box[1], w: box[2], h: box[3], fit: how });
      const d = await api('POST', `/api/books/${book.id}/pictures/${encodeURIComponent(n)}?${q}`, chosen);
      closeDialog();
      toast(`The picture is replaced${book.kind === 'pdf' ? ', on the page and in the book’s PDF' : ''}.${d.words ? ` ${d.words} word${d.words === 1 ? '' : 's'} of the old picture left the text.` : ''}`);
      app.reloadBook();
    } catch (err) {
      msg.textContent = err.message;
      go.disabled = false;
    }
  });

  const body = el('div', { class: 'lib-form pic-dialog' },
    el('div', { class: 'pic-compare' },
      el('figure', {}, el('figcaption', {}, 'Now'), el('div', { class: 'pic-frame', style: `aspect-ratio: ${shape}` }, oldPicture(view, rect))),
      el('figure', {}, el('figcaption', {}, 'New'), newBox)),
    ways, own, ai, fit,
    words ? el('p', { class: 'hint' }, `${words} word${words === 1 ? '' : 's'} read from the old picture will leave the page’s text.`) : null,
    book.kind === 'pdf' ? el('p', { class: 'hint' }, 'The book’s PDF changes too (download it in the book’s Settings). It can be taken back.') : null,
    before, msg,
    el('div', { class: 'form-buttons' }, el('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'Cancel'), el('span', { class: 'push' }), go));
  openDialog('Replace a picture', body, () => { if (preview.src.startsWith('blob:')) URL.revokeObjectURL(preview.src); }, { keep: true });
}

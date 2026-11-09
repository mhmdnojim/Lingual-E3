// Correction mode → Play buttons (a library book's, by its owner: web/library.py add_button,
// move_button, remove_button): its audio and video buttons dragged to another place (one that covers
// the number), taken away (one put in a wrong place: its ×), and new ones put where the owner
// clicks, for one of the book's recordings (or a file added now). What is changed by hand stays when
// the buttons are placed again.
import { $, el, icon, toast } from './util.js';

const api = async (method, url, body) => {
  const r = await fetch(url, body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `It did not work (${r.status}).`);
  return d;
};

/** Send one file (the body as it is): resolves when the server has it. */
const upload = (url, file) => fetch(url, { method: 'PUT', body: file }).then(async (r) => {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `It could not be added (${r.status}).`);
  return d;
});

export class PlayButtons {
  constructor(editor) {
    this.editor = editor;
    this.app = editor.app;
    this.book = this.app.book;
    this.choosing = false; // the list of the book's recordings shown
    this.putting = null; // a recording chosen: its button goes where the page is clicked
    this.hooks = {
      moved: (view, a, x, y) => this.change(view, 'PUT', { src: a.src, from: [a.x, a.y], x, y }, 'Moved.'),
      removed: (view, a) => {
        if (!confirm(`Take the button of “${a.title}” away from this page? (The recording stays in the book.)`)) return;
        this.change(view, 'DELETE', `?src=${encodeURIComponent(a.src)}&x=${a.x}&y=${a.y}`, 'Taken away.');
      },
    };
    this.attach();
  }

  /** The views shown now (also after turning the page) let their buttons be changed. */
  attach() {
    for (const view of this.app.views) if (view.hsEdit !== this.hooks) view.editHotspots(this.hooks);
  }

  stop() {
    this.app.views.forEach((v) => { v.stopMarking(); v.editHotspots(null); });
    document.body.classList.remove('marking');
    $('#pb-bar').hidden = true;
    $('#pb-bar').replaceChildren();
  }

  /** Esc: putting or choosing a button stops (true); else false (the tool itself then stops). */
  escape() {
    if (!this.putting && !this.choosing) return false;
    this.putting = null;
    this.choosing = false;
    this.chooserEl = null;
    this.app.views.forEach((v) => v.stopMarking());
    document.body.classList.remove('marking');
    this.editor.render();
    return true;
  }

  /** A button moved, taken away or put: the server keeps it; the page shows the buttons it has now. */
  async change(view, method, body, said) {
    const url = `/api/books/${this.book.id}/buttons/${view.page.n}`;
    try {
      const d = method === 'DELETE' ? await api(method, url + body) : await api(method, url, body);
      view.setHotspots(d.buttons);
      toast(said);
    } catch (err) {
      toast(err.message);
      view.setHotspots(view.page.a || []); // (back where it was)
    }
  }

  /**
   * Its buttons right under the tools at the top of the Text panel (they stay there while the
   * sentences scroll: always in sight), what to do under them.
   */
  draw() {
    const bar = $('#pb-bar');
    bar.hidden = false;
    if (this.putting) {
      bar.replaceChildren(el('div', { class: 'form-buttons' },
        el('button', { class: 'tbtn', type: 'button', onclick: () => this.escape() }, 'Cancel')),
      el('p', { class: 'edit-hint now' }, `Click on the page where the button of “${this.putting.title}” goes. Esc cancels.`));
      return;
    }
    const add = el('button', { class: 'tbtn pb-add', type: 'button', 'aria-pressed': String(this.choosing), html: `${icon('plus')}Add a play button…`,
      onclick: () => { this.choosing = !this.choosing; this.editor.render(); } });
    const done = el('button', { class: 'tbtn', type: 'button', html: `${icon('check')}Done with play buttons`, onclick: () => this.editor.tool('buttons') });
    if (!this.choosing) this.chooserEl = null;
    bar.replaceChildren(el('div', { class: 'form-buttons' }, add, done),
      ...(this.choosing ? [this.chooserEl ||= this.chooser()] : []), // (kept while it is drawn again)
      el('p', { class: 'hint pb-help' }, 'Drag a play button to move it (for example off the number it covers). Its × takes it away from this page '
        + '(put in a wrong place). A recording with no button: Add a play button…, choose it, then click on the page where it goes.'));
  }

  /** The book's recordings to choose one (those on no page first), or a file added now. */
  chooser() {
    const find = el('input', { type: 'search', class: 'input', placeholder: 'Find (e.g. 4.01)', 'aria-label': 'Find a recording' });
    const list = el('div', { class: 'pb-list', role: 'listbox', 'aria-label': 'The recordings of this book' }, el('p', { class: 'hint' }, 'Loading…'));
    const file = el('input', { type: 'file', accept: 'audio/*,video/*,.mp3,.m4a,.wav,.ogg,.mp4,.webm', hidden: true });
    const state = el('p', { class: 'hint', 'aria-live': 'polite' });
    let items = [];
    const show = () => {
      const q = find.value.trim().toLowerCase();
      const shown = items.filter((it) => !q || `${it.title} ${it.name}`.toLowerCase().includes(q));
      list.replaceChildren(...(shown.length ? shown.slice(0, 200).map((it) => el('button', {
        type: 'button', class: `pb-item${it.placed ? '' : ' unplaced'}`, role: 'option', onclick: () => this.choose(it),
      }, el('b', {}, it.title), ' ', el('small', {}, it.placed ? it.name : `${it.name} — on no page yet`)))
        : [el('p', { class: 'hint' }, items.length ? 'None is called so.' : 'This book has no recordings yet: add a file.')]));
    };
    const load = async (pick = null) => {
      const d = await api('GET', `/api/books/${this.book.id}/tracks`);
      items = (d.items || []).sort((x, y) => Number(x.placed) - Number(y.placed) || x.title.localeCompare(y.title, undefined, { numeric: true }));
      show();
      if (pick) this.choose(items.find((it) => it.file === pick) || null);
    };
    find.addEventListener('input', show);
    file.addEventListener('change', async () => {
      const f = file.files[0];
      if (!f) return;
      state.textContent = `Adding ${f.name}…`;
      try {
        const d = await upload(`/api/books/${this.book.id}/tracks?name=${encodeURIComponent(f.name)}`, f);
        state.textContent = '';
        await load(d.file);
      } catch (err) { state.textContent = err.message; }
    });
    load().catch((err) => { list.replaceChildren(el('p', { class: 'hint' }, err.message)); });
    setTimeout(() => find.focus(), 0);
    return el('div', { class: 'pb-chooser' }, find, list,
      el('div', { class: 'form-buttons' },
        el('button', { class: 'tbtn', type: 'button', onclick: () => file.click() }, 'Another file (audio or video)…'),
        el('button', { class: 'tbtn', type: 'button', onclick: () => { this.choosing = false; this.editor.render(); } }, 'Cancel')),
      file, state);
  }

  /** A recording chosen: the next click on a page puts its button there. */
  choose(it) {
    if (!it) return;
    this.choosing = false;
    this.putting = it;
    document.body.classList.add('marking');
    for (const view of this.app.views) {
      view.pickPoint(({ x, y }) => {
        this.app.views.forEach((v) => v.stopMarking());
        document.body.classList.remove('marking');
        this.putting = null;
        this.editor.render();
        this.change(view, 'POST', { file: it.file, x, y }, `The button of “${it.title}” is on the page. Drag it to move it.`);
      });
    }
    this.editor.render();
  }
}

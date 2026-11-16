/**
 * Admin: give books to users. Choose one or more books and one or more accounts; every account gets its
 * own private copy (it can read it, change it, delete it). "Public" makes the books public too: a
 * book of the admin as it is, another account's book as a public copy of the admin.
 * The server (library.give) does the copying and checks that the admin is one.
 */
import { el, toast } from './util.js';

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
  if (!r) throw new Error('The app could not reach its server.');
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `It did not work (${r.status}).`);
  return d;
}

/** A list of things with a find box and a tick for each: {items: [{id, label, note}], chosen: Set}. */
function picker(title, items, chosen, onChange) {
  const find = el('input', { type: 'search', class: 'input', placeholder: `Find in ${title.toLowerCase()}`, 'aria-label': `Find in ${title}` });
  const list = el('div', { class: 'give-list' });
  const count = el('span', { class: 'hint' });
  const render = () => {
    const q = find.value.trim().toLowerCase();
    const rows = items.filter((i) => !q || `${i.label} ${i.note}`.toLowerCase().includes(q));
    list.replaceChildren(...(rows.length ? rows.map((i) => {
      const box = el('input', { type: 'checkbox', dataset: { id: i.id } });
      box.checked = chosen.has(i.id);
      box.addEventListener('change', () => { box.checked ? chosen.add(i.id) : chosen.delete(i.id); count.textContent = `${chosen.size} chosen`; onChange(); });
      return el('label', { class: 'give-row' }, box, el('span', {}, i.label), el('span', { class: 'hint' }, i.note));
    }) : [el('p', { class: 'hint' }, 'Nothing found.')]));
    count.textContent = `${chosen.size} chosen`;
  };
  find.addEventListener('input', render);
  const all = el('button', { class: 'link-btn', type: 'button' }, 'Choose all shown');
  all.addEventListener('click', () => {
    const q = find.value.trim().toLowerCase();
    items.filter((i) => !q || `${i.label} ${i.note}`.toLowerCase().includes(q)).forEach((i) => chosen.add(i.id));
    render(); onChange();
  });
  const none = el('button', { class: 'link-btn', type: 'button' }, 'Clear');
  none.addEventListener('click', () => { chosen.clear(); render(); onChange(); });
  render();
  return el('section', { class: 'give-col' }, el('h3', {}, title), find, el('div', { class: 'give-tools' }, all, ' · ', none, count), list);
}

/**
 * The panel. books: [{id, title, owner, visibility, status}], users: [{id, name, email}],
 * preselect: ids of books ticked at the start, done: called after a successful give.
 */
export function giveBooksPanel({ books, users, preselect = [], done = null }) {
  const ready = books.filter((b) => b.status === 'ready');
  const chosenBooks = new Set(preselect.filter((id) => ready.some((b) => b.id === id)));
  const chosenUsers = new Set();
  const toUsers = el('input', { type: 'checkbox' }); toUsers.checked = true;
  const toPublic = el('input', { type: 'checkbox' });
  const go = el('button', { class: 'btn primary', type: 'button' }, 'Give');
  const say = el('p', { class: 'hint', role: 'status' });
  const summary = () => {
    const b = chosenBooks.size, u = toUsers.checked ? chosenUsers.size : 0;
    const parts = [];
    if (u) parts.push(`${b * u} private cop${b * u === 1 ? 'y' : 'ies'} (${b} book${b === 1 ? '' : 's'} × ${u} account${u === 1 ? '' : 's'})`);
    if (toPublic.checked && b) parts.push(`${b} made public`);
    say.textContent = b && parts.length ? `This will make: ${parts.join(' and ')}.` : 'Choose books, then accounts and/or Public.';
    go.disabled = !(b && parts.length);
  };
  toUsers.addEventListener('change', summary);
  toPublic.addEventListener('change', summary);
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      const r = await post('/api/admin/book-gifts', { books: [...chosenBooks], users: toUsers.checked ? [...chosenUsers] : [], public: toPublic.checked });
      toast(`Done: ${r.copies} cop${r.copies === 1 ? 'y' : 'ies'} given${r.public ? `, ${r.public} public` : ''}.`);
      say.replaceChildren(`Done: ${r.copies} given, ${r.public} made public.`, ...r.problems.map((p) => el('div', { class: 'give-problem' }, p)));
      done?.(r);
    } catch (err) { toast(err.message); } finally { summary(); }
  });
  const mine = (b) => b.owner || '';
  const bookItems = ready.map((b) => ({ id: b.id, label: b.title || '(no title)', note: `${mine(b)} · ${b.visibility === 'public' ? 'public' : 'private'}` }));
  const userItems = users.map((u) => ({ id: u.id, label: u.name || u.email, note: u.email || '' }));
  const panel = el('div', { class: 'give' },
    el('p', { class: 'hint' }, 'Each account you choose gets its own private copy: it can read, change and delete it. The original stays where it is.'),
    el('div', { class: 'give-cols' }, picker('Books', bookItems, chosenBooks, summary), picker('Accounts', userItems, chosenUsers, summary)),
    el('div', { class: 'give-to' },
      el('label', {}, toUsers, ' Give a private copy to the chosen accounts'),
      el('label', {}, toPublic, ' Make the chosen books public (everyone sees them)')),
    el('div', { class: 'give-go' }, go), say);
  summary();
  return panel;
}

/** All the books an admin can give from a list: their own and the public ones, each once. */
export async function giveBooksLoad() {
  const get = async (url) => (await (await fetch(url)).json().catch(() => null)) || [];
  const [mine, shared, users] = await Promise.all([get('/api/books?scope=mine'), get('/api/books?scope=all'), get('/api/admin/users')]);
  const seen = new Map();
  for (const b of [...(Array.isArray(mine) ? mine : mine.books || []), ...(Array.isArray(shared) ? shared : shared.books || [])]) seen.set(b.id, b);
  return { books: [...seen.values()], users: (users.users || []).filter((u) => !u.blocked) };
}

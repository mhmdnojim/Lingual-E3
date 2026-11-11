/**
 * The Users tab of the Admin page (web/admin_users.py): every account with its role, plan and last
 * use, found by name or e-mail; one account's page to give or take away plan days, block it, make
 * it an admin (the owner only), give it a new password, or delete it. What may be done to an
 * account is said by the server (may), which checks it again on every change.
 */
import { el, toast } from './util.js';

const api = async (method, url, body) => {
  const r = await fetch(url, body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .catch(() => null);
  if (!r) throw new Error('The app could not reach its server.');
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `It did not work (${r.status}).`);
  return d;
};

const DAY = 86400;
const day = (t) => (t ? new Date(t * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
function ago(t) {
  if (!t) return 'Never';
  const s = Date.now() / 1000 - t;
  if (s < 600) return 'Just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < DAY) return `${Math.round(s / 3600)} h ago`;
  if (s < 30 * DAY) return `${Math.round(s / DAY)} days ago`;
  return day(t);
}
const size = (n) => (n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(1)} GB` : `${Math.max(0, n / 2 ** 20).toFixed(n < 10 * 2 ** 20 ? 1 : 0)} MB`);
const ROLE = { owner: 'Owner', admin: 'Admin', user: 'User' };
const sameBooks = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** A plan in a few words: "Until 3 Dec 2026", "Starts 5 Dec", "None". */
function planText(p) {
  if (!p) return 'None';
  const books = p.books === '*' ? '' : ` (${p.books} book${p.books === 1 ? '' : 's'})`;
  return `${p.active ? 'Until' : 'Starts later, until'} ${day(p.expiresAt)}${books}`;
}

/**
 * The Users tab. o: {me (the admin: /api/me's user), plans (access codes are on: plan days can be
 * given), openDialog, closeDialog}. Returns its element; the accounts are loaded into it.
 */
export function usersAdmin(o) {
  let users = [];
  const find = el('input', { type: 'search', class: 'input', placeholder: 'Find a name or e-mail', 'aria-label': 'Find a user' });
  const filter = el('select', { class: 'select', 'aria-label': 'Which users' },
    ...[['all', 'Everyone'], ['admins', 'Admins'], ['users', 'Users'], ['blocked', 'Blocked'],
      ...(o.plans ? [['plan', 'With a plan'], ['noplan', 'Without a plan']] : [])]
      .map(([v, label]) => el('option', { value: v }, label)));
  const count = el('p', { class: 'hint' }, 'Loading the accounts…');
  const rows = el('tbody');
  const picked = new Set(); // (users ticked: their features switched together)
  const featuresBtn = el('button', { class: 'btn', type: 'button', onclick: () => featuresDialog() }, 'Features for everyone…');
  const head = ['', 'Name', 'Role', ...(o.plans ? ['Plan'] : []), 'Last seen', 'Joined', ''];
  const table = el('div', { class: 'table-scroll' }, el('table', { class: 'admin-table users-table' },
    el('thead', {}, el('tr', {}, ...head.map((h) => el('th', {}, h)))), rows));

  const shown = () => {
    const q = find.value.trim().toLowerCase();
    const f = filter.value;
    return users.filter((u) => (!q || u.name.toLowerCase().includes(q) || u.email.includes(q))
      && (f === 'all' || (f === 'admins' && u.role !== 'user') || (f === 'users' && u.role === 'user') || (f === 'blocked' && u.blocked)
        || (f === 'plan' && u.plan) || (f === 'noplan' && !u.plan)));
  };
  const draw = () => {
    const list = shown();
    count.textContent = users.length
      ? `${list.length === users.length ? '' : `${list.length} of `}${users.length} account${users.length === 1 ? '' : 's'}.`
      : 'No accounts yet: people sign up on the website.';
    for (const id of [...picked]) if (!users.some((u) => u.id === id && u.role === 'user')) picked.delete(id);
    featuresBtn.textContent = picked.size ? `Features for the ${picked.size} chosen…` : 'Features for everyone…';
    rows.replaceChildren(...list.map((u) => el('tr', { dataset: { user: u.id } },
      el('td', { class: 'pick' }, u.role === 'user' ? el('input', { type: 'checkbox', checked: picked.has(u.id), 'aria-label': `Choose ${u.name}`,
        onchange: (e) => { if (e.target.checked) picked.add(u.id); else picked.delete(u.id); draw(); } }) : null),
      el('td', {}, el('b', {}, u.name), u.id === o.me.id ? el('span', { class: 'badge' }, 'You') : null,
        u.blocked ? el('span', { class: 'badge warn' }, 'Blocked') : null, el('div', { class: 'hint' }, u.email)),
      el('td', {}, el('span', { class: `badge role-${u.role}` }, ROLE[u.role])),
      ...(o.plans ? [el('td', {}, u.role === 'user' ? planText(u.plan) : 'All (admin)')] : []),
      el('td', {}, ago(u.lastSeen)), el('td', {}, day(u.created)),
      el('td', { class: 'admin-acts' }, el('button', { class: 'btn small', type: 'button', onclick: () => open(u.id) }, 'Open')))));
    if (users.length && !list.length) rows.append(el('tr', {}, el('td', { colspan: head.length }, 'No account fits.')));
  };
  const load = async () => {
    try { users = (await api('GET', '/api/admin/users')).users; } catch (err) { count.textContent = err.message; return; }
    draw();
  };
  find.addEventListener('input', draw);
  filter.addEventListener('change', draw);

  /** The features switched for everyone (no user ticked), or on / off for the ticked users. */
  async function featuresDialog() {
    let d;
    try { d = await api('GET', '/api/admin/features'); } catch (err) { toast(err.message); return; }
    const ids = [...picked];
    const set = async (feature, value, said) => {
      try { d = await api('POST', '/api/admin/features', { users: ids.length ? ids : 'everyone', feature, value }); } catch (err) { toast(err.message); return; }
      toast(said);
      if (!ids.length) o.openDialog('Features for everyone', body());
    };
    const body = () => el('div', { class: 'user-page features-all' },
      el('p', { class: 'hint' }, ids.length
        ? `For the ${ids.length} chosen user${ids.length === 1 ? '' : 's'}: switch a feature on or off, or back to “as for everyone”.`
        : 'For everyone who has no setting of their own. An account’s own setting (on its page) counts first. Admins always have everything.'),
      el('div', { class: ids.length ? '' : 'feature-list' }, ...d.features.map((f) => {
        if (!ids.length) {
          const box = el('input', { type: 'checkbox', checked: f.on, dataset: { feature: f.key } });
          box.addEventListener('change', () => set(f.key, box.checked, `${f.name}: ${box.checked ? 'on' : 'off'} for everyone.`));
          return el('label', { class: 'check' }, box, ` ${f.name}`);
        }
        return el('div', { class: 'ai-give', dataset: { feature: f.key } }, el('b', { style: 'min-width: 200px' }, f.name),
          el('button', { class: 'btn small', type: 'button', onclick: () => set(f.key, true, `${f.name}: on for the chosen.`) }, 'On'),
          el('button', { class: 'btn small', type: 'button', onclick: () => set(f.key, false, `${f.name}: off for the chosen.`) }, 'Off'),
          el('button', { class: 'link-btn', type: 'button', onclick: () => set(f.key, null, `${f.name}: as for everyone.`) }, 'As for everyone'));
      })),
      el('p', { class: 'hint' }, 'The paid AI services (scripts, AI pictures, AI page layouts) are given to one account at a time, as an amount: open the user.'));
    o.openDialog(ids.length ? 'Features for the chosen users' : 'Features for everyone', body());
  }

  let publicBooks = null; // (for days given for chosen books: the ready, shared books)
  let plans = [];         // (the plans offered: one can be given as it is)
  async function open(id) {
    let d;
    try { d = await api('GET', `/api/admin/users/${id}`); } catch (err) { toast(err.message); return; }
    if (o.plans && !publicBooks) {
      publicBooks = (await api('GET', '/api/books?scope=all').catch(() => []))
        .filter((b) => b.visibility === 'public' && b.status === 'ready' && !b.link);
      plans = ((await api('GET', '/api/admin/plans').catch(() => null))?.plans || []).filter((p) => p.active);
    }
    o.openDialog(`User: ${d.name}`, page(d));
  }

  /** Do an action to the account; then its page again (or the list, when it is deleted). */
  async function act(d, body, done) {
    let next;
    try { next = await api('POST', `/api/admin/users/${d.id}`, body); } catch (err) { toast(err.message); return false; }
    if (done) toast(done);
    await load();
    if (next.deleted) o.closeDialog();
    else o.openDialog(`User: ${next.name}`, page(next));
    return true;
  }

  function page(d) {
    const facts = el('dl', { class: 'about-list user-facts' },
      ...[['E-mail', d.email], ['Role', ROLE[d.role] + (d.you ? ' (you)' : '')], ['Status', d.blocked ? 'Blocked' : 'Can log in'],
        ['Joined', day(d.created)], ['Last seen', ago(d.lastSeen)], ['Books', `${d.books} (${size(d.bytes)})`]]
        .flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
    const parts = [facts];
    if (o.plans) parts.push(planPart(d));
    if (d.devices) parts.push(devicePart(d));
    if (d.role === 'user' && d.may.feature) parts.push(featurePart(d), aiPart(d));
    parts.push(accountPart(d));
    return el('div', { class: 'user-page' }, ...parts);
  }

  function planPart(d) {
    const live = d.grants.filter((g) => ['active', 'scheduled'].includes(g.status));
    const grantRows = d.grants.map((g) => el('tr', {},
      el('td', {}, g.books.includes('*') ? 'All shared books' : `${g.books.length} chosen`),
      el('td', {}, day(g.starts_at)), el('td', {}, day(g.ends_at)), el('td', {}, g.status),
      el('td', {}, g.kind === 'code' ? `Code •••• ${g.code_hint}` : (g.label || 'Given by an admin')),
      el('td', { class: 'admin-acts' }, d.may['revoke-plan'] && ['active', 'scheduled'].includes(g.status)
        ? el('button', { class: 'btn small danger-btn', type: 'button', onclick: () => {
          if (confirm(`Take this plan away from ${d.name} now?`)) act(d, { action: 'revoke-plan', grant: g.id }, 'The plan is taken away.');
        } }, 'Take away') : null)));
    const part = [el('h4', {}, 'Plan'),
      d.role !== 'user' ? el('p', { class: 'hint' }, 'Admins can open every book; they need no plan.') : null,
      grantRows.length ? el('div', { class: 'table-scroll' }, el('table', { class: 'admin-table' },
        el('thead', {}, el('tr', {}, ...['Books', 'From', 'Until', 'Status', 'How', ''].map((h) => el('th', {}, h)))), el('tbody', {}, ...grantRows)))
        : el('p', { class: 'hint' }, 'No plan yet.')];
    if (!d.may['give-days']) return el('section', { class: 'user-plan' }, ...part);

    // Give days: 7, 30, 90, 365 or another number; for all shared books or chosen ones.
    let days = 30;
    const other = el('input', { type: 'number', class: 'input', min: 1, max: 3650, placeholder: 'Other', 'aria-label': 'Other number of days' });
    const presets = el('div', { class: 'seg give-days', role: 'radiogroup', 'aria-label': 'Days' },
      ...[7, 30, 90, 365].map((n) => el('button', { type: 'button', role: 'radio', dataset: { days: n } }, `${n} days`)));
    const scope = el('select', { class: 'select', 'aria-label': 'Which books' },
      el('option', { value: '*' }, 'All shared books'), el('option', { value: 'chosen' }, 'Chosen books'));
    const chosen = el('select', { class: 'select', multiple: true, hidden: true, size: Math.min(7, Math.max(3, publicBooks?.length || 3)), 'aria-label': 'The books' },
      ...(publicBooks || []).map((b) => el('option', { value: b.id }, b.title)));
    const until = el('p', { class: 'hint give-until', 'aria-live': 'polite' });
    const give = el('button', { class: 'btn primary', type: 'button' }, 'Give the days');
    const books = () => (scope.value === '*' ? ['*'] : [...chosen.selectedOptions].map((x) => x.value));
    const show = () => {
      presets.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.days) === days && !other.value)));
      chosen.hidden = scope.value === '*';
      // (as the server adds them: after a plan of the same books not ended yet)
      const now = Date.now() / 1000;
      const start = Math.max(now, ...live.filter((g) => sameBooks(g.books, books())).map((g) => g.ends_at));
      until.textContent = days >= 1 && days <= 3650 ? `Access until ${day(start + days * DAY)}.` : 'Give from 1 to 3,650 days.';
    };
    presets.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      days = Number(b.dataset.days);
      other.value = '';
      show();
    });
    other.addEventListener('input', () => { days = Number(other.value) || 30; show(); });
    scope.addEventListener('change', show);
    chosen.addEventListener('change', show);
    give.addEventListener('click', async () => {
      const list = books();
      if (!list.length) { toast('Choose the books.'); return; }
      give.disabled = true;
      if (!await act(d, { action: 'give-days', days, books: scope.value === '*' ? '*' : list }, `${days} days given to ${d.name}.`)) give.disabled = false;
    });
    show();
    part.push(el('div', { class: 'lib-form give-form' },
      el('span', { class: 'field-label' }, 'Give days (no code needed)'), el('div', { class: 'give-row' }, presets, other),
      scope, chosen, until, el('div', { class: 'form-buttons' }, give)));
    if (plans.length && d.may['give-plan']) { // (a plan as it is: its days, books and offline time)
      const which = el('select', { class: 'select', 'aria-label': 'Plan to give' }, ...plans.map((p) => el('option', { value: p.id }, `${p.name} (${p.days} days)`)));
      part.push(el('div', { class: 'ai-give give-plan' }, el('span', { class: 'field-label' }, 'Or give a plan:'), which,
        el('button', { class: 'btn small', type: 'button', onclick: () => act(d, { action: 'give-plan', plan: Number(which.value) }, `The plan is given to ${d.name}.`) }, 'Give the plan')));
    }
    return el('section', { class: 'user-plan' }, ...part);
  }

  /** The devices the account is logged in on (at most 2 for a user): unlinked here, it is logged out there at once. */
  function devicePart(d) {
    const rows = d.devices.map((v) => el('div', { class: 'ai-give device-row', dataset: { device: v.id } },
      el('b', {}, v.name), el('span', { class: 'hint' }, `linked ${day(v.linkedAt)} · last seen ${ago(v.lastSeen)}`),
      v.inUse ? el('span', { class: 'badge public' }, 'In use') : null,
      el('button', { class: 'link-btn', type: 'button', onclick: () => {
        if (confirm(`Unlink “${v.name}”? ${d.name} is logged out there and can log in on another device.`)) act(d, { action: 'unlink-device', device: v.id }, 'Unlinked.');
      } }, 'Unlink')));
    return el('section', { class: 'user-devices' }, el('h4', {}, `Devices (${d.devices.length}${d.role === 'user' ? ' of 2' : ''})`),
      ...(rows.length ? rows : [el('p', { class: 'hint' }, 'Not logged in on any device.')]));
  }

  /** The features of an account: each on or off (a change is saved at once), or as for everyone again. */
  function featurePart(d) {
    const boxes = d.features.map((f) => {
      const box = el('input', { type: 'checkbox', checked: f.on, dataset: { feature: f.key } });
      box.addEventListener('change', () => act(d, { action: 'feature', feature: f.key, value: box.checked },
        `${f.name}: ${box.checked ? 'on' : 'off'} for ${d.name}.`));
      return el('label', { class: 'check', title: f.own == null ? 'As for everyone' : 'Set for this account' }, box, ` ${f.name}`,
        f.own != null && f.own !== f.everyone ? el('span', { class: 'badge' }, f.own ? 'only here on' : 'off here') : null);
    });
    const changed = d.features.filter((f) => f.own != null);
    return el('section', { class: 'user-features' }, el('h4', {}, 'Features'),
      el('div', { class: 'feature-list' }, ...boxes),
      changed.length ? el('div', { class: 'form-buttons user-acts' }, el('button', { class: 'link-btn', type: 'button', onclick: async () => {
        for (const f of changed.slice(0, -1)) await api('POST', `/api/admin/users/${d.id}`, { action: 'feature', feature: f.key, value: null }).catch(() => {});
        act(d, { action: 'feature', feature: changed.at(-1).key, value: null }, 'As for everyone again.');
      } }, 'As for everyone again')) : null);
  }

  /** The paid AI services: how much the account has left, an amount given (with an end date or without), taken away. */
  function aiPart(d) {
    const kinds = Object.entries(d.ai).map(([kind, a]) => {
      const amount = el('input', { type: 'number', class: 'input', min: 1, max: 100000, placeholder: a.unit, 'aria-label': `${a.name}: ${a.unit} to give` });
      const until = el('input', { type: 'date', class: 'input', 'aria-label': `${a.name}: until (optional)`, title: 'Until this day (optional)' });
      const give = el('button', { class: 'btn small', type: 'button', dataset: { giveAi: kind } }, 'Give');
      give.addEventListener('click', () => {
        if (!(Number(amount.value) > 0)) { amount.focus(); return; }
        const end = until.value ? Math.floor(new Date(`${until.value}T23:59:59`).getTime() / 1000) : 0;
        act(d, { action: 'give-ai', kind, amount: Number(amount.value), expiresAt: end }, `${amount.value} ${a.unit} given to ${d.name}.`);
      });
      const rows = a.rows.filter((r) => r.state === 'active').map((r) => el('div', { class: 'hint' },
        `${r.left} of ${r.amount} ${a.unit} left${r.expiresAt ? `, until ${day(r.expiresAt)}` : ''} `,
        el('button', { class: 'link-btn', type: 'button', onclick: () => {
          if (confirm(`Take the ${r.left} ${a.unit} left away from ${d.name}?`)) act(d, { action: 'take-ai', amount: r.id }, 'Taken away.');
        } }, 'Take away')));
      return el('div', { class: 'ai-kind', dataset: { ai: kind } },
        el('div', {}, el('b', {}, a.name), ': ', el('span', { class: 'ai-left' }, a.left ? `${a.left} ${a.unit} left` : 'off (nothing given)')),
        ...rows, el('div', { class: 'ai-give' }, amount, until, give));
    });
    return el('section', { class: 'user-ai' }, el('h4', {}, 'Paid AI (off until you give an amount)'),
      el('p', { class: 'hint' }, 'Each use is counted on the server and stops at zero. The end date is optional.'), ...kinds);
  }

  function accountPart(d) {
    const may = d.may;
    const buttons = [];
    if (may.block) {
      buttons.push(el('button', { class: 'btn', type: 'button', onclick: () => {
        if (confirm(`Block ${d.name}? They are logged out at once and cannot log in until you unblock them.`)) act(d, { action: 'block' }, `${d.name} is blocked.`);
      } }, 'Block'));
    }
    if (may.unblock) buttons.push(el('button', { class: 'btn', type: 'button', onclick: () => act(d, { action: 'unblock' }, `${d.name} can log in again.`) }, 'Unblock'));
    if (may['make-admin']) {
      buttons.push(el('button', { class: 'btn', type: 'button', onclick: () => {
        if (confirm(`Make ${d.name} an admin? Admins see every account, hide and delete books, and give plan days. Only you make admins and change the API keys.`)) {
          act(d, { action: 'make-admin' }, `${d.name} is an admin now.`);
        }
      } }, 'Make admin'));
    }
    if (may['remove-admin']) buttons.push(el('button', { class: 'btn', type: 'button', onclick: () => act(d, { action: 'remove-admin' }, `${d.name} is a user again.`) }, 'Remove admin'));
    if (may.delete) {
      buttons.push(el('button', { class: 'btn danger-btn', type: 'button', onclick: () => {
        if (confirm(`Delete ${d.name}’s account and everything in it (${d.books} book${d.books === 1 ? '' : 's'}, MP3s, new words)? This cannot be undone.`)) {
          act(d, { action: 'delete' }, 'The account is deleted.');
        }
      } }, 'Delete the account'));
    }
    const part = [el('h4', {}, 'Account'), buttons.length ? el('div', { class: 'form-buttons user-acts' }, ...buttons) : null];
    if (may.password) {
      const pw = el('input', { type: 'text', class: 'input', minlength: 8, autocomplete: 'off', placeholder: 'At least 8 characters', 'aria-label': 'New password' });
      const set = el('button', { class: 'btn', type: 'button' }, 'Set the new password');
      set.addEventListener('click', () => {
        if (pw.value.length < 8) { toast('The new password needs at least 8 characters.'); pw.focus(); return; }
        act(d, { action: 'password', password: pw.value }, 'The new password is set. Tell it to the user: they are logged out everywhere.');
      });
      part.push(el('div', { class: 'lib-form' }, el('label', { class: 'field' }, el('span', {}, 'A new password (when the user forgot theirs)'), pw),
        el('div', { class: 'form-buttons' }, set)));
    }
    if (!buttons.length && !may.password) {
      part.push(el('p', { class: 'hint' }, d.role === 'owner' ? 'The owner’s account cannot be changed here.'
        : d.you ? 'Your own account: change your password in the account menu.' : 'Only the owner changes an admin’s account.'));
    }
    return el('section', { class: 'user-account' }, ...part.filter(Boolean));
  }

  load();
  return el('section', { class: 'users-admin' },
    el('div', { class: 'users-tools' }, find, filter, featuresBtn), count, table,
    el('p', { class: 'hint' }, o.me.owner ? 'You are the owner: only you make admins and change the API keys. Helper admins manage the users.'
      : 'You are a helper admin: the owner makes admins and changes the API keys.'));
}

/**
 * Subscription plans of a website (web/plans.py). For a user: the plans offered, with the owner's
 * payment QR pictures, and "I paid" — a request an admin approves (there is no online payment yet).
 * For the admins (the Plans part of the Admin page): the requests, the plans and the free trial.
 */
import { el, toast } from './util.js';

const api = async (method, url, body, raw) => {
  const r = await fetch(url, raw ? { method, body: raw } : body === undefined ? { method }
    : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
  if (!r) throw new Error('The app could not reach its server.');
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `It did not work (${r.status}).`);
  return d;
};
const day = (t) => (t ? new Date(t * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const booksText = (books) => (books.includes('*') ? 'All shared books' : `${books.length} chosen book${books.length === 1 ? '' : 's'}`);
/** An offline time in words: "3 days", "12 hours". */
export function offlineText(minutes) {
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? '' : 's'}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'}`;
  return `${minutes} minutes`;
}
const STATE = { pending: 'Waiting for the admin', approved: 'Approved', refused: 'Refused' };

/**
 * The plans, for a user. o: {openDialog, closeDialog, redeem(): the access-code dialog,
 * changed(): the account got (or may have got) access}.
 */
export async function plansDialog(o) {
  const body = el('div', { class: 'plans-page' }, el('p', { class: 'hint' }, 'Loading the plans…'));
  o.openDialog('Plans', body);
  const draw = async () => {
    let d;
    try { d = await api('GET', '/api/plans'); } catch (err) { body.replaceChildren(el('p', { class: 'form-msg' }, err.message)); return; }
    const sub = d.subscription;
    const state = el('p', { class: 'plans-state' }, sub.admin ? 'You are an admin: you need no plan.'
      : sub.active ? `You have access until ${day(sub.expiresAt)}.` : 'You have no plan now.');
    const cards = d.plans.map((p) => {
      const open = d.requests.find((r) => r.plan === p.id && r.status === 'pending');
      const paid = el('button', { class: 'btn primary', type: 'button', dataset: { paid: p.id } }, 'I paid');
      const form = el('div', { class: 'lib-form plan-paid', hidden: true });
      paid.addEventListener('click', () => {
        const note = el('textarea', { class: 'input', rows: 2, maxlength: 300, placeholder: 'For example: paid by WeChat at 14:05, name Li Ming' });
        const proof = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', 'aria-label': 'A screenshot of the payment' });
        const send = el('button', { class: 'btn primary', type: 'button' }, 'Send to the admin');
        const msg = el('p', { class: 'form-msg', role: 'alert' });
        send.addEventListener('click', async () => {
          send.disabled = true;
          try {
            const r = await api('POST', `/api/plans/${p.id}/paid`, { note: note.value });
            if (proof.files[0]) await api('PUT', `/api/payment-requests/${r.id}/proof`, undefined, proof.files[0]).catch((e) => toast(e.message));
            toast('Sent. An admin will look at it soon.');
            draw();
          } catch (err) { msg.textContent = err.message; send.disabled = false; }
        });
        form.replaceChildren(el('label', { class: 'field' }, el('span', {}, 'A note for the admin (how and when you paid)'), note),
          el('label', { class: 'field' }, el('span', {}, 'A screenshot of the payment (if you have one)'), proof), msg,
          el('div', { class: 'form-buttons' }, send));
        form.hidden = false;
        paid.hidden = true;
        note.focus();
      });
      return el('section', { class: 'plan-card', dataset: { plan: p.id } },
        el('h4', {}, p.name, p.price ? el('span', { class: 'plan-price' }, p.price) : null),
        el('p', { class: 'hint' }, `${p.days} days · ${booksText(p.books)} · offline up to ${offlineText(p.offlineMinutes)}`),
        p.about ? el('p', {}, p.about) : null,
        p.qr.length ? el('div', { class: 'plan-qrs' }, ...p.qr.map((q) => el('figure', {},
          el('img', { src: q.url, alt: `Payment code${q.label ? `: ${q.label}` : ''}`, loading: 'lazy' }), q.label ? el('figcaption', {}, q.label) : null))) : null,
        sub.admin ? null : open ? el('p', { class: 'hint plan-waiting' }, `You told us you paid on ${day(open.created)}: waiting for the admin.`)
          : el('div', { class: 'form-buttons' }, paid), form);
    });
    const past = d.requests.filter((r) => r.status !== 'pending').slice(0, 5).map((r) => el('p', { class: 'hint' },
      `${r.planName}: ${STATE[r.status].toLowerCase()} on ${day(r.decided)}${r.reply ? ` — “${r.reply}”` : ''}`));
    body.replaceChildren(state,
      el('p', { class: 'hint' }, 'Pay with one of the codes below, then press “I paid”. An admin checks it and opens the books for you.'),
      ...(cards.length ? cards : [el('p', { class: 'hint' }, 'No plans are offered yet. Ask the admin for an access code.')]),
      ...past,
      sub.admin ? null : el('div', { class: 'form-buttons' },
        el('button', { class: 'btn', type: 'button', onclick: () => { o.closeDialog(); o.redeem(); } }, 'I have an access code')));
    if (sub.active) o.changed?.();
  };
  await draw();
}

/** The Plans part of the Admin page. o: {openDialog, closeDialog, books: the ready, shared books}. */
export function plansAdmin(o) {
  const box = el('section', { class: 'plans-admin' }, el('p', { class: 'hint' }, 'Loading the plans…'));
  let d;
  const load = async () => {
    try { d = await api('GET', '/api/admin/plans'); } catch (err) { box.replaceChildren(el('p', { class: 'form-msg' }, err.message)); return; }
    draw();
  };
  const table = (head, rows, none) => el('div', { class: 'table-scroll' }, el('table', { class: 'admin-table' },
    el('thead', {}, el('tr', {}, ...head.map((h) => el('th', {}, h)))),
    el('tbody', {}, ...(rows.length ? rows : [el('tr', {}, el('td', { colspan: head.length }, none))]))));

  function draw() {
    // "I paid": approve (the amount you received: a note for you) or refuse (a word for the user).
    const requestRows = d.requests.map((r) => {
      const acts = [];
      if (r.status === 'pending') {
        const amount = el('input', { type: 'text', class: 'input', maxlength: 40, placeholder: 'Received, e.g. ¥30', 'aria-label': 'Amount received' });
        const decide = async (action) => {
          const reply = action === 'refuse' ? prompt('A word for the user (why it is refused):', '') : '';
          if (reply === null) return;
          try { await api('POST', `/api/admin/payment-requests/${r.id}`, { action, amount: amount.value, reply }); } catch (err) { toast(err.message); return; }
          toast(action === 'approve' ? `Approved: ${r.user.name} has the plan now.` : 'Refused.');
          load();
        };
        acts.push(amount, el('button', { class: 'btn small primary', type: 'button', dataset: { approve: r.id }, onclick: () => decide('approve') }, 'Approve'),
          el('button', { class: 'btn small danger-btn', type: 'button', onclick: () => decide('refuse') }, 'Refuse'));
      }
      return el('tr', {},
        el('td', {}, el('b', {}, r.user.name), el('div', { class: 'hint' }, r.user.email)),
        el('td', {}, r.planName), el('td', {}, r.note || '—', r.proof ? el('div', {}, el('a', { href: r.proof, target: '_blank', rel: 'noopener' }, 'Screenshot')) : null),
        el('td', {}, day(r.created)),
        el('td', {}, STATE[r.status], r.amount ? el('div', { class: 'hint' }, `Recorded: ${r.amount}`) : null, r.reply ? el('div', { class: 'hint' }, r.reply) : null),
        el('td', { class: 'admin-acts' }, ...acts));
    });
    const planRows = d.plans.map((p) => el('tr', { dataset: { plan: p.id } },
      el('td', {}, el('b', {}, p.name), p.active ? null : el('span', { class: 'badge warn' }, 'Off'), el('div', { class: 'hint' }, p.price || 'No price shown')),
      el('td', {}, `${p.days} days`), el('td', {}, booksText(p.books)), el('td', {}, offlineText(p.offlineMinutes)),
      el('td', {}, `${p.qr.length} of 2`), el('td', {}, String(p.subscribers)),
      el('td', { class: 'admin-acts' }, el('button', { class: 'btn small', type: 'button', onclick: () => editPlan(p) }, 'Change'))));
    const trial = el('input', { type: 'number', class: 'input', min: 0, max: 365, value: d.trialDays, 'aria-label': 'Days of the free trial' });
    const saveTrial = el('button', { class: 'btn small', type: 'button' }, 'Save');
    saveTrial.addEventListener('click', async () => {
      try { d = await api('PUT', '/api/admin/settings', { trialDays: Number(trial.value) }); } catch (err) { toast(err.message); return; }
      toast(d.trialDays ? `New accounts get ${d.trialDays} free days.` : 'No free trial for new accounts.');
    });
    box.replaceChildren(
      el('h3', {}, `Payments to check (${d.pending})`),
      el('p', { class: 'hint' }, 'A user pays you with your QR code and presses “I paid”. Check your payment app, then approve: the plan’s days are given. '
        + 'The amount you type is your own note of what you received.'),
      table(['User', 'Plan', 'Note', 'Sent', 'Status', ''], requestRows, 'No requests yet.'),
      el('h3', {}, `Plans (${d.plans.length})`),
      el('div', { class: 'form-buttons user-acts' }, el('button', { class: 'btn primary', type: 'button', onclick: () => editPlan(null) }, 'New plan')),
      table(['Plan', 'Gives', 'Books', 'Offline', 'QR pictures', 'People now', ''], planRows, 'No plans yet: make the first one.'),
      el('h3', {}, 'Free trial'),
      el('div', { class: 'ai-give' }, el('span', {}, 'A new account gets'), trial, el('span', {}, 'free days of all shared books (0: no trial)'), saveTrial));
  }

  function editPlan(p) {
    const v = p || { name: '', price: '', about: '', days: 30, books: ['*'], offlineMinutes: 4320, active: true, qr: [] };
    const name = el('input', { type: 'text', class: 'input', maxlength: 60, value: v.name, required: true, placeholder: 'For example: One month' });
    const price = el('input', { type: 'text', class: 'input', maxlength: 40, value: v.price, placeholder: 'As it is shown, for example: ¥30' });
    const about = el('textarea', { class: 'input', rows: 2, maxlength: 400, placeholder: 'A few words about the plan (optional)' });
    about.value = v.about;
    const days = el('input', { type: 'number', class: 'input', min: 1, max: 3650, value: v.days, required: true });
    const offline = el('input', { type: 'number', class: 'input', min: 1, max: 8760, value: Math.round(v.offlineMinutes / 60), required: true });
    const scope = el('select', { class: 'select' }, el('option', { value: '*' }, 'All shared books'), el('option', { value: 'chosen', selected: !v.books.includes('*') }, 'Chosen books'));
    const chosen = el('select', { class: 'select', multiple: true, size: Math.min(7, Math.max(3, o.books.length)), hidden: v.books.includes('*') },
      ...o.books.map((b) => el('option', { value: b.id, selected: v.books.includes(b.id) }, b.title)));
    scope.addEventListener('change', () => { chosen.hidden = scope.value === '*'; });
    const active = el('input', { type: 'checkbox', checked: v.active });
    const msg = el('p', { class: 'form-msg', role: 'alert' });
    const save = el('button', { class: 'btn primary', type: 'submit' }, p ? 'Save the plan' : 'Make the plan');
    const form = el('form', { class: 'lib-form plan-form' },
      el('label', { class: 'field' }, el('span', {}, 'Name'), name),
      el('label', { class: 'field' }, el('span', {}, 'Price (as the users see it)'), price),
      el('label', { class: 'field' }, el('span', {}, 'About'), about),
      el('div', { class: 'subscription-fields' },
        el('label', { class: 'field' }, el('span', {}, 'Days it gives'), days),
        el('label', { class: 'field' }, el('span', {}, 'Offline time (hours; 72 = 3 days)'), offline)),
      el('label', { class: 'field' }, el('span', {}, 'Books it opens'), scope), chosen,
      el('label', { class: 'check' }, active, ' Offered to the users (off: nobody new can take it; the people who have it keep their days)'),
      msg);
    const value = () => ({ name: name.value, price: price.value, about: about.value, days: Number(days.value), offlineMinutes: Number(offline.value) * 60,
      books: scope.value === '*' ? '*' : [...chosen.selectedOptions].map((x) => x.value), active: active.checked });
    // The pictures of your payment QR codes (after the plan is made).
    const qrPart = (plan) => el('div', { class: 'plan-qr-edit' }, el('span', { class: 'field-label' }, 'Your payment QR pictures (up to two: WeChat, Alipay, a bank …)'),
      ...[1, 2].map((n) => {
        const have = plan.qr.find((q) => q.n === n);
        const label = el('input', { type: 'text', class: 'input', maxlength: 40, value: have?.label || '', placeholder: n === 1 ? 'Its name, e.g. WeChat Pay' : 'Its name, e.g. Alipay' });
        const file = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', 'aria-label': `QR picture ${n}` });
        const send = async () => {
          try {
            let next = plan;
            if (file.files[0]) next = await api('PUT', `/api/admin/plans/${plan.id}/qr/${n}`, undefined, file.files[0]);
            next = await api('PUT', `/api/admin/plans/${plan.id}`, { [`qr${n}Label`]: label.value });
            toast('Saved.');
            load();
            editPlan(next);
          } catch (err) { toast(err.message); }
        };
        return el('div', { class: 'ai-give', dataset: { qr: n } }, have ? el('img', { class: 'plan-qr-small', src: have.url, alt: '' }) : null, label, file,
          el('button', { class: 'btn small', type: 'button', onclick: send }, 'Save'),
          have ? el('button', { class: 'link-btn', type: 'button', onclick: async () => {
            try { const next = await api('DELETE', `/api/admin/plans/${plan.id}/qr/${n}`); load(); editPlan(next); } catch (err) { toast(err.message); }
          } }, 'Take away') : null);
      }));
    const buttons = el('div', { class: 'form-buttons' },
      p ? el('button', { class: 'btn danger-btn', type: 'button', onclick: async () => {
        if (!confirm(`Delete the plan “${p.name}”? If people had it, it is only switched off: they keep their days.`)) return;
        try {
          const r = await api('DELETE', `/api/admin/plans/${p.id}`);
          toast(r.deleted ? 'The plan is deleted.' : 'People had this plan: it is switched off, not deleted.');
          o.closeDialog();
          load();
        } catch (err) { toast(err.message); }
      } }, 'Delete') : null,
      el('button', { class: 'btn', type: 'button', onclick: o.closeDialog }, p ? 'Close' : 'Cancel'), save);
    form.append(buttons);
    if (p) form.append(qrPart(p));
    else form.append(el('p', { class: 'hint' }, 'After making the plan you add the pictures of your payment QR codes.'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = value();
      if (body.books !== '*' && !body.books.length) { msg.textContent = 'Choose the books.'; return; }
      save.disabled = true;
      try {
        const next = p ? await api('PUT', `/api/admin/plans/${p.id}`, body) : await api('POST', '/api/admin/plans', body);
        toast(p ? 'The plan is saved.' : 'The plan is made. Now add your payment QR pictures.');
        load();
        editPlan(next);
      } catch (err) { msg.textContent = err.message; save.disabled = false; }
    });
    o.openDialog(p ? `Plan: ${p.name}` : 'New plan', form);
  }

  load();
  return box;
}

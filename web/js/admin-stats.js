/**
 * The Statistics part of the Admin page (web/stats.py): a period (today, this week, this month,
 * this year, or two dates), for everyone or one account: who used the app and how much, who
 * signed up, the plans, the payments the admins recorded, the paid AI used and about what it cost.
 */
import { el } from './util.js';

const api = async (url) => {
  const r = await fetch(url).catch(() => null);
  if (!r) throw new Error('The app could not reach its server.');
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `It did not work (${r.status}).`);
  return d;
};
const n = (v) => Number(v || 0).toLocaleString();
const hours = (minutes) => (minutes >= 120 ? `${(minutes / 60).toFixed(1)} h` : `${n(minutes)} min`);
const USE = [['pages', 'Pages opened'], ['reads', 'Sentences read aloud'], ['translations', 'Translations'], ['mp3s', 'MP3s made'],
  ['words', 'New words added'], ['scripts', 'Script minutes (AI)'], ['pictures', 'AI pictures'], ['layout', 'AI layout pages']];
const PLAN = { trial: 'free trials started', plan: 'plans paid (approved)', given: 'given by an admin', code: 'codes redeemed' };

export function statsAdmin({ users = [] } = {}) {
  const box = el('section', { class: 'stats-admin' });
  const period = el('select', { class: 'select', 'aria-label': 'Period' },
    ...[['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['year', 'This year'], ['custom', 'Two dates…']]
      .map(([v, label]) => el('option', { value: v }, label)));
  const start = el('input', { type: 'date', class: 'input', hidden: true, 'aria-label': 'From' });
  const end = el('input', { type: 'date', class: 'input', hidden: true, 'aria-label': 'To' });
  const who = el('select', { class: 'select', 'aria-label': 'Whose' }, el('option', { value: '' }, 'Everyone'),
    ...users.filter((u) => u.role === 'user').map((u) => el('option', { value: u.id }, u.name)));
  const refresh = el('button', { class: 'btn small', type: 'button' }, 'Refresh');
  const out = el('div', { class: 'stats-body' }, el('p', { class: 'hint' }, 'Loading…'));
  period.addEventListener('change', () => { start.hidden = end.hidden = period.value !== 'custom'; if (period.value !== 'custom') load(); });
  [start, end, who].forEach((x) => x.addEventListener('change', load));
  refresh.addEventListener('click', load);

  async function load() {
    const q = new URLSearchParams({ period: period.value });
    if (period.value === 'custom') {
      if (!start.value || !end.value) return;
      q.set('start', start.value);
      q.set('end', end.value);
    }
    if (who.value) q.set('user', who.value);
    let d;
    try { d = await api(`/api/admin/stats?${q}`); } catch (err) { out.replaceChildren(el('p', { class: 'form-msg' }, err.message)); return; }
    draw(d);
  }

  const tile = (label, value, note) => el('div', { class: 'stat' }, el('b', {}, value), el('span', {}, label), note ? el('small', {}, note) : null);

  function draw(d) {
    const one = Boolean(who.value);
    const money = Object.entries(d.payments.recorded.sums).map(([unit, sum]) => `${unit === '?' ? '' : unit}${n(sum)}`).join(' + ') || '—';
    const tiles = el('div', { class: 'stats-tiles' },
      tile(one ? 'Days active' : 'Accounts active', n(one ? d.activeDays : d.users)),
      tile('Time active', hours(d.minutes), 'about: 5 min per page or reading'),
      one ? null : tile('Signed up', n(d.signedUp)),
      tile('With a plan now', n(d.withPlanNow)),
      tile('Payments approved', n(d.payments.approved), `${n(d.payments.refused)} refused, ${n(d.payments.pending)} waiting`),
      tile('Money recorded', money, 'what the admins typed when approving: not a proof'),
      tile('AI cost, about', `$${d.aiCost.toFixed(2)}`, `scripts ${d.ai.scripts.n} min · pictures ${d.ai.pictures.n} · layouts ${d.ai.layout.n}`));
    const plans = Object.entries(d.plans).map(([k, v]) => `${n(v)} ${PLAN[k] || k}`).join(', ') || 'none';
    const useRows = USE.map(([k, label]) => el('tr', {}, el('td', {}, label), el('td', { class: 'num' }, n(d.use[k]))));
    const head = one ? ['Day', 'Minutes', ...USE.map(([, l]) => l)] : ['Account', 'Minutes', 'Days', ...USE.map(([, l]) => l)];
    const detailRows = d.detail.map((r) => el('tr', {},
      el('td', {}, one ? r.day : el('span', {}, el('b', {}, r.name), el('div', { class: 'hint' }, r.email))),
      el('td', { class: 'num' }, n(r.minutes)), ...(one ? [] : [el('td', { class: 'num' }, n(r.days))]),
      ...USE.map(([k]) => el('td', { class: 'num' }, n(r[k])))));
    out.replaceChildren(
      el('p', { class: 'hint' }, `${d.period.first === d.period.last ? d.period.first : `${d.period.first} to ${d.period.last}`}${one ? '' : ' · everyone'}.`),
      tiles,
      el('p', { class: 'hint' }, `Plans started in this period: ${plans}.`),
      el('div', { class: 'stats-two' },
        el('div', {}, el('h4', {}, 'What was used'), el('table', { class: 'admin-table' }, el('tbody', {}, ...useRows))),
        el('div', {}, el('h4', {}, one ? 'Day by day' : 'The busiest accounts'),
          el('div', { class: 'table-scroll' }, el('table', { class: 'admin-table' }, el('thead', {}, el('tr', {}, ...head.map((h) => el('th', {}, h)))),
            el('tbody', {}, ...(detailRows.length ? detailRows : [el('tr', {}, el('td', { colspan: head.length }, 'Nothing in this period.'))])))))),
      el('p', { class: 'hint' }, 'The record of use is told in the terms: pages, minutes and counts per day, kept a year; never what was read. '
        + `AI cost is an estimate (about ${d.costNote.scripts}¢ a script minute, ${d.costNote.pictures}¢ a picture, ${d.costNote.layout}¢ a layout page).`));
  }

  box.append(el('div', { class: 'users-tools' }, period, start, end, who, refresh), out);
  load();
  return box;
}

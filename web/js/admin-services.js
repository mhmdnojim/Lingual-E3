/**
 * The API part of the Admin page (web/services.py): only the owner of the website sees it. Every
 * online service the app uses, whether its key is saved (its last 4 characters, never the key),
 * its model, a Test button, and the free services' state. A key is typed into a password box and
 * saved; '' takes it out.
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
const when = (t) => (t ? new Date(t * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const GROUPS = { scripts: 'Scripts of audio and video (ElevenLabs)', openai: 'Pictures and page layouts (OpenAI)', backup: 'Paid backups of the free services' };

export function servicesAdmin() {
  const box = el('section', { class: 'services-admin' }, el('p', { class: 'hint' }, 'Loading…'));
  let d;
  const load = async () => {
    try { d = await api('GET', '/api/admin/services'); } catch (err) { box.replaceChildren(el('p', { class: 'form-msg' }, err.message)); return; }
    draw();
  };
  const state = (s) => (!s ? el('span', { class: 'hint' }, 'Not tried yet')
    : el('span', { class: `badge ${s.ok ? 'public' : 'warn'}`, title: s.said }, `${s.ok ? 'Working' : 'Not working'} · ${when(s.at)}`));

  function row(s) {
    const key = el('input', { type: 'password', class: 'input', autocomplete: 'new-password', placeholder: s.saved ? `Saved (…${s.hint}); type a new one to change it` : 'Paste the key',
      'aria-label': `${s.name}: key` });
    const model = 'model' in s ? el('input', { type: 'text', class: 'input', value: s.model, maxlength: 100, 'aria-label': `${s.name}: model` }) : null;
    const region = 'region' in s ? el('input', { type: 'text', class: 'input', value: s.region, maxlength: 40, 'aria-label': 'Azure region', placeholder: 'eastasia' }) : null;
    const said = el('p', { class: 'hint service-said', 'aria-live': 'polite' });
    const save = el('button', { class: 'btn small primary', type: 'button', dataset: { save: s.key } }, 'Save');
    save.addEventListener('click', async () => {
      const body = {};
      if (key.value.trim()) body[s.key] = key.value.trim();
      if (model && model.value.trim() !== s.model) body[{ speechKey: 'speechModel', imageKey: 'imageModel', layoutKey: 'layoutModel' }[s.key]] = model.value.trim();
      if (region && region.value.trim() !== s.region) body.azureSpeechRegion = region.value.trim();
      if (!Object.keys(body).length) { said.textContent = 'Nothing to save.'; return; }
      try { d = await api('PUT', '/api/admin/services', body); } catch (err) { said.textContent = err.message; return; }
      toast('Saved. The key is kept on the server only.');
      draw();
    });
    const test = el('button', { class: 'btn small', type: 'button', dataset: { test: s.key } }, 'Test');
    test.addEventListener('click', async () => {
      test.disabled = true;
      said.textContent = 'Trying…';
      try {
        const r = await api('POST', `/api/admin/services/${s.key}/test`);
        said.textContent = r.said;
        said.classList.toggle('err', !r.ok);
      } catch (err) { said.textContent = err.message; }
      test.disabled = false;
      load();
    });
    const remove = s.saved ? el('button', { class: 'link-btn', type: 'button', onclick: async () => {
      if (!confirm(`Take the key of ${s.name} out?`)) return;
      try { d = await api('PUT', '/api/admin/services', { [s.key]: '' }); } catch (err) { toast(err.message); return; }
      draw();
    } }, 'Take the key out') : null;
    return el('div', { class: 'service', dataset: { service: s.key } },
      el('div', { class: 'service-head' }, el('b', {}, s.name),
        el('span', { class: `badge ${s.saved ? 'public' : ''}` }, s.saved ? `Key saved …${s.hint}` : s.usesImageKey ? 'Uses the pictures key' : 'No key'),
        s.saved ? state(s.state) : null),
      el('p', { class: 'hint' }, s.note),
      el('div', { class: 'service-fields' }, key, model ? el('label', { class: 'field' }, el('span', {}, 'Model'), model) : null,
        region ? el('label', { class: 'field' }, el('span', {}, 'Region'), region) : null),
      el('div', { class: 'form-buttons user-acts' }, save, s.saved || s.usesImageKey ? test : null, remove), said);
  }

  function draw() {
    const groups = Object.entries(GROUPS).map(([g, title]) => el('div', { class: 'service-group' }, el('h3', {}, title),
      ...d.services.filter((s) => s.group === g).map(row)));
    const free = d.free.map((f) => {
      const said = el('span', { class: 'hint service-said' });
      const test = el('button', { class: 'btn small', type: 'button', dataset: { test: f.key }, onclick: async () => {
        test.disabled = true;
        said.textContent = 'Trying…';
        try { const r = await api('POST', `/api/admin/services/${f.key}/test`); said.textContent = r.said; } catch (err) { said.textContent = err.message; }
        test.disabled = false;
        load();
      } }, 'Test');
      return el('div', { class: 'service free', dataset: { service: f.key } }, el('div', { class: 'service-head' }, el('b', {}, f.name), state(f.state), test), said);
    });
    box.replaceChildren(
      el('p', { class: 'hint' }, 'Only you see this page. Keys are kept on the server (web/server-config.json), never shown again, and never sent to anyone’s browser.'),
      ...groups,
      el('div', { class: 'service-group' }, el('h3', {}, 'Free services (no key)'),
        el('p', { class: 'hint' }, 'When one of these fails, its paid backup above is used, if its key is saved.'), ...free));
  }

  load();
  return box;
}

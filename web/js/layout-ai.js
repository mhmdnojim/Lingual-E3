// Optional paid layout analysis. Keys stay on the server; page requests are explicit.
import { el } from './util.js';

export function layoutAISettings(info, configure, changed) {
  if (!info?.owner || !configure) return el('p', { class: 'hint' },
    info?.can ? 'AI analysis sends this page image and its OCR text to OpenAI. API usage is billed.'
      : 'An admin can enable optional AI layout analysis. Local paragraph editing is available.');
  const details = el('details', { class: 'layout-ai-settings' });
  const model = el('input', { class: 'input', value: info.model || 'gpt-4.1', maxlength: 100, 'aria-label': 'AI layout model' });
  const key = el('input', { type: 'password', class: 'input', autocomplete: 'new-password',
    placeholder: 'Leave empty to keep the saved key', 'aria-label': 'AI layout API key' });
  const shared = el('input', { type: 'checkbox', checked: !!info.useImageKey });
  const users = el('input', { type: 'checkbox', checked: !!info.allowUsers });
  const state = el('p', { class: 'hint', 'aria-live': 'polite' }, info.ready ? `Configured: ${info.source}.` : 'No API key configured yet.');
  const save = el('button', { type: 'button', class: 'btn small' }, 'Save AI settings');
  const remove = el('button', { type: 'button', class: 'btn small' }, 'Remove dedicated layout key');
  async function update(body) {
    save.disabled = remove.disabled = true;
    try {
      const next = await configure(body);
      key.value = '';
      info = next;
      state.textContent = next.ready ? `Ready: ${next.source}. Click Analyze layout with AI to use it.` : 'No API key configured.';
      changed(next);
    } catch (error) { state.textContent = error.message; }
    finally { save.disabled = remove.disabled = false; }
  }
  save.addEventListener('click', () => {
    const body = { model: model.value.trim(), allowUsers: users.checked, useImageKey: shared.checked };
    if (key.value.trim()) body.key = key.value.trim();
    update(body);
  });
  remove.addEventListener('click', () => update({ key: '' }));
  details.append(el('summary', {}, 'AI layout settings'),
    el('p', { class: 'hint' }, 'OpenAI API key: stored only on the app server and never returned to the browser. '
      + 'Use a model supporting images and structured output. Each new analysis sends one page image and OCR words to OpenAI and uses paid API credits.'),
    el('label', { class: 'field' }, el('span', {}, 'OpenAI API key'), key),
    el('label', { class: 'field' }, el('span', {}, 'Model ID'), model),
    info.sharedAvailable ? el('label', { class: 'check' }, shared, ' Use the existing OpenAI image-service key when no dedicated key is set') : '',
    el('label', { class: 'check' }, users, ' Allow other book owners to use AI (up to 20 requests per day each)'),
    el('div', { class: 'form-buttons' }, save, remove), state);
  return details;
}

export async function requestAILayout(book, page, refresh, progress) {
  const response = await fetch(`/api/books/${book}/layout-ai/${page}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ progress: true, refresh }),
  }).catch(() => null);
  if (!response) throw new Error('The app server could not be reached. Your current outlines are kept.');
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `AI layout request failed (${response.status}).`);
  }
  if (!(response.headers.get('Content-Type') || '').includes('application/x-ndjson')) return response.json();
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', result;
  const accept = (line) => {
    if (!line.trim()) return;
    const data = JSON.parse(line);
    if (data.error) throw new Error(data.error);
    if (Number.isInteger(data.at)) progress(data.at, data.message || 'Analyzing…');
    if (data.result) result = data.result;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        accept(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      }
    }
    buffer += decoder.decode();
    accept(buffer);
  } finally { reader.releaseLock(); }
  if (!result) throw new Error('The AI connection ended before a result arrived. Your current outlines are kept. Reopening a completed cached suggestion does not call OpenAI again.');
  return result;
}

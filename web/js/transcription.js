// A recording or video without a script: its lines made by speech recognition (web/transcription.py:
// on this computer, or by ElevenLabs with its key). It goes on in the server if the player is closed.
// speechDialog: how it is done (ElevenLabs's key, or this computer), and any file transcribed.
import { downloadText, el, icon } from './util.js';
import { openDialog, repeatButton, Transcript } from './media.js';
import { ScriptTranslation } from './translation.js';

export const AUTO_NOTE = 'Made by speech recognition: it may have mistakes.';

export function transcribeButton() {
  return el('button', { class: 'btn small transcribe-btn', type: 'button', title: 'Write down what is said in this recording (speech recognition)',
    html: `${icon('transcribe')}<span>Transcribe</span>` });
}

/** The button that opens speechDialog (next to a Transcribe button). */
export function speechButton(app, onChange = null) {
  return el('button', { class: 'icon-btn small speech-btn', type: 'button', title: 'Speech recognition: ElevenLabs or this computer; transcribe any file',
    'aria-label': 'Speech recognition settings', html: icon('sliders'), onclick: () => speechDialog(app, onChange) });
}

const api = async (method, url, body) => {
  const r = await fetch(url, body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `It did not work (${r.status}).`);
  return d;
};

const stamp = (ms, comma = false) => {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000), m = Math.floor(t / 60000) % 60, s = Math.floor(t / 1000) % 60;
  const two = (n) => String(n).padStart(2, '0');
  return comma ? `${two(h)}:${two(m)}:${two(s)},${String(t % 1000).padStart(3, '0')}` : `${h ? `${h}:${two(m)}` : m}:${two(s)}`;
};
const who = (c) => (c.speaker === 'A' ? 'Speaker A' : c.speaker === 'B' ? 'Speaker B' : c.speaker === 'explanation' ? 'Explanation' : '');

/** The lines as text: "[0:03] Speaker A: …" a line each. */
export const cuesText = (cues) => cues.map((c) => `[${stamp(c.t)}] ${who(c) ? `${who(c)}: ` : ''}${c.x}`).join('\n');

/** The lines as subtitles (SRT): each until the next begins (or its last word ends). */
export function cuesSrt(cues) {
  return cues.map((c, i) => {
    const end = c.words?.length ? c.words[c.words.length - 1].e : (cues[i + 1]?.t ?? c.t + 3000);
    return `${i + 1}\n${stamp(c.t, true)} --> ${stamp(Math.max(end, c.t + 500), true)}\n${who(c) ? `${who(c)}: ` : ''}${c.x}\n`;
  }).join('\n');
}

/**
 * Speech recognition: the way used (ElevenLabs, with its key kept on the server; or this computer)
 * and any audio or video file transcribed — its lines shown with it (translated as the scripts of the
 * books are), to copy or download. onChange(info): the way was changed.
 */
export async function speechDialog(app, onChange = null) {
  const how = el('div', { class: 'speech-how' }, el('p', { class: 'hint' }, 'Asking how recordings are transcribed here…'));
  const body = el('div', { class: 'speech-dialog' }, el('h4', {}, 'How'), how, el('h4', {}, 'Transcribe a file'), fileBox(app));
  openDialog('Speech recognition', body, () => body.querySelectorAll('audio, video').forEach((m) => m.pause()));
  let info;
  try { info = await api('GET', '/api/speech-ai'); } catch (err) { how.replaceChildren(el('p', { class: 'hint err' }, err.message)); return; }

  const changed = (d) => { info = d; onChange?.(d); };
  const ways = () => {
    const seg = el('div', { class: 'seg speech-ways', role: 'radiogroup', 'aria-label': 'How recordings are transcribed' },
      ...[['eleven', 'ElevenLabs (on the internet)'], ['local', 'This computer (Whisper)']].map(([k, label]) =>
        el('button', { type: 'button', role: 'radio', 'aria-checked': String(info.engine === k), dataset: { engine: k }, disabled: !info.admin }, label)));
    const state = el('p', { class: 'hint', 'aria-live': 'polite' });
    const tell = () => {
      state.textContent = info.engine === 'eleven'
        ? 'ElevenLabs writes down what is said, tells the speakers apart, and knows 90+ languages. It is quick; each hour of sound costs some of your ElevenLabs credits.'
        : info.local ? 'Whisper on this computer: free and without internet, slower, English (and Chinese with its bigger model).'
          : 'Speech recognition on this computer is not installed (Setup transcription.bat). Use ElevenLabs, or install it.';
    };
    seg.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b || b.dataset.engine === info.engine) return;
      if (b.dataset.engine === 'eleven' && !info.ready) { how.replaceChildren(...keyForm()); return; }
      try { changed(await api('PUT', '/api/speech-ai', { engine: b.dataset.engine })); } catch (err) { state.textContent = err.message; return; }
      seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.engine === info.engine)));
      tell();
    });
    tell();
    return [seg, state, info.admin ? el('div', { class: 'form-buttons' },
      el('button', { class: 'link-btn speech-key', type: 'button', onclick: () => how.replaceChildren(...keyForm()) }, info.ready ? 'Change the key of ElevenLabs' : 'Add a key of ElevenLabs')) : null,
    info.can ? null : el('p', { class: 'hint' }, 'Only an admin can transcribe here: ElevenLabs costs money.')].filter(Boolean);
  };
  const keyForm = () => {
    const key = el('input', { type: 'password', class: 'input', autocomplete: 'off', placeholder: 'sk_…', 'aria-label': 'The key of ElevenLabs' });
    const save = el('button', { class: 'btn primary', type: 'button' }, 'Save the key');
    const state = el('p', { class: 'hint', 'aria-live': 'polite' });
    save.addEventListener('click', async () => {
      if (!key.value.trim()) { key.focus(); return; }
      save.disabled = true;
      try {
        changed(await api('PUT', '/api/speech-ai', { key: key.value.trim(), engine: 'eleven' }));
        how.replaceChildren(...ways());
      } catch (err) { state.textContent = err.message; save.disabled = false; }
    });
    key.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });
    return [el('p', { class: 'hint' }, 'ElevenLabs needs its key: at elevenlabs.io → Developers → API keys, make one (with Speech to Text allowed) and paste it here. '
      + 'It is kept on this computer only (web/server-config.json), never shown again.'),
    el('label', { class: 'field' }, el('span', {}, 'The key of ElevenLabs'), key),
    el('div', { class: 'form-buttons' }, el('button', { class: 'btn', type: 'button', onclick: () => how.replaceChildren(...ways()) }, info.ready ? 'Keep the one saved' : 'Not now'), save),
    state];
  };
  how.replaceChildren(...(info.admin && !info.ready && !info.local ? keyForm() : ways()));
}

/**
 * Any audio or video file: sent to the server, transcribed (as chosen in "How"; its language found
 * by itself), its lines shown.
 */
function fileBox(app) {
  const file = el('input', { type: 'file', accept: 'audio/*,video/*,.mp3,.m4a,.aac,.wav,.ogg,.opus,.flac,.mp4,.webm,.mov,.mkv,.avi', 'aria-label': 'An audio or video file' });
  const go = el('button', { class: 'btn primary', type: 'button', disabled: true }, 'Transcribe');
  const bar = el('div', { class: 'rec-progress', hidden: true }, el('div'));
  const state = el('p', { class: 'hint', 'aria-live': 'polite' }, 'An MP3, a video, a voice message … of any length (up to 1000 MB).');
  const result = el('div', { class: 'speech-result' });
  file.addEventListener('change', () => { go.disabled = !file.files[0]; });
  go.addEventListener('click', async () => {
    const f = file.files[0];
    if (!f) return;
    go.disabled = true;
    result.replaceChildren();
    state.classList.remove('err');
    bar.hidden = false;
    try {
      const sent = await send(`/api/transcribe-file?name=${encodeURIComponent(f.name)}`, f,
        (x) => { bar.firstChild.style.width = `${Math.round(x * 100)}%`; state.textContent = `Sending it: ${Math.round(x * 100)}%`; });
      bar.hidden = true;
      let job = { state: 'queued', message: 'Waiting to transcribe…' };
      while (stillOpen(file)) {
        if (job.state === 'done') { showResult(app, result, f, job); state.textContent = `${job.cues.length} lines. Click one to hear it; click it again to pause.`; break; }
        if (job.state === 'error') throw new Error(job.error);
        state.textContent = `${job.message || 'Transcribing…'}${job.progress != null ? ` ${job.progress}%` : ''}`;
        await new Promise((ok) => setTimeout(ok, 1500));
        job = await api('GET', `/api/transcribe-file?job=${encodeURIComponent(sent.job)}`);
      }
    } catch (err) {
      state.classList.add('err');
      state.textContent = err.message || 'The transcription failed. Try again.';
    }
    bar.hidden = true;
    go.disabled = !file.files[0];
  });
  return el('div', { class: 'speech-file' }, el('label', { class: 'field' }, el('span', {}, 'The file'), file),
    el('div', { class: 'form-buttons' }, go), bar, state, result);
}

/** Is the window of this still open? */
const stillOpen = (node) => !!node.closest('.speech-dialog')?.isConnected;

/**
 * The file played here, its lines under it as a book's script: a click on one plays it (on the
 * line being played: pause / play), each repeated as set; translated under every line or when
 * pointing at one (into the language chosen there; from the language found); copy or download them.
 */
function showResult(app, box, f, job) {
  const cues = job.cues;
  const player = el(/^video\//.test(f.type) ? 'video' : 'audio', { controls: true, src: URL.createObjectURL(f), class: 'speech-player' });
  const list = el('ol', { class: 'cue-list speech-lines' });
  const transcript = new Transcript(list, player, {
    seek: (t) => { player.currentTime = t; player.play().catch(() => {}); },
    toggle: () => { if (player.paused) player.play().catch(() => {}); else player.pause(); },
  });
  const tr = new ScriptTranslation(app.translator, transcript, box.closest('.speech-dialog') || box);
  player.addEventListener('timeupdate', () => transcript.update(player.currentTime * 1000));
  player.addEventListener('ended', () => transcript.ended());
  const name = f.name.replace(/\.[^.]+$/, '');
  const copy = el('button', { class: 'btn', type: 'button' }, 'Copy the text');
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(cues.map((c) => c.x).join('\n')); copy.textContent = 'Copied'; } catch { copy.textContent = 'Could not copy'; }
  });
  box.replaceChildren(player, el('div', { class: 'form-buttons' }, copy,
    el('button', { class: 'btn', type: 'button', onclick: () => downloadText(`${name}.txt`, cuesText(cues)) }, 'Download the text'),
    el('button', { class: 'btn', type: 'button', onclick: () => downloadText(`${name}.srt`, cuesSrt(cues)) }, 'Download subtitles (SRT)')),
  el('div', { class: 'cue-tools speech-tools' }, tr.underBtn, tr.pointBtn, repeatButton(app), tr.lang), tr.note, list);
  transcript.render(cues);
  tr.from = job.language || 'en';
  tr.setScript('files', job.script || null);
}

/** Send one file (the body as it is) with progress (POST). */
function send(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', url);
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onload = () => {
      let d = {};
      try { d = JSON.parse(x.responseText); } catch { /* not JSON */ }
      if (x.status >= 200 && x.status < 300) resolve(d);
      else reject(new Error(d.error || (x.status === 413 ? 'The file is too big (at most 1000 MB).' : `It could not be sent (${x.status}).`)));
    };
    x.onerror = () => reject(new Error('The file could not be sent. Check the connection and try again.'));
    x.send(file);
  });
}

/** The lines made before (state "done"), a transcription still running, or {state: "idle"}. */
export async function savedTranscript(asset, language = 'en') {
  if (asset.generatedCues) return { state: 'done', cues: asset.generatedCues };
  try {
    const response = await fetch(`/api/transcript?src=${encodeURIComponent(asset.src)}&language=${encodeURIComponent(language || 'en')}`);
    return response.ok ? await response.json() : { state: 'idle' };
  } catch { return { state: 'idle' }; }
}

/**
 * Transcribe the recording (or follow a transcription already running: job) and show how far it
 * is in status. apply(cues) when done. alive(): false once that player shows something else.
 */
export async function transcribeRecording(asset, button, status, apply, alive = () => true, job = null, language = 'en', force = false) {
  button.disabled = true;
  status.classList.remove('err');
  status.textContent = 'Starting…';
  try {
    if (!job) {
      const response = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ src: asset.src, language: language || 'en', force }) });
      job = await response.json();
      if (!response.ok) throw new Error(job.error || 'The transcription could not start.');
    }
    while (alive()) {
      if (job.state === 'done') {
        asset.generatedCues = job.cues;
        apply(job.cues);
        return;
      }
      if (job.state === 'error') throw new Error(job.error);
      status.textContent = `${job.message || 'Transcribing…'}${job.progress != null ? ` ${job.progress}%` : ''}`;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      if (!alive()) return;
      const response = await fetch(`/api/transcript?src=${encodeURIComponent(asset.src)}&language=${encodeURIComponent(language || 'en')}`);
      job = await response.json();
      if (!response.ok) throw new Error(job.error || 'Could not check how far the transcription is.');
    }
  } catch (error) {
    if (!alive()) return;
    status.classList.add('err');
    status.textContent = error.message || 'The transcription failed. Try again.';
  } finally {
    if (alive()) button.disabled = false;
  }
}

// A recording or video of the disc without a script: its lines made by speech recognition on
// this computer (web/transcription.py). It goes on in the server if the player is closed.
import { el, icon } from './util.js';

export const AUTO_NOTE = 'Made by speech recognition: it may have mistakes.';

export function transcribeButton() {
  return el('button', { class: 'btn small transcribe-btn', type: 'button', title: 'Write down what is said in this recording (speech recognition on this computer)',
    html: `${icon('transcribe')}<span>Transcribe</span>` });
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

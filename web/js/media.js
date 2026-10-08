// Audio player bar, video dialog and Flash answer-key dialog (via Ruffle),
// with timed transcripts that follow the recording.
import { $, el, escapeHtml, fmtTime, getJSON, icon } from './util.js';
import { ScriptTranslation } from './translation.js';

/** A clickable list of timed transcript lines that highlights the current line. */
export class Transcript {
  constructor(listEl, onSeek) {
    this.list = listEl;
    this.onSeek = onSeek;
    this.cues = [];
    this.items = [];
    this.current = -1;
    this.userScrollUntil = 0;
    listEl.addEventListener('wheel', () => { this.userScrollUntil = Date.now() + 4000; }, { passive: true });
  }

  render(cues) {
    this.cues = cues || [];
    this.current = -1;
    this.items = this.cues.map((c) => {
      const li = el('li', { class: 'cue', tabindex: '0' },
        el('time', {}, fmtTime(c.t / 1000)), el('span', {}, c.x));
      const seek = () => this.onSeek(c.t / 1000);
      li.addEventListener('click', seek);
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter') seek(); });
      return li;
    });
    this.list.replaceChildren(...this.items);
  }

  /** A translation under each line (null: none). */
  setTranslations(trs, dir = 'ltr', lang = '') {
    this.items.forEach((li, i) => {
      li.querySelector('.tr')?.remove();
      if (trs?.[i]) li.append(el('span', { class: 'tr', dir, lang }, trs[i]));
    });
  }

  update(ms) {
    let i = -1;
    for (let k = 0; k < this.cues.length && this.cues[k].t <= ms + 120; k++) i = k;
    if (i === this.current) return;
    this.items[this.current]?.classList.remove('active');
    this.current = i;
    const item = this.items[i];
    if (!item) return;
    item.classList.add('active');
    if (Date.now() > this.userScrollUntil) item.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

export class AudioPlayer {
  constructor(app) {
    this.app = app;
    this.audio = $('#audio');
    this.bar = $('#player');
    this.playBtn = $('#pl-play');
    this.seekEl = $('#pl-seek');
    this.timeEl = $('#pl-time');
    this.asset = null;
    this.transcript = new Transcript($('#cue-list'), (t) => this.seek(t, true));
    this.seeking = false;
    this.renderHead(null);

    const a = this.audio;
    this.playBtn.addEventListener('click', () => this.toggle());
    $('#pl-close').addEventListener('click', () => this.close());
    $('#pl-rate').addEventListener('change', (e) => { a.playbackRate = Number(e.target.value); });
    this.seekEl.addEventListener('input', () => {
      this.seeking = true;
      if (a.duration) this.timeEl.textContent = `${fmtTime((this.seekEl.value / 1000) * a.duration)} / ${fmtTime(a.duration)}`;
    });
    this.seekEl.addEventListener('change', () => {
      this.app.recordings?.cancelWait();
      this.seeking = false;
      if (a.duration) a.currentTime = (this.seekEl.value / 1000) * a.duration;
    });
    a.addEventListener('timeupdate', () => this.sync());
    a.addEventListener('loadedmetadata', () => this.sync());
    a.addEventListener('play', () => this.setPlaying(true));
    a.addEventListener('pause', () => this.setPlaying(false));
    a.addEventListener('ended', () => {
      if (this.app.recordings?.ended(this.asset)) return; // "Repeat each sentence": the last one again
      this.setPlaying(false);
      this.app.onAudioTime?.(null);
    });
    a.addEventListener('error', () => {
      if (this.asset) this.app.toast('This recording could not be played.');
    });
  }

  get open() { return !this.bar.hidden; }

  /**
   * Play a recording. asset: {src, title, script (URL of timed lines) or cues (the lines
   * themselves)}. tab: side panel tab to show (null keeps the current one).
   * at: start at this second (if the recording is already loaded, it just jumps there).
   */
  async play(asset, { tab = 'listen', at = null } = {}) {
    this.app.reader.stop();
    const a = this.audio;
    if (this.asset === asset && this.open) {
      if (at == null) this.toggle();
      else this.seek(at, true);
      return;
    }
    this.app.markPlaying(this.asset, false);
    this.app.onAudioTime?.(null);
    this.asset = asset;
    a.src = asset.src;
    if (at != null) {
      a.currentTime = at; // before loading, this sets where playback starts
      a.addEventListener('loadedmetadata', () => { if (Math.abs(a.currentTime - at) > 0.3) a.currentTime = at; }, { once: true });
    }
    a.playbackRate = Number($('#pl-rate').value);
    $('#pl-title').textContent = asset.title.replace(/^Listen to /, '');
    this.bar.hidden = false;
    this.app.layoutChanged();
    a.play().catch(() => {});

    const cues = asset.cues || (asset.script ? await getJSON(asset.script) : null);
    if (this.asset !== asset) return;
    this.renderHead(asset, cues);
    this.transcript.render(cues);
    if (tab) this.app.showTab(tab);
  }

  renderHead(asset, cues) {
    const head = $('#cue-head');
    if (!asset) {
      head.innerHTML = 'Audio script<small>Click a headphones button on the page to play a recording. Its script appears here and follows the audio.</small>';
    } else if (!cues) {
      head.innerHTML = `${escapeHtml(asset.title.replace(/^Listen to /, ''))}<small>This recording has no audio script.</small>`;
    } else {
      head.innerHTML = `${escapeHtml(asset.title.replace(/^Listen to /, ''))}<small>Click a line to jump to it.</small>`;
    }
  }

  toggle() {
    this.app.recordings?.cancelWait();
    const a = this.audio;
    if (a.paused) { this.app.reader.stop(); a.play().catch(() => {}); } else a.pause();
  }

  pause() { this.audio.pause(); }

  seek(sec, play) {
    this.audio.currentTime = sec;
    if (play) { this.app.reader.stop(); this.audio.play().catch(() => {}); }
  }

  setPlaying(on) {
    this.playBtn.innerHTML = icon(on ? 'pause' : 'play');
    this.playBtn.setAttribute('aria-label', on ? 'Pause' : 'Play');
    this.app.markPlaying(this.asset, on);
    // Recordings made in the app highlight the text word by word: report the time every frame.
    cancelAnimationFrame(this.raf);
    if (on && this.asset?.rec) {
      const tick = () => {
        if (this.audio.paused || !this.asset?.rec) return;
        this.app.onAudioTime?.(this.asset, this.audio.currentTime * 1000);
        this.raf = requestAnimationFrame(tick);
      };
      tick();
    }
  }

  sync() {
    const a = this.audio;
    if (!this.seeking && a.duration) this.seekEl.value = String(Math.round((a.currentTime / a.duration) * 1000));
    if (!this.seeking) this.timeEl.textContent = `${fmtTime(a.currentTime)} / ${fmtTime(a.duration)}`;
    this.transcript.update(a.currentTime * 1000);
    if (this.asset?.rec) this.app.onAudioTime?.(this.asset, a.currentTime * 1000); // also while paused (seeking)
  }

  close() {
    this.app.recordings?.cancelWait();
    this.audio.pause();
    this.app.markPlaying(this.asset, false);
    this.app.onAudioTime?.(null);
    this.asset = null;
    this.audio.removeAttribute('src');
    this.audio.load();
    this.bar.hidden = true;
    this.transcript.render([]);
    this.renderHead(null);
    this.app.layoutChanged();
  }
}

// ---------- Dialogs ----------

const dialog = () => $('#media-dialog');
let cleanup = null;

export function openDialog(title, body) {
  const d = dialog();
  closeDialog();
  $('#md-title').textContent = title;
  $('#md-body').replaceChildren(body);
  if (!d.open) d.showModal();
}

export function closeDialog() {
  const d = dialog();
  cleanup?.();
  cleanup = null;
  $('#md-body').replaceChildren();
  if (d.open) d.close();
}

export function initDialog() {
  const d = dialog();
  $('#md-close').addEventListener('click', closeDialog);
  d.addEventListener('close', () => { cleanup?.(); cleanup = null; $('#md-body').replaceChildren(); });
  d.addEventListener('click', (e) => { if (e.target === d) closeDialog(); }); // click on the backdrop
}

/** A video, with its script next to it (and the script's translation: ScriptTranslation). */
export async function openVideo(app, asset, book) {
  app.reader.stop();
  app.audio.pause();
  const video = el('video', { controls: true, autoplay: true, playsinline: true, src: asset.src });
  const list = el('ol', { class: 'cue-list' });
  const transcript = new Transcript(list, (t) => { video.currentTime = t; video.play().catch(() => {}); });
  const id = asset.script?.match(/([A-Z]{2}-[0-9a-f]+)\.json$/)?.[1];
  const tr = id && book ? new ScriptTranslation(app.translator, transcript, book, id) : null;
  const side = el('div', { class: 'cue-side' }, ...(tr ? [tr.el] : []), list);
  const body = el('div', { class: 'dialog-body' }, el('div', { class: 'video-wrap' }, video), side);
  openDialog(asset.title.replace(/^Play /, ''), body);
  video.addEventListener('timeupdate', () => transcript.update(video.currentTime * 1000));
  video.addEventListener('error', () => app.toast('This video could not be played.'));
  cleanup = () => { video.pause(); video.removeAttribute('src'); video.load(); };

  const cues = asset.script ? await getJSON(asset.script) : null;
  if (cues) {
    transcript.render(cues);
    tr?.refresh();
  } else {
    tr?.el.remove();
    list.replaceChildren(el('li', { class: 'empty' }, 'This video has no script.'));
  }
}

let ruffleLoading = null;
function loadRuffle() {
  if (!ruffleLoading) {
    ruffleLoading = new Promise((resolve, reject) => {
      window.RufflePlayer = window.RufflePlayer || {};
      window.RufflePlayer.config = {
        publicPath: '/web/vendor/ruffle/',
        polyfills: false,
        autoplay: 'on',
        unmuteOverlay: 'hidden',
        splashScreen: false,
        contextMenu: 'off',
        letterbox: 'on',
        backgroundColor: '#FFFFFF',
        warnOnUnsupportedContent: false,
        showSwfDownload: false,
        openUrlMode: 'deny',
        logLevel: 'error',
      };
      const s = el('script', { src: '/web/vendor/ruffle/ruffle.js' });
      s.onload = () => resolve(window.RufflePlayer);
      s.onerror = () => reject(new Error('Ruffle failed to load'));
      document.head.append(s);
    });
  }
  return ruffleLoading;
}

export async function openSwf(app, asset) {
  app.reader.stop();
  const w = asset.w || 400, h = asset.h || 300;
  // Answer keys are small; show them larger but keep them on screen.
  const scale = Math.max(1, Math.min(2.2, (innerWidth * 0.86) / w, (innerHeight * 0.78) / h));
  const wrap = el('div', { class: 'swf-wrap' });
  openDialog(asset.title, wrap);
  try {
    const ruffle = await loadRuffle();
    const player = ruffle.newest().createPlayer();
    player.style.width = `${Math.round(w * scale)}px`;
    player.style.height = `${Math.round(h * scale)}px`;
    wrap.append(player);
    cleanup = () => player.remove();
    const api = typeof player.ruffle === 'function' ? player.ruffle() : player;
    await api.load({ url: asset.src });
  } catch (err) {
    console.error(err);
    wrap.replaceChildren(el('p', { class: 'swf-note' }, 'This answer key could not be shown. The Flash emulator (Ruffle) failed to load it.'));
  }
}

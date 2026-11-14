// Audio player bar, video dialog and Flash answer-key dialog (via Ruffle),
// with timed transcripts that follow the recording.
import { $, el, escapeHtml, fmtTime, getJSON, icon, store, toast } from './util.js';
import { ScriptTranslation } from './translation.js';
import { repeatTimes } from './speech.js';
import { AUTO_NOTE, savedTranscript, speechButton, speechDialog, transcribeButton, transcribeRecording } from './transcription.js';

/** The id of a recording's script (its translations are saved under it): AU-… or VI-… of the disc;
 * of a recording added to a library book AU-<its file's sha256>. */
const scriptId = (asset) => (asset.script || asset.src || '').match(/([A-Z]{2}-[0-9a-f]+)(?:\.json|\/[^/]+)$/)?.[1]
  || (asset.src || '').match(/\/migration-media\/([0-9a-f]{64})\.\w+$/)?.[1]?.replace(/^/, 'AU-') || null;

function parseCueTime(value) {
  const text = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const match = text.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
  if (!match || Number(match[2]) >= 60) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function cueWords(cue, nextCue) {
  if (Array.isArray(cue.words) && cue.words.length) return cue.words;
  const tokens = String(cue.x || '').match(/\S+/gu) || [];
  const end = nextCue?.t ?? cue.t + 2500;
  const span = Math.max(0, end - cue.t);
  return tokens.map((x, i) => ({ x, t: Math.round(cue.t + span * i / Math.max(1, tokens.length)) }));
}

/**
 * A clickable list of the timed lines of a recording or video (its script) that highlights the
 * line being played. A click on a line plays it; a click on the line being played pauses (and
 * plays again). Each line is played as often as "Repeat each sentence" says (1–10 times or ∞):
 * at the end of the line it goes back to its start. media: the <audio> or <video>.
 * seek(seconds): play from there; toggle(): pause or play; repeats(): whether to repeat here.
 */
export class Transcript {
  constructor(listEl, media, { seek, toggle, repeats = () => true, onMap = () => {}, onCue = () => {}, onWordCue = () => {}, onChange = () => {}, onInsert = () => {}, onDelete = () => {}, onMerge = () => {}, onRetiming = () => {}, onWordSelect = () => {} }) {
    this.list = listEl;
    this.media = media;
    this.seekTo = seek;
    this.toggle = toggle;
    this.repeats = repeats;
    this.onMap = onMap;
    this.onCue = onCue;
    this.onWordCue = onWordCue;
    this.onChange = onChange;
    this.onInsert = onInsert;
    this.onDelete = onDelete;
    this.onMerge = onMerge;
    this.onRetiming = onRetiming;
    this.onWordSelect = onWordSelect;
    this.mergeMode = false;
    this.mergeOrder = [];
    this.editMode = false;
    this.selectedIndex = null;
    this.wordMapCueIndex = null;
    this.pendingWord = null;
    this.editingIndex = null;
    this.cues = [];
    this.items = [];
    this.current = -1;
    this.rep = null; // {i, round}: the line being played, and how many times so far
    this.userScrollUntil = 0;
    listEl.addEventListener('wheel', () => { this.userScrollUntil = Date.now() + 4000; }, { passive: true });
    media.addEventListener('play', () => this.watch());
    // The person moved in the recording (a line, the seek bar): count from there again.
    media.addEventListener('seeking', () => { if (this.ownSeek) this.ownSeek = false; else this.rep = null; });
  }

  render(cues, maps = {}, mapIndex = null, canMap = false, canEdit = false) {
    this.cues = cues || [];
    if (!Number.isInteger(this.selectedIndex) || this.selectedIndex < 0 || this.selectedIndex >= this.cues.length) this.selectedIndex = null;
    for (const button of this.editActionButtons || []) button.disabled = this.selectedIndex == null;
    this.lastMaps = maps || {};
    this.lastMapIndex = mapIndex;
    this.canMap = canMap;
    this.canEdit = canEdit;
    this.current = -1;
    this.rep = null;
    this.items = this.cues.map((c, i) => {
      const target = maps[i];
      const speaker = c.speaker === 'A' ? 'Speaker A' : c.speaker === 'B' ? 'Speaker B' : c.speaker === 'explanation' ? 'Explanation' : '';
      const words = cueWords(c, this.cues[i + 1]);
      const wordLine = canMap ? el('span', { class: 'cue-words' }, ...words.flatMap((word, wi) => {
        const mapped = word.book;
        const button = el('button', {
          class: `cue-word${mapped ? ' mapped' : ''}${this.pendingWord?.cueIndex === i && this.pendingWord?.wordIndex === wi ? ' selected' : ''}`,
          type: 'button', 'data-word-index': String(wi),
          'aria-label': `Audio word ${wi + 1}: ${word.x}${mapped ? `, mapped to ${mapped.text}` : ''}`,
          title: mapped ? `Book word: ${mapped.text}` : this.wordMapCueIndex === i ? 'Choose this audio word, then click its original book word' : 'Play from this transcribed word',
        }, word.x);
        button.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.wordMapCueIndex === i) {
            this.pendingWord = { cueIndex: i, wordIndex: wi };
            this.onWordSelect(i, wi);
            this.render(this.cues, maps, mapIndex, canMap, canEdit);
          } else if (canEdit && this.editMode) {
            this.selectedIndex = i;
            this.render(this.cues, maps, mapIndex, canMap, canEdit);
          } else this.seekTo((word.t ?? c.t) / 1000);
        });
        return wi < words.length - 1 ? [button, ' '] : [button];
      })) : el('span', {}, c.x);
      const content = el('span', { class: 'cue-content' }, speaker ? el('strong', { class: `cue-speaker ${c.speaker}` }, speaker) : null, wordLine,
        target ? el('small', { class: 'cue-map-label' }, `↳ p.${target.page}: ${target.text}`) : null);
      const order = this.mergeOrder.indexOf(i);
      const li = el('li', { class: `cue${mapIndex === i ? ' mapping' : ''}${order >= 0 ? ' merge-selected' : ''}${this.editMode && this.selectedIndex === i ? ' edit-selected' : ''}`, tabindex: '0' },
        el('time', {}, order >= 0 ? `${order + 1}. ${fmtTime(c.t / 1000)}` : fmtTime(c.t / 1000)), content);
      const click = () => {
        if (this.mergeMode) {
          const selected = this.mergeOrder.indexOf(i);
          if (selected >= 0) this.mergeOrder.splice(selected, 1);
          else this.mergeOrder.push(i);
          this.render(this.cues, maps, mapIndex, canMap, canEdit);
          this.onMergeSelection?.();
          return;
        }
        if (canEdit && this.editMode) {
          this.selectedIndex = i;
          this.render(this.cues, maps, mapIndex, canMap, canEdit);
          return;
        }
        if (i === this.current && this.toggle) this.toggle(); // the line being played: pause / play
        else this.seekTo(c.t / 1000);
      };
      li.addEventListener('click', click);
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.target.closest('button,textarea,select,input')) click(); });
      return li;
    });
    this.list.replaceChildren(...this.items);
  }

  performEdit(action) {
    const i = this.selectedIndex, c = this.cues[i];
    if (!this.editMode || !c) { toast('Select a transcript line first.'); return; }
    if (action === 'mapWords') { this.startWordMap(i); return; }
    if (action === 'mapSentence') { this.onMap(i); return; }
    if (action === 'text') {
      const value = window.prompt('Correct this transcript line:', c.x);
      if (value == null || !value.trim()) return;
      const next = this.cues.map((cue, j) => {
        if (j !== i) return cue;
        const updated = { ...cue, x: value.trim() };
        const tokens = value.trim().match(/\S+/gu) || [];
        if (Array.isArray(cue.words) && cue.words.length === tokens.length) updated.words = cue.words.map((word, k) => ({ ...word, x: tokens[k] }));
        else delete updated.words;
        return updated;
      });
      this.onChange(next);
      return;
    }
    if (action === 'time') {
      const value = window.prompt('Change this segment start time (seconds or m:ss):', fmtTime(c.t / 1000));
      if (value == null) return;
      const time = parseCueTime(value);
      if (time == null || (Number.isFinite(this.media.duration) && time > this.media.duration)) {
        toast('Enter a valid time within the recording duration.');
        return;
      }
      const retimed = this.cues.map((cue, j) => {
        if (j !== i) return { ...cue, _oldIndex: j };
        const start = Math.round(time * 1000), delta = start - cue.t;
        return { ...cue, t: start, words: cue.words?.map((word) => ({ ...word, t: Math.max(0, (word.t ?? cue.t) + delta), ...(word.e == null ? {} : { e: Math.max(0, word.e + delta) }) })), _oldIndex: j };
      });
      retimed.sort((a, b) => a.t - b.t || a._oldIndex - b._oldIndex);
      const remap = {};
      for (let j = 0; j < retimed.length; j++) {
        remap[retimed[j]._oldIndex] = j;
        delete retimed[j]._oldIndex;
      }
      this.selectedIndex = remap[i];
      this.onRetiming(retimed, remap);
      return;
    }
    if (action === 'speaker') {
      const value = window.prompt('Speaker label: A, B, Explanation, or blank:', c.speaker || '');
      if (value == null) return;
      const role = value.trim().toLowerCase();
      if (role && !['a', 'b', 'explanation'].includes(role)) { toast('Enter A, B, Explanation, or leave it blank.'); return; }
      this.onChange(this.cues.map((cue, j) => {
        if (j !== i) return cue;
        const updated = { ...cue };
        if (!role) delete updated.speaker;
        else updated.speaker = role === 'explanation' ? role : role.toUpperCase();
        return updated;
      }));
      return;
    }
    if (action === 'split') {
      const first = window.prompt('Enter the first part of this line. The remaining text becomes the next line:', c.x);
      if (first == null) return;
      const head = first.trim(), whole = String(c.x || '').trim();
      if (!head || !whole.startsWith(head) || head.length >= whole.length) {
        toast('The first part must be the beginning of the line and leave text for the next line.');
        return;
      }
      const tail = whole.slice(head.length).trim(), next = [...this.cues];
      const end = next[i + 1]?.t ?? (Number.isFinite(this.media.duration) ? this.media.duration * 1000 : c.t + 2000);
      const ratio = head.length / whole.length;
      const splitTime = Math.max(c.t + 1, Math.min(end - 1, Math.round(c.t + Math.max(2, end - c.t) * ratio)));
      const firstCue = { ...c, x: head }, secondCue = { ...c, t: splitTime, x: tail };
      const tokens = whole.match(/\S+/gu) || [];
      if (Array.isArray(c.words) && c.words.length === tokens.length) {
        const count = head.match(/\S+/gu)?.length || 1;
        firstCue.words = c.words.slice(0, count);
        secondCue.words = c.words.slice(count);
        if (secondCue.words[0]) secondCue.t = secondCue.words[0].t;
      } else { delete firstCue.words; delete secondCue.words; }
      next[i] = firstCue;
      next.splice(i + 1, 0, secondCue);
      this.selectedIndex = i + 1;
      this.onInsert(next, i + 1);
      toast('Transcript line split.');
      return;
    }
    if (action === 'delete') {
      if (!window.confirm('Delete this transcript line?')) return;
      this.selectedIndex = Math.max(0, Math.min(i, this.cues.length - 2));
      this.onDelete(this.cues.filter((_, j) => j !== i), i);
    }
  }

  add(cue) {
    const next = [...this.cues];
    const found = next.findIndex((item) => item.t > cue.t);
    const index = found < 0 ? next.length : found;
    next.splice(index, 0, cue);
    this.onInsert(next, index);
  }

  startWordMap(index) {
    this.wordMapCueIndex = this.wordMapCueIndex === index ? null : index;
    this.pendingWord = null;
    this.onWordSelect(null, null);
    this.render(this.cues, this.lastMaps, this.lastMapIndex, this.canMap, this.canEdit);
    if (this.wordMapCueIndex != null) toast(`Select a word in audio line ${index + 1}, then click its original word on the book page.`);
    else toast('Word mapping canceled.');
  }

  beginMerge() {
    this.mergeMode = true;
    this.mergeOrder = [];
    this.render(this.cues, this.lastMaps, this.lastMapIndex, this.canMap, this.canEdit);
    this.onMergeSelection?.();
  }

  finishMerge() {
    if (this.mergeOrder.length < 2) { toast('Select at least two transcript lines in the order they should be read.'); return; }
    const chosen = [...this.mergeOrder];
    const anchor = chosen[0];
    const selected = new Set(chosen);
    const merged = {
      ...this.cues[anchor],
      x: chosen.map((i) => this.cues[i].x).join(' '),
      words: chosen.flatMap((i) => cueWords(this.cues[i], this.cues[i + 1]).map((word) => ({ ...word }))),
    };
    const next = [];
    const remap = {};
    for (let old = 0; old < this.cues.length; old++) {
      if (old === anchor) {
        remap[old] = next.length;
        next.push(merged);
      } else if (!selected.has(old)) {
        remap[old] = next.length;
        next.push(this.cues[old]);
      }
    }
    this.mergeMode = false;
    this.mergeOrder = [];
    this.onMerge(next, remap);
  }

  cancelMerge() {
    this.mergeMode = false;
    this.mergeOrder = [];
    this.render(this.cues, this.lastMaps, this.lastMapIndex, this.canMap, this.canEdit);
    this.onMergeSelection?.();
  }

  /** The line at this time (-1: before the first). */
  lineAt(ms) {
    let i = -1;
    for (let k = 0; k < this.cues.length && this.cues[k].t <= ms; k++) i = k;
    return i;
  }

  /** While playing, every frame: at the end of a line that must be heard again, back to its start. */
  watch() {
    cancelAnimationFrame(this.raf);
    const step = () => {
      if (this.media.paused || !this.cues.length || !this.list.isConnected) return;
      if (this.repeats()) this.checkRepeat();
      this.raf = requestAnimationFrame(step);
    };
    step();
  }

  checkRepeat() {
    if (repeatTimes() !== this.shownTimes) this.showRound(); // the setting was changed meanwhile
    const ms = this.media.currentTime * 1000;
    const next = this.lineAt(ms + 40); // a moment early, so the next line is not heard
    if (!this.rep) { this.rep = { i: this.lineAt(ms), round: 1 }; this.showRound(); return; }
    if (next === this.rep.i) return;
    if (next === this.rep.i + 1 && this.rep.i >= 0 && this.rep.round < repeatTimes()) {
      this.rep.round++;
      this.jump(this.cues[this.rep.i].t);
    } else this.rep = { i: next, round: 1 };
    this.showRound();
  }

  /** The recording ended: play its last line again if wanted. Returns true if it plays again. */
  ended() {
    const r = this.rep, last = this.cues.length - 1;
    if (!this.repeats() || !r || r.i !== last || last < 0 || r.round >= repeatTimes()) return false;
    r.round++;
    this.showRound();
    this.jump(this.cues[last].t);
    this.media.play().catch(() => {});
    return true;
  }

  jump(ms) {
    this.ownSeek = true;
    this.media.currentTime = ms / 1000;
  }

  /** "2/3" under the time of the line being repeated. */
  showRound() {
    this.list.querySelectorAll('time[data-round]').forEach((t) => t.removeAttribute('data-round'));
    const times = repeatTimes(), r = this.rep;
    this.shownTimes = times;
    if (!r || times === 1 || !this.items[r.i] || !this.repeats()) return;
    this.items[r.i].querySelector('time').dataset.round = `${r.round}/${times === Infinity ? '∞' : times}`;
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
    const words = i >= 0 ? cueWords(this.cues[i], this.cues[i + 1]) : [];
    let wi = -1;
    for (let k = 0; k < words.length && (words[k].t ?? this.cues[i].t) <= ms + 80; k++) wi = k;
    this.items[this.current]?.querySelectorAll('.cue-word.active').forEach((word) => word.classList.remove('active'));
    if (i >= 0 && wi >= 0) this.items[i]?.querySelector(`[data-word-index="${wi}"]`)?.classList.add('active');
    const wordKey = `${i}:${wi}`;
    this.currentWord = i >= 0 && wi >= 0 ? { cueIndex: i, wordIndex: wi } : null;
    if (wordKey !== this.wordCue) { this.wordCue = wordKey; if (i >= 0 && wi >= 0) this.onWordCue(i, wi); }
    if (i === this.current) return;
    this.items[this.current]?.classList.remove('active');
    this.current = i;
    const item = this.items[i];
    if (!item) return;
    item.classList.add('active');
    this.onCue(i);
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
    this.bookId = null;
    this.mapCueIndex = null;
    this.wordMapSelection = null;
    this.shown = 0; // counts the recordings shown: work for an earlier one stops
    this.transcript = new Transcript($('#cue-list'), this.audio, {
      seek: (t) => this.seek(t, true),
      toggle: () => this.toggle(),
      repeats: () => !!this.asset && !this.asset.rec && !app.assistant?.busy, // My audio MP3s repeat by themselves (recordings.js)
      onMap: (i) => this.startMap(i),
      onCue: (i) => this.followMappedCue(i),
      onWordCue: (i, wi) => this.followMappedWord(i, wi),
      onChange: (cues) => this.saveTranscript(cues),
      onInsert: (cues, index) => this.insertTranscriptLine(cues, index),
      onDelete: (cues, index) => this.deleteTranscriptLine(cues, index),
      onMerge: (cues, remap) => this.mergeTranscriptLines(cues, remap),
      onRetiming: (cues, remap) => this.retimeTranscriptLines(cues, remap),
      onWordSelect: (cueIndex, wordIndex) => { this.wordMapSelection = cueIndex == null ? null : { cueIndex, wordIndex }; },
      onMergeSelection: () => this.updateMergeControls(),
    });
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
      if (this.transcript.ended()) return;
      this.setPlaying(false);
      this.app.onAudioTime?.(null);
    });
    a.addEventListener('error', () => {
      if (this.asset) this.app.toast('This recording could not be played.');
    });
  }

  get open() { return !this.bar.hidden; }

  /** The buttons over the script on the Script tab (made once the translator exists). */
  scriptTools() {
    if (!this.scriptTr) {
      this.scriptTr = new ScriptTranslation(this.app.translator, this.transcript);
      const tr = this.scriptTr;
      $('#cue-head').after(el('div', { class: 'cue-tools' }, tr.underBtn, tr.pointBtn, tr.lang), tr.note);
    }
    return this.scriptTr;
  }

  /**
   * Play a recording. asset: {src, title, script (URL of timed lines) or cues (the lines
   * themselves)}. tab: side panel tab to show (null keeps the current one); the Script tab
   * ('listen') also opens the panel. book: the book of a recording on the disc (to translate
   * its script). at: start at this second (if the recording is already loaded, it just jumps there).
   */
  async play(asset, { tab = 'listen', at = null, book = null, language = 'en' } = {}) {
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
    this.bookId = book;
    this.mapCueIndex = null;
    this.wordMapSelection = null;
    this.transcript.wordMapCueIndex = null;
    this.transcript.pendingWord = null;
    this.transcript.editMode = false;
    asset.transcribeLanguage = language || 'en';
    const shown = ++this.shown;
    a.src = asset.src;
    if (at != null) {
      a.currentTime = at; // before loading, this sets where playback starts
      a.addEventListener('loadedmetadata', () => { if (Math.abs(a.currentTime - at) > 0.3) a.currentTime = at; }, { once: true });
    }
    a.playbackRate = Number($('#pl-rate').value);
    $('#pl-title').textContent = asset.title.replace(/^Listen to /, '');
    this.bar.hidden = false;
    if (tab === 'listen') { // the script of the recording, at once
      this.app.showTab(tab);
      this.app.setPanelOpen(true);
    }
    this.app.layoutChanged();
    a.play().catch(() => {});

    let cues = asset.cues || (asset.script ? await getJSON(asset.script).catch(() => null) : null);
    // A recording without a script: transcribed before (or now)? One speech recognition wrote
    // (auto): written again since (e.g. by ElevenLabs, better)?
    const job = (!cues || asset.auto) && book && !asset.rec ? await savedTranscript(asset, asset.transcribeLanguage) : null;
    if (shown !== this.shown) return;
    if (job?.state === 'done') cues = job.cues;
    const corrections = store.get('audioTranscriptCorrections', {})[asset.src];
    if (Array.isArray(corrections)) cues = corrections;
    this.showScript(asset, cues, book);
    if (tab) this.app.showTab(tab);
    if (['queued', 'running'].includes(job?.state)) this.transcribe(asset, book, job);
  }

  showScript(asset, cues, book) {
    if (this.transcriptSource !== asset?.src) {
      this.transcript.selectedIndex = null;
      this.transcriptSource = asset?.src;
    }
    this.bookId = book;
    this.renderHead(asset, cues, book);
    this.transcript.render(cues, this.mapsFor(asset), null, !!book && !asset.rec, !!asset && !asset.rec);
    this.scriptTools().setScript(book, !asset.rec && cues && book ? scriptId(asset) : null);
  }

  saveTranscript(cues) {
    if (!this.asset) return;
    const corrections = store.get('audioTranscriptCorrections', {});
    corrections[this.asset.src] = cues;
    store.set('audioTranscriptCorrections', corrections);
    this.showScript(this.asset, cues, this.bookId);
    this.scriptTr?.refresh();
    toast('Transcript correction saved in this browser.');
  }

  shiftSentenceMaps(index, delta) {
    if (!this.asset) return;
    const all = store.get('audioBookSentenceMaps', {});
    const existing = all[this.asset.src] || {};
    const shifted = {};
    for (const [key, value] of Object.entries(existing)) {
      const i = Number(key);
      if (delta < 0 && i === index) continue;
      shifted[String(i >= index ? i + delta : i)] = value;
    }
    all[this.asset.src] = shifted;
    store.set('audioBookSentenceMaps', all);
  }

  insertTranscriptLine(cues, index) {
    this.shiftSentenceMaps(index, 1);
    this.saveTranscript(cues);
    toast('Transcript line added.');
  }

  deleteTranscriptLine(cues, index) {
    this.shiftSentenceMaps(index, -1);
    this.saveTranscript(cues);
    toast('Transcript line deleted.');
  }

  mergeTranscriptLines(cues, remap) {
    if (!this.asset) return;
    const all = store.get('audioBookSentenceMaps', {});
    const existing = all[this.asset.src] || {};
    const shifted = {};
    for (const [old, value] of Object.entries(existing)) {
      if (Object.hasOwn(remap, old)) shifted[String(remap[old])] = value;
    }
    all[this.asset.src] = shifted;
    store.set('audioBookSentenceMaps', all);
    this.saveTranscript(cues);
    this.scriptTr?.refresh();
    toast('Transcript lines merged in the order selected. The first selected line keeps its position and mapping.');
  }

  retimeTranscriptLines(cues, remap) {
    if (!this.asset) return;
    const all = store.get('audioBookSentenceMaps', {});
    const existing = all[this.asset.src] || {};
    const shifted = {};
    for (const [old, value] of Object.entries(existing)) {
      if (Object.hasOwn(remap, old)) shifted[String(remap[old])] = value;
    }
    all[this.asset.src] = shifted;
    store.set('audioBookSentenceMaps', all);
    this.saveTranscript(cues);
    toast('Segment start time updated; sentence mapping followed the segment.');
  }

  updateMergeControls() {
    if (!this.mergeButton) return;
    this.mergeButton.title = this.transcript.mergeMode
      ? `Finish ordered merge (${this.transcript.mergeOrder.length} selected)`
      : 'Merge selected transcript lines in order';
    this.mergeButton.setAttribute('aria-label', this.mergeButton.title);
    this.mergeCancelButton.hidden = !this.transcript.mergeMode;
  }

  addTranscriptLine() {
    if (!this.asset || this.asset.rec) return;
    const time = Math.round(this.audio.currentTime * 1000);
    const value = window.prompt(`Add a transcript line at ${fmtTime(time / 1000)}:`);
    if (value == null || !value.trim()) return;
    this.transcript.add({ t: time, x: value.trim() });
  }

  mapsFor(asset = this.asset) {
    return asset ? (store.get('audioBookSentenceMaps', {})[asset.src] || {}) : {};
  }

  startMap(index) {
    if (!this.asset || !this.bookId) return;
    this.transcript.wordMapCueIndex = null;
    this.transcript.pendingWord = null;
    this.wordMapSelection = null;
    this.mapCueIndex = this.mapCueIndex === index ? null : index;
    this.transcript.render(this.transcript.cues, this.mapsFor(), this.mapCueIndex, true, !this.asset.rec);
    this.scriptTr?.refresh();
    toast(this.mapCueIndex == null ? 'Sentence mapping canceled.' : `Click the matching book sentence for audio line ${index + 1}.`);
  }

  mapBookWord(view, wordIndex) {
    const selected = this.wordMapSelection;
    if (!selected || !Number.isInteger(wordIndex) || wordIndex < 0) return false;
    if (view.book.slug !== this.bookId) { toast('Choose an original word from this recording’s book.'); return true; }
    const cue = this.transcript.cues[selected.cueIndex];
    if (!cue) { this.wordMapSelection = null; return true; }
    const words = cueWords(cue, this.transcript.cues[selected.cueIndex + 1]).map((word) => ({ ...word }));
    if (!words[selected.wordIndex]) { toast('That audio word is no longer available.'); return true; }
    const bookWord = view.text.text(wordIndex, wordIndex + 1);
    words[selected.wordIndex].book = {
      book: this.bookId, path: view.page.path, page: view.page.n, word: wordIndex, text: bookWord,
    };
    const next = this.transcript.cues.map((item, i) => i === selected.cueIndex ? { ...item, words } : item);
    this.wordMapSelection = null;
    this.transcript.pendingWord = null;
    this.transcript.wordMapCueIndex = null;
    this.saveTranscript(next);
    const unit = { mode: 'word', a: wordIndex, b: wordIndex + 1 };
    view.showActive(unit);
    view.showWord(wordIndex);
    this.app.markPanel('active', view, unit);
    this.app.focus = { view, w: wordIndex };
    toast(`Mapped audio word “${words[selected.wordIndex].x}” to book word “${bookWord}”.`);
    return true;
  }

  mapSentence(view, unit) {
    if (this.mapCueIndex == null) return false;
    if (view.book.slug !== this.bookId) { toast('Choose a sentence from this recording’s book.'); return true; }
    const s = view.text?.w2s[unit.a] ?? -1;
    if (s < 0) { toast('That page text is not available to map.'); return true; }
    const [a, b] = view.text.sent[s];
    const maps = store.get('audioBookSentenceMaps', {});
    const forAsset = { ...(maps[this.asset.src] || {}) };
    forAsset[this.mapCueIndex] = { book: this.bookId, path: view.page.path, page: view.page.n, text: view.text.text(a, b) };
    maps[this.asset.src] = forAsset;
    store.set('audioBookSentenceMaps', maps);
    const index = this.mapCueIndex;
    this.mapCueIndex = null;
    this.wordMapSelection = null;
    this.transcript.wordMapCueIndex = null;
    this.transcript.pendingWord = null;
    this.transcript.render(this.transcript.cues, forAsset, null, true, !this.asset.rec);
    this.scriptTr?.refresh();
    const mappedUnit = { mode: 'sentence', a, b };
    view.showActive(mappedUnit);
    this.app.markPanel('active', view, mappedUnit);
    this.app.focus = { view, w: a };
    toast(`Mapped audio line ${index + 1} to page ${view.page.n}, sentence ${s + 1}.`);
    return true;
  }

  followMappedCue(index, afterNavigation = false) {
    if (!this.asset || !this.bookId || index < 0) return;
    if (this.transcript.currentWord?.cueIndex === index && this.transcript.cues[index]?.words?.[this.transcript.currentWord.wordIndex]?.book) return;
    const target = this.mapsFor()[index];
    if (!target || target.book !== this.bookId) return;
    const view = this.app.views.find((v) => v.book.slug === target.book && v.page.path === target.path && v.text);
    if (view) {
      const s = view.text.findSentence(target.text);
      if (s < 0) return;
      const [a, b] = view.text.sent[s];
      const unit = { mode: 'sentence', a, b };
      view.showActive(unit);
      this.app.markPanel('active', view, unit);
      this.app.focus = { view, w: a };
      this.app.follower.reading(view, unit);
      return;
    }
    const page = this.app.book?.id === target.book && this.app.book.pages.find((p) => p.path === target.path);
    if (page && !afterNavigation) this.app.go(target.book, page.n)
      .then(() => this.app.pageReady).then(() => this.followMappedCue(index, true));
  }

  followMappedWord(index, wordIndex, afterNavigation = false) {
    const target = this.transcript.cues[index]?.words?.[wordIndex]?.book;
    if (!target || target.book !== this.bookId) return;
    const view = this.app.views.find((v) => v.book.slug === target.book && v.page.path === target.path && v.text);
    if (view) {
      this.app.views.forEach((v) => { v.showActive(null); v.showWord(-1); });
      const unit = { mode: 'word', a: target.word, b: target.word + 1 };
      view.showActive(unit);
      view.showWord(target.word);
      this.app.markPanel('active', view, unit);
      this.app.focus = { view, w: target.word };
      return;
    }
    const page = this.app.book?.id === target.book && this.app.book.pages.find((p) => p.path === target.path);
    if (page && !afterNavigation) this.app.go(target.book, page.n)
      .then(() => this.app.pageReady).then(() => this.followMappedWord(index, wordIndex, true));
  }

  renderHead(asset, cues, book = null) {
    const head = $('#cue-head');
    this.transcript.editActionButtons = [];
    this.mergeButton = null;
    this.mergeCancelButton = null;
    this.transcribeStatus = null;
    const title = asset && escapeHtml(asset.title.replace(/^Listen to /, ''));
    if (!asset) {
      head.innerHTML = 'Audio script<small>Click a headphones button on the page to play a recording. Its script appears here and follows the audio.</small>';
      head.append(el('div', { class: 'cue-transcript-tools' }, el('button', { class: 'btn small', type: 'button', onclick: () => speechDialog(this.app),
        title: 'Write down what is said in any audio or video file (ElevenLabs or this computer)' }, 'Transcribe a file…')));
    } else {
      const detected = cues?.some((cue) => cue.speaker) ? ' Speaker labels are automatic; a third detected voice is marked Explanation.' : '';
      const editHelp = asset && !asset.rec ? (this.transcript.editMode
        ? ' Click a transcript line to select it; the toolbar tools apply to that line.'
        : ' Use the pencil above the transcript to edit segments and map words.') : '';
      head.innerHTML = `${title}<small>${cues ? 'Click a line or word to play it; click a playing line to pause.' : 'This recording has no transcript.'}${detected}${editHelp}</small>`;
      if (cues && (asset.auto || asset.generatedCues)) head.append(el('small', { class: 'auto-note' }, AUTO_NOTE));
    }
    if (asset) {
      const tools = [repeatButton(this.app)];
      if (cues && !asset.rec) {
        const edit = el('button', { class: 'icon-btn small', type: 'button', title: 'Edit transcript segments', 'aria-label': 'Edit transcript segments', 'aria-pressed': String(this.transcript.editMode), html: icon('pencil') });
        edit.addEventListener('click', () => {
          this.transcript.editMode = !this.transcript.editMode;
          if (!this.transcript.editMode) this.transcript.selectedIndex = null;
          this.showScript(asset, this.transcript.cues, book);
        });
        tools.push(edit);
        if (this.transcript.editMode) {
          const action = (name, title, glyph, enabled = true) => {
            const button = el('button', { class: 'icon-btn small', type: 'button', title, 'aria-label': title, disabled: !enabled || this.transcript.selectedIndex == null, html: icon(glyph) });
            button.addEventListener('click', () => this.transcript.performEdit(name));
            this.transcript.editActionButtons.push(button);
            tools.push(button);
          };
          action('text', 'Correct selected line text', 'text');
          action('time', 'Change selected line start time', 'clock');
          action('speaker', 'Change selected line speaker', 'user');
          action('split', 'Split selected line', 'scissors');
          action('delete', 'Delete selected line', 'trash');
          action('mapWords', 'Map selected audio words to book words', 'languages', !!book);
          action('mapSentence', 'Map selected line to a book sentence', 'target', !!book);
          this.mergeButton = el('button', { class: 'icon-btn small', type: 'button', title: 'Merge selected transcript lines in order', 'aria-label': 'Merge selected transcript lines in order', html: icon('merge-up') });
          this.mergeButton.addEventListener('click', () => this.transcript.mergeMode ? this.transcript.finishMerge() : this.transcript.beginMerge());
          this.mergeCancelButton = el('button', { class: 'icon-btn small', type: 'button', title: 'Cancel ordered merge', 'aria-label': 'Cancel ordered merge', hidden: '', html: icon('x') });
          this.mergeCancelButton.addEventListener('click', () => this.transcript.cancelMerge());
          tools.push(this.mergeButton, this.mergeCancelButton);
        } else {
          this.mergeButton = null;
          this.mergeCancelButton = null;
        }
      }
      const canTranscribe = !!book && !asset.rec && (!asset.script || asset.generatedCues || asset.auto);
      if (canTranscribe) {
        const button = transcribeButton();
        button.className = 'icon-btn small transcribe-btn';
        button.innerHTML = icon('transcribe');
        button.title = cues ? 'Transcribe this recording again' : 'Transcribe this recording';
        button.setAttribute('aria-label', button.title);
        const status = el('small', { class: 'transcribe-status', role: 'status' });
        button.addEventListener('click', () => {
          const force = !!cues;
          if (force && !window.confirm('Replace this transcript? This clears its manual corrections and mappings.')) return;
          if (force) {
            for (const key of ['audioTranscriptCorrections', 'audioBookSentenceMaps']) {
              const values = store.get(key, {});
              delete values[asset.src];
              store.set(key, values);
            }
            this.transcript.editMode = false;
            this.showScript(asset, this.transcript.cues, book);
          }
          this.transcribe(asset, book, null, force);
        });
        tools.push(button, speechButton(this.app));
        this.transcribeStatus = status;
      } else {
        this.transcribeStatus = null;
      }
      if (cues && canTranscribe) {
        const remove = el('button', { class: 'icon-btn small danger', type: 'button', title: 'Delete transcript', 'aria-label': 'Delete transcript', html: icon('trash') });
        remove.addEventListener('click', () => this.deleteTranscript(asset, book));
        tools.push(remove);
      }
      if (tools.length || cues?.length) head.append(el('div', { class: 'cue-transcript-tools' }, ...tools));
      if (this.transcribeStatus) head.append(this.transcribeStatus);
      this.updateMergeControls();
    }
  }

  async deleteTranscript(asset, book) {
    if (!window.confirm('Delete this transcript, its corrections, and its sentence and word mappings?')) return;
    try {
      const response = await fetch(`/api/transcript?src=${encodeURIComponent(asset.src)}`, { method: 'DELETE' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'The transcript could not be deleted.');
      for (const key of ['audioTranscriptCorrections', 'audioBookSentenceMaps']) {
        const values = store.get(key, {});
        delete values[asset.src];
        store.set(key, values);
      }
      delete asset.generatedCues;
      this.transcript.editMode = false;
      this.transcript.wordMapCueIndex = null;
      this.wordMapSelection = null;
      this.showScript(asset, null, book);
      toast('Transcript deleted.');
    } catch (error) {
      toast(error.message || 'The transcript could not be deleted.');
    }
  }

  /** Transcribe the recording being played (or follow it: job) and show its lines when done. */
  transcribe(asset, book, job = null, force = false) {
    const shown = this.shown;
    transcribeRecording(asset, $('#cue-head .transcribe-btn'), $('#cue-head .transcribe-status'),
      (cues) => {
        const corrections = store.get('audioTranscriptCorrections', {})[asset.src];
        this.showScript(asset, Array.isArray(corrections) ? corrections : cues, book);
      }, () => shown === this.shown && this.open, job, asset.transcribeLanguage, force);
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
    this.bookId = null;
    this.mapCueIndex = null;
    this.wordMapSelection = null;
    this.transcript.wordMapCueIndex = null;
    this.transcript.pendingWord = null;
    this.transcript.editMode = false;
    this.shown++;
    this.audio.removeAttribute('src');
    this.audio.load();
    this.bar.hidden = true;
    this.transcript.render([]);
    this.scriptTr?.setScript(null, null);
    this.renderHead(null);
    this.app.layoutChanged();
  }
}

// ---------- Dialogs ----------

const dialog = () => $('#media-dialog');
let cleanup = null;
let keep = false; // (the open dialog stays when the page outside it is clicked)

/**
 * Show the dialog; onClose() runs when it is closed (or shows something else). keep: a click
 * outside it does not close it (a book being added, a form): only its × (or Cancel, Esc) does.
 */
export function openDialog(title, body, onClose = null, { keep: stay = false } = {}) {
  const d = dialog();
  closeDialog();
  cleanup = onClose;
  keep = stay;
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
  // (closed with Esc: its cleanup; the event comes a moment later: opened again meanwhile — another
  // dialog from this one — it is not that one's to empty)
  d.addEventListener('close', () => { if (d.open) return; cleanup?.(); cleanup = null; $('#md-body').replaceChildren(); });
  // A click on the backdrop closes it (unless it keeps). Pressed inside and let go outside (selecting text): no such click.
  let down = null;
  d.addEventListener('pointerdown', (e) => { down = e.target; });
  d.addEventListener('click', (e) => { if (e.target === d && down === d && !keep) closeDialog(); });
}

/** The repeat button of a script (the same setting as the one in the top bar: R). */
export function repeatButton(app) {
  const b = el('button', { class: 'icon-btn small repeat-btn', type: 'button', html: `${icon('repeat')}<span class="count-badge" hidden></span>` });
  b.addEventListener('click', () => app.cycleRepeat());
  app.showRepeat?.(b);
  return b;
}

/**
 * A video, with its script next to it: a click on a line plays it (on the line being played:
 * pause / play), each line is repeated as set, and the script can be translated.
 */
export async function openVideo(app, asset, book, language = 'en') {
  app.reader.stop();
  app.audio.pause();
  const video = el('video', { controls: true, autoplay: true, playsinline: true, src: asset.src });
  const list = el('ol', { class: 'cue-list' });
  const transcript = new Transcript(list, video, {
    seek: (t) => { video.currentTime = t; video.play().catch(() => {}); },
    toggle: () => { if (video.paused) video.play().catch(() => {}); else video.pause(); },
  });
  const body = el('div', { class: 'dialog-body' }, el('div', { class: 'video-wrap' }, video));
  const tr = new ScriptTranslation(app.translator, transcript, body); // its box inside the window (above everything)
  const tools = el('div', { class: 'cue-tools' }, tr.underBtn, tr.pointBtn, repeatButton(app), tr.lang);
  body.append(el('div', { class: 'cue-side' }, tools, tr.note, list));
  openDialog(asset.title.replace(/^Play /, ''), body);
  video.addEventListener('timeupdate', () => transcript.update(video.currentTime * 1000));
  video.addEventListener('ended', () => transcript.ended());
  video.addEventListener('error', () => app.toast('This video could not be played.'));
  cleanup = () => { video.pause(); video.removeAttribute('src'); video.load(); };

  const show = (cues) => {
    transcript.render(cues);
    tr.setScript(book, book ? scriptId(asset) : null);
    if (asset.auto || asset.generatedCues) tr.note.before(el('p', { class: 'auto-note' }, AUTO_NOTE));
  };
  const cues = asset.script ? await getJSON(asset.script).catch(() => null) : null;
  // A video without a script: transcribed before (or now)? Written again since (auto)?
  const job = (!cues || asset.auto) && book ? await savedTranscript(asset, language) : null;
  if (!list.isConnected) return; // closed meanwhile
  if (cues || job?.state === 'done') return show(job?.state === 'done' ? job.cues : cues);
  const empty = el('li', { class: 'empty' }, 'This video has no script.');
  list.replaceChildren(empty);
  if (!book) return;
  const button = transcribeButton(), status = el('small', { class: 'transcribe-status', role: 'status' });
  empty.append(el('div', { class: 'transcribe-row' }, button, status));
  const run = (running = null) => transcribeRecording(asset, button, status, show, () => list.isConnected, running, language);
  button.addEventListener('click', () => run());
  if (['queued', 'running'].includes(job?.state)) run(job);
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

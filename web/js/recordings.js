// "My audio": natural-voice MP3s of chosen sentences, made by the local server (web/tts.py).
// Choose whole paragraphs or single sentences, create one MP3, then play it from an icon next
// to the paragraph or from the list. While it plays, the text is highlighted like when reading.
import { $, el, icon, store, toast, fmtTime } from './util.js';
import { PageText, speakable } from './pagetext.js';
import { settings, repeatTimes, speech } from './speech.js';
import { openDialog, closeDialog } from './media.js';
import { offlineAudio } from './offline-audio.js';
import { isWindowsVoice, matchingRecordingVoice, recordingVoiceLabel, detectRecordingLanguage, offlineVoiceChoices } from './voice-options.js';

const gapMs = () => Math.round((Number(settings.gap) || 0) * 1000);

const ACCENTS = {
  'en-US': 'American', 'en-GB': 'British', 'en-AU': 'Australian', 'en-CA': 'Canadian', 'en-IE': 'Irish',
  'en-NZ': 'New Zealand', 'en-IN': 'Indian', 'en-ZA': 'South African', 'en-SG': 'Singapore',
  'en-PH': 'Philippine', 'en-HK': 'Hong Kong', 'en-KE': 'Kenyan', 'en-NG': 'Nigerian', 'en-TZ': 'Tanzanian',
};
const norm = (s) => s.replace(/\s+/g, ' ').trim();
// Two ways of reading the translations too ({order, lang}, or null: not read) are the same.
const sameTranslation = (x, y) => (!x && !y) || (!!x && !!y && x.order === y.order && x.lang === y.lang);
const fileName = (r) => `${(r.title || 'audio').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80)}.mp3`;

export class Recordings {
  constructor(app) {
    this.app = app;
    this.list = [];             // recordings without timing details
    this.serverIds = new Set(); // recordings that still have an online/server copy
    this.serverOffline = new Map(); // dedicated voice packages not yet removed from the server
    this.deletedIds = new Set(); // ignore stale requests completing after deletion
    this.deletingIds = new Set();
    this.full = new Map();      // id -> recording with the timing of every sentence and word
    this.assets = new Map();    // id -> player asset
    this.offlineItems = new Map(); // id -> locally cached recording package
    this.offlineUrls = new Map(); // id -> object URL for its cached MP3
    this.resolved = new WeakMap(); // page text doc -> Map(id -> sentence ranges on that page)
    this.picking = false;
    this.picked = new Map();    // view -> Set(sentence index)
    this.filter = store.get('recFilter', 'page');
    this.playingId = null;
    this.selectedId = null; // selected saved audio, independent of playback / My audio mode
    this.selectedRec = null;
    this.unselectedRanges = new Set(); // sentences manually deselected within the selected recording
    this.unselectAnchor = null;
    this.modeId = null; // page-text clicks follow this recording until toggled off or a sentence outside it is clicked
    this.pageClickId = 0; // discard stale results when sentence clicks happen while audio lookup is loading
    this.spotFocusId = null; // first page-icon click in My Audio selects; following clicks control playback
    this.pickCoverage = new Map();
    this.coverageVisible = false;
    this.section = 'audio';
    this.box = $('#rec-view');
    this.pickBox = $('#rec-pick-view');
    this.pickSection = $('#rec-pick-section');
    this.audioSection = $('#rec-audio-section');
    this.audioContent = $('#rec-audio-content');
    this.offlineList = $('#offline-list');
    this.pageOfflineSection = $('#rec-page-offline-section');
    this.pageOfflineList = $('#rec-page-offline-list');
    this.voices().then((voices) => { this.voiceList = voices; this.syncPageOfflineVoice(); this.app.updateVoiceOfflineStatus?.(); }).catch(() => { this.voiceList = []; this.app.updateVoiceOfflineStatus?.(); });
    this.loadOffline();
    this.bind();
    this.load();
  }

  async load() {
    const request = this.listRequest = (this.listRequest || 0) + 1;
    let list;
    try {
      const r = await fetch('/api/recordings', { cache: 'no-store' });
      list = r.ok ? await r.json() : [];
    } catch { list = []; }
    if (request !== this.listRequest) return;
    list = list.filter((rec) => !this.deletedIds.has(rec.id));
    this.serverIds = new Set(list.map((rec) => rec.id));
    this.serverOffline = new Map(list.filter((rec) => this.isOfflineVoicePackage(rec)).map((rec) => [rec.id, rec]));
    this.list = list.filter((rec) => !this.isOfflineVoicePackage(rec));
    this.mergeOfflineSummaries();
    this.renderList();
    this.renderPageOfflineFiles();
    this.renderSpots();
    this.app.updateVoiceOfflineStatus?.();
    if (this.coverageVisible) { this.loadCoverage(); this.ensureDefaultSelection(); }
  }

  async loadOffline() {
    try {
      const items = await offlineAudio.all();
      this.offlineItems = new Map(items.filter((item) => !this.deletedIds.has(item.id)).map((item) => [item.id, item]));
      this.syncPageOfflineVoice();
      this.mergeOfflineSummaries();
      this.renderList();
      this.renderOffline();
      this.renderPageOfflineFiles();
      this.app.updateVoiceOfflineStatus?.();
      this.renderSpots();
      this.updateRecordingFrame();
    } catch (error) {
      $('#offline-status').textContent = error.message || 'Offline storage is unavailable in this browser.';
    }
  }

  mergeOfflineSummaries() {
    const ids = new Set(this.list.map((rec) => rec.id));
    const voiceOnly = new Set([...this.offlineItems.values()].filter((item) => this.isOfflineVoicePackage(item.recording) || this.isOfflineVoicePackage(item.summary)).map((item) => item.id));
    this.list = this.list.filter((rec) => !voiceOnly.has(rec.id));
    for (const item of this.offlineItems.values()) if (!voiceOnly.has(item.id) && !ids.has(item.id) && item.summary) this.list.push(item.summary);
  }

  isOfflineVoicePackage(rec) {
    // Older versions used this generated title without saving a type flag.
    if (rec?.offlineVoiceOnly === false && !rec?.offlineCollection) return false;
    return !!(rec?.offlineVoiceOnly || rec?.offlineCollection
      || /\bEnglish\s*[·—-].*\boffline(?: audio)?$/i.test(rec?.title || '')
      || /\boffline audio(?:\s*\(\d+\/\d+\))?$/i.test(rec?.title || ''));
  }

  recordingPaths(rec) {
    return new Set([rec?.path, ...(rec?.paths || []), ...(rec?.sentences || []).map((s) => s.path)].filter(Boolean));
  }

  currentPageView() {
    const page = this.app.book?.pages?.[this.app.idx];
    return this.app.views.find((v) => v.book.slug === this.app.book?.slug && v.page.path === page?.path) || this.app.views[0];
  }

  /**
   * How the translations are read aloud now ({order, lang}), or null. Offline audio is made with
   * them, and used only when it reads them the same way.
   */
  liveTranslation() {
    const lang = this.app.translator?.lang;
    return settings.trOrder !== 'off' && lang ? { order: settings.trOrder, lang } : null;
  }

  pageOfflineItems(view = this.currentPageView()) {
    if (!view) return [];
    const tr = this.liveTranslation();
    return [...this.offlineItems.values()].filter(({ recording: rec, blob }) => blob?.size > 0
      && this.isOfflineVoicePackage(rec) && rec.book === view.book.slug && this.recordingPaths(rec).has(view.page.path)
      && sameTranslation(rec.translation, tr))
      .sort((a, b) => String(b.importedAt || '').localeCompare(String(a.importedAt || '')) || a.id.localeCompare(b.id));
  }

  syncPageOfflineVoice() {
    const items = this.pageOfflineItems();
    const voiceId = this.neuralVoiceFor(speech.currentVoice('en'), 'en')?.id?.toLowerCase();
    const next = items.find(({ recording: rec }) => [rec.voice, rec.voiceB].some((id) => id?.toLowerCase() === voiceId)) || items[0];
    this.pageOfflineId = next?.id || null;
    if (next && voiceId !== next.recording.voice?.toLowerCase()) {
      const voice = speech.voicesFor('en').find((v) => this.neuralVoiceFor(v, 'en')?.id?.toLowerCase() === next.recording.voice?.toLowerCase());
      if (voice) speech.setVoice(voice.voiceURI);
    }
    return next;
  }

  renderOffline() {
    if (!this.offlineList) return;
    const items = [...this.offlineItems.values()].sort((a, b) => (b.importedAt || '').localeCompare(a.importedAt || ''));
    this.offlineList.replaceChildren(...(items.length ? items.map((item) => el('div', { class: 'offline-item', dataset: { id: item.id } },
      el('div', { class: 'offline-item-main' },
        el('div', { class: 'offline-item-title' }, item.recording.title),
        el('div', { class: 'offline-item-meta' }, `${item.recording.bookType || 'Book'} p.${item.recording.page} · ${item.recording.count || item.recording.sentences.length} sentences · ${item.recording.voiceName || item.recording.voice} · ${fmtTime(item.recording.duration)}`)),
      el('div', { class: 'offline-item-tools' },
        el('button', { class: 'icon-btn small', dataset: { offlineAct: 'play' }, title: 'Play offline audio', html: icon('play') }),
        el('button', { class: 'icon-btn small', dataset: { offlineAct: 'export' }, title: 'Export this MP3 and its sentence map', html: icon('download') }),
        el('button', { class: 'icon-btn small danger', dataset: { offlineAct: 'remove' }, title: this.isOfflineVoicePackage(item.recording) ? 'Delete this offline audio and any server copy' : 'Remove offline copy from this browser', html: icon('trash') }))))
      : [el('div', { class: 'offline-empty' }, 'No audio imported yet. Import saved recordings here for offline playback.') ]));
  }

  renderPageOfflineFiles() {
    const section = $('#rec-page-offline-section');
    const list = $('#rec-page-offline-list');
    if (!section || !list) return;
    const view = this.currentPageView();
    const all = new Map([...this.serverOffline].map(([id, recording]) => [id, { id, recording }]));
    for (const item of this.offlineItems.values()) if (this.isOfflineVoicePackage(item.recording)) all.set(item.id, item);
    const items = [...all.values()]
      .filter(({ recording: rec }) => view && rec.book === view.book.slug && this.recordingPaths(rec).has(view.page.path))
      .sort((a, b) => Number(a.recording.page) - Number(b.recording.page)
        || String(a.recording.voiceName || a.recording.voice).localeCompare(String(b.recording.voiceName || b.recording.voice)));
    section.hidden = !items.length;
    if (!items.length && this.section === 'offline') this.section = 'audio';
    $('#rec-page-offline-count').textContent = items.length ? `(${items.length})` : '';
    list.replaceChildren(...items.map(({ id, recording: rec }) => el('div', { class: 'page-offline-item', dataset: { id } },
      el('button', { class: 'icon-btn rec-play offline-voice-play', dataset: { pageOfflineAct: 'play' }, title: 'Play this offline voice', 'aria-label': 'Play this offline voice', html: icon('play') }),
      el('div', { class: 'page-offline-main' },
        el('div', { class: 'rec-title' }, `${rec.voiceName || rec.voice || 'English voice'} · p.${rec.page}`),
        el('div', { class: 'rec-meta' }, `${rec.bookType || 'Book'} · ${rec.count || rec.sentences?.length || 0} sentences`),
        el('div', { class: 'rec-text' }, rec.title || 'Offline voice')),
      el('div', { class: 'rec-tools' },
        el('span', { class: `page-offline-status${this.offlineItems.has(id) ? ' available' : ' server-only'}` }, this.offlineItems.has(id) ? 'Available offline' : 'Server only'),
        el('button', { class: 'icon-btn small danger', dataset: { pageOfflineAct: 'remove' }, title: 'Delete this offline voice file', 'aria-label': 'Delete this offline voice file', html: icon('trash') })))));
    this.renderSections();
  }

  hasAnyOfflineVoiceOnCurrentPage() {
    return this.pageOfflineItems().length > 0;
  }

  async importOfflineScope() {
    return this.generateOfflineVoice(speech.currentVoice('en'), $('#offline-scope').value);
  }

  async collectOfflineSentences(scope) {
    const book = this.app.book;
    if (!book) return [];
    const pages = scope === 'page' ? this.app.views.map((view) => view.page) : book.pages;
    const out = [];
    for (const page of pages) {
      const view = this.app.views.find((item) => item.book.slug === book.slug && item.page.path === page.path);
      let doc = view?.text;
      if (!doc) {
        const response = await fetch(`/api/text/${encodeURIComponent(book.slug)}/${encodeURIComponent(page.path)}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Text for page ${page.n} is not extracted yet. Extract or correct it before importing offline audio.`);
        doc = await response.json();
      }
      for (const [a, b] of doc.sent || []) {
        const words = doc.words.slice(a, b);
        const text = view?.text ? view.text.text(a, b)
          : words.reduce((result, word, i) => result + word[4] + (word[6] && i < words.length - 1 ? ' ' : ''), '').trim();
        if (!text) continue;
        const sentenceView = view || { book, page };
        out.push({ view: sentenceView, path: page.path, a, b, text, words: words.map((word) => speakable(word[4])) });
      }
    }
    return out;
  }

  async importOffline(id) {
    if (this.offlineItems.has(id)) return;
    const rec = await this.loadFull(id);
    const response = await fetch(rec.file, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not download “${rec.title}”. Connect to the internet and try again.`);
    const blob = await response.blob();
    const summary = this.list.find((item) => item.id === id) || rec;
    const item = { id, summary, recording: rec, blob, importedAt: new Date().toISOString() };
    await offlineAudio.put(item);
    this.offlineItems.set(id, item);
    this.renderList();
    this.renderOffline();
    this.renderPageOfflineFiles();
    this.app.updateVoiceOfflineStatus?.();
  }

  async cacheGeneratedOffline(summary, { voiceOnly = false, collection = null } = {}) {
    const rec = await this.loadFull(summary.id);
    if (voiceOnly) { rec.offlineVoiceOnly = true; summary.offlineVoiceOnly = true; }
    if (collection) { rec.offlineCollection = collection; summary.offlineCollection = collection; }
    const response = await fetch(rec.file, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Audio “${rec.title}” was generated, but could not be copied for offline use.`);
    const blob = await response.blob();
    const item = { id: rec.id, summary, recording: rec, blob, importedAt: new Date().toISOString() };
    await offlineAudio.put(item);
    this.offlineItems.set(item.id, item);
    this.mergeOfflineSummaries();
    this.syncPageOfflineVoice();
    this.renderList();
    this.renderOffline();
    this.renderPageOfflineFiles();
    this.renderSpots();
    this.app.updateVoiceOfflineStatus?.();
  }

  hasOfflineVoice(voice, language) {
    if (!voice) return 0;
    const match = this.neuralVoiceFor(voice, language);
    if (!match) return 0;
    let count = 0;
    const view = this.currentPageView(), tr = this.liveTranslation();
    for (const item of this.offlineItems.values()) {
      const rec = item.recording;
      if (!this.isOfflineVoicePackage(rec) || !view || rec.book !== view.book.slug || !this.recordingPaths(rec).has(view.page.path) || !item.blob?.size) continue;
      if (!sameTranslation(rec.translation, tr)) continue;
      if (rec.languageMode !== 'both' && rec.languageMode !== language) continue;
      const ids = language === 'zh' ? [rec.zhVoice, rec.zhVoiceB] : [rec.voice, rec.voiceB];
      if (ids.some((id) => id?.toLowerCase() === match.id.toLowerCase())) count++;
    }
    return count;
  }

  hasOfflineVoiceForCurrentPage(voice) {
    if (!voice || !this.app.views?.length) return false;
    const match = this.neuralVoiceFor(voice, 'en');
    if (!match) return false;
    const expected = new Set();
    for (const view of [this.currentPageView()].filter(Boolean)) {
      if (!view.text) return false;
      for (const [a, b] of view.text.sent || []) {
        const text = view.text.text(a, b);
        if (/[A-Za-z]/.test(text) && !/[\u3400-\u9fff\uf900-\ufaff]/u.test(text)) {
          expected.add(`${view.book.slug}:${view.page.path}:${a}:${b}:${norm(text)}`);
        }
      }
    }
    if (!expected.size) return false;
    const available = new Set(), tr = this.liveTranslation();
    for (const { recording: rec, blob } of this.offlineItems.values()) {
      if (!blob?.size) continue;
      if (!this.isOfflineVoicePackage(rec) || !sameTranslation(rec.translation, tr)) continue;
      if (rec.book !== this.app.book?.slug || (rec.languageMode !== 'en' && rec.languageMode !== 'both')) continue;
      if (![rec.voice, rec.voiceB].some((id) => id?.toLowerCase() === match.id.toLowerCase())) continue;
      for (const sentence of rec.sentences || []) {
        available.add(`${rec.book}:${sentence.path}:${sentence.a}:${sentence.b}:${norm(sentence.text || '')}`);
      }
    }
    return [...expected].every((key) => available.has(key));
  }

  neuralVoiceFor(voice, language = 'en') {
    return matchingRecordingVoice(voice, this.voiceList, language);
  }

  voiceAvailability(voice) {
    if (!voice) return { status: 'No English voice selected', canGenerate: false, label: 'unavailable' };
    const neural = this.neuralVoiceFor(voice);
    if (voice.localService) return {
      status: neural ? `${voice.name} can read and generate audio offline on this Windows computer.` : `${voice.name} can read offline on this device. This server cannot generate files with that voice.`,
      canGenerate: !!neural, label: neural ? 'Windows offline · generate files' : 'device offline', neural,
    };
    if (!this.voiceList) return { status: 'Checking voice availability…', canGenerate: false, label: 'checking' };
    if (!neural) return { status: `${voice.name} is online, but no matching downloadable voice is available.`, canGenerate: false, label: 'online' };
    const imported = this.hasOfflineVoice(voice, 'en');
    return imported
      ? { status: `${voice.name}: ${imported} offline package${imported === 1 ? '' : 's'} on this page; uncached sentences use the live voice.`, canGenerate: true, label: 'offline available on this page', neural }
      : { status: `${voice.name} is online. Generate its audio here to use matching sentences offline.`, canGenerate: true, label: 'online · generate offline', neural };
  }

  async generateOfflineVoice(voice, scope) {
    const status = $('#offline-status');
    const button = $('#offline-import');
    const progress = $('#offline-progress');
    const progressFill = progress.firstElementChild;
    const info = this.voiceAvailability(voice);
    const neural = info.neural || this.neuralVoiceFor(voice);
    if (!neural) { status.textContent = info.status; return; }
    let sources = [];
    button.disabled = true;
    progress.hidden = false;
    progress.classList.add('busy');
    progressFill.style.width = '4%';
    status.textContent = 'Preparing…';
    try {
      if (scope === 'page' || scope === 'book') {
        sources = await this.collectOfflineSentences(scope);
      } else if (scope === 'selected') {
        sources = this.pickedSentences();
        if (!sources.length && this.selectedId) {
          const rec = await this.loadFull(this.selectedId);
          sources = rec.sentences.map((sentence) => {
            const view = this.app.views.find((item) => item.book.slug === rec.book && item.page.path === sentence.path)
              || { book: { slug: rec.book, id: rec.bookId, type: rec.bookType }, page: { path: sentence.path, n: rec.page } };
            return { view, path: sentence.path, a: sentence.a, b: sentence.b, text: sentence.text, words: sentence.words || [] };
          });
        }
        if (!sources.length) throw new Error('Select sentences or a saved audio first.');
      } else {
        for (const summary of this.list) {
          const rec = await this.loadFull(summary.id);
          const view = this.app.views.find((item) => item.book.slug === rec.book && item.page.path === rec.path)
            || { book: { slug: rec.book, id: rec.bookId, type: rec.bookType, title: rec.bookType }, page: { path: rec.path, n: rec.page } };
          sources.push(...rec.sentences.map((sentence) => ({ view: this.app.views.find((item) => item.book.slug === rec.book && item.page.path === sentence.path) || view,
            path: sentence.path, a: sentence.a, b: sentence.b, text: sentence.text, words: sentence.words || [] })));
        }
      }
      sources = sources.filter((sentence) => /[A-Za-z]/.test(sentence.text || '') && !/[\u3400-\u9fff\uf900-\ufaff]/u.test(sentence.text || ''));
      if (!sources.length) throw new Error('No English sentences were found in that scope.');
      const unique = new Map(sources.map((sentence) => [`${sentence.view.book.slug}:${sentence.path}:${sentence.a}:${sentence.b}`, sentence]));
      sources = [...unique.values()];
      // "Read the translation" (voice settings): the audio reads each sentence's translation too.
      const tr = this.liveTranslation(), trName = this.app.translator?.name || tr?.lang;
      sources = sources.filter((sentence) => ![...this.offlineItems.values()].some(({ recording }) =>
        recording.book === sentence.view.book.slug && (recording.languageMode === 'en' || recording.languageMode === 'both')
        && sameTranslation(recording.translation, tr)
        && [recording.voice, recording.voiceB].some((id) => id?.toLowerCase() === neural.id.toLowerCase())
        && recording.sentences.some((saved) => saved.path === sentence.path && saved.a === sentence.a && saved.b === sentence.b && norm(saved.text) === norm(sentence.text))));
      if (!sources.length) throw new Error(`All English sentences in this scope already have offline audio for ${neural.name}${tr ? ` with the ${trName} translation` : ''}.`);
      let trVoice = null, untranslated = 0;
      if (tr) {
        trVoice = this.defaultTranslationVoice(await this.translationVoiceList(tr.lang), tr.lang);
        if (!trVoice) throw new Error(`No voice can make ${trName} audio. Set \u201cRead the translation\u201d to No to make the sentences only.`);
        status.textContent = `Translating into ${trName}\u2026`;
        const books = new Map();
        for (const s of sources) books.set(s.view.book.slug, [...(books.get(s.view.book.slug) || []), s]);
        for (const [slug, list] of books) {
          const trs = await this.translationsOf(slug, list, (sec) => { status.textContent = `The translation service is busy: waiting ${sec} s\u2026`; });
          list.forEach((s, i) => { s.tr = trs[i]; });
        }
        untranslated = sources.filter((s) => !s.tr).length;
      }
      // Keep each page as its own offline audio file. A book-wide generation
      // is therefore a set of page packages, not one unmanageably long track.
      const groups = new Map();
      for (const sentence of sources) {
        const key = `${sentence.view.book.slug}:${sentence.path}`;
        if (!groups.has(key)) groups.set(key, { first: sentence, sentences: [] });
        groups.get(key).sentences.push(sentence);
      }
      const pages = [...groups.values()].sort((a, b) => {
        const book = String(a.first.view.book.slug).localeCompare(String(b.first.view.book.slug));
        return book || (Number(a.first.view.page.n) - Number(b.first.view.page.n))
          || String(a.first.path).localeCompare(String(b.first.path));
      });
      const bookCount = new Set(pages.map(({ first }) => first.view.book.slug)).size;
      let done = 0, total = sources.length;
      progress.classList.remove('busy');
      progressFill.style.width = '0%';
      status.textContent = `Generating 0/${total}`;
      for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
        const group = pages[pageIndex];
        const first = group.first;
        const chunks = Math.ceil(group.sentences.length / 400);
        for (let start = 0; start < group.sentences.length; start += 400) {
          const chunk = group.sentences.slice(start, start + 400);
          const chunkIndex = Math.floor(start / 400);
          const pageLabel = Number.isFinite(Number(first.view.page.n)) ? `p.${first.view.page.n}` : 'page';
          const chunkLabel = chunks > 1 ? ` · part ${chunkIndex + 1}` : '';
          const withTr = !!tr && chunk.some((s) => s.tr); // (none translated yet: the sentences only)
          const collection = {
            id: `${first.view.book.slug}:${neural.id}:en${withTr ? `:${tr.lang}-${tr.order}` : ''}`,
            title: first.view.book.title || first.view.book.type || first.view.book.slug,
            book: first.view.book.slug,
            bookType: first.view.book.type || 'Book',
            voice: neural.id,
            voiceName: neural.name,
            languageMode: 'en',
            scope,
            pageCount: pages.filter(({ first: item }) => item.view.book.slug === first.view.book.slug).length,
            bookCount,
          };
          const body = {
            book: first.view.book.slug, bookId: first.view.book.id || '', bookType: first.view.book.type || 'Book',
            page: first.view.page.n, path: first.path,
            title: `${neural.name} English${withTr ? ` + ${trName}` : ''} · ${first.view.book.type || 'Book'} ${pageLabel}${chunkLabel} offline`,
            voice: neural.id, voiceName: neural.name, languageMode: 'en', rate: 0, gap: 0,
            offlineVoiceOnly: true, offlineCollection: collection,
            twoSpeakers: false, voiceB: '', voiceBName: '', zhVoice: '', zhVoiceName: '', zhVoiceB: '', zhVoiceBName: '',
            translation: withTr ? { order: tr.order, lang: tr.lang, langName: trName, voice: trVoice.id, voiceName: trVoice.name } : null,
            sentences: chunk.map(({ path, a, b, text, words, tr: translated }) => ({ path, a, b, text, words: words?.length ? words : text.split(/\s+/).map(speakable),
              ...(withTr ? { tr: translated || '' } : {}) })),
          };
          const rec = await this.create(body, (partDone, partTotal) => { // (the server counts each translation too)
            const current = Math.min(total, done + Math.round((partDone / (partTotal || chunk.length)) * chunk.length));
            const percent = Math.round((current / total) * 100);
            progressFill.style.width = `${percent}%`;
            progress.setAttribute('aria-valuenow', String(percent));
            status.textContent = `Generating ${current}/${total} · ${pageLabel} (${pageIndex + 1}/${pages.length})`;
          });
          await this.cacheGeneratedOffline(rec, { voiceOnly: true, collection });
          const removed = await fetch(`/api/recordings/${rec.id}`, { method: 'DELETE' }).catch(() => null);
          if (!removed?.ok) {
            this.serverIds.add(rec.id);
            this.serverOffline.set(rec.id, rec);
          } else {
            this.serverIds.delete(rec.id);
            this.serverOffline.delete(rec.id);
            const item = this.offlineItems.get(rec.id);
            if (item) { item.serverCopy = false; await offlineAudio.put(item); }
          }
          done += chunk.length;
        }
      }
      progressFill.style.width = '100%';
      progress.setAttribute('aria-valuenow', '100');
      status.textContent = `Offline ready · ${done} sentences across ${pages.length} page file${pages.length === 1 ? '' : 's'}`
        + (untranslated ? ` · ${untranslated} without a ${trName} translation yet` : '');
      this.app.updateVoiceOfflineStatus?.();
      this.renderPageOfflineFiles();
      toast(`Generated ${neural.name} English${tr ? ` + ${trName}` : ''} offline audio.`);
      setTimeout(() => { progress.hidden = true; }, 2400);
    } catch (error) {
      status.textContent = error.message || 'Offline audio generation failed.';
      progress.hidden = true;
    } finally {
      button.disabled = false;
      progress.classList.remove('busy');
    }
  }

  async playOfflineForUnit(view, unit, fromPage) {
    const clickId = this.pageClickId;
    if (!this.offlineItems.size || !view.text) return false;
    const text = view.text.text(unit.a, unit.b);
    const language = /[\u3400-\u9fff\uf900-\ufaff]/u.test(text) ? 'zh' : 'en';
    if (settings.languageMode !== 'both' && settings.languageMode !== language) return false;
    const voice = speech.currentVoice(language);
    const matchedVoice = this.neuralVoiceFor(voice, language);
    const expected = matchedVoice?.id.toLowerCase();
    const tr = this.liveTranslation(); // (read with the translations, or without, as wanted now)
    const candidates = [...this.offlineItems.values()].filter((item) => item.blob?.size
      && !this.deletingIds.has(item.id) && this.isOfflineVoicePackage(item.recording) && sameTranslation(item.recording.translation, tr));
    for (const item of candidates.sort((a, b) => Number(b.id === this.pageOfflineId) - Number(a.id === this.pageOfflineId))) {
      const rec = item.recording;
      if (rec.languageMode !== 'both' && rec.languageMode !== language) continue;
      if (rec.book !== view.book.slug || !this.recordingPaths(rec).has(view.page.path)) continue;
      const ids = language === 'zh' ? [rec.zhVoice, rec.zhVoiceB] : [rec.voice, rec.voiceB];
      if (!ids.some((id) => expected && id?.toLowerCase() === expected) && !(language === 'en' && item.id === this.pageOfflineId)) continue;
      const hit = await this.locate(view, unit, rec.id);
      if (clickId !== this.pageClickId) return false;
      if (!hit) continue;
      if (this.deletedIds.has(item.id) || this.deletingIds.has(item.id)) continue;
      await this.playFrom(hit, fromPage);
      return true;
    }
    return false;
  }

  setOfflineVoiceMode(on) {
    this.offlineVoiceMode = !!on;
    if (!on && this.framedRec?.offlineVoiceOnly) this.framedRec = null;
    this.updateRecordingFrame();
  }

  async removeOffline(id) {
    const rec = this.offlineItems.get(id)?.recording || this.serverOffline.get(id);
    if (!rec) return;
    if (this.isOfflineVoicePackage(rec)) return this.deleteRecording(id);
    // Ordinary saved audio has a separate, explicitly labelled "remove offline copy" action.
    try {
      if (this.app.audio.asset?.rec?.id === id) this.app.audio.close();
      await offlineAudio.remove(id);
      this.forgetRecording(id, { keepServer: this.serverIds.has(id) });
      this.refreshOfflineState();
      toast('Offline copy removed. The saved server recording is kept.');
    } catch (error) { toast(error.message || 'The offline copy could not be removed.'); }
  }

  forgetRecording(id, { keepServer = false } = {}) {
    this.offlineItems.delete(id);
    if (!keepServer) {
      this.deletedIds.add(id);
      this.list = this.list.filter((rec) => rec.id !== id);
      this.serverIds.delete(id);
      this.serverOffline.delete(id);
    }
    this.full.delete(id);
    this.assets.delete(id);
    this.pickCoverage.delete(id);
    this.resolved = new WeakMap();
    const url = this.offlineUrls.get(id);
    if (url) URL.revokeObjectURL(url);
    this.offlineUrls.delete(id);
    if (this.modeId === id) this.modeId = null;
    if (this.playingId === id) this.playingId = null;
    if (this.spotFocusId === id) this.spotFocusId = null;
    if (this.framedRec?.id === id) this.framedRec = null;
    if (this.selectedId === id) {
      this.selectedId = null;
      this.selectedRec = null;
      this.unselectedRanges.clear();
      this.unselectAnchor = null;
      this.stopPicking();
      this.app.views.forEach((view) => view.showPicks([]));
    }
  }

  refreshOfflineState() {
    const next = this.syncPageOfflineVoice();
    this.renderList();
    this.renderOffline();
    this.renderPageOfflineFiles();
    this.renderSpots();
    this.app.updateVoiceOfflineStatus?.();
    this.updateRecordingFrame();
    this.updateRecordingSelection();
    return next;
  }

  async deleteRecording(id, { notify = true } = {}) {
    if (this.deletingIds.has(id)) return false;
    this.deletingIds.add(id);
    const offline = this.isOfflineVoicePackage(this.offlineItems.get(id)?.recording || this.serverOffline.get(id) || this.list.find((r) => r.id === id));
    // Release a playing MP3 before Windows tries to remove it from disk.
    if (this.app.audio.asset?.rec?.id === id) this.app.audio.close();
    try {
      const item = this.offlineItems.get(id);
      if (this.serverIds.has(id) || item?.serverCopy !== false) {
        const res = await fetch(`/api/recordings/${id}`, { method: 'DELETE' });
        // A generated offline-only package usually has no remaining server copy.
        if (!res.ok && res.status !== 404) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'The server copy could not be deleted. Please try again.');
        }
      }
      await offlineAudio.remove(id);
      this.forgetRecording(id);
      const next = this.refreshOfflineState();
      if (notify) toast(offline ? next
        ? `Offline audio deleted. Using ${next.recording.voiceName || next.recording.voice} on this page.`
        : 'Offline audio deleted. This page is now online.' : 'Audio and its offline copy deleted.');
      return true;
    } catch (error) {
      if (notify) toast(error.message || 'Could not delete the audio. Check that the app server is running and try again.');
      return false;
    } finally { this.deletingIds.delete(id); }
  }

  async exportOffline(id) {
    const item = this.offlineItems.get(id);
    if (!item) return;
    const base = fileName(item.recording).replace(/\.mp3$/i, '');
    try {
      if (window.showDirectoryPicker) {
        const root = await window.showDirectoryPicker({ mode: 'readwrite' });
        const folder = await root.getDirectoryHandle(base.replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80), { create: true });
        const write = async (name, data) => {
          const handle = await folder.getFileHandle(name, { create: true });
          const stream = await handle.createWritable();
          await stream.write(data);
          await stream.close();
        };
        await write(`${base}.mp3`, item.blob);
        await write(`${base}.json`, new Blob([JSON.stringify(item.recording, null, 2)], { type: 'application/json' }));
        toast('Offline MP3 and sentence map exported to the chosen folder.');
      } else {
        const url = URL.createObjectURL(item.blob);
        const link = el('a', { href: url, download: `${base}.mp3` });
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        toast('MP3 exported. This browser cannot export folders; the sentence map remains in Offline Audio.');
      }
    } catch (error) {
      if (error.name !== 'AbortError') toast(error.message || 'Could not export this offline audio.');
    }
  }

  async exportOfflineFolder() {
    const items = [...this.offlineItems.values()];
    if (!items.length) { $('#offline-status').textContent = 'Import some audio before exporting a folder.'; return; }
    if (!window.showDirectoryPicker) {
      $('#offline-status').textContent = 'Folder export needs Microsoft Edge or Chrome. Use each recording’s download button instead.';
      return;
    }
    try {
      const root = await window.showDirectoryPicker({ mode: 'readwrite' });
      const safe = (value) => String(value || 'Audio').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Audio';
      const write = async (folder, name, data) => {
        const handle = await folder.getFileHandle(name, { create: true });
        const stream = await handle.createWritable();
        await stream.write(data);
        await stream.close();
      };
      const collections = new Map();
      for (const item of items) {
        const rec = item.recording;
        const key = [rec.book || rec.bookType, rec.languageMode || 'both', rec.voiceName || rec.voice].join(':');
        if (!collections.has(key)) collections.set(key, []);
        collections.get(key).push(item);
      }
      for (const group of collections.values()) {
        group.sort((a, b) => (Number(a.recording.page) - Number(b.recording.page))
          || String(a.recording.title).localeCompare(String(b.recording.title)));
        const first = group[0].recording;
        const bookFolder = await root.getDirectoryHandle(safe(first.book || first.bookType), { create: true });
        const languageFolder = await bookFolder.getDirectoryHandle(safe(first.languageMode || 'both'), { create: true });
        const voiceFolder = await languageFolder.getDirectoryHandle(safe(first.voiceName || first.voice), { create: true });
        const usedNames = new Set();
        const manifest = {
          collection: first.offlineCollection || null,
          book: first.book || '',
          bookType: first.bookType || '',
          languageMode: first.languageMode || 'both',
          voice: first.voiceName || first.voice || '',
          files: [],
        };
        for (const item of group) {
          const rec = item.recording;
          let base = fileName(rec).replace(/\.mp3$/i, '');
          const initial = base;
          let suffix = 2;
          while (usedNames.has(`${base}.mp3`.toLowerCase())) base = `${initial} (${suffix++})`;
          usedNames.add(`${base}.mp3`.toLowerCase());
          await write(voiceFolder, `${base}.mp3`, item.blob);
          await write(voiceFolder, `${base}.json`, new Blob([JSON.stringify(rec, null, 2)], { type: 'application/json' }));
          manifest.files.push({
            page: rec.page ?? null,
            path: rec.path || '',
            title: rec.title || '',
            audio: `${base}.mp3`,
            sentences: rec.sentences?.length || 0,
            duration: rec.duration || null,
          });
        }
        await write(voiceFolder, 'book-collection.json', new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }));
      }
      $('#offline-status').textContent = `Exported ${items.length} audio file${items.length === 1 ? '' : 's'} into book collections, ordered by page. Each folder includes a book-collection.json index.`;
    } catch (error) {
      if (error.name !== 'AbortError') $('#offline-status').textContent = error.message || 'Folder export failed.';
    }
  }

  bind() {
    $('#rec-new').addEventListener('click', () => this.startPicking({ newAudio: true }));
    $('#rec-cancel').addEventListener('click', () => this.stopPicking());
    $('#rec-create').addEventListener('click', () => {
      try { this.openCreate(); }
      catch (err) { console.error('Could not open the audio settings:', err); toast(err.message || 'Could not open audio settings.'); }
    });
    $('#rec-search').addEventListener('input', () => this.renderList());
    $('#rec-pick-toggle').addEventListener('click', () => { this.section = this.section === 'pick' ? 'closed' : 'pick'; this.renderSections(); });
    $('#rec-audio-toggle').addEventListener('click', () => { this.section = this.section === 'audio' ? 'closed' : 'audio'; this.renderSections(); });
    $('#rec-page-offline-toggle').addEventListener('click', () => {
      this.section = this.section === 'offline' ? 'closed' : 'offline';
      this.renderSections();
    });
    this.pageOfflineList.addEventListener('click', (e) => {
      const button = e.target.closest('[data-page-offline-act]');
      const id = button?.closest('[data-id]')?.dataset.id;
      if (!id) return;
      if (button.dataset.pageOfflineAct === 'remove') this.removeOffline(id);
      else if (button.dataset.pageOfflineAct === 'play') this.play(id, { tab: null });
    });
    $('#offline-export-all').addEventListener('click', () => this.exportOfflineFolder());
    this.offlineList.addEventListener('click', (e) => {
      const button = e.target.closest('[data-offline-act]');
      const id = button?.closest('[data-id]')?.dataset.id;
      if (!id) return;
      if (button.dataset.offlineAct === 'play') this.play(id, { tab: null });
      else if (button.dataset.offlineAct === 'remove') this.removeOffline(id);
      else if (button.dataset.offlineAct === 'export') this.exportOffline(id);
    });
    for (const b of document.querySelectorAll('#rec-filter button')) {
      b.addEventListener('click', () => { this.filter = b.dataset.f; store.set('recFilter', this.filter); this.renderList(); });
    }
    this.box.addEventListener('click', (e) => (this.picking ? this.onPickClick(e) : this.onListClick(e)));
    this.pickBox.addEventListener('click', (e) => this.onPickClick(e));
  }

  // ---------------------------------------------------------------- The list

  renderList() {
    document.querySelectorAll('#rec-filter button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.f === this.filter)));
    const q = norm($('#rec-search').value).toLowerCase();
    const paths = new Set(this.app.views.map((v) => v.page.path));
    const items = this.list.filter((r) => {
      if (this.filter === 'page' && !r.paths.some((p) => paths.has(p))) return false;
      if (this.filter === 'book' && r.book !== this.app.book?.slug) return false;
      return !q || `${r.title} ${r.text}`.toLowerCase().includes(q);
    });
    if (!items.length) {
      const msg = q ? 'Nothing matches your search.'
        : this.filter === 'page' ? 'No audio for this page yet. Click “New audio” and choose the sentences to read.'
          : 'No audio yet. Click “New audio” and choose the sentences to read.';
      this.box.replaceChildren(el('div', { class: 'empty' }, msg));
      return;
    }
    const pendingAdds = this.pickedSentences().length;
    this.box.replaceChildren(el('ul', { class: 'rec-list' }, ...items.map((r) => {
      const playing = r.id === this.playingId;
      const selected = r.id === this.selectedId;
      const inMode = r.id === this.modeId;
      const hasPendingChanges = this.picking && selected && (pendingAdds > 0 || this.unselectedRanges.size > 0);
      const regenHint = pendingAdds > 0
        ? `Add ${pendingAdds} selected sentence${pendingAdds === 1 ? '' : 's'} here`
        : 'Regenerate with this sentence selection';
      return el('li', { class: `rec${selected ? ' selected' : ''}${playing ? ' playing' : ''}${inMode ? ' audio-mode' : ''}`, dataset: { id: r.id }, 'aria-selected': String(selected) },
        el('button', { class: 'icon-btn rec-play', dataset: { act: 'play' }, title: inMode ? 'Exit My audio mode' : 'Play and enter My audio mode', 'aria-pressed': String(inMode), html: icon(playing ? 'pause' : 'play') }),
        el('div', { class: 'rec-main' },
          el('div', { class: 'rec-title' }, r.title),
          el('button', { class: 'rec-meta', dataset: { act: 'goto' }, title: 'Go to this page' },
            `${r.bookType} p.${r.page} · ${fmtTime(r.duration)} · ${r.voiceName || r.voice} · ${r.count} sentence${r.count === 1 ? '' : 's'}`
            + (r.translation ? ` · ${r.translation.langName || r.translation.lang} translation ${r.translation.order} each sentence` : '')),
          el('div', { class: 'rec-text' }, r.text.length > 150 ? `${r.text.slice(0, 150)}…` : r.text),
          hasPendingChanges ? el('div', { class: 'rec-regen-hint' }, pendingAdds > 0
            ? `Click the check icon to add ${pendingAdds} selected sentence${pendingAdds === 1 ? '' : 's'} here.`
            : 'Click the check icon to regenerate with this sentence selection.') : null),
        el('div', { class: 'rec-tools' },
          el('button', { class: `icon-btn small rec-offline${this.offlineItems.has(r.id) ? ' imported' : ''}`, dataset: { act: 'offline' }, title: this.offlineItems.has(r.id) ? 'Saved for offline playback on this browser' : 'Import this recording for offline playback', 'aria-label': this.offlineItems.has(r.id) ? 'Available offline' : 'Import for offline playback', html: icon(this.offlineItems.has(r.id) ? 'check' : 'download') }),
          el('button', { class: `icon-btn small rec-extend${hasPendingChanges ? ' has-changes' : ''}`, dataset: { act: 'regenerate' },
              title: this.picking
              ? (r.id === this.selectedId
                ? 'Regenerate this audio from your sentence selection: deselected sentences are removed, and newly chosen sentences are added.'
                : 'Regenerate this audio and add the sentences currently chosen on the page.')
              : 'Edit this saved audio: select or deselect its sentences, then click this icon again to regenerate.',
              'aria-label': hasPendingChanges ? regenHint : this.picking ? 'Regenerate this audio' : 'Edit and regenerate this saved audio',
              html: icon(hasPendingChanges ? 'check' : 'restore') }),
          el('a', { class: 'icon-btn small', href: r.file, download: fileName(r), title: 'Download the MP3', html: icon('download') }),
          el('a', { class: 'icon-btn small cc', href: r.srt, download: fileName(r).replace(/\.mp3$/, '.srt'), title: 'Download the subtitles (.srt): the time of every sentence' }, 'CC'),
          el('button', { class: 'icon-btn small', dataset: { act: 'rename' }, title: 'Rename', html: icon('pencil') }),
          el('button', { class: 'icon-btn small', dataset: { act: 'delete' }, title: 'Delete', html: icon('trash') })));
    })));
    if (this.coverageVisible) this.scrollActiveAudioIntoView();
  }

  scrollActiveAudioIntoView() {
    const id = this.playingId || this.selectedId;
    if (!id || !this.coverageVisible) return;
    requestAnimationFrame(() => {
      const item = [...this.box.querySelectorAll('.rec[data-id]')].find((node) => node.dataset.id === id);
      if (!item || this.audioContent.hidden) return;
      const boxRect = this.box.getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();
      this.box.scrollTop += (itemRect.top + itemRect.height / 2) - (boxRect.top + boxRect.height / 2);
    });
  }

  ensureDefaultSelection() {
    if (this.selectedId || this.picking) return;
    const id = this.box.querySelector('.rec')?.dataset.id;
    if (id) this.select(id);
  }

  renderSections() {
    const choosing = this.picking;
    const pickOpen = choosing && this.section === 'pick';
    const offlineOpen = !this.pageOfflineSection.hidden && this.section === 'offline';
    const audioOpen = this.section === 'audio';
    this.pickSection.hidden = !choosing;
    this.pickBox.hidden = !pickOpen;
    this.pageOfflineList.hidden = !offlineOpen;
    this.audioContent.hidden = !audioOpen;
    this.pickSection.classList.toggle('collapsed', !pickOpen);
    this.pageOfflineSection.classList.toggle('collapsed', !offlineOpen);
    this.audioSection.classList.toggle('collapsed', !audioOpen);
    $('#rec-pick-toggle').setAttribute('aria-expanded', String(pickOpen));
    $('#rec-page-offline-toggle').setAttribute('aria-expanded', String(offlineOpen));
    $('#rec-audio-toggle').setAttribute('aria-expanded', String(audioOpen));
    $('#rec-pick-toggle span').textContent = pickOpen ? '▾' : '▸';
    $('#rec-page-offline-chevron').textContent = offlineOpen ? '▾' : '▸';
    $('#rec-audio-toggle span').textContent = audioOpen ? '▾' : '▸';
  }

  onListClick(e) {
    const row = e.target.closest('.rec');
    const btn = e.target.closest('[data-act]');
    const id = row?.dataset.id;
    if (!id) return;
    // The card body selects and outlines the saved text; playback remains on its own button.
    if (!btn) { this.startEditing(id); return; }
    const r = this.list.find((x) => x.id === id);
    if (btn.dataset.act === 'play') this.play(id, { tab: null });
    else if (btn.dataset.act === 'offline') this.importOffline(id).then(() => { $('#offline-status').textContent = 'Recording imported for offline playback.'; }).catch((err) => { $('#offline-status').textContent = err.message || 'Could not import this recording.'; });
    else if (btn.dataset.act === 'regenerate') this.startRegenerating(r);
    else if (btn.dataset.act === 'goto') this.app.go(r.bookId, r.page);
    else if (btn.dataset.act === 'rename') this.rename(r);
    else if (btn.dataset.act === 'delete') this.remove(r);
  }

  async startRegenerating(rec) {
    if (this.picking) { this.extend(rec); return; }
    if (this.selectedId !== rec.id || !this.selectedRec) await this.select(rec.id);
    if (this.selectedId === rec.id) this.startPicking();
  }

  async startEditing(id) {
    if (this.picking && this.selectedId === id) return;
    if (this.selectedId !== id || !this.selectedRec) await this.select(id);
    if (this.selectedId === id && this.selectedRec) this.startPicking();
  }

  async select(id) {
    const summary = this.list.find((r) => r.id === id);
    if (!summary) return;
    if (this.selectedId && this.selectedId !== id) {
      if (this.coverageVisible && this.app.audio.asset?.rec && this.app.audio.asset.rec.id !== id) {
        this.app.audio.pause();
        this.cancelWait();
        this.stopAt = null;
        this.loop = null;
        this.modeId = null;
        this.renderMode();
        this.unfollow();
      }
      this.framedRec = null;
    }
    this.selectedId = id;
    this.selectedRec = null;
    this.unselectedRanges.clear();
    this.unselectAnchor = null;
    this.renderList();
    this.updateRecordingFrame();
    try {
      const rec = await this.loadFull(id);
      if (this.selectedId !== id) return;
      this.selectedRec = rec;
      const visiblePaths = summary.paths?.length ? summary.paths : [summary.path];
      if (!this.app.views.some((v) => v.book.slug === rec.book && visiblePaths.includes(v.page.path))) {
        await this.app.go(summary.bookId, summary.page);
        await this.app.pageReady;
        if (this.selectedId !== id) return;
      }
      this.updateRecordingFrame();
      this.updateRecordingSelection();
    } catch { toast('Could not load this saved audio.'); }
  }

  updateRecordingSelection() {
    for (const view of this.app.views) {
      const units = (this.picking || this.coverageVisible) && this.selectedRec && !this.isOfflineVoicePackage(this.selectedRec) && view.book.slug === this.selectedRec.book
        ? this.resolve(view, this.selectedRec).filter((r) => r && !this.unselectedRanges.has(`${view.page.path}:${r.a}:${r.b}`)).map(({ a, b }) => ({ a, b })) : [];
      view.showRecordingSelection(units);
    }
  }

  /** Clicking a highlighted sentence toggles only that sentence's highlight; the recording stays selected. */
  deselectFromPage(view, unit) {
    if (!this.picking && !this.coverageVisible) return false;
    const sentence = view.text?.w2s[unit.a] ?? -1;
    return sentence >= 0 && this.toggleSelectedAudioSentence(view, sentence);
  }

  async rename(r) {
    const title = prompt('New name for this audio:', r.title);
    if (!title || !title.trim() || title === r.title) return;
    const res = await fetch(`/api/recordings/${r.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
    }).catch(() => null);
    if (!res?.ok) { toast('Could not rename. Is the app window still open?'); return; }
    Object.assign(r, await res.json());
    if (this.full.has(r.id)) this.full.get(r.id).title = r.title;
    if (this.assets.has(r.id)) this.assets.get(r.id).title = `My audio: ${r.title}`;
    this.renderList();
    this.renderSpots();
  }

  async remove(r) {
    if (!confirm(`Delete the audio “${r.title}”?`)) return;
    return this.deleteRecording(r.id);
  }

  // ---------------------------------------------------------------- Playing

  async loadFull(id) {
    if (this.deletedIds.has(id) || this.deletingIds.has(id)) throw new Error('This recording was deleted.');
    if (!this.full.has(id)) {
      const cached = this.offlineItems.get(id);
      if (cached?.recording) this.full.set(id, cached.recording);
      else {
        const r = await fetch(`/api/recordings/${id}`, { cache: 'no-store' }).catch(() => null);
        if (!r?.ok) throw new Error('This recording is not available online or in this browser’s offline library.');
        const rec = await r.json();
        if (this.deletedIds.has(id) || this.deletingIds.has(id)) throw new Error('This recording was deleted.');
        this.full.set(id, rec);
      }
    }
    return this.full.get(id);
  }

  assetFor(rec) {
    if (!this.assets.has(rec.id)) {
      let src = rec.file;
      const cached = this.offlineItems.get(rec.id);
      if (cached?.blob) {
        if (!this.offlineUrls.has(rec.id)) this.offlineUrls.set(rec.id, URL.createObjectURL(cached.blob));
        src = this.offlineUrls.get(rec.id);
      }
      this.assets.set(rec.id, {
        t: 'recording', src, title: `${this.isOfflineVoicePackage(rec) ? 'Offline voice' : 'My audio'}: ${rec.title}`, rec,
        cues: rec.sentences.map((s) => ({ t: Math.round(s.start * 1000), x: s.text })),
      });
    }
    return this.assets.get(rec.id);
  }

  /**
   * A recording that reads this unit (sentence, clause or word) on this page, and where:
   * {rec, k: sentence number, t: start second, end: stop second (word mode) or null}.
   * The recording in the player is tried first, then the page's recordings, newest first.
   */
  containsUnit(view, unit, rec) {
    if (!view.text || !rec) return false;
    return this.resolve(view, rec).some((range) => range && unit.a >= range.a && unit.a < range.b);
  }

  async locate(view, unit, preferredId = null) {
    if (!view.text) return null;
    const ids = preferredId ? [preferredId] : [];
    if (!preferredId) {
      const loaded = this.app.audio.asset?.rec?.id;
      if (loaded) ids.push(loaded);
      for (const r of this.list) {
        if (r.book === view.book.slug && r.paths.includes(view.page.path) && !ids.includes(r.id)) ids.push(r.id);
      }
    }
    for (const id of ids) {
      let rec;
      try { rec = await this.loadFull(id); } catch { continue; }
      const ranges = this.resolve(view, rec);
      const k = ranges.findIndex((r) => r && unit.a >= r.a && unit.a < r.b);
      if (k < 0) continue;
      const s = rec.sentences[k], r = ranges[k];
      if (unit.mode === 'sentence' || !r.exact) return { rec, k, t: s.start, end: null };
      const w = s.words[unit.a - r.a]; // clause or word: start at its first word
      return { rec, k, t: Math.max(s.start, w[0] - 0.05), end: unit.mode === 'word' ? w[1] + 0.12 : null };
    }
    return null;
  }

  /** Play a recording from a located place. Clicking the sentence being played pauses / continues. */
  async playFrom(hit, fromPage) {
    const a = this.app.audio;
    const asset = this.assetFor(hit.rec);
    if (!this.app.assistant?.busy && !hit.end && a.asset === asset && a.open && this.followKey === `${hit.rec.id}:${hit.k}`) {
      a.toggle();
      return;
    }
    this.cancelWait();
    this.stopAt = this.app.assistant?.busy ? (hit.rec.sentences[hit.k]?.end ?? hit.rec.sentences[hit.k + 1]?.start ?? hit.end) : hit.end;
    this.stopFrom = hit.t;
    this.wordRound = 1;
    this.loop = { id: hit.rec.id, k: hit.k, round: 1 }; // "Repeat each sentence" counts from here
    await a.play(asset, { tab: fromPage ? 'text' : null, at: hit.t });
  }

  /** Play from `at` again, after `ms` of silence (the player waits paused meanwhile). */
  replay(at, ms) {
    const a = this.app.audio;
    if (!ms) { a.seek(at, true); return; }
    a.pause();
    this.wait = setTimeout(() => { this.wait = null; a.seek(at, true); }, ms);
  }

  /** The user paused, moved or closed the player while it waited to repeat: do not repeat. */
  cancelWait() {
    if (!this.wait) return;
    clearTimeout(this.wait);
    this.wait = null;
    this.stopAt = null;
    this.loop = null;
  }

  /** The MP3 ended: repeat its last sentence if wanted. Returns true if it plays again. */
  ended(asset) {
    if (this.app.assistant?.busy) return false;
    const rec = asset?.rec, L = this.loop;
    if (!rec || !L || L.id !== rec.id || L.k !== rec.sentences.length - 1 || L.round >= repeatTimes()) return false;
    L.round++;
    this.replay(rec.sentences[L.k].start, gapMs());
    return true;
  }

  /** Play (or pause) a recording, on its page. tab: side panel tab to show (null: keep). */
  async play(id, { tab = 'text' } = {}) {
    const sum = this.list.find((r) => r.id === id) || this.offlineItems.get(id)?.recording || this.serverOffline.get(id);
    if (!sum) return;
    if (!this.app.views.some((v) => v.book.slug === sum.book && this.recordingPaths(sum).has(v.page.path))) {
      await this.app.go(sum.bookId, sum.page); // (the book may have to be loaded first)
      await this.app.pageReady;
    }
    let rec;
    try { rec = await this.loadFull(id); } catch { toast('This audio file is missing.'); return; }
    if (this.isOfflineVoicePackage(rec)) {
      // A voice package is not an editable paragraph recording.
      this.modeId = null;
      this.framedRec = null;
      this.renderMode();
      this.updateRecordingFrame();
      return this.app.audio.play(this.assetFor(rec), { tab: null });
    }
    if (this.selectedId !== id) { this.unselectedRanges.clear(); this.unselectAnchor = null; }
    this.selectedId = id;
    this.selectedRec = rec;
    this.renderList();
    this.updateRecordingFrame();
    this.updateRecordingSelection();
    if (this.modeId === id) {
      this.modeId = null;
      this.cancelWait();
      this.stopAt = null;
      this.loop = null;
      if (this.app.audio.asset?.rec?.id === id) this.app.audio.pause();
      this.renderMode();
      return;
    }
    this.modeId = id;
    this.renderMode();
    this.app.audio.play(this.assetFor(rec), { tab });
  }

  renderMode() {
    this.renderList();
    for (const view of this.app.views) {
      view.markRecMode(this.modeId, !!this.modeId);
    }
  }

  /** Stop following a saved recording when the clicked sentence is outside it. */
  stopModeForLiveRead(id) {
    if (this.modeId !== id) return;
    this.modeId = null;
    this.cancelWait();
    this.stopAt = null;
    this.stopFrom = null;
    this.loop = null;
    this.wordRound = 1;
    this.app.audio.pause();
    this.unfollow();
    if (this.framedRec?.id === id) this.framedRec = null;
    this.renderMode();
    this.updateRecordingFrame();
  }

  markPlaying(asset, on) {
    const id = asset?.rec?.id;
    if (!id) {
      if (!on) { this.framedRec = null; this.updateRecordingFrame(); }
      return;
    }
    this.playingId = on ? id : this.playingId === id ? null : this.playingId;
    this.app.views.forEach((v) => v.markRecPlaying(id, on));
    if (on) this.framedRec = this.isOfflineVoicePackage(asset.rec) ? null : asset.rec;
    else if (this.framedRec?.id === id) this.framedRec = null;
    this.updateRecordingFrame();
    if (!this.picking) this.renderList();
    if (on) this.scrollActiveAudioIntoView();
  }

  /** Draw an outer frame around each paragraph covered by the audio on the visible page(s). */
  updateRecordingFrame() {
    const recordings = new Map();
    if (this.coverageVisible) {
      // In My Audio, the frame belongs only to the focused recording. Keep
      // other recordings' icons available, but do not paint their sentences.
      if (this.selectedRec) recordings.set(this.selectedRec.id, this.selectedRec);
    } else {
      if (this.framedRec) recordings.set(this.framedRec.id, this.framedRec);
      if (this.picking) this.pickCoverage.forEach((rec, id) => { if (!recordings.has(id)) recordings.set(id, rec); });
    }
    for (const view of this.app.views) {
      const boxes = [];
      if (view.text) for (const rec of recordings.values()) {
        if (this.isOfflineVoicePackage(rec)) continue;
        if (view.book.slug !== rec.book) continue;
        const ranges = this.resolve(view, rec);
        for (const [sa, sb] of view.text.blocks) {
          const covered = ranges.some((r) => {
            if (!r) return false;
            const sentence = view.text.w2s[r.a];
            return sentence >= sa && sentence < sb;
          });
          if (!covered) continue;
          const words = view.text.sent.slice(sa, sb);
          if (!words.length) continue;
          const lines = view.text.rects(words[0][0], words.at(-1)[1], 0.14);
          if (!lines.length) continue;
          const x = Math.min(...lines.map((r) => r.x)), y = Math.min(...lines.map((r) => r.y));
          const right = Math.max(...lines.map((r) => r.x + r.w)), bottom = Math.max(...lines.map((r) => r.y + r.h));
          boxes.push({ x, y, w: right - x, h: bottom - y, selected: rec.id === this.selectedId, saved: rec.id !== this.framedRec?.id && rec.id !== this.selectedId });
        }
      }
      view.showRecordingFrame(boxes);
    }
    this.updateRecordingSelection();
  }

  async loadCoverage() {
    const pages = this.app.views.map((view) => `${view.book.slug}:${view.page.path}`).join('|');
    const summaries = this.list.filter((rec) => rec.paths?.some((path) => this.app.views.some((view) =>
      view.book.slug === rec.book && view.page.path === path)));
    const full = await Promise.all(summaries.map((rec) => this.loadFull(rec.id).catch(() => null)));
    const currentPages = this.app.views.map((view) => `${view.book.slug}:${view.page.path}`).join('|');
    if ((!this.picking && !this.coverageVisible) || pages !== currentPages) return;
    this.pickCoverage = new Map(full.filter(Boolean).map((rec) => [rec.id, rec]));
    this.updateRecordingFrame();
  }

  setCoverageVisible(on) {
    const wasVisible = this.coverageVisible;
    this.coverageVisible = on;
    if (on) {
      if (!wasVisible) this.spotFocusId = null;
      this.scrollActiveAudioIntoView();
      this.loadCoverage();
      this.ensureDefaultSelection();
    } else {
      if (this.picking) this.stopPicking();
      this.updateRecordingSelection();
      this.updateRecordingFrame();
    }
  }

  /** Where each sentence of a recording is in the page text now (text corrections can move it). */
  resolve(view, rec) {
    if (!view.text) return rec.sentences.map(() => null); // the page text is still loading
    let byRec = this.resolved.get(view.doc);
    if (!byRec) { byRec = new Map(); this.resolved.set(view.doc, byRec); }
    if (!byRec.has(rec.id)) {
      const t = view.text;
      const texts = t.sent.map(([a, b]) => norm(t.text(a, b)));
      byRec.set(rec.id, rec.sentences.map((s) => {
        if (s.path !== view.page.path) return null;
        if (s.b <= t.words.length && norm(t.text(s.a, s.b)) === norm(s.text)) return { a: s.a, b: s.b, exact: true };
        const i = texts.indexOf(norm(s.text));
        if (i < 0) return null;
        const [a, b] = t.sent[i];
        return { a, b, exact: b - a === s.b - s.a };
      }));
    }
    return byRec.get(rec.id);
  }

  /** Highlight the sentence and word being played (called many times a second). */
  follow(rec, ms) {
    if (this.wait) return; // waiting to repeat: the sentence stays highlighted
    const t = ms / 1000;
    const times = this.app.assistant?.busy ? 1 : repeatTimes();
    if (this.stopAt != null && t >= this.stopAt) { // word mode: just the clicked word (again, if wanted)
      if (this.wordRound < times) {
        this.wordRound++;
        this.replay(this.stopFrom, Math.max(600, gapMs()));
        return;
      }
      if (!this.app.assistant?.busy) this.stopAt = null;
      this.app.audio.pause();
      return; // Keep the clicked sentence highlighted at the clip's end.
    }
    // "Repeat each sentence": the MP3 has just gone on to the next sentence by itself (after the
    // pause the MP3 has between sentences), so go back to the start of the one being repeated.
    const L = this.loop;
    if (L && L.id === rec.id && this.stopAt == null && L.round < times && !this.app.audio.audio.paused) {
      const cur = rec.sentences[L.k], until = rec.sentences[L.k + 1]?.start ?? cur?.end;
      if (cur && t + 0.03 >= until && t < until + 0.6) {
        L.round++;
        this.replay(cur.start, gapMs());
        return;
      }
    }
    let k = -1;
    rec.sentences.forEach((s, i) => { if (s.start <= t + 0.03) k = i; });
    if (!L || L.id !== rec.id || L.k !== k) this.loop = { id: rec.id, k, round: 1 };
    const s = rec.sentences[k];
    const view = s && this.app.views.find((v) => v.page.path === s.path && v.book.slug === rec.book && v.text);
    const range = view ? this.resolve(view, rec)[k] : null;
    const key = range ? `${rec.id}:${k}` : null;
    if (key !== this.followKey) {
      this.unfollow();
      this.followKey = key;
      if (range) {
        const unit = { mode: 'sentence', a: range.a, b: range.b };
        view.showActive(unit);
        this.app.markPanel('active', view, unit);
        this.app.follower.reading(view, unit); // keep it in view, unless the person looks elsewhere
        this.app.focus = { view, w: range.a };
      }
    }
    if (!range || !range.exact || !settings.follow) return;
    let j = -1;
    const translating = s.tr && t >= s.tr.start && t < s.tr.end; // (its translation: the sentence stays marked, no word)
    if (!translating) s.words.forEach(([ws], i) => { if (ws <= t) j = i; });
    if (j !== this.followWord) {
      this.followWord = j;
      this.app.showWord(view, j >= 0 ? range.a + j : -1);
    }
  }

  unfollow() {
    this.app.follower.stopped();
    this.followKey = undefined;
    this.followWord = -1;
    this.app.views.forEach((v) => { v.showActive(null); v.showWord(-1); });
    this.app.markPanel('active', null, null);
    this.app.markPanel('cur', null, null);
  }

  // ---------------------------------------------------------------- Icons on the page

  renderSpots() {
    for (const view of this.app.views) {
      if (!view.text) { view.setRecSpots([], () => {}); continue; }
      const used = new Map();
      const spots = this.list.filter((r) => !this.isOfflineVoicePackage(r) && r.path === view.page.path && r.book === view.book.slug).map((r) => {
        // Next to the first sentence of the recording (found again if the text was corrected).
        const f = r.first;
        let range = null;
        if (f) {
          const t = view.text;
          if (f.b <= t.words.length && norm(t.text(f.a, f.b)) === norm(f.text)) range = [f.a, f.b];
          else range = t.sent.find(([a, b]) => norm(t.text(a, b)) === norm(f.text)) || null;
        }
        const box = range && view.text.rects(range[0], range[1])[0];
        let x = box ? box.x : 110, y = box ? box.y + box.h / 2 : 60; // the icon is drawn left of x
        const k = `${Math.round(x)},${Math.round(y)}`;
        y += (used.get(k) || 0) * 48; // several recordings starting at the same sentence
        used.set(k, (used.get(k) || 0) + 1);
        return { id: r.id, title: r.title, x, y };
      });
      view.setRecSpots(spots, (id) => this.onRecordingSpotClick(id));
      if (this.playingId) view.markRecPlaying(this.playingId, true);
      if (this.modeId) view.markRecMode(this.modeId, true);
    }
  }

  async onRecordingSpotClick(id) {
    // In My Audio the first click enters sentence-editing mode and frames the
    // full saved recording. Later clicks on that same icon control playback.
    if (this.coverageVisible && this.spotFocusId !== id) {
      this.spotFocusId = id;
      if (this.app.audio.asset?.rec && this.app.audio.asset.rec.id !== id) this.app.audio.pause();
      if (this.modeId && this.modeId !== id) { this.modeId = null; this.renderMode(); }
      await this.startEditing(id);
      return;
    }
    this.play(id, { tab: null });
  }

  // ---------------------------------------------------------------- Choosing sentences

  startPicking({ newAudio = false } = {}) {
    if (this.app.me.mode === 'public' && !this.app.me.user) { // on a website MP3s belong to an account
      this.app.library.accountDialog('signup', 'Create a free account (or log in) to make MP3s with a natural voice.');
      return;
    }
    if (this.app.editor.active) this.app.editor.stop();
    if (this.app.words?.collecting) this.app.words.setCollecting(false);
    this.app.reader.stop();
    if (newAudio) {
      this.selectedId = null;
      this.selectedRec = null;
      this.unselectedRanges.clear();
      this.unselectAnchor = null;
      this.updateRecordingFrame();
      this.renderList();
    }
    this.picking = true;
    // Keep the saved-audio list visible; sentence selection can be made directly on the page.
    this.section = 'audio';
    this.picked = new Map();
    this.anchor = null;
    document.body.classList.add('picking');
    $('#rec-new').hidden = true;
    $('#rec-pick-actions').hidden = false;
    this.renderSections();
    this.app.setPanelOpen(true);
    this.app.showTab('audio');
    this.app.applyMode();
    this.update();
    this.renderList();
    this.renderSpots(); // existing audio markers remain available while choosing new sentences
    const first = this.pickBox.querySelector('.prow.on');
    if (first) this.app.centerInPanel(first, first, false);
  }

  stopPicking() {
    if (!this.picking) return;
    this.picking = false;
    this.section = 'audio';
    this.picked = new Map();
    document.body.classList.remove('picking');
    $('#rec-new').hidden = false;
    $('#rec-pick-actions').hidden = true;
    this.renderSections();
    this.app.views.forEach((v) => v.showPicks([]));
    this.app.applyMode();
    this.pickCoverage.clear();
    if (this.coverageVisible) this.loadCoverage();
    else this.updateRecordingFrame();
    this.renderList();
  }

  /** The shown pages changed. */
  pageShown() {
    this.syncPageOfflineVoice();
    if (this.picking) { this.picked = new Map(); this.update(); }
    if (this.picking || this.coverageVisible) { this.loadCoverage(); this.renderSpots(); }
    this.renderList();
    this.renderPageOfflineFiles();
    this.updateRecordingFrame();
    this.updateRecordingSelection();
    this.app.updateVoiceOfflineStatus?.();
  }

  setOf(view) {
    if (!this.picked.has(view)) this.picked.set(view, new Set());
    return this.picked.get(view);
  }

  /**
   * A click on sentence s. Click the first sentence, then the last one: everything in between
   * is chosen. Clicking a chosen sentence removes it; Ctrl+click picks or drops just one.
   */
  toggle(view, s, e = {}) {
    const set = this.setOf(view);
    if (e.ctrlKey || e.metaKey) {
      if (set.has(s)) set.delete(s); else set.add(s);
      this.anchor = null;
    } else if (this.anchor?.view === view && set.has(this.anchor.s)) {
      // A second click completes the range even when its endpoint was already selected.
      for (let i = Math.min(s, this.anchor.s); i <= Math.max(s, this.anchor.s); i++) set.add(i);
      this.anchor = null;
    } else if (set.has(s)) {
      set.delete(s);
      if (this.anchor?.view === view && this.anchor.s === s) this.anchor = null;
    } else {
      set.add(s);
      this.anchor = { view, s }; // the first sentence: wait for the last one
    }
    this.update();
  }

  toggleBlock(view, bi) {
    const [a, b] = view.text.blocks[bi];
    const set = this.setOf(view);
    const all = Array.from({ length: b - a }, (_, i) => a + i);
    if (all.every((s) => set.has(s))) all.forEach((s) => set.delete(s));
    else all.forEach((s) => set.add(s));
    this.anchor = null;
    this.unselectAnchor = null;
    this.update();
  }

  pageClick(view, unit, e) {
    const s = view.text?.w2s[unit.a] ?? -1;
    if (s < 0) return;
    // In saved-audio mode, page clicks first operate on recordings that already
    // contain the sentence. Do not accidentally add unrelated text to the edit.
    if (this.selectedRec && view.book.slug === this.selectedRec.book) {
      const [a, b] = view.text.sent[s] || [];
      const belongsToSelected = this.resolve(view, this.selectedRec).some((r) => r && a < r.b && b > r.a);
      if (belongsToSelected) {
        this.toggleSelectedAudioSentence(view, s, e || {});
        return;
      }
      this.selectOtherRecordingForSentence(view, a, b, unit);
      return;
    }
    // New-audio mode retains the ordinary sentence picker/range behavior.
    if (this.picking) {
      this.unselectAnchor = null;
      this.toggle(view, s, e || {});
      return;
    }
    this.app.reader.click(view, unit, true);
  }

  async selectOtherRecordingForSentence(view, a, b, unit) {
    if (a == null || b == null || !this.selectedRec) return;
    const selectedId = this.selectedId;
    for (const summary of this.list) {
      const paths = summary.paths?.length ? summary.paths : [summary.path];
      if (summary.id === selectedId || summary.book !== view.book.slug || !paths.includes(view.page.path)) continue;
      let rec;
      try { rec = await this.loadFull(summary.id); } catch { continue; }
      const ranges = this.resolve(view, rec);
      if (!ranges.some((r) => r && a < r.b && b > r.a)) continue;
      // Selecting another saved audio enters its edit mode; the next click on
      // one of its highlighted sentences can then remove that sentence.
      await this.startEditing(summary.id);
      return;
    }
    // No saved recording owns this sentence: leave it out of the current edit
    // and use the regular live reader instead of selecting it for an MP3.
    if (this.selectedId === selectedId) this.app.reader.click(view, unit, true);
  }

  toggleSelectedAudioSentence(view, sentenceIndex, e = {}) {
    if (!this.selectedRec || view.book.slug !== this.selectedRec.book || !view.text?.sent[sentenceIndex]) return false;
    const [a, b] = view.text.sent[sentenceIndex];
    const range = this.resolve(view, this.selectedRec).find((r) => r && a < r.b && b > r.a);
    if (e.ctrlKey || e.metaKey) {
      if (!range) return false;
      const key = `${view.page.path}:${range.a}:${range.b}`;
      if (this.unselectedRanges.has(key)) this.unselectedRanges.delete(key);
      else this.unselectedRanges.add(key);
      this.unselectAnchor = null;
      this.anchor = null;
    } else if (this.anchor?.view === view && this.picked.get(view)?.has(this.anchor.s)) {
      // Finish an add-range even when its last sentence already belongs to the audio.
      const lo = Math.min(this.anchor.s, sentenceIndex), hi = Math.max(this.anchor.s, sentenceIndex);
      const set = this.setOf(view), ranges = this.resolve(view, this.selectedRec);
      for (let s = lo; s <= hi; s++) {
        const [sa, sb] = view.text.sent[s] || [];
        if (sa == null) continue;
        const existing = ranges.find((r) => r && sa < r.b && sb > r.a);
        if (existing) this.unselectedRanges.delete(`${view.page.path}:${existing.a}:${existing.b}`);
        else set.add(s);
      }
      this.anchor = null;
      this.unselectAnchor = null;
    } else if (this.unselectAnchor?.view === view && this.unselectAnchor.s !== sentenceIndex) {
      // Finish a remove-range even if its endpoint is already deselected.
      const lo = Math.min(this.unselectAnchor.s, sentenceIndex), hi = Math.max(this.unselectAnchor.s, sentenceIndex);
      const set = this.picked.get(view), ranges = this.resolve(view, this.selectedRec);
      for (let s = lo; s <= hi; s++) {
        set?.delete(s);
        const [sa, sb] = view.text.sent[s] || [];
        if (sa == null) continue;
        const covered = ranges.find((r) => r && sa < r.b && sb > r.a);
        if (covered) this.unselectedRanges.add(`${view.page.path}:${covered.a}:${covered.b}`);
      }
      this.unselectAnchor = null;
    } else {
      if (!range) return false;
      const key = `${view.page.path}:${range.a}:${range.b}`;
      if (this.unselectedRanges.has(key)) {
        this.unselectedRanges.delete(key);
        this.setOf(view).add(sentenceIndex);
        this.anchor = { view, s: sentenceIndex };
        this.unselectAnchor = null;
      } else {
        this.unselectedRanges.add(key);
        this.unselectAnchor = { view, s: sentenceIndex };
      }
      this.anchor = null;
    }
    this.updateRecordingSelection();
    this.update();
    return true;
  }

  pickedSentences() {
    const out = [];
    for (const view of this.app.views) {
      const set = this.picked.get(view);
      if (!set?.size || !view.text) continue;
      for (const s of [...set].sort((x, y) => x - y)) {
        const [a, b] = view.text.sent[s];
        const words = [];
        for (let k = a; k < b; k++) words.push(speakable(view.text.words[k][4]));
        out.push({ view, path: view.page.path, a, b, text: view.text.text(a, b), words });
      }
    }
    return out;
  }

  update() {
    const n = this.pickedSentences().length;
    $('#rec-count').textContent = this.anchor ? 'Now click the last sentence' : `${n} sentence${n === 1 ? '' : 's'} chosen`;
    $('#rec-create').disabled = n === 0;
    for (const view of this.app.views) {
      const set = this.picked.get(view) || new Set();
      view.showPicks([...set].map((s) => view.text.sentenceUnit(s)));
    }
    this.renderPick();
    this.renderList();
  }

  renderPick() {
    const keep = this.pickBox.scrollTop;
    const selectionHelp = this.selectedRec
      ? 'In the selected audio, click a sentence to remove it; click another sentence to remove the range between them. Click a removed sentence to restore it. Click other sentences to add them. '
      : 'Click the first sentence, then the last one: everything in between is chosen. ';
    const out = [el('p', { class: 'edit-hint' },
      selectionHelp +
      'The box next to a paragraph chooses the whole paragraph. Ctrl+click picks or drops a single sentence. ' +
      'This works in the list and on the page. Click + beside a recording to add these sentences; in the editor, untick sentences to remove. The old audio stays unless you choose to replace it.'),
    el('div', { class: 'pick-tools' },
      el('button', { class: 'link-btn', dataset: { pick: 'all' } }, 'Choose everything'), ' · ',
      el('button', { class: 'link-btn', dataset: { pick: 'none' } }, 'Clear'))];
    this.app.views.forEach((view, vi) => {
      out.push(el('h4', {}, `Page ${view.page.n}`));
      if (!view.text?.sent.length) { out.push(el('div', { class: 'empty' }, 'There is no text on this page.')); return; }
      const set = this.picked.get(view) || new Set();
      view.text.blocks.forEach(([sa, sb], bi) => {
        const count = Array.from({ length: sb - sa }, (_, i) => sa + i).filter((s) => set.has(s)).length;
        const box = el('input', { type: 'checkbox', checked: count === sb - sa, 'aria-label': 'The whole paragraph', dataset: { pick: 'block', v: vi, b: bi } });
        box.indeterminate = count > 0 && count < sb - sa;
        const rows = [];
        for (let s = sa; s < sb; s++) {
          const isAnchor = this.anchor?.view === view && this.anchor.s === s;
          rows.push(el('label', { class: `prow${set.has(s) ? ' on' : ''}${isAnchor ? ' anchor' : ''}` },
            el('input', { type: 'checkbox', checked: set.has(s), dataset: { pick: 'sent', v: vi, s } }),
            el('span', {}, view.text.text(...view.text.sent[s]))));
        }
        out.push(el('div', { class: `pblock${count ? ' some' : ''}` }, el('div', { class: 'pblock-box', title: 'Choose the whole paragraph' }, box), el('div', {}, ...rows)));
      });
    });
    this.pickBox.replaceChildren(...out);
    this.pickBox.scrollTop = keep;
  }

  onPickClick(e) {
    const extend = e.target.closest('[data-act="regenerate"]');
    if (extend) {
      const id = e.target.closest('.rec')?.dataset.id;
      const rec = this.list.find((x) => x.id === id);
      if (rec) this.extend(rec);
      return;
    }
    const row = e.target.closest('.rec');
    if (row && !e.target.closest('[data-act]')) {
      this.startEditing(row.dataset.id);
      return;
    }
    const t = e.target.closest('[data-pick]');
    if (!t) return;
    if (t.dataset.pick === 'all' || t.dataset.pick === 'none') {
      for (const view of this.app.views) {
        const set = this.setOf(view);
        set.clear();
        if (t.dataset.pick === 'all') view.text?.sent.forEach((_, i) => set.add(i));
      }
      this.update();
      return;
    }
    e.preventDefault(); // the list is drawn again with the new state
    const view = this.app.views[Number(t.dataset.v)];
    if (t.dataset.pick === 'block') this.toggleBlock(view, Number(t.dataset.b));
    else {
      const sentence = Number(t.dataset.s);
      if (!this.toggleSelectedAudioSentence(view, sentence, e)) {
        this.unselectAnchor = null;
        this.toggle(view, sentence, e);
      }
    }
  }

  // ---------------------------------------------------------------- Creating an audio

  voices() {
    if (!this.voicesPromise) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      this.voicesPromise = fetch('/api/voices', { signal: controller.signal }).then(async (r) => {
        if (r.status === 404) {
          throw new Error('The app’s server is an older version. Close its black window and start the app again with Start Lingua Books.bat.');
        }
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || 'The voices could not be loaded. Check that the app server is running.');
        if (!Array.isArray(data)) throw new Error('The app server returned an invalid voice list. Restart Lingua Books and try again.');
        return data;
      }, (error) => {
        throw new Error(error?.name === 'AbortError'
          ? 'Loading voices took too long. Restart Lingua Books and try again.'
          : 'The app’s server is not running. Start the app with Start Lingua Books.bat.');
      }).finally(() => clearTimeout(timeout));
      this.voicesPromise.catch(() => { this.voicesPromise = null; });
    }
    return this.voicesPromise;
  }

  /** The voices of a translation language (ar, zh-CN …) the server can make audio with. */
  translationVoiceList(lang) {
    this.trVoiceLists ||= new Map();
    if (!this.trVoiceLists.has(lang)) {
      const p = fetch(`/api/voices?lang=${encodeURIComponent(lang)}`).then(async (r) => {
        const d = await r.json().catch(() => null);
        if (!r.ok || !Array.isArray(d)) throw new Error(d?.error || 'The voices for the translation could not be loaded.');
        return d;
      });
      p.catch(() => this.trVoiceLists.delete(lang));
      this.trVoiceLists.set(lang, p);
    }
    return this.trVoiceLists.get(lang);
  }

  /** The one that matches the voice reading the translation aloud, else a Natural voice of the language. */
  defaultTranslationVoice(list, lang) {
    return matchingRecordingVoice(speech.translationVoice(lang), list, lang) || list.find((v) => !isWindowsVoice(v)) || list[0] || null;
  }

  /**
   * The translation of each sentence ({path, a, b}; from the book `slug`) into the language of
   * the Translation tab, '' where there is none yet. onWait(seconds): the translation service is
   * busy and asks to wait.
   */
  async translationsOf(slug, sentences, onWait = null) {
    const t = this.app.translator, pages = new Map(), out = [];
    const pageTranslations = async (path) => {
      const view = this.app.views.find((v) => v.book.slug === slug && v.page.path === path && v.text);
      if (view) return { text: view.text, trs: await t.forView(view) };
      const r = await fetch(`/api/text/${encodeURIComponent(slug)}/${encodeURIComponent(path)}`, { cache: 'no-store' });
      if (!r.ok) return { text: null, trs: null };
      const text = new PageText(await r.json());
      return { text, trs: await t.forText(slug, path, text) };
    };
    for (const s of sentences) {
      if (!pages.has(s.path)) {
        for (let tries = 0; ; tries++) { // Google asks to slow down now and then: wait, then go on
          try { pages.set(s.path, await pageTranslations(s.path)); break; } catch (err) {
            if (!err.busy || tries >= 4) throw err;
            onWait?.(err.wait || 60);
            await new Promise((ok) => setTimeout(ok, (err.wait || 60) * 1000));
          }
        }
      }
      const { text, trs } = pages.get(s.path);
      const k = text ? text.sent.findIndex(([a, b]) => a === s.a && b === s.b) : -1;
      out.push((k >= 0 && trs?.[k]) || '');
    }
    return out;
  }

  /** New recordings follow the chosen reading voice; regeneration retains its original voice. */
  defaultVoice(voices) {
    const same = matchingRecordingVoice(speech.currentVoice('en'), voices);
    if (same) return same.id;
    const saved = store.get('recVoice', null);
    if (saved && voices.some((v) => v.id === saved)) return saved;
    return voices.find((v) => v.id === 'en-US-AriaNeural')?.id || voices.find((v) => v.locale.startsWith('en-'))?.id;
  }

  defaultChineseVoice(voices) {
    const same = matchingRecordingVoice(speech.currentVoice('zh'), voices, 'zh');
    if (same) return same.id;
    const saved = store.get('recZhVoice', null);
    return (saved && voices.some((v) => v.id === saved) ? saved : null)
      || voices.find((v) => v.id === 'zh-CN-XiaoxiaoNeural')?.id
      || voices.find((v) => v.locale === 'zh-CN')?.id || voices.find((v) => v.locale.startsWith('zh-'))?.id;
  }

  otherVoice(voices, primary) {
    const first = voices.find((v) => v.id === primary);
    const sameProvider = voices.filter((v) => isWindowsVoice(v) === isWindowsVoice(first));
    return sameProvider.find((v) => v.gender && first?.gender && v.gender !== first.gender)?.id
      || sameProvider.find((v) => v.id !== primary)?.id
      || (isWindowsVoice(first) ? primary : voices.find((v) => v.gender && first?.gender && v.gender !== first.gender)?.id)
      || voices.find((v) => v.id !== primary)?.id || primary;
  }

  async extend(rec) {
    const additions = this.pickedSentences();
    const applyPageSelection = rec.id === this.selectedId && this.unselectedRanges.size > 0;
    if (!additions.length && !applyPageSelection) { toast('Choose sentences to add, or deselect sentences in this saved audio first.'); return; }
    if (additions.some((s) => s.view.book.slug !== rec.book)) { toast('Choose sentences from the same book as this audio.'); return; }
    try {
      const full = await this.loadFull(rec.id);
      const docs = new Map();
      const original = [];
      for (let i = 0; i < full.sentences.length; i++) {
        const s = full.sentences[i];
        const currentView = this.app.views.find((v) => v.book.slug === rec.book && v.page.path === s.path);
        const currentRange = currentView ? this.resolve(currentView, full)[i] : null;
        const rangeKey = `${s.path}:${currentRange?.a ?? s.a}:${currentRange?.b ?? s.b}`;
        if (applyPageSelection && this.unselectedRanges.has(rangeKey)) continue;
        if (!docs.has(s.path)) {
          const view = this.app.views.find((v) => v.book.slug === rec.book && v.page.path === s.path);
          const response = view?.text ? null : await fetch(`/api/text/${rec.book}/${s.path}`, { cache: 'no-store' });
          if (response && !response.ok) throw new Error(`Could not load the text for page ${s.path} in the existing audio.`);
          docs.set(s.path, view?.text || await response.json());
        }
        const doc = docs.get(s.path);
        const words = doc.words.slice(s.a, s.b);
        if (words.length !== s.b - s.a) throw new Error('The original sentences no longer match the book text. Keep the old audio and create a new one instead.');
        const text = words.reduce((out, w, i) => out + w[4] + (w[6] && i < words.length - 1 ? ' ' : ''), '').trim();
        if (norm(text) !== norm(s.text)) throw new Error('Some sentences in the existing audio have changed in the book. Keep the old audio and create a new one instead.');
        original.push({ path: s.path, a: s.a, b: s.b, text: s.text, words: words.map((w) => speakable(w[4])) });
      }
      const keys = new Set(original.map((s) => `${s.path}:${s.a}:${s.b}`));
      const extra = additions.filter((s) => !keys.has(`${s.path}:${s.a}:${s.b}`));
      if (!extra.length && !applyPageSelection) { toast('Every chosen sentence is already in this audio. Choose new sentences to add.'); return; }
      if (!original.length && !extra.length) { toast('Keep at least one sentence in the regenerated audio.'); return; }
      this.openCreate({ existing: full, original, additions: extra });
    } catch (err) {
      toast(err.message || 'Could not prepare the existing audio for updating.');
    }
  }

  /** New audio from the sentences chosen in the page-layout window (host: the box in that window where the form is shown). */
  createFromLayout({ book, page, sentences, host }) {
    if (this.app.me.mode === 'public' && !this.app.me.user) {
      toast('Create a free account (or log in) to make MP3s with a natural voice.');
      return;
    }
    const view = { book: { slug: book.id, id: book.id, type: book.title }, page: { n: page, path: `p${page}` } };
    this.openCreate({ host, additions: sentences.map((s) => ({ view, path: view.page.path, a: s.a, b: s.b, text: s.text, words: (s.speak || []).map(speakable) })) });
  }

  openCreate({ existing = null, original = [], additions = null, offlineImport = false, host = null } = {}) {
    const leave = () => { if (host) host.close(); else closeDialog(); }; // (the layout window must stay open)
    const newlyPicked = additions || this.pickedSentences();
    const sents = [...original, ...newlyPicked];
    if (!sents.length) return;
    const included = new Set(sents.map((_, i) => i));
    const field = (label, control, out) => el('label', { class: 'field' }, el('span', {}, label, out || ''), control);
    const offlineTitle = offlineImport ? `${this.app.book?.title || this.app.book?.type || 'Book'} offline audio` : '';
    const title = el('input', { type: 'text', class: 'input', maxlength: '120', value: existing?.title || offlineTitle || sents[0].text.slice(0, 60) });
    const voice = el('select', { class: 'select', dataset: { role: 'audio-voice' } }, el('option', {}, 'Loading voices…'));
    const voiceB = el('select', { class: 'select', dataset: { role: 'audio-voice-b' } }, el('option', {}, 'Loading voices…'));
    const zhVoice = el('select', { class: 'select', dataset: { role: 'audio-zh-voice' } }, el('option', {}, 'Loading Chinese voices…'));
    const zhVoiceB = el('select', { class: 'select', dataset: { role: 'audio-zh-voice-b' } }, el('option', {}, 'Loading Chinese voices…'));
    const zhTryBtn = el('button', { class: 'btn small', type: 'button', html: `${icon('volume')}Try` });
    const initialLanguage = existing?.languageMode || detectRecordingLanguage(sents, settings.languageMode || 'both');
    const languageMode = el('select', { class: 'select', dataset: { role: 'audio-language' } },
      el('option', { value: 'both', selected: initialLanguage === 'both' }, 'English and Chinese'),
      el('option', { value: 'en', selected: initialLanguage === 'en' }, 'English only'),
      el('option', { value: 'zh', selected: initialLanguage === 'zh' }, 'Chinese only'));
    const speakerLabels = sents.map((s) => s.text.match(/^\s*([A-Z][A-Za-z0-9_. '-]{0,28}):/)?.[1]?.trim().toLowerCase()).filter(Boolean);
    const likelyDialogue = new Set(speakerLabels).size > 1;
    const twoSpeakers = el('input', { type: 'checkbox', checked: existing ? existing.twoSpeakers : likelyDialogue });
    const speakerHint = el('p', { class: 'hint' }, 'Speaker labels such as A:/B: or names: are detected. Without labels, selected sentences alternate between speaker A and B.');
    const tryBtn = el('button', { class: 'btn small', type: 'button', html: `${icon('volume')}Try` });
    const englishField = el('div', { class: 'field' }, el('span', {}, 'Voice'), el('div', { class: 'row' }, voice, tryBtn));
    const speakerBField = el('div', { class: 'field' }, el('span', {}, 'Speaker B — English voice'), voiceB);
    const chineseField = el('div', { class: 'field' }, el('span', {}, 'Chinese voice'), el('div', { class: 'row' }, zhVoice, zhTryBtn));
    const chineseBField = el('div', { class: 'field' }, el('span', {}, 'Speaker B — Chinese voice'), zhVoiceB);
    const rate = el('input', { type: 'range', min: '-50', max: '50', step: '5', value: String(existing?.rate ?? store.get('recRate', 0)) });
    const rateOut = el('output');
    const gap = el('input', { type: 'range', min: '0', max: '10', step: '0.5', value: String(existing?.gap ?? store.get('recGap', settings.gap || 0)) });
    const gapOut = el('output');
    // Read each sentence's translation too (into the language of the Translation tab), with a voice of that language.
    const trLang = this.app.translator?.lang || '', trName = this.app.translator?.name || trLang;
    const trOrder = el('select', { class: 'select', dataset: { role: 'audio-translation' }, disabled: !trLang },
      el('option', { value: 'off' }, 'No'), el('option', { value: 'after' }, 'After each sentence'), el('option', { value: 'before' }, 'Before each sentence'));
    trOrder.value = !trLang ? 'off' : existing ? existing.translation?.order || 'off' : settings.trOrder;
    const trVoice = el('select', { class: 'select', dataset: { role: 'audio-translation-voice' } }, el('option', { value: '' }, 'Loading voices…'));
    const trTryBtn = el('button', { class: 'btn small', type: 'button', html: `${icon('volume')}Try` });
    const trField = field(trLang ? `Read the ${trName} translation` : 'Read the translation (choose its language in the Translation tab)', trOrder);
    const trVoiceField = el('div', { class: 'field' }, el('span', {}, `${trName} voice`), el('div', { class: 'row' }, trVoice, trTryBtn));
    let trVoices = null; // (still loading)
    const showRate = () => { rateOut.textContent = Number(rate.value) ? `${Number(rate.value) > 0 ? '+' : ''}${rate.value}%` : 'normal'; };
    const showGap = () => { gapOut.textContent = Number(gap.value) ? `${Number(gap.value)} s` : 'none'; };
    const selectedSentences = () => sents.filter((_, i) => included.has(i));
    const estimate = () => {
      const chosen = selectedSentences();
      const words = chosen.reduce((n, s) => n + s.words.length, 0);
      return `${chosen.length} sentence${chosen.length === 1 ? '' : 's'} · about ${fmtTime(
        (words / 2.6) / (1 + Number(rate.value) / 100) + Number(gap.value) * Math.max(0, chosen.length - 1))}`;
    };
    const summary = el('p', { class: 'hint' }, estimate());
    rate.addEventListener('input', () => { showRate(); summary.textContent = estimate(); });
    gap.addEventListener('input', () => { showGap(); summary.textContent = estimate(); });
    showRate();
    showGap();
    const error = el('p', { class: 'rec-error', hidden: true });
    const bar = el('div', { class: 'rec-progress', hidden: true }, el('div'));
    const status = el('p', { class: 'hint', hidden: true });
    const create = el('button', { class: 'btn primary', type: 'button', disabled: true, dataset: { role: 'audio-create' }, html: `${icon(offlineImport ? 'download' : 'wave')}${offlineImport ? 'Import offline' : existing ? 'Regenerate audio' : 'Create MP3'}` });
    const cancel = el('button', { class: 'btn', type: 'button' }, 'Cancel');
    cancel.addEventListener('click', () => leave());
    const replaceOld = existing ? el('input', { type: 'checkbox', checked: true }) : null;
    let voicesValid = false;
    let generating = false;
    const voiceSource = el('p', { class: 'hint', dataset: { role: 'audio-voice-source' }, 'aria-live': 'polite' }, 'Checking available voices…');
    const useOffline = el('button', { class: 'btn small', type: 'button', hidden: true, dataset: { role: 'audio-use-offline' } }, 'Use Windows offline voices');
    const currentVoices = () => ({ voice: voice.value, voiceB: voiceB.value, zhVoice: zhVoice.value,
      zhVoiceB: zhVoiceB.value, languageMode: languageMode.value, twoSpeakers: twoSpeakers.checked });
    const syncVoiceSource = () => {
      if (!this.voiceList) return;
      const active = (languageMode.value === 'zh' ? [] : [voice.value, ...(twoSpeakers.checked ? [voiceB.value] : [])])
        .concat(languageMode.value === 'en' ? [] : [zhVoice.value, ...(twoSpeakers.checked ? [zhVoiceB.value] : [])]);
      const online = active.map((id) => this.voiceList.find((v) => v.id === id)).filter((v) => v && !isWindowsVoice(v));
      const alternatives = offlineVoiceChoices(this.voiceList, currentVoices());
      useOffline.hidden = online.length === 0;
      useOffline.disabled = generating || alternatives.missing.length > 0;
      useOffline.title = alternatives.missing.length
        ? `No Windows ${alternatives.missing.join(' or ')} voice is installed on the app server.`
        : 'Switch to installed voices. They sound different from Natural voices. Your selected sentences and title stay unchanged.';
      if (online.length) {
        const names = [...new Set(online.map((v) => v.name))].join(', ');
        voiceSource.textContent = `${names}: online service required. ` + (alternatives.missing.length
          ? `No installed Windows ${alternatives.missing.join(' or ')} voice is available on the app server.`
          : 'Windows voices can create this audio without internet; they sound different.'
            + (alternatives.shared.length ? ` Only one Windows ${alternatives.shared.join(' / ')} voice is installed, so both speakers would share it.` : ''));
      } else {
        voiceSource.textContent = 'Windows offline: this audio is generated on the app server without internet. Click Create MP3 when ready.';
      }
    };
    const syncCreateState = () => {
      if (this.voiceList) voicesValid = !!voice.value && (languageMode.value === 'en' || !!zhVoice.value)
        && (!twoSpeakers.checked || !!voiceB.value) && (!twoSpeakers.checked || languageMode.value === 'en' || !!zhVoiceB.value);
      trVoiceField.hidden = trOrder.value === 'off';
      const trValid = trOrder.value === 'off' || !!trVoices?.some((v) => v.id === trVoice.value);
      create.disabled = generating || !voicesValid || !trValid || selectedSentences().length === 0;
      syncVoiceSource();
    };
    useOffline.addEventListener('click', () => {
      if (generating || !this.voiceList) return;
      const alternatives = offlineVoiceChoices(this.voiceList, currentVoices());
      if (alternatives.missing.length) return;
      for (const [field, input] of Object.entries({ voice, voiceB, zhVoice, zhVoiceB })) input.value = alternatives.voices[field];
      error.hidden = true;
      syncCreateState();
    });
    const sentenceEditor = existing ? el('div', { class: 'rec-sentence-edit' },
      el('h4', {}, 'Sentences in the regenerated audio'),
      el('p', { class: 'hint' }, 'Untick any sentence you want removed. Newly selected sentences are included too.'),
      ...sents.map((s, i) => el('label', { class: 'rec-sentence-choice' },
        el('input', { type: 'checkbox', checked: true, dataset: { index: i } }),
        el('span', {}, s.text)))) : null;
    sentenceEditor?.addEventListener('change', (e) => {
      const checkbox = e.target.closest('input[data-index]');
      if (!checkbox) return;
      const index = Number(checkbox.dataset.index);
      if (checkbox.checked) included.add(index); else included.delete(index);
      summary.textContent = estimate();
      syncCreateState();
    });
    for (const control of [voice, voiceB, zhVoice, zhVoiceB, languageMode, twoSpeakers]) {
      control.addEventListener('change', syncCreateState);
    }

    this.voices().then((voices) => {
      const english = voices.filter((v) => v.locale.startsWith('en-'));
      const chinese = voices.filter((v) => v.locale.startsWith('zh-'));
      const groups = new Map();
      for (const v of english) {
        const g = `${isWindowsVoice(v) ? 'Windows offline' : 'Online Natural'} · ${ACCENTS[v.locale] || v.locale} English`;
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(v);
      }
      voice.replaceChildren(...[...groups].sort(([a], [b]) => Number(b.startsWith('Windows')) - Number(a.startsWith('Windows'))).map(([g, vs]) => el('optgroup', { label: g },
        ...vs.map((v) => el('option', { value: v.id }, recordingVoiceLabel(v))))));
      zhVoice.replaceChildren(...(chinese.length ? chinese.map((v) => el('option', { value: v.id }, recordingVoiceLabel(v, true))) : [el('option', { value: '' }, 'No Chinese voice found')]));
      voice.value = (existing?.voice && english.some((v) => v.id === existing.voice) ? existing.voice : this.defaultVoice(english)) || '';
      voiceB.replaceChildren(...english.map((v) => el('option', { value: v.id }, recordingVoiceLabel(v, true))));
      voiceB.value = (existing?.voiceB && english.some((v) => v.id === existing.voiceB) ? existing.voiceB : this.otherVoice(english, voice.value)) || '';
      zhVoice.value = (existing?.zhVoice && chinese.some((v) => v.id === existing.zhVoice) ? existing.zhVoice : this.defaultChineseVoice(chinese)) || '';
      zhVoiceB.replaceChildren(...(chinese.length ? chinese.map((v) => el('option', { value: v.id }, recordingVoiceLabel(v, true))) : [el('option', { value: '' }, 'No Chinese voice found')]));
      zhVoiceB.value = (existing?.zhVoiceB && chinese.some((v) => v.id === existing.zhVoiceB) ? existing.zhVoiceB : this.otherVoice(chinese, zhVoice.value)) || '';
      this.voiceList = voices;
      syncCreateState();
    }).catch((err) => {
      voice.replaceChildren(el('option', {}, 'Not available'));
      error.textContent = err.message;
      error.hidden = false;
      voiceSource.textContent = 'The voice list could not be loaded. Restart the app server and reopen this dialog.';
    });
    if (trLang) {
      this.translationVoiceList(trLang).then((list) => {
        trVoices = list;
        trVoice.replaceChildren(...(list.length ? list.map((v) => el('option', { value: v.id }, recordingVoiceLabel(v, true)))
          : [el('option', { value: '' }, `No ${trName} voice found`)]));
        const kept = existing?.translation?.lang === trLang && list.find((v) => v.id === existing.translation.voice);
        trVoice.value = (kept || this.defaultTranslationVoice(list, trLang))?.id || '';
        syncCreateState();
      }).catch((err) => { trVoice.replaceChildren(el('option', { value: '' }, err.message)); });
    }
    trOrder.addEventListener('change', syncCreateState);
    trVoice.addEventListener('change', syncCreateState);
    trTryBtn.addEventListener('click', () => {
      new Audio(`/api/voice-sample?voice=${encodeURIComponent(trVoice.value)}&rate=${rate.value}`).play()
        .catch(() => toast(`The ${trName} voice could not be played. Check the internet connection.`));
    });

    tryBtn.addEventListener('click', () => {
      const chosen = voice.value;
      const a = new Audio(`/api/voice-sample?voice=${encodeURIComponent(chosen)}&rate=${rate.value}`);
      a.play().catch(() => toast(isWindowsVoice(this.voiceList?.find((v) => v.id === chosen))
        ? 'The Windows voice could not be played. Check that the app server and installed voice are available.'
        : 'The online voice could not be played. Check the internet or choose a Windows offline voice.'));
    });
    zhTryBtn.addEventListener('click', () => {
      const a = new Audio(`/api/voice-sample?voice=${encodeURIComponent(zhVoice.value)}&rate=${rate.value}`);
      a.play().catch(() => toast(isWindowsVoice(this.voiceList?.find((v) => v.id === zhVoice.value))
        ? 'The Windows Chinese voice could not be played. Check that the app server and installed voice are available.'
        : 'The online Chinese voice could not be played. Check the internet or choose a Windows offline voice.'));
    });
    const syncLanguageMode = () => {
      englishField.hidden = languageMode.value === 'zh';
      chineseField.hidden = languageMode.value === 'en';
    };
    languageMode.addEventListener('change', syncLanguageMode);
    syncLanguageMode();
    const syncSpeakers = () => {
      speakerBField.hidden = !twoSpeakers.checked || languageMode.value === 'zh';
      chineseBField.hidden = !twoSpeakers.checked || languageMode.value === 'en';
      speakerHint.hidden = !twoSpeakers.checked;
    };
    twoSpeakers.addEventListener('change', syncSpeakers);
    languageMode.addEventListener('change', syncSpeakers);
    syncSpeakers();

    create.addEventListener('click', async () => {
      if (generating) return;
      const v = this.voiceList?.find((x) => x.id === voice.value);
      const zv = this.voiceList?.find((x) => x.id === zhVoice.value);
      const vb = this.voiceList?.find((x) => x.id === voiceB.value);
      const zvb = this.voiceList?.find((x) => x.id === zhVoiceB.value);
      if (!v || (languageMode.value !== 'en' && !zv) || (twoSpeakers.checked && !vb) || (twoSpeakers.checked && languageMode.value !== 'en' && !zvb)) {
        toast(languageMode.value !== 'en' && !zv ? 'Choose a Chinese voice before creating audio.' : 'Choose voices for both speakers.');
        return;
      }
      const tv = trOrder.value !== 'off' ? trVoices?.find((x) => x.id === trVoice.value) : null;
      if (trOrder.value !== 'off' && !tv) { toast(`Choose a ${trName} voice, or do not read the translation.`); return; }
      store.set('recVoice', v.id);
      store.set('recZhVoice', zv?.id || '');
      store.set('recRate', Number(rate.value));
      store.set('recGap', Number(gap.value));
      const first = newlyPicked[0]?.view;
      const selectedVoiceNames = languageMode.value === 'en' ? `A: ${v.name}` : `A: ${v.name} + ${zv.name}`;
      const completeVoiceNames = twoSpeakers.checked
        ? `${selectedVoiceNames}; B: ${vb.name}${languageMode.value === 'en' ? '' : ` + ${zvb.name}`}`
        : selectedVoiceNames;
      const body = {
        book: existing?.book || first.book.slug, bookId: existing?.bookId || first.book.id,
        bookType: existing?.bookType || first.book.type, page: existing?.page || first.page.n, path: existing?.path || first.page.path,
        title: title.value.trim(), voice: v.id, voiceName: completeVoiceNames, zhVoice: zv?.id || '', zhVoiceName: zv?.name || '', languageMode: languageMode.value, rate: Number(rate.value), gap: Number(gap.value),
        twoSpeakers: twoSpeakers.checked, voiceB: vb?.id || '', voiceBName: vb?.name || '', zhVoiceB: zvb?.id || '', zhVoiceBName: zvb?.name || '',
        translation: tv ? { order: trOrder.value, lang: trLang, langName: trName, voice: tv.id, voiceName: tv.name } : null,
        sentences: selectedSentences().map(({ path, a, b, text, words: w }) => ({ path, a, b, text, words: w })),
      };
      if (!body.sentences.length) { toast('Keep at least one sentence in the regenerated audio.'); return; }
      generating = true;
      syncCreateState();
      error.hidden = true;
      bar.hidden = false;
      status.hidden = false;
      status.textContent = 'Starting…';
      try {
        if (tv) { // each sentence's translation, read before or after it
          status.textContent = `Translating into ${trName}…`;
          const trs = await this.translationsOf(body.book, body.sentences, (sec) => { status.textContent = `The translation service is busy: waiting ${sec} s…`; });
          body.sentences.forEach((s, i) => { s.tr = trs[i]; });
          if (!trs.some(Boolean)) throw new Error(`There is no ${trName} translation of these sentences yet. Check the internet connection, or the Translation tab.`);
        }
        if (offlineImport) {
          const chunks = [];
          for (let i = 0; i < body.sentences.length; i += 400) chunks.push(body.sentences.slice(i, i + 400));
          let done = 0;
          for (let i = 0; i < chunks.length; i++) {
            const batch = { ...body, offlineVoiceOnly: true, title: chunks.length === 1 ? body.title : `${body.title} (${i + 1}/${chunks.length})`, sentences: chunks[i] };
            const rec = await this.create(batch, (partDone, partTotal) => { // (the server counts each translation too)
              const progress = done + Math.round((partDone / (partTotal || chunks[i].length)) * chunks[i].length);
              bar.firstChild.style.width = `${(progress / body.sentences.length) * 100}%`;
              status.textContent = `Creating offline audio… ${progress} of ${body.sentences.length} sentences`;
            });
            await this.cacheGeneratedOffline(rec, { voiceOnly: true });
            const removed = await fetch(`/api/recordings/${rec.id}`, { method: 'DELETE' }).catch(() => null);
            if (!removed?.ok) { this.serverOffline.set(rec.id, rec); this.serverIds.add(rec.id); }
            else {
              this.serverIds.delete(rec.id);
              this.serverOffline.delete(rec.id);
              const item = this.offlineItems.get(rec.id);
              if (item) { item.serverCopy = false; await offlineAudio.put(item); }
            }
            done += chunks[i].length;
          }
          closeDialog();
          this.stopPicking();
          this.renderList();
          this.renderSpots();
          this.renderPageOfflineFiles();
          $('#offline-status').textContent = `Offline audio ready: ${body.sentences.length} sentences in ${chunks.length} voice file${chunks.length === 1 ? '' : 's'}.`;
          this.app.openSettings?.('voice');
          toast('Offline audio imported to this browser.');
          return;
        }
        const rec = await this.create(body, (done, total) => {
          bar.firstChild.style.width = `${(done / total) * 100}%`;
          status.textContent = `Creating the audio… ${done} of ${total} ${tv ? 'sentences and translations' : 'sentences'}`;
        });
        let replaced = false;
        let replaceFailed = false;
        if (existing && replaceOld.checked) {
          const deleted = await this.deleteRecording(existing.id, { notify: false });
          if (deleted) {
            replaced = true;
            this.list = this.list.filter((r) => r.id !== existing.id);
            this.full.delete(existing.id);
            this.assets.delete(existing.id);
            if (this.app.audio.asset?.rec?.id === existing.id) this.app.audio.close();
          } else replaceFailed = true;
        }
        if (host) { // (made from the page-layout window: it stays as it is)
          this.list.unshift(rec);
          this.renderList();
          host.done(rec);
          return;
        }
        closeDialog();
        this.stopPicking();
        this.list.unshift(rec);
        this.selectedId = rec.id;
        this.unselectedRanges.clear();
        this.unselectAnchor = null;
        this.renderList();
        this.renderSpots();
        try {
          const full = await this.loadFull(rec.id);
          this.selectedRec = full;
          this.framedRec = full;
          this.updateRecordingFrame();
          const firstView = this.app.views.find((view) => view.book.slug === full.book && view.page.path === full.path);
          const firstRange = firstView && this.resolve(firstView, full).find((range) => range);
          if (firstView && firstRange) this.app.reveal(firstView, { mode: 'sentence', a: firstRange.a, b: firstRange.b }, true);
        } catch (err) {
          console.warn('The new audio was created, but its page frame could not be drawn:', err);
        }
        if (existing) {
          toast(replaced ? 'Audio updated; the previous recording was replaced.' : replaceFailed
            ? 'The new audio is ready, but the previous recording could not be removed. Both are kept.'
            : 'The new audio is ready; the previous recording is still available.');
          return;
        }
        toast(`Audio “${rec.title}” is ready. Play it from the icon next to the paragraph.`);
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        bar.hidden = true;
        status.hidden = true;
      } finally {
        generating = false;
        syncCreateState();
      }
    });

    const form = (...parts) => el('div', { class: 'rec-form' }, ...parts);
    (host ? (title_, body) => host.show(body) : openDialog)(existing ? 'Edit existing audio' : 'New audio', form(
      field('Title', title),
      sentenceEditor,
      field('Read', languageMode),
      el('label', { class: 'check' }, twoSpeakers, 'Use two speaker voices for conversations'),
      englishField, speakerBField, chineseField, chineseBField,
      speakerHint,
      trField, trVoiceField,
      field('Speed ', rate, rateOut),
      field('Pause between sentences ', gap, gapOut),
      existing ? el('label', { class: 'check' }, replaceOld, 'Replace the old audio after the new version is ready (if creation fails, the old one stays)') : null,
      summary, error, voiceSource, useOffline, bar, status,
      el('div', { class: 'rec-buttons' }, cancel, create)), null, { keep: true });
    title.focus();
    title.select();
  }

  /** Ask the server to make the MP3 and wait for it. progress(done, total). */
  async create(body, progress) {
    const r = await fetch('/api/recordings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).catch(() => null);
    if (!r) throw new Error('The app server is not running. Start the app again with the .bat file.');
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'The audio could not be created.');
    for (;;) {
      await new Promise((ok) => setTimeout(ok, 500));
      const j = await fetch(`/api/jobs/${data.job}`, { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
      if (!j) throw new Error('The app server stopped while creating the audio.');
      progress(j.done || 0, j.total || body.sentences.length);
      if (j.state === 'done') return j.recording;
      if (j.state !== 'running') throw new Error(j.error || 'The audio could not be created.');
    }
  }
}

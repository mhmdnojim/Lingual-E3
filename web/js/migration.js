// Guided content migration. Uploaded programs are inventoried, never run in the browser.
import { el } from './util.js';

const ACTIVE = new Set(['analyzing', 'sampling', 'converting']);
const RETRYABLE = new Set(['error', 'interrupted', 'cancelled']);
const LABELS = ['Upload files', 'Inspect the old app', 'Choose content', 'Review sample pages', 'Convert selected content', 'Open or export'];
const bytes = (n = 0) => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;
const sourceName = (file) => file.webkitRelativePath || file.name;

async function request(method, url, body) {
  const response = await fetch(url, {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || (response.status === 404
    ? 'The importer is not available on this server yet. Restart the app server after installing this update.'
    : `The request failed (${response.status}).`));
  return data;
}

export class MigrationAssistant {
  constructor(app, library) {
    this.app = app;
    this.library = library;
    this.session = 0;
    this.dialog = el('dialog', { class: 'dialog migration-dialog', 'aria-labelledby': 'migration-title' });
    this.dialog.addEventListener('close', () => {
      ++this.session;
      clearTimeout(this.poll);
      this.xhr?.abort();
      this.xhr = null;
      this.busy = false;
    });
    document.body.append(this.dialog);
  }

  open() {
    if (this.dialog.open) return;
    this.dialog.showModal();
    this.home();
  }

  alive(session) { return this.dialog.open && this.session === session; }
  url(suffix = '') { return `/api/migrations/${encodeURIComponent(this.job.id)}${suffix}`; }

  shell(title) {
    clearTimeout(this.poll);
    this.dialog.replaceChildren(
      el('div', { class: 'dialog-head' }, el('h2', { id: 'migration-title' }, title),
        el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close importer', onclick: () => this.dialog.close() }, '\u00d7')),
      this.body = el('div', { class: 'migration-body' }));
    this.message = el('p', { class: 'form-msg', role: 'alert' });
  }

  async home() {
    const session = ++this.session;
    this.job = null;
    this.busy = false;
    this.shell('Import an old app');
    const title = el('input', { class: 'input', type: 'text', maxlength: 120, placeholder: 'For example: American English File Level 2', required: true });
    const picker = this.sourcePicker();
    const submit = el('button', { class: 'btn primary', type: 'submit' }, '1. Upload and inspect');
    const form = el('form', { class: 'lib-form migration-form' },
      el('p', {}, 'Bring the books from your old app into Lingua Books. Choose a ZIP or a folder, inspect what was found, then review sample pages before converting.'),
      el('p', { class: 'hint' }, 'Supports recognized iTools book assets, PDFs and page images. Other application code and unsupported formats are listed in the report; they are not rebuilt automatically. No coding editor or AI key is needed for supported formats.'),
      el('label', { class: 'field' }, el('span', {}, 'Import name'), title), picker.node,
      this.message, el('div', { class: 'form-buttons' }, submit));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (this.busy) return;
      const files = picker.files();
      if (!files.length) { this.message.textContent = 'Choose a ZIP or the old app folder first.'; return; }
      if (!title.value.trim()) { title.focus(); return; }
      this.busy = true;
      submit.disabled = true;
      this.message.textContent = '';
      try {
        const job = await request('POST', '/api/migrations', { title: title.value.trim(), input: picker.kind(),
          expectedFiles: files.length, expectedBytes: files.reduce((total, file) => total + file.size, 0) });
        if (!this.alive(session)) return;
        this.busy = false;
        this.showJob(job);
        await this.uploadFiles(files);
      } catch (error) {
        if (this.alive(session)) { this.message.textContent = error.message; this.busy = false; submit.disabled = false; }
      }
    });
    const jobs = el('div', { class: 'migration-jobs' }, el('p', { class: 'hint' }, 'Loading previous imports...'));
    this.body.append(form, jobs);
    try {
      const data = await request('GET', '/api/migrations');
      if (!this.alive(session)) return;
      const list = Array.isArray(data) ? data : data.jobs || [];
      jobs.replaceChildren(el('h3', {}, 'Previous imports'));
      if (!list.length) jobs.append(el('p', { class: 'hint' }, 'Your imports will appear here so you can continue later.'));
      for (const job of list) jobs.append(el('button', { class: 'migration-job', type: 'button', onclick: () => this.loadJob(job.id) },
        el('span', {}, job.title || 'Untitled import'), el('span', { class: 'badge' }, job.state || 'Saved')));
    } catch (error) { if (this.alive(session)) jobs.replaceChildren(el('p', { class: 'form-msg' }, error.message)); }
  }

  sourcePicker(input = 'zip') {
    let kind = input;
    const zip = el('input', { type: 'file', accept: '.zip,application/zip', 'aria-label': 'Old app ZIP file' });
    const folder = el('input', { type: 'file', webkitdirectory: true, multiple: true, 'aria-label': 'Old app folder' });
    const note = el('p', { class: 'hint' });
    const zipRow = el('label', { class: 'field' }, el('span', {}, 'ZIP file'), zip);
    const folderRow = el('label', { class: 'field' }, el('span', {}, 'Folder and its contents'), folder);
    const buttons = ['zip', 'folder'].map((value) => el('button', { class: 'btn', type: 'button',
      onclick: () => { kind = value; sync(); } }, value === 'zip' ? 'Upload ZIP' : 'Choose folder'));
    const files = () => [...(kind === 'zip' ? zip.files : folder.files)];
    const sync = () => {
      zipRow.hidden = kind !== 'zip';
      folderRow.hidden = kind !== 'folder';
      buttons.forEach((button, i) => button.setAttribute('aria-pressed', String(kind === (i ? 'folder' : 'zip'))));
      const chosen = files();
      note.textContent = chosen.length ? `${chosen.length} file${chosen.length === 1 ? '' : 's'} selected · ${bytes(chosen.reduce((sum, file) => sum + file.size, 0))}`
        : 'Choose files on your computer. A typed folder path cannot be uploaded by the browser.';
    };
    zip.addEventListener('change', sync);
    folder.addEventListener('change', sync);
    sync();
    return { node: el('div', { class: 'migration-source' }, el('div', { class: 'migration-actions' }, ...buttons), zipRow, folderRow, note), files, kind: () => kind };
  }

  async loadJob(id) {
    if (this.busy) return;
    const session = ++this.session;
    this.message.textContent = 'Opening import...';
    try {
      const job = await request('GET', `/api/migrations/${encodeURIComponent(id)}`);
      if (this.alive(session)) this.showJob(job);
    } catch (error) { if (this.alive(session)) this.message.textContent = error.message; }
  }

  showJob(job) {
    ++this.session;
    this.job = job;
    this.busy = false;
    this.shell(job.title || 'Import old app');
    this.progress = el('div', { class: 'migration-progress' });
    this.content = el('div', { class: 'migration-content' });
    this.back = el('button', { class: 'btn', type: 'button', onclick: () => this.home() }, 'All imports');
    this.cancel = el('button', { class: 'btn', type: 'button', onclick: () => this.cancelJob() }, 'Cancel process');
    this.discard = el('button', { class: 'btn danger-btn', type: 'button', onclick: () => this.discardJob() }, 'Remove import files');
    this.body.append(this.progress, this.message, this.content,
      el('div', { class: 'migration-actions migration-footer' }, this.back, this.cancel, this.discard),
      el('p', { class: 'hint' }, 'You can close this window while processing. Reopen Import old app to continue. Closing during an upload pauses the upload; select the same source again to resume.'));
    this.stageKey = '';
    this.update(job);
  }

  update(job) {
    this.job = job;
    this.renderProgress();
    this.back.disabled = this.busy;
    this.discard.hidden = ACTIVE.has(job.state);
    this.discard.disabled = this.busy;
    this.cancel.hidden = job.state === 'ready' || job.state === 'cancelled';
    const key = `${job.state}:${job.sample?.token || ''}:${job.phase || ''}`;
    if (key !== this.stageKey) {
      this.stageKey = key;
      this.renderStage();
    }
    this.schedulePoll();
  }

  renderProgress(upload) {
    const job = this.job;
    const steps = job.steps?.length ? job.steps : LABELS.map((label, i) => ({ number: i + 1, label, state: i ? 'pending' : 'active' }));
    const complete = (step) => ['done', 'complete', 'completed', 'ready'].includes(step.state);
    const fraction = (step) => complete(step) ? 1 : step.total > 0 ? Math.min(1, (step.done || 0) / step.total) : 0;
    const overall = Math.round(100 * steps.reduce((sum, step, i) => sum + (upload && i === 0
      ? (upload.total ? Math.min(1, upload.done / upload.total) : 0) : fraction(step)), 0) / steps.length);
    this.progress.replaceChildren(el('div', { class: 'migration-total' }, el('strong', {}, `Overall progress · ${overall}%`),
      el('progress', { max: 100, value: overall, 'aria-label': 'Overall import progress' })),
      el('ol', { class: 'migration-steps' }, ...steps.map((step, i) => {
        const isUpload = upload && i === 0;
        const active = isUpload || ['active', 'running', 'working'].includes(step.state);
        const count = isUpload ? `${bytes(upload.done)} / ${bytes(upload.total)}` : step.total ? `${step.done || 0} / ${step.total}` : '';
        return el('li', { class: `migration-step ${complete(step) ? 'done' : active ? 'active' : ''}` },
          el('span', { class: 'migration-step-number' }, String(step.number || i + 1)),
          el('div', {}, el('div', { class: 'migration-step-label' }, el('strong', {}, step.label || LABELS[i] || `Step ${i + 1}`), el('span', {}, count)),
            el('progress', { max: 1, value: isUpload ? (upload.total ? upload.done / upload.total : 0) : active && !step.total ? undefined : fraction(step), 'aria-label': step.label || `Step ${i + 1}` }),
            el('small', {}, isUpload ? upload.message : step.message || step.state || 'Waiting')));
      })));
  }

  schedulePoll() {
    clearTimeout(this.poll);
    if (!ACTIVE.has(this.job.state) || this.busy) return;
    const session = this.session;
    const url = this.url();
    this.poll = setTimeout(async () => {
      if (!this.alive(session)) return;
      try {
        const job = await request('GET', url);
        if (this.alive(session)) { this.message.textContent = ''; this.update(job); }
      } catch (error) {
        if (this.alive(session)) { this.message.textContent = `${error.message} Retrying status...`; this.schedulePoll(); }
      }
    }, 1100);
  }

  async uploadFiles(files) {
    const session = this.session;
    const url = this.url('/source');
    this.busy = true;
    this.back.disabled = true;
    this.discard.disabled = true;
    this.content.replaceChildren(el('p', {}, 'Uploading the source. Each file keeps its original folder name.'));
    this.message.textContent = '';
    const total = files.reduce((sum, file) => sum + file.size, 0);
    let completed = 0;
    try {
      // Going on with an upload: the files the server has already (the same name and size) are not sent again.
      const have = (await request('GET', url).catch(() => null))?.files || {};
      const todo = files.filter((file) => {
        if (have[sourceName(file)] !== file.size) return true;
        completed += file.size;
        return false;
      });
      const before = files.length - todo.length;
      if (before) this.content.replaceChildren(el('p', {}, `${before.toLocaleString()} files were received before; the other ${todo.length.toLocaleString()} are sent now.`));
      for (let i = 0; i < todo.length; i++) {
        if (!this.alive(session)) return;
        const file = todo[i];
        const progress = (sent, note = '') => this.renderProgress({ done: completed + sent, total,
          message: `File ${(before + i + 1).toLocaleString()} of ${files.length.toLocaleString()}: ${sourceName(file)} (${bytes(sent)} / ${bytes(file.size)})${note}` });
        // A file that fails for a moment (the connection, a file kept busy on the server) is sent again, a few times.
        for (let attempt = 1; ; attempt++) {
          progress(0, attempt > 1 ? ` — trying again (${attempt})` : '');
          try {
            await this.sendFile(url, file, session, progress);
            break;
          } catch (error) {
            if (!error.retry || attempt >= 6 || !this.alive(session)) throw error;
            await new Promise((ok) => setTimeout(ok, 500 * 2 ** (attempt - 1)));
          }
        }
        completed += file.size;
      }
      if (!this.alive(session)) return;
      this.xhr = null;
      this.busy = false;
      await this.command('analyze', {});
    } catch (error) {
      if (!this.alive(session)) return;
      this.xhr = null;
      this.busy = false;
      this.back.disabled = false;
      this.discard.disabled = false;
      this.message.textContent = error.message;
      this.renderStage();
    }
  }

  /** Send one file of the upload; a failure says whether sending it again may work (error.retry). */
  sendFile(url, file, session, progress) {
    return new Promise((resolve, reject) => {
      const fail = (message, retry) => reject(Object.assign(new Error(message), { retry }));
      const xhr = this.xhr = new XMLHttpRequest();
      xhr.open('PUT', `${url}?name=${encodeURIComponent(sourceName(file))}`);
      xhr.upload.onprogress = (event) => { if (this.alive(session)) progress(event.loaded); };
      xhr.onload = () => {
        let result = {};
        try { result = JSON.parse(xhr.responseText); } catch { /* Show HTTP status for a proxy response. */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(result);
        else fail(result.error || (xhr.status === 413 ? 'This upload exceeds the server size limit. Choose a smaller source.' : `Upload failed (${xhr.status}).`), xhr.status >= 500);
      };
      xhr.onerror = () => fail('The upload was interrupted. Select the same files below to go on: the files received are not sent again.', true);
      xhr.onabort = () => fail('Upload paused. Select the same files to continue.', false);
      xhr.send(file);
    });
  }

  async command(action, data) {
    if (this.busy) return;
    const session = this.session;
    this.busy = true;
    this.back.disabled = true;
    this.discard.disabled = true;
    this.message.textContent = '';
    const controls = [...this.content.querySelectorAll('button, input, select, textarea')].map((node) => [node, node.disabled]);
    controls.forEach(([node]) => { node.disabled = true; });
    try {
      const job = await request('POST', this.url(`/${action}`), data);
      if (!this.alive(session)) return;
      this.busy = false;
      this.stageKey = '';
      this.update(job);
    } catch (error) {
      if (!this.alive(session)) return;
      this.busy = false;
      this.back.disabled = false;
      this.discard.disabled = false;
      this.message.textContent = error.message;
      controls.forEach(([node, disabled]) => { node.disabled = disabled; });
    }
  }

  async cancelJob() {
    ++this.session;
    clearTimeout(this.poll);
    this.xhr?.abort();
    this.xhr = null;
    this.busy = false;
    await this.command('cancel', {});
  }

  async discardJob() {
    if (this.busy || !confirm('Remove this import\'s uploaded files, previews, export and unfinished imported books? Completed library books and your original folder are kept. Import progress cannot be recovered.')) return;
    const session = this.session;
    this.busy = true;
    this.discard.disabled = this.back.disabled = this.cancel.disabled = true;
    try {
      await request('POST', this.url('/discard'), {});
      if (this.alive(session)) this.home();
    } catch (error) {
      if (this.alive(session)) {
        this.busy = false;
        this.discard.disabled = this.back.disabled = this.cancel.disabled = false;
        this.message.textContent = error.message;
      }
    }
  }

  renderStage() {
    const job = this.job;
    this.content.replaceChildren();
    if (job.warnings?.length) this.content.append(el('details', { class: 'migration-findings' },
      el('summary', {}, `Findings and limitations (${job.warnings.length})`),
      el('ul', {}, ...job.warnings.map((warning) => el('li', {}, typeof warning === 'string' ? warning : warning.message || JSON.stringify(warning))))));
    if (job.state === 'upload') {
      const picker = this.sourcePicker(job.input || 'zip');
      this.content.append(el('p', {}, job.upload?.files ? `${job.upload.files} file(s) already received. Select the same ZIP or folder to finish uploading.` : 'Choose the source files to upload.'),
        picker.node, el('button', { class: 'btn primary', type: 'button', onclick: () => {
          const files = picker.files();
          if (!files.length) { this.message.textContent = 'Choose the source files first.'; return; }
          this.uploadFiles(files);
        } }, 'Continue upload'));
      return;
    }
    if (ACTIVE.has(job.state)) {
      this.content.append(el('p', { role: 'status' }, job.state === 'analyzing' ? 'Inspecting the files and finding supported books...' : job.state === 'sampling' ? 'Preparing sample pages for your review...' : 'Converting your chosen content into library books...'));
      return;
    }
    if (job.state === 'ready') {
      this.content.append(el('h3', {}, 'Your books are ready'),
        el('p', {}, 'Open a book to use the reader, sentence editing and audio tools. Voice generation is available from the reader settings.'),
        el('div', { class: 'migration-results' }, ...(job.results || []).map((result) => el('button', { class: 'btn', type: 'button', onclick: () => {
          this.dialog.close();
          this.app.go(result.id, '1');
        } }, `Open ${result.title || 'book'}`))),
        el('div', { class: 'migration-actions' }, el('a', { class: 'btn primary', href: this.url('/export'), download: '' }, 'Export converted books (ZIP)'),
          el('a', { class: 'btn', href: this.url('/report'), download: '' }, 'Download import report')));
      this.library.setScope('mine');
      return;
    }
    if (RETRYABLE.has(job.state)) {
      this.content.append(el('p', { class: 'form-msg' }, job.error || `This import is ${job.state}. Its source and finished work are saved.`));
      const action = job.phase || (job.sample?.token ? 'convert' : job.candidates?.length ? 'sample' : 'analyze');
      this.content.append(el('button', { class: 'btn', type: 'button', onclick: () => this.command(action,
        { selected: job.selected || [], options: job.options || {}, ...(action === 'convert' ? { approved: true, sampleToken: job.sample?.token } : {}) }) }, `Retry ${action}`));
      if (!job.candidates?.length) return;
    }
    this.renderReview();
  }

  renderReview() {
    const job = this.job;
    const candidates = job.candidates || [];
    if (!candidates.length) {
      this.content.append(el('h3', {}, 'No supported books found'),
        el('p', {}, 'This app needs a format-specific converter. You can still import its PDF books or page images using Add a book.'),
        el('a', { class: 'btn', href: this.url('/report'), download: '' }, 'Download file report'));
      return;
    }
    const selected = new Set(job.selected?.length ? job.selected : candidates.map((candidate) => candidate.id));
    const options = this.library.pageQuestions('pdf', job.options || {}, true);
    const preserveMedia = el('input', { type: 'checkbox', checked: job.options?.preserveMedia !== false });
    const checks = candidates.map((candidate) => {
      const input = el('input', { type: 'checkbox', checked: selected.has(candidate.id), value: candidate.id });
      return { candidate, input, row: el('label', { class: 'migration-candidate' }, input,
        el('span', {}, el('strong', {}, candidate.title), el('small', {}, `${candidate.kind} · ${candidate.pageCount ? `${candidate.pageCount} pages` : 'page count determined during inspection'}`))) };
    });
    const payload = () => ({ selected: checks.filter(({ input }) => input.checked).map(({ candidate }) => candidate.id),
      options: { ...options.value(), preserveMedia: preserveMedia.checked } });
    const reviewSignature = JSON.stringify(payload());
    const dirtyNote = el('p', { class: 'hint', hidden: true }, 'Your settings changed. Generate new sample pages to review these changes before converting.');
    const sampleButton = el('button', { class: 'btn', type: 'button', onclick: () => {
      const value = payload();
      if (!value.selected.length) { this.message.textContent = 'Select at least one book or set of pages.'; return; }
      this.command('sample', value);
    } }, job.sample?.token ? 'Regenerate sample pages' : 'Generate sample pages');
    const approve = el('input', { type: 'checkbox' });
    const convert = el('button', { class: 'btn primary', type: 'button', disabled: true, onclick: () => this.command('convert', {
      ...payload(), approved: true, sampleToken: job.sample.token,
    }) }, 'Convert selected books');
    const form = el('div', { class: 'migration-review' }, el('h3', {}, 'Choose what to import'),
      el('div', { class: 'migration-candidates' }, ...checks.map(({ row }) => row)),
      el('details', { open: !job.sample?.token }, el('summary', {}, 'Page language and extraction settings'), options.node,
        el('label', { class: 'check' }, preserveMedia, ' Include supported original audio, video and page links')),
      el('p', { class: 'hint' }, 'Review 1–5 sample pages before the full conversion. Chinese books keep Chinese characters and English; detected pinyin is excluded.'),
      dirtyNote, el('div', { class: 'migration-actions' }, sampleButton));
    const sync = () => {
      const dirty = reviewSignature !== JSON.stringify(payload());
      dirtyNote.hidden = !dirty || !job.sample?.token;
      if (dirty) approve.checked = false;
      convert.disabled = dirty || !approve.checked || !job.sample?.token || !payload().selected.length;
    };
    form.addEventListener('change', sync);
    form.addEventListener('input', sync);
    this.content.append(form);
    if (job.sample?.pages?.length) {
      const samples = el('div', { class: 'migration-samples' }, el('h3', {}, 'Check the sample pages'));
      for (const page of job.sample.pages) {
        const text = page.text || (Array.isArray(page.words) ? page.words : []).map((word) => word.t || word.text || '').join(' ');
        samples.append(el('article', { class: 'migration-sample' },
          el('h4', {}, `${page.title || 'Book'} · page ${page.page}`),
          page.image ? el('img', { src: page.image, alt: `Sample page ${page.page}`, loading: 'lazy' }) : null,
          el('label', { class: 'field' }, el('span', {}, 'Extracted text'), el('textarea', { class: 'input', rows: 7, readonly: true }, text)),
          page.how ? el('p', { class: 'hint' }, page.how) : null));
      }
      this.content.append(samples, el('p', { class: 'hint' }, 'If the sample needs changes, adjust the language, page range or text corrections above and regenerate it. Individual sentences can also be edited after import.'),
        el('label', { class: 'check' }, approve, ' I reviewed the sample pages and want to convert the selected books.'),
        el('div', { class: 'migration-actions' }, convert));
      approve.addEventListener('change', sync);
    }
  }
}

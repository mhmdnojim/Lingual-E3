// ElevenLabs Conversational AI for Lingua Books.
//
// The browser never receives an ElevenLabs API key. It asks /api/assistant-token
// for a short-lived conversation token, then starts the public SDK session. The
// client-tool names below are also the exact names to register on the agent:
//   navigate_to_section({ section: string })
//   focus_sentence({ index: number })
//   get_lesson_context({})

import { $, el, icon, toast } from './util.js';

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@elevenlabs/client/+esm';

let sdk;
async function conversationClass() {
  if (!sdk) {
    const module = await import(SDK_URL);
    sdk = module.Conversation || module.default?.Conversation || module.default;
  }
  if (!sdk?.startSession) throw new Error('The ElevenLabs browser library could not be loaded.');
  return sdk;
}

const textOf = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

export class Assistant {
  constructor(app) {
    this.app = app;
    this.session = null;
    this.open = false;
    this.busy = false;
    this.bind();
  }

  bind() {
    const pop = $('#assistant-pop'), button = $('#btn-assistant');
    if (!pop || !button) return;
    const place = () => {
      const r = button.getBoundingClientRect();
      pop.style.left = `${Math.max(8, Math.min(innerWidth - 360, r.right - 350))}px`;
    };
    const setOpen = (open) => {
      this.open = open;
      pop.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
      if (open) place();
    };
    button.addEventListener('click', (e) => { e.stopPropagation(); setOpen(!this.open); });
    document.addEventListener('click', (e) => { if (this.open && !pop.contains(e.target) && e.target !== button) setOpen(false); });
    window.addEventListener('resize', () => { if (this.open) place(); });
    $('#assistant-start').addEventListener('click', () => this.start());
    $('#assistant-stop').addEventListener('click', () => this.stop());
    this.setStatus('Ready. Press Start conversation and allow microphone access.');
    this.renderButtons();
  }

  setStatus(message, error = false) {
    const node = $('#assistant-status');
    if (!node) return;
    node.textContent = message || '';
    node.classList.toggle('err', error);
  }

  renderButtons() {
    const start = $('#assistant-start'), stop = $('#assistant-stop');
    if (start) start.hidden = this.busy;
    if (stop) stop.hidden = !this.busy;
    $('#btn-assistant')?.classList.toggle('active', this.busy);
  }

  addMessage(source, message) {
    const box = $('#assistant-messages');
    const text = textOf(message);
    if (!box || !text) return;
    const label = source === 'user' ? 'You' : 'Tutor';
    box.append(el('div', { class: `assistant-message ${source === 'user' ? 'user' : 'agent'}` },
      el('b', {}, label), el('span', {}, text)));
    box.scrollTop = box.scrollHeight;
  }

  context() {
    const app = this.app;
    const view = app.reader?.active?.view || app.views?.find((v) => v.text && !v.text.empty);
    const unit = app.reader?.active?.unit;
    const sentence = view?.text && unit ? view.text.text(unit.a, unit.b) : '';
    const page = app.group?.length ? app.book?.pages?.[app.group[0]] : app.book?.pages?.[app.idx];
    return {
      current_book: textOf(app.book?.title || ''),
      current_page: textOf(page?.n || ''),
      total_pages: textOf(app.book?.pages?.length || ''),
      current_sentence: textOf(sentence).slice(0, 1200),
      reading_mode: textOf(app.mode || 'sentence'),
      language: textOf(app.book?.language || 'English'),
    };
  }

  async getToken() {
    const response = await fetch('/api/assistant-token', { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'The conversation assistant is not available.');
    return data;
  }

  async start() {
    if (this.busy) return;
    this.busy = true;
    this.renderButtons();
    this.setStatus('Connecting…');
    try {
      const [credentials, Conversation] = await Promise.all([this.getToken(), conversationClass()]);
      const options = {
        dynamicVariables: this.context(),
        clientTools: {
          navigate_to_section: async (parameters) => this.navigate(parameters),
          focus_sentence: async (parameters) => this.focusSentence(parameters),
          get_lesson_context: async () => this.context(),
        },
        onConnect: () => this.setStatus('Connected. Speak naturally.'),
        onDisconnect: () => {
          this.session = null;
          this.busy = false;
          this.renderButtons();
          this.setStatus('Conversation ended.');
        },
        onError: (message) => this.setStatus(textOf(message) || 'The conversation ended with an error.', true),
        onMessage: (message) => this.addMessage(message?.source, message?.message ?? message?.text ?? message),
        onModeChange: ({ mode } = {}) => { if (mode) this.setStatus(mode === 'speaking' ? 'Tutor is speaking…' : 'Listening…'); },
      };
      if (credentials.conversationToken) options.conversationToken = credentials.conversationToken;
      else options.agentId = credentials.agentId;
      this.session = await Conversation.startSession(options);
    } catch (error) {
      this.busy = false;
      this.renderButtons();
      this.setStatus(error.message || 'Could not start the conversation.', true);
      toast(error.message || 'Could not start the conversation.');
    }
  }

  async stop() {
    const session = this.session;
    this.session = null;
    this.busy = false;
    this.renderButtons();
    try { await session?.endSession?.(); } catch { /* already disconnected */ }
    this.setStatus('Conversation ended.');
  }

  navigate(parameters = {}) {
    const section = textOf(parameters.section).toLowerCase().replace(/[ -]+/g, '_');
    const panel = { text: 'text', script: 'listen', search: 'search', my_audio: 'audio' };
    if (section === 'library' || section === 'courses' || section === 'my_books') {
      this.app.goHome();
      return { ok: true, section: 'library' };
    }
    if (section === 'pages') {
      this.app.setDrawer(true);
      return { ok: true, section };
    }
    if (panel[section]) {
      this.app.setPanelOpen(true);
      this.app.showTab(panel[section]);
      return { ok: true, section };
    }
    if (section === 'voice' || section === 'translation' || section === 'follow') {
      this.app.openSettings(section);
      return { ok: true, section };
    }
    return { ok: false, error: 'Unknown section. Use library, pages, text, script, search, my_audio, voice, translation, or follow.' };
  }

  focusSentence(parameters = {}) {
    const index = Number(parameters.index);
    if (!Number.isInteger(index) || index < 1) return { ok: false, error: 'index must be a positive sentence number.' };
    const view = this.app.views?.find((v) => v.text?.sent?.[index - 1]);
    if (!view) return { ok: false, error: `Sentence ${index} is not on the current page.` };
    const unit = view.text.sentenceUnit(index - 1);
    view.showActive(unit);
    this.app.follower.reading(view, unit, true);
    this.app.markPanel('active', view, unit);
    return { ok: true, index, text: view.text.text(unit.a, unit.b) };
  }
}

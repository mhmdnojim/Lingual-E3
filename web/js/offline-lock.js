/**
 * Offline use of the website (web/sw.js caches the app and the books opened), and its time limit:
 * every time the server is reached, /api/me says until when this device may stay offline
 * (offline.until: the plan's offline time from now). Without the server, the app goes on until
 * then; after it — or when the device's clock was moved back — the whole app locks ("Connect to
 * the internet to continue") until the server is reached again. Admins get the default time.
 * An account whose "Offline use" an admin switched off gets nothing cached.
 */
import { $, el, store } from './util.js';

const EVERY = 60000;

export const offlineLock = {
  app: null,
  enabled: false,
  locked: false,
  timer: null,

  start(app) {
    this.app = app;
    window.aef && (window.aef.offlineLock = this);
    this.apply(app.me);
    this.timer = setInterval(() => this.tick(), EVERY);
    window.addEventListener('online', () => this.tick());
    window.addEventListener('offline', () => this.tick());
    this.tick();
  },

  /** The server's answer (/api/me): the lease kept, the service worker registered or taken away. */
  apply(me) {
    this.enabled = Boolean(me?.mode === 'public' && me.user && me.features?.offline !== false);
    if (me?.offline && me.user) {
      store.set('lease', { until: me.offline.until, minutes: me.offline.minutes, serverTime: me.serverTime, at: Math.floor(Date.now() / 1000) });
    } else if (me && me.mode === 'public' && !me.user) {
      store.set('lease', null);
    }
    this.register(this.enabled);
  },

  register(on) {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    if (on) {
      navigator.serviceWorker.register('/web/sw.js', { scope: '/web/' }).catch(() => {});
    } else {
      navigator.serviceWorker.getRegistrations().then((all) => all.forEach((r) => r.unregister())).catch(() => {});
      if (window.caches) caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
    }
  },

  /** Can the server be reached now? (/api/version is never cached.) */
  probe() {
    return fetch('/api/version', { cache: 'no-store' }).then((r) => r.ok).catch(() => false);
  },

  async tick() {
    if (this.app?.me?.student) return this.tickStudent();
    if (this.app?.me?.mode !== 'public') return;
    if (await this.probe()) {
      const me = await fetch('/api/me', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (me) {
        const was = this.app.me;
        this.app.me = me;
        this.apply(me);
        if (this.locked) {
          this.unlock();
          if ((was?.user?.id || 0) !== (me.user?.id || 0)) this.app.accountChanged?.(); // (logged out meanwhile: blocked, unlinked …)
        }
      }
      this.pill(null);
      return;
    }
    if (!this.app.me?.user) return; // (nobody logged in: nothing to lock)
    const lease = store.get('lease', null);
    const now = Math.floor(Date.now() / 1000);
    if (!lease) { this.lock('This device has not checked your account yet. Connect to the internet to continue.'); return; }
    if (now < lease.at - 120) { this.lock('The clock of this device was moved back. Connect to the internet to continue.'); return; }
    if (now > lease.until) { this.lock('The time the app may stay offline is over. Connect to the internet to continue.'); return; }
    this.pill(lease.until - now);
  },

  /** A student's computer (web/student.py): the local server keeps the lease and says when it is locked. */
  async tickStudent() {
    const me = await fetch('/api/me', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!me) return;
    const was = this.app.me;
    this.app.me = me;
    if (me.locked && me.user) this.lock(me.lockedWhy);
    else if (this.locked) { this.unlock(); if ((was?.user?.email || '') !== (me.user?.email || '')) this.app.accountChanged?.(); }
    if (me.user && !me.student.online && me.offline?.until) this.pill(me.offline.until - Math.floor(Date.now() / 1000));
    else this.pill(null);
  },

  lock(why) {
    this.app.assistant?.stop('Connect to the internet to continue.');
    this.locked = true;
    let box = $('#offline-lock');
    if (!box) {
      box = el('div', { class: 'offline-lock', id: 'offline-lock', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'offline-lock-title' });
      document.body.append(box);
    }
    const again = el('button', { class: 'btn primary', type: 'button' }, 'Try again');
    again.addEventListener('click', async () => {
      again.disabled = true;
      if (this.app?.me?.student) await fetch('/api/student/refresh', { method: 'POST' }).catch(() => {}); // (the local server asks the website now)
      await this.tick();
      again.disabled = false;
    });
    box.replaceChildren(el('div', { class: 'offline-lock-box' },
      el('h2', { id: 'offline-lock-title' }, 'Connect to the internet to continue'),
      el('p', {}, why),
      el('p', { class: 'hint' }, 'The app checks your account with the server, then opens again at once. Your books stay on this device.'),
      el('div', { class: 'form-buttons' }, again)));
    box.hidden = false;
    document.body.classList.add('offline-locked');
    try { window.speechSynthesis?.cancel(); } catch { /* no speech */ }
    document.querySelectorAll('audio, video').forEach((m) => m.pause());
    this.pill(null);
  },

  unlock() {
    this.locked = false;
    const box = $('#offline-lock');
    if (box) box.hidden = true;
    document.body.classList.remove('offline-locked');
  },

  /** A small sign while offline: how long the app still works. */
  pill(seconds) {
    let p = $('#offline-pill');
    if (seconds == null) { if (p) p.hidden = true; return; }
    if (!p) {
      p = el('div', { class: 'offline-pill', id: 'offline-pill', role: 'status' });
      document.body.append(p);
    }
    const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60);
    p.textContent = `Offline · works ${d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`} more`;
    p.hidden = false;
  },
};

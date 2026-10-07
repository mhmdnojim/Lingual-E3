// Following the reading: the sentence being read (or played from an MP3) stays in view — in the
// middle of the page by default — unless the person is looking somewhere else. While they scroll,
// swipe or zoom the page (or scroll the Text list), that area waits; it follows again a few
// seconds after they stop, or at once with "Back to the reading". A plain tap on a sentence does
// not count as looking elsewhere. Settings: the Follow tab of the settings box (and F, or the
// button in the reading bar, to switch it on and off).
import { $, store, toast } from './util.js';

export const followSettings = {
  on: store.get('follow.on', true),
  where: store.get('follow.where', 'center'), // center | top | edge (only when it leaves the screen)
  speed: store.get('follow.speed', 500),      // milliseconds of the scroll (0: jump at once)
  wait: store.get('follow.wait', 4),          // seconds after the person scrolled, before following again
  list: store.get('follow.list', true),       // keep it in the middle of the Text list too
};

export function setFollow(key, value) {
  followSettings[key] = value;
  store.set(`follow.${key}`, value);
}

const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);

/** A scrolling area (the page, or the Text list) that knows when the person moves it. */
class Area {
  constructor(el, onUser) {
    this.el = el;
    this.onUser = onUser;
    this.lastUser = 0;
    this.touching = false;
    this.ours = 0; // until this time, scroll events come from our own scrolling
    const user = () => this.user();
    el.addEventListener('wheel', user, { passive: true });
    el.addEventListener('touchstart', (e) => {
      this.touching = true;
      this.moved = false;
      this.tx = e.touches[0].clientX;
      this.ty = e.touches[0].clientY;
      if (e.touches.length > 1) this.user(); // two fingers: zooming
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      if (!this.moved && Math.hypot(t.clientX - this.tx, t.clientY - this.ty) > 10) this.moved = true;
      if (this.moved) this.user();
    }, { passive: true });
    const end = (e) => {
      if (e.touches.length) return;
      this.touching = false;
      if (this.moved) this.user();
    };
    el.addEventListener('touchend', end, { passive: true });
    el.addEventListener('touchcancel', end, { passive: true });
    // Scrolling by other means (the scroll bar, keys): a scroll right after the person pressed
    // something here. (Scrolls caused by the layout, e.g. the panel getting taller, do not count.)
    const input = () => { this.lastInput = Date.now(); };
    el.addEventListener('pointerdown', input, { passive: true });
    el.addEventListener('keydown', input);
    el.addEventListener('scroll', () => {
      if (!this.animating && Date.now() > this.ours && Date.now() - (this.lastInput || 0) < 1500) this.user();
    }, { passive: true });
  }

  user() {
    this.lastUser = Date.now();
    if (this.animating) { cancelAnimationFrame(this.raf); this.animating = false; } // the person wins
    this.onUser?.();
  }

  /** The person is looking around (scrolled less than `wait` seconds ago, or a finger is down). */
  busy() { return this.touching || Date.now() - this.lastUser < followSettings.wait * 1000; }

  /** Milliseconds until it may follow again. */
  waitLeft() { return Math.max(0, this.lastUser + followSettings.wait * 1000 - Date.now()); }

  scrollTo(top, left = this.el.scrollLeft, ms = followSettings.speed) {
    const el = this.el;
    cancelAnimationFrame(this.raf);
    const maxT = el.scrollHeight - el.clientHeight, maxL = el.scrollWidth - el.clientWidth;
    top = Math.max(0, Math.min(maxT, Math.round(top)));
    left = Math.max(0, Math.min(maxL, Math.round(left)));
    const t0 = el.scrollTop, l0 = el.scrollLeft;
    if (Math.abs(top - t0) < 2 && Math.abs(left - l0) < 2) return;
    if (!(ms > 0)) {
      this.ours = Date.now() + 150;
      el.scrollTop = top;
      el.scrollLeft = left;
      return;
    }
    this.animating = true;
    const start = performance.now();
    const step = (now) => {
      if (!this.animating) return;
      const p = Math.min(1, (now - start) / ms), k = ease(p);
      el.scrollTop = t0 + (top - t0) * k;
      el.scrollLeft = l0 + (left - l0) * k;
      if (p < 1) this.raf = requestAnimationFrame(step);
      else { this.animating = false; this.ours = Date.now() + 150; }
    };
    this.raf = requestAnimationFrame(step);
  }
}

export class Follower {
  constructor(app) {
    this.app = app;
    this.stage = new Area($('#stage'), () => this.userMoved());
    this.list = new Area($('#text-view').closest('.tab-body'));
    this.current = null; // {view, unit}: being read or played
    $('#follow-back').addEventListener('click', () => this.backToReading());
    $('#reading-follow').addEventListener('click', () => this.toggle());
    this.updateButtons();
  }

  // ---------- The sentence being read ----------

  /** A new sentence is being read (or played): keep it in view, unless the person looks elsewhere. */
  reading(view, unit, list = true) {
    this.current = { view, unit };
    if (!followSettings.on) return;
    if (this.stage.busy()) this.waitThenFollow();
    else this.placeOnPage(view, unit);
    if (list && followSettings.list && !this.list.busy()) this.app.centerPanel(view, unit);
  }

  /** Reading (or playing) has ended. */
  stopped() {
    this.current = null;
    clearTimeout(this.timer);
    $('#follow-back').hidden = true;
  }

  userMoved() {
    if (!this.current || !followSettings.on) return;
    if (!this.isShown()) { this.current = null; return; } // reading ended or another page
    this.waitThenFollow();
  }

  isShown() {
    const c = this.current;
    return !!c && this.app.views.includes(c.view) && (this.app.reader.busy || this.app.audio.open);
  }

  /** The person looks elsewhere: offer "Back to the reading", follow again after the wait. */
  waitThenFollow() {
    $('#follow-back').hidden = false;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.stage.busy()) { this.waitThenFollow(); return; }
      $('#follow-back').hidden = true;
      if (this.isShown()) this.placeOnPage(this.current.view, this.current.unit);
    }, this.stage.waitLeft() + 50);
  }

  backToReading() {
    this.stage.lastUser = 0;
    this.stage.touching = false;
    clearTimeout(this.timer);
    $('#follow-back').hidden = true;
    if (this.isShown()) {
      this.placeOnPage(this.current.view, this.current.unit, true);
      if (followSettings.list) this.app.centerPanel(this.current.view, this.current.unit);
    }
  }

  /** Scroll the page so the sentence is where the settings say (middle, near the top, or just in view). */
  placeOnPage(view, unit, force = false) {
    const st = this.stage.el;
    const box = view.unitBox(unit);
    if (!box) return;
    const pr = view.el.getBoundingClientRect(), sr = st.getBoundingClientRect();
    const top = pr.top - sr.top + st.scrollTop + box.y;
    const left = pr.left - sr.left + st.scrollLeft + box.x;
    // The reading bar covers the bottom of the page: the part above it is what can be seen.
    // (When reading starts, the bar appears a moment after the first sentence is placed.)
    const pill = $('#reading-pill');
    const covered = !pill ? 0 : !pill.hidden ? sr.bottom - pill.getBoundingClientRect().top + 8
      : this.app.reader.busy ? parseFloat(getComputedStyle(pill).bottom) + 44 + 8 : 0;
    const seen = Math.max(120, st.clientHeight - Math.max(0, covered));
    let y = st.scrollTop;
    const where = force && followSettings.where === 'edge' ? 'center' : followSettings.where;
    if (box.h > seen * 0.8) y = top - seen * 0.1; // taller than the screen: from its start
    else if (where === 'center') y = top + box.h / 2 - seen / 2;
    else if (where === 'top') y = top - seen * 0.18;
    else if (top < st.scrollTop + 20 || top + box.h > st.scrollTop + seen - 20) y = top - seen / 3;
    let x = st.scrollLeft;
    if (left < st.scrollLeft || left + Math.min(box.w, st.clientWidth) > st.scrollLeft + st.clientWidth) {
      x = box.w < st.clientWidth ? left + box.w / 2 - st.clientWidth / 2 : left - 20;
    }
    this.stage.scrollTo(y, x);
  }

  // ---------- Other scrolling of the app (search results, corrections) ----------

  /** Scroll the page so a unit is comfortably visible (center: in the upper middle). */
  reveal(view, unit, center = false) {
    const st = this.stage.el;
    const box = view.unitBox(unit);
    if (!box) return;
    const pr = view.el.getBoundingClientRect(), sr = st.getBoundingClientRect();
    const top = pr.top - sr.top + st.scrollTop + box.y;
    const left = pr.left - sr.left + st.scrollLeft + box.x;
    const out = top < st.scrollTop + 30 || top + box.h > st.scrollTop + st.clientHeight - 70;
    const x = left < st.scrollLeft || left + Math.min(box.w, st.clientWidth) > st.scrollLeft + st.clientWidth ? left - 40 : st.scrollLeft;
    this.stage.scrollTo(center || out ? top - st.clientHeight / 3 : st.scrollTop, x, 350);
  }

  /** Scroll the Text list (smooth: with the chosen speed). */
  listTo(top, smooth) { this.list.scrollTo(top, this.list.el.scrollLeft, smooth ? Math.max(200, followSettings.speed) : 0); }

  // ---------- Settings ----------

  toggle() {
    setFollow('on', !followSettings.on);
    this.updateButtons();
    this.app.syncFollowSettings?.();
    toast(followSettings.on ? 'Following the reading: the sentence being read stays in view.' : 'Not following the reading: the page stays where it is.');
    if (followSettings.on) this.backToReading();
    else { clearTimeout(this.timer); $('#follow-back').hidden = true; }
  }

  updateButtons() {
    const b = $('#reading-follow');
    b.setAttribute('aria-pressed', String(followSettings.on));
    b.title = followSettings.on ? 'Following the reading: click to stop (F)' : 'Not following the reading: click to follow it (F)';
    b.setAttribute('aria-label', b.title);
  }
}

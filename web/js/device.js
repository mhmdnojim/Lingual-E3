// The device the app is laid out for: a phone, a tablet or a computer — found by itself
// (Automatic), or chosen in the settings (the Screen tab, or at the bottom of the library).
// Automatic: a touch screen up to 700 px wide is a phone; a wider touch screen (an iPad, an
// Android tablet, a phone turned sideways) is a tablet; else a computer — and a computer's window
// made narrow gets the phone's layout too. It is set on <html> before the page is drawn:
// data-device="phone|tablet|computer", and data-touch when fingers are used (nothing hovers).
// A layout chosen by hand on a smaller screen draws the page wider, as a browser's "desktop site".
//
// Also here: what older phones' browsers lack (a few functions added), and a message when the app
// cannot start in a browser (too old for it).
//
// A plain script (not a module), loaded first in <head>; the app uses window.linguaDevice.
(function () {
  'use strict';
  var KEY = 'aef3.device'; // (util.js's store: "aef3." + key, JSON)
  var CHOICES = ['auto', 'phone', 'tablet', 'computer'];
  var NAMES = { auto: 'Automatic', phone: 'Phone', tablet: 'Tablet', computer: 'Computer' };
  var root = document.documentElement;
  var current = '', listeners = [];

  function mq(q) { return !!(window.matchMedia && window.matchMedia(q).matches); }

  function choice() {
    try {
      var v = JSON.parse(localStorage.getItem(KEY));
      return CHOICES.indexOf(v) >= 0 ? v : 'auto';
    } catch (e) { return 'auto'; }
  }

  /** Is the screen touched with fingers (no mouse or pen to point with)? */
  function touchScreen() {
    if (mq('(pointer: coarse)')) return true;
    if (mq('(pointer: fine)')) return false;
    return (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window; // (browsers without these media queries)
  }

  function landscape() {
    var o = window.screen && screen.orientation && screen.orientation.type;
    if (o) return o.indexOf('landscape') === 0;
    if (typeof window.orientation === 'number') return Math.abs(window.orientation) === 90; // (older iPhones)
    return window.innerWidth > window.innerHeight;
  }

  /** The width of the screen as it is held now, in CSS pixels (not the width the page is drawn at). */
  function screenWidth() {
    var s = window.screen, a = s && s.width || window.innerWidth, b = s && s.height || window.innerHeight;
    return landscape() ? Math.max(a, b) : Math.min(a, b);
  }

  /** What this device is, as Automatic finds it. */
  function detect() {
    if (touchScreen()) return screenWidth() <= 700 ? 'phone' : 'tablet';
    return (document.documentElement.clientWidth || window.innerWidth) <= 700 ? 'phone' : 'computer';
  }

  /** The page drawn wider than the screen for a layout chosen by hand (a computer's on a phone …). */
  function viewport(device, auto) {
    var meta = document.querySelector('meta[name=viewport]');
    if (!meta) return;
    var w = screenWidth(), width = 'device-width, initial-scale=1';
    if (!auto && touchScreen()) {
      if (device === 'computer' && w < 1000) width = '1200';
      else if (device === 'tablet' && w < 760) width = '820';
      else if (device === 'phone' && w > 700) width = '420';
    }
    var content = 'width=' + width + ', viewport-fit=cover';
    if (meta.getAttribute('content') !== content) meta.setAttribute('content', content);
  }

  function apply() {
    var c = choice(), device = c === 'auto' ? detect() : c;
    viewport(device, c === 'auto');
    if (c === 'auto') device = detect(); // (measured again in the page as drawn now)
    root.setAttribute('data-device', device);
    root.setAttribute('data-device-choice', c);
    // Fingers: a touch screen, or a phone's or tablet's layout chosen (a computer's narrow window: its mouse still hovers).
    if (touchScreen() || (c !== 'auto' && device !== 'computer')) root.setAttribute('data-touch', '');
    else root.removeAttribute('data-touch');
    if (device !== current) {
      current = device;
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](device); } catch (e) { setTimeout(function () { throw e; }); }
      }
    }
  }

  var pending = 0;
  function later() { // (once per frame while the window is resized or the phone turned)
    if (pending) return;
    pending = (window.requestAnimationFrame || setTimeout)(function () { pending = 0; apply(); });
  }
  window.addEventListener('resize', later);
  window.addEventListener('orientationchange', function () { setTimeout(apply, 250); });
  if (window.matchMedia) {
    var pointer = window.matchMedia('(pointer: coarse)');
    if (pointer.addEventListener) pointer.addEventListener('change', apply); // (a tablet's keyboard and trackpad taken off)
  }

  window.linguaDevice = {
    NAMES: NAMES,
    CHOICES: CHOICES,
    /** The layout now: 'phone', 'tablet' or 'computer'. */
    get: function () { return current; },
    isPhone: function () { return current === 'phone'; },
    /** What was chosen: 'auto' or a layout. */
    choice: choice,
    /** What Automatic finds this device to be. */
    detect: detect,
    set: function (c) {
      try { localStorage.setItem(KEY, JSON.stringify(CHOICES.indexOf(c) >= 0 ? c : 'auto')); } catch (e) { /* storage unavailable */ }
      apply();
    },
    /** fn(device) whenever the layout changes. */
    onChange: function (fn) { listeners.push(fn); },
  };
  apply();

  // ---------------------------------------------------------------- What older browsers lack

  function add(proto, name, fn) {
    if (!proto[name]) Object.defineProperty(proto, name, { value: fn, writable: true, configurable: true });
  }
  function at(n) { // Array and String .at() (Safari before 15.4, Chrome before 92)
    n = Math.trunc(n) || 0;
    if (n < 0) n += this.length;
    return n < 0 || n >= this.length ? undefined : this[n];
  }
  add(Array.prototype, 'at', at);
  add(String.prototype, 'at', at);
  add(Object, 'hasOwn', function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); });

  // ---------------------------------------------------------------- A browser too old for the app

  // The app (js/main.js, a module) sets window.aef when it has started. In a browser that cannot
  // run it (an iPhone before iOS 15.4, a browser not updated for years) the page would stay
  // empty: it says so instead.
  window.addEventListener('load', function () {
    if (!document.querySelector('script[type=module][src*="main.js"]')) return; // (another page)
    setTimeout(function () {
      if (window.aef || document.getElementById('too-old')) return;
      var box = document.createElement('div');
      box.id = 'too-old';
      box.setAttribute('role', 'alert');
      box.style.cssText = 'position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;'
        + 'padding:24px;background:#fff;color:#1f2430;font:17px/1.5 system-ui,sans-serif;text-align:center';
      box.innerHTML = '<div style="max-width:440px"><b>Lingua Books cannot start in this browser.</b><br>'
        + 'It is too old for the app. Update it, or open the app in another browser: on an iPhone or iPad, '
        + 'iOS 15.4 or newer (Settings → General → Software Update); on Android, Chrome; on a computer, '
        + 'Chrome, Edge, Firefox or Safari.</div>';
      document.body.appendChild(box);
    }, 12000);
  });
})();

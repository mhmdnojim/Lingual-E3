/*
 * The service worker of the website (js/offline-lock.js registers it when the account may use the
 * app offline): the app's own files and the books that were opened keep working without internet.
 *
 * - The app's files (/web/…): from the network when it is there (an update shows at once), else
 *   from the cache; the main ones are cached when the worker is installed.
 * - A book's pages and thumbnails (/lib/<id>/pages|thumbs/…): cached when first shown.
 * - Its text, its list of pages, the library's answers (/api/books…, /api/text/…, /api/me …): from
 *   the network when it is there, else the last answer.
 * - Its audio (/lib/<id>/migration-media/…mp3|wav|ogg|m4a): the whole file is fetched and cached
 *   the first time it is played, then served in pieces (Range) from the cache. Video: the network.
 * - /api/version is never cached: the app asks it to know whether the server can be reached.
 * - A message {type: 'clear'} empties every cache (offline use switched off for the account).
 */
const VERSION = 'lingua-books-1';
const SHELL = ['/web/', '/web/index.html', '/web/css/app.css', '/web/manifest.webmanifest',
  '/web/icons/icon.svg', '/web/icons/icon-180.png', '/web/icons/icon-192.png', '/web/icons/icon-512.png',
  '/web/fonts/AtkinsonHyperlegible-Regular.ttf', '/web/fonts/AtkinsonHyperlegible-Bold.ttf',
  ...['admin-services', 'admin-stats', 'admin-users', 'assistant', 'breakdown', 'designs', 'device', 'editor', 'follow', 'layout-ai', 'library', 'main',
    'media', 'migration', 'offline-audio', 'pagetext', 'pageview', 'pictures', 'plans', 'playbuttons', 'recordings', 'search', 'segment',
    'speech', 'transcription', 'translation', 'util', 'voice-options', 'words', 'offline-lock'].map((n) => `/web/js/${n}.js`)];
const AUDIO = /^\/lib\/L[0-9a-f]{10}\/migration-media\/[0-9a-f]{64}\.(?:mp3|wav|ogg|m4a)$/;
const PAGES = /^\/lib\/L[0-9a-f]{10}\/(?:pages|thumbs)\/\d{1,4}\.webp$/;
const API = /^\/api\/(?:me|books(?:\/L[0-9a-f]{10}(?:\/tracks)?)?|text\/L[0-9a-f]{10}\/p\d{1,4}|branches|tr-languages|transcript|plans|words|recordings|speech-ai|picture-ai|layout-ai)$/;
const MOST_AUDIO = 60 * 2 ** 20;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('message', (e) => {
  if (e.data?.type === 'clear') e.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))));
});

const cache = () => caches.open(VERSION);

/** From the network, the answer kept; without the network, the answer kept before (or `fallback`). */
async function networkFirst(req, fallback = null) {
  const c = await cache();
  try {
    const r = await fetch(req);
    if (r.ok) c.put(req, r.clone());
    return r;
  } catch {
    return (await c.match(req, { ignoreSearch: req.url.includes('/api/me') })) || fallback || Response.error();
  }
}

/** From the cache, else fetched and kept. */
async function cacheFirst(req) {
  const c = await cache();
  const kept = await c.match(req);
  if (kept) return kept;
  const r = await fetch(req);
  if (r.ok) c.put(req, r.clone());
  return r;
}

/** A piece of a cached file (Range), as the browser asks for sound. */
function slice(full, rangeHeader) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || '');
  return full.arrayBuffer().then((buf) => {
    if (!m) return new Response(buf, { status: 200, headers: { 'Content-Type': full.headers.get('Content-Type') || 'audio/mpeg', 'Content-Length': String(buf.byteLength), 'Accept-Ranges': 'bytes' } });
    const size = buf.byteLength;
    let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    return new Response(buf.slice(start, end + 1), { status: 206, headers: {
      'Content-Type': full.headers.get('Content-Type') || 'audio/mpeg', 'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' } });
  });
}

/** Audio: the whole file once, kept (when not too big), then its pieces from the cache. */
async function audio(req) {
  const c = await cache();
  const whole = new Request(req.url, { method: 'GET' });
  let full = await c.match(whole);
  if (!full) {
    const r = await fetch(whole);
    if (!r.ok) return r;
    const size = Number(r.headers.get('Content-Length') || 0);
    if (!size || size > MOST_AUDIO) return r;
    await c.put(whole, r.clone());
    full = r;
  }
  return slice(full, req.headers.get('Range'));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;
  if (p === '/api/version' || p.startsWith('/web/recordings/') || p.startsWith('/api/admin/')) return;
  if (req.mode === 'navigate' || p === '/web/' || p === '/web/index.html') {
    e.respondWith(networkFirst(new Request('/web/index.html', { cache: 'no-cache' })).then((r) => (r.ok ? r : caches.match('/web/index.html'))));
  } else if (PAGES.test(p)) {
    e.respondWith(cacheFirst(req));
  } else if (AUDIO.test(p)) {
    e.respondWith(audio(req));
  } else if (API.test(p)) {
    e.respondWith(networkFirst(req));
  } else if (p.startsWith('/web/')) {
    e.respondWith(networkFirst(req));
  }
});

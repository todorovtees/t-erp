// T-ERP service worker (spec §44-45 — PWA / offline).
//
// Strategy, deliberately split by request type:
//
//  - App shell (HTML/CSS/JS/icons): cache-first, so the app opens instantly
//    and still opens with no connection at all.
//  - Everything else (Supabase API, fonts CDN): network-only, never cached.
//    Serving stale stock levels or prices from a cache would be actively
//    dangerous in an ERP — a cashier could sell against numbers that were
//    true an hour ago. Offline sales are handled properly in POS via the
//    explicit queue in js/pages/pos.js, not by faking a cached response.
//
// Bump CACHE_VERSION whenever shell files change, so returning users pick
// up the new build instead of a stale cached one.

const CACHE_VERSION = 'terp-shell-v1';

const SHELL_FILES = [
  './',
  './index.html',
  './login.html',
  './pos.html',
  './inventory.html',
  './css/tokens.css',
  './css/app.css',
  './js/lib/supabaseClient.js',
  './js/lib/shell.js',
  './js/lib/print.js',
  './js/lib/fiscal-adapter.js',
  './js/pages/dashboard.js',
  './js/pages/login.js',
  './js/pages/pos.js',
  './js/pages/inventory.js',
  './manifest.json',
  './icon-192.svg',
  './icon-512.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      // Individual failures shouldn't abort the whole install (e.g. a file
      // renamed but not yet removed from this list).
      .then((cache) => Promise.allSettled(SHELL_FILES.map((f) => cache.add(f))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API traffic or anything cross-origin — always live.
  const isSupabase = url.hostname.endsWith('.supabase.co');
  const isSameOrigin = url.origin === self.location.origin;

  if (isSupabase || !isSameOrigin || event.request.method !== 'GET') {
    return; // let the browser handle it normally (network)
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Cache successful same-origin shell responses for next time.
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
        }
        return response;
      }).catch(() => caches.match('./index.html'));
    })
  );
});

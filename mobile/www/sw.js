/**
 * M3.4: PWA service worker — cache-first offline strategy.
 *
 * Caches the app shell (HTML, JS, CSS, manifest) on first load and serves
 * cached assets when the network is unavailable. Data files under data/
 * are already bundled in the APK (Capacitor), so they don't need to be
 * fetched over the network. On the web, they're cached here too.
 *
 * Registered in index.html:
 *   if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
 */
const CACHE = 'dict-learn-v1';

// Core app shell (always cached; revalidated on each navigate)
const SHELL = [
  'index.html',
  'app.js',
  'srs-store.js',
  'asr-mobile.js',
  'manifest.json',
];

// Data files (fetched once; cached permanently within this app version)
const DATA = [
  'data/concepts.json',
  'data/langs.json',
  'data/drills.json',
];

// --- install: cache shell + data ---
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL.concat(DATA)))
      .then(() => self.skipWaiting())
  );
});

// --- activate: clean up old cache names ---
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// --- fetch: cache-first, fallback to network, store new responses ---
self.addEventListener('fetch', (event) => {
  // Skip cross-origin requests (fonts, API calls, etc.)
  if (event.request.url.startsWith(self.location.origin) === false) return;

  event.respondWith(
    caches.match(event.request, { ignoreSearch: true })
      .then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((res) => {
          if (res.status === 200 && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, clone));
          }
          return res;
        });
      })
      // Network failed → try cache again (catches requests not in initial list)
      .catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});

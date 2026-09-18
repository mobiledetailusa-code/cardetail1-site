/**
 * Cardetail1 customer PWA prototype — shell-only service worker.
 * Caches the app chrome for offline demo. Does NOT cache production APIs.
 */
const CACHE = 'cd1-pwa-shell-v1';
const SHELL = [
  '/prototype/pwa/',
  '/prototype/pwa/index.html',
  '/prototype/pwa/app.css',
  '/prototype/pwa/app.js',
  '/prototype/pwa/manifest.webmanifest',
  '/prototype/mock-data.js',
  '/prototype/ui.js',
  '/prototype/shared.css',
  '/assets/favicon-192.png',
  '/assets/apple-touch-icon.png',
  '/assets/cardetail1-logo-square.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Never intercept API / Netlify functions — live data stays network-only.
  if (url.pathname.startsWith('/.netlify/') || url.pathname.startsWith('/api/')) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok && url.origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

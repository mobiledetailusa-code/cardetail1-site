/**
 * Cardetail1 customer PWA prototype — shell-only service worker.
 * Caches the app chrome for offline demo. Does NOT cache production APIs.
 */
const CACHE = 'cd1-pwa-shell-v2';
const SHELL = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './manifest.webmanifest',
  '../mock-data.js',
  './icons/favicon-192.png',
  './icons/apple-touch-icon.png',
  './icons/cardetail1-logo-square.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(
        SHELL.map((path) =>
          cache.add(new Request(new URL(path, self.location.href), { cache: 'reload' })).catch(() => null)
        )
      )
    ).then(() => self.skipWaiting())
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

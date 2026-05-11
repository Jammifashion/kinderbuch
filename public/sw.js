const CACHE_NAME = 'fably-cache-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Pass through everything, minimal service worker to satisfy PWA install criteria
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});

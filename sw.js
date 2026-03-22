/**
 * SkyCoup Service Worker
 * Caches all app assets for offline use on the plane.
 */

const CACHE_NAME = 'skycoup-v3';

// Build asset URLs relative to the SW scope (works for subdirectory GitHub Pages)
const BASE = self.registration.scope;
const ASSETS = [
  BASE,
  BASE + 'index.html',
  BASE + 'css/style.css',
  BASE + 'js/app.js',
  BASE + 'js/game.js',
  BASE + 'js/network.js',
  BASE + 'js/peerjs.min.js',
  BASE + 'manifest.json',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  // Only handle GET requests to our own origin
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache successful responses for our assets
        if (response.ok && event.request.url.startsWith(self.location.origin)) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached); // Fallback to cache if network fails
    })
  );
});

/*
 * Auto-Stock service worker (P12, spec §A1).
 *
 * Minimal, dependency-free: pre-caches the app shell and serves it cache-first
 * so the PWA loads offline; API calls (/api/) always go to the network (writes
 * that fail offline are captured by the in-app offline queue, not here). On a
 * navigation request the cached shell is served as a fallback so a refresh
 * while offline still boots the SPA.
 */
const CACHE = 'autostock-shell-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never cache API traffic.
  if (url.pathname.startsWith('/api/')) return;
  if (request.method !== 'GET') return;

  // SPA navigations → cached shell fallback when offline.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/index.html')));
    return;
  }

  // Static assets → cache-first.
  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      });
    }),
  );
});

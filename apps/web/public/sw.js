/*
 * Auto-Stock service worker (P12, spec §A1).
 *
 * Minimal, dependency-free: pre-caches the app shell and serves it cache-first
 * so the PWA loads offline; API calls (/api/) always go to the network (writes
 * that fail offline are captured by the in-app offline queue, not here). On a
 * navigation request the cached shell is served as a fallback so a refresh
 * while offline still boots the SPA.
 */
/*
 * Cache name (Aug-2026 feedback set, E-2).
 *
 * This was a hard-coded literal (the old "…-shell-v1" name). A redeploy
 * therefore kept serving the OLD shell cache-first for ever, because the
 * `activate` handler only deletes caches whose key differs from the current
 * one — and the key never changed. `__BUILD_ID__` is substituted at build time
 * (see vite.config.ts), so every deploy gets its own cache and the previous
 * one is swept on activate. Unsubstituted (dev, serving straight from
 * `public/`) the name is stable and still not the old literal.
 */
const BUILD_ID = '__BUILD_ID__';
const CACHE = `bigbakes-stock-shell-${BUILD_ID}`;

/*
 * `/pin-login` is in the shell because it is the PWA's `start_url` (E-2) — an
 * installed icon opened with no network must still reach the sign-in screen,
 * not a browser error page.
 */
const SHELL = ['/', '/index.html', '/pin-login', '/manifest.webmanifest'];

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

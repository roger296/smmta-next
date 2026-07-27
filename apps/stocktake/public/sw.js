/*
 * Stock-take-lite service worker (P26).
 *
 * Dependency-free app-shell cache so the PWA boots offline on the iPad. API
 * calls (/api/) always go to the network — writes that fail offline are held by
 * the in-app sync queue, not here. Static assets are cached on first fetch so a
 * reload while offline still works.
 *
 * ⚠️ THE SHELL MUST NOT FOSSILISE. The first version cached index.html on
 * install and never refreshed it, and pinned a fixed cache name so the activate
 * purge could only ever delete nothing. An installed device therefore kept
 * serving the build it first saw: the stale shell asked for the old hashed
 * bundle, which was also cached, giving a complete and self-consistent copy of
 * an old app with nothing reaching the server. A deployed fix could never
 * arrive. It also HID AN OUTAGE — a rejected fetch (a TLS error counts) fell
 * back to that shell, so the app looked healthy while the server returned 503.
 *
 * So: index.html is network-first AND rewritten on every success. Hashed assets
 * stay cache-first, which is safe precisely because their names change per
 * build — a fresh index.html simply asks for names the cache doesn't hold.
 *
 * BUMP `VERSION` WHENEVER THIS FILE CHANGES, or the purge stays a no-op.
 */
const VERSION = 'v2';
const CACHE = `stocktake-shell-${VERSION}`;
const SHELL = ['/', '/index.html', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      // Bumping VERSION is what gives this line anything to do.
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (url.pathname.startsWith('/api/')) return; // never cache API traffic
  if (request.method !== 'GET') return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          // Only a genuinely good page replaces the offline copy — a 503 from
          // the proxy must never become the thing served when offline.
          if (res.ok) {
            const copy = res.clone();
            void caches.open(CACHE).then((c) => c.put('/index.html', copy));
          }
          return res;
        })
        .catch(() => caches.match('/index.html')),
    );
    return;
  }

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

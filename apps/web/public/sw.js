// Service worker for instant PWA launches. In production it precaches the app
// shell and serves the shell + content-hashed static assets from the cache so
// that, from the second launch onward, the page paints with no network in the
// critical path — the white gap between the native (manifest) splash and first
// paint collapses. Dynamic data (API, server functions, tiles, cross-origin) is
// never cached, so the edge cache and the ch-stream tag-invalidation pipeline
// keep owning content freshness. It also still has a real fetch handler, which
// is what lets Chromium fire `beforeinstallprompt`.
//
// In dev (localhost / *.local) all caching is disabled and navigations pass
// straight through, so Vite's mutable modules and HMR are never served stale.
//
// Bump VERSION to roll the caches (old caches are deleted on activate).
const VERSION = 'v1';
const SHELL_CACHE = `ss-shell-${VERSION}`;
const ASSET_CACHE = `ss-assets-${VERSION}`;

const DEV =
  self.location.hostname === 'localhost' ||
  self.location.hostname === '127.0.0.1' ||
  self.location.hostname.endsWith('.local');

// Stable, unhashed entry points worth pre-warming on install. Hashed JS/CSS/
// fonts are cached at runtime (their names aren't known here).
const SHELL_URLS = [
  '/',
  '/manifest.json',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      if (!DEV) {
        const cache = await caches.open(SHELL_CACHE);
        // Don't let one failed URL abort the whole install.
        await Promise.all(
          SHELL_URLS.map((url) => cache.add(url).catch(() => {})),
        );
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      // Drop caches from older versions (and any left over if DEV flips).
      const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => !keep.has(name))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

// Content-hashed, immutable assets that are safe to serve cache-first. Excludes
// the SW itself, API/server-function routes, and map tiles (their own caching),
// which must always hit the network.
function isHashedAsset(url, request) {
  if (url.pathname === '/sw.js') return false;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/_server')) {
    return false;
  }
  const dest = request.destination;
  return (
    dest === 'style' || dest === 'script' || dest === 'font' || dest === 'image'
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Top-level navigations.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        // Dev: pass through (with navigation preload), never cache.
        if (DEV) {
          const preloaded = await event.preloadResponse;
          return preloaded || fetch(request);
        }
        // Prod: stale-while-revalidate. Serve the cached shell instantly, then
        // refresh it in the background. Only same-origin, non-redirected 200s
        // are stored, so an SSO/auth redirect on a protected preview is never
        // cached or replayed.
        const cache = await caches.open(SHELL_CACHE);
        const cached = await cache.match(request, { ignoreSearch: true });
        const network = (async () => {
          const preloaded = await event.preloadResponse;
          const fresh = preloaded || (await fetch(request));
          if (
            fresh &&
            fresh.ok &&
            fresh.type === 'basic' &&
            !fresh.redirected
          ) {
            await cache.put(request, fresh.clone());
          }
          return fresh;
        })();
        event.waitUntil(network.catch(() => {}));
        return cached || network;
      })(),
    );
    return;
  }

  if (DEV) return;

  // Prod hashed static assets: cache-first. Immutable, so this never goes
  // stale, and keeping old chunks cached means a stale shell still resolves its
  // own JS/CSS.
  if (isHashedAsset(url, request)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSET_CACHE);
        const cached = await cache.match(request);
        if (cached) return cached;
        const fresh = await fetch(request);
        if (fresh && fresh.ok) {
          await cache.put(request, fresh.clone());
        }
        return fresh;
      })(),
    );
    return;
  }

  // Everything else (data, server functions, tiles) goes straight to network.
});

// Minimal service worker. Its only job is to let Chromium fire
// `beforeinstallprompt` — the install criteria require an active SW with a real
// (non-no-op) fetch handler. It caches nothing and serves no custom pages:
// navigations pass straight through to the network, with Navigation Preload so
// the request runs concurrently with SW startup. So SSR, Vercel edge-cache, and
// the browser's native offline/error page (reload + auto-retry) all behave
// exactly as they would with no service worker at all.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  // Only top-level navigations, passed through untouched. Calling respondWith
  // makes this a real fetch handler (so the install prompt qualifies); on a
  // network failure the promise rejects, leaving the browser's native offline
  // page in place. Assets, data and API requests are never intercepted.
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    (async () => {
      const preloaded = await event.preloadResponse;
      return preloaded || fetch(event.request);
    })(),
  );
});

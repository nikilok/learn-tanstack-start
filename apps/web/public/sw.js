// Minimal service worker. Its only jobs are (1) to exist with a fetch handler so
// Chrome fires `beforeinstallprompt` (required for the in-app install button) and
// (2) to show an offline fallback page when a navigation fails with no network.
//
// It deliberately does NOT cache pages, search data, or API/_server responses:
// online navigations go straight to the network, so the app's SSR + Vercel
// edge-cache + tag-invalidation behaviour is completely untouched.
const OFFLINE_CACHE = 'ss-offline-v1';
const OFFLINE_URL = '/__offline';

const OFFLINE_HTML = `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Offline · SponsorSearch</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #0a0a0a; color: #ededed; text-align: center; padding: 2rem; }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
  p { color: #a0a0a0; margin: 0 auto; max-width: 26rem; line-height: 1.5; }
</style>
</head>
<body>
  <main>
    <h1>You're offline</h1>
    <p>SponsorSearch needs a connection to search live sponsor data. Reconnect and try again.</p>
  </main>
</body>
</html>`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(OFFLINE_CACHE).then((cache) =>
      cache.put(
        OFFLINE_URL,
        new Response(OFFLINE_HTML, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        }),
      ),
    ),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== OFFLINE_CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  // Only top-level navigations are handled: network-first, offline page on
  // failure. Assets, data and API requests fall through to the browser uncached.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(OFFLINE_URL)),
    );
  }
});

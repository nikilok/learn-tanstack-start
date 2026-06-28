/**
 * Pre-hydration install setup, for Chromium browsers only (Chrome/Edge/Brave/…;
 * `data-browser` is stamped by the earlier BROWSER_INIT_SCRIPT). It registers the
 * service worker — which is what lets Chromium fire `beforeinstallprompt` — and
 * captures the deferred prompt the instant it fires, early enough that a fast
 * reload with the SW already active can't lose it to a race with the app bundle.
 * On mobile it leaves the event alone so the browser shows its own install UI
 * (we only render the desktop pill). Non-Chromium browsers get nothing here.
 */
export const INSTALL_PROMPT_INIT_SCRIPT = `(() => {
  try {
    var browser = document.documentElement.dataset.browser;
    if (browser !== 'chrome' && browser !== 'edge') return;
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(function () {});
    }
    window.__ssInstallPrompt = null;
    window.addEventListener('beforeinstallprompt', function (e) {
      if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) return;
      e.preventDefault();
      window.__ssInstallPrompt = e;
      window.dispatchEvent(new Event('ss:installable'));
    });
    window.addEventListener('appinstalled', function () {
      window.__ssInstallPrompt = null;
      window.dispatchEvent(new Event('ss:installed'));
    });
  } catch (_e) {}
})();`;

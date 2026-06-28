/**
 * Pre-hydration capture of Chrome's `beforeinstallprompt`. The event fires once,
 * early — often before the app bundle mounts and can attach a listener, especially
 * on a reload with the service worker already active. Stashing it from an inline
 * `<head>` script (and re-broadcasting via a custom event) guarantees the install
 * chip can find the deferred prompt instead of losing it to that race.
 */
export const INSTALL_PROMPT_INIT_SCRIPT = `(() => {
  try {
    window.__ssInstallPrompt = null;
    window.addEventListener('beforeinstallprompt', function (e) {
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

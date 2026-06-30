/**
 * Blocking pre-hydration script that stamps `data-desktop` on `<html>` when the
 * page is running inside the Electron shell (the preload exposes
 * `window.isSponsorSearchDesktop`). A CSS rule then hides the web `<Header/>` so
 * the native title bar owns that chrome — done pre-paint to avoid any flash.
 */
export const DESKTOP_INIT_SCRIPT = `(() => {
  try {
    if (window.isSponsorSearchDesktop) {
      document.documentElement.dataset.desktop = '';
    }
  } catch (_e) {}
})();`;

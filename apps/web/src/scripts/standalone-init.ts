/**
 * Blocking pre-hydration inline script for installed-PWA launches. When running
 * standalone (display-mode standalone, or iOS `navigator.standalone`) it stamps
 * `data-standalone` on `<html>` so the app-shell splash shows (gated in
 * styles.css) — and never in a normal browser tab. It then stamps
 * `data-splash-done` one frame after first paint, which hides the splash. That
 * dismissal is driven by `requestAnimationFrame`, NOT React hydration, so the
 * already-painted app is revealed at first paint instead of waiting the much
 * longer hydration window. The `setTimeout` is a failsafe.
 */
export const STANDALONE_INIT_SCRIPT = `(() => {
  try {
    var standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true;
    if (!standalone) return;
    var root = document.documentElement;
    root.dataset.standalone = '';
    var done = function () { root.dataset.splashDone = ''; };
    requestAnimationFrame(function () { requestAnimationFrame(done); });
    setTimeout(done, 1500);
  } catch (_e) {}
})();`;

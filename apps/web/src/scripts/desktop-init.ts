import { DESKTOP_PREVIEW_WINDOW_NAME } from '../utils/desktop-preview';

/**
 * Blocking pre-hydration script that stamps `data-desktop` on `<html>` when the
 * page is running inside the Electron shell (the preload exposes
 * `window.isSponsorSearchDesktop`) or inside the /download live-preview iframe
 * (whose `name` is stamped by `<Preview/>` before any script runs). A CSS rule
 * then hides the web `<Header/>` so the native title bar owns that chrome —
 * done pre-paint to avoid any flash. Preview iframes additionally fold SPA
 * pushes into replaces: iframe navigations join the tab's session history, so
 * without this the parent page's Back button would step the demo backwards.
 */
export const DESKTOP_INIT_SCRIPT = `(() => {
  try {
    if (window.isSponsorSearchDesktop) {
      document.documentElement.dataset.desktop = '';
    } else if (window.name === '${DESKTOP_PREVIEW_WINDOW_NAME}') {
      document.documentElement.dataset.desktop = '';
      window.history.pushState = window.history.replaceState.bind(window.history);
    }
  } catch (_e) {}
})();`;

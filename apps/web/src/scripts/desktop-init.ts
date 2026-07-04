import { DESKTOP_PREVIEW_WINDOW_NAME } from '../utils/desktop-preview';

/**
 * Blocking pre-hydration script that stamps `data-desktop` on `<html>` when the
 * page is running inside the Electron shell (the preload exposes
 * `window.isSponsorSearchDesktop`) or inside the /download live-preview iframe
 * (whose `name` is stamped by `<Preview/>` before any script runs; the
 * framed-only check keeps a window.open with a forged name from flipping a
 * top-level tab). A CSS rule then hides the web `<Header/>` so the native
 * title bar owns that chrome — done pre-paint to avoid any flash.
 *
 * Preview iframes additionally get two containment patches:
 * - SPA pushes fold into replaces: iframe navigations join the tab's session
 *   history, so without this the parent page's Back button would step the demo
 *   backwards instead of leaving.
 * - `sessionStorage` is shadowed with an in-memory store: same-origin iframes
 *   share the tab's real sessionStorage, so the embedded app would otherwise
 *   consume/overwrite the parent session's `hmrc-*` back-nav keys and clobber
 *   the router's `tsr-scroll-restoration` blob on unload. This must run BEFORE
 *   search-input-init (which reads sessionStorage) — keep the script order in
 *   __root.tsx.
 */
export const DESKTOP_INIT_SCRIPT = `(() => {
  try {
    if (window.isSponsorSearchDesktop) {
      document.documentElement.dataset.desktop = '';
    } else if (window.name === '${DESKTOP_PREVIEW_WINDOW_NAME}' && window.self !== window.top) {
      document.documentElement.dataset.desktop = '';
      window.history.pushState = window.history.replaceState.bind(window.history);
      var mem = Object.create(null);
      Object.defineProperty(window, 'sessionStorage', {
        configurable: true,
        value: {
          getItem: function (k) { return k in mem ? mem[k] : null; },
          setItem: function (k, v) { mem[k] = String(v); },
          removeItem: function (k) { delete mem[k]; },
          clear: function () { mem = Object.create(null); },
          key: function (i) { var ks = Object.keys(mem); return i < ks.length ? ks[i] : null; },
          get length() { return Object.keys(mem).length; },
        },
      });
    }
  } catch (_e) {}
})();`;

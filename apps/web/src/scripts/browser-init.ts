/**
 * Pre-hydration inline script that stamps `data-browser="<name>"` on
 * `<html>` so CSS can target browser-specific fixes — e.g. dropping
 * `object-fit: fill` on the active-card view-transition pseudos under
 * Safari, where it causes cumulative GPU pressure across navigations.
 * Set as a generic mechanism so future per-browser tweaks (Chrome,
 * Firefox, Edge) can hang off the same attribute.
 *
 * Detection is order-sensitive because Chromium-based browsers also
 * include "Chrome" / "Safari" tokens in their UA strings — Edge is
 * checked first, then Firefox, then Chrome, then Safari as the final
 * fallback for true WebKit.
 *
 * On WebKit it ALSO neutralises `document.startViewTransition`, disabling
 * every page morph on Safari. WebKit drops `backdrop-filter` (and fixed
 * layers) from view-transition snapshots, so the transparent frosted header
 * renders bare mid-morph — a clear header that "pops" to blurred once the
 * transition ends. Rather than abandon the transparent-blur header design,
 * Safari opts out of transitions: navigations are instant there and the live
 * blurred header renders correctly. Every iOS browser is WebKit, so the
 * `safari` bucket is the right gate; other engines keep the morph. Nothing in
 * app code calls `startViewTransition` directly — only the router (via its
 * `viewTransition` options) — so the shim's blast radius is exactly the page
 * morphs. The shim runs the update callback synchronously and returns a
 * resolved, no-op transition so the router's `.finished`/`.ready` awaits still
 * settle.
 */
export const BROWSER_INIT_SCRIPT = `(() => {
  try {
    const ua = navigator.userAgent;
    let browser = 'unknown';
    if (/edg\\//i.test(ua)) browser = 'edge';
    else if (/firefox/i.test(ua)) browser = 'firefox';
    else if (/chrome/i.test(ua)) browser = 'chrome';
    else if (/safari/i.test(ua)) browser = 'safari';
    document.documentElement.setAttribute('data-browser', browser);
    if (browser === 'safari' && typeof document.startViewTransition === 'function') {
      document.startViewTransition = function (arg) {
        const cb = typeof arg === 'function' ? arg : arg && arg.update;
        let result;
        try { result = cb ? cb() : undefined; } catch (_e) {}
        const done = Promise.resolve(result).catch(function () {});
        return {
          finished: done,
          ready: done,
          updateCallbackDone: done,
          skipTransition: function () {},
          types: new Set(),
        };
      };
    }
  } catch (_e) {}
})();`;

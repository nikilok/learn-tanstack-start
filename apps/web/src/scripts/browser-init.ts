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
  } catch (_e) {}
})();`;

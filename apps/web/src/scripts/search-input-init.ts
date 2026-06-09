/**
 * Blocking pre-hydration inline script that stamps `data-hide-search-input`
 * on `<html>` when the page is loading scrolled (either `window.scrollY > 0`
 * or a saved `hmrc-scroll-y` that parses to a positive integer). Paired with a
 * CSS rule in `styles.css` that gates the search input's opacity off this
 * attribute to prevent a first-paint flash before pill mode kicks in. A
 * non-positive saved value (e.g. "0") means nothing to restore, so it must not
 * stamp the attribute — "0" is truthy and would otherwise hide the input
 * forever (see CLAUDE.md).
 */
export const SEARCH_INIT_SCRIPT = `(() => {
  try {
    const y = window.sessionStorage.getItem('hmrc-scroll-y');
    if ((y && parseInt(y, 10) >= 1) || window.scrollY >= 1) {
      document.documentElement.dataset.hideSearchInput = '';
    }
  } catch (_e) {}
})();`;

/**
 * Blocking pre-hydration inline script that stamps `data-hide-search-input`
 * on `<html>` when the page is loading scrolled (either `window.scrollY > 0`
 * or a saved `hmrc-scroll-y` key). Paired with a CSS rule in `styles.css`
 * that gates the search input's opacity off this attribute to prevent a
 * first-paint flash before pill mode kicks in.
 */
export const SEARCH_INIT_SCRIPT = `(() => {
  try {
    if (window.sessionStorage.getItem('hmrc-scroll-y') || window.scrollY > 0) {
      document.documentElement.dataset.hideSearchInput = '';
    }
  } catch (_e) {}
})();`;

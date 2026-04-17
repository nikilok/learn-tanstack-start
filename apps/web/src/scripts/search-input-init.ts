export const SEARCH_INIT_SCRIPT = `(() => {
  try {
    if (window.sessionStorage.getItem('hmrc-scroll-y') || window.scrollY > 0) {
      document.documentElement.dataset.hideSearchInput = '';
    }
  } catch (_e) {}
})();`;

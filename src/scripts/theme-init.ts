import { THEME_COLORS } from '../theme';

export const THEME_INIT_SCRIPT = `(() => {
  try {
    const stored = window.localStorage.getItem('theme');
    const mode =
      stored === 'light' || stored === 'dark' || stored === 'auto'
        ? stored
        : 'auto';
    const prefersDark = window.matchMedia(
      '(prefers-color-scheme: dark)',
    ).matches;
    const resolved = mode === 'auto' ? (prefersDark ? 'dark' : 'light') : mode;

    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(resolved);

    if (mode === 'auto') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', mode);
    }

    root.style.colorScheme = resolved;

    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      document.head.appendChild(meta);
    }
    meta.content = resolved === 'dark' ? '${THEME_COLORS.dark}' : '${THEME_COLORS.light}';
  } catch (_e) {}
})();`;

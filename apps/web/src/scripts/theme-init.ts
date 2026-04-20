import { THEME_COLORS } from '../theme';

/**
 * Blocking pre-hydration inline script that reads the stored `theme`
 * preference (`light`/`dark`/`auto`), resolves `auto` via `prefers-color-
 * scheme`, and applies the matching class + `color-scheme` + `<meta
 * theme-color>` on `<html>` before first paint to avoid a flash.
 */
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
    root.style.colorScheme = resolved;

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.content = resolved === 'dark' ? '${THEME_COLORS.dark}' : '${THEME_COLORS.light}';
    }
  } catch (_e) {}
})();`;

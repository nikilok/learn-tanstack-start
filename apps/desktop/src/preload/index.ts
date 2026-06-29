import { contextBridge, ipcRenderer } from 'electron';

// A safe marker so the web app can detect the desktop shell.
contextBridge.exposeInMainWorld('isSponsorSearchDesktop', true);

/** Forwards the page's resolved theme (exact colour + explicit light/dark vs auto) to main. */
function reportTheme(): void {
  const stored = window.localStorage.getItem('theme');
  // 'auto'/unset -> 'system' so the native chrome keeps tracking the OS appearance.
  const themeSource =
    stored === 'light' || stored === 'dark' ? stored : 'system';
  const color =
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      ?.content ??
    (document.documentElement.classList.contains('dark')
      ? '#0a0a0a'
      : '#ffffff');
  ipcRenderer.send('ss:theme', { themeSource, color });
}

// The site swaps the light/dark class on <html> (and the theme-color meta) on every
// theme change; mirror it onto the native title bar. DOMContentLoaded fires after the
// blocking theme-init script, so the first read is already correct.
window.addEventListener('DOMContentLoaded', () => {
  reportTheme();
  new MutationObserver(reportTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  });
});

// window.name is the only channel a parent can stamp on an iframe before the
// document's inline head scripts run, and it survives SPA navigations — so the
// /download live preview rides its flag on it.
export const DESKTOP_PREVIEW_WINDOW_NAME = 'ss-desktop-preview';

/** True inside the /download live-preview iframe (its `name` is stamped by `<Preview/>`; the framed check keeps a forged top-level window.name from counting). */
export function isDesktopPreview(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.name === DESKTOP_PREVIEW_WINDOW_NAME &&
    window.self !== window.top
  );
}

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { DesktopPlatform } from '../api/releases';
import { usePreviewScenario } from '../hooks/usePreviewScenario';
import { DESKTOP_PREVIEW_WINDOW_NAME } from '../utils/desktop-preview';
import PreviewTitleBar from './PreviewTitleBar';

// Mirrors the shell's default BaseWindow size (apps/desktop/src/main/index.ts).
const WINDOW_W = 1280;
const WINDOW_H = 860;

/**
 * Live desktop-app preview for /download: the real app in a same-origin iframe
 * (its window.name makes desktop-init hide the web header, like the Electron
 * shell), dressed in a replica of the shell's title bar and scaled into a
 * window floating over a wallpaper. Once on screen it's driven like a user —
 * type the company, let real results stream in, click through to its details
 * page. Decorative only: the iframe is inert and mouse-transparent.
 */
export default function Preview({
  company,
  platform,
  wallpaper,
}: {
  company: string;
  platform: DesktopPlatform;
  wallpaper?: string;
}) {
  const paneRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [scale, setScale] = useState(0);
  const { title, canGoBack } = usePreviewScenario(frameRef, paneRef, company);

  // Track the anchor's rendered width → the transform that fits 1280px into it.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const observer = new ResizeObserver(([entry]) => {
      setScale(entry.contentRect.width / WINDOW_W);
    });
    observer.observe(anchor);
    return () => observer.disconnect();
  }, []);

  // Mirror the parent page's resolved theme onto the iframed app (class +
  // color-scheme, matching applyThemeMode). The app resolves its theme once at
  // load, so a /download theme toggle would otherwise strand the window on the
  // stale scheme until a reload; its own useIsDark consumers react to the class.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const sync = () => {
      const resolved = document.documentElement.classList.contains('dark')
        ? 'dark'
        : 'light';
      try {
        const root = frame.contentDocument?.documentElement;
        if (!root || root.classList.contains(resolved)) return;
        root.classList.remove('light', 'dark');
        root.classList.add(resolved);
        root.style.colorScheme = resolved;
      } catch {
        // teardown/cross-origin: nothing to sync
      }
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    // Covers a toggle that lands while the iframe document is still loading.
    frame.addEventListener('load', sync);
    sync();
    return () => {
      observer.disconnect();
      frame.removeEventListener('load', sync);
    };
  }, []);

  return (
    <div
      ref={paneRef}
      aria-hidden="true"
      className="pointer-events-none relative h-full w-full overflow-hidden select-none"
    >
      {wallpaper ? (
        <img
          src={wallpaper}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 bg-linear-to-br from-[#c7d2e8] via-[#e9e2ee] to-[#f2dcc8] dark:from-[#131a33] dark:via-[#1d1430] dark:to-[#3a1d33]" />
      )}
      {/* The window floats over the wallpaper: sky on top and sides, bottom bleeding off the pane. */}
      <div ref={anchorRef} className="absolute inset-x-[7%] top-[9%]">
        <div
          className="overflow-hidden rounded-lg bg-(--bg-base) shadow-[0_24px_60px_-12px_rgba(0,0,0,0.5)] ring-1 ring-black/20 dark:ring-white/10"
          style={{
            height: WINDOW_H * scale,
            visibility: scale > 0 ? 'visible' : 'hidden',
          }}
        >
          {/* Unscaled 1280×860 coordinate space: the app lays out at desktop size, then shrinks. */}
          <div
            className="relative"
            style={{
              width: WINDOW_W,
              height: WINDOW_H,
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
            }}
          >
            <iframe
              ref={frameRef}
              src="/"
              name={DESKTOP_PREVIEW_WINDOW_NAME}
              title={`SponsorSearch desktop preview (${platform})`}
              inert
              className="h-full w-full border-0"
            />
            <PreviewTitleBar
              platform={platform}
              title={title}
              canGoBack={canGoBack}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

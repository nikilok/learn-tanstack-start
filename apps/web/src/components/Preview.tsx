import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { DesktopPlatform } from '../api/releases';
import { useIsDark } from '../hooks/useIsDark';
import {
  type PreviewShot,
  usePreviewScenario,
} from '../hooks/usePreviewScenario';
import { DESKTOP_PREVIEW_WINDOW_NAME } from '../utils/desktop-preview';
import Logo from './Logo';
import PreviewTitleBar from './PreviewTitleBar';

// Mirrors the shell's default BaseWindow size (apps/desktop/src/main/index.ts).
const WINDOW_W = 1280;
const WINDOW_H = 860;
// Window placement inside the pane: wallpaper margin on the sides and top.
const INSET_X = 0.07;
const INSET_TOP = 0.09;
// One timing curve for every camera move — the scene transform and the lens
// blur must share it (plus the shot's duration) so their progress stays locked.
const CAMERA_EASE = 'cubic-bezier(0.45, 0.05, 0.25, 1)';
// Wallpaper defocus per unit of zoom beyond 1, in pre-transform px (the scene
// scale magnifies it, so the felt blur deepens slightly faster than the zoom).
const LENS_BLUR_PER_ZOOM = 6;

/** Clamps `v` into [lo, hi]. */
const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/**
 * Scene-camera transform for a shot: maps the shot's app rect (iframe coords)
 * into pane coords via the window inset + base scale, then zooms the WHOLE
 * scene — wallpaper, window frame and chrome — about it, clamped so the pane
 * stays covered. `rect: null` (or an unmeasured pane) is the resting wide shot.
 * Returns the zoom multiple alongside so the lens blur can key off it.
 */
function shotTransform(
  shot: PreviewShot,
  paneW: number,
  paneH: number,
  scale: number,
): { transform: string; zoom: number } {
  if (!shot.rect || paneW === 0 || paneH === 0) {
    return { transform: 'scale(1) translate(0px, 0px)', zoom: 1 };
  }
  const left = paneW * INSET_X + (shot.rect.left - (shot.padX ?? 0)) * scale;
  const top = paneH * INSET_TOP + (shot.rect.top - (shot.padY ?? 0)) * scale;
  const width = (shot.rect.width + (shot.padX ?? 0) * 2) * scale;
  const height = (shot.rect.height + (shot.padY ?? 0) * 2) * scale;
  const z = clamp(Math.min(paneW / width, paneH / height), 1, shot.maxZ ?? 2.2);
  const vw = paneW / z;
  const vh = paneH / z;
  const x = clamp(left + width / 2 - vw / 2, 0, paneW - vw);
  const y = clamp(top + height / 2 - vh / 2, 0, paneH - vh);
  return { transform: `scale(${z}) translate(${-x}px, ${-y}px)`, zoom: z };
}

/**
 * Live desktop-app preview for /download: the real app in a same-origin iframe
 * (its window.name makes desktop-init hide the web header, like the Electron
 * shell), dressed in a replica of the shell's title bar and scaled into a
 * window floating over a wallpaper. Once on screen it's driven like a user —
 * type the company, let real results stream in, click through to its details
 * page — while a scene camera moves closer for the typing and details beats
 * and pulls away between them. Decorative only: the iframe is inert and
 * mouse-transparent.
 */
export default function Preview({
  company,
  platform,
  wallpaper,
}: {
  company: string;
  platform: DesktopPlatform;
  /** Per-theme wallpaper URLs; both ship and CSS shows one, so the theme swap needs no JS (no flash). */
  wallpaper?: { light: string; dark: string };
}) {
  const paneRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [pane, setPane] = useState({ w: 0, h: 0 });
  // Mount the iframe only after the parent page has fully loaded (fonts,
  // wallpapers) and gone idle: it boots a full second copy of the app, which
  // would otherwise compete with /download's own boot. SSR/no-JS renders just
  // the window chrome over the wallpaper.
  const [frameReady, setFrameReady] = useState(false);
  useEffect(() => {
    let idleId: number | undefined;
    let timerId: number | undefined;
    let armed = false;
    /** Schedules the mount on idle (Safari: short timer) — at most once. */
    const arm = () => {
      if (armed) return;
      armed = true;
      if (timerId !== undefined) window.clearTimeout(timerId);
      if (typeof window.requestIdleCallback === 'function') {
        idleId = window.requestIdleCallback(() => setFrameReady(true), {
          timeout: 1500,
        });
      } else {
        // Safari has no requestIdleCallback; load has fired, so a beat is enough.
        timerId = window.setTimeout(() => setFrameReady(true), 300);
      }
    };
    if (document.readyState === 'complete') {
      arm();
    } else {
      window.addEventListener('load', arm, { once: true });
      // Safety net: a straggling resource must not strand the demo unstarted.
      timerId = window.setTimeout(arm, 4000);
    }
    return () => {
      window.removeEventListener('load', arm);
      if (idleId !== undefined) window.cancelIdleCallback(idleId);
      if (timerId !== undefined) window.clearTimeout(timerId);
    };
  }, []);
  // Splash → app handoff: the window shows a launch splash (base bg + mark,
  // like the PWA/native splash) from first SSR paint, and reveals the live app
  // only once the iframed document has painted — never a bare dark pane.
  const [appVisible, setAppVisible] = useState(false);
  useEffect(() => {
    if (!frameReady) return;
    const frame = frameRef.current;
    if (!frame) return;
    const reveal = () => requestAnimationFrame(() => setAppVisible(true));
    // Covers a load that finished before this effect attached (the initial
    // about:blank document also reports 'complete' — don't count it).
    const doc = frame.contentDocument;
    if (doc && doc.readyState === 'complete' && doc.URL !== 'about:blank') {
      reveal();
      return;
    }
    frame.addEventListener('load', reveal);
    return () => frame.removeEventListener('load', reveal);
  }, [frameReady]);
  const { title, canGoBack, shot } = usePreviewScenario(
    frameRef,
    paneRef,
    company,
    frameReady,
  );
  const scale = (pane.w * (1 - INSET_X * 2)) / WINDOW_W;
  const camera = shotTransform(shot, pane.w, pane.h, scale);

  // Animate the camera only for shot changes: a pane resize also changes
  // shotTransform's output, and easing that correction while the inner layers
  // snap would rubber-band the scene against its own window chrome.
  const lastShotRef = useRef(shot);
  const lastPaneRef = useRef(pane);
  const suppressTransition =
    lastShotRef.current === shot && lastPaneRef.current !== pane;
  useEffect(() => {
    lastShotRef.current = shot;
    lastPaneRef.current = pane;
  });
  // One shared timing fragment: the transform and filter transitions must run
  // under the same duration + curve, so build it once for both.
  const cameraTransition =
    shot.ms > 0 && !suppressTransition
      ? `${shot.ms}ms ${CAMERA_EASE}`
      : undefined;
  // Lens blur target ∝ (zoom − 1): with endpoints proportional and the same
  // duration + easing as the transform, blur stays locked to zoom mid-flight —
  // even when a new shot interrupts one still easing.
  const lensBlur = (camera.zoom - 1) * LENS_BLUR_PER_ZOOM;

  // Track the pane's rendered size → base window scale + camera mapping.
  useLayoutEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setPane({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Mirror the parent page's resolved theme onto the iframed app (class +
  // color-scheme, matching applyThemeMode). The app resolves its theme once at
  // load, so a /download theme toggle would otherwise strand the window on the
  // stale scheme until a reload; its own useIsDark consumers react to the class.
  const isDark = useIsDark();
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const resolved = isDark ? 'dark' : 'light';
    const sync = () => {
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
    // Covers a toggle that lands while the iframe document is still loading.
    frame.addEventListener('load', sync);
    sync();
    return () => frame.removeEventListener('load', sync);
    // frameReady re-runs this once the deferred iframe actually exists.
  }, [isDark, frameReady]);

  return (
    <div
      ref={paneRef}
      aria-hidden="true"
      className="pointer-events-none relative h-full w-full overflow-hidden select-none"
    >
      {/* Scene layer = wallpaper + floating window. The camera zooms this whole
          layer within the fixed pane, like physically moving closer to the app;
          the pane's overflow-hidden crops whatever grows past its edges. */}
      <div
        className="absolute inset-0"
        style={{
          transform: camera.transform,
          transformOrigin: 'top left',
          transition: cameraTransition && `transform ${cameraTransition}`,
        }}
      >
        {/* Lens layer: the wallpaper defocuses as the camera moves in, like
            focus racking onto the app; oversized so the blur's faded edge
            stays outside the pane. The window above it stays sharp. */}
        <div
          className="absolute -inset-6"
          style={{
            filter: `blur(${lensBlur}px)`,
            transition: cameraTransition && `filter ${cameraTransition}`,
            willChange: 'filter',
          }}
        >
          {wallpaper ? (
            <>
              <img
                src={wallpaper.light}
                alt=""
                className="absolute inset-0 block h-full w-full object-cover dark:hidden"
              />
              <img
                src={wallpaper.dark}
                alt=""
                className="absolute inset-0 hidden h-full w-full object-cover dark:block"
              />
            </>
          ) : (
            <div className="absolute inset-0 bg-linear-to-br from-[#c7d2e8] via-[#e9e2ee] to-[#f2dcc8] dark:from-[#131a33] dark:via-[#1d1430] dark:to-[#3a1d33]" />
          )}
        </div>
        {/* The window floats over the wallpaper: sky on top and sides, bottom bleeding off the pane. */}
        <div
          style={{
            position: 'absolute',
            left: `${INSET_X * 100}%`,
            right: `${INSET_X * 100}%`,
            top: `${INSET_TOP * 100}%`,
          }}
        >
          {/* CSS aspect-ratio (not a JS height) so the empty window frame paints
              with the SSR HTML — no-JS visitors and crawlers see wallpaper +
              window instead of a blank pane; only the live content waits on JS. */}
          <div
            className="overflow-hidden rounded-lg bg-(--bg-base) shadow-[0_24px_60px_-12px_rgba(0,0,0,0.5)] ring-1 ring-black/20 dark:ring-white/10"
            style={{ aspectRatio: `${WINDOW_W} / ${WINDOW_H}` }}
          >
            {/* Unscaled 1280×860 coordinate space: the app lays out at desktop size, then shrinks. */}
            <div
              className="relative"
              style={{
                width: WINDOW_W,
                height: WINDOW_H,
                transform: `scale(${scale})`,
                transformOrigin: 'top left',
                visibility: scale > 0 ? 'visible' : 'hidden',
              }}
            >
              {frameReady ? (
                <iframe
                  ref={frameRef}
                  src="/"
                  name={DESKTOP_PREVIEW_WINDOW_NAME}
                  title={`SponsorSearch desktop preview (${platform})`}
                  inert
                  className="h-full w-full border-0"
                />
              ) : null}
              {/* Launch splash — replica of the shell's, which opens on the site's own dark
                  ground (INITIAL_BG.dark in apps/desktop/src/main/index.ts, --bg-page-edge
                  in styles.css) with the white wordmark over it. This window advertises the
                  app, so the two have to stay in lockstep; the colour drifted once already
                  when the shell moved off #120817 and only the comment was updated. Fades
                  out over the loaded app. */}
              <div
                className={`absolute inset-0 flex items-center justify-center bg-[#0a0a0a] transition-opacity duration-500 ${
                  appVisible ? 'opacity-0' : 'opacity-100'
                }`}
              >
                <Logo
                  className="w-105"
                  navyColor="#ffffff"
                  redColor="#ffffff"
                />
              </div>
              <PreviewTitleBar
                platform={platform}
                title={title}
                canGoBack={canGoBack}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

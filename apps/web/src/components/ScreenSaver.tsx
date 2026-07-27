import { useEffect, useRef, useState } from 'react';

import { useIdle } from '../hooks/useIdle';
import { useIsDark } from '../hooks/useIsDark';
import {
  COIL_DOT_RADIUS,
  coilBounds,
  coilDrift,
  coilPalette,
  fitCoil,
  sampleCoil,
  TENTACLE_SPREAD,
  TIME_PER_SECOND,
} from '../lib/screensaver/coil';
import { EXTERNAL_ACTIVITY_EVENT } from '../lib/screensaver/idle';
import { prefersReducedMotion } from '../utils';
import Logo from './Logo';

import styles from './ScreenSaver.module.css';

// Must match .leaving's transition-duration — it's how long the overlay stays mounted
// after waking so the fade-out can play.
const FADE_OUT_MS = 320;

// Curve time the reduced-motion still is frozen at. Picked for a well-formed coil.
const STATIC_FRAME_T = 3.8;

// Canvas is a field of ~1px dots, so past 2x the extra fill buys nothing.
const MAX_DPR = 2;

const TAU = Math.PI * 2;
const NO_DRIFT = { x: 0, y: 0 };

/**
 * Takes over the whole window once the user has been idle (see `useIdle`) and hands it
 * back on the first real input. Draws the coil on a full-bleed canvas in the app's own
 * theme colours: white dots on the dark page, black on the light one. Reduced motion
 * gets the same scene held on a single frame.
 */
export default function ScreenSaver() {
  const idle = useIdle();
  const dark = useIsDark();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Mounted covers the fade-out too; visible drives the opacity transition itself.
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);

  // Keep it mounted through the fade-out, then drop the canvas (and its loop) entirely.
  useEffect(() => {
    if (idle) {
      setMounted(true);
      return;
    }
    if (!mounted) return;
    const timer = window.setTimeout(() => setMounted(false), FADE_OUT_MS);
    return () => window.clearTimeout(timer);
  }, [idle, mounted]);

  // One frame at opacity 0 first, or the transition has nothing to move from.
  useEffect(() => {
    if (!mounted) {
      setVisible(false);
      return;
    }
    const frame = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(frame);
  }, [mounted]);

  // Tell the Electron shell so it can fade its native title bar out of the way.
  useEffect(() => {
    window.ssDesktop?.setScreenSaver?.(idle);
  }, [idle]);

  // That title bar is a separate view, so input landing on it never reaches this
  // document — the shell forwards it and we re-emit it as activity.
  useEffect(
    () =>
      window.ssDesktop?.onScreenSaverWake?.(() => {
        window.dispatchEvent(new Event(EXTERNAL_ACTIVITY_EVENT));
      }),
    [],
  );

  // The scrollbar gutter sits outside a fixed element's box, so <html> has to be recoloured
  // for the field to reach the screen edge (see the :global rule in the stylesheet).
  useEffect(() => {
    if (!idle) return;
    document.documentElement.dataset['screensaver'] = '';
    return () => {
      delete document.documentElement.dataset['screensaver'];
    };
  }, [idle]);

  // Swallow scroll while it's up: the gesture that wakes the app shouldn't also move the
  // page under it. Non-passive, so the listener only exists while the screensaver shows.
  useEffect(() => {
    if (!idle) return;
    const block = (event: Event) => {
      if (event.cancelable) event.preventDefault();
    };
    window.addEventListener('wheel', block, { passive: false });
    window.addEventListener('touchmove', block, { passive: false });
    return () => {
      window.removeEventListener('wheel', block);
      window.removeEventListener('touchmove', block);
    };
  }, [idle]);

  useEffect(() => {
    if (!mounted) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const reduce = prefersReducedMotion();
    const start = performance.now();
    let raf = 0;
    let alive = true;

    /** Match the backing store to the canvas box in device pixels. */
    const sizeCanvas = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(2, Math.ceil(rect.width * dpr));
      const height = Math.max(2, Math.ceil(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    };

    /** One flat colour, or a sweep down the coil's diagonal — echoing the rotated glow grid on the page behind it. */
    const dotFill = (stops: string[], box: ReturnType<typeof coilBounds>) => {
      const [first] = stops;
      if (stops.length < 2 || !first) return first ?? 'transparent';
      const gradient = ctx.createLinearGradient(box.x0, box.y0, box.x1, box.y1);
      for (const [i, stop] of stops.entries()) {
        gradient.addColorStop(i / (stops.length - 1), stop);
      }
      return gradient;
    };

    /** Paint one frame; `elapsedMs` drives both the curve and its drift. */
    const draw = (elapsedMs: number) => {
      const { width, height } = canvas;
      // Read the live theme each frame, so an OS appearance change mid-screensaver follows.
      const { background, dotStops, tentacle } = coilPalette(
        document.documentElement.classList.contains('dark'),
      );
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);

      const { scale, offsetX, offsetY } = fitCoil(width, height);
      const drift = reduce
        ? NO_DRIFT
        : coilDrift(elapsedMs, Math.min(width, height));
      const originX = offsetX + drift.x;
      const originY = offsetY + drift.y;
      const radius = COIL_DOT_RADIUS * scale;
      const t = reduce ? STATIC_FRAME_T : (elapsedMs / 1000) * TIME_PER_SECOND;

      /** Draws only the samples on one side of the tentacle threshold. */
      const paint = (fill: string | CanvasGradient, tentacles: boolean) => {
        ctx.fillStyle = fill;
        sampleCoil(t, (x, y, spread) => {
          if (spread >= TENTACLE_SPREAD !== tentacles) return;
          ctx.beginPath();
          ctx.arc(x * scale + originX, y * scale + originY, radius, 0, TAU);
          ctx.fill();
        });
      };

      // Body then strands: two passes over the (cheap) curve maths, but still one
      // fillStyle each and 10k dots total. A theme with no accent paints both the same.
      const sweep = dotFill(dotStops, coilBounds(scale, originX, originY));
      paint(sweep, false);
      paint(tentacle ?? sweep, true);
    };

    sizeCanvas();
    draw(0);

    if (reduce) {
      // One still frame, repainted only when its pixels would actually change.
      const redraw = () => {
        if (!alive) return;
        sizeCanvas();
        draw(0);
      };
      const resize = new ResizeObserver(redraw);
      resize.observe(canvas);
      const theme = new MutationObserver(redraw);
      theme.observe(document.documentElement, { attributeFilter: ['class'] });
      return () => {
        alive = false;
        resize.disconnect();
        theme.disconnect();
      };
    }

    const animate = (now: number) => {
      if (!alive) {
        raf = 0;
        return;
      }
      draw(now - start);
      raf = window.requestAnimationFrame(animate);
    };
    const resize = new ResizeObserver(sizeCanvas);
    resize.observe(canvas);
    raf = window.requestAnimationFrame(animate);

    return () => {
      alive = false;
      if (raf) window.cancelAnimationFrame(raf);
      resize.disconnect();
    };
  }, [mounted]);

  if (!mounted) return null;

  const { background } = coilPalette(dark);
  const ink = dark ? '#ffffff' : '#000000';

  return (
    <div
      className={`${styles.overlay} ${idle ? '' : styles.leaving}`}
      style={{ background, opacity: idle && visible ? 1 : 0 }}
      aria-hidden="true"
      data-screensaver=""
    >
      <canvas ref={canvasRef} className={styles.canvas} />
      <Logo className={styles.mark} navyColor={ink} redColor={ink} />
    </div>
  );
}

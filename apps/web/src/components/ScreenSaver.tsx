import { useEffect, useRef, useState } from 'react';

import { useIdle } from '../hooks/useIdle';
import {
  bokehAt,
  bokehField,
  bokehPalette,
  bokehSprites,
} from '../lib/screensaver/bokeh';
import {
  COIL_DOT_RADIUS,
  coilBounds,
  coilDrift,
  coilPalette,
  fitCoil,
  rgba,
  sampleCoil,
  TENTACLE_SPREAD,
  TIME_PER_SECOND,
} from '../lib/screensaver/coil';
import { EXTERNAL_ACTIVITY_EVENT } from '../lib/screensaver/idle';
import { prefersReducedMotion } from '../utils';
import Logo from './Logo';

import styles from './ScreenSaver.module.css';

// Must match the stylesheet: .overlay's transition-duration, and .leaving's — the latter
// is also how long the overlay stays mounted after waking so the fade-out can play.
const FADE_IN_MS = 1200;
const FADE_OUT_MS = 320;

// Curve time the reduced-motion still is frozen at. Picked for a well-formed coil.
const STATIC_FRAME_T = 3.8;

// Canvas is a field of ~1px dots, so past 2x the extra fill buys nothing.
const MAX_DPR = 2;

const TAU = Math.PI * 2;
const NO_DRIFT = { x: 0, y: 0 };

/**
 * Takes over the whole window once the user has been idle (see `useIdle`) and hands it
 * back on the first real input: the app's own elements fade out and the coil is drawn
 * over the page's backdrop, in colours taken from that backdrop. Reduced motion gets the
 * same scene held on a single frame.
 *
 * The wordmark stays, dimmed, at the header logo's position — the app dissolves around
 * it. Note what that costs: in the desktop shell, where the title bar fades too, the mark
 * becomes the only thing on screen naming the app, and looking for a visa sponsor is
 * usually done from the job you are trying to leave. Gate it on
 * `window.isSponsorSearchDesktop` if that ever outweighs the branding.
 */
export default function ScreenSaver() {
  const idle = useIdle();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Mounted covers the fade-out too; visible drives the opacity transition itself.
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [held, setHeld] = useState(false);

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

  // Only take pointer events once the dissolve has finished. For its first second the page
  // underneath is still readable and still what the user is aiming at, so a click then
  // must reach the app — it wakes the screensaver on the way through, and the fade
  // reverses, instead of the overlay silently eating it and the click having to be redone.
  useEffect(() => {
    if (!mounted || !idle) {
      setHeld(false);
      return;
    }
    const timer = window.setTimeout(() => setHeld(true), FADE_IN_MS);
    return () => window.clearTimeout(timer);
  }, [mounted, idle]);

  // Tell the Electron shell so it can fade its native title bar out of the way.
  useEffect(() => {
    window.ssDesktop?.setScreenSaver?.(idle);
  }, [idle]);

  // The title bar is a separate view and main swallows the app's shortcuts before they
  // reach this document, so neither reaches our listeners — the shell forwards both and we
  // re-emit them as activity. `deliberate` rides along so a pointer merely crossing the
  // chrome counts as presence without dismissing a running screensaver.
  useEffect(
    () =>
      window.ssDesktop?.onChromeInput?.((deliberate) => {
        window.dispatchEvent(
          new CustomEvent(EXTERNAL_ACTIVITY_EVENT, { detail: { deliberate } }),
        );
      }),
    [],
  );

  // Fades the app's own elements out from under the coil (see the :global rule in the
  // stylesheet) — the page's backdrop is what the screensaver runs on. Carries a value
  // rather than being a bare flag so the fade has somewhere to transition back to.
  useEffect(() => {
    const root = document.documentElement;
    if (!mounted) {
      delete root.dataset['screensaver'];
      return;
    }
    root.dataset['screensaver'] = idle ? 'on' : 'off';
  }, [mounted, idle]);

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
    // Keeps its alpha: the coil is drawn onto the page's backdrop, not onto a field.
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduce = prefersReducedMotion();
    const start = performance.now();
    let raf = 0;
    let alive = true;

    const field = bokehField();
    // Discs are rebuilt only when the theme actually swaps them, not per frame.
    let discs: HTMLCanvasElement[] = [];
    let discKey = '';

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

    /** Blits the highlights sitting on one side of the coil. */
    const paintBokeh = (
      elapsedMs: number,
      front: boolean,
      dark: boolean,
      width: number,
      height: number,
    ) => {
      const { colours, composite, gain } = bokehPalette(dark);
      const key = colours.join();
      if (key !== discKey) {
        discKey = key;
        discs = bokehSprites(colours, rgba);
      }
      const short = Math.min(width, height);
      ctx.globalCompositeOperation = composite;
      for (const particle of field) {
        const sample = bokehAt(particle, elapsedMs);
        // Which side of the focal plane it's on decides which side of the coil it draws on.
        if (sample.front !== front) continue;
        const { x, y, alpha } = sample;
        const radius = sample.radius * short;
        const disc = discs[particle.colour % discs.length];
        if (!disc) continue;
        ctx.globalAlpha = alpha * gain;
        ctx.drawImage(
          disc,
          x * width - radius,
          y * height - radius,
          radius * 2,
          radius * 2,
        );
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    };

    /** Paint one frame; `elapsedMs` drives both the curve and its drift. */
    const draw = (elapsedMs: number) => {
      const { width, height } = canvas;
      // Read the live theme each frame, so an OS appearance change mid-screensaver follows.
      const dark = document.documentElement.classList.contains('dark');
      const { dotStops, tentacle } = coilPalette(dark);
      ctx.clearRect(0, 0, width, height);

      // Reduced motion holds the field at rest along with the coil.
      const bokehMs = reduce ? 0 : elapsedMs;
      paintBokeh(bokehMs, false, dark, width, height);

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

      // The few large, faint ones ride over the coil — that crossing is what sells depth.
      paintBokeh(bokehMs, true, dark, width, height);
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

  return (
    <div
      className={`${styles.overlay} ${idle ? '' : styles.leaving}`}
      style={{
        opacity: idle && visible ? 1 : 0,
        pointerEvents: held ? 'auto' : 'none',
      }}
      aria-hidden="true"
      data-screensaver=""
    >
      <canvas ref={canvasRef} className={styles.canvas} />
      {/* Mirrors Header.tsx's nesting so the mark lands on the header logo exactly. */}
      <div className={`${styles.markRow} px-4`}>
        <div className="page-wrap py-3 sm:py-4">
          <div className="inline-flex px-3 py-1.5">
            <Logo className={`${styles.mark} h-6 sm:h-8`} />
          </div>
        </div>
      </div>
      {/* The curve is @yuruyurau's; see the attribution in lib/screensaver/coil.ts. */}
      <p className={styles.credit}>original curve by @yuruyurau</p>
    </div>
  );
}

import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';

import { useIsMac } from '../hooks/useIsMac';
import { keycaps, type ShortcutId } from './headerShortcuts';

import styles from './HeaderTooltip.module.css';

/** Keep the bubble this far inside the viewport before falling back to end-aligned. */
const EDGE_PAD = 8;

interface HeaderTooltipProps {
  /** Terse chip label; the control keeps its own descriptive `aria-label`. */
  label: string;
  /** Shortcut whose keycaps sit under the label — omitted for controls without one. */
  shortcut?: ShortcutId;
  /**
   * `auto` centres on the trigger where that fits and falls back to end-aligned; the fixed
   * modes never measure. Both are plain CSS, so every mode renders correctly before JS runs.
   * Use `center` for a trigger wider than its bubble (end-aligning one detaches the caret)
   * and `end` where something else must share the bubble's edge.
   */
  align?: 'auto' | 'center' | 'end';
  /** Hide the chip while something else owns the slot below the button. */
  suppressed?: boolean;
  /** Display utility for the wrapper — the module deliberately sets none. */
  className: string;
  children: ReactNode;
}

/**
 * Wraps a header control in a hover/focus keycap chip, mirroring the shell's title-bar
 * tooltip. `aria-hidden` — the control's own `aria-label`/`aria-keyshortcuts` carry this.
 */
export default function HeaderTooltip({
  label,
  shortcut,
  align = 'auto',
  suppressed = false,
  className,
  children,
}: HeaderTooltipProps) {
  const isMac = useIsMac();
  const keys = shortcut ? keycaps(shortcut, isMac) : [];
  const wrapRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  // End-aligned until measured, matching the stylesheet — so SSR, no-JS and the first
  // client render all agree. Fixed modes are their own answer and never change.
  const [centred, setCentred] = useState(align === 'center');

  useLayoutEffect(() => {
    if (align !== 'auto') return;
    const wrap = wrapRef.current;
    const bubble = bubbleRef.current;
    if (!wrap || !bubble) return;

    const measure = () => {
      const trigger = wrap.getBoundingClientRect();
      const width = bubble.offsetWidth;
      // clientWidth, not innerWidth: `body { overflow-x: hidden }` clips at the content
      // box, so a classic scrollbar's width is not space the bubble can use.
      const limit = document.documentElement.clientWidth;
      const left = trigger.left + trigger.width / 2 - width / 2;
      setCentred(left >= EDGE_PAD && left + width <= limit - EDGE_PAD);
    };
    measure();

    // Coalesce to one read per frame — a drag-resize otherwise interleaves a forced layout
    // per tooltip per tick (the pattern CompanyTimeline uses for the same reason).
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };

    // Both measured boxes, because either can change without a window resize: the bubble
    // when Geist replaces the fallback font or the keycaps mount, the wrapper when the
    // cursor control goes from `display:none` to shown as a fine pointer appears.
    const observer = new ResizeObserver(schedule);
    observer.observe(wrap);
    observer.observe(bubble);
    // A viewport resize that leaves both boxes untouched still moves the limit.
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [align]);

  return (
    <span ref={wrapRef} className={`${styles.wrap} ${className}`}>
      {children}
      <span
        aria-hidden
        className={`${styles.tip}${suppressed ? ` ${styles.suppressed}` : ''}`}
      >
        <span
          ref={bubbleRef}
          className={`${styles.bubble} ${centred ? styles.center : styles.end}`}
        >
          <span className={styles.label}>{label}</span>
          {keys.length > 0 && (
            <span className={styles.keys}>
              {keys.map((k) => (
                <kbd key={k}>{k}</kbd>
              ))}
            </span>
          )}
        </span>
        {/* After the bubble, so it paints over the border under the point. */}
        <span className={styles.caret} />
      </span>
    </span>
  );
}

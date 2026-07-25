import { type ReactNode, useLayoutEffect, useRef } from 'react';

import { useIsMac } from '../hooks/useIsMac';
import { keycaps, type ShortcutId } from './headerShortcuts';

import styles from './HeaderTooltip.module.css';

/** Keep the bubble this far inside the viewport when the trigger sits near an edge. */
const EDGE_PAD = 8;

interface HeaderTooltipProps {
  /** Terse chip label; the control keeps its own descriptive `aria-label`. */
  label: string;
  /** Shortcut whose keycaps sit under the label — omitted for controls without one. */
  shortcut?: ShortcutId;
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
  suppressed = false,
  className,
  children,
}: HeaderTooltipProps) {
  const isMac = useIsMac();
  const keys = shortcut ? keycaps(shortcut, isMac) : [];
  const wrapRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);

  // Centre the bubble on the trigger, clamped inside the viewport — the shell's geometry,
  // which keeps the caret on the button while edge controls stay fully on screen. CSS alone
  // can't clamp, so this writes a delta from the right-aligned fallback the stylesheet uses
  // (safe pre-hydration: every trigger sits near an edge, so right-aligned never overflows).
  useLayoutEffect(() => {
    const place = () => {
      const wrap = wrapRef.current;
      const bubble = bubbleRef.current;
      if (!wrap || !bubble) return;
      const trigger = wrap.getBoundingClientRect();
      const width = bubble.offsetWidth;
      const centred = trigger.left + trigger.width / 2 - width / 2;
      const clamped = Math.min(
        Math.max(centred, EDGE_PAD),
        window.innerWidth - width - EDGE_PAD,
      );
      wrap.style.setProperty(
        '--tip-x',
        `${Math.round(clamped - (trigger.right - width))}px`,
      );
    };
    place();
    // Geist lands after mount and remeasures the bubble; without this the offset is
    // computed against the fallback font's width and stays stale.
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) place();
    });
    window.addEventListener('resize', place);
    return () => {
      live = false;
      window.removeEventListener('resize', place);
    };
    // Keycaps arrive at hydration and widen the bubble, so re-place when they do.
  }, [keys.length, label]);

  return (
    <span ref={wrapRef} className={`${styles.wrap} ${className}`}>
      {children}
      <span
        aria-hidden
        className={`${styles.tip}${suppressed ? ` ${styles.suppressed}` : ''}`}
      >
        <span ref={bubbleRef} className={styles.bubble}>
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

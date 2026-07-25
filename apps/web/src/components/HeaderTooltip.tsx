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

  // Centre the bubble on the trigger like the shell does, but only where it fits: otherwise
  // it stays end-aligned (right edge on the trigger's), which never runs off screen. That
  // end-aligned position is the stylesheet's default, so `--tip-x: 0` IS the fallback — and
  // it's what renders pre-hydration. The caret is CSS-centred on the trigger either way.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const bubble = bubbleRef.current;
    if (!wrap || !bubble) return;

    const place = () => {
      const trigger = wrap.getBoundingClientRect();
      const width = bubble.offsetWidth;
      // clientWidth, not innerWidth: `body { overflow-x: hidden }` clips at the content
      // box, so a classic scrollbar's width is not space the bubble can use.
      const limit = document.documentElement.clientWidth;
      const centred = trigger.left + trigger.width / 2 - width / 2;
      const fits = centred >= EDGE_PAD && centred + width <= limit - EDGE_PAD;
      wrap.style.setProperty(
        '--tip-x',
        fits ? `${Math.round(centred - (trigger.right - width))}px` : '0px',
      );
    };
    place();
    // Both measured boxes, because either can change without a window resize: the bubble
    // when Geist replaces the fallback font, the wrapper when the cursor control goes from
    // `display:none` to shown as a fine pointer appears (measuring it at 0 gives a bogus
    // offset that nothing else would correct). `--tip-x` only drives `translate`, so
    // re-placing can't resize either box and feed the observer.
    const observer = new ResizeObserver(place);
    observer.observe(wrap);
    observer.observe(bubble);
    // A viewport resize that leaves both boxes untouched still moves the clamp.
    window.addEventListener('resize', place);
    return () => {
      observer.disconnect();
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

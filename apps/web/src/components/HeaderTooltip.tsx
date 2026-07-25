import type { ReactNode } from 'react';

import { useIsMac } from '../hooks/useIsMac';
import { keycaps, type ShortcutId } from './headerShortcuts';

import styles from './HeaderTooltip.module.css';

interface HeaderTooltipProps {
  /** Terse chip label; the control keeps its own descriptive `aria-label`. */
  label: string;
  /** Shortcut whose keycaps sit under the label — omitted for controls without one. */
  shortcut?: ShortcutId;
  /** Which trigger edge the bubble hangs off. `end` keeps the right-hand cluster on screen. */
  align?: 'center' | 'end';
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
  align = 'center',
  suppressed = false,
  className,
  children,
}: HeaderTooltipProps) {
  const isMac = useIsMac();
  const keys = shortcut ? keycaps(shortcut, isMac) : [];

  return (
    <span className={`${styles.wrap} ${className}`}>
      {children}
      <span
        aria-hidden
        className={`${styles.tip}${suppressed ? ` ${styles.suppressed}` : ''}`}
      >
        <span
          className={`${styles.bubble} ${align === 'end' ? styles.end : styles.center}`}
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

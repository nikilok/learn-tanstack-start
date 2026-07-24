import { ChevronDown } from 'lucide-react';
import { useEffect, useState } from 'react';

import styles from './Accordion.module.css';

/**
 * Disclosure section in the download page's accordion language: hairline
 * divider that wipes blue on open, kicker title, an optional dashed count
 * pill on the far right (this section's contribution to the active-filter
 * total), and the animated grid-rows reveal. Controlled — the parent owns
 * open state. The panel's clip lifts once the open transition settles so
 * popover children (selects, date pickers) can escape the bounds.
 */
export default function Accordion({
  id,
  title,
  shortcut,
  count = 0,
  open,
  onToggle,
  children,
}: {
  id?: string;
  title: string;
  /** Keyboard hint rendered as a kbd chip next to the title (e.g. "⌘1"). */
  shortcut?: string;
  count?: number;
  open: boolean;
  onToggle: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const [settled, setSettled] = useState(open);
  useEffect(() => {
    if (!open) {
      setSettled(false);
      return;
    }
    const timer = setTimeout(() => setSettled(true), 470);
    return () => clearTimeout(timer);
  }, [open]);

  return (
    <details
      id={id}
      open={open}
      onToggle={(e) => {
        // React simulates bubbling for `toggle`, so a nested <details> in
        // the panel (Industry's SIC sub-sections) would close this whole
        // section. Only this element's own toggles count.
        if (e.target !== e.currentTarget) return;
        onToggle((e.target as HTMLDetailsElement).open);
      }}
      className={`group scroll-mt-24 ${styles.item}`}
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 py-5 [&::-webkit-details-marker]:hidden">
        <span className="island-kicker">{title}</span>
        {shortcut && (
          <kbd className="hidden font-sans text-[11px] pointer-fine:inline">
            {shortcut}
          </kbd>
        )}
        <span className="ml-auto flex items-center gap-3">
          {count > 0 && (
            <span
              aria-label={`${count} active`}
              className="flex h-5 min-w-5 items-center justify-center rounded-full border border-dashed border-(--sea-ink)/50 px-1 text-[11px] leading-none font-semibold text-(--sea-ink)"
            >
              {count}
            </span>
          )}
          <ChevronDown
            className="size-4 text-(--sea-ink-soft) transition-transform group-open:rotate-180"
            aria-hidden
          />
        </span>
      </summary>
      <div className={`${styles.panel} ${settled ? styles.panelOpen : ''}`}>
        <div className="pt-1 pb-8">{children}</div>
      </div>
    </details>
  );
}

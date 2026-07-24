import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

export type SelectOption = { value: string; label: string };

/**
 * Custom select: a pill trigger opening a glass popover listbox, styled with
 * the site's tokens (native <select> popups can't be). Keyboard: Enter/Space/
 * arrows open, arrows move, Enter picks, Escape closes; outside pointerdown
 * closes. Focus stays on the trigger (activedescendant pattern), so there's
 * no tab trap.
 */
export default function Select({
  value,
  options,
  onChange,
  ariaLabel,
  triggerClassName = '',
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selectedIndex = options.findIndex((opt) => opt.value === value);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const openList = () => {
    setOpen(true);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
  };
  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Modifier combos belong to page-level shortcuts (⌘+Enter, ⌥+digit).
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!open) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
        e.preventDefault();
        openList();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const active = options[activeIndex];
      if (active) choose(active.value);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className="relative w-fit">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={
          open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined
        }
        aria-label={ariaLabel}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
        className={`flex cursor-pointer items-center gap-1.5 rounded-full border border-(--sea-ink)/15 bg-transparent py-1.5 pr-3 pl-4 text-sm text-(--sea-ink) transition hover:border-(--sea-ink)/40 ${triggerClassName}`}
      >
        {options[selectedIndex]?.label ?? value}
        <ChevronDown
          className={`size-3.5 shrink-0 text-(--sea-ink-soft) transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="glass absolute top-full left-0 z-30 m-0 mt-1.5 w-max min-w-full list-none rounded-2xl p-1.5 backdrop-blur-md!"
        >
          {options.map((opt, index) => (
            <li
              key={opt.value}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={opt.value === value}
            >
              <button
                type="button"
                tabIndex={-1}
                onPointerEnter={() => setActiveIndex(index)}
                onClick={() => choose(opt.value)}
                className={`flex w-full cursor-pointer items-center justify-between gap-4 rounded-xl border-none px-3 py-1.5 text-left text-sm text-(--sea-ink) transition ${
                  index === activeIndex
                    ? 'bg-(--link-bg-hover)'
                    : 'bg-transparent'
                }`}
              >
                {opt.label}
                {opt.value === value && (
                  <Check
                    className="size-3.5 shrink-0 text-(--sea-ink-soft)"
                    aria-hidden
                  />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

import {
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const MIN_YEAR = 1800;
const MAX_YEAR = new Date().getFullYear();
const YEARS_PER_PAGE = 16;

type Ymd = { y: number; m: number; d: number };

/** Parse a YYYY-MM-DD string into numeric parts; null when malformed. */
function parseIso(value: string | undefined): Ymd | null {
  const m = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]) - 1, d: Number(m[3]) };
}

/** Format numeric parts back to YYYY-MM-DD. */
function toIso({ y, m, d }: Ymd): string {
  return `${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Shift a date by whole days, rolling months/years via Date arithmetic. */
function shiftDays(date: Ymd, delta: number): Ymd {
  const next = new Date(date.y, date.m, date.d + delta);
  return { y: next.getFullYear(), m: next.getMonth(), d: next.getDate() };
}

const dayCount = (y: number, m: number) => new Date(y, m + 1, 0).getDate();
// Monday-first column index of a month's first day.
const firstColumn = (y: number, m: number) =>
  (new Date(y, m, 1).getDay() + 6) % 7;

/**
 * Custom calendar date picker matching the Select's language: a pill trigger
 * opening a glass popover. Clicking the month label switches to a year grid
 * (incorporation dates span two centuries — stepping months doesn't scale).
 * Keyboard on the trigger: Enter/Space opens, arrows move a day (±1/±7),
 * Enter picks, Escape closes. Emits YYYY-MM-DD or undefined (Clear).
 */
export default function DatePicker({
  value,
  onChange,
  placeholder,
  align = 'left',
  min,
  disabled = false,
}: {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  placeholder: string;
  align?: 'left' | 'right';
  /** Earliest selectable date (YYYY-MM-DD); earlier days render disabled. */
  min?: string;
  /** Disables the trigger entirely (e.g. a To picker before From exists). */
  disabled?: boolean;
}) {
  const selected = parseIso(value);
  const minDate = parseIso(min);
  const isBeforeMin = (date: Ymd) => (min ? toIso(date) < min : false);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'days' | 'years'>('days');
  const today = (() => {
    const now = new Date();
    return { y: now.getFullYear(), m: now.getMonth(), d: now.getDate() };
  })();
  const [active, setActive] = useState<Ymd>(selected ?? today);
  const [yearPage, setYearPage] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const openPicker = () => {
    const seed =
      parseIso(value) ?? (minDate && isBeforeMin(today) ? minDate : today);
    setActive(seed);
    setYearPage(Math.floor((seed.y - MIN_YEAR) / YEARS_PER_PAGE));
    setView('days');
    setOpen(true);
  };
  const choose = (date: Ymd) => {
    onChange(toIso(date));
    setOpen(false);
  };
  const clear = () => {
    onChange(undefined);
    setOpen(false);
  };

  const stepMonth = (delta: number) => {
    const next = new Date(active.y, active.m + delta, 1);
    if (next.getFullYear() < MIN_YEAR || next.getFullYear() > MAX_YEAR) return;
    const clampedDay = Math.min(
      active.d,
      dayCount(next.getFullYear(), next.getMonth()),
    );
    setActive({ y: next.getFullYear(), m: next.getMonth(), d: clampedDay });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Modifier combos belong to page-level shortcuts (⌘+Enter, ⌥+digit).
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Backspace/Delete clears the picked date, open or closed.
    if ((e.key === 'Backspace' || e.key === 'Delete') && value) {
      e.preventDefault();
      clear();
      return;
    }
    if (!open) {
      if (['Enter', ' ', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
        openPicker();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === 'Tab') {
      setOpen(false);
      return;
    }
    const dayDelta =
      e.key === 'ArrowLeft'
        ? -1
        : e.key === 'ArrowRight'
          ? 1
          : e.key === 'ArrowUp'
            ? -7
            : e.key === 'ArrowDown'
              ? 7
              : 0;
    if (view === 'days' && dayDelta !== 0) {
      e.preventDefault();
      const next = shiftDays(active, dayDelta);
      if (next.y >= MIN_YEAR && next.y <= MAX_YEAR && !isBeforeMin(next)) {
        setActive(next);
      }
      return;
    }
    if (e.key === 'Enter' && view === 'days') {
      e.preventDefault();
      if (!isBeforeMin(active)) choose(active);
    }
  };

  const yearsStart = MIN_YEAR + yearPage * YEARS_PER_PAGE;
  const years = Array.from(
    { length: YEARS_PER_PAGE },
    (_, i) => yearsStart + i,
  ).filter((y) => y <= MAX_YEAR);

  const blanks = firstColumn(active.y, active.m);
  const days = Array.from(
    { length: dayCount(active.y, active.m) },
    (_, i) => i + 1,
  );
  const isSelected = (d: number) =>
    selected?.y === active.y && selected.m === active.m && selected.d === d;
  const isActiveDay = (d: number) => active.d === d;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={value ? `${placeholder}: ${value}` : placeholder}
        onClick={() => (open ? setOpen(false) : openPicker())}
        onKeyDown={onKeyDown}
        className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-full border border-(--sea-ink)/15 bg-transparent px-4 py-2 text-sm transition hover:border-(--sea-ink)/40 disabled:cursor-default disabled:opacity-40 disabled:hover:border-(--sea-ink)/15"
      >
        <span className="flex min-w-0 items-center gap-2">
          <CalendarDays
            className="size-4 shrink-0 text-(--sea-ink-soft)"
            aria-hidden
          />
          <span
            className={`truncate ${value ? 'text-(--sea-ink)' : 'text-(--sea-ink-soft)'}`}
          >
            {selected
              ? `${selected.d} ${MONTHS[selected.m].slice(0, 3)} ${selected.y}`
              : placeholder}
          </span>
        </span>
        <ChevronDown
          className={`size-3.5 shrink-0 text-(--sea-ink-soft) transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={`${placeholder} date`}
          className={`glass absolute top-full z-30 mt-1.5 w-max rounded-2xl p-3 backdrop-blur-md! ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              tabIndex={-1}
              aria-label="Previous"
              onClick={() =>
                view === 'days'
                  ? stepMonth(-1)
                  : setYearPage((p) => Math.max(0, p - 1))
              }
              className="flex size-7 cursor-pointer items-center justify-center rounded-full border-none bg-transparent text-(--sea-ink-soft) transition hover:bg-(--link-bg-hover) hover:text-(--sea-ink)"
            >
              <ChevronLeft className="size-4" aria-hidden />
            </button>
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setView(view === 'days' ? 'years' : 'days')}
              className="cursor-pointer rounded-full border-none bg-transparent px-3 py-1 text-sm font-medium text-(--sea-ink) transition hover:bg-(--link-bg-hover)"
            >
              {view === 'days'
                ? `${MONTHS[active.m]} ${active.y}`
                : `${yearsStart}–${Math.min(yearsStart + YEARS_PER_PAGE - 1, MAX_YEAR)}`}
            </button>
            <button
              type="button"
              tabIndex={-1}
              aria-label="Next"
              onClick={() =>
                view === 'days'
                  ? stepMonth(1)
                  : setYearPage((p) =>
                      yearsStart + YEARS_PER_PAGE <= MAX_YEAR ? p + 1 : p,
                    )
              }
              className="flex size-7 cursor-pointer items-center justify-center rounded-full border-none bg-transparent text-(--sea-ink-soft) transition hover:bg-(--link-bg-hover) hover:text-(--sea-ink)"
            >
              <ChevronRight className="size-4" aria-hidden />
            </button>
          </div>

          {view === 'years' ? (
            <div className="mt-2 grid grid-cols-4 gap-1">
              {years.map((y) => (
                <button
                  key={y}
                  type="button"
                  tabIndex={-1}
                  disabled={minDate ? y < minDate.y : false}
                  onClick={() => {
                    setActive((a) => ({
                      y,
                      m: a.m,
                      d: Math.min(a.d, dayCount(y, a.m)),
                    }));
                    setView('days');
                  }}
                  className={`cursor-pointer rounded-lg border-none px-2 py-1.5 text-sm transition disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent ${
                    y === active.y
                      ? 'bg-(--link-blue) text-white'
                      : 'bg-transparent text-(--sea-ink) hover:bg-(--link-bg-hover)'
                  }`}
                >
                  {y}
                </button>
              ))}
            </div>
          ) : (
            <>
              <div className="mt-2 grid grid-cols-7 gap-y-0.5 text-center">
                {WEEKDAYS.map((wd) => (
                  <span
                    key={wd}
                    className="text-xs font-medium text-(--sea-ink-soft)"
                  >
                    {wd}
                  </span>
                ))}
                {Array.from({ length: blanks }, (_, i) => (
                  <span key={`blank-${i}`} />
                ))}
                {days.map((d) => (
                  <button
                    key={d}
                    type="button"
                    tabIndex={-1}
                    disabled={isBeforeMin({ y: active.y, m: active.m, d })}
                    aria-label={`${d} ${MONTHS[active.m]} ${active.y}`}
                    aria-current={isSelected(d) ? 'date' : undefined}
                    onClick={() => choose({ y: active.y, m: active.m, d })}
                    className={`flex size-8 cursor-pointer items-center justify-center justify-self-center rounded-full border-none text-sm transition disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent ${
                      isSelected(d)
                        ? 'bg-(--link-blue) text-white'
                        : isActiveDay(d)
                          ? 'bg-(--link-bg-hover) text-(--sea-ink)'
                          : 'bg-transparent text-(--sea-ink) hover:bg-(--link-bg-hover)'
                    }`}
                  >
                    {d}
                  </button>
                ))}
              </div>
              <div className="mt-2 flex justify-end border-t border-(--sea-ink)/10 pt-2">
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={clear}
                  className="cursor-pointer border-none bg-transparent p-0 text-xs text-(--sea-ink-soft) transition hover:text-(--sea-ink)"
                >
                  Clear
                  <kbd className="ml-1.5 hidden font-sans text-[11px] pointer-fine:inline">
                    ⌫
                  </kbd>
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

import {
  type CSSProperties,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import type { TimelineEvent, TimelineTone } from '../lib/timeline/types';
import { AddressChangeMap } from './AddressChangeMap';

import styles from './CompanyTimeline.module.css';

// Measure the rail before paint on the client (no connector flash); on the
// server this is useEffect (a no-op there — avoids the SSR layout-effect warning).
const useIsoLayoutEffect =
  typeof document !== 'undefined' ? useLayoutEffect : useEffect;

// Change events shown before the expand button reveals the rest.
const INITIAL_VISIBLE = 8;

// Event dates in brand red (matching the highlighted search name) so they
// anchor each row — same 10px uppercase scale as the shared LABEL_CLASS.
const DATE_CLASS =
  'text-[10px] font-medium tracking-wider text-(--logo-red) uppercase';

// Dots share StatusBadge's --status-* palette; neutral is a hollow ring.
const TONE_DOT: Record<TimelineTone, string> = {
  positive: 'bg-(--status-green)',
  warning: 'bg-(--status-amber)',
  negative: 'bg-(--status-red)',
  neutral: 'border border-(--sea-ink-soft) bg-(--sponsor-card-bg)',
};

/** Rail gutter cell: one row's tone dot riding the shared gradient rail. */
function RailCell({ tone }: { tone?: TimelineTone }) {
  return (
    <span className="relative w-2 shrink-0" aria-hidden>
      {tone && (
        <span
          data-timeline-dot
          className={`absolute top-2 left-1/2 size-2 -translate-x-1/2 rounded-full ${TONE_DOT[tone]}`}
        />
      )}
    </span>
  );
}

/** Whether an event is a context anchor rather than an observed change. */
function isAnchor(event: TimelineEvent) {
  return event.kind === 'tracking-start' || event.kind === 'incorporated';
}

/** Inline "A → B" for short values, stacked old/new lines for long ones. */
function ChangeDetail({ from, to }: { from: string; to: string }) {
  if (from.length + to.length <= 40) {
    return (
      <p className="text-sm text-(--sea-ink)">
        <span className="text-(--sea-ink-soft)">{from}</span>
        {' → '}
        {to}
      </p>
    );
  }
  return (
    <>
      <p className="text-sm text-(--sea-ink-soft)">{from}</p>
      <p className="text-sm text-(--sea-ink)">→ {to}</p>
    </>
  );
}

type Row = { type: 'event'; event: TimelineEvent } | { type: 'button' };

/**
 * Vertical change-history timeline for a company's Companies House record,
 * rendered from server-curated events (newest first, anchors interleaved by
 * date). Collapses long histories behind a "show earlier" toggle; anchors
 * stay visible while collapsed.
 */
export function CompanyTimeline({ events }: { events: TimelineEvent[] }) {
  const [expanded, setExpanded] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [rail, setRail] = useState<{ top: number; height: number } | null>(
    null,
  );

  // First non-anchor event past the fold — the anchors below the fold stay
  // visible while collapsed, so this (not INITIAL_VISIBLE) is what expanding
  // newly reveals. In the expanded list DOM index === event index (no button).
  const firstRevealedIndex = events.findIndex(
    (event, i) => i >= INITIAL_VISIBLE && !isAnchor(event),
  );

  // Expanding unmounts the button — move focus to the first revealed change so
  // keyboard/screen-reader users aren't dropped back to <body>.
  useEffect(() => {
    if (!expanded || firstRevealedIndex < 0) return;
    const revealed = listRef.current?.children.item(firstRevealedIndex);
    if (revealed instanceof HTMLElement) revealed.focus();
  }, [expanded, firstRevealedIndex]);

  // Span the gradient rail from the first dot's centre to the last dot's,
  // measured in the wrapper's frame (the rail's offset parent — the "No changes
  // observed yet." note offsets the <ol> from it). A ResizeObserver re-measures
  // on ANY in-list reflow — a map collapsing on a failed geocode, a font swap,
  // expand — not just window resize. rAF-coalesced and value-guarded so a no-op
  // measure doesn't re-render the timeline (Leaflet rows included).
  useIsoLayoutEffect(() => {
    const ol = listRef.current;
    const wrap = wrapRef.current;
    if (!ol || !wrap) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const dots = ol.querySelectorAll<HTMLElement>('[data-timeline-dot]');
      if (dots.length < 2) {
        setRail((prev) => (prev === null ? prev : null));
        return;
      }
      const baseTop = wrap.getBoundingClientRect().top;
      const first = dots[0].getBoundingClientRect();
      const last = dots[dots.length - 1].getBoundingClientRect();
      const top = first.top - baseTop + first.height / 2;
      const height = last.top - baseTop + last.height / 2 - top;
      setRail((prev) =>
        prev && prev.top === top && prev.height === height
          ? prev
          : { top, height },
      );
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(ol);
    return () => {
      observer.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [events, expanded]);

  const tail = events.slice(INITIAL_VISIBLE);
  const hiddenChanges = tail.filter((event) => !isAnchor(event)).length;
  const collapsed = !expanded && hiddenChanges > 1;
  const visible = collapsed
    ? [...events.slice(0, INITIAL_VISIBLE), ...tail.filter(isAnchor)]
    : events;
  const noChanges = events.every(isAnchor);
  // The rail connects dot to dot, so it only shows with ≥2 dotted rows.
  // Computed from the data (not measurement) so the connector is in the SSR
  // HTML and survives no-JS/pre-hydration; the measured style refines it.
  const showRail = visible.filter((event) => event.tone).length >= 2;

  // The expand button is its own row so it exists even when no anchors
  // survive into the collapsed tail.
  const rows: Row[] = visible.map((event) => ({ type: 'event', event }));
  if (collapsed) rows.splice(INITIAL_VISIBLE, 0, { type: 'button' });

  // Measured span once JS runs; otherwise the full-height CSS fallback (so the
  // connector is in the SSR HTML / no-JS). Exception: in the noChanges state the
  // "No changes observed yet." note sits in the wrapper and a full-height
  // fallback would run up through it — hold it hidden there until measured.
  const railStyle: CSSProperties | undefined = rail
    ? { top: rail.top, height: rail.height }
    : noChanges
      ? { display: 'none' }
      : undefined;

  return (
    <div ref={wrapRef} className="relative mt-1">
      {noChanges && (
        <p className="mb-2 text-sm text-(--sea-ink-soft)">
          No changes observed yet.
        </p>
      )}
      {showRail && (
        <span className={styles.railTrack} style={railStyle} aria-hidden />
      )}
      <ol
        ref={listRef}
        className="m-0 list-none p-0"
        aria-label="Company change history"
      >
        {rows.map((row, i) => {
          const isLast = i === rows.length - 1;

          if (row.type === 'button') {
            return (
              <li key="show-earlier" className="flex gap-2.5">
                <RailCell />
                <button
                  type="button"
                  onClick={() => setExpanded(true)}
                  className="mb-4 w-fit cursor-pointer text-sm text-(--sea-ink-soft) underline decoration-(--sea-ink-soft)/40 underline-offset-2 hover:text-(--sea-ink)"
                >
                  Show {hiddenChanges} earlier changes
                </button>
              </li>
            );
          }

          const { event } = row;
          const anchor = isAnchor(event);
          return (
            <li
              key={event.id}
              className={`${styles.event} flex gap-2.5`}
              tabIndex={expanded && i === firstRevealedIndex ? -1 : undefined}
            >
              <RailCell tone={event.tone} />
              <div className={`min-w-0 grow ${isLast ? '' : 'pb-4'}`}>
                <time dateTime={event.dateISO} className={DATE_CLASS}>
                  {event.dateLabel}
                </time>
                <p
                  className={
                    anchor
                      ? 'text-sm text-(--sea-ink-soft)'
                      : 'text-sm font-medium text-(--sea-ink)'
                  }
                >
                  {event.title}
                </p>
                {event.from && event.to && (
                  <ChangeDetail from={event.from} to={event.to} />
                )}
                {event.detail && (
                  <p className="text-sm whitespace-pre-line text-(--sea-ink-soft)">
                    {event.detail}
                  </p>
                )}
                {event.mappable && event.from && event.to && (
                  <AddressChangeMap from={event.from} to={event.to} />
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

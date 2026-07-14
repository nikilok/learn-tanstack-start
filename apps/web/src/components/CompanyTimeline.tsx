import { useEffect, useRef, useState } from 'react';

import type { TimelineEvent, TimelineTone } from '../lib/timeline/types';
import { AddressChangeMap } from './AddressChangeMap';
import { LABEL_CLASS } from './DetailField';

import styles from './CompanyTimeline.module.css';

// Change events shown before the expand button reveals the rest.
const INITIAL_VISIBLE = 8;

// Dots share StatusBadge's --status-* palette; neutral is a hollow ring.
const TONE_DOT: Record<TimelineTone, string> = {
  positive: 'bg-(--status-green)',
  warning: 'bg-(--status-amber)',
  negative: 'bg-(--status-red)',
  neutral: 'border border-(--sea-ink-soft) bg-(--sponsor-card-bg)',
};

type RailLine = 'start' | 'middle' | 'end' | 'none';

const RAIL_LINE: Record<RailLine, string> = {
  start: 'top-2.5 bottom-0',
  middle: 'inset-y-0',
  end: 'top-0 h-3',
  none: 'hidden',
};

/** Rail gutter cell: one row's connector-line segment plus optional tone dot. */
function RailCell({ line, tone }: { line: RailLine; tone?: TimelineTone }) {
  return (
    <span className="relative w-2 shrink-0" aria-hidden>
      <span
        className={`absolute left-1/2 w-px -translate-x-1/2 bg-(--sea-ink-soft)/30 ${RAIL_LINE[line]}`}
      />
      {tone && (
        <span
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

  const tail = events.slice(INITIAL_VISIBLE);
  const hiddenChanges = tail.filter((event) => !isAnchor(event)).length;
  const collapsed = !expanded && hiddenChanges > 1;
  const visible = collapsed
    ? [...events.slice(0, INITIAL_VISIBLE), ...tail.filter(isAnchor)]
    : events;
  const noChanges = events.every(isAnchor);

  // The expand button is its own row so it exists even when no anchors
  // survive into the collapsed tail.
  const rows: Row[] = visible.map((event) => ({ type: 'event', event }));
  if (collapsed) rows.splice(INITIAL_VISIBLE, 0, { type: 'button' });

  return (
    <div className="mt-1">
      {noChanges && (
        <p className="mb-2 text-sm text-(--sea-ink-soft)">
          No changes observed yet.
        </p>
      )}
      <ol
        ref={listRef}
        className="m-0 list-none p-0"
        aria-label="Company change history"
      >
        {rows.map((row, i) => {
          const isLast = i === rows.length - 1;
          const line: RailLine =
            rows.length === 1
              ? 'none'
              : i === 0
                ? 'start'
                : isLast
                  ? 'end'
                  : 'middle';

          if (row.type === 'button') {
            return (
              <li key="show-earlier" className="flex gap-2.5">
                <RailCell line={line} />
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
              <RailCell line={line} tone={event.tone} />
              <div className={`min-w-0 grow ${isLast ? '' : 'pb-4'}`}>
                <time dateTime={event.dateISO} className={LABEL_CLASS}>
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

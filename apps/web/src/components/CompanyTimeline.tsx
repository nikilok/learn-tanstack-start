import { useState } from 'react';

import type { TimelineEvent, TimelineTone } from '../lib/timeline/types';
import { LABEL_CLASS } from './DetailField';

// Change events shown before the expand button reveals the rest.
const INITIAL_VISIBLE = 8;

// Dot colors reuse StatusBadge's theme-paired shades; neutral is a hollow
// ring like NameHistory's previous-name dots.
const TONE_DOT: Record<TimelineTone, string> = {
  positive: 'bg-[#166534] dark:bg-[#4ade80]',
  warning: 'bg-[#92400e] dark:bg-[#fbbf24]',
  negative: 'bg-[#b91c1c] dark:bg-[#f87171]',
  neutral: 'border border-(--sea-ink-soft) bg-(--sponsor-card-bg)',
};

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

/**
 * Vertical change-history timeline for a company's Companies House record,
 * rendered from server-curated events (newest first, anchors interleaved by
 * date). Collapses long histories behind a "show earlier" toggle; anchors
 * stay visible while collapsed.
 */
export function CompanyTimeline({ events }: { events: TimelineEvent[] }) {
  const [expanded, setExpanded] = useState(false);

  const tail = events.slice(INITIAL_VISIBLE);
  const hiddenChanges = tail.filter((event) => !isAnchor(event)).length;
  const collapsed = !expanded && hiddenChanges > 1;
  const visible = collapsed
    ? [...events.slice(0, INITIAL_VISIBLE), ...tail.filter(isAnchor)]
    : events;
  const noChanges = events.every(isAnchor);

  return (
    <div className="mt-1">
      {noChanges && (
        <p className="mb-2 text-sm text-(--sea-ink-soft)">
          No changes observed yet.
        </p>
      )}
      <ol className="m-0 list-none p-0" aria-label="Company change history">
        {visible.map((event, i) => {
          const isLast = i === visible.length - 1;
          const anchor = isAnchor(event);
          const showButton = collapsed && i === INITIAL_VISIBLE;
          return (
            <li key={event.id} className="flex flex-col">
              {showButton && (
                <div className="flex gap-2.5">
                  <span className="relative w-2 shrink-0" aria-hidden>
                    <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-(--sea-ink-soft)/30" />
                  </span>
                  <button
                    type="button"
                    aria-expanded={false}
                    onClick={() => setExpanded(true)}
                    className="mb-4 w-fit cursor-pointer text-sm text-(--sea-ink-soft) underline decoration-(--sea-ink-soft)/40 underline-offset-2 hover:text-(--sea-ink)"
                  >
                    Show {hiddenChanges} earlier changes
                  </button>
                </div>
              )}
              <div className="flex gap-2.5">
                <span className="relative w-2 shrink-0" aria-hidden>
                  <span
                    className={`absolute left-1/2 w-px -translate-x-1/2 bg-(--sea-ink-soft)/30 ${
                      isLast
                        ? 'top-0 h-3'
                        : i === 0
                          ? 'top-2.5 bottom-0'
                          : 'inset-y-0'
                    } ${visible.length === 1 ? 'hidden' : ''}`}
                  />
                  <span
                    className={`absolute top-2 left-1/2 size-2 -translate-x-1/2 rounded-full ${TONE_DOT[event.tone]}`}
                  />
                </span>
                <div className={`min-w-0 ${isLast ? '' : 'pb-4'}`}>
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
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

import { type ReactNode } from 'react';

import { titleCase } from '../utils';

/**
 * Renders the company's current name, plus any previous names as a vertical
 * "formerly known as" timeline linked by a connecting line. Falls back to a plain
 * heading when there are no previous names; `children` (subtitle, industry) render
 * inside the current-name node so they stay attached to it. Previous names are
 * title-cased for display; the caller passes them already deduped.
 */
export function NameHistory({
  currentName,
  previousNames,
  children,
}: {
  currentName: string;
  previousNames: string[];
  children?: ReactNode;
}) {
  const head = (
    <>
      <h1 className="text-xl font-semibold text-(--sea-ink)">{currentName}</h1>
      {children}
    </>
  );

  if (previousNames.length === 0) return head;

  return (
    <div>
      {/* Current name: a standalone heading, not part of the history list. */}
      <div className="flex gap-2.5">
        <span className="relative w-2 shrink-0" aria-hidden>
          <span className="absolute top-3.5 bottom-0 left-1/2 w-px -translate-x-1/2 bg-(--sea-ink-soft)/30" />
          <span className="absolute top-2.5 left-1/2 size-2 -translate-x-1/2 rounded-full bg-(--sea-ink)" />
        </span>
        <div className="min-w-0 pb-2">{head}</div>
      </div>
      <ol className="m-0 list-none p-0" aria-label="Previous company names">
        {previousNames.map((name, i) => {
          const isLast = i === previousNames.length - 1;
          return (
            <li key={`${name}-${i}`} className="flex gap-2.5">
              <span className="relative w-2 shrink-0" aria-hidden>
                <span
                  className={`absolute left-1/2 w-px -translate-x-1/2 bg-(--sea-ink-soft)/30 ${
                    isLast ? 'top-0 h-2.5' : 'inset-y-0'
                  }`}
                />
                <span className="absolute top-1.5 left-1/2 size-2 -translate-x-1/2 rounded-full border border-(--sea-ink-soft) bg-(--sponsor-card-bg)" />
              </span>
              <span
                className={`min-w-0 text-sm text-(--sea-ink-soft) ${isLast ? '' : 'pb-2'}`}
              >
                {titleCase(name)}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

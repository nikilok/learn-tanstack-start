import { LABEL_CLASS } from './DetailField';

// Same fill/hairline as the licence rows, so the markers read as part of the card.
const MARKER_CLASS =
  'flex size-5 shrink-0 items-center justify-center rounded-full bg-(--card-row-bg) text-[10px] font-medium text-(--sea-ink-soft) tabular-nums ring-1 ring-(--card-row-line) ring-inset';

const LIST_CLASS = 'mt-1.5 flex flex-col gap-1.5 text-sm text-(--sea-ink-soft)';

// size-5 marker = the text's 20px line box, so it sits on the first line.
const ROW_CLASS = 'flex items-start gap-2';

/** The company header's industry block: one numbered SIC description per line, each followed by its code, bracketed so it can be copied into a `sic` filter search. */
export function CompanyIndustry({
  entries,
}: {
  entries: { code: string; description: string }[];
}) {
  if (entries.length === 0) return null;
  return (
    <div className="mt-3">
      <p className={LABEL_CLASS}>Industry (SIC Codes)</p>
      {/* role="list": Tailwind's preflight sets list-style:none, which drops list semantics (and the "n of m" position) in WebKit. */}
      <ol role="list" className={LIST_CLASS}>
        {entries.map((sic, i) => (
          <li key={sic.code} className={ROW_CLASS}>
            {/* Decorative: the list itself carries the ordinal. */}
            <span aria-hidden="true" className={MARKER_CLASS}>
              {i + 1}
            </span>
            <span>
              {sic.description}{' '}
              {/* Literal so iOS doesn't turn a bare 5-digit code into a phone link. */}
              <span
                className="text-(--sea-ink) tabular-nums"
                x-apple-data-detectors="false"
              >
                ({sic.code})
              </span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The industry block before its codes load: its title, and one numbered line held by a bar, as most companies have one code. */
export function CompanyIndustryPending() {
  return (
    <div className="mt-3">
      <p className={LABEL_CLASS}>Industry (SIC Codes)</p>
      <ol role="list" className={LIST_CLASS}>
        <li className={ROW_CLASS}>
          <span aria-hidden="true" className={MARKER_CLASS}>
            1
          </span>
          <span aria-hidden className="flex h-5 grow items-center">
            <span className="h-3.5 w-3/4 rounded bg-(--sea-ink-soft)/15 motion-safe:animate-pulse" />
          </span>
        </li>
      </ol>
    </div>
  );
}

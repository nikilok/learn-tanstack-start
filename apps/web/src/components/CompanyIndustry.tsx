import { LABEL_CLASS } from './DetailField';

// Same fill/hairline as the licence rows, so the markers read as part of the card.
const MARKER_CLASS =
  'flex size-5 shrink-0 items-center justify-center rounded-full bg-(--card-row-bg) text-[10px] font-medium text-(--sea-ink-soft) tabular-nums ring-1 ring-(--card-row-line) ring-inset';

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
      <ol className="mt-1.5 flex flex-col gap-1.5 text-sm text-(--sea-ink-soft)">
        {entries.map((sic, i) => (
          // size-5 marker = the text's 20px line box, so it sits on the first line.
          <li key={sic.code} className="flex items-start gap-2">
            <span className={MARKER_CLASS}>{i + 1}</span>
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

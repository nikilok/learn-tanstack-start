import { Fragment } from 'react';

import { LABEL_CLASS } from './DetailField';

/** The company header's industry line: each SIC description followed by its code, bracketed so it can be copied into a `sic` filter search. */
export function CompanyIndustry({
  entries,
}: {
  entries: { code: string; description: string }[];
}) {
  if (entries.length === 0) return null;
  return (
    <div className="mt-3">
      <p className={LABEL_CLASS}>Industry (SIC Codes)</p>
      <p className="mt-1 text-sm text-(--sea-ink-soft)">
        {entries.map((sic, i) => (
          <Fragment key={sic.code}>
            {i > 0 && ', '}
            {sic.description}{' '}
            {/* Literal so iOS doesn't turn a bare 5-digit code into a phone link. */}
            <span
              className="text-(--sea-ink) tabular-nums"
              x-apple-data-detectors="false"
            >
              ({sic.code})
            </span>
          </Fragment>
        ))}
      </p>
    </div>
  );
}

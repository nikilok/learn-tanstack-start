import { MapPin } from 'lucide-react';
import type { ReactNode } from 'react';

import { MAP_FRAME_CLASS } from './AddressMap';
import BingLogo from './BingLogo';
import { CompanyIndustryPending } from './CompanyIndustry';
import { DetailField, LABEL_CLASS } from './DetailField';
import DuckDuckGoLogo from './DuckDuckGoLogo';
import GoogleLogo from './GoogleLogo';
import GovUkLogo from './GovUkLogo';
import LinkedInLogo from './LinkedInLogo';
import { SeeMoreLink } from './SeeMoreLink';

const BAR = 'rounded bg-(--sea-ink-soft)/15 motion-safe:animate-pulse';

/** Which breakpoints show placeholder line `i` of `phone` lines below `sm` and `wide` from it. */
function shownAt(i: number, phone: number, wide: number): string {
  if (i < phone && i < wide) return 'flex';
  return i < phone ? 'flex sm:hidden' : 'hidden sm:flex';
}

/** Placeholder lines, each one line of the surrounding text high (`1lh`): `phone` below `sm`, `wide` from it. */
function Lines({
  phone,
  wide = phone,
  width,
  last = width,
  bar = 'h-3.5',
}: {
  phone: number;
  wide?: number;
  width: string;
  last?: string;
  bar?: string;
}) {
  const count = Math.max(phone, wide);
  return (
    <span aria-hidden className="block grow">
      {Array.from({ length: count }, (_, i) => (
        // oxlint-disable-next-line react/no-array-index-key -- static placeholders never reorder
        <span
          key={i}
          className={`h-[1lh] items-center ${shownAt(i, phone, wide)}`}
        >
          <span className={`${bar} ${i === count - 1 ? last : width} ${BAR}`} />
        </span>
      ))}
    </span>
  );
}

/** `StatusBadge`'s pill, empty: the same box, so its row keeps the badge's height. */
function StatusPending() {
  return (
    <span
      aria-hidden
      className="inline-block w-16 rounded-full border border-(--sea-ink-soft)/20 px-3 py-1 text-xs"
    >
      &nbsp;
    </span>
  );
}

/** A `CompanyTimeline` row before its event loads: dot, date, title and, but for the last, a detail line. */
function TimelineRowPending({ last }: { last: boolean }) {
  return (
    <li className="flex gap-2.5">
      <span aria-hidden className="relative w-2 shrink-0">
        <span className="absolute top-2 left-1/2 size-2 -translate-x-1/2 rounded-full bg-(--sea-ink-soft)/15" />
      </span>
      <div className={`min-w-0 grow ${last ? '' : 'pb-4'}`}>
        <span aria-hidden className="text-[10px]">
          <span className={`inline-block h-2.5 w-16 ${BAR}`} />
        </span>
        <p className="text-sm">
          <Lines phone={1} width="w-1/2" />
        </p>
        {!last && (
          <p className="text-sm">
            <Lines phone={1} width="w-1/3" />
          </p>
        )}
      </div>
    </li>
  );
}

/**
 * The company page's frame while its data loads: its cards, titles, map frame and links, with each
 * value a placeholder of its height. Drawn to the most common page (a Companies House record, one
 * licence, one SIC code, three timeline rows). `back` is the way back to the search.
 */
export function CompanyScaffold({ back }: { back?: ReactNode }) {
  return (
    <main className="page-wrap min-h-[50vh] px-4 py-16">
      <section className="mx-auto max-w-2xl" aria-busy="true">
        <div className="page-flip-details">
          <div className="rounded-lg bg-(--sponsor-card-bg) p-6 shadow-(--shadow-card)">
            <noscript>
              <p className="mb-3 text-sm text-(--sea-ink-soft)">
                Turn on JavaScript to see this company&apos;s details.
              </p>
            </noscript>
            <div className="text-xl font-semibold">
              <Lines phone={1} width="w-2/3" bar="h-5" />
            </div>
            <div className="mt-1 text-sm">
              <Lines phone={2} wide={1} width="w-full" last="w-1/3" />
            </div>
            <CompanyIndustryPending />
            <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <DetailField
                label="Location"
                value={<Lines phone={1} width="w-20" />}
              />
              <DetailField
                label="Status"
                value={<StatusPending />}
                valueClassName="mt-1"
              />
              <DetailField
                label="Visa Route"
                value={<Lines phone={1} width="w-24" />}
              />
              <DetailField
                label="Rating"
                value={<Lines phone={1} width="w-24" />}
              />
            </dl>
          </div>

          <div className="glass mt-4 rounded-lg p-6">
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <DetailField
                label="Incorporated"
                value={<Lines phone={1} width="w-20" />}
              />
              <DetailField
                label="Company Type"
                value={<Lines phone={1} width="w-12" />}
              />
              <DetailField
                label="Last Accounts Filed"
                value={<Lines phone={1} width="w-20" />}
              />
              <DetailField
                label="Registration No."
                value={<Lines phone={1} width="w-16" />}
              />
              <DetailField
                label="Sponsor Licence No."
                value={<Lines phone={1} width="w-20" />}
              />
              <DetailField
                label="Registered Address"
                className="col-span-2 sm:col-span-4"
                valueClassName="mt-1 text-sm"
                value={
                  <>
                    <span className="inline-flex w-full items-center gap-1.5 text-(--sea-ink-soft)">
                      <MapPin size={14} className="shrink-0" />
                      <Lines phone={2} wide={1} width="w-3/4" last="w-1/2" />
                    </span>
                    <div className="-mx-6 mt-3 -mb-6 overflow-hidden rounded-b-lg">
                      <div className={MAP_FRAME_CLASS} />
                    </div>
                  </>
                }
              />
            </dl>
          </div>
        </div>

        <section className="mt-6" aria-labelledby="sponsor-about-heading">
          <h2 id="sponsor-about-heading" className={LABEL_CLASS}>
            About
          </h2>
          <div className="mt-1 text-sm leading-relaxed">
            <Lines phone={9} wide={5} width="w-full" last="w-1/2" />
          </div>
        </section>

        <section className="mt-6" aria-labelledby="company-timeline-heading">
          <h2 id="company-timeline-heading" className={LABEL_CLASS}>
            Timeline
          </h2>
          <div className="relative mt-1">
            <ol className="m-0 list-none p-0">
              <TimelineRowPending last={false} />
              <TimelineRowPending last={false} />
              <TimelineRowPending last />
            </ol>
          </div>
        </section>

        <section className="mt-6" aria-labelledby="see-more-heading">
          <h2 id="see-more-heading" className={`mb-2 ${LABEL_CLASS}`}>
            See more on
          </h2>
          <div className="flex flex-wrap gap-4 sm:gap-x-2">
            <SeeMoreLink logo={<GovUkLogo className="h-5 w-auto" />} />
            <SeeMoreLink
              logo={<GoogleLogo className="brand-mark h-5 w-auto" />}
              label="Google"
            />
            <SeeMoreLink
              logo={<BingLogo className="brand-mark h-5 w-auto" />}
              label="Bing"
            />
            <SeeMoreLink
              logo={<DuckDuckGoLogo className="brand-mark h-5 w-auto" />}
              label="DuckDuckGo"
            />
            <SeeMoreLink
              logo={<LinkedInLogo className="brand-mark h-5 w-auto" />}
              label="LinkedIn"
            />
          </div>
        </section>

        {back}
      </section>
    </main>
  );
}

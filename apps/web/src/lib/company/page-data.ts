import type { CompanyProfileResult } from '../../api/companiesHouse';
import type { CompanyTimeline } from '../../api/companyTimeline';
import type { CompanyBySlug } from '../../api/hmrc';
import { companyDocumentDegraded } from './document-cache';
import { PROFILE_UNAVAILABLE, profileStaleTime } from './profile-lookup';

/** What a company page shows apart from its extras: its licences, its Companies House profile and its timeline. */
export type CompanyPage = {
  company: CompanyBySlug | null;
  /** Null for a company not found, or with no Companies House record. */
  profile: CompanyProfileResult;
  timeline: CompanyTimeline | null;
};

/** The server-side reads a company page is built from. */
export type PageReads = {
  company: (slug: string) => Promise<CompanyBySlug | null>;
  profile: (organisationName: string) => Promise<CompanyProfileResult>;
  timeline: (companyNumber: string) => Promise<CompanyTimeline | null>;
};

/**
 * A company page's data for `slug`. Only a company's own slug reads past the slug lookup: a miss, a
 * rename or another spelling only 404s or redirects, so its profile and timeline are never read. A
 * failed profile lookup degrades the page like a Companies House outage does, and a failed timeline
 * leaves it out: neither takes the page down.
 */
export async function loadPage(
  slug: string,
  reads: PageReads,
): Promise<CompanyPage> {
  const company = await reads.company(slug);
  if (company?.kind !== 'found' || company.nameSlug !== slug)
    return { company, profile: null, timeline: null };
  const profile = await reads
    .profile(company.licences[0].organisationName)
    .catch((error: unknown) => {
      console.error('[Profile] load failed:', error);
      return PROFILE_UNAVAILABLE;
    });
  const timeline =
    profile?.kind === 'found' && profile.company_number
      ? await reads.timeline(profile.company_number).catch((error: unknown) => {
          console.error('[Timeline] load failed:', error);
          return null;
        })
      : null;
  return { company, profile, timeline };
}

/** The parts of a company page's data its freshness turns on. */
export type PageFreshness = {
  company: { kind: 'found' | 'moved'; nameSlug: string } | null;
  profile: { kind: 'found' | 'unavailable'; company_number?: string } | null;
  timeline: object | null;
};

/**
 * How long the browser reuses the data of the page at `slug`. A complete page holds while it stays
 * cached: it changes only via ingest and the website sweep. A miss, a rename or another spelling
 * is stale at once, so a revert or a reinstated sponsor is resolved again on the next visit instead
 * of 404ing or redirecting all session. A page built from incomplete data (`companyDocumentDegraded`)
 * is read again: after a minute for a Companies House outage, and on the next visit for a timeline
 * missing on a mapped company (a first visit racing the profile's save).
 */
export function companyPageStaleTime(
  page: PageFreshness | undefined,
  slug: string,
): number {
  if (page?.company?.kind !== 'found' || page.company.nameSlug !== slug)
    return 0;
  const { profile } = page;
  const degraded = companyDocumentDegraded({
    profileUnavailable: profile?.kind === 'unavailable',
    hasCompanyNumber: Boolean(
      profile?.kind === 'found' && profile.company_number,
    ),
    timelineLoaded: Boolean(page.timeline),
  });
  if (!degraded) return Number.POSITIVE_INFINITY;
  return profile?.kind === 'unavailable' ? profileStaleTime(profile) : 0;
}

/** A company page's data call the browser check refused: the page cannot show its data. */
export class PageDataRefusedError extends Error {
  constructor() {
    super('Page data refused');
    this.name = 'PageDataRefusedError';
  }
}

/** What a company page's data call answers: the page, or `denied` when the browser check refused it. */
export type PageAnswer<T> = { status: 'ok'; page: T } | { status: 'denied' };

/** The data call's answer: the check is asked first, and a refused call reads nothing. */
export async function answerPage<T>(deps: {
  allowed: () => Promise<boolean>;
  load: () => Promise<T>;
}): Promise<PageAnswer<T>> {
  if (!(await deps.allowed())) return { status: 'denied' };
  return { status: 'ok', page: await deps.load() };
}

/** The page a data call answered with, or `PageDataRefusedError` for a refusal. */
export function pageOf<T>(answer: PageAnswer<T>): T {
  if (answer.status === 'denied') throw new PageDataRefusedError();
  return answer.page;
}

import { profileStaleTime } from './profile-lookup';

/** The parts of a company page's data its freshness turns on. */
export type PageFreshness = {
  company: { kind: 'found' | 'moved' } | null;
  profile: { kind: 'found' | 'unavailable'; company_number?: string } | null;
  timeline: object | null;
};

/**
 * How long the browser reuses a company page's data. A complete page holds while it stays cached:
 * it changes only via ingest and the website sweep. A miss or a rename is stale at once, so a
 * revert or a reinstated sponsor is resolved again on the next visit instead of 404ing or
 * redirecting all session. A Companies House outage is retried after a minute, and a timeline
 * missing for a mapped company (a first visit racing the profile's save) on the next visit.
 */
export function companyPageStaleTime(page: PageFreshness | undefined): number {
  if (page?.company?.kind !== 'found') return 0;
  const { profile } = page;
  if (profile?.kind === 'unavailable') return profileStaleTime(profile);
  if (profile?.kind === 'found' && profile.company_number && !page.timeline)
    return 0;
  return Number.POSITIVE_INFINITY;
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

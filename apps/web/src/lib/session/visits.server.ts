import { slugify } from '../../utils';
import { hourBucket } from './token.server';

/** What recording a visit needs from the database — injected, so the rule is testable without one. */
export type VisitStore = {
  /** Whether a company page with this canonical slug exists. */
  companyPageExists(slug: string): Promise<boolean>;
  /** Insert the (session, slug, hour) row; a duplicate is a no-op, never an error. */
  insertVisit(row: {
    sessionId: string;
    slug: string;
    hour: Date;
  }): Promise<void>;
};

/**
 * Records that a session viewed a company page, and says whether it did. The slug is
 * caller-controlled, so it is normalised, checked for shape, then checked against the company
 * table: a well-formed slug that names no page is not a visit, and must not become a row.
 *
 * Never throws — the count is a measurement the page does not depend on, so any failure is a
 * quiet `false`.
 */
export async function recordCompanyVisit(
  sessionId: string,
  rawSlug: unknown,
  store: VisitStore,
  now = Date.now(),
): Promise<boolean> {
  // Same guard as getHmrcCompanyBySlug: type-check before slugify, then the canonical shape.
  const slug = typeof rawSlug === 'string' ? slugify(rawSlug) : '';
  if (!/^[a-z0-9-]{1,255}$/.test(slug)) return false;
  try {
    if (!(await store.companyPageExists(slug))) return false;
    await store.insertVisit({ sessionId, slug, hour: hourBucket(now) });
    return true;
  } catch (err) {
    console.error('[session] visit not recorded', err);
    return false;
  }
}

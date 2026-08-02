/**
 * Edge-cache tag names for company-scoped responses. Pure module by design:
 * client-visible code imports it via cache-headers, so it must never grow an
 * import of server-only code (the Vercel SDK chain).
 */

/** Population tag carried by every long-cached company response; one nightly invalidation refreshes them all (docs/company-pages-cache.md). */
export const ALL_COMPANY_PAGES_TAG = 'company-pages';

/** The one spelling of a company's own edge-cache tag — responses and the purge pipelines must agree or purges silently no-op. */
export function companyTag(companyNumber: string): string {
  return `company-${companyNumber}`;
}

/** A company response's full tag header: own tag then population tag, comma-joined per Vercel's multi-tag format. */
export function companyCacheTagHeader(companyNumber: string): string {
  return `${companyTag(companyNumber)},${ALL_COMPANY_PAGES_TAG}`;
}

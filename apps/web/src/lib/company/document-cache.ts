/**
 * Whether a company document was rendered from incomplete data, and so must
 * not be edge-cached for the full 30 days.
 *
 * Auxiliary loads (timeline, website) are caught and degraded to null so a
 * transient RPC failure cannot take the page down. That is right for
 * availability and wrong for caching: without this check the degraded document
 * is the one that gets pinned at the edge for a month, and the company looks
 * like it has no timeline and no website until the entry expires.
 *
 * The distinction that matters is failure versus absence. A website lookup
 * that succeeds and returns nothing is the ordinary answer for almost every
 * company, and must stay long-cacheable — treating it as degraded would put
 * essentially the whole site on the short TTL.
 */
export function companyDocumentDegraded(input: {
  /** Companies House link. Without one there is no timeline or website to expect. */
  hasCompanyNumber: boolean;
  timelineLoaded: boolean;
  websiteLookupFailed: boolean;
}): boolean {
  if (!input.hasCompanyNumber) return false;
  return !input.timelineLoaded || input.websiteLookupFailed;
}

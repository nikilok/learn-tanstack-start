/**
 * Whether a company document was rendered from incomplete data, and so must
 * not be edge-cached for the full 30 days.
 *
 * The timeline load is caught and degraded to null so a transient RPC failure
 * cannot take the page down. That is right for availability and wrong for
 * caching: without this check the degraded document is the one that gets
 * pinned at the edge for a month, and the company looks like it has no
 * timeline until the entry expires.
 */
export function companyDocumentDegraded(input: {
  /** Companies House link. Without one there is no timeline to expect. */
  hasCompanyNumber: boolean;
  timelineLoaded: boolean;
}): boolean {
  return input.hasCompanyNumber && !input.timelineLoaded;
}

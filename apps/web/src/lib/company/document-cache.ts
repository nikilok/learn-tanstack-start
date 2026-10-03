/**
 * Whether a company document was rendered from incomplete data, and so must
 * not be edge-cached for the full 30 days.
 *
 * A failed Companies House lookup renders the page without its Companies
 * House section, and a failed timeline load renders it without the timeline,
 * so neither can take the page down. That is right for availability and wrong
 * for caching: without this check the degraded document is the one that gets
 * pinned at the edge for a month.
 */
export function companyDocumentDegraded(input: {
  /** The Companies House lookup failed transiently, so its section is missing. */
  profileUnavailable: boolean;
  /** Companies House link. Without one there is no timeline to expect. */
  hasCompanyNumber: boolean;
  timelineLoaded: boolean;
}): boolean {
  return (
    input.profileUnavailable ||
    (input.hasCompanyNumber && !input.timelineLoaded)
  );
}

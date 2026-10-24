/**
 * A site judged not to be a company's: taken off its row, and out of the
 * search results the row banked, so no later walk can choose it again. No I/O.
 *
 * Clearing the URL alone left the site among the banked candidates, and the
 * next walk version chose it again.
 */

import { crowdKey } from './crowded-hosts';

/** What rejecting a site changes on one row. */
export type Rejection = {
  /** The row holds the site, so it goes back to `none`. */
  reset: boolean;
  /** The banked candidates without the site; null when the row banks none. */
  candidates: unknown[] | null;
};

/** The site a URL is on, compared www-insensitively; null when it is not a URL. */
function siteOf(url: string): string | null {
  try {
    return crowdKey(new URL(url).hostname);
  } catch {
    return null;
  }
}

/** Whether a URL is on the site or one of its subdomains. */
function onSite(url: unknown, site: string): boolean {
  const host = typeof url === 'string' ? siteOf(url) : null;
  return host !== null && (host === site || host.endsWith(`.${site}`));
}

/** What rejecting a site changes on a row: off it if the row holds it, and out of its banked candidates; null when nothing does. */
export function rejectSite(
  row: { url: string | null; candidates: unknown },
  rejectedUrl: string,
): Rejection | null {
  const site = siteOf(rejectedUrl);
  if (!site) throw new Error('the rejected site must be a URL');
  const reset = onSite(row.url, site);
  const banked = Array.isArray(row.candidates)
    ? (row.candidates as unknown[])
    : null;
  const kept = banked?.filter((url) => !onSite(url, site)) ?? null;
  if (!reset && kept?.length === banked?.length) return null;
  return { reset, candidates: kept };
}

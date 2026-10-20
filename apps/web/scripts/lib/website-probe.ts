/**
 * Fetching half of search discovery: turn a candidate URL into the two
 * query-independent signals, and walk a candidate's legal pages when its
 * homepage proves nothing.
 *
 * Shared rather than script-local so an experiment measures the code that
 * actually runs. A private second copy is how measure-search-recall drifted
 * from the Serper client and started throwing on a body the client banks.
 */

import { isDiscoveryAggregator } from '../../src/lib/websites/crowded-hosts.ts';
import {
  legalLinks,
  walkTargets,
} from '../../src/lib/websites/disclosure-walk.ts';
import type { DiscoveryRow } from '../../src/lib/websites/discover-sweep.ts';
import type { CandidateProbe } from '../../src/lib/websites/discover.ts';
import {
  pageHasCompanyNumber,
  pageHasPostcode,
  visibleText,
} from '../../src/lib/websites/extract.ts';
import { normaliseWebsiteUrl } from '../../src/lib/websites/normalise-url.ts';
import { looksParked } from '../../src/lib/websites/page-signals.ts';
import { statedOnPage } from '../../src/lib/websites/stated-numbers.ts';
import { fetchSite } from './web-fetch.ts';

/** Fetch one candidate origin and read the two query-independent signals. */
export async function probeOrigin(
  row: DiscoveryRow,
  url: string,
  crowded: ReadonlySet<string>,
): Promise<CandidateProbe | null> {
  // Raw provider output, so normalise as every other writer of url does.
  const canonical = normaliseWebsiteUrl(url);
  if (!canonical) return null;
  const fetched = await fetchSite(canonical);
  if (!fetched.ok) return null;
  const host = (() => {
    try {
      return new URL(fetched.url).host.toLowerCase();
    } catch {
      return '';
    }
  })();
  const text = visibleText(fetched.html);
  const crnFound = pageHasCompanyNumber(fetched.html, row.companyNumber);
  const postcodeFound = row.postcode
    ? pageHasPostcode(fetched.html, row.postcode)
    : false;
  const onAggregator = isDiscoveryAggregator(host, crowded);
  return {
    // The URL we ASKED for, not the post-redirect one: that is what a visitor
    // clicks and what the sweep revalidates. The HOST is judged post-redirect,
    // because a URL that 301s into a directory is what it lands on.
    url: canonical,
    // The page actually PARSED — post-redirect — matching walkDisclosure. On a
    // redirecting candidate, `canonical` names a page the signals never came
    // from.
    evidenceUrl: crnFound || postcodeFound ? fetched.url : null,
    crnFound,
    postcodeFound,
    onAggregator,
    parked: looksParked(text),
    legalLinks: legalLinks(fetched.html, fetched.url),
    // A directory's numbers are its listings', not the site naming itself.
    stated: onAggregator ? [] : statedOnPage(fetched.url, fetched.html),
  };
}

export type WalkOptions = {
  /** Fixed disclosure paths read after the homepage's legal links. */
  maxPaths: number;
  delayMs: number;
  /** Called per fetch attempted, for the caller's own counter. */
  onFetch?: () => void;
};

/**
 * Probe a candidate's legal pages when its homepage proved nothing.
 *
 * Returns the probe updated with whatever they found, so the same pure decider
 * settles the row either way. Stops at the first registration number: nothing
 * below it can beat the company naming itself.
 */
export async function walkDisclosure(
  row: DiscoveryRow,
  base: CandidateProbe,
  options: WalkOptions,
): Promise<CandidateProbe | null> {
  let updated = base;
  const stated = [...(base.stated ?? [])];
  const targets = walkTargets(
    base.url,
    base.legalLinks ?? [],
    options.maxPaths,
  );
  for (const target of targets) {
    await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    const fetched = await fetchSite(target);
    options.onFetch?.();
    if (!fetched.ok) continue;
    stated.push(...statedOnPage(fetched.url, fetched.html));
    if (pageHasCompanyNumber(fetched.html, row.companyNumber)) {
      return { ...updated, crnFound: true, evidenceUrl: fetched.url, stated };
    }
    if (
      !updated.postcodeFound &&
      row.postcode &&
      pageHasPostcode(fetched.html, row.postcode)
    ) {
      updated = { ...updated, postcodeFound: true, evidenceUrl: fetched.url };
    }
  }
  return { ...updated, stated };
}

/**
 * Fetching half of search discovery: turn a candidate URL into the two
 * query-independent signals, and walk a candidate's legal pages when its
 * homepage proves nothing.
 *
 * Shared rather than script-local so an experiment measures the code that
 * actually runs. A private second copy is how measure-search-recall drifted
 * from the Serper client and started throwing on a body the client banks.
 */

import {
  foldWalkPage,
  readHomepage,
  readWalkPage,
  walkTargets,
} from '../../src/lib/websites/disclosure-walk.ts';
import type { DiscoveryRow } from '../../src/lib/websites/discover-sweep.ts';
import type { CandidateProbe } from '../../src/lib/websites/discover.ts';
import { normaliseWebsiteUrl } from '../../src/lib/websites/normalise-url.ts';
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
  return readHomepage(row, canonical, fetched.url, fetched.html, crowded);
}

export type WalkOptions = {
  /** Fixed disclosure paths read after the homepage's legal links. */
  maxPaths: number;
  delayMs: number;
  /** Hosts discovery treats as directories; a page served from one proves nothing. */
  crowded: ReadonlySet<string>;
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
    const page = readWalkPage(row, fetched.url, fetched.html, options.crowded);
    if (!page) continue;
    stated.push(...page.stated);
    updated = foldWalkPage(updated, fetched.url, page);
    if (updated.crnFound) return { ...updated, stated };
  }
  return { ...updated, stated };
}

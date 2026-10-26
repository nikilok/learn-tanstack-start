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
  pageKey,
  readHomepage,
  readWalkPage,
  walkTargets,
} from '../../src/lib/websites/disclosure-walk.ts';
import type { DiscoveryRow } from '../../src/lib/websites/discover-sweep.ts';
import type { CandidateProbe } from '../../src/lib/websites/discover.ts';
import { RENDER_VISIT_MS } from '../../src/lib/websites/fetch-policy.ts';
import { normaliseWebsiteUrl } from '../../src/lib/websites/normalise-url.ts';
import { fetchSite, type SiteFetch } from './web-fetch.ts';
import type { Renderer } from './web-render.ts';

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
  /** The fetcher; the real one unless a test supplies its own. */
  fetch?: (url: string) => Promise<SiteFetch>;
  /** Epoch milliseconds after which the walk reads no further page. */
  deadline?: number;
};

/**
 * Probe a candidate's legal and about pages when its homepage proved nothing.
 *
 * Returns the probe updated with whatever they found, and with every page it
 * read for the two-signal rule, so the same pure deciders settle the row
 * either way. Stops at the first registration number: nothing below it can
 * beat the company naming itself.
 */
export async function walkDisclosure(
  row: DiscoveryRow,
  base: CandidateProbe,
  options: WalkOptions,
): Promise<CandidateProbe | null> {
  let updated = base;
  const stated = [...(base.stated ?? [])];
  const pages = [...(base.pages ?? [])];
  const read = new Set(pages.map((page) => pageKey(page.url)));
  const targets = walkTargets(
    base.url,
    base.legalLinks ?? [],
    options.maxPaths,
    base.aboutLinks ?? [],
  );
  const fetch = options.fetch ?? fetchSite;
  for (const target of targets) {
    if (options.deadline !== undefined && Date.now() >= options.deadline) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    const fetched = await fetch(target);
    options.onFetch?.();
    if (!fetched.ok) continue;
    const page = readWalkPage(row, fetched.url, fetched.html, options.crowded);
    if (!page) continue;
    stated.push(...page.stated);
    // A path that redirected to a page already read adds nothing to read.
    if (!read.has(pageKey(page.read.url))) {
      read.add(pageKey(page.read.url));
      pages.push(page.read);
    }
    updated = foldWalkPage(updated, fetched.url, page);
    if (updated.crnFound) return { ...updated, stated, pages };
  }
  return { ...updated, stated, pages };
}

/**
 * Read a candidate again in a browser, in one visit: its homepage, then the
 * walk's pages from the links the rendered homepage shows, every page
 * rendered. Null when the homepage would not render.
 */
export async function renderCandidate(
  row: DiscoveryRow,
  base: CandidateProbe,
  renderer: Pick<Renderer, 'visit'>,
  options: WalkOptions,
): Promise<CandidateProbe | null> {
  const visit = renderer.visit();
  // A site too slow for its visit keeps what was read.
  const deadline = Date.now() + RENDER_VISIT_MS;
  try {
    await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    const home = await visit.render(base.url);
    options.onFetch?.();
    if (!home.ok) return null;
    const probe = readHomepage(
      row,
      base.url,
      home.url,
      home.html,
      options.crowded,
    );
    if (probe.crnFound || probe.onAggregator || probe.parked) return probe;
    return await walkDisclosure(row, probe, {
      ...options,
      fetch: (url) => visit.render(url),
      deadline,
    });
  } finally {
    await visit.close();
  }
}

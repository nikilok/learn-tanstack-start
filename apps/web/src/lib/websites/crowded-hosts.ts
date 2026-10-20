/**
 * Result hosts search returns for many different companies: directories,
 * registers and platforms, listed or not. No I/O.
 */

import { isAggregatorHost } from './page-signals';

/** Companies a host must appear for to count as a directory; 99.9% of proven own sites appear for fewer. */
export const CROWDED_HOST_COMPANIES = 50;

/** The form hosts are counted under: lower-case, without a leading `www.`. */
export function crowdKey(host: string): string {
  return host
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
}

/** Whether discovery should pass over a host: listed, or crowded. */
export function isDiscoveryAggregator(
  host: string,
  crowded: ReadonlySet<string>,
): boolean {
  return isAggregatorHost(host) || crowded.has(crowdKey(host));
}

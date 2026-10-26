/**
 * A company's officers from Companies House, for the two-signal rule: paced
 * so a job's workers together stay inside a small share of the key the
 * phase-5 sweeps also use, retried on a transient failure, never logged and
 * never stored. A run whose lookups keep failing stops asking.
 */

import {
  type ChResponse,
  fetchChApi,
} from '../../src/lib/hmrc-ch/ch-lookup.ts';
import { isRetryableChFailure } from '../../src/lib/hmrc-ch/ch-retry.ts';
import {
  type OfficerLookup,
  officersOf,
} from '../../src/lib/websites/officer-names.ts';

/** Officer lookups a second one job allows itself, across its workers: a quarter of the key's 600 calls per five minutes. */
export const OFFICER_CALLS_PER_SECOND = 0.5;

/** Retries after a rate limit, a server error or a transport failure. */
export const OFFICER_RETRIES = 2;

/** Lookups failing in a row before a run stops asking. */
export const OFFICER_BREAKER = 3;

/** Pause before a retry. */
const RETRY_PAUSE_MS = 30_000;

export type OfficerLookupOptions = {
  apiKey: string;
  /** Workers sharing the job's share, each pacing itself to its part. */
  workers: number;
  fetchCh?: (path: string) => Promise<ChResponse>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/** One officers call per company, paced to this worker's part: `failed` when Companies House could not answer, `stopped` once OFFICER_BREAKER lookups in a row have. */
export function makeOfficerLookup(
  options: OfficerLookupOptions,
): (companyNumber: string) => Promise<OfficerLookup> {
  const interval = (options.workers * 1000) / OFFICER_CALLS_PER_SECOND;
  const fetchCh =
    options.fetchCh ?? ((path: string) => fetchChApi(path, options.apiKey));
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  let next = 0;
  let failing = 0;
  return async (companyNumber) => {
    if (failing >= OFFICER_BREAKER) return 'stopped';
    for (let attempt = 0; ; attempt++) {
      const wait = next - now();
      if (wait > 0) await sleep(wait);
      next = now() + interval;
      const res = await fetchCh(
        `/company/${encodeURIComponent(companyNumber)}/officers?items_per_page=100`,
      );
      if (res.ok || res.status === 404) {
        failing = 0;
        // No such company, or none listed: no officer can be named.
        return res.ok ? officersOf(res.data) : [];
      }
      if (!isRetryableChFailure(res.status) || attempt >= OFFICER_RETRIES) {
        failing += 1;
        return 'failed';
      }
      await sleep(RETRY_PAUSE_MS);
    }
  };
}

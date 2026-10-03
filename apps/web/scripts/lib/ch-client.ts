/**
 * Shared Companies House REST client for the backfill, sweep and seed
 * scripts. Basic auth via COMPANIES_HOUSE_SEED_API_KEY (read lazily so
 * callers' dotenv.config runs first), a 30s timeout that covers the body, and
 * up to 3 retries 60s apart on a transport failure, 429 or 5xx. Kept as one
 * module so retry/timeout/auth policy can't drift between scripts (the
 * copy-paste the #258 review flagged).
 */

import {
  type ChFetch,
  type ChResponse,
  fetchChApi,
} from '../../src/lib/hmrc-ch/ch-lookup.ts';
import { withChRetries } from '../../src/lib/hmrc-ch/ch-retry.ts';

const FETCH_MAX_RETRIES = 3;
const FETCH_PAUSE_MS = 60_000;
const FETCH_TIMEOUT_MS = 30_000;

/** Sleep for `ms` milliseconds. */
export function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** The CH key, read on first use. A missing key throws rather than retrying. */
function apiKey(): string {
  const key = process.env.COMPANIES_HOUSE_SEED_API_KEY;
  if (!key) throw new Error('COMPANIES_HOUSE_SEED_API_KEY not set');
  return key;
}

/** The scripts' CH fetch under the shared policy; `fetchImpl` and `sleep` are injectable for tests. */
export function makeScriptChFetch(
  deps: {
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): ChFetch {
  return withChRetries(
    (path) =>
      fetchChApi(path, apiKey(), {
        fetchImpl: deps.fetchImpl,
        timeoutMs: FETCH_TIMEOUT_MS,
      }),
    { retries: FETCH_MAX_RETRIES, pauseMs: FETCH_PAUSE_MS, sleep: deps.sleep },
  );
}

/** GET a CH REST path with retries. Each failure keeps its status, so only a 404 reads as "no such company". */
export const fetchCh: ChFetch = makeScriptChFetch();

export type FetchOutcome =
  | { ok: true; data: unknown }
  | { ok: false; notFound: boolean };

/** A CH response as the backfills read it: a 404 or 410 is not found, and they leave that company intact. */
export function toFetchOutcome(res: ChResponse): FetchOutcome {
  if (res.ok) return res;
  return { ok: false, notFound: res.status === 404 || res.status === 410 };
}

/** GET a CH REST path for the backfills. */
export async function fetchApi(path: string): Promise<FetchOutcome> {
  return toFetchOutcome(await fetchCh(path));
}

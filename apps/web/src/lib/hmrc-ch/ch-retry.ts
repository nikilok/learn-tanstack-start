import {
  type ChFetch,
  type ChResponse,
  isTransientChFailure,
} from './ch-lookup';

/** Whether retrying a failed Companies House call can help: a transport failure, a rate limit or a server error. */
export function isRetryableChFailure(status: number): boolean {
  return status === 0 || status === 429 || (status >= 500 && status < 600);
}

/** The run-log label for a retryable Companies House failure. */
function failureLabel(res: Extract<ChResponse, { ok: false }>): string {
  if (res.status === 0) return `Transport failure (${res.cause ?? 'no cause'})`;
  if (res.status === 429) return 'Rate limited';
  return `Server error ${res.status}`;
}

/** Waits `ms` milliseconds. */
function sleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps a Companies House fetch for batch scripts: a transport failure, a 429
 * or a 5xx is retried after a pause, up to `retries` times. Whatever it gives
 * up on comes back as its status, which the resolver treats as a gap.
 */
export function withChRetries(
  fetchCh: ChFetch,
  opts: {
    retries: number;
    pauseMs: number;
    sleep?: (ms: number) => Promise<void>;
  },
): ChFetch {
  const { retries, pauseMs, sleep = sleepFor } = opts;
  return async (path) => {
    for (let retriesLeft = retries; ; retriesLeft -= 1) {
      const res = await fetchCh(path);
      if (res.ok || !isTransientChFailure(res.status)) return res;
      if (!isRetryableChFailure(res.status)) {
        console.error(`  Unexpected ${res.status} for ${path}`);
        return res;
      }
      const label = failureLabel(res);
      if (retriesLeft <= 0) {
        console.error(`  ${label} retries exhausted for ${path}, giving up`);
        return res;
      }
      console.log(
        `  ${label}, backing off for ${pauseMs / 1000}s… (${retriesLeft} retries left)`,
      );
      await sleep(pauseMs);
    }
  };
}

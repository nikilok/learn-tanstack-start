/** getCompanyProfile's result when a Companies House call failed transiently. Unlike `null`, it says nothing about whether the company exists. */
export const PROFILE_UNAVAILABLE = { kind: 'unavailable' } as const;

/** How long a client reuses a transient failure: long enough to absorb preload bursts, short enough that recovery shows on the next visit. */
const UNAVAILABLE_STALE_MS = 60_000;

/** Client staleTime for a profile lookup. A transient failure goes stale after a minute, so retries are paced; a profile or a verified absence never goes stale while it stays in the cache. */
export function profileStaleTime(
  data: { kind: 'found' | 'unavailable' } | null | undefined,
): number {
  return data?.kind === 'unavailable'
    ? UNAVAILABLE_STALE_MS
    : Number.POSITIVE_INFINITY;
}

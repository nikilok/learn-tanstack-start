import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { getRequestHeader } from '@tanstack/react-start/server';

import { isRenderingBot } from '../utils/rendering-bot';
import {
  LONG_EDGE_CACHE,
  setRpcCacheControl,
  TRANSIENT_EDGE_CACHE,
} from './cache-headers';
import { geocodeUpstream } from './geocode-upstream';

export type { Geocoded } from '../utils/geocode-body';

const UK_POSTCODE_RE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s+(\d[A-Z]{2})\b/i;

/** Normalize a UK address to its postcode for Nominatim — used client-side for the React Query key and server-side as a defensive re-normalisation before hitting Nominatim. */
function buildQuery(address: string): string {
  const m = address.match(UK_POSTCODE_RE);
  return m ? `${m[1]} ${m[2]}` : address;
}

/** Log form of a geocode query: postcodes are format-validated public geographic tokens and safe to log; anything else (free-form input on a public endpoint) is redacted. */
function logLabel(query: string): string {
  return UK_POSTCODE_RE.test(query) ? `"${query}"` : '[non-postcode address]';
}

/**
 * Server fn that proxies Nominatim with a compliant User-Agent, a 5s cap,
 * and the shared long-TTL RPC cache header. Postcodes don't move, so a
 * 30-day Vercel edge cache means each unique postcode hits Nominatim once
 * globally. Returns `null` for malformed input, misses and every upstream
 * failure — logged, and edge-cached only briefly so a transient refusal is
 * retried rather than pinned. Rendering crawlers get an uncached `null`
 * before Nominatim is touched: coords are render decoration, and
 * crawl-rate renders don't fit inside the upstream's request budget.
 */
const getGeocode = createServerFn()
  .inputValidator((input: unknown) => {
    const q = (input as { q?: unknown } | null | undefined)?.q;
    return { q: typeof q === 'string' ? q : '' };
  })
  .handler(async ({ data: { q } }) => {
    const raw = q.trim();
    if (!raw || raw.length > 200) return null;

    // Uncacheable by omission: a crawler-served null must never become the cache entry a person then hits.
    if (isRenderingBot(getRequestHeader('user-agent') ?? '')) return null;

    const query = buildQuery(raw);

    setRpcCacheControl(TRANSIENT_EDGE_CACHE);

    const result = await geocodeUpstream(query);
    if (!result.ok) {
      console.error(
        `[geocode] upstream failed (${result.reason}) for ${logLabel(query)}`,
      );
      return null;
    }
    if (!result.geo) {
      console.log(`[geocode] no result for ${logLabel(query)}`);
      return null;
    }

    setRpcCacheControl(LONG_EDGE_CACHE);

    return result.geo;
  });

/** React Query options for `getGeocode`. Normalises to a UK postcode so addresses sharing a postcode dedupe in both the React Query cache and the Vercel edge cache. Real coords are immutable and stay fresh forever; a `null` is usually Nominatim under load, so it goes stale immediately and re-resolves on the next mount or window refocus. */
export const geocodeQueryOptions = (address: string) => {
  const query = buildQuery(address);
  return queryOptions({
    queryKey: ['geocode', query],
    queryFn: () => getGeocode({ data: { q: query } }),
    staleTime: (q) => (q.state.data ? Number.POSITIVE_INFINITY : 0),
  });
};

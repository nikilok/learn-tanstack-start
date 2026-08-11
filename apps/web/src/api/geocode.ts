import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { getRequestHeader } from '@tanstack/react-start/server';

import { isRenderingBot } from '../utils/rendering-bot';
import {
  LONG_EDGE_CACHE,
  setRpcCacheControl,
  TRANSIENT_EDGE_CACHE,
} from './cache-headers';

export interface Geocoded {
  lat: number;
  lon: number;
}

const UK_POSTCODE_RE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s+(\d[A-Z]{2})\b/i;

/** Normalize a UK address to its postcode for Nominatim — used client-side for the React Query key and server-side as a defensive re-normalisation before hitting Nominatim. */
function buildQuery(address: string): string {
  const m = address.match(UK_POSTCODE_RE);
  return m ? `${m[1]} ${m[2]}` : address;
}

/**
 * Server fn that proxies Nominatim with a compliant User-Agent and the
 * shared long-TTL RPC cache header. Postcodes don't move, so a 30-day
 * Vercel edge cache means each unique postcode hits Nominatim once
 * globally. Returns `null` for misses or upstream errors — logged, and
 * edge-cached only briefly so a transient upstream refusal is retried
 * rather than pinned. Rendering crawlers get an uncached `null` before
 * Nominatim is touched: coords are render decoration, and crawl-rate
 * renders don't fit inside the upstream's request budget.
 */
const getGeocode = createServerFn()
  .inputValidator((input: unknown) => input as { q: string })
  .handler(async ({ data: { q } }) => {
    const raw = q.trim();
    if (!raw || raw.length > 200) return null;

    // Uncacheable by omission: a crawler-served null must never become the cache entry a person then hits.
    if (isRenderingBot(getRequestHeader('user-agent') ?? '')) return null;

    const query = buildQuery(raw);

    setRpcCacheControl(TRANSIENT_EDGE_CACHE);

    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`,
      {
        headers: {
          'User-Agent': 'SponsorSearch/1.0 (+https://sponsorsearch.co.uk)',
        },
      },
    );

    if (!res.ok) {
      console.error(`[geocode] upstream ${res.status} for "${query}"`);
      return null;
    }

    let data: Array<{ lat: string; lon: string }>;
    try {
      data = (await res.json()) as Array<{ lat: string; lon: string }>;
    } catch {
      console.error(`[geocode] unparseable upstream body for "${query}"`);
      return null;
    }

    const hit = data[0];
    if (!hit) {
      console.log(`[geocode] no result for "${query}"`);
      return null;
    }

    const lat = Number.parseFloat(hit.lat);
    const lon = Number.parseFloat(hit.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    setRpcCacheControl(LONG_EDGE_CACHE);

    return { lat, lon };
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

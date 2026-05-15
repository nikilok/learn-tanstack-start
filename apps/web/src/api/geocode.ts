import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { LONG_EDGE_CACHE, setRpcCacheControl } from './cache-headers';

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
 * globally. Returns `null` for misses or upstream errors.
 */
export const getGeocode = createServerFn()
  .inputValidator((input: unknown) => input as { q: string })
  .handler(async ({ data: { q } }) => {
    const raw = q.trim();
    if (!raw || raw.length > 200) return null;

    const query = buildQuery(raw);

    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`,
      {
        headers: {
          'User-Agent': 'SponsorSearch/1.0 (+https://sponsorsearch.co.uk)',
        },
      },
    );

    if (!res.ok) return null;

    let data: Array<{ lat: string; lon: string }>;
    try {
      data = (await res.json()) as Array<{ lat: string; lon: string }>;
    } catch {
      return null;
    }

    const hit = data[0];
    if (!hit) return null;

    const lat = Number.parseFloat(hit.lat);
    const lon = Number.parseFloat(hit.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    setRpcCacheControl(LONG_EDGE_CACHE);

    return { lat, lon };
  });

/** React Query options for `getGeocode`. Normalises to a UK postcode so addresses sharing a postcode dedupe in both the React Query cache and the Vercel edge cache. `staleTime: Infinity` since postcode coords are immutable. */
export const geocodeQueryOptions = (address: string) => {
  const query = buildQuery(address);
  return queryOptions({
    queryKey: ['geocode', query],
    queryFn: () => getGeocode({ data: { q: query } }),
    staleTime: Number.POSITIVE_INFINITY,
  });
};

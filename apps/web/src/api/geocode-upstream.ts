import { type Geocoded, parseGeocodeBody } from '../utils/geocode-body';

export type GeocodeUpstreamResult =
  | { ok: true; geo: Geocoded | null }
  | { ok: false; reason: string };

/**
 * Query Nominatim for `query` under one bounded request — the timeout spans
 * fetch AND the body read, since `await fetch` settles at headers and a
 * stalled body would otherwise hang unbounded. Never throws: transport,
 * status and body-shape failures come back as `{ ok: false, reason }` with
 * the reason built from our own bounded text, never raw upstream content.
 * `fetchImpl`/`timeoutMs` are injectable for tests.
 */
export async function geocodeUpstream(
  query: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<GeocodeUpstreamResult> {
  const { fetchImpl = fetch, timeoutMs = 5000 } = opts;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let body: unknown;
  try {
    const res = await fetchImpl(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`,
      {
        signal: controller.signal,
        headers: {
          'User-Agent': 'SponsorSearch/1.0 (+https://sponsorsearch.co.uk)',
        },
      },
    );
    if (!res.ok) return { ok: false, reason: `status ${res.status}` };
    body = (await res.json()) as unknown;
  } catch (err) {
    // Category + error name only — a message can embed the request URL, and with it the query.
    return {
      ok: false,
      reason:
        err instanceof Error ? `request error: ${err.name}` : 'unknown error',
    };
  } finally {
    clearTimeout(timeout);
  }
  if (!Array.isArray(body)) return { ok: false, reason: 'non-array body' };
  return { ok: true, geo: parseGeocodeBody(body) };
}

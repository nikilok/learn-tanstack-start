/**
 * Responses for the tile proxy (`server/api/tiles/[theme]/[z]/[x]/[y].get.ts`).
 * The `/api/tiles/**` route rule's Cache-Control is merged over every 2xx and
 * added at the edge to anything that sets none, so only a non-2xx response
 * can opt out, by setting its own.
 */

const ALLOWED_HOSTS = new Set([
  'sponsorsearch.co.uk',
  'www.sponsorsearch.co.uk',
]);
const VERCEL_TEAM_SUFFIX = '-nikil-kuruvillas-projects.vercel.app';
const VERCEL_PROJECT_PREFIX = 'learn-tanstack-start-';

// Exact values browsers send for a request that is not same-origin; null is a client that sends none.
const OFF_ORIGIN_FETCH_SITES = new Set<string | null>([
  null,
  'cross-site',
  'same-site',
  'none',
]);

const TILE_VARY = 'Sec-Fetch-Site';
const NO_STORE = 'private, no-store';

/** Returns true when the Referer's parsed hostname matches the prod custom domain or a Vercel deployment URL anchored on both this team's suffix and this project's prefix. */
function isAllowedReferer(referer: string): boolean {
  if (!referer) return false;
  try {
    const url = new URL(referer);
    if (url.protocol !== 'https:') return false;
    if (ALLOWED_HOSTS.has(url.hostname)) return true;
    return (
      url.hostname.startsWith(VERCEL_PROJECT_PREFIX) &&
      url.hostname.endsWith(VERCEL_TEAM_SUFFIX)
    );
  } catch {
    return false;
  }
}

/** A 302 to the branded blocked-tile placeholder, so hotlinkers see a visible "blocked" tile instead of a broken-image icon. A null `cacheControl` leaves the route rule's edge caching in place, partitioned by `Vary`. */
function blockedTileRedirect(cacheControl: string | null): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: '/blocked-tile.png',
      Vary: TILE_VARY,
      ...(cacheControl ? { 'Cache-Control': cacheControl } : {}),
    },
  });
}

/** The redirect for a tile request the proxy refuses, or null to serve it. A refusal may be edge-cached only when it depends on nothing outside `Vary`. The Referer check is skipped when `checkReferer` is false (non-production). */
export function blockedTileResponse(
  headers: Headers,
  checkReferer: boolean,
): Response | null {
  const fetchSite = headers.get('sec-fetch-site');
  if (fetchSite !== 'same-origin') {
    return blockedTileRedirect(
      OFF_ORIGIN_FETCH_SITES.has(fetchSite) ? null : NO_STORE,
    );
  }
  if (checkReferer && !isAllowedReferer(headers.get('referer') ?? '')) {
    return blockedTileRedirect(NO_STORE);
  }
  return null;
}

/** An empty, uncached error response for failures that may clear: a missing key, an unreachable upstream, or an upstream error status. Non-2xx only, since h3 merges the route rule over a 2xx. */
export function uncachedTileError(status: number): Response {
  return new Response(null, {
    status,
    headers: { 'Cache-Control': NO_STORE },
  });
}

/** The proxy's answer to an upstream response: its error status passed on uncached, or the tile as a PNG that the route rule edge-caches and `Vary` partitions. */
export async function upstreamTileResponse(
  upstream: Response,
): Promise<Response> {
  if (!upstream.ok) return uncachedTileError(upstream.status);
  return new Response(await upstream.arrayBuffer(), {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      Vary: TILE_VARY,
    },
  });
}

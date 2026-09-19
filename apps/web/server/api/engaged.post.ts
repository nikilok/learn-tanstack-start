/**
 * POST /api/engaged
 *
 * The engagement ping. The pre-hydration script in src/scripts/engagement-init.ts sends one
 * body-less request per page view on the visitor's first genuine input, via sendBeacon.
 * Nothing is read, stored or logged here — the platform's request analytics count the route
 * — so the handler only has to exist, answer fast, and never be cached.
 *
 * The edge middleware must pass this path through (its API_PREFIXES): sendBeacon sends an
 * Accept of `*` + `/` + `*`, which the middleware's document fallback would otherwise 404 at the edge.
 */
import { defineEventHandler } from 'h3';

/** What every ping gets: nothing to say, nothing to cache. */
export function engagedResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: { 'cache-control': 'no-store' },
  });
}

export default defineEventHandler(() => engagedResponse());

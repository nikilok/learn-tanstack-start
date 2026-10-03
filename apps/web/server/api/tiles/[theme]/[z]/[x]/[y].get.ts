/**
 * GET /api/tiles/:theme/:z/:x/:y
 *
 * Proxies Stadia Maps tile requests so we can front them with the Vercel
 * edge cache (s-maxage=1y) — first viewer per region pays Stadia,
 * everyone else hits the CDN. STADIA_API_KEY stays server-only.
 *
 * URL params:
 *  - theme: alidade_smooth | alidade_smooth_dark
 *  - z:     zoom (5-19)
 *  - x:     tile x (0 <= x < 2^z)
 *  - y:     tile y (0 <= y < 2^z), optional @2x retina suffix
 *
 * Access checks and every response's caching headers live in
 * server/utils/tileResponses.ts. Zoom + tile-coord bounds reject
 * world-scrape patterns (z=0..4).
 *
 * Env vars:
 *  - STADIA_API_KEY — server-only Stadia API key.
 */
import { defineEventHandler } from 'h3';

import { TILE_MAX_ZOOM, TILE_MIN_ZOOM } from '#/utils/tileBounds';

import {
  blockedTileResponse,
  uncachedTileError,
  upstreamTileResponse,
} from '../../../../../utils/tileResponses';

const ALLOWED_THEMES = new Set(['alidade_smooth', 'alidade_smooth_dark']);

export default defineEventHandler(async (event) => {
  const blocked = blockedTileResponse(
    event.req.headers,
    process.env.NODE_ENV === 'production',
  );
  if (blocked) return blocked;

  const params = event.context.params ?? {};
  const theme = params.theme as string | undefined;
  const z = params.z as string | undefined;
  const x = params.x as string | undefined;
  const y = params.y as string | undefined;

  if (!theme || !z || !x || !y) {
    return new Response(null, { status: 400 });
  }

  if (!ALLOWED_THEMES.has(theme)) {
    return new Response(null, { status: 404 });
  }

  const zn = Number(z);
  if (!Number.isInteger(zn) || zn < TILE_MIN_ZOOM || zn > TILE_MAX_ZOOM) {
    return new Response(null, { status: 400 });
  }

  const yMatch = y.match(/^(\d+)(@2x)?$/);
  const xn = Number(x);
  if (!yMatch || !Number.isInteger(xn) || xn < 0) {
    return new Response(null, { status: 400 });
  }
  const yNum = Number(yMatch[1]);
  const worldSize = 2 ** zn;
  if (xn >= worldSize || yNum < 0 || yNum >= worldSize) {
    return new Response(null, { status: 400 });
  }

  const apiKey = process.env.STADIA_API_KEY;
  if (!apiKey) {
    console.error('[tiles] STADIA_API_KEY not set');
    return uncachedTileError(500);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  let upstream: Response;
  try {
    upstream = await fetch(
      `https://tiles.stadiamaps.com/tiles/${theme}/${z}/${x}/${y}.png?api_key=${apiKey}`,
      {
        signal: controller.signal,
        headers: {
          'User-Agent': 'SponsorSearch/1.0 (+https://sponsorsearch.co.uk)',
        },
      },
    );
  } catch (err) {
    console.error('[tiles] upstream fetch failed:', err);
    return uncachedTileError(502);
  } finally {
    clearTimeout(timeout);
  }

  return upstreamTileResponse(upstream);
});

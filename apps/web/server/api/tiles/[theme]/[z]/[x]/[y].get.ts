/**
 * GET /api/tiles/:theme/:z/:x/:y
 *
 * Proxies Stadia Maps tile requests so we can front them with the Vercel
 * edge cache (s-maxage=1y, immutable) — first viewer per region pays Stadia,
 * everyone else hits the CDN. STADIA_API_KEY stays server-only.
 *
 * URL params:
 *  - theme: alidade_smooth | alidade_smooth_dark
 *  - z:     zoom (5-19)
 *  - x:     tile x (0 <= x < 2^z)
 *  - y:     tile y (0 <= y < 2^z), optional @2x retina suffix
 *
 * Access control — three cheap layers, ordered cheapest-first:
 *  - Referer must match prod domain (browsers send this automatically;
 *    skipped on non-prod NODE_ENV so localhost works).
 *  - Sec-Fetch-Site, when present, must be same-origin (browser-computed,
 *    cannot be set by in-browser JS — blocks cross-site embed attempts).
 *  - Zoom + tile-coord bounds reject world-scrape patterns (z=0..4).
 *
 * Env vars:
 *  - STADIA_API_KEY — server-only Stadia API key.
 */
import { defineEventHandler } from 'h3';
import { TILE_MAX_ZOOM, TILE_MIN_ZOOM } from '#/utils/tileBounds';

const ALLOWED_THEMES = new Set(['alidade_smooth', 'alidade_smooth_dark']);
const ALLOWED_REFERERS = [
  'https://sponsorsearch.co.uk',
  'https://www.sponsorsearch.co.uk',
];

export default defineEventHandler(async (event) => {
  const isProd = process.env.NODE_ENV === 'production';

  if (isProd) {
    const referer = event.req.headers.get('referer') ?? '';
    if (!ALLOWED_REFERERS.some((r) => referer.startsWith(r))) {
      return new Response(null, { status: 403 });
    }
  }

  const fetchSite = event.req.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin') {
    return new Response(null, { status: 403 });
  }

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
    return new Response(null, { status: 500 });
  }

  const upstream = await fetch(
    `https://tiles.stadiamaps.com/tiles/${theme}/${z}/${x}/${y}.png?api_key=${apiKey}`,
    {
      headers: {
        'User-Agent': 'SponsorSearch/1.0 (+https://sponsorsearch.co.uk)',
      },
    },
  );

  if (!upstream.ok) {
    return new Response(null, { status: upstream.status });
  }

  return new Response(await upstream.arrayBuffer(), {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=3600, s-maxage=31536000, immutable',
    },
  });
});

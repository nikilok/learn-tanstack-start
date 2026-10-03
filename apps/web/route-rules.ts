import type { NitroRouteConfig } from 'nitro/types';

import { BROWSER_CHECK_PATH } from './src/lib/device/browser-check-config';

/**
 * Nitro route rules (vite.config.ts). A rule's headers are merged over a 2xx
 * response's own, and Vercel's edge adds them to responses that set none, so
 * only the tile proxy and the service worker may set caching (locked by
 * route-rules.test.ts).
 */
export const ROUTE_RULES: Record<string, NitroRouteConfig> = {
  // Vercel BotID's challenge and its calls, for local development. In
  // production the rewrites in vercel.json answer these paths at
  // Vercel's edge, as BotID's setup asks: the edge rewrites Nitro makes
  // of these rules sit behind the site-wide headers rule, which ends
  // the match, and a challenge the function proxies reaches Vercel from
  // the function's address instead of the visitor's. The edge
  // middleware must pass the same path through.
  [`${BROWSER_CHECK_PATH}/a-4-a/c.js`]: {
    proxy: 'https://api.vercel.com/bot-protection/v1/challenge',
  },
  [`${BROWSER_CHECK_PATH}/**`]: {
    proxy: 'https://api.vercel.com/bot-protection/v1/proxy/**',
    headers: { 'X-Frame-Options': 'SAMEORIGIN' },
  },
  '/**': {
    headers: {
      // Force HTTPS for 2 years across all subdomains (no preload — reversible).
      'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
      // Block MIME sniffing — browsers must honor declared Content-Type.
      'X-Content-Type-Options': 'nosniff',
      // Full URL same-origin; origin only cross-origin; nothing on HTTPS→HTTP.
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      // Same-origin framing only: /download's live preview iframes the app
      // into a fake desktop window; cross-site embedding stays blocked.
      'X-Frame-Options': 'SAMEORIGIN',
      // Block legacy Flash/Acrobat cross-domain policy files.
      'X-Permitted-Cross-Domain-Policies': 'none',
      // Isolate browsing context from cross-origin openers (Spectre-era hardening). 'allow-popups' lets popups we open (e.g. the Vercel Toolbar auth flow) postMessage back via window.opener.
      'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
      // Disable browser APIs we don't use; loosen per-route if a feature ships.
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      // CSP subset: clickjacking + base-URL/plugin/form-hijack defense + HTTP→HTTPS upgrade. Script/style lockdown deferred.
      'Content-Security-Policy':
        "frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'; upgrade-insecure-requests",
    },
  },
  '/api/tiles/**': {
    headers: {
      'Cache-Control': 's-maxage=31536000, stale-while-revalidate=86400',
    },
  },
  '/sw.js': {
    headers: {
      // Always revalidate so clients pick up a new service worker promptly.
      'Cache-Control': 'public, max-age=0, must-revalidate',
    },
  },
};

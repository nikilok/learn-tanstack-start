import tailwindcss from '@tailwindcss/vite';
import { devtools } from '@tanstack/devtools-vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { vercelToolbar } from '@vercel/toolbar/plugins/vite';
import viteReact from '@vitejs/plugin-react';
import dotenv from 'dotenv';
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

dotenv.config({ path: '../../.env.local' });

// The fixed path BotID's client loads its challenge from (see `botid/nuxt`).
const BOTID_PREFIX =
  '/149e9513-01fa-4fb0-aad4-566afd725d1b/2d206a39-8ed7-437e-a3be-862e0f06eea3';

const config = defineConfig({
  plugins: [
    devtools(),
    tsconfigPaths({ projects: ['./tsconfig.json'] }),
    tailwindcss(),
    tanstackStart(),
    nitro({
      serverDir: 'server',
      routeRules: {
        // Vercel BotID's challenge, served first-party: the script and its
        // calls are proxied to Vercel, as the `botid/nuxt` module sets up for
        // Nitro. Production only; locally the check always answers human.
        [`${BOTID_PREFIX}/a-4-a/c.js`]: {
          proxy: 'https://api.vercel.com/bot-protection/v1/challenge',
        },
        [`${BOTID_PREFIX}/**`]: {
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
        '/company/**': {
          headers: {
            'Cache-Control': 's-maxage=2592000, stale-while-revalidate=604800',
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
      },
    }),
    viteReact(),
    vercelToolbar(),
  ],
  optimizeDeps: {
    exclude: ['@tanstack/start-server-core'],
  },
});

export default config;

import tailwindcss from '@tailwindcss/vite';
import { devtools } from '@tanstack/devtools-vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import dotenv from 'dotenv';
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

dotenv.config({ path: '../../.env.local' });

const config = defineConfig({
  plugins: [
    devtools(),
    tsconfigPaths({ projects: ['./tsconfig.json'] }),
    tailwindcss(),
    tanstackStart(),
    nitro({
      serverDir: 'server',
      routeRules: {
        '/**': {
          headers: {
            'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
            'X-Frame-Options': 'DENY',
            'X-Permitted-Cross-Domain-Policies': 'none',
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
            'Content-Security-Policy':
              "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'; upgrade-insecure-requests",
          },
        },
        '/company/**': {
          headers: {
            'Cache-Control': 's-maxage=2592000, stale-while-revalidate=604800',
          },
        },
      },
    }),
    viteReact(),
  ],
  optimizeDeps: {
    exclude: ['@tanstack/start-server-core'],
  },
});

export default config;

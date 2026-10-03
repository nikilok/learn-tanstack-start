import tailwindcss from '@tailwindcss/vite';
import { devtools } from '@tanstack/devtools-vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { vercelToolbar } from '@vercel/toolbar/plugins/vite';
import viteReact from '@vitejs/plugin-react';
import dotenv from 'dotenv';
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

import { ROUTE_RULES } from './route-rules';

dotenv.config({ path: '../../.env.local' });

const config = defineConfig({
  plugins: [
    devtools(),
    tsconfigPaths({ projects: ['./tsconfig.json'] }),
    tailwindcss(),
    tanstackStart(),
    nitro({
      serverDir: 'server',
      routeRules: ROUTE_RULES,
    }),
    viteReact(),
    vercelToolbar(),
  ],
  optimizeDeps: {
    exclude: ['@tanstack/start-server-core'],
  },
});

export default config;

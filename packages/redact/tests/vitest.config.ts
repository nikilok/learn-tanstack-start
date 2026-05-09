import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

// __dirname here is `packages/redact/tests`, so `..` gets us to the redact
// package root and `src/...` reaches the canonical TS source. We point both
// the `@ss/redact/*` and `react`/`react-dom` shapes at the same source files
// so tests exercise the actual implementation, not the built dist/.
const r = (p: string) => resolve(__dirname, '..', p)

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['**/*.test.{ts,tsx}'],
  },
  resolve: {
    alias: {
      '@ss/redact/jsx-runtime': r('src/react/jsx-runtime.ts'),
      '@ss/redact/jsx-dev-runtime': r('src/react/jsx-runtime.ts'),
      '@ss/redact/compiler-runtime': r('src/react/compiler-runtime.ts'),
      '@ss/redact/dom-client': r('src/dom/client.ts'),
      '@ss/redact/dom-test-utils': r('src/dom/test-utils.ts'),
      '@ss/redact/dom': r('src/dom/index.ts'),
      '@ss/redact/server': r('src/server/index.ts'),
      '@ss/redact/scheduler': r('src/scheduler/index.ts'),
      '@ss/redact/vite': r('src/vite/index.ts'),
      '@ss/redact': r('src/react/index.ts'),
      // React-shape aliases — what consumers will actually import
      'react/jsx-runtime': r('src/react/jsx-runtime.ts'),
      'react/jsx-dev-runtime': r('src/react/jsx-runtime.ts'),
      'react/compiler-runtime': r('src/react/compiler-runtime.ts'),
      react: r('src/react/index.ts'),
      'react-dom/client': r('src/dom/client.ts'),
      'react-dom/server': r('src/server/index.ts'),
      'react-dom/test-utils': r('src/dom/test-utils.ts'),
      'react-dom': r('src/dom/index.ts'),
      scheduler: r('src/scheduler/index.ts'),
    },
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: '@ss/redact',
  },
})

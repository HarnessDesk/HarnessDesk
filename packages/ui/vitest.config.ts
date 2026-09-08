import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Mirrors vite.config.ts: vendored shadcn components import via `@/`.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // The sanitiser and highlighter both work through real DOM APIs, so these
    // tests need a document rather than mocks of one.
    environment: 'jsdom',
    // jsdom omits a few real browser APIs the renderer uses; see the file.
    setupFiles: ['./src/setup-tests.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // The token sheets are asserted against, so they have to be real.
    // Vitest's default (`css: false`) stubs every CSS import — `?raw`
    // included — to the empty string, which does not fail: it makes a sheet
    // test pass whatever the sheet contains. `editorial-tokens.test.ts` had
    // been green and vacuous for exactly that reason.
    css: true,
  },
})

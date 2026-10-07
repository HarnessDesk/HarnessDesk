import { fileURLToPath } from 'node:url'

import { configDefaults, defineConfig } from 'vitest/config'

import { NODE_TESTS } from './vitest.node-tests.ts'

export default defineConfig({
  resolve: {
    alias: {
      // Mirrors vite.config.ts: vendored shadcn components import via `@/`.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // The token sheets are asserted against, so they have to be real.
    // Vitest's default (`css: false`) stubs every CSS import — `?raw`
    // included — to the empty string, which does not fail: it makes a sheet
    // test pass whatever the sheet contains. `editorial-tokens.test.ts` had
    // been green and vacuous for exactly that reason.
    css: true,
    projects: [
      {
        // Everything but the files named below. The sanitiser and highlighter
        // both work through real DOM APIs, so these tests need a document
        // rather than mocks of one.
        extends: true,
        test: {
          name: 'dom',
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
          environment: 'jsdom',
          // jsdom omits a few real browser APIs the renderer uses; see the file.
          setupFiles: ['./src/setup-tests.ts'],
          exclude: [...configDefaults.exclude, ...NODE_TESTS],
        },
      },
      {
        // The files that never use a DOM. jsdom is built again for every
        // file, so leaving it out of these is most of what they cost.
        extends: true,
        test: { name: 'node', environment: 'node', include: [...NODE_TESTS] },
      },
    ],
  },
})

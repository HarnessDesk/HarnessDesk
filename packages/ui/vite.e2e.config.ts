import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

import { E2E_PAGES } from '../../script/ci-imports.mjs'
import uiConfig from './vite.config.ts'

// The specs were written against the dev server, so the build is made in its
// mode: development React (the diagnostics `surfaces.spec.ts` turns into
// failures, StrictMode's second effect run), `import.meta.env.DEV` true and
// `import.meta.env.MODE` 'development'. Both are set here, before Vite reads
// them, so no caller has to remember to.
process.env.NODE_ENV = 'development'

// The suite's fixtures share the app's plugins and aliases. Bundling removes
// per-navigation transforms; readable chunks keep the build itself cheap.
export default defineConfig({
  ...uiConfig,
  mode: 'development',
  build: {
    ...uiConfig.build,
    outDir: 'dist-e2e',
    minify: false,
    rollupOptions: {
      input: Object.fromEntries(E2E_PAGES.map(page => [page.replace('.html', ''), fileURLToPath(new URL(page, import.meta.url))])),
    },
  },
})

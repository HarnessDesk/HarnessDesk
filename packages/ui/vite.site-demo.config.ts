import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * The website's embedded demo — the production renderer over a recorded host
 * (site-demo/fake-host.ts). Built apart from the app so nothing about the
 * desktop bundle changes; the output is copied into the harnessdesk-site
 * repository as static files.
 */
export default defineConfig({
  plugins: [
    {
      name: 'site-demo-placeholder-identities',
      // Shared preview data also carries the project's public demo persona.
      // The site's bundle uses placeholders, including unused fixture data.
      transform(code, id) {
        if (!id.includes('/src/preview/')) return
        return code
          .replace(/\b[\w.+-]+@harnessdesk\.app\b/g, 'dev@example.com')
          .replace(/\/Users\/[^/\\'"\s]+/g, '/Users/dev') // hd-secrets-ok: home-matching pattern, not an account path.
          .replace(/\b\w+-Cursor\b/g, 'Jane Doe')
      },
    },
    react(), tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  root: fileURLToPath(new URL('./site-demo', import.meta.url)),
  base: './',
  build: {
    outDir: fileURLToPath(new URL('./dist-site-demo', import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 3_000,
  },
  server: { port: 5274, strictPort: true },
})

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
  plugins: [react(), tailwindcss()],
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

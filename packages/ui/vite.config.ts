import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // The shadcn convention: components and their imports both say `@/`,
      // so a component vendored from the registry works unedited and the
      // CLI (`pnpm dlx shadcn@latest add …`) can write new ones.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Two pages: the app, and the design system rendered by itself. The
    // explorer ships with the app rather than living in a separate tool, so
    // the documentation is always the same build as the product — it cannot
    // describe a version of the system that is no longer running.
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        design: fileURLToPath(new URL('./design.html', import.meta.url)),
      },
    },
    // The host serves these over loopback and the page never reaches the
    // network, so a single chunk boundary keeps first paint simple.
    chunkSizeWarningLimit: 2_000,
  },
  server: {
    port: 5273,
    strictPort: true,
  },
})

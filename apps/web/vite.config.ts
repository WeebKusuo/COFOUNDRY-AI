import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Same-origin contract (Section 22): the browser only ever calls relative /api/v1 URLs.
// In development Vite proxies /api to the Express server on localhost:5000; the Origin header
// stays http://localhost:5173, which must equal APP_ORIGIN.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:5000', changeOrigin: false },
    },
  },
  preview: { port: 4173, strictPort: true },
  build: {
    outDir: 'dist',
    // Maps are generated for debugging but not referenced from the shipped bundle.
    sourcemap: 'hidden',
    // Never inline assets as data: URIs — the production CSP allows fonts from 'self' only.
    assetsInlineLimit: 0,
  },
});

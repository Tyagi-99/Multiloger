import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Multiloger dashboard. Dev server proxies API + WebSocket traffic to the
 * API server (default http://127.0.0.1:3000); production builds are static
 * files served by the API server itself (ServerOptions.webDir).
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/v1': { target: 'http://127.0.0.1:3000', changeOrigin: true, ws: true },
      '/health': { target: 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The SPA is built to web/dist and served by the payments worker via the
// Cloudflare ASSETS binding. In dev, `npm run dev` proxies the API to the
// worker on :8791 so the SPA can run with HMR against real endpoints.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://127.0.0.1:8791',
      '/webhooks': 'http://127.0.0.1:8791',
      '/v1': 'http://127.0.0.1:8791',
      '/health': 'http://127.0.0.1:8791',
    },
  },
});
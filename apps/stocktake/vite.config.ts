import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Standalone stock-take-lite PWA (P26). Built to a static bundle and served
// behind nginx on the VPS. VITE_API_BASE points at the Auto-Stock API origin
// (empty ⇒ same-origin, i.e. nginx proxies /api to the API).
export default defineConfig({
  plugins: [react()],
  server: { port: 4100 },
  build: { outDir: 'dist', sourcemap: false },
});

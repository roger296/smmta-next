import { createHash } from 'node:crypto';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { TanStackRouterVite } from '@tanstack/router-vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

/**
 * Stamp the service worker with a per-build cache name (Aug-2026 feedback,
 * E-2).
 *
 * `public/sw.js` is copied verbatim by Vite, so the substitution has to happen
 * in `generateBundle`. Without it the cache name is a hard-coded literal and a
 * redeploy keeps serving the previous shell cache-first for ever — the
 * `activate` sweep only deletes caches whose key differs from the current one.
 *
 * The id is derived from the wall clock at build time, which is enough: the
 * only property that matters is that a new deploy produces a new key.
 */
function serviceWorkerBuildId(): Plugin {
  const buildId = createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 12);
  return {
    name: 'sw-build-id',
    apply: 'build',
    generateBundle(_options, bundle) {
      const sw = bundle['sw.js'];
      if (sw && sw.type === 'asset' && typeof sw.source === 'string') {
        sw.source = sw.source.replaceAll('__BUILD_ID__', buildId);
      }
    },
  };
}

export default defineConfig({
  plugins: [
    TanStackRouterVite({
      routesDirectory: 'src/routes',
      generatedRouteTree: 'src/routeTree.gen.ts',
      // Tests colocated with a route file are not routes. Without this the
      // generator warns on every dev-server boot and every Playwright run.
      routeFileIgnorePattern: '\\.(test|spec)\\.tsx?$',
    }),
    react(),
    tailwindcss(),
    serviceWorkerBuildId(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    host: true,
  },
});

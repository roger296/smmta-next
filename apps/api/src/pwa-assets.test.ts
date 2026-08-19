/**
 * PWA shell assets (P12, spec §A1). Validates the apps/web PWA manifest +
 * service worker are present and well-formed. Lives in the api package because
 * it needs Node fs (the web build's tsc -b has no Node types).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Resolve relative to this file (apps/api/src) so cwd doesn't matter:
// ../../web/public = apps/web/public.
const here = path.dirname(fileURLToPath(import.meta.url));
const webPublic = (f: string) => path.resolve(here, '../../web/public', f);

describe('PWA shell assets', () => {
  it('ships a valid web manifest', () => {
    const m = JSON.parse(readFileSync(webPublic('manifest.webmanifest'), 'utf8')) as {
      name: string;
      start_url: string;
      display: string;
      icons: Array<{ sizes: string }>;
    };
    expect(m.name).toMatch(/Big Bakes Stock/);
    expect(m.start_url).toBe('/');
    expect(m.display).toBe('standalone');
    expect(m.icons.some((i) => i.sizes === '512x512')).toBe(true);
  });

  it('ships a service worker that never caches the API', () => {
    const sw = readFileSync(webPublic('sw.js'), 'utf8');
    expect(existsSync(webPublic('sw.js'))).toBe(true);
    expect(sw).toMatch(/\/api\//); // the SW explicitly bypasses /api/
  });
});

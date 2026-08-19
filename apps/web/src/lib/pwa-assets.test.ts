/**
 * PWA entry-point assets (Aug-2026 feedback set, defects E-2 / E-6).
 *
 * "Adding the iPad PIN login page to the home screen redirects incorrectly to
 * the standard email login page." The manifest's `start_url` was `/`, and `/`
 * is under `_authed`, which sends an unauthenticated visitor to `/login`.
 *
 * (The API package has its own `pwa-assets.test.ts` asserting the manifest is
 * present and well-formed — it lives there because it needs Node fs. This one
 * asserts the venue-entry contract specifically, next to the code that depends
 * on it.)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');

describe('manifest.webmanifest (E-2, E-6)', () => {
  const manifest = JSON.parse(readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8')) as {
    id?: string;
    name: string;
    start_url: string;
    scope: string;
    display: string;
    orientation: string;
  };

  it('E-2: an installed icon opens the PIN screen, not the dashboard', () => {
    expect(manifest.start_url).toBe('/pin-login');
  });

  it('keeps the whole app in scope, so links out of the PIN screen stay in the PWA', () => {
    expect(manifest.scope).toBe('/');
  });

  it('declares an id, so an existing install updates rather than duplicating', () => {
    expect(manifest.id).toBe('/pin-login');
  });

  it('E-6: works in both orientations — the venue tested and uses both', () => {
    expect(manifest.orientation).toBe('any');
  });

  it('is still a standalone app with the right name', () => {
    expect(manifest.display).toBe('standalone');
    expect(manifest.name).toMatch(/Big Bakes Stock/);
  });
});

describe('service worker (E-2)', () => {
  const sw = readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');

  it('pre-caches the PIN screen — the start_url must work offline', () => {
    expect(sw).toMatch(/'\/pin-login'/);
  });

  it('derives its cache name from the build, so a redeploy invalidates', () => {
    // The old hard-coded name meant `activate`'s sweep never fired: it only
    // deletes caches whose key differs from the current one, and the key never
    // changed. A stale shell was served cache-first for ever.
    expect(sw).not.toContain('autostock-shell-v1');
    expect(sw).toContain('__BUILD_ID__');
    expect(sw).toContain('${BUILD_ID}');
  });

  it('still never caches API traffic', () => {
    expect(sw).toMatch(/url\.pathname\.startsWith\('\/api\/'\)/);
  });
});

describe('index.html (E-2)', () => {
  const html = readFileSync(path.resolve(PUBLIC, '../index.html'), 'utf8');

  it('sets the iOS standalone status-bar style', () => {
    expect(html).toMatch(/apple-mobile-web-app-status-bar-style/);
  });

  it('opts into the safe area, which .topbar then pads for', () => {
    expect(html).toMatch(/viewport-fit=cover/);
  });
});

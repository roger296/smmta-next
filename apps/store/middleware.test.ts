/**
 * Unit tests for the Edge middleware. Covers:
 *   - 308 redirect on mixed-case `/shop/...` paths to lowercase
 *   - 308 redirect stripping `?utm_*` params
 *   - `?colour=` is preserved (page UI state, not an SEO duplicate)
 *   - non-`/shop` paths fall through to the admin gating logic
 *   - admin gating still issues 401 / login redirects as before
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

const REAL_KEY = 'k'.repeat(48);

beforeEach(() => {
  process.env.ADMIN_API_KEY = REAL_KEY;
});

afterEach(() => {
  delete process.env.ADMIN_API_KEY;
});

function makeRequest(url: string, opts: { cookie?: string } = {}): NextRequest {
  const headers = new Headers();
  if (opts.cookie) headers.set('cookie', opts.cookie);
  return new NextRequest(new URL(url), { headers });
}

describe('SEO canonicalisation', () => {
  it('308-redirects mixed-case shop paths to lowercase', async () => {
    const { middleware } = await import('./middleware');
    const res = await middleware(makeRequest('https://filament.shop/shop/Aurora'));
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://filament.shop/shop/aurora');
  });

  it('308-strips utm_* params from /shop URLs', async () => {
    const { middleware } = await import('./middleware');
    const res = await middleware(
      makeRequest(
        'https://filament.shop/shop/aurora?utm_source=newsletter&utm_medium=email&colour=Smoke',
      ),
    );
    expect(res.status).toBe(308);
    const loc = res.headers.get('location') ?? '';
    expect(loc).not.toContain('utm_source');
    expect(loc).not.toContain('utm_medium');
    // colour= is a real UI state — it must survive.
    expect(loc).toContain('colour=Smoke');
  });

  it('passes a clean lowercase shop URL through unchanged', async () => {
    const { middleware } = await import('./middleware');
    const res = await middleware(
      makeRequest('https://filament.shop/shop/aurora?colour=Smoke'),
    );
    // Pass-through → 200 / NextResponse.next(); status is 200.
    expect(res.status).toBe(200);
  });

  it('does not run canonicalisation outside /shop', async () => {
    const { middleware } = await import('./middleware');
    const res = await middleware(
      makeRequest('https://filament.shop/?utm_source=newsletter'),
    );
    // The matcher excludes /, so middleware shouldn't even run here in
    // production. We invoke it directly to ensure it doesn't strip
    // params on non-/shop paths if the matcher were widened.
    expect(res.status).toBe(200);
  });
});

describe('admin gating (regression)', () => {
  it('redirects /admin/refunds to /admin/login when no cookie is present', async () => {
    const { middleware } = await import('./middleware');
    const res = await middleware(makeRequest('https://filament.shop/admin/refunds'));
    expect(res.status).toBe(307); // NextResponse.redirect default
    expect(res.headers.get('location') ?? '').toContain('/admin/login');
  });

  it('returns 401 JSON for /api/admin/* when no cookie is present', async () => {
    const { middleware } = await import('./middleware');
    const res = await middleware(
      makeRequest('https://filament.shop/api/admin/refunds'),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
  });

  it('lets /admin/login through unauthenticated', async () => {
    const { middleware } = await import('./middleware');
    const res = await middleware(makeRequest('https://filament.shop/admin/login'));
    expect(res.status).toBe(200);
  });
});

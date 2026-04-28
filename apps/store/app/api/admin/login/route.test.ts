/**
 * Tests for /api/admin/login. We mock `next/headers` so the cookie store
 * is in-memory and the handler can run from a vitest worker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeCookie {
  value: string;
  options?: Record<string, unknown>;
}
const cookieStore = new Map<string, FakeCookie>();
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => {
      const v = cookieStore.get(name);
      return v ? { name, value: v.value } : undefined;
    },
    set: (name: string, value: string, options: Record<string, unknown>) => {
      cookieStore.set(name, { value, options });
    },
    delete: (name: string) => {
      cookieStore.delete(name);
    },
  })),
}));

const REAL_KEY = 'k'.repeat(48);

beforeEach(() => {
  vi.resetModules();
  cookieStore.clear();
  process.env.ADMIN_API_KEY = REAL_KEY;
});

afterEach(() => {
  delete process.env.ADMIN_API_KEY;
});

function req(body: unknown, accept = 'application/json') {
  return new Request('http://localhost/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}

describe('POST /api/admin/login', () => {
  it('returns 401 on a wrong key (no cookie set)', async () => {
    const { POST } = await import('./route');
    const res = await POST(req({ key: 'nope' }));
    expect(res.status).toBe(401);
    expect(cookieStore.has('admin_session')).toBe(false);
  });

  it('returns 200 + sets the admin_session cookie on success', async () => {
    const { POST } = await import('./route');
    const res = await POST(req({ key: REAL_KEY }));
    expect(res.status).toBe(200);
    expect(cookieStore.has('admin_session')).toBe(true);
  });

  it('redirects HTML form submissions to the next path', async () => {
    const { POST } = await import('./route');
    const res = await POST(req({ key: REAL_KEY, next: '/admin/refunds/tr_1' }, 'text/html'));
    expect(res.status).toBe(303);
    expect(res.headers.get('location') ?? '').toContain('/admin/refunds/tr_1');
  });

  it('rejects external `next` redirects (anti-open-redirect)', async () => {
    const { POST } = await import('./route');
    const res = await POST(req({ key: REAL_KEY, next: 'https://evil.example/x' }, 'text/html'));
    expect(res.status).toBe(303);
    const loc = res.headers.get('location') ?? '';
    expect(loc).toContain('/admin/refunds');
    expect(loc).not.toContain('evil.example');
  });
});

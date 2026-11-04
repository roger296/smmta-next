/**
 * The /email/* pass-through to the API's unsubscribe and preferences pages.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from './route';

afterEach(() => vi.unstubAllGlobals());

const ctx = (path: string[]) => ({ params: Promise.resolve({ path }) });

describe('/email/* proxy', () => {
  it('forwards a one-click POST with its body, content type and client address', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const req = new NextRequest('https://shop.example.com/email/u/tok_123', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': '203.0.113.9',
      },
      body: 'List-Unsubscribe=One-Click',
    });
    const res = await POST(req, ctx(['u', 'tok_123']));
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/email\/u\/tok_123$/);
    expect(url).not.toContain('/api/v1');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('List-Unsubscribe=One-Click');
    expect((init.headers as Record<string, string>)['x-forwarded-for']).toBe('203.0.113.9');
  });

  it('passes the page and its noindex header back', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('<h1>Email preferences</h1>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex, nofollow', 'set-cookie': 'x=1' },
        }),
      ),
    );
    const res = await GET(new NextRequest('https://shop.example.com/email/preferences/t'), ctx(['preferences', 't']));
    expect(await res.text()).toContain('Email preferences');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('answers 503 when the API is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const res = await GET(new NextRequest('https://shop.example.com/email/u/t'), ctx(['u', 't']));
    expect(res.status).toBe(503);
  });
});

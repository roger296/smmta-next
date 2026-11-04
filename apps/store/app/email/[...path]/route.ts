/**
 * /email/* — the email unsubscribe and preferences pages. They are rendered
 * by the SMMTA API (modules/email/public); this route passes each request
 * through so the links in our emails stay on the shop's own domain, which is
 * what makes them look trustworthy and what Gmail's one-click unsubscribe
 * calls. Proxied at request time (not a next.config rewrite) because the
 * API's address is only known at runtime in the Docker deploy.
 */
import type { NextRequest } from 'next/server';
import { getEnv } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PASS_BACK = ['content-type', 'x-robots-tag', 'cache-control', 'referrer-policy', 'retry-after'];

async function proxy(request: NextRequest, path: string[]): Promise<Response> {
  const apiOrigin = new URL(getEnv().SMMTA_API_BASE_URL).origin;
  const target = `${apiOrigin}/email/${path.map(encodeURIComponent).join('/')}`;
  const forwardedFor =
    request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip') ?? '';
  const headers: Record<string, string> = {
    'user-agent': request.headers.get('user-agent') ?? '',
  };
  if (forwardedFor) headers['x-forwarded-for'] = forwardedFor;
  const contentType = request.headers.get('content-type');
  if (contentType) headers['content-type'] = contentType;

  try {
    const res = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === 'POST' ? await request.text() : undefined,
      cache: 'no-store',
      redirect: 'manual',
    });
    const out = new Headers();
    for (const h of PASS_BACK) {
      const v = res.headers.get(h);
      if (v) out.set(h, v);
    }
    return new Response(await res.text(), { status: res.status, headers: out });
  } catch {
    // One-click unsubscribe callers only look at the status; a person sees
    // a plain message rather than a stack trace.
    return new Response('Sorry — this page is not available right now. Please try again shortly.', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '60' },
    });
  }
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, ctx: Ctx) {
  return proxy(request, (await ctx.params).path);
}

export async function POST(request: NextRequest, ctx: Ctx) {
  return proxy(request, (await ctx.params).path);
}

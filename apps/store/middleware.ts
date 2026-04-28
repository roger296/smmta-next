/**
 * Edge middleware — two responsibilities:
 *
 *   1. **Admin gating.** `/admin/*` (excluding `/admin/login`) and
 *      `/api/admin/*` (excluding `/api/admin/login`) require the signed
 *      `admin_session` cookie. We can't import `node:crypto` from
 *      middleware (Edge runtime), so verify uses Web Crypto inline —
 *      same HMAC, same constant-time comparison.
 *
 *   2. **SEO canonicalisation.** Mixed-case slugs under `/shop/...`
 *      308-redirect to their lowercase form so search engines index
 *      one canonical URL. `utm_*` params are stripped on shop /
 *      catalogue pages — analytics still capture them via the
 *      Referer / first-page navigation, but they shouldn't fragment
 *      caches or appear as duplicate content. `?colour=` is preserved
 *      because it's a real UI state on group pages (the page's
 *      `<link rel="canonical">` points at the bare `/shop/[slug]`).
 *
 *      We don't redirect `/api/*` or `/admin/*` (admin login + API
 *      routes legitimately receive utm_* on cross-origin POSTs in
 *      some flows).
 */
import { NextResponse, type NextRequest } from 'next/server';

const ADMIN_COOKIE = 'admin_session';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

async function hmacOk(secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode('ok'));
  // base64url encode
  const bytes = new Uint8Array(sig);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function verifyAdmin(request: NextRequest): Promise<boolean> {
  const value = request.cookies.get(ADMIN_COOKIE)?.value;
  if (!value) return false;
  const secret = process.env.ADMIN_API_KEY;
  if (!secret) return false;
  const expected = await hmacOk(secret);
  return timingSafeEqual(expected, value);
}

/** Walk the URL searchParams and drop any `utm_*` keys. Returns the new
 *  URL when at least one was removed; null when there's nothing to do. */
function stripUtmParams(url: URL): URL | null {
  const toRemove: string[] = [];
  for (const key of url.searchParams.keys()) {
    if (key.toLowerCase().startsWith('utm_')) toRemove.push(key);
  }
  if (toRemove.length === 0) return null;
  const next = new URL(url.toString());
  for (const k of toRemove) next.searchParams.delete(k);
  return next;
}

/** Lower-case the path portion of `/shop/<...>` URLs. Returns the new
 *  URL when the path actually had any uppercase chars; null otherwise. */
function lowerCaseShopPath(url: URL): URL | null {
  const path = url.pathname;
  if (!path.startsWith('/shop')) return null;
  if (path === path.toLowerCase()) return null;
  const next = new URL(url.toString());
  next.pathname = path.toLowerCase();
  return next;
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // ------------------------------------------------------------------
  // 1. SEO canonicalisation (only for storefront paths under /shop —
  //    admin / API are handled separately below).
  // ------------------------------------------------------------------
  if (pathname.startsWith('/shop')) {
    const stripped = stripUtmParams(request.nextUrl);
    if (stripped) {
      return NextResponse.redirect(stripped, { status: 308 });
    }
    const lowered = lowerCaseShopPath(request.nextUrl);
    if (lowered) {
      return NextResponse.redirect(lowered, { status: 308 });
    }
  }

  // ------------------------------------------------------------------
  // 2. Admin gating.
  // ------------------------------------------------------------------
  // Allow login surface itself.
  if (pathname === '/admin/login' || pathname === '/api/admin/login') {
    return NextResponse.next();
  }

  const isAdminPath = pathname.startsWith('/admin/') || pathname === '/admin';
  const isAdminApi = pathname.startsWith('/api/admin/');
  if (!isAdminPath && !isAdminApi) {
    return NextResponse.next();
  }

  const ok = await verifyAdmin(request);
  if (ok) return NextResponse.next();

  // For API: 401 JSON. For pages: redirect to /admin/login with a `next`.
  if (isAdminApi) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } },
    );
  }
  const loginUrl = new URL('/admin/login', request.url);
  loginUrl.searchParams.set('next', pathname + request.nextUrl.search);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Match the admin surface (gating) plus /shop/* (canonicalisation).
  // Other public paths (/, /faq, /track, /cart, /checkout) don't need
  // either, so we keep the matcher narrow.
  matcher: ['/admin/:path*', '/api/admin/:path*', '/shop/:path*'],
};

/**
 * Edge middleware — gates `/admin/*` (excluding `/admin/login`) and
 * `/api/admin/*` (excluding `/api/admin/login`) on the signed
 * `admin_session` cookie.
 *
 * We can't import `node:crypto` from middleware (Edge runtime), so the
 * verify is implemented inline using the Web Crypto API — same HMAC,
 * same constant-time comparison.
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

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

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
  matcher: ['/admin/:path*', '/api/admin/:path*'],
};

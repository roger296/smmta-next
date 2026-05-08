/**
 * POST /api/admin/logout — clears the `admin_session` cookie.
 *
 * Form submissions (the "Sign out" button on the admin layout) get a 303
 * back to /admin/login; JSON callers get { ok: true }.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { clearAdminCookie } from '@/lib/admin-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  await clearAdminCookie();
  const wantsHtml = request.headers.get('accept')?.includes('text/html') ?? false;
  if (wantsHtml) {
    return NextResponse.redirect(new URL('/admin/login', request.url), { status: 303 });
  }
  return NextResponse.json({ ok: true });
}

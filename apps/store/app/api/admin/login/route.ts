/**
 * POST /api/admin/login
 *
 * Accepts `{ key: string }` (or form-encoded equivalent), constant-time
 * compares against `ADMIN_API_KEY`, and on success sets the signed
 * `admin_session` cookie. The middleware does the gating; this route is
 * the only thing under /api/admin that's *allowed* through unauthenticated.
 *
 * Rate-limit / lock-out is intentionally not implemented here — the v1
 * surface is single-operator and the key is high-entropy. A real auth
 * provider (Cognito / Auth0 / SSO) replaces this whole module.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { verifyAdminKey, writeAdminCookie } from '@/lib/admin-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  key: z.string().min(1),
  next: z.string().optional(),
});

async function parseBody(request: NextRequest): Promise<unknown> {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return await request.json().catch(() => ({}));
  }
  const fd = await request.formData();
  return Object.fromEntries(fd.entries());
}

/** Sanitise the post-login redirect target so we can't be used as an
 *  open redirect — only same-origin pathnames are allowed. */
function sanitiseNext(raw: string | undefined): string {
  if (!raw) return '/admin/refunds';
  if (!raw.startsWith('/')) return '/admin/refunds';
  if (raw.startsWith('//')) return '/admin/refunds';
  return raw;
}

export async function POST(request: NextRequest) {
  const body = await parseBody(request);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  if (!verifyAdminKey(parsed.data.key)) {
    return NextResponse.json({ error: 'Invalid key' }, { status: 401 });
  }

  await writeAdminCookie();

  const wantsHtml = request.headers.get('accept')?.includes('text/html') ?? false;
  if (wantsHtml) {
    const redirectTo = sanitiseNext(parsed.data.next);
    return NextResponse.redirect(new URL(redirectTo, request.url), { status: 303 });
  }
  return NextResponse.json({ ok: true });
}

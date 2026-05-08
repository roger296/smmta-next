/**
 * POST /api/notify-me — public storefront endpoint for the
 * "notify me when back in stock" form. Validates input, then forwards
 * to SMMTA-NEXT's `POST /storefront/notify-me` using the storefront's
 * api-key. Generic responses on failure so we don't leak whether an
 * email was already in either table.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { notifyMe, SmmtaApiError } from '@/lib/smmta';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  productId: z.string().uuid(),
  email: z.string().email().max(320),
  subscribeToNewsletter: z.boolean().default(true),
});

export async function POST(request: NextRequest) {
  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_request', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    await notifyMe(parsed.data);
    return NextResponse.json({ ok: true });
  } catch (err) {
    // Don't leak the upstream error verbatim — keep the surface small
    // and uniform so a client can't fingerprint internal state.
    const status = err instanceof SmmtaApiError ? err.status : 500;
    return NextResponse.json(
      { error: 'notify_failed' },
      { status: status >= 400 && status < 500 ? 400 : 500 },
    );
  }
}

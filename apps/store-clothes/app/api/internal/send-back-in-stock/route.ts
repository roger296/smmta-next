/**
 * POST /api/internal/send-back-in-stock — enqueue a "back in stock" email.
 *
 * Called by the SMMTA-NEXT API after a GRN books in stock that produces
 * free units for a SKU with pending notifications. Auth is the same
 * `Bearer <ADMIN_API_KEY>` pattern used by `process-outbox` (and on the
 * API side, this is `STORE_INTERNAL_API_KEY`).
 *
 * Persistence: this route uses the same `email_outbox` queue as every
 * other transactional email — the actual SendGrid call happens later
 * when `process-outbox` is called by cron. Using the queue means a
 * SendGrid outage doesn't lose the notification, and the existing
 * `(orderId, template)` idempotency guard isn't relevant here (we
 * deliberately enqueue without an orderId).
 */
import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getEnv } from '@/lib/env';
import { enqueue } from '@/lib/email';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  email: z.string().email().max(320),
  productId: z.string().uuid(),
  productName: z.string().min(1).max(500),
  productSlug: z.string().max(200).nullable(),
  productImageUrl: z.string().max(1024).nullable(),
  priceGbp: z.string().regex(/^\d+(\.\d{1,2})?$/).nullable(),
  colour: z.string().max(80).nullable(),
});

function authorised(request: NextRequest): boolean {
  const expected = getEnv().ADMIN_API_KEY;
  if (!expected) return false;
  const got = request.headers.get('authorization') ?? '';
  if (!got.startsWith('Bearer ')) return false;
  const token = got.slice('Bearer '.length).trim();
  if (token.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  if (!authorised(request)) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } },
    );
  }

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid payload', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const env = getEnv();
  const storeBaseUrl = env.STORE_BASE_URL ?? 'http://localhost:3000';

  await enqueue(
    'back_in_stock',
    {
      storeBaseUrl,
      productName: parsed.data.productName,
      productSlug: parsed.data.productSlug,
      productImageUrl: parsed.data.productImageUrl,
      priceGbp: parsed.data.priceGbp,
      colour: parsed.data.colour,
    },
    parsed.data.email,
  );

  return NextResponse.json({ ok: true });
}

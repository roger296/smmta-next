/**
 * POST /api/internal/order-status — receiver for SMMTA-NEXT to ping when
 * an order's status changes (SHIPPED, CANCELLED). When that wiring lands
 * on the SMMTA side, this stub will translate into the right outbox
 * enqueue and the cron will deliver the email on its next pass.
 *
 * For now this is a documented stub: it accepts the JSON body, validates
 * shape, and enqueues the matching template if the order is one we know
 * about (i.e. we have a local checkouts row with that smmta_order_id).
 *
 * Auth: `Authorization: Bearer <ADMIN_API_KEY>` — same convention as
 * the outbox processor, since both endpoints are operator-only.
 */
import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { checkouts } from '@/drizzle/schema';
import { enqueue } from '@/lib/email';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  orderId: z.string().uuid(),
  status: z.enum(['SHIPPED', 'CANCELLED']),
  shippedDate: z.string().optional(),
  trackingNumber: z.string().optional(),
  trackingLink: z.string().url().optional(),
  courierName: z.string().optional(),
  cancelReason: z.string().optional(),
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
  const raw = await request.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid body', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { orderId, status, shippedDate, trackingNumber, trackingLink, courierName, cancelReason } =
    parsed.data;

  // Cross-reference the SMMTA order against our checkouts table to find
  // the customer's email + order number.
  const db = getDb();
  const checkout = await db.query.checkouts.findFirst({
    where: eq(checkouts.smmtaOrderId, orderId),
  });
  if (!checkout) {
    return NextResponse.json(
      { error: 'Unknown order — no local checkout row' },
      { status: 404 },
    );
  }
  const customer = checkout.customer as
    | { email?: string; firstName?: string; lastName?: string }
    | null
    | undefined;
  if (!customer?.email) {
    return NextResponse.json(
      { error: 'No customer email captured for this order' },
      { status: 422 },
    );
  }

  const env = getEnv();
  const baseUrl = env.STORE_BASE_URL;

  if (status === 'SHIPPED') {
    await enqueue(
      'order_shipped',
      {
        orderId,
        // We don't know the SMMTA order number here without an API hop.
        // Use the local idempotencyKey-derived public ref the
        // confirmation page already shows.
        orderNumber: `STORE-${(checkout.idempotencyKey ?? checkout.id).slice(-12).toUpperCase()}`,
        firstName: customer.firstName,
        storeBaseUrl: baseUrl,
        shippedDate,
        trackingNumber,
        trackingLink,
        courierName,
      },
      customer.email,
      { orderId },
    );
  } else {
    await enqueue(
      'order_cancelled',
      {
        orderId,
        orderNumber: `STORE-${(checkout.idempotencyKey ?? checkout.id).slice(-12).toUpperCase()}`,
        firstName: customer.firstName,
        storeBaseUrl: baseUrl,
        reason: cancelReason,
      },
      customer.email,
      { orderId },
    );
  }

  return NextResponse.json({ ok: true });
}

/**
 * POST /api/internal/order-status — SMMTA-NEXT tells the storefront an order's
 * status changed (SHIPPED, CANCELLED), and the matching email is enqueued. The
 * outbox cron delivers it on its next pass.
 *
 * Storefront orders are matched to their local checkouts row, whose captured
 * customer email is used. Orders the storefront never saw — created in the
 * admin — have no checkouts row, so SMMTA sends the customer's email, first
 * name and order number in the body instead, and the same branded email goes
 * out for them.
 *
 * The enqueue is idempotent per (orderId, template), so SMMTA retrying after a
 * lost response cannot send the customer the email twice.
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
import { shippedEmailExtras } from '@/lib/order-adverts';

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
  // For orders with no local checkouts row (created in the admin).
  orderNumber: z.string().max(100).optional(),
  customerEmail: z.string().email().optional(),
  customerFirstName: z.string().max(100).optional(),
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
  const body = parsed.data;

  // A storefront order's checkouts row holds the email the customer gave at
  // checkout, which is preferred over anything sent in the body.
  const db = getDb();
  const checkout = await db.query.checkouts.findFirst({
    where: eq(checkouts.smmtaOrderId, body.orderId),
  });
  if (!checkout && !body.customerEmail) {
    return NextResponse.json(
      { error: 'Unknown order — no local checkout row and no customer email supplied' },
      { status: 404 },
    );
  }
  const captured = checkout?.customer as
    | { email?: string; firstName?: string; lastName?: string }
    | null
    | undefined;
  const email = captured?.email ?? body.customerEmail;
  if (!email) {
    return NextResponse.json(
      { error: 'No customer email captured for this order' },
      { status: 422 },
    );
  }
  const firstName = captured?.firstName ?? body.customerFirstName;
  // SMMTA's own order number when it sends one; otherwise the public reference
  // the storefront derives for its orders, as the confirmation page shows.
  const orderNumber =
    body.orderNumber ??
    (checkout
      ? `STORE-${(checkout.idempotencyKey ?? checkout.id).slice(-12).toUpperCase()}`
      : body.orderId.slice(0, 8).toUpperCase());

  const baseUrl = getEnv().STORE_BASE_URL;

  if (body.status === 'SHIPPED') {
    // Ranges picked for this customer, and whether their VAT invoice can be
    // downloaded yet. Captured now, so the email sent is the one chosen at
    // dispatch; simply left out if SMMTA cannot supply them.
    const { recommendations, invoiceAvailable } = await shippedEmailExtras(body.orderId);
    await enqueue(
      'order_shipped',
      {
        orderId: body.orderId,
        orderNumber,
        firstName,
        storeBaseUrl: baseUrl,
        shippedDate: body.shippedDate,
        trackingNumber: body.trackingNumber,
        trackingLink: body.trackingLink,
        courierName: body.courierName,
        recommendations,
        invoiceAvailable,
      },
      email,
      { orderId: body.orderId },
    );
  } else {
    await enqueue(
      'order_cancelled',
      {
        orderId: body.orderId,
        orderNumber,
        firstName,
        storeBaseUrl: baseUrl,
        reason: body.cancelReason,
      },
      email,
      { orderId: body.orderId },
    );
  }

  return NextResponse.json({ ok: true });
}

/**
 * POST /api/track/resend-email
 *
 *   { orderId: string }
 *
 * Re-enqueues the customer's `order_confirmation` email after looking up
 * the original payload from the most-recent `email_outbox` row for that
 * order. We always send to the email **already on file** for the order
 * (read off the checkout) — the orderId in the body is just the lookup
 * key, the email address is server-trusted.
 *
 * Rate-limit: at most one confirmation event per orderId per hour. We
 * enforce it by reading every email_outbox row whose payload's
 * `orderId` JSONB key equals the requested orderId, then taking the
 * latest sent_at / created_at and rejecting if it's within the last
 * hour. Storing the limiter in Postgres (rather than in-process)
 * survives restarts and works across multiple Next instances.
 *
 * The resend row is enqueued with `options.orderId = null` so it doesn't
 * collide with the original confirmation under the unique partial index
 * on (order_id, template). The original payload (and its embedded
 * orderId) carries the linkage forward.
 *
 * Privacy: probes for non-existent or unknown orders return a generic
 * 200 — we don't disclose existence.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { emailOutbox, checkouts } from '@/drizzle/schema';
import { enqueue } from '@/lib/email';
import type { OrderConfirmationPayload } from '@/lib/email-templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RATE_LIMIT_SECONDS = 60 * 60; // 1 hour

const bodySchema = z.object({
  orderId: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const orderId = parsed.data.orderId;
  const db = getDb();

  // 1. All confirmation rows tied to this order — by the original
  //    `order_id` column, by the payload's embedded orderId (covers
  //    resends, which have order_id = null), or both.
  const confirmationRows = await db
    .select({
      id: emailOutbox.id,
      orderId: emailOutbox.orderId,
      payload: emailOutbox.payload,
      sentAt: emailOutbox.sentAt,
      createdAt: emailOutbox.createdAt,
    })
    .from(emailOutbox)
    .where(
      and(
        eq(emailOutbox.template, 'order_confirmation'),
        sql`(${emailOutbox.orderId} = ${orderId} OR ${emailOutbox.payload} ->> 'orderId' = ${orderId})`,
      ),
    )
    .orderBy(desc(emailOutbox.createdAt));

  if (confirmationRows.length === 0) {
    // Treat as "nothing to resend" — return 200 with a generic message
    // so we don't disclose order existence to UUID-probers.
    return NextResponse.json({
      ok: true,
      message: 'If a confirmation is on file for that order, a copy is on its way.',
    });
  }

  // 2. Rate-limit on the most recent activity (sent or queued).
  const latestEvent = confirmationRows
    .map((r) => r.sentAt ?? r.createdAt)
    .filter((d): d is Date => d instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  if (latestEvent) {
    const ageSec = (Date.now() - latestEvent.getTime()) / 1000;
    if (ageSec < RATE_LIMIT_SECONDS) {
      const retryAfterSeconds = Math.ceil(RATE_LIMIT_SECONDS - ageSec);
      return NextResponse.json(
        {
          error: 'A confirmation email was sent recently. Please try again later.',
          retryAfterSeconds,
        },
        {
          status: 429,
          headers: { 'Retry-After': String(retryAfterSeconds) },
        },
      );
    }
  }

  // 3. Resolve the customer's email from the checkout linked to this
  //    SMMTA order id. Server-trusted — never read from request body.
  const checkout = await db.query.checkouts.findFirst({
    where: eq(checkouts.smmtaOrderId, orderId),
  });
  const customer = checkout?.customer as
    | { email?: string; firstName?: string; lastName?: string }
    | null
    | undefined;
  if (!customer?.email) {
    return NextResponse.json({
      ok: true,
      message: 'If a confirmation is on file for that order, a copy is on its way.',
    });
  }

  // 4. Re-use the original payload verbatim so the resend looks
  //    identical to the first email. The original is the row with the
  //    earliest createdAt — confirmationRows is desc, so the last entry.
  const original = confirmationRows[confirmationRows.length - 1];
  if (!original) {
    return NextResponse.json({ ok: true, message: 'A copy is on its way.' });
  }
  const payload = original.payload as unknown as OrderConfirmationPayload;

  // `orderId: null` (the column) avoids the unique-index collision with
  // the first confirmation. The payload's own orderId field is what
  // links the resend back to the order for future rate-limit lookups.
  await enqueue('order_confirmation', payload, customer.email);

  return NextResponse.json({
    ok: true,
    message: 'A copy of your confirmation is on its way — give it a few minutes.',
  });
}

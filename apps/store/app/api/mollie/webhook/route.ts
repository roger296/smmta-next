/**
 * POST /api/mollie/webhook — Mollie's payment-state callback.
 *
 * Mollie's webhook body is form-urlencoded with a single field, `id=tr_...`.
 * The body is **never trusted**: we always re-fetch GET /v2/payments/:id
 * with our server API key (`finalizeFromMollie`) and use the response as
 * ground truth. Idempotent on Mollie payment id — replays are safe (the
 * SMMTA order-commit call is itself idempotent on the checkout's
 * Idempotency-Key).
 *
 * Always responds 200 once we've persisted whatever we learned. Any 5xx
 * we throw causes Mollie to retry on its standard back-off, which is the
 * desired behaviour for a transient SMMTA outage.
 *
 * `runtime = 'nodejs'` is mandatory — the Mollie SDK / our DB driver
 * aren't edge-compatible.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { webhookDeliveries } from '@/drizzle/schema';
import { finalizeFromMollie } from '@/lib/checkout';
import { MollieApiError } from '@/lib/mollie';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const db = getDb();

  // Capture the raw body up-front. We log it verbatim so the audit trail
  // captures whatever Mollie actually sent, even if parsing fails.
  const rawBody = await request.text();
  let molliePaymentId: string | null = null;
  try {
    const params = new URLSearchParams(rawBody);
    const id = params.get('id');
    if (typeof id === 'string' && id.startsWith('tr_')) {
      molliePaymentId = id;
    }
  } catch {
    // Fall through — body is logged below; we'll respond 400 then.
  }

  if (!molliePaymentId) {
    await db.insert(webhookDeliveries).values({
      source: 'mollie',
      rawBody,
      signatureOk: false,
      error: 'No id in body',
    });
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  }

  // 1. Log the raw delivery before doing any work, so a crash later doesn't
  //    cost us the audit trail.
  const [delivery] = await db
    .insert(webhookDeliveries)
    .values({
      source: 'mollie',
      rawBody,
      signatureOk: false, // flipped below once the re-fetch succeeds
    })
    .returning({ id: webhookDeliveries.id });

  try {
    // 2. Re-fetch + finalize. Idempotent on subsequent webhook deliveries.
    const result = await finalizeFromMollie(molliePaymentId);

    // 3. Mark the delivery as verified + record the action taken.
    if (delivery) {
      await db
        .update(webhookDeliveries)
        .set({
          signatureOk: true,
          fetchedPaymentStatus: result.mollieStatus,
          actionTaken:
            result.status === 'COMMITTED'
              ? `committed order ${result.smmtaOrderId}`
              : result.status === 'FAILED'
                ? 'released reservation'
                : `held in ${result.status}`,
        })
        .where(eq(webhookDeliveries.id, delivery.id));
    }

    return NextResponse.json({ ok: true, status: result.status });
  } catch (err) {
    if (delivery) {
      await db
        .update(webhookDeliveries)
        .set({
          error: err instanceof Error ? err.message : 'Unknown error',
        })
        .where(eq(webhookDeliveries.id, delivery.id));
    }
    // Mollie-specific 4xx (invalid id) → return 400 so Mollie stops
    // retrying. Network / SMMTA 5xx → return 502 so Mollie does retry.
    if (err instanceof MollieApiError && err.status >= 400 && err.status < 500) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Webhook processing failed' },
      { status: 502 },
    );
  }
}

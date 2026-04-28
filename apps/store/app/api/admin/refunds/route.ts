/**
 * POST /api/admin/refunds
 *
 *   { paymentId, amountGbp, reason?, smmtaCreditNoteId? }
 *
 * Calls `issueRefund` which:
 *   - validates the requested amount against payment + already-refunded total,
 *   - creates the Mollie refund (idempotent on credit-note id + amount),
 *   - inserts the local `mollie_refunds` row,
 *   - enqueues the customer's `refund_issued` email.
 *
 * Errors map onto HTTP statuses via `RefundError.status`. Mollie API
 * errors bubble up as 502.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { issueRefund, RefundError } from '@/lib/refunds';
import { MollieApiError } from '@/lib/mollie';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  paymentId: z.string().min(1).regex(/^tr_/, 'Mollie payment ids start with tr_'),
  amountGbp: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/, 'amountGbp must be a major-unit decimal'),
  reason: z.string().max(500).optional(),
  smmtaCreditNoteId: z.string().uuid().optional(),
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

  try {
    const result = await issueRefund(parsed.data);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof RefundError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    }
    if (err instanceof MollieApiError) {
      return NextResponse.json(
        { error: err.message, code: 'MOLLIE_REFUND_FAILED' },
        { status: 502 },
      );
    }
    throw err;
  }
}

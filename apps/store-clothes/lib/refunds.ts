/**
 * Refund orchestration.
 *
 * The credit-note in SMMTA-NEXT remains an operator step in `apps/web`
 * (per the architecture doc + Prompt 12). This module covers the
 * Mollie side:
 *
 *   - listRecentPaidPayments() — surface for the admin list page
 *   - getPaymentDetail()       — surface for the admin detail page
 *   - issueRefund()            — Mollie createRefund + record locally,
 *                                 enqueue the refund_issued email, return
 *                                 the new refund row.
 *
 * Server-only.
 */
import 'server-only';
import { and, desc, eq, sum } from 'drizzle-orm';
import { getDb } from './db';
import { getEnv } from './env';
import { checkouts, mollieRefunds, molliePayments } from '@/drizzle/schema';
import { createRefund } from './mollie';
import { enqueue } from './email';

export interface AdminPaymentRow {
  paymentId: string;
  status: string;
  method: string | null;
  amountGbp: string;
  currency: string;
  createdAt: Date;
  smmtaOrderId: string | null;
  customerEmail: string | null;
  customerName: string | null;
  refundedGbp: string;
  refundsToDate: number;
}

/** Recent `paid|authorized` payments — joined with the local checkouts
 *  row for the customer name + smmta order id. Used by the admin list. */
export async function listRecentPaidPayments(limit = 50): Promise<AdminPaymentRow[]> {
  const db = getDb();
  // Drizzle 0.41 doesn't expose nice SUM with grouping cleanly across
  // joins, so we read once and fold in JS — the admin list is bounded.
  const rows = await db
    .select({
      paymentId: molliePayments.id,
      status: molliePayments.status,
      method: molliePayments.method,
      amountGbp: molliePayments.amountGbp,
      currency: molliePayments.currency,
      createdAt: molliePayments.createdAt,
      checkoutId: molliePayments.checkoutId,
    })
    .from(molliePayments)
    .orderBy(desc(molliePayments.createdAt))
    .limit(limit);

  if (rows.length === 0) return [];

  const checkoutIds = rows.map((r) => r.checkoutId);
  const checkoutRows = checkoutIds.length
    ? await db.query.checkouts.findMany({
        where: (c, { inArray }) => inArray(c.id, checkoutIds),
      })
    : [];
  const checkoutById = new Map(checkoutRows.map((c) => [c.id, c]));

  const refunds = await db
    .select({
      paymentId: mollieRefunds.paymentId,
      amountGbp: mollieRefunds.amountGbp,
    })
    .from(mollieRefunds);
  const refundByPayment = new Map<string, { sumPence: number; count: number }>();
  for (const r of refunds) {
    const existing = refundByPayment.get(r.paymentId) ?? { sumPence: 0, count: 0 };
    existing.sumPence += Math.round(Number.parseFloat(r.amountGbp) * 100);
    existing.count += 1;
    refundByPayment.set(r.paymentId, existing);
  }

  return rows.map((row) => {
    const checkout = checkoutById.get(row.checkoutId);
    const customer = checkout?.customer as
      | { email?: string; firstName?: string; lastName?: string }
      | null
      | undefined;
    const refundAgg = refundByPayment.get(row.paymentId) ?? { sumPence: 0, count: 0 };
    return {
      paymentId: row.paymentId,
      status: row.status,
      method: row.method,
      amountGbp: row.amountGbp,
      currency: row.currency,
      createdAt: row.createdAt,
      smmtaOrderId: checkout?.smmtaOrderId ?? null,
      customerEmail: customer?.email ?? null,
      customerName:
        customer?.firstName || customer?.lastName
          ? `${customer.firstName ?? ''} ${customer.lastName ?? ''}`.trim()
          : null,
      refundedGbp: (refundAgg.sumPence / 100).toFixed(2),
      refundsToDate: refundAgg.count,
    };
  });
  // (sum import is referenced indirectly via the SQL helper below, but
  // we kept the JS aggregation for clarity. Silence the unused warning.)
  void sum;
}

export interface AdminPaymentDetail extends AdminPaymentRow {
  refunds: Array<{
    id: string;
    amountGbp: string;
    currency: string;
    status: string;
    description: string | null;
    smmtaCreditNoteId: string | null;
    createdAt: Date;
  }>;
}

export async function getPaymentDetail(paymentId: string): Promise<AdminPaymentDetail | null> {
  const db = getDb();
  const payment = await db.query.molliePayments.findFirst({
    where: eq(molliePayments.id, paymentId),
  });
  if (!payment) return null;
  const checkout = await db.query.checkouts.findFirst({
    where: eq(checkouts.id, payment.checkoutId),
  });
  const refundRows = await db.query.mollieRefunds.findMany({
    where: eq(mollieRefunds.paymentId, paymentId),
    orderBy: (r, { desc: d }) => [d(r.createdAt)],
  });
  const customer = checkout?.customer as
    | { email?: string; firstName?: string; lastName?: string }
    | null
    | undefined;
  const refundedPence = refundRows.reduce(
    (s, r) => s + Math.round(Number.parseFloat(r.amountGbp) * 100),
    0,
  );
  return {
    paymentId: payment.id,
    status: payment.status,
    method: payment.method,
    amountGbp: payment.amountGbp,
    currency: payment.currency,
    createdAt: payment.createdAt,
    smmtaOrderId: checkout?.smmtaOrderId ?? null,
    customerEmail: customer?.email ?? null,
    customerName:
      customer?.firstName || customer?.lastName
        ? `${customer.firstName ?? ''} ${customer.lastName ?? ''}`.trim()
        : null,
    refundedGbp: (refundedPence / 100).toFixed(2),
    refundsToDate: refundRows.length,
    refunds: refundRows.map((r) => ({
      id: r.id,
      amountGbp: r.amountGbp,
      currency: 'GBP',
      status: r.status,
      description: null,
      smmtaCreditNoteId: r.smmtaCreditNoteId,
      createdAt: r.createdAt,
    })),
  };
}

export class RefundError extends Error {
  readonly code: 'PAYMENT_NOT_FOUND' | 'AMOUNT_INVALID' | 'AMOUNT_EXCEEDS_REMAINING';
  readonly status: number;
  constructor(message: string, code: RefundError['code'], status: number) {
    super(message);
    this.name = 'RefundError';
    this.code = code;
    this.status = status;
  }
}

export interface IssueRefundInput {
  paymentId: string;
  amountGbp: string;
  reason?: string;
  /** Optional credit-note id from SMMTA-NEXT — operators paste it in
   *  after creating the credit note in `apps/web`. */
  smmtaCreditNoteId?: string;
}

export interface IssueRefundResult {
  refundId: string;
  status: string;
  amountGbp: string;
}

export async function issueRefund(input: IssueRefundInput): Promise<IssueRefundResult> {
  const db = getDb();
  const payment = await db.query.molliePayments.findFirst({
    where: eq(molliePayments.id, input.paymentId),
  });
  if (!payment) {
    throw new RefundError(
      `Payment ${input.paymentId} not found`,
      'PAYMENT_NOT_FOUND',
      404,
    );
  }

  const requestedPence = Math.round(Number.parseFloat(input.amountGbp) * 100);
  if (!Number.isFinite(requestedPence) || requestedPence <= 0) {
    throw new RefundError(`Invalid amount ${input.amountGbp}`, 'AMOUNT_INVALID', 400);
  }
  const paidPence = Math.round(Number.parseFloat(payment.amountGbp) * 100);
  const existingRefunds = await db
    .select({ amountGbp: mollieRefunds.amountGbp })
    .from(mollieRefunds)
    .where(eq(mollieRefunds.paymentId, input.paymentId));
  const refundedPence = existingRefunds.reduce(
    (s, r) => s + Math.round(Number.parseFloat(r.amountGbp) * 100),
    0,
  );
  if (refundedPence + requestedPence > paidPence) {
    throw new RefundError(
      `Refund amount £${input.amountGbp} exceeds remaining £${(
        (paidPence - refundedPence) /
        100
      ).toFixed(2)} on payment ${input.paymentId}`,
      'AMOUNT_EXCEEDS_REMAINING',
      422,
    );
  }

  // Use a deterministic-but-unique idempotency key per refund attempt so
  // the same operator click can't double-refund. credit-note-id +
  // requested-amount is a reasonable composite; falls back to timestamp
  // if no credit-note id is provided.
  const idempotencyKey = input.smmtaCreditNoteId
    ? `cn-${input.smmtaCreditNoteId}-${requestedPence}`
    : `${input.paymentId}-${requestedPence}-${Date.now()}`;

  const refund = await createRefund({
    paymentId: input.paymentId,
    amount: { value: input.amountGbp, currency: payment.currency },
    description: input.reason,
    idempotencyKey,
  });

  await db.insert(mollieRefunds).values({
    id: refund.id,
    paymentId: input.paymentId,
    smmtaCreditNoteId: input.smmtaCreditNoteId ?? null,
    amountGbp: refund.amount.value,
    status: refund.status,
    rawPayload: refund as unknown as Record<string, unknown>,
  });

  // Best-effort: enqueue the customer's refund_issued email. Pull the
  // customer from the checkout linked to this payment.
  try {
    const checkout = await db.query.checkouts.findFirst({
      where: eq(checkouts.id, payment.checkoutId),
    });
    const customer = checkout?.customer as
      | { email?: string; firstName?: string; lastName?: string }
      | null
      | undefined;
    if (customer?.email && checkout?.smmtaOrderId) {
      await enqueue(
        'refund_issued',
        {
          orderId: checkout.smmtaOrderId,
          orderNumber: `STORE-${(checkout.idempotencyKey ?? checkout.id)
            .slice(-12)
            .toUpperCase()}`,
          firstName: customer.firstName,
          storeBaseUrl: getEnv().STORE_BASE_URL,
          refundAmount: refund.amount.value,
          currency: refund.amount.currency,
          refundId: refund.id,
        },
        customer.email,
        // Don't gate on (orderId, template) here — partial refunds may
        // legitimately recur. We deliberately omit options.orderId so
        // each refund_issued email is its own outbox row (the unique
        // partial index treats null orderIds as distinct, so multiple
        // refund_issued rows per order are allowed). The natural
        // duplicate-suppression is upstream: the mollie_refunds insert
        // is keyed on refund.id (PK), so issueRefund can never produce
        // two rows for the same refund.
      );
    }
  } catch {
    // Email enqueue failure does not fail the refund.
  }

  return {
    refundId: refund.id,
    status: refund.status,
    amountGbp: refund.amount.value,
  };
}

/** Refresh local `mollie_refunds` rows from Mollie's source of truth.
 *  Called by the Mollie webhook handler whenever a payment delivery
 *  arrives — Mollie re-triggers the payment webhook on refund events,
 *  so a fresh `listRefunds` call is the cheapest way to stay in sync. */
export async function refreshRefundsForPayment(paymentId: string): Promise<{ updated: number }> {
  const { listRefunds } = await import('./mollie');
  const remote = await listRefunds(paymentId);
  if (remote.length === 0) return { updated: 0 };

  const db = getDb();
  let updated = 0;
  for (const r of remote) {
    const existing = await db.query.mollieRefunds.findFirst({
      where: and(eq(mollieRefunds.id, r.id), eq(mollieRefunds.paymentId, paymentId)),
    });
    if (existing) {
      await db
        .update(mollieRefunds)
        .set({
          status: r.status,
          amountGbp: r.amount.value,
          rawPayload: r as unknown as Record<string, unknown>,
          updatedAt: new Date(),
        })
        .where(eq(mollieRefunds.id, r.id));
    } else {
      await db.insert(mollieRefunds).values({
        id: r.id,
        paymentId,
        amountGbp: r.amount.value,
        status: r.status,
        rawPayload: r as unknown as Record<string, unknown>,
      });
    }
    updated += 1;
  }
  return { updated };
}

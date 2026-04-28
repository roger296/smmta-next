/**
 * Checkout orchestration — turns a cart into a Mollie payment, then
 * (later, via the webhook) into a SMMTA order.
 *
 * State machine on `checkouts`:
 *   OPEN      ── startCheckout ────────────> RESERVED (stock held)
 *   RESERVED  ── createPayment ────────────> PAYING   (Mollie redirect)
 *   PAYING    ── webhook(paid|authorized) ─> COMMITTED (SMMTA order id)
 *   PAYING    ── webhook(canceled|failed) ─> FAILED   (reservation released)
 *
 * The webhook is the source of truth — `/checkout/return` polls
 * `/api/checkout/status`, which reads the local `checkouts` row first
 * and falls back to a live Mollie `getPayment(id)` if the customer's
 * been on the return page > 30s without a webhook landing.
 *
 * Server-only.
 */
import 'server-only';
import { eq } from 'drizzle-orm';
import { getDb } from './db';
import { getEnv } from './env';
import {
  carts,
  cartItems,
  checkouts,
  molliePayments,
} from '@/drizzle/schema';
import { getOrCreateCart, type CartView } from './cart';
import {
  commitOrder,
  createReservation,
  InsufficientStockError,
  releaseReservation,
  SmmtaApiError,
} from './smmta';
import {
  createPayment,
  getPayment,
  isCommitableStatus,
  isTerminalNonPaid,
  MollieApiError,
  type MolliePayment,
} from './mollie';

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

export interface CheckoutAddress {
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postCode: string;
  country: string;
  contactName?: string;
}

export interface CheckoutCustomer {
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
}

export interface StartCheckoutInput {
  cartId: string;
  customer: CheckoutCustomer;
  deliveryAddress: CheckoutAddress;
  invoiceAddress?: CheckoutAddress;
}

export interface StartCheckoutOk {
  ok: true;
  checkoutId: string;
  checkoutUrl: string;
}

export type StartCheckoutResult =
  | StartCheckoutOk
  | { ok: false; error: 'EMPTY_CART' }
  | { ok: false; error: 'INSUFFICIENT_STOCK'; productId: string; available: number; requested: number }
  | { ok: false; error: 'PAYMENT_CREATE_FAILED'; reason: string };

export type CheckoutStatus =
  | 'OPEN'
  | 'RESERVED'
  | 'PAYING'
  | 'COMMITTED'
  | 'FAILED'
  | 'ABANDONED';

export interface CheckoutStatusView {
  checkoutId: string;
  status: CheckoutStatus;
  smmtaOrderId: string | null;
  mollieStatus: string | null;
  /** Set when status is FAILED; used by the return page to render the
   *  retry CTA with a useful explanation. */
  failureReason: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toPence(amount: string): number {
  const n = Number(amount);
  if (!Number.isFinite(n)) throw new Error(`Invalid amount ${amount}`);
  return Math.round(n * 100);
}
function fromPence(p: number): string {
  return (p / 100).toFixed(2);
}

function describeOrder(cart: CartView): string {
  const lineNames = cart.lines
    .map((l) => `${l.quantity}× ${l.display.name ?? l.productId}`)
    .join(', ');
  return `Filament Store — ${lineNames}`.slice(0, 200);
}

// ---------------------------------------------------------------------------
// startCheckout
// ---------------------------------------------------------------------------

export async function startCheckout(input: StartCheckoutInput): Promise<StartCheckoutResult> {
  const env = getEnv();
  const db = getDb();
  const cart = await getOrCreateCart(input.cartId);
  if (!cart.cartId || cart.lines.length === 0) {
    return { ok: false, error: 'EMPTY_CART' };
  }

  // 1. Insert the checkout row in OPEN state. We capture the customer +
  //    addresses immediately so they survive a crash between here and the
  //    Mollie call.
  const [checkoutRow] = await db
    .insert(checkouts)
    .values({
      cartId: cart.cartId,
      status: 'OPEN',
      customer: input.customer,
      // The checkouts.deliveryAddress / invoiceAddress columns are typed
      // `Record<string, unknown> | null` at the schema level; the typed
      // CheckoutAddress here is a strict subset, so the cast is safe.
      deliveryAddress: input.deliveryAddress as unknown as Record<string, unknown>,
      invoiceAddress: (input.invoiceAddress ?? null) as Record<string, unknown> | null,
      idempotencyKey: null,
    })
    .returning({ id: checkouts.id });
  if (!checkoutRow) throw new Error('Failed to insert checkout row');
  const checkoutId = checkoutRow.id;

  // 2. Reserve stock against SMMTA.
  let reservation;
  try {
    reservation = await createReservation(
      cart.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
      { ttlSeconds: 15 * 60 },
    );
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      await db
        .update(checkouts)
        .set({ status: 'FAILED', updatedAt: new Date() })
        .where(eq(checkouts.id, checkoutId));
      return {
        ok: false,
        error: 'INSUFFICIENT_STOCK',
        productId: err.productId,
        available: err.available,
        requested: err.requested,
      };
    }
    throw err;
  }

  await db
    .update(checkouts)
    .set({
      status: 'RESERVED',
      reservationId: reservation.reservationId,
      expiresAt: new Date(reservation.expiresAt),
      idempotencyKey: checkoutId, // reuse checkoutId as the idempotency key
      updatedAt: new Date(),
    })
    .where(eq(checkouts.id, checkoutId));

  // 3. Compute the gross total (cart subtotal + flat shipping). This is
  //    Mollie's `amount`. The order-commit path on SMMTA recomputes from
  //    canonical product prices and refuses on >1p drift, so we need to
  //    pass exactly what SMMTA will compute.
  const subtotalPence = toPence(cart.subtotalGbp);
  const shippingPence = toPence(env.STORE_DEFAULT_SHIPPING_GBP);
  const grandTotalPence = subtotalPence + shippingPence;
  const amountValue = fromPence(grandTotalPence);

  // 4. Create the Mollie payment.
  let payment: MolliePayment;
  try {
    payment = await createPayment({
      amount: { value: amountValue, currency: 'GBP' },
      description: describeOrder(cart),
      redirectUrl: `${env.STORE_BASE_URL.replace(/\/$/, '')}/checkout/return?cid=${checkoutId}`,
      webhookUrl: `${env.MOLLIE_WEBHOOK_URL_BASE.replace(/\/$/, '')}/api/mollie/webhook`,
      metadata: { checkoutId, reservationId: reservation.reservationId },
      idempotencyKey: checkoutId,
    });
  } catch (err) {
    // Roll back the reservation; let the customer try again.
    await releaseReservation(reservation.reservationId).catch(() => undefined);
    await db
      .update(checkouts)
      .set({ status: 'FAILED', updatedAt: new Date() })
      .where(eq(checkouts.id, checkoutId));
    return {
      ok: false,
      error: 'PAYMENT_CREATE_FAILED',
      reason: err instanceof Error ? err.message : 'Unknown Mollie error',
    };
  }

  if (!payment.checkoutUrl) {
    await releaseReservation(reservation.reservationId).catch(() => undefined);
    await db
      .update(checkouts)
      .set({ status: 'FAILED', updatedAt: new Date() })
      .where(eq(checkouts.id, checkoutId));
    return { ok: false, error: 'PAYMENT_CREATE_FAILED', reason: 'No checkoutUrl in Mollie response' };
  }

  // 5. Persist the local mollie_payments row + flip checkout to PAYING.
  await db.insert(molliePayments).values({
    id: payment.id,
    checkoutId,
    amountGbp: payment.amount.value,
    currency: payment.amount.currency,
    method: payment.method ?? null,
    status: payment.status,
    rawPayload: payment as unknown as Record<string, unknown>,
  });
  await db
    .update(checkouts)
    .set({
      status: 'PAYING',
      molliePaymentId: payment.id,
      updatedAt: new Date(),
    })
    .where(eq(checkouts.id, checkoutId));

  return { ok: true, checkoutId, checkoutUrl: payment.checkoutUrl };
}

// ---------------------------------------------------------------------------
// finalizeFromMollie — invoked by the webhook handler AND by the status
// route's safety-net fallback. Idempotent.
// ---------------------------------------------------------------------------

export interface FinalizeResult {
  status: CheckoutStatus;
  smmtaOrderId: string | null;
  mollieStatus: string;
}

export async function finalizeFromMollie(molliePaymentId: string): Promise<FinalizeResult> {
  const db = getDb();

  // 1. Re-fetch from Mollie — never trust an unauthenticated webhook body.
  const payment = await getPayment(molliePaymentId);

  // 2. Persist whatever Mollie says.
  await db
    .update(molliePayments)
    .set({
      status: payment.status,
      method: payment.method,
      amountGbp: payment.amount.value,
      currency: payment.amount.currency,
      rawPayload: payment as unknown as Record<string, unknown>,
      updatedAt: new Date(),
    })
    .where(eq(molliePayments.id, molliePaymentId));

  // 3. Look up the local checkout row.
  const checkout = await db.query.checkouts.findFirst({
    where: eq(checkouts.molliePaymentId, molliePaymentId),
  });
  if (!checkout) {
    return { status: 'FAILED', smmtaOrderId: null, mollieStatus: payment.status };
  }

  // Already-committed checkout? Nothing more to do — the webhook is being
  // replayed (Mollie retries on non-200) and SMMTA's idempotency key would
  // catch it anyway, but short-circuiting saves a network hop.
  if (checkout.status === 'COMMITTED') {
    return {
      status: 'COMMITTED',
      smmtaOrderId: checkout.smmtaOrderId,
      mollieStatus: payment.status,
    };
  }
  if (checkout.status === 'FAILED') {
    return { status: 'FAILED', smmtaOrderId: null, mollieStatus: payment.status };
  }

  if (isCommitableStatus(payment.status)) {
    if (!checkout.reservationId || !checkout.customer || !checkout.deliveryAddress) {
      throw new Error(
        `Checkout ${checkout.id} is missing reservationId / customer / delivery address`,
      );
    }
    const env = getEnv();
    const result = await commitOrder(
      {
        reservationId: checkout.reservationId,
        customer: checkout.customer,
        deliveryAddress: checkout.deliveryAddress as unknown as Parameters<typeof commitOrder>[0]['deliveryAddress'],
        invoiceAddress: (checkout.invoiceAddress as unknown as Parameters<typeof commitOrder>[0]['invoiceAddress']) ?? undefined,
        mollie: {
          paymentId: payment.id,
          amount: payment.amount.value,
          currency: payment.amount.currency,
          methodPaid: payment.method ?? 'unknown',
          status: payment.status,
        },
        deliveryCharge: env.STORE_DEFAULT_SHIPPING_GBP,
      },
      checkout.idempotencyKey ?? checkout.id,
    );
    await db
      .update(checkouts)
      .set({
        status: 'COMMITTED',
        smmtaOrderId: result.orderId,
        updatedAt: new Date(),
      })
      .where(eq(checkouts.id, checkout.id));

    // Wipe the cart so the next visit starts fresh.
    if (checkout.cartId) {
      await db
        .update(carts)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(carts.id, checkout.cartId));
      await db.delete(cartItems).where(eq(cartItems.cartId, checkout.cartId));
    }

    // Enqueue the order_confirmation email. Idempotent on
    // (orderId, template) so a duplicate webhook delivery doesn't
    // queue a second email. Failure is logged but doesn't fail the
    // commit — the confirmation page also enqueues as a backstop.
    const customerForEmail = checkout.customer as
      | { email?: string; firstName?: string; lastName?: string }
      | null;
    if (customerForEmail?.email) {
      const { enqueue } = await import('./email');
      await enqueue(
        'order_confirmation',
        {
          orderId: result.orderId,
          orderNumber: `STORE-${(checkout.idempotencyKey ?? checkout.id).slice(-12).toUpperCase()}`,
          firstName: customerForEmail.firstName,
          grandTotal: payment.amount.value,
          currency: payment.amount.currency,
          storeBaseUrl: env.STORE_BASE_URL,
        },
        customerForEmail.email,
        { orderId: result.orderId },
      ).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[checkout] enqueue order_confirmation failed:', err);
        return { enqueued: false };
      });
    }

    return {
      status: 'COMMITTED',
      smmtaOrderId: result.orderId,
      mollieStatus: payment.status,
    };
  }

  if (isTerminalNonPaid(payment.status)) {
    if (checkout.reservationId) {
      await releaseReservation(checkout.reservationId).catch(() => undefined);
    }
    await db
      .update(checkouts)
      .set({ status: 'FAILED', updatedAt: new Date() })
      .where(eq(checkouts.id, checkout.id));
    return { status: 'FAILED', smmtaOrderId: null, mollieStatus: payment.status };
  }

  // open / pending / authorized-without-capture — leave the checkout in PAYING.
  return {
    status: checkout.status as CheckoutStatus,
    smmtaOrderId: checkout.smmtaOrderId,
    mollieStatus: payment.status,
  };
}

// ---------------------------------------------------------------------------
// getCheckoutStatus — used by /api/checkout/status. Falls back to a live
// Mollie fetch if the local row is still PAYING and was created > N seconds
// ago (the webhook hasn't landed in the expected window).
// ---------------------------------------------------------------------------

const FALLBACK_AFTER_MS = 30_000;

export async function getCheckoutStatus(checkoutId: string): Promise<CheckoutStatusView | null> {
  const db = getDb();
  const checkout = await db.query.checkouts.findFirst({
    where: eq(checkouts.id, checkoutId),
  });
  if (!checkout) return null;

  let mollieStatus: string | null = null;
  if (checkout.molliePaymentId) {
    const local = await db.query.molliePayments.findFirst({
      where: eq(molliePayments.id, checkout.molliePaymentId),
    });
    mollieStatus = local?.status ?? null;
  }

  const stale =
    checkout.status === 'PAYING' &&
    Date.now() - checkout.createdAt.getTime() > FALLBACK_AFTER_MS;

  if (stale && checkout.molliePaymentId) {
    try {
      const result = await finalizeFromMollie(checkout.molliePaymentId);
      return {
        checkoutId: checkout.id,
        status: result.status,
        smmtaOrderId: result.smmtaOrderId,
        mollieStatus: result.mollieStatus,
        failureReason: null,
      };
    } catch (err) {
      // The fallback is best-effort. Surface the local state so the customer
      // can at least retry.
      return {
        checkoutId: checkout.id,
        status: checkout.status as CheckoutStatus,
        smmtaOrderId: checkout.smmtaOrderId,
        mollieStatus,
        failureReason: err instanceof Error ? err.message : 'Status fallback failed',
      };
    }
  }

  return {
    checkoutId: checkout.id,
    status: checkout.status as CheckoutStatus,
    smmtaOrderId: checkout.smmtaOrderId,
    mollieStatus,
    failureReason: null,
  };
}

// ---------------------------------------------------------------------------
// Re-exports so route handlers can `import from '@/lib/checkout'`.
// ---------------------------------------------------------------------------

export {
  InsufficientStockError,
  MollieApiError,
  SmmtaApiError,
};

/**
 * Integration tests for the checkout orchestration. Hits a real Postgres
 * for `carts` / `cart_items` / `checkouts` / `mollie_payments`. The Mollie
 * and SMMTA modules are mocked so the test doesn't need real upstream
 * services.
 *
 * Covers:
 *   - startCheckout happy path (cart → reservation → Mollie → PAYING)
 *   - startCheckout 409 INSUFFICIENT_STOCK surfaces typed error + leaves
 *     the checkout row marked FAILED
 *   - finalizeFromMollie commits on `paid` and is idempotent on replay
 *   - finalizeFromMollie releases the reservation on `canceled`
 *   - getCheckoutStatus's Mollie fallback fires when the checkout has
 *     been PAYING for >30s without a webhook
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

const PRODUCT_ID = 'cccccccc-1111-4222-8333-444444444444';

// ---- Mocks ---------------------------------------------------------------

const smmtaCalls = {
  reservationsCreated: 0,
  ordersCommitted: 0,
  reservationsReleased: 0,
};
let nextReservationFails: { type: 'stock'; available: number } | null = null;
let lastOrderCommitInput: unknown = null;

vi.mock('./smmta', async () => {
  const actual = await vi.importActual<typeof import('./smmta')>('./smmta');
  return {
    ...actual,
    getProductsByIds: vi.fn(async (ids: string[]) =>
      ids.map((id) => ({
        id,
        slug: 'aurora-smoke',
        colour: 'Smoke',
        colourHex: null,
        priceGbp: '24.00',
        availableQty: 10,
        heroImageUrl: null,
        name: 'Aurora — Smoke',
        shortDescription: null,
        longDescription: null,
        galleryImageUrls: null,
        seoTitle: null,
        seoDescription: null,
        seoKeywords: null,
        sortOrderInGroup: 0,
        groupId: null,
      })),
    ),
    createReservation: vi.fn(async () => {
      smmtaCalls.reservationsCreated += 1;
      if (nextReservationFails) {
        const f = nextReservationFails;
        nextReservationFails = null;
        throw new actual.InsufficientStockError({
          productId: PRODUCT_ID,
          available: f.available,
          requested: 99,
        });
      }
      return {
        reservationId: '00000000-0000-4000-8000-000000000aaa',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        lines: [{ productId: PRODUCT_ID, quantity: 1, stockItemIds: ['si-1'] }],
      };
    }),
    releaseReservation: vi.fn(async () => {
      smmtaCalls.reservationsReleased += 1;
    }),
    commitOrder: vi.fn(async (input: unknown) => {
      smmtaCalls.ordersCommitted += 1;
      lastOrderCommitInput = input;
      return { orderId: '00000000-0000-4000-8000-000000000bbb', status: 'ALLOCATED' };
    }),
  };
});

let mollieGetState: { status: string; method: string | null } = { status: 'paid', method: 'creditcard' };

vi.mock('./mollie', async () => {
  const actual = await vi.importActual<typeof import('./mollie')>('./mollie');
  return {
    ...actual,
    createPayment: vi.fn(async () => ({
      id: 'tr_mock_1',
      status: 'open',
      amount: { value: '28.95', currency: 'GBP' },
      method: null,
      description: 'mock',
      metadata: { checkoutId: 'cid-1' },
      redirectUrl: 'http://localhost:3000/checkout/return?cid=cid-1',
      webhookUrl: 'http://localhost:3000/api/mollie/webhook',
      checkoutUrl: 'https://www.mollie.com/checkout/select-method/test_mock',
    })),
    getPayment: vi.fn(async () => ({
      id: 'tr_mock_1',
      status: mollieGetState.status,
      amount: { value: '28.95', currency: 'GBP' },
      method: mollieGetState.method,
      description: 'mock',
      metadata: { checkoutId: 'cid-1' },
      redirectUrl: null,
      webhookUrl: null,
      checkoutUrl: null,
    })),
  };
});

// Pull SUT + DB after mocks are in place.
const { addItem, getOrCreateCart } = await import('./cart');
const { startCheckout, finalizeFromMollie, getCheckoutStatus } = await import('./checkout');
const { closeDatabase, getDb } = await import('./db');
const { carts, cartItems, checkouts, molliePayments } = await import('@/drizzle/schema');

beforeAll(() => {
  process.env.STORE_COOKIE_SECRET = 'checkout-test-secret-32bytes-min!';
  process.env.STORE_DEFAULT_SHIPPING_GBP = '4.95';
  process.env.STORE_BASE_URL = 'http://localhost:3000';
  process.env.MOLLIE_WEBHOOK_URL_BASE = 'http://localhost:3000';
});

beforeEach(async () => {
  const db = getDb();
  // 1) Drop any mollie_payments / checkouts that might be hanging around
  //    from a previous run. The mock uses a deterministic id, so the
  //    unique constraints would trip otherwise.
  await db.delete(molliePayments).where(eq(molliePayments.id, 'tr_mock_1'));
  await db.delete(checkouts).where(eq(checkouts.molliePaymentId, 'tr_mock_1'));
  // 2) Clean carts seeded with the test product, plus any checkouts /
  //    payments anchored on those carts.
  const dirty = await db
    .select({ cartId: cartItems.cartId })
    .from(cartItems)
    .where(eq(cartItems.productId, PRODUCT_ID));
  const dirtyCartIds = Array.from(new Set(dirty.map((r) => r.cartId)));
  if (dirtyCartIds.length > 0) {
    const dirtyCheckouts = await db
      .select({ id: checkouts.id })
      .from(checkouts)
      .where(inArray(checkouts.cartId, dirtyCartIds));
    const checkoutIds = dirtyCheckouts.map((r) => r.id);
    if (checkoutIds.length > 0) {
      await db.delete(molliePayments).where(inArray(molliePayments.checkoutId, checkoutIds));
      await db.delete(checkouts).where(inArray(checkouts.id, checkoutIds));
    }
    await db.delete(cartItems).where(inArray(cartItems.cartId, dirtyCartIds));
    await db.delete(carts).where(inArray(carts.id, dirtyCartIds));
  }
  smmtaCalls.reservationsCreated = 0;
  smmtaCalls.ordersCommitted = 0;
  smmtaCalls.reservationsReleased = 0;
  mollieGetState = { status: 'paid', method: 'creditcard' };
  nextReservationFails = null;
  lastOrderCommitInput = null;
});

afterAll(async () => {
  await closeDatabase();
});

const baseAddress = {
  line1: '12 Test Street',
  city: 'London',
  postCode: 'SW1A 1AA',
  country: 'GB',
};
const baseCustomer = {
  email: 'buyer@example.invalid',
  firstName: 'Pat',
  lastName: 'Buyer',
};

async function seededCart(): Promise<string> {
  const { cartId } = await addItem(null, PRODUCT_ID, 1);
  return cartId;
}

describe('startCheckout — happy path', () => {
  it('reserves stock, creates a Mollie payment, persists PAYING + mollie_payments', async () => {
    const cartId = await seededCart();
    const result = await startCheckout({
      cartId,
      customer: baseCustomer,
      deliveryAddress: baseAddress,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.checkoutUrl).toMatch(/^https:\/\/www\.mollie\.com\/checkout/);
    expect(smmtaCalls.reservationsCreated).toBe(1);

    const db = getDb();
    const checkout = await db.query.checkouts.findFirst({
      where: eq(checkouts.id, result.checkoutId),
    });
    expect(checkout?.status).toBe('PAYING');
    expect(checkout?.molliePaymentId).toBe('tr_mock_1');
    expect(checkout?.reservationId).toBe('00000000-0000-4000-8000-000000000aaa');

    const payment = await db.query.molliePayments.findFirst({
      where: eq(molliePayments.id, 'tr_mock_1'),
    });
    expect(payment?.checkoutId).toBe(result.checkoutId);
    expect(payment?.status).toBe('open');
  });
});

describe('startCheckout — INSUFFICIENT_STOCK', () => {
  it('surfaces 409 with productId + available + leaves checkout in FAILED', async () => {
    const cartId = await seededCart();
    nextReservationFails = { type: 'stock', available: 2 };
    const result = await startCheckout({
      cartId,
      customer: baseCustomer,
      deliveryAddress: baseAddress,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('INSUFFICIENT_STOCK');
    if (result.error !== 'INSUFFICIENT_STOCK') return;
    expect(result.available).toBe(2);
    expect(result.productId).toBe(PRODUCT_ID);

    const db = getDb();
    const allCheckouts = await db
      .select({ id: checkouts.id, status: checkouts.status })
      .from(checkouts)
      .where(eq(checkouts.cartId, cartId));
    expect(allCheckouts).toHaveLength(1);
    expect(allCheckouts[0]?.status).toBe('FAILED');
  });
});

describe('startCheckout — empty cart', () => {
  it('returns EMPTY_CART without touching SMMTA', async () => {
    // Brand new cookie cart with no items
    const result = await startCheckout({
      cartId: '00000000-0000-4000-8000-000000000000',
      customer: baseCustomer,
      deliveryAddress: baseAddress,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('EMPTY_CART');
    expect(smmtaCalls.reservationsCreated).toBe(0);
  });
});

describe('finalizeFromMollie — paid → COMMITTED + idempotent replay', () => {
  it('commits SMMTA order, marks COMMITTED, wipes the cart; replay does not double-commit', async () => {
    const cartId = await seededCart();
    const start = await startCheckout({
      cartId,
      customer: baseCustomer,
      deliveryAddress: baseAddress,
    });
    if (!start.ok) throw new Error('startCheckout failed in setup');
    mollieGetState = { status: 'paid', method: 'creditcard' };

    const finalize1 = await finalizeFromMollie('tr_mock_1');
    expect(finalize1.status).toBe('COMMITTED');
    expect(finalize1.smmtaOrderId).toBe('00000000-0000-4000-8000-000000000bbb');
    expect(smmtaCalls.ordersCommitted).toBe(1);

    // Replay (Mollie retries on a non-200; our handler should short-circuit).
    const finalize2 = await finalizeFromMollie('tr_mock_1');
    expect(finalize2.status).toBe('COMMITTED');
    expect(finalize2.smmtaOrderId).toBe('00000000-0000-4000-8000-000000000bbb');
    expect(smmtaCalls.ordersCommitted).toBe(1); // unchanged

    // Cart wiped (deletedAt set, items removed).
    const db = getDb();
    const cart = await db.query.carts.findFirst({ where: eq(carts.id, cartId) });
    expect(cart?.deletedAt).not.toBeNull();
    const remainingItems = await db
      .select({ id: cartItems.id })
      .from(cartItems)
      .where(eq(cartItems.cartId, cartId));
    expect(remainingItems).toHaveLength(0);
  });

  it('forwards Mollie metadata and shipping into commitOrder', async () => {
    const cartId = await seededCart();
    const start = await startCheckout({
      cartId,
      customer: baseCustomer,
      deliveryAddress: baseAddress,
    });
    if (!start.ok) throw new Error('startCheckout failed');
    mollieGetState = { status: 'paid', method: 'creditcard' };
    await finalizeFromMollie('tr_mock_1');

    const input = lastOrderCommitInput as {
      mollie: { paymentId: string; methodPaid: string; status: string };
      deliveryCharge: string;
      reservationId: string;
    };
    expect(input.mollie.paymentId).toBe('tr_mock_1');
    expect(input.mollie.methodPaid).toBe('creditcard');
    expect(input.mollie.status).toBe('paid');
    expect(input.deliveryCharge).toBe('4.95');
    expect(input.reservationId).toBe('00000000-0000-4000-8000-000000000aaa');
  });
});

describe('finalizeFromMollie — canceled → FAILED + reservation released', () => {
  it('releases the reservation and marks FAILED', async () => {
    const cartId = await seededCart();
    const start = await startCheckout({
      cartId,
      customer: baseCustomer,
      deliveryAddress: baseAddress,
    });
    if (!start.ok) throw new Error('startCheckout failed');
    mollieGetState = { status: 'canceled', method: null };

    const result = await finalizeFromMollie('tr_mock_1');
    expect(result.status).toBe('FAILED');
    expect(smmtaCalls.reservationsReleased).toBeGreaterThanOrEqual(1);
    expect(smmtaCalls.ordersCommitted).toBe(0);
  });
});

describe('getCheckoutStatus — fallback to live Mollie when stale', () => {
  it('triggers a finalize when PAYING for >30s without a webhook', async () => {
    const cartId = await seededCart();
    const start = await startCheckout({
      cartId,
      customer: baseCustomer,
      deliveryAddress: baseAddress,
    });
    if (!start.ok) throw new Error('startCheckout failed');

    // Backdate the checkout's createdAt so getCheckoutStatus considers it stale.
    const db = getDb();
    await db
      .update(checkouts)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(checkouts.id, start.checkoutId));

    mollieGetState = { status: 'paid', method: 'creditcard' };
    const view = await getCheckoutStatus(start.checkoutId);
    expect(view?.status).toBe('COMMITTED');
    expect(view?.smmtaOrderId).toBe('00000000-0000-4000-8000-000000000bbb');
  });

  it('does not trigger fallback for fresh PAYING checkouts', async () => {
    const cartId = await seededCart();
    const start = await startCheckout({
      cartId,
      customer: baseCustomer,
      deliveryAddress: baseAddress,
    });
    if (!start.ok) throw new Error('startCheckout failed');

    const view = await getCheckoutStatus(start.checkoutId);
    expect(view?.status).toBe('PAYING');
    expect(smmtaCalls.ordersCommitted).toBe(0);
  });
});

// Re-import getOrCreateCart only to make sure cart wipe assertions can use it
// without a separate import block.
void getOrCreateCart;

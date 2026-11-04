/**
 * /api/checkout/start — the email-capture wiring. The cart cookie, the
 * checkout itself, the cart DB read and SMMTA are all mocked, so this runs
 * without Postgres. Checks that `marketingOptIn` reaches the consent call
 * and that a failing SMMTA never fails the checkout.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const CART_ID = '44444444-5555-4666-8777-888888888888';
const PRODUCT_ID = '44444444-5555-4666-8777-999999999999';

const startCheckout = vi.fn();
const recordEmailConsent = vi.fn();
const reportEmailCart = vi.fn();
const findMany = vi.fn();

vi.mock('@/lib/cookies', () => ({ readCartIdFromCookie: vi.fn(async () => CART_ID) }));
vi.mock('@/lib/checkout', () => ({ startCheckout }));
vi.mock('@/lib/smmta', () => ({ recordEmailConsent, reportEmailCart }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ query: { cartItems: { findMany } } }) }));
vi.mock('@/lib/log', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const { POST } = await import('./route');
const { EMAIL_CHANNEL } = await import('@/lib/email-copy');

const address = { line1: '1 Test Street', city: 'Leeds', postCode: 'LS1 1AA', country: 'GB' };

function request(extra: Record<string, unknown> = {}) {
  return new Request('http://localhost/api/checkout/start', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.9, 10.0.0.1',
      'user-agent': 'TestAgent/1.0',
    },
    body: JSON.stringify({
      customer: { email: 'buyer@example.com', firstName: 'Pat', lastName: 'Buyer' },
      deliveryAddress: address,
      termsAccepted: true,
      ...extra,
    }),
  });
}

beforeEach(() => {
  startCheckout.mockReset().mockResolvedValue({
    ok: true,
    checkoutId: 'chk_1',
    checkoutUrl: 'https://mollie.test/pay',
  });
  recordEmailConsent.mockReset().mockResolvedValue({ ok: true });
  reportEmailCart.mockReset().mockResolvedValue({ ok: true });
  findMany.mockReset().mockResolvedValue([
    { productId: PRODUCT_ID, quantity: 3, priceSnapshotGbp: '21.50' },
  ]);
});

describe('POST /api/checkout/start — email capture', () => {
  it('records marketing consent when the box is ticked', async () => {
    const res = await POST(request({ marketingOptIn: true }) as never);
    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(recordEmailConsent).toHaveBeenCalled());
    expect(recordEmailConsent).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'buyer@example.com',
        granted: true,
        form: 'checkout',
        ip: '203.0.113.9',
        userAgent: 'TestAgent/1.0',
      }),
    );
  });

  it('records transactional-only when the box is missing or unticked', async () => {
    await POST(request() as never);
    await POST(request({ marketingOptIn: false }) as never);
    await vi.waitFor(() => expect(recordEmailConsent).toHaveBeenCalledTimes(2));
    expect(recordEmailConsent).toHaveBeenNthCalledWith(1, expect.objectContaining({ granted: false }));
    expect(recordEmailConsent).toHaveBeenNthCalledWith(2, expect.objectContaining({ granted: false }));
  });

  it('reports the basket with its stored prices', async () => {
    await POST(request() as never);
    await vi.waitFor(() => expect(reportEmailCart).toHaveBeenCalled());
    expect(reportEmailCart).toHaveBeenCalledWith({
      cartId: CART_ID,
      channel: EMAIL_CHANNEL,
      email: 'buyer@example.com',
      lines: [{ productId: PRODUCT_ID, quantity: 3, priceGbp: '21.50' }],
    });
  });

  it('still checks out when both SMMTA email calls fail', async () => {
    recordEmailConsent.mockRejectedValue(new Error('SMMTA down'));
    reportEmailCart.mockRejectedValue(new Error('SMMTA down'));
    const res = await POST(request({ marketingOptIn: true }) as never);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ checkoutId: 'chk_1', checkoutUrl: 'https://mollie.test/pay' });
    await vi.waitFor(() => expect(reportEmailCart).toHaveBeenCalled());
  });

  it('still checks out when the email calls throw synchronously', async () => {
    recordEmailConsent.mockImplementation(() => {
      throw new Error('boom');
    });
    reportEmailCart.mockImplementation(() => {
      throw new Error('boom');
    });
    const res = await POST(request({ marketingOptIn: true }) as never);
    expect(res.status).toBe(201);
  });

  it('rejects a non-boolean marketingOptIn', async () => {
    const res = await POST(request({ marketingOptIn: 'yes' }) as never);
    expect(res.status).toBe(400);
    expect(startCheckout).not.toHaveBeenCalled();
  });
});

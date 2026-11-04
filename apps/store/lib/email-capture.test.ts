/**
 * captureCheckoutEmail — SMMTA is mocked. Checks both payloads and that a
 * failure of either call is swallowed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const recordEmailConsent = vi.fn();
const reportEmailCart = vi.fn();
vi.mock('./smmta', () => ({ recordEmailConsent, reportEmailCart }));
vi.mock('./log', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const { captureCheckoutEmail, clientIp } = await import('./email-capture');
const { CHECKOUT_MARKETING_LABEL, EMAIL_CHANNEL } = await import('./email-copy');

const CART_ID = '33333333-4444-4555-8666-777777777777';
const PRODUCT_ID = '33333333-4444-4555-8666-888888888888';
const lines = [{ productId: PRODUCT_ID, quantity: 2, priceGbp: '19.99' }];
const loadLines = vi.fn(async () => lines);

beforeEach(() => {
  recordEmailConsent.mockReset().mockResolvedValue({ ok: true });
  reportEmailCart.mockReset().mockResolvedValue({ ok: true });
  loadLines.mockClear();
});

describe('captureCheckoutEmail', () => {
  it('records marketing consent when the box is ticked, and reports the basket', async () => {
    await captureCheckoutEmail(
      { cartId: CART_ID, email: 'a@example.com', marketingOptIn: true, ip: '203.0.113.9', userAgent: 'UA' },
      loadLines,
    );
    expect(recordEmailConsent).toHaveBeenCalledWith({
      email: 'a@example.com',
      granted: true,
      form: 'checkout',
      wording: CHECKOUT_MARKETING_LABEL,
      ip: '203.0.113.9',
      userAgent: 'UA',
    });
    expect(loadLines).toHaveBeenCalledWith(CART_ID);
    expect(reportEmailCart).toHaveBeenCalledWith({
      cartId: CART_ID,
      channel: EMAIL_CHANNEL,
      email: 'a@example.com',
      lines,
    });
  });

  it('records transactional-only when the box is unticked or missing', async () => {
    await captureCheckoutEmail({ cartId: CART_ID, email: 'a@example.com', marketingOptIn: false }, loadLines);
    await captureCheckoutEmail({ cartId: CART_ID, email: 'a@example.com' }, loadLines);
    expect(recordEmailConsent).toHaveBeenNthCalledWith(1, expect.objectContaining({ granted: false }));
    expect(recordEmailConsent).toHaveBeenNthCalledWith(2, expect.objectContaining({ granted: false }));
  });

  it('skips the basket report for an empty basket', async () => {
    await captureCheckoutEmail({ cartId: CART_ID, email: 'a@example.com' }, async () => []);
    expect(reportEmailCart).not.toHaveBeenCalled();
    expect(recordEmailConsent).toHaveBeenCalled();
  });

  it('never rejects when SMMTA or the basket read fails', async () => {
    recordEmailConsent.mockRejectedValue(new Error('down'));
    reportEmailCart.mockRejectedValue(new Error('down'));
    await expect(
      captureCheckoutEmail({ cartId: CART_ID, email: 'a@example.com', marketingOptIn: true }, loadLines),
    ).resolves.toBeUndefined();
    await expect(
      captureCheckoutEmail({ cartId: CART_ID, email: 'a@example.com' }, async () => {
        throw new Error('db gone');
      }),
    ).resolves.toBeUndefined();
  });
});

describe('clientIp', () => {
  it('takes the first x-forwarded-for hop', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': ' 203.0.113.9 , 10.0.0.1' }))).toBe('203.0.113.9');
  });
  it('is undefined without the header', () => {
    expect(clientIp(new Headers())).toBeUndefined();
  });
});

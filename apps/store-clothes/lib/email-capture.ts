/**
 * Best-effort email capture at checkout start: the marketing-consent tick
 * box and the basket (for abandoned-basket emails), both sent to SMMTA.
 *
 * Neither is allowed to affect checkout. `captureCheckoutEmail` never
 * throws — every failure is logged and swallowed — and the route calls it
 * without awaiting, so a slow or broken SMMTA cannot hold up the Mollie
 * redirect.
 *
 * Server-only.
 */
import 'server-only';
import { eq } from 'drizzle-orm';
import { cartItems } from '@/drizzle/schema';
import { getDb } from './db';
import { log } from './log';
import { recordEmailConsent, reportEmailCart } from './smmta';
import { CHECKOUT_MARKETING_LABEL, EMAIL_CHANNEL } from './email-copy';

export interface EmailCartLine {
  productId: string;
  quantity: number;
  priceGbp: string | null;
}

export interface CaptureCheckoutEmailInput {
  cartId: string;
  email: string;
  /** The checkout tick box. Anything but `true` records transactional-only. */
  marketingOptIn?: boolean;
  ip?: string;
  userAgent?: string;
}

/** The first hop of `x-forwarded-for` — the shopper's address as nginx saw
 *  it. Undefined when the header is absent or blank. */
export function clientIp(headers: Headers): string | undefined {
  const first = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return first ? first : undefined;
}

/** The basket as stored: one line per cart item, with the price captured
 *  when it was added. */
export async function loadCartLines(cartId: string): Promise<EmailCartLine[]> {
  const items = await getDb().query.cartItems.findMany({
    where: eq(cartItems.cartId, cartId),
  });
  return items.map((i) => ({
    productId: i.productId,
    quantity: i.quantity,
    priceGbp: i.priceSnapshotGbp ?? null,
  }));
}

/**
 * Send the consent record and the basket to SMMTA. Resolves once both have
 * settled; never rejects.
 */
export async function captureCheckoutEmail(
  input: CaptureCheckoutEmailInput,
  loadLines: (cartId: string) => Promise<EmailCartLine[]> = loadCartLines,
): Promise<void> {
  const consent = (async () =>
    recordEmailConsent({
      email: input.email,
      granted: input.marketingOptIn === true,
      form: 'checkout',
      wording: CHECKOUT_MARKETING_LABEL,
      ip: input.ip,
      userAgent: input.userAgent,
    }))();

  const cart = (async () => {
    const lines = await loadLines(input.cartId);
    if (lines.length === 0) return;
    await reportEmailCart({
      cartId: input.cartId,
      channel: EMAIL_CHANNEL,
      email: input.email,
      lines,
    });
  })();

  try {
    const [consentResult, cartResult] = await Promise.allSettled([consent, cart]);
    if (consentResult.status === 'rejected') {
      log.warn({ err: consentResult.reason, cartId: input.cartId }, 'email consent capture failed');
    }
    if (cartResult.status === 'rejected') {
      log.warn({ err: cartResult.reason, cartId: input.cartId }, 'email basket capture failed');
    }
  } catch {
    // allSettled does not reject; this only guards a broken logger.
  }
}

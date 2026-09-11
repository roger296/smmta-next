/**
 * The "your order has shipped" email, with the courier and tracking number.
 *
 * Handed to the storefront, which renders its branded order-shipped template
 * into its email outbox and delivers it through SendGrid, the same way as order
 * confirmations. Its enqueue is idempotent per order, so a retry after a lost
 * response cannot send the customer two emails.
 *
 * Only orders we sold directly are emailed: storefront orders (source API) and
 * admin-created orders (MANUAL). Amazon, eBay and Etsy send their own shipping
 * notices and restrict contacting their buyers directly, and Shopify and
 * WooCommerce orders come from shops that notify their own customers.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { getEnv } from '../../config/env.js';
import { customerOrders } from '../../db/schema/index.js';
import { longDate } from '../orders/invoice-pdf.js';

export const DISPATCH_EMAIL_CHANNELS: readonly string[] = ['MANUAL', 'API'];

export type DispatchEmailOutcome = 'sent' | 'not-found' | 'not-shipped' | 'marketplace-order' | 'no-customer-email';

/** The storefront refused the request; retrying the same request cannot help. */
export class DispatchEmailRejectedError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`The storefront refused the shipped email (${status}): ${body.slice(0, 200)}`);
    this.name = 'DispatchEmailRejectedError';
  }
}

export interface DispatchEmailDeps {
  fetch?: typeof fetch;
  storeBaseUrl?: string;
  storeKey?: string;
  timeoutMs?: number;
}

export async function sendDispatchEmail(
  orderId: string,
  companyId: string,
  deps: DispatchEmailDeps = {},
): Promise<DispatchEmailOutcome> {
  const order = await getDb().query.customerOrders.findFirst({
    where: and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId), isNull(customerOrders.deletedAt)),
    with: { customer: true, contact: true, deliveryAddress: true },
  });
  if (!order) return 'not-found';
  if (order.status !== 'SHIPPED') return 'not-shipped';
  if (!DISPATCH_EMAIL_CHANNELS.includes(order.sourceChannel)) return 'marketplace-order';

  const email = (order.contact?.email || order.customer?.email || '').trim();
  if (!email) return 'no-customer-email';

  const env = getEnv();
  const base = (deps.storeBaseUrl ?? env.STORE_BASE_URL).replace(/\/+$/, '');
  const key = deps.storeKey ?? env.STORE_INTERNAL_API_KEY;
  if (!base || !key) {
    throw new Error('STORE_BASE_URL / STORE_INTERNAL_API_KEY are not configured, so the shipped email cannot be handed to the storefront');
  }

  const name = (order.deliveryAddress?.contactName || order.contact?.name || order.customer?.name || '').trim();
  const body = {
    orderId,
    status: 'SHIPPED',
    orderNumber: order.orderNumber,
    customerEmail: email,
    customerFirstName: name.split(/\s+/)[0] || undefined,
    shippedDate: order.shippedDate ? longDate(String(order.shippedDate)) : undefined,
    trackingNumber: order.trackingNumber ?? undefined,
    trackingLink: order.trackingLink ?? undefined,
    courierName: order.courierName ?? undefined,
  };

  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(`${base}/api/internal/order-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
    });
  } catch (err) {
    throw new Error(`Could not reach the storefront to send the shipped email: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.ok) return 'sent';

  const text = await res.text().catch(() => '');
  // A storefront outage is worth retrying; a refusal of this request is not.
  if (res.status >= 500) throw new Error(`The storefront returned ${res.status} for the shipped email: ${text.slice(0, 200)}`);
  throw new DispatchEmailRejectedError(res.status, text);
}

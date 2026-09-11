/**
 * Integration test for /api/internal/order-status against the real
 * `email_outbox` + `checkouts` tables.
 *
 * Verifies:
 *   - 401 without the operator key
 *   - a storefront order uses the email captured at checkout
 *   - an admin-created order (no checkouts row) uses the email sent in the body,
 *     with SMMTA's order number, courier and tracking details
 *   - an unknown order with no email is refused
 *   - the enqueue is idempotent, so a retry sends nothing twice
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { NextRequest } from 'next/server';

const ADMIN_KEY = 'order-status-test-key-0123456789abcdef';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.STORE_BASE_URL = 'http://localhost:3000';

const { POST } = await import('./route');
const { closeDatabase, getDb } = await import('@/lib/db');
const { emailOutbox, checkouts } = await import('@/drizzle/schema');

const STORE_ORDER_ID = '33333333-4444-4555-8666-aaaaaaaaaaaa';
const ADMIN_ORDER_ID = '33333333-4444-4555-8666-bbbbbbbbbbbb';
const UNKNOWN_ORDER_ID = '33333333-4444-4555-8666-cccccccccccc';
const CHECKOUT_ID = '33333333-4444-4555-8666-dddddddddddd';
const ORDER_IDS = [STORE_ORDER_ID, ADMIN_ORDER_ID, UNKNOWN_ORDER_ID];

function request(body: unknown, key: string | null = ADMIN_KEY) {
  return new NextRequest('http://localhost:3000/api/internal/order-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });
}

async function clean() {
  const db = getDb();
  await db.delete(emailOutbox).where(inArray(emailOutbox.orderId, ORDER_IDS));
  await db.delete(checkouts).where(eq(checkouts.id, CHECKOUT_ID));
}

beforeAll(clean);
beforeEach(clean);
afterAll(async () => {
  await clean();
  await closeDatabase();
});

const outboxFor = (orderId: string) =>
  getDb().select().from(emailOutbox).where(eq(emailOutbox.orderId, orderId));

describe('POST /api/internal/order-status', () => {
  it('refuses a caller without the operator key', async () => {
    const res = await POST(request({ orderId: ADMIN_ORDER_ID, status: 'SHIPPED' }, null));
    expect(res.status).toBe(401);
  });

  it('emails a storefront order to the address captured at checkout', async () => {
    await getDb().insert(checkouts).values({
      id: CHECKOUT_ID,
      status: 'COMMITTED',
      smmtaOrderId: STORE_ORDER_ID,
      customer: { email: 'checkout-buyer@example.invalid', firstName: 'Pat', lastName: 'Buyer' },
      idempotencyKey: 'idem-order-status-EBE1CE630088',
    });
    const res = await POST(
      request({
        orderId: STORE_ORDER_ID,
        status: 'SHIPPED',
        customerEmail: 'other@example.invalid',
        orderNumber: 'STORE-EBE1CE630088',
        courierName: 'Evri',
        trackingNumber: 'A1B2-C3D4',
      }),
    );
    expect(res.status).toBe(200);
    const [row] = await outboxFor(STORE_ORDER_ID);
    expect(row?.toEmail).toBe('checkout-buyer@example.invalid');
    expect(row?.template).toBe('order_shipped');
    expect(row?.payload).toMatchObject({ firstName: 'Pat', orderNumber: 'STORE-EBE1CE630088', courierName: 'Evri' });
  });

  it('emails an admin-created order to the address sent by SMMTA, once however often it is told', async () => {
    const body = {
      orderId: ADMIN_ORDER_ID,
      status: 'SHIPPED',
      orderNumber: 'SO-000142',
      customerEmail: 'trade-buyer@example.invalid',
      customerFirstName: 'Sam',
      courierName: 'Royal Mail',
      trackingNumber: 'Z9Y8-X7W6',
      trackingLink: 'https://app.smoothparcel.com/trackmyshipments/Z9Y8-X7W6',
      shippedDate: '11 September 2026',
    };
    expect((await POST(request(body))).status).toBe(200);
    expect((await POST(request(body))).status).toBe(200);

    const rows = await outboxFor(ADMIN_ORDER_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.toEmail).toBe('trade-buyer@example.invalid');
    expect(rows[0]?.payload).toMatchObject({
      orderNumber: 'SO-000142',
      firstName: 'Sam',
      courierName: 'Royal Mail',
      trackingNumber: 'Z9Y8-X7W6',
    });
  });

  it('refuses an unknown order when no email is supplied', async () => {
    const res = await POST(request({ orderId: UNKNOWN_ORDER_ID, status: 'SHIPPED' }));
    expect(res.status).toBe(404);
    expect(await outboxFor(UNKNOWN_ORDER_ID)).toHaveLength(0);
  });
});

/**
 * Integration test for the /api/track/resend-email route. Uses the real
 * `email_outbox` + `checkouts` tables; SendGrid is mocked.
 *
 * Verifies:
 *   - 400 on invalid body
 *   - 200 generic on unknown order (no leakage)
 *   - happy path enqueues a new outbox row addressed to the customer email on file
 *   - 429 with retryAfterSeconds when called twice within the rate-limit window
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

const sendMock = vi.fn(async () => [{ statusCode: 202 }]);
vi.mock('@sendgrid/mail', () => ({
  default: {
    setApiKey: vi.fn(),
    send: sendMock,
  },
}));

const { POST } = await import('./route');
const { closeDatabase, getDb } = await import('@/lib/db');
const { emailOutbox, checkouts } = await import('@/drizzle/schema');

const ORDER_ID = '22222222-3333-4444-8555-aaaaaaaaaaaa';
const CHECKOUT_ID = '22222222-3333-4444-8555-bbbbbbbbbbbb';
const CUSTOMER_EMAIL = 'resend-test@example.invalid';

beforeAll(() => {
  process.env.SENDGRID_API_KEY = 'SG.test_key';
  process.env.SENDGRID_FROM = 'orders@example.invalid';
  process.env.STORE_BASE_URL = 'http://localhost:3000';
  Object.assign(process.env, { NODE_ENV: 'test' });
});

async function clean() {
  const db = getDb();
  await db.delete(emailOutbox).where(eq(emailOutbox.toEmail, CUSTOMER_EMAIL));
  await db.delete(emailOutbox).where(inArray(emailOutbox.orderId, [ORDER_ID]));
  await db.delete(checkouts).where(eq(checkouts.id, CHECKOUT_ID));
}

async function seedOriginalConfirmation(sentAt: Date | null) {
  const db = getDb();
  await db.insert(checkouts).values({
    id: CHECKOUT_ID,
    status: 'COMMITTED',
    smmtaOrderId: ORDER_ID,
    customer: { email: CUSTOMER_EMAIL, firstName: 'Pat', lastName: 'Buyer' },
    idempotencyKey: 'idem-resend-AAAA',
  });
  await db.insert(emailOutbox).values({
    toEmail: CUSTOMER_EMAIL,
    template: 'order_confirmation',
    payload: {
      orderId: ORDER_ID,
      orderNumber: 'STORE-AAAAAAAAAA00',
      grandTotal: '24.00',
      currency: 'GBP',
      storeBaseUrl: 'http://localhost:3000',
    },
    sendStatus: sentAt ? 'SENT' : 'PENDING',
    sentAt,
    orderId: ORDER_ID,
  });
}

beforeEach(async () => {
  await clean();
  sendMock.mockClear();
});

afterAll(async () => {
  await clean();
  await closeDatabase();
});

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/track/resend-email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}

describe('POST /api/track/resend-email', () => {
  it('rejects invalid body with 400', async () => {
    const res = await POST(makeRequest({ orderId: 'not-a-uuid' }));
    expect(res.status).toBe(400);
  });

  it('returns 200 with a generic message when the order has no confirmation history', async () => {
    const res = await POST(makeRequest({ orderId: ORDER_ID }));
    // 200 OK + generic message — we don't disclose existence.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; message?: string };
    expect(body.ok).toBe(true);
    expect(typeof body.message).toBe('string');
  });

  it('happy path: enqueues a fresh outbox row when there is no recent activity', async () => {
    // Original confirmation sent more than an hour ago.
    const oneHourAgo = new Date(Date.now() - 65 * 60 * 1000);
    await seedOriginalConfirmation(oneHourAgo);

    const res = await POST(makeRequest({ orderId: ORDER_ID }));
    expect(res.status).toBe(200);

    const db = getDb();
    const rows = await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.toEmail, CUSTOMER_EMAIL));
    // Original + the resend.
    expect(rows.length).toBe(2);
    const resend = rows.find((r) => r.sendStatus === 'PENDING' && r.orderId === null);
    expect(resend).toBeDefined();
  });

  it('returns 429 with retryAfterSeconds when called within the rate-limit window', async () => {
    // Fresh confirmation sent moments ago.
    await seedOriginalConfirmation(new Date());
    const res = await POST(makeRequest({ orderId: ORDER_ID }));
    expect(res.status).toBe(429);
    const body = (await res.json()) as { retryAfterSeconds?: number };
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.retryAfterSeconds).toBeLessThanOrEqual(60 * 60);
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });
});

/**
 * Integration tests for the email service. Uses the real `email_outbox`
 * Postgres table and a mocked SendGrid mailer so we can verify:
 *
 *   - enqueue inserts a row
 *   - duplicate enqueue against the same (orderId, template) is a silent no-op
 *   - processOutbox renders + sends + marks SENT, in batches
 *   - sandbox mode is on whenever NODE_ENV !== 'production'
 *   - render errors mark the row FAILED with the error message
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

// Mock SendGrid before importing the SUT.
const sendMock = vi.fn(async () => [{ statusCode: 202 }]);
vi.mock('@sendgrid/mail', () => ({
  default: {
    setApiKey: vi.fn(),
    send: sendMock,
  },
}));

const { enqueue, processOutbox, _resetForTests } = await import('./email');
const { closeDatabase, getDb } = await import('./db');
const { emailOutbox } = await import('@/drizzle/schema');

const ORDER_PREFIX = '00000000-0000-4000-8000-0000abcdef';

beforeAll(() => {
  process.env.SENDGRID_API_KEY = 'SG.test_key';
  process.env.SENDGRID_FROM = 'orders@example.invalid';
  process.env.STORE_BASE_URL = 'http://localhost:3000';
  Object.assign(process.env, { NODE_ENV: 'test' });
  _resetForTests();
});

beforeEach(async () => {
  // Clean any rows we left behind in earlier runs.
  const db = getDb();
  const orderIds = Array.from({ length: 9 }, (_, i) => `${ORDER_PREFIX}${i}1`);
  await db.delete(emailOutbox).where(inArray(emailOutbox.orderId, orderIds));
  // Also drop rows with the test-owned dummy email so cross-suite leftovers
  // don't pollute results.
  await db.delete(emailOutbox).where(eq(emailOutbox.toEmail, 'buyer@email-test.invalid'));
  sendMock.mockClear();
});

afterAll(async () => {
  await closeDatabase();
});

describe('enqueue', () => {
  it('inserts a PENDING row', async () => {
    const orderId = `${ORDER_PREFIX}01`;
    const result = await enqueue(
      'order_confirmation',
      {
        orderId,
        orderNumber: 'STORE-AAAAAAAA1111',
        grandTotal: '24.00',
        currency: 'GBP',
        storeBaseUrl: 'http://localhost:3000',
      },
      'buyer@email-test.invalid',
      { orderId },
    );
    expect(result.enqueued).toBe(true);

    const db = getDb();
    const rows = await db.select().from(emailOutbox).where(eq(emailOutbox.orderId, orderId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sendStatus).toBe('PENDING');
    expect(rows[0]?.template).toBe('order_confirmation');
  });

  it('is idempotent on (orderId, template) — duplicate is a silent no-op', async () => {
    const orderId = `${ORDER_PREFIX}21`;
    const r1 = await enqueue(
      'order_confirmation',
      {
        orderId,
        orderNumber: 'STORE-X',
        grandTotal: '1.00',
        currency: 'GBP',
        storeBaseUrl: 'http://localhost:3000',
      },
      'buyer@email-test.invalid',
      { orderId },
    );
    const r2 = await enqueue(
      'order_confirmation',
      {
        orderId,
        orderNumber: 'STORE-X',
        grandTotal: '1.00',
        currency: 'GBP',
        storeBaseUrl: 'http://localhost:3000',
      },
      'buyer@email-test.invalid',
      { orderId },
    );
    expect(r1.enqueued).toBe(true);
    expect(r2.enqueued).toBe(false);

    const db = getDb();
    const rows = await db.select().from(emailOutbox).where(eq(emailOutbox.orderId, orderId));
    expect(rows).toHaveLength(1);
  });

  it('allows different templates against the same orderId', async () => {
    const orderId = `${ORDER_PREFIX}31`;
    const r1 = await enqueue(
      'order_confirmation',
      { orderId, orderNumber: 'X', grandTotal: '1.00', currency: 'GBP', storeBaseUrl: 'http://x/' },
      'buyer@email-test.invalid',
      { orderId },
    );
    const r2 = await enqueue(
      'order_shipped',
      { orderId, orderNumber: 'X', storeBaseUrl: 'http://x/' },
      'buyer@email-test.invalid',
      { orderId },
    );
    expect(r1.enqueued).toBe(true);
    expect(r2.enqueued).toBe(true);

    const db = getDb();
    const rows = await db.select().from(emailOutbox).where(eq(emailOutbox.orderId, orderId));
    expect(rows.map((r) => r.template).sort()).toEqual(['order_confirmation', 'order_shipped']);
  });
});

describe('processOutbox', () => {
  it('sends pending rows and marks them SENT', async () => {
    const orderId = `${ORDER_PREFIX}41`;
    await enqueue(
      'order_confirmation',
      {
        orderId,
        orderNumber: 'STORE-PROCESS',
        firstName: 'Pat',
        grandTotal: '24.00',
        currency: 'GBP',
        storeBaseUrl: 'http://localhost:3000',
      },
      'buyer@email-test.invalid',
      { orderId },
    );

    const result = await processOutbox();
    expect(result.attempted).toBeGreaterThanOrEqual(1);
    expect(result.sent).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);
    expect(sendMock).toHaveBeenCalled();

    // The send call carried the rendered subject + sandbox flag.
    const lastCall = sendMock.mock.calls.at(-1) as unknown as readonly unknown[] | undefined;
    const sent = lastCall?.[0] as {
      to: string;
      from: string;
      subject: string;
      html: string;
      text: string;
      mailSettings?: { sandboxMode?: { enable: boolean } };
    };
    expect(sent.to).toBe('buyer@email-test.invalid');
    expect(sent.from).toBe('orders@example.invalid');
    expect(sent.subject).toMatch(/STORE-PROCESS/);
    expect(sent.html).toMatch(/STORE-PROCESS/);
    expect(sent.text).toMatch(/STORE-PROCESS/);
    // NODE_ENV='test' → sandbox enabled.
    expect(sent.mailSettings?.sandboxMode?.enable).toBe(true);

    const db = getDb();
    const rows = await db.select().from(emailOutbox).where(eq(emailOutbox.orderId, orderId));
    expect(rows[0]?.sendStatus).toBe('SENT');
    expect(rows[0]?.sentAt).not.toBeNull();
  });

  it('marks the row FAILED and records the error when SendGrid errors', async () => {
    const orderId = `${ORDER_PREFIX}51`;
    await enqueue(
      'order_confirmation',
      {
        orderId,
        orderNumber: 'STORE-FAIL',
        grandTotal: '1.00',
        currency: 'GBP',
        storeBaseUrl: 'http://localhost:3000',
      },
      'buyer@email-test.invalid',
      { orderId },
    );

    sendMock.mockRejectedValueOnce(new Error('SendGrid 5xx — try again later'));

    const result = await processOutbox();
    expect(result.failed).toBeGreaterThanOrEqual(1);

    const db = getDb();
    const rows = await db.select().from(emailOutbox).where(eq(emailOutbox.orderId, orderId));
    expect(rows[0]?.sendStatus).toBe('FAILED');
    expect(rows[0]?.error).toMatch(/SendGrid 5xx/);
    // Failed rows DO NOT mark sentAt.
    expect(rows[0]?.sentAt).toBeNull();
  });

  it('drains an empty outbox cleanly', async () => {
    const result = await processOutbox();
    // Other test files may have left rows; we only assert the bookkeeping
    // shape is sane (no thrown error, all-attempted are accounted for).
    expect(result.attempted).toBeGreaterThanOrEqual(0);
    expect(result.sent + result.failed).toBe(result.attempted);
  });

  it('sets sandbox=false when NODE_ENV=production', async () => {
    const previous = process.env.NODE_ENV;
    Object.assign(process.env, { NODE_ENV: 'production' });
    try {
      const orderId = `${ORDER_PREFIX}61`;
      await enqueue(
        'order_confirmation',
        {
          orderId,
          orderNumber: 'STORE-PROD',
          grandTotal: '1.00',
          currency: 'GBP',
          storeBaseUrl: 'http://localhost:3000',
        },
        'buyer@email-test.invalid',
        { orderId },
      );
      sendMock.mockResolvedValueOnce([{ statusCode: 202 }]);
      await processOutbox();
      const lastCall = sendMock.mock.calls.at(-1) as unknown as readonly unknown[] | undefined;
      const sent = lastCall?.[0] as { mailSettings?: { sandboxMode?: { enable: boolean } } };
      expect(sent.mailSettings?.sandboxMode?.enable).toBe(false);
    } finally {
      Object.assign(process.env, { NODE_ENV: previous ?? 'test' });
    }
  });
});

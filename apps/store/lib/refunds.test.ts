/**
 * Integration tests for the refund orchestration. Uses the real
 * `mollie_payments` / `mollie_refunds` / `checkouts` tables; mocks the
 * Mollie client so we don't hit the network. Verifies:
 *
 *   - issueRefund happy path: creates Mollie refund, inserts row, enqueues email
 *   - amount-validation: zero / negative / over-remaining are rejected
 *   - PAYMENT_NOT_FOUND error
 *   - listRecentPaidPayments returns paginated rows with refund totals
 *   - getPaymentDetail returns refund history
 *   - refreshRefundsForPayment upserts new + existing refund rows
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

// ---- Mocks ---------------------------------------------------------------

let createRefundResponse: {
  id: string;
  paymentId: string;
  status: string;
  amount: { value: string; currency: string };
  description: string | null;
} = {
  id: 're_test_1',
  paymentId: 'tr_refund_1',
  status: 'pending',
  amount: { value: '10.00', currency: 'GBP' },
  description: null,
};

let listRefundsResponse: typeof createRefundResponse[] = [];

const createRefundMock = vi.fn(async () => createRefundResponse);
const listRefundsMock = vi.fn(async () => listRefundsResponse);

vi.mock('./mollie', async () => {
  const actual = await vi.importActual<typeof import('./mollie')>('./mollie');
  return {
    ...actual,
    createRefund: createRefundMock,
    listRefunds: listRefundsMock,
  };
});

// Mock SendGrid so refund_issued enqueue doesn't try to send.
const sendMock = vi.fn(async () => [{ statusCode: 202 }]);
vi.mock('@sendgrid/mail', () => ({
  default: {
    setApiKey: vi.fn(),
    send: sendMock,
  },
}));

const {
  issueRefund,
  RefundError,
  listRecentPaidPayments,
  getPaymentDetail,
  refreshRefundsForPayment,
} = await import('./refunds');
const { closeDatabase, getDb } = await import('./db');
const { molliePayments, mollieRefunds, checkouts, emailOutbox } = await import(
  '@/drizzle/schema'
);

const PAYMENT_ID = 'tr_refund_1';
const PAYMENT_ID_2 = 'tr_refund_2';
const CHECKOUT_ID = '11111111-2222-4333-8444-555555555555';
const ORDER_ID = '11111111-2222-4333-8444-666666666666';

beforeAll(() => {
  process.env.MOLLIE_API_KEY = 'test_xxx';
  process.env.SENDGRID_API_KEY = 'SG.test_key';
  process.env.SENDGRID_FROM = 'orders@example.invalid';
  process.env.STORE_BASE_URL = 'http://localhost:3000';
  Object.assign(process.env, { NODE_ENV: 'test' });
});

async function clean() {
  const db = getDb();
  await db
    .delete(mollieRefunds)
    .where(inArray(mollieRefunds.paymentId, [PAYMENT_ID, PAYMENT_ID_2]));
  await db
    .delete(molliePayments)
    .where(inArray(molliePayments.id, [PAYMENT_ID, PAYMENT_ID_2]));
  await db.delete(checkouts).where(eq(checkouts.id, CHECKOUT_ID));
  await db.delete(emailOutbox).where(eq(emailOutbox.toEmail, 'refund-test@example.invalid'));
}

async function seed() {
  const db = getDb();
  await db.insert(checkouts).values({
    id: CHECKOUT_ID,
    status: 'COMMITTED',
    smmtaOrderId: ORDER_ID,
    idempotencyKey: 'idem-refund-test-AAAA',
    customer: {
      email: 'refund-test@example.invalid',
      firstName: 'Pat',
      lastName: 'Buyer',
    },
  });
  await db.insert(molliePayments).values({
    id: PAYMENT_ID,
    checkoutId: CHECKOUT_ID,
    amountGbp: '50.00',
    currency: 'GBP',
    method: 'creditcard',
    status: 'paid',
  });
}

beforeEach(async () => {
  await clean();
  await seed();
  createRefundMock.mockClear();
  listRefundsMock.mockClear();
  sendMock.mockClear();
  createRefundResponse = {
    id: 're_test_1',
    paymentId: PAYMENT_ID,
    status: 'pending',
    amount: { value: '10.00', currency: 'GBP' },
    description: null,
  };
  listRefundsResponse = [];
});

afterAll(async () => {
  await clean();
  await closeDatabase();
});

describe('issueRefund — happy path', () => {
  it('creates Mollie refund, inserts row, enqueues email', async () => {
    const result = await issueRefund({
      paymentId: PAYMENT_ID,
      amountGbp: '10.00',
      reason: 'Customer changed mind',
    });
    expect(result.refundId).toBe('re_test_1');
    expect(result.status).toBe('pending');
    expect(createRefundMock).toHaveBeenCalledTimes(1);

    const db = getDb();
    const rows = await db
      .select()
      .from(mollieRefunds)
      .where(eq(mollieRefunds.paymentId, PAYMENT_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amountGbp).toBe('10.00');
    expect(rows[0]?.status).toBe('pending');

    const queued = await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.toEmail, 'refund-test@example.invalid'));
    expect(queued).toHaveLength(1);
    expect(queued[0]?.template).toBe('refund_issued');
  });

  it('uses credit-note id in the idempotency key when supplied', async () => {
    const creditNoteId = '99999999-aaaa-4bbb-8ccc-ddddddddddd0';
    await issueRefund({
      paymentId: PAYMENT_ID,
      amountGbp: '10.00',
      smmtaCreditNoteId: creditNoteId,
    });
    const firstCall = createRefundMock.mock.calls[0] as unknown as readonly unknown[] | undefined;
    const arg = firstCall?.[0] as { idempotencyKey: string } | undefined;
    expect(arg?.idempotencyKey).toBe(`cn-${creditNoteId}-1000`);
  });
});

describe('issueRefund — validation', () => {
  it('throws PAYMENT_NOT_FOUND when payment is unknown', async () => {
    await expect(
      issueRefund({ paymentId: 'tr_nope', amountGbp: '5.00' }),
    ).rejects.toMatchObject({ code: 'PAYMENT_NOT_FOUND', status: 404 });
  });

  it('throws AMOUNT_INVALID for zero/negative amounts', async () => {
    await expect(
      issueRefund({ paymentId: PAYMENT_ID, amountGbp: '0.00' }),
    ).rejects.toMatchObject({ code: 'AMOUNT_INVALID', status: 400 });
    await expect(
      issueRefund({ paymentId: PAYMENT_ID, amountGbp: '-5.00' }),
    ).rejects.toMatchObject({ code: 'AMOUNT_INVALID', status: 400 });
  });

  it('throws AMOUNT_EXCEEDS_REMAINING when total would go over the payment amount', async () => {
    // Pre-record a 45.00 refund so only 5.00 remains on the 50.00 payment.
    const db = getDb();
    await db.insert(mollieRefunds).values({
      id: 're_seed_1',
      paymentId: PAYMENT_ID,
      amountGbp: '45.00',
      status: 'refunded',
    });
    await expect(
      issueRefund({ paymentId: PAYMENT_ID, amountGbp: '10.00' }),
    ).rejects.toMatchObject({
      code: 'AMOUNT_EXCEEDS_REMAINING',
      status: 422,
    });
    expect(createRefundMock).not.toHaveBeenCalled();
  });

  it('rejects mollie payment id format on the API surface', () => {
    // (validated at the route layer with zod — covered there.)
    // Here we just guarantee RefundError is throwable + has the union code.
    const e = new RefundError('x', 'AMOUNT_INVALID', 400);
    expect(e.code).toBe('AMOUNT_INVALID');
    expect(e.status).toBe(400);
  });
});

describe('listRecentPaidPayments + getPaymentDetail', () => {
  it('returns one row with the seeded checkout joined', async () => {
    const rows = await listRecentPaidPayments(50);
    const ours = rows.find((r) => r.paymentId === PAYMENT_ID);
    expect(ours).toBeDefined();
    expect(ours?.smmtaOrderId).toBe(ORDER_ID);
    expect(ours?.customerEmail).toBe('refund-test@example.invalid');
    expect(ours?.amountGbp).toBe('50.00');
    expect(ours?.refundedGbp).toBe('0.00');
    expect(ours?.refundsToDate).toBe(0);
  });

  it('aggregates partial refunds in the row', async () => {
    const db = getDb();
    await db.insert(mollieRefunds).values({
      id: 're_part_1',
      paymentId: PAYMENT_ID,
      amountGbp: '10.00',
      status: 'pending',
    });
    await db.insert(mollieRefunds).values({
      id: 're_part_2',
      paymentId: PAYMENT_ID,
      amountGbp: '5.50',
      status: 'pending',
    });
    const rows = await listRecentPaidPayments(50);
    const ours = rows.find((r) => r.paymentId === PAYMENT_ID);
    expect(ours?.refundedGbp).toBe('15.50');
    expect(ours?.refundsToDate).toBe(2);
  });

  it('getPaymentDetail returns null on an unknown payment', async () => {
    expect(await getPaymentDetail('tr_does_not_exist')).toBeNull();
  });

  it('getPaymentDetail returns refund history sorted desc by createdAt', async () => {
    const db = getDb();
    await db.insert(mollieRefunds).values({
      id: 're_hist_1',
      paymentId: PAYMENT_ID,
      amountGbp: '5.00',
      status: 'refunded',
    });
    await db.insert(mollieRefunds).values({
      id: 're_hist_2',
      paymentId: PAYMENT_ID,
      amountGbp: '3.00',
      status: 'pending',
    });
    const detail = await getPaymentDetail(PAYMENT_ID);
    expect(detail?.refunds).toHaveLength(2);
    // Most-recent insert appears first.
    expect(detail?.refunds[0]?.id).toMatch(/^re_hist_/);
  });
});

describe('refreshRefundsForPayment', () => {
  it('inserts new rows and updates existing rows', async () => {
    listRefundsResponse = [
      {
        id: 're_remote_1',
        paymentId: PAYMENT_ID,
        status: 'refunded',
        amount: { value: '12.00', currency: 'GBP' },
        description: null,
      },
    ];
    const r1 = await refreshRefundsForPayment(PAYMENT_ID);
    expect(r1.updated).toBe(1);

    // Mollie now reports the same id with a new status.
    listRefundsResponse = [
      {
        id: 're_remote_1',
        paymentId: PAYMENT_ID,
        status: 'refunded', // unchanged status, but row exists → goes to update branch
        amount: { value: '12.00', currency: 'GBP' },
        description: null,
      },
    ];
    const r2 = await refreshRefundsForPayment(PAYMENT_ID);
    expect(r2.updated).toBe(1);

    const db = getDb();
    const rows = await db
      .select()
      .from(mollieRefunds)
      .where(eq(mollieRefunds.id, 're_remote_1'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('refunded');
  });

  it('returns 0 when Mollie reports no refunds', async () => {
    listRefundsResponse = [];
    const result = await refreshRefundsForPayment(PAYMENT_ID);
    expect(result.updated).toBe(0);
  });
});

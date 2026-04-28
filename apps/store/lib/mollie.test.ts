/**
 * Unit tests for the Mollie client. Mocks `fetch` — no real Mollie traffic.
 * Verifies the request shape (Authorization, Idempotency-Key,
 * `_links.checkout.href` mapping) and error mapping.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  process.env.MOLLIE_API_KEY = 'test_xxx';
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const FAKE_PAYMENT = {
  id: 'tr_test_123',
  status: 'open',
  amount: { value: '24.95', currency: 'GBP' },
  method: null,
  description: 'Filament Store',
  metadata: { checkoutId: 'cid-1', reservationId: 'rid-1' },
  redirectUrl: 'http://localhost:3000/checkout/return?cid=cid-1',
  webhookUrl: 'http://localhost:3000/api/mollie/webhook',
  _links: { checkout: { href: 'https://www.mollie.com/checkout/select-method/test_123' } },
};

describe('createPayment', () => {
  it('returns the parsed payment with checkoutUrl', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(FAKE_PAYMENT, 201));
    vi.stubGlobal('fetch', fetchMock);

    const { createPayment } = await import('./mollie');
    const p = await createPayment({
      amount: { value: '24.95', currency: 'GBP' },
      description: 'test',
      redirectUrl: 'http://localhost:3000/checkout/return?cid=cid-1',
      webhookUrl: 'http://localhost:3000/api/mollie/webhook',
      metadata: { checkoutId: 'cid-1' },
      idempotencyKey: 'cid-1',
    });
    expect(p.id).toBe('tr_test_123');
    expect(p.checkoutUrl).toMatch(/^https:\/\/www\.mollie\.com\/checkout/);
    expect(p.amount).toEqual({ value: '24.95', currency: 'GBP' });
  });

  it('sets Authorization Bearer + Idempotency-Key headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(FAKE_PAYMENT, 201));
    vi.stubGlobal('fetch', fetchMock);

    const { createPayment } = await import('./mollie');
    await createPayment({
      amount: { value: '1.00', currency: 'GBP' },
      description: 'x',
      redirectUrl: 'http://x/r',
      webhookUrl: 'http://x/w',
      idempotencyKey: 'idem-1',
    });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test_xxx');
    expect(headers['Idempotency-Key']).toBe('idem-1');
    expect(init.method).toBe('POST');
  });

  it('throws MollieApiError with status + body on 4xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ status: 422, title: 'Unprocessable Entity', detail: 'amount.value invalid' }, 422),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { createPayment, MollieApiError } = await import('./mollie');
    try {
      await createPayment({
        amount: { value: '0', currency: 'GBP' },
        description: 'x',
        redirectUrl: 'http://x/r',
        webhookUrl: 'http://x/w',
        idempotencyKey: 'k',
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MollieApiError);
      const e = err as InstanceType<typeof MollieApiError>;
      expect(e.status).toBe(422);
      expect((e.body as { detail?: string }).detail).toMatch(/amount\.value/);
    }
  });

  it('refuses to call Mollie when MOLLIE_API_KEY is empty', async () => {
    process.env.MOLLIE_API_KEY = '';
    const { createPayment, MollieApiError } = await import('./mollie');
    await expect(
      createPayment({
        amount: { value: '1.00', currency: 'GBP' },
        description: 'x',
        redirectUrl: 'http://x/r',
        webhookUrl: 'http://x/w',
        idempotencyKey: 'k',
      }),
    ).rejects.toBeInstanceOf(MollieApiError);
  });
});

describe('getPayment', () => {
  it('returns the parsed payment', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ ...FAKE_PAYMENT, status: 'paid', method: 'creditcard' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { getPayment } = await import('./mollie');
    const p = await getPayment('tr_test_123');
    expect(p.status).toBe('paid');
    expect(p.method).toBe('creditcard');
  });

  it('uses GET on the by-id endpoint and sends Authorization', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(FAKE_PAYMENT));
    vi.stubGlobal('fetch', fetchMock);

    const { getPayment } = await import('./mollie');
    await getPayment('tr_abc');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/payments\/tr_abc$/);
    expect((init as RequestInit).method).toBe('GET');
    expect(((init as RequestInit).headers as Record<string, string>).Authorization).toBe(
      'Bearer test_xxx',
    );
  });
});

describe('isCommitableStatus / isTerminalNonPaid', () => {
  it('classifies terminal Mollie statuses correctly', async () => {
    const { isCommitableStatus, isTerminalNonPaid } = await import('./mollie');
    expect(isCommitableStatus('paid')).toBe(true);
    expect(isCommitableStatus('authorized')).toBe(true);
    expect(isCommitableStatus('open')).toBe(false);
    expect(isCommitableStatus('failed')).toBe(false);
    expect(isTerminalNonPaid('canceled')).toBe(true);
    expect(isTerminalNonPaid('expired')).toBe(true);
    expect(isTerminalNonPaid('failed')).toBe(true);
    expect(isTerminalNonPaid('paid')).toBe(false);
    expect(isTerminalNonPaid('open')).toBe(false);
  });
});

/**
 * Test for the /api/admin/refunds POST handler. Mocks `issueRefund` so we
 * just verify request parsing + status mapping.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const issueRefundMock = vi.fn();
vi.mock('@/lib/refunds', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/refunds')>('@/lib/refunds');
  return {
    ...actual,
    issueRefund: issueRefundMock,
  };
});

const { POST } = await import('./route');
const { RefundError } = await import('@/lib/refunds');
const { MollieApiError } = await import('@/lib/mollie');

afterEach(() => {
  issueRefundMock.mockReset();
});

function req(body: unknown) {
  return new Request('http://localhost/api/admin/refunds', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}

describe('POST /api/admin/refunds', () => {
  it('rejects bad JSON / shape with 400', async () => {
    const res = await POST(req({ amountGbp: '5.00' })); // missing paymentId
    expect(res.status).toBe(400);
  });

  it('rejects non-tr_ payment ids', async () => {
    const res = await POST(req({ paymentId: 'pay_1', amountGbp: '5.00' }));
    expect(res.status).toBe(400);
  });

  it('rejects bad amount format', async () => {
    const res = await POST(req({ paymentId: 'tr_x', amountGbp: 'free' }));
    expect(res.status).toBe(400);
    const res2 = await POST(req({ paymentId: 'tr_x', amountGbp: '5.123' }));
    expect(res2.status).toBe(400);
  });

  it('returns 201 + body on success', async () => {
    issueRefundMock.mockResolvedValueOnce({
      refundId: 're_1',
      status: 'pending',
      amountGbp: '5.00',
    });
    const res = await POST(req({ paymentId: 'tr_x', amountGbp: '5.00' }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { refundId: string };
    expect(body.refundId).toBe('re_1');
    expect(issueRefundMock).toHaveBeenCalledWith({
      paymentId: 'tr_x',
      amountGbp: '5.00',
    });
  });

  it('maps RefundError to its declared status', async () => {
    issueRefundMock.mockRejectedValueOnce(
      new RefundError('over', 'AMOUNT_EXCEEDS_REMAINING', 422),
    );
    const res = await POST(req({ paymentId: 'tr_x', amountGbp: '5.00' }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('AMOUNT_EXCEEDS_REMAINING');
  });

  it('maps MollieApiError to 502', async () => {
    issueRefundMock.mockRejectedValueOnce(
      new MollieApiError('mollie down', 503, undefined),
    );
    const res = await POST(req({ paymentId: 'tr_x', amountGbp: '5.00' }));
    expect(res.status).toBe(502);
  });
});

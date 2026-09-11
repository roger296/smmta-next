import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getOrderInvoicePdf } = vi.hoisted(() => ({ getOrderInvoicePdf: vi.fn() }));
vi.mock('@/lib/smmta', () => ({ getOrderInvoicePdf }));

const { GET } = await import('./route');

const ORDER_ID = '1fc461b0-0b4a-439b-8d2a-c8b725df5bd9';
const call = (orderId: string) =>
  GET(new Request(`http://localhost:3000/track/${orderId}/invoice`), { params: Promise.resolve({ orderId }) });

beforeEach(() => getOrderInvoicePdf.mockReset());

describe('GET /track/[orderId]/invoice', () => {
  it('downloads the invoice PDF, privately', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.3 test');
    getOrderInvoicePdf.mockResolvedValueOnce({ bytes: pdf.buffer, filename: 'invoice-INV 0001.pdf' });

    const res = await call(ORDER_ID);
    expect(getOrderInvoicePdf).toHaveBeenCalledWith(ORDER_ID);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="invoice-INV-0001.pdf"');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe('%PDF-1.3 test');
  });

  it('404s while the order has no invoice', async () => {
    getOrderInvoicePdf.mockResolvedValueOnce(null);
    expect((await call(ORDER_ID)).status).toBe(404);
  });

  it('404s for something that is not an order id, without asking SMMTA', async () => {
    expect((await call('..%2F..%2Fadmin')).status).toBe(404);
    expect(getOrderInvoicePdf).not.toHaveBeenCalled();
  });
});

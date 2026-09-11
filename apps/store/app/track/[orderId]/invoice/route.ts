/**
 * GET /track/[orderId]/invoice — the order's VAT invoice as a PDF download,
 * linked from the track page.
 *
 * The unguessable order id is the only key, exactly as for the track page
 * itself. The PDF is fetched from SMMTA with the storefront's server-side API
 * key, which never reaches the browser. 404 until an invoice has been issued,
 * which normally happens when the order ships.
 */
import { NextResponse } from 'next/server';
import { getOrderInvoicePdf } from '@/lib/smmta';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ORDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIVATE = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' };

export async function GET(_request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const file = ORDER_ID.test(orderId) ? await getOrderInvoicePdf(orderId) : null;
  if (!file) {
    return new NextResponse('No VAT invoice is available for this order yet.', {
      status: 404,
      headers: { ...PRIVATE, 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  const filename = file.filename.replace(/[^\w.-]+/g, '-');
  return new NextResponse(file.bytes, {
    headers: {
      ...PRIVATE,
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

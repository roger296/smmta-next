/**
 * GET /api/checkout/status?cid=… — read the local checkout status; if the
 * customer has been on /checkout/return for >30s and we still don't have
 * a webhook landing, the underlying `getCheckoutStatus` falls back to a
 * live Mollie fetch so a missing webhook doesn't get the customer stuck.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getCheckoutStatus } from '@/lib/checkout';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const cid = request.nextUrl.searchParams.get('cid');
  if (!cid) {
    return NextResponse.json({ error: 'Missing cid' }, { status: 400 });
  }
  const view = await getCheckoutStatus(cid);
  if (!view) {
    return NextResponse.json({ error: 'Unknown checkout' }, { status: 404 });
  }
  return NextResponse.json(view);
}

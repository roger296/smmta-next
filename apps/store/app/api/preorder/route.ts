/**
 * POST /api/preorder — place a bank-only pre-order (SPEC §16). Server-side:
 * capture the guest (email → storefront user + flag_updates consent) then create
 * the pre-order (manual bank transfer). Returns the payment reference for the
 * bank-transfer instructions. Api-key stays server-side.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getEnv } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  email: z.string().email(),
  sku: z.string().min(1),
  poolRef: z.string().min(1),
  qty: z.number().int().positive().max(999),
  ccrAccepted: z.literal(true),
});

function base(): string {
  return getEnv().SMMTA_API_BASE_URL.replace(/\/$/, '');
}
function authHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${getEnv().SMMTA_API_KEY}` };
}

export async function POST(request: NextRequest) {
  if (!getEnv().SMMTA_API_KEY) return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad_request', detail: parsed.error.flatten() }, { status: 400 });
  }
  const { email, sku, poolRef, qty } = parsed.data;

  // 1. Guest capture → user id.
  const guestRes = await fetch(`${base()}/storefront/identity/guest`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ email, source: 'preorder' }),
  });
  const guest = (await guestRes.json().catch(() => ({}))) as { data?: { id: string } };
  if (!guestRes.ok || !guest.data) return NextResponse.json({ error: 'identity_failed' }, { status: 502 });

  // 2. Create the pre-order (manual bank transfer → bank-only rule enforced server-side).
  const orderRes = await fetch(`${base()}/storefront/preorders`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      userId: guest.data.id,
      items: [{ sku, qty, poolRef }],
      paymentMethod: 'manual_transfer',
    }),
  });
  const order = (await orderRes.json().catch(() => ({}))) as {
    data?: { paymentReference: string; totalPence: number; status: string };
    error?: string;
  };
  if (orderRes.status === 409) {
    return NextResponse.json({ error: order.error ?? 'not_allowed' }, { status: 409 });
  }
  if (!orderRes.ok || !order.data) return NextResponse.json({ error: 'order_failed' }, { status: 502 });

  return NextResponse.json({
    paymentReference: order.data.paymentReference,
    totalPence: order.data.totalPence,
    status: order.data.status,
  });
}

/** POST /api/preorder/lookup — check a pre-order status by reference + email. */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getEnv } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ reference: z.string().min(1), email: z.string().email() });

export async function POST(request: NextRequest) {
  const env = getEnv();
  if (!env.SMMTA_API_KEY) return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'bad_request' }, { status: 400 });

  const base = env.SMMTA_API_BASE_URL.replace(/\/$/, '');
  const res = await fetch(`${base}/storefront/preorders/lookup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.SMMTA_API_KEY}` },
    body: JSON.stringify(parsed.data),
  });
  if (res.status === 404) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const body = (await res.json().catch(() => ({}))) as { data?: unknown };
  if (!res.ok || !body.data) return NextResponse.json({ error: 'failed' }, { status: 502 });
  return NextResponse.json(body.data);
}

/**
 * POST /api/interest — register interest in a coming-soon product (F8).
 * Server-side proxy (api-key stays server-side). The API captures the guest
 * user + flag_updates consent from the action.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getEnv } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  email: z.string().email(),
  prospectiveId: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  const env = getEnv();
  if (!env.SMMTA_API_KEY) return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'bad_request' }, { status: 400 });

  const base = env.SMMTA_API_BASE_URL.replace(/\/$/, '');
  const res = await fetch(`${base}/storefront/interest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.SMMTA_API_KEY}` },
    body: JSON.stringify({
      email: parsed.data.email,
      prospectiveId: parsed.data.prospectiveId,
      flagType: 'register_interest',
      sourcePage: 'coming-soon',
    }),
  });
  if (!res.ok) return NextResponse.json({ error: 'failed' }, { status: 502 });
  return NextResponse.json({ ok: true });
}

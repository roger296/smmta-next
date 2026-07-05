/**
 * POST /api/chat/session — start a sales-agent chat session.
 * Server-side proxy so the storefront api-key never reaches the browser.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getEnv } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function apiBase(): string {
  return getEnv().SMMTA_API_BASE_URL.replace(/\/$/, '');
}

export async function POST(_request: NextRequest) {
  const env = getEnv();
  if (!env.SMMTA_API_KEY) {
    return NextResponse.json({ error: 'chat unavailable' }, { status: 503 });
  }
  const res = await fetch(`${apiBase()}/storefront/chat/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.SMMTA_API_KEY}` },
    body: JSON.stringify({}),
  });
  const body = (await res.json().catch(() => ({}))) as { data?: { sessionId: string; basketId: string } };
  if (!res.ok || !body.data) {
    return NextResponse.json({ error: 'could not start chat' }, { status: 502 });
  }
  return NextResponse.json({ sessionId: body.data.sessionId });
}

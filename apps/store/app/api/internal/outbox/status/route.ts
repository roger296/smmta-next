/**
 * GET /api/internal/outbox/status — read-only snapshot of the email outbox.
 *
 * Exists because diagnosing "no emails are arriving" previously required a
 * shell on the host and a psql session: there was no way to tell an empty
 * queue from a stalled drainer from a provider rejection. This answers all
 * three, and is what the admin SPA renders via the API's /admin/outbox proxy.
 *
 * Auth: `Authorization: Bearer <ADMIN_API_KEY>` — the same shared secret the
 * drainer uses. Never exposed to the browser directly; the API proxies it.
 */
import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { getEnv } from '@/lib/env';
import { getOutboxStatus } from '@/lib/email';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function authorised(request: NextRequest): boolean {
  const expected = getEnv().ADMIN_API_KEY;
  if (!expected) return false;
  const got = request.headers.get('authorization') ?? '';
  if (!got.startsWith('Bearer ')) return false;
  const token = got.slice('Bearer '.length).trim();
  if (token.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  if (!authorised(request)) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } },
    );
  }
  try {
    return NextResponse.json(await getOutboxStatus());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to read outbox status' },
      { status: 500 },
    );
  }
}

/**
 * POST /api/internal/process-outbox — pop up to 50 PENDING outbox rows
 * and send them via SendGrid. Returns counts so a host cron can log
 * something useful.
 *
 * Auth: `Authorization: Bearer <ADMIN_API_KEY>`. v1 cron is the simplest
 * possible — `* * * * * curl -X POST -H "Authorization: Bearer $K"
 * https://store.example.com/api/internal/process-outbox`. Migrate to a
 * BullMQ worker later.
 *
 * Constant-time comparison on the bearer so a leaked timing oracle
 * doesn't make the key easier to guess.
 */
import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { getEnv } from '@/lib/env';
import { processOutbox } from '@/lib/email';

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

export async function POST(request: NextRequest) {
  if (!authorised(request)) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } },
    );
  }
  try {
    const result = await processOutbox();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Outbox processing failed' },
      { status: 500 },
    );
  }
}

/** GET on the same path is a no-op probe so a host monitor can hit it
 *  without forcing a send loop. */
export async function GET(request: NextRequest) {
  if (!authorised(request)) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } },
    );
  }
  return NextResponse.json({ ok: true, hint: 'POST to actually process the outbox.' });
}

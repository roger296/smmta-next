/**
 * /healthz — runtime health probe used by Nginx + the synthetic checks
 * in Prompt 14. Returns 200 with `{ ok, db, api }` when both Postgres
 * and the SMMTA API are reachable; 503 otherwise.
 *
 * Always served fresh — this is a probe, not a cacheable resource.
 */
import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { ping } from '@/lib/smmta';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface HealthBody {
  ok: boolean;
  db: 'ok' | 'fail';
  api: 'ok' | 'fail';
  detail?: { dbError?: string; apiStatus?: number };
}

async function checkDb(): Promise<{ ok: boolean; error?: string }> {
  try {
    await getDb().execute(sql`select 1`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown' };
  }
}

export async function GET(): Promise<NextResponse> {
  const [db, api] = await Promise.all([checkDb(), ping()]);
  const body: HealthBody = {
    ok: db.ok && api.ok,
    db: db.ok ? 'ok' : 'fail',
    api: api.ok ? 'ok' : 'fail',
  };
  if (!db.ok && db.error) (body.detail ??= {}).dbError = db.error;
  if (!api.ok) (body.detail ??= {}).apiStatus = api.status;
  return NextResponse.json(body, { status: body.ok ? 200 : 503 });
}

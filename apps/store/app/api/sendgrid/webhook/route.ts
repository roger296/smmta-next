/**
 * POST /api/sendgrid/webhook — SendGrid event webhook receiver.
 *
 * Persists the raw payload to `webhook_deliveries` with `source='sendgrid'`.
 * No automatic suppression — Prompt 11 explicitly leaves that as an
 * operator concern (the audit trail is what they need to see).
 *
 * SendGrid sends a JSON array of events; we log them all under a single
 * delivery row with the raw body verbatim so future signature
 * verification (Prompt 12+ if/when we wire it) can re-read the bytes.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { webhookDeliveries } from '@/drizzle/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SendGridEvent {
  event?: string;
  email?: string;
  reason?: string;
  sg_message_id?: string;
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const db = getDb();

  let parsed: SendGridEvent[] = [];
  try {
    const body = JSON.parse(rawBody) as unknown;
    if (Array.isArray(body)) parsed = body as SendGridEvent[];
  } catch {
    // Non-JSON body — log it anyway and respond 200 so SendGrid stops retrying.
  }

  const counts = parsed.reduce<Record<string, number>>((acc, e) => {
    const k = e.event ?? 'unknown';
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

  await db.insert(webhookDeliveries).values({
    source: 'sendgrid',
    rawBody,
    signatureOk: false, // signature verification is a follow-up
    actionTaken:
      Object.keys(counts).length > 0
        ? `logged ${parsed.length} events: ${Object.entries(counts)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')}`
        : 'logged (non-JSON body)',
  });

  return NextResponse.json({ ok: true, received: parsed.length });
}

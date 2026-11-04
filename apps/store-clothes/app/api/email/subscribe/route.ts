/**
 * POST /api/email/subscribe — the footer newsletter signup.
 *
 * Accepts JSON or a plain form post (`email` + repeated `interests`),
 * validates it, then forwards to SMMTA-NEXT's `POST /storefront/email/subscribe`
 * with the shopper's IP and user agent for the consent record.
 *
 * The response is the same `{ ok: true }` whether the address was new or
 * already subscribed, and failures come back as one generic error, so the
 * endpoint cannot be used to find out who is on the list.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { subscribeEmail } from '@/lib/smmta';
import { clientIp } from '@/lib/email-capture';
import { NEWSLETTER_SIGNUP_COPY } from '@/lib/email-copy';
import { log } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  email: z.string().trim().email().max(320),
  interests: z.array(z.string().min(1).max(64)).max(32).default([]),
});

async function readBody(request: NextRequest): Promise<unknown> {
  const type = request.headers.get('content-type') ?? '';
  if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
    const form = await request.formData().catch(() => null);
    if (!form) return null;
    return {
      email: form.get('email'),
      interests: form.getAll('interests').filter((v): v is string => typeof v === 'string'),
    };
  }
  return request.json().catch(() => null);
}

export async function POST(request: NextRequest) {
  const parsed = bodySchema.safeParse(await readBody(request));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  try {
    await subscribeEmail({
      email: parsed.data.email,
      interests: parsed.data.interests,
      wording: NEWSLETTER_SIGNUP_COPY,
      ip: clientIp(request.headers),
      userAgent: request.headers.get('user-agent') ?? undefined,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    log.warn({ err }, 'newsletter subscribe failed');
    return NextResponse.json({ error: 'subscribe_failed' }, { status: 500 });
  }
}

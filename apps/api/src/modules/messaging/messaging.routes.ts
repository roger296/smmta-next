/**
 * SendGrid event webhook + one-click unsubscribe (SPEC §4.6, §12.3).
 *  - /webhooks/sendgrid: signature-verified; bounces/complaints/unsubscribes
 *    upsert the suppression list (+ consent revocation).
 *  - /unsubscribe: signed link → revoke general_marketing consent + suppress.
 *
 * Auth scheme: a shared secret SendGrid sends as a static custom header
 * `X-Webhook-Signature: <SENDGRID_WEBHOOK_KEY>`. SendGrid's Event Webhook can
 * attach static headers but cannot HMAC the request body, so a shared secret
 * over HTTPS (body integrity guaranteed by TLS) is the pragmatic check. Future
 * hardening: SendGrid's ECDSA signed webhook (needs the raw request body + the
 * verification public key); this wrapper keeps that a localized change.
 */
import { timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../config/database.js';
import { getEnv } from '../../config/env.js';
import { storefrontUsers } from '../../db/schema/index.js';
import { SuppressionService, type SuppressionReason } from './suppression.service.js';
import { verifyUnsubscribe } from './unsubscribe.js';

const suppression = new SuppressionService();

// Constant-time comparison of the shared secret presented in the webhook header
// against SENDGRID_WEBHOOK_KEY. See the file header for the scheme + rationale.
function verifySignature(signature: string | undefined): boolean {
  const secret = getEnv().SENDGRID_WEBHOOK_KEY;
  if (!signature || !secret) return false;
  const presented = Buffer.from(signature);
  const expected = Buffer.from(secret);
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

const EVENT_TO_REASON: Record<string, SuppressionReason | undefined> = {
  bounce: 'bounce',
  dropped: 'bounce',
  spamreport: 'complaint',
  unsubscribe: 'unsubscribe',
  group_unsubscribe: 'unsubscribe',
};

export async function sendgridWebhookRoutes(app: FastifyInstance) {
  app.post('/webhooks/sendgrid', async (request, reply) => {
    const signature = request.headers['x-webhook-signature'] as string | undefined;
    if (!verifySignature(signature)) {
      return reply.status(401).send({ success: false, error: 'invalid signature' });
    }
    const events = z
      .array(z.object({ email: z.string().email(), event: z.string() }))
      .safeParse(request.body);
    if (!events.success) return reply.status(400).send({ success: false, error: 'bad payload' });

    for (const e of events.data) {
      const reason = EVENT_TO_REASON[e.event];
      if (reason) {
        await suppression.suppress(e.email, reason);
        if (reason === 'unsubscribe' || reason === 'complaint') {
          await suppression.cancelPendingDraftsForEmail(e.email);
        }
      }
    }
    return reply.status(200).send({ success: true });
  });
}

export async function unsubscribeRoutes(app: FastifyInstance) {
  const handle = async (userId: string, token: string): Promise<boolean> => {
    if (!verifyUnsubscribe(userId, token)) return false;
    const [user] = await getDb()
      .select({ email: storefrontUsers.email })
      .from(storefrontUsers)
      .where(eq(storefrontUsers.id, userId))
      .limit(1);
    if (!user?.email) return false;
    await suppression.suppress(user.email, 'unsubscribe');
    await suppression.cancelPendingDraftsForEmail(user.email);
    return true;
  };

  const schema = z.object({ u: z.string().uuid(), t: z.string() });

  app.get('/unsubscribe', async (request, reply) => {
    const q = schema.safeParse(request.query);
    if (!q.success) return reply.status(400).send('Invalid unsubscribe link.');
    const okd = await handle(q.data.u, q.data.t);
    return reply
      .header('content-type', 'text/html')
      .send(okd ? '<p>You have been unsubscribed. Sorry to see you go.</p>' : '<p>Invalid or expired link.</p>');
  });

  // One-click (List-Unsubscribe-Post).
  app.post('/unsubscribe', async (request, reply) => {
    const q = schema.safeParse(request.query);
    if (!q.success) return reply.status(400).send({ success: false });
    const okd = await handle(q.data.u, q.data.t);
    return reply.status(okd ? 200 : 400).send({ success: okd });
  });
}

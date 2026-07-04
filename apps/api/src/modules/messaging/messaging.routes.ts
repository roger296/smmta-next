/**
 * SendGrid event webhook + one-click unsubscribe (SPEC §4.6, §12.3).
 *  - /webhooks/sendgrid: signature-verified; bounces/complaints/unsubscribes
 *    upsert the suppression list (+ consent revocation).
 *  - /unsubscribe: signed link → revoke general_marketing consent + suppress.
 *
 * Signature scheme (logged): HMAC-SHA256 over the JSON body with
 * SENDGRID_WEBHOOK_KEY. Production may switch to SendGrid's ECDSA public-key
 * verification; the wrapper boundary makes that a localized change.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../config/database.js';
import { getEnv } from '../../config/env.js';
import { storefrontUsers } from '../../db/schema/index.js';
import { SuppressionService, type SuppressionReason } from './suppression.service.js';
import { verifyUnsubscribe } from './unsubscribe.js';

const suppression = new SuppressionService();

function verifySignature(rawJson: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', getEnv().SENDGRID_WEBHOOK_KEY).update(rawJson).digest('hex');
  if (signature.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
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
    const rawJson = JSON.stringify(request.body);
    if (!verifySignature(rawJson, signature)) {
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

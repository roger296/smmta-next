/**
 * SendGrid event webhook + one-click unsubscribe (SPEC §4.6, §12.3).
 *  - /webhooks/sendgrid: signature-verified; bounces/complaints/unsubscribes
 *    upsert the suppression list (+ consent revocation).
 *  - /unsubscribe: signed link → revoke general_marketing consent + suppress.
 *
 * Auth: SendGrid's Signed Event Webhook. SendGrid signs `timestamp + rawBody`
 * with ECDSA P-256 and sends the base64 signature + timestamp in the
 * X-Twilio-Email-Event-Webhook-Signature / -Timestamp headers. We verify with
 * the base64 public verification key SendGrid shows when signing is enabled
 * (SENDGRID_WEBHOOK_VERIFICATION_KEY). Verification needs the exact raw request
 * body, so this route parses application/json as a raw string (scoped to the
 * plugin) and JSON.parses it only after the signature checks out.
 */
import { createVerify } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../config/database.js';
import { getEnv } from '../../config/env.js';
import { storefrontUsers } from '../../db/schema/index.js';
import { SuppressionService, type SuppressionReason } from './suppression.service.js';
import { verifyUnsubscribe } from './unsubscribe.js';

const suppression = new SuppressionService();

// Verify SendGrid's ECDSA signature over `timestamp + rawBody`. The public
// verification key is base64 SPKI DER; wrap it in PEM for Node. Node's default
// EC signature encoding is DER, which matches SendGrid. Fails closed.
function verifySignature(
  rawBody: string,
  signature: string | undefined,
  timestamp: string | undefined,
): boolean {
  const key = getEnv().SENDGRID_WEBHOOK_VERIFICATION_KEY;
  if (!key || !signature || !timestamp) return false;
  const pem = `-----BEGIN PUBLIC KEY-----\n${key}\n-----END PUBLIC KEY-----\n`;
  try {
    const verifier = createVerify('sha256');
    verifier.update(timestamp + rawBody);
    verifier.end();
    return verifier.verify(pem, signature, 'base64');
  } catch {
    return false;
  }
}

const EVENT_TO_REASON: Record<string, SuppressionReason | undefined> = {
  bounce: 'bounce',
  dropped: 'bounce',
  spamreport: 'complaint',
  unsubscribe: 'unsubscribe',
  group_unsubscribe: 'unsubscribe',
};

export async function sendgridWebhookRoutes(app: FastifyInstance) {
  // SendGrid signs the exact raw payload, so keep it as a string — JSON.stringify
  // of a parsed object would not reproduce the signed bytes. Scoped to this
  // encapsulated plugin, so other routes keep the default JSON parser.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) =>
    done(null, body),
  );

  app.post('/webhooks/sendgrid', async (request, reply) => {
    const raw = typeof request.body === 'string' ? request.body : '';
    const signature = request.headers['x-twilio-email-event-webhook-signature'] as
      | string
      | undefined;
    const timestamp = request.headers['x-twilio-email-event-webhook-timestamp'] as
      | string
      | undefined;
    if (!verifySignature(raw, signature, timestamp)) {
      return reply.status(401).send({ success: false, error: 'invalid signature' });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return reply.status(400).send({ success: false, error: 'invalid json' });
    }
    const events = z
      .array(z.object({ email: z.string().email(), event: z.string() }))
      .safeParse(payload);
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

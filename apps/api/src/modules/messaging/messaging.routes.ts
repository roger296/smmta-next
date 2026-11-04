/**
 * SendGrid event webhook + one-click unsubscribe (SPEC §4.6, §12.3).
 *  - /webhooks/sendgrid: signature-verified; bounces/complaints/unsubscribes
 *    upsert the suppression list (+ consent revocation), and every event goes
 *    to the email system's event log (docs/email). Mounted at
 *    /api/v1/webhooks/sendgrid and /api/webhooks/sendgrid.
 *  - /unsubscribe: signed link → revoke general_marketing consent + suppress.
 *
 * Auth: SendGrid's Signed Event Webhook. SendGrid signs `timestamp + rawBody`
 * with ECDSA P-256 and sends the base64 signature + timestamp in the
 * X-Twilio-Email-Event-Webhook-Signature / -Timestamp headers. We verify with
 * the base64 public verification key SendGrid shows when signing is enabled
 * (SENDGRID_WEBHOOK_VERIFICATION_KEY). Verification needs the exact raw request
 * body, so this route parses application/json as a raw string (scoped to the
 * plugin) and JSON.parses it only after the signature checks out.
 *
 * Sharing the webhook: SendGrid gives a smaller account one Event Webhook,
 * which Bloodhound also needs. With SENDGRID_WEBHOOK_FORWARD_URL set, each
 * batch that passes the signature check is posted on to that URL byte for
 * byte, with SendGrid's signature headers, so the other system can verify it
 * as if SendGrid had sent it. Ours is processed first; if the forward fails
 * with a network error or 5xx we answer 503, so SendGrid resends the batch
 * (our side ignores the duplicates). A 4xx from the other side is logged and
 * not retried.
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
import { webhookVerificationKey } from '../email/lib/config.js';
import { EventsService, type SendGridEvent } from '../email/services/events.service.js';

const emailEvents = new EventsService();

const suppression = new SuppressionService();

// Verify SendGrid's ECDSA signature over `timestamp + rawBody`. The public
// verification key is base64 SPKI DER; wrap it in PEM for Node. Node's default
// EC signature encoding is DER, which matches SendGrid. Fails closed.
function verifySignature(
  rawBody: string,
  signature: string | undefined,
  timestamp: string | undefined,
): boolean {
  // Either name of the key (the email system's runbook calls it
  // SENDGRID_WEBHOOK_PUBLIC_KEY).
  const key = webhookVerificationKey();
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

const SIGNATURE = 'x-twilio-email-event-webhook-signature';
const TIMESTAMP = 'x-twilio-email-event-webhook-timestamp';

/** Pass a verified batch on to the system sharing the webhook. Returns false
 *  only when SendGrid should resend (network error, timeout or 5xx). */
export async function forwardWebhook(
  raw: string,
  signature: string,
  timestamp: string,
  log: { warn: (o: object, msg: string) => void },
): Promise<boolean> {
  const url = getEnv().SENDGRID_WEBHOOK_FORWARD_URL;
  if (!url) return true;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SIGNATURE]: signature, [TIMESTAMP]: timestamp },
      body: raw,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return true;
    log.warn({ status: res.status }, 'sendgrid webhook forward refused');
    return res.status < 500;
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'sendgrid webhook forward failed');
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
      .array(z.object({ email: z.string().email(), event: z.string() }).passthrough())
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
    // The email system's event log: send status, deliverability, consent and
    // interests (modules/email/services/events.service.ts).
    await emailEvents.ingest(events.data as SendGridEvent[]);
    if (!(await forwardWebhook(raw, signature!, timestamp!, request.log))) {
      return reply.status(503).send({ success: false, error: 'forward failed; resend' });
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

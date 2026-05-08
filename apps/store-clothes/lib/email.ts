/**
 * Transactional email service.
 *
 *   enqueue(template, payload, toEmail [, orderId])
 *     → inserts a row into `email_outbox`. Idempotent per
 *       (orderId, template) thanks to the unique index from Prompt 7.
 *       Re-enqueueing the same combination silently no-ops.
 *
 *   processOutbox()
 *     → pops up to 50 PENDING rows, renders the template, sends via
 *       SendGrid, marks `sent_at` on success or stores the error.
 *       Designed to be called from cron (host or BullMQ later).
 *
 *   sendgridClient
 *     → memoised. In any non-production NODE_ENV the SendGrid sandbox
 *       mode is enabled so test runs can't accidentally deliver to real
 *       inboxes. The flag is set on every send (not just at init) so
 *       there's no way for a stale init to leak through.
 *
 * Server-only.
 */
import 'server-only';
import sgMail from '@sendgrid/mail';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from './db';
import { getEnv } from './env';
import { emailOutbox } from '@/drizzle/schema';
import {
  renderTemplate,
  type TemplateName,
  type TemplatePayloads,
  type RenderedEmail,
} from './email-templates';

let sgInitialised = false;

function ensureSendGrid(): typeof sgMail {
  if (!sgInitialised) {
    const env = getEnv();
    if (!env.SENDGRID_API_KEY) {
      throw new Error('SENDGRID_API_KEY is not set');
    }
    sgMail.setApiKey(env.SENDGRID_API_KEY);
    sgInitialised = true;
  }
  return sgMail;
}

/** Sandbox mode is on whenever NODE_ENV !== 'production'. SendGrid's
 *  sandbox accepts the request, runs validation, and returns 200 without
 *  actually delivering — exactly what we want for staging / tests / dev. */
function shouldSandbox(): boolean {
  return process.env.NODE_ENV !== 'production';
}

// ---------------------------------------------------------------------------
// enqueue
// ---------------------------------------------------------------------------

export interface EnqueueOptions {
  /** Optional SMMTA orderId — when set, the unique partial index on
   *  `(order_id, template)` makes the enqueue idempotent. Re-enqueueing
   *  the same combination silently no-ops. */
  orderId?: string;
}

export async function enqueue<T extends TemplateName>(
  template: T,
  payload: TemplatePayloads[T],
  toEmail: string,
  options: EnqueueOptions = {},
): Promise<{ enqueued: boolean }> {
  const db = getDb();
  try {
    await db.insert(emailOutbox).values({
      toEmail,
      template,
      payload: payload as unknown as Record<string, unknown>,
      sendStatus: 'PENDING',
      orderId: options.orderId ?? null,
    });
    return { enqueued: true };
  } catch (err) {
    // Unique-violation on (order_id, template) → already enqueued. Silent.
    if (err instanceof Error && /duplicate key|unique constraint/i.test(err.message)) {
      return { enqueued: false };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// processOutbox
// ---------------------------------------------------------------------------

export interface ProcessOutboxResult {
  attempted: number;
  sent: number;
  failed: number;
  errors: Array<{ id: string; error: string }>;
}

export async function processOutbox(batchSize = 50): Promise<ProcessOutboxResult> {
  const db = getDb();
  const env = getEnv();
  const result: ProcessOutboxResult = { attempted: 0, sent: 0, failed: 0, errors: [] };

  // Pop up to N PENDING rows. We re-read each row's payload + template
  // freshly because the row's JSONB column carries the template-specific
  // payload type at runtime.
  const pending = await db
    .select()
    .from(emailOutbox)
    .where(and(eq(emailOutbox.sendStatus, 'PENDING'), isNull(emailOutbox.sentAt)))
    .limit(batchSize);

  if (pending.length === 0) return result;

  const sg = ensureSendGrid();

  for (const row of pending) {
    result.attempted += 1;
    try {
      let rendered: RenderedEmail;
      try {
        // The payload is stored as JSONB; cast through `unknown` to the
        // template-specific shape. `renderTemplate` does the runtime
        // dispatch.
        rendered = renderTemplate(
          row.template as TemplateName,
          row.payload as unknown as TemplatePayloads[TemplateName],
        );
      } catch (err) {
        await db
          .update(emailOutbox)
          .set({
            sendStatus: 'FAILED',
            error: err instanceof Error ? err.message : 'Render error',
            updatedAt: new Date(),
          })
          .where(eq(emailOutbox.id, row.id));
        result.failed += 1;
        result.errors.push({
          id: row.id,
          error: err instanceof Error ? err.message : 'Render error',
        });
        continue;
      }

      await sg.send({
        to: row.toEmail,
        from: env.SENDGRID_FROM,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        // Per-message sandbox flag — re-applied every send so tests
        // running in vitest never escape, even after a hot module reload.
        mailSettings: { sandboxMode: { enable: shouldSandbox() } },
      });

      await db
        .update(emailOutbox)
        .set({
          sendStatus: 'SENT',
          sentAt: new Date(),
          error: null,
          updatedAt: new Date(),
        })
        .where(eq(emailOutbox.id, row.id));
      result.sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Send error';
      await db
        .update(emailOutbox)
        .set({
          sendStatus: 'FAILED',
          error: message,
          updatedAt: new Date(),
        })
        .where(eq(emailOutbox.id, row.id));
      result.failed += 1;
      result.errors.push({ id: row.id, error: message });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Test-only escape hatch — let tests reset the memoised SendGrid init so
// they can swap the env between cases.
// ---------------------------------------------------------------------------

export function _resetForTests(): void {
  sgInitialised = false;
}

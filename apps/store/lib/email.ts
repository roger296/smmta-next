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
import { and, eq, isNull, or, lte, lt, sql, desc } from 'drizzle-orm';
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
// Provider error diagnostics
// ---------------------------------------------------------------------------

/** Give up after this many attempts on a transient failure. */
export const MAX_ATTEMPTS = 6;

/** Backoff schedule in minutes, indexed by attempt number. Roughly
 *  1m, 5m, 15m, 1h, 6h — long enough to ride out a provider incident
 *  without hammering it, short enough that a blip self-heals unattended. */
const BACKOFF_MINUTES = [1, 5, 15, 60, 360];

interface ProviderFailure {
  /** Human-readable detail, including SendGrid's errors[] where present. */
  message: string;
  /** HTTP status, when the failure came from the provider at all. */
  statusCode: number | null;
  /** Whether retrying could plausibly succeed. */
  retryable: boolean;
}

/**
 * Turn whatever the SendGrid SDK threw into something worth storing.
 *
 * `ResponseError.message` is only the HTTP status text ("Forbidden"), while
 * the actionable reason ("The from address does not match a verified Sender
 * Identity") lives in `response.body.errors` and is rendered only by
 * `toString()`. Storing the bare message is what made a 403 look like an
 * unexplained outage rather than a one-line configuration fix.
 */
export function describeFailure(err: unknown): ProviderFailure {
  const anyErr = err as { code?: unknown; toString?: () => string; message?: string };
  const statusCode = typeof anyErr?.code === 'number' ? anyErr.code : null;

  let message: string;
  try {
    // ResponseError.toString() folds in errors[].message/field/help.
    message = typeof anyErr?.toString === 'function' ? String(anyErr) : String(err);
  } catch {
    message = anyErr?.message ?? 'Send error';
  }
  if (!message || message === '[object Object]') message = anyErr?.message ?? 'Send error';

  return { message, statusCode, retryable: isRetryable(statusCode) };
}

/**
 * 429 and 5xx are transient — rate limiting or a provider incident. Every
 * other 4xx is a rejection of *this* message (unverified sender, malformed
 * payload, suppressed recipient); retrying re-sends an identical request and
 * gets an identical refusal, so those stop immediately. No status at all means
 * the request never completed — a network or DNS fault, which is retryable.
 */
export function isRetryable(statusCode: number | null): boolean {
  if (statusCode === null) return true;
  if (statusCode === 429) return true;
  return statusCode >= 500;
}

/** SendGrid returns the id that its Activity feed is keyed on in a header. */
function extractMessageId(response: unknown): string | null {
  const headers = (response as { headers?: Record<string, unknown> } | undefined)?.headers;
  const raw = headers?.['x-message-id'] ?? headers?.['X-Message-Id'];
  return typeof raw === 'string' && raw.length > 0 ? raw.slice(0, 200) : null;
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
  errors: Array<{
    id: string;
    error: string;
    statusCode?: number | null;
    attempts?: number;
    willRetry?: boolean;
  }>;
}

export async function processOutbox(batchSize = 50): Promise<ProcessOutboxResult> {
  const db = getDb();
  const env = getEnv();
  const result: ProcessOutboxResult = { attempted: 0, sent: 0, failed: 0, errors: [] };

  // Pop up to N PENDING rows. We re-read each row's payload + template
  // freshly because the row's JSONB column carries the template-specific
  // payload type at runtime.
  // PENDING rows, plus FAILED rows the classifier explicitly scheduled for
  // another go. A FAILED row with next_attempt_at NULL is dead by design —
  // either the failure was permanent, or it predates retry support — so a
  // deploy never resurrects historical failures.
  const now = new Date();
  const pending = await db
    .select()
    .from(emailOutbox)
    .where(
      and(
        isNull(emailOutbox.sentAt),
        or(
          eq(emailOutbox.sendStatus, 'PENDING'),
          and(
            eq(emailOutbox.sendStatus, 'FAILED'),
            lt(emailOutbox.attempts, MAX_ATTEMPTS),
            lte(emailOutbox.nextAttemptAt, now),
          ),
        ),
      ),
    )
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
        // A render failure is a bad payload, not a provider problem: the same
        // input renders the same way for ever. Leave next_attempt_at NULL so
        // it is never retried, and record the attempt for visibility.
        await db
          .update(emailOutbox)
          .set({
            sendStatus: 'FAILED',
            error: `Render error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 4000),
            attempts: row.attempts + 1,
            nextAttemptAt: null,
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

      const [response] = await sg.send({
        to: row.toEmail,
        from: env.SENDGRID_FROM,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        // Per-message sandbox flag — re-applied every send so tests
        // running in vitest never escape, even after a hot module reload.
        mailSettings: { sandboxMode: { enable: shouldSandbox() } },
        // Ties SendGrid's delivered/bounce/dropped webhook events back to the
        // row that produced them, so a bounce is traceable to an order.
        customArgs: { outboxId: row.id },
      });

      await db
        .update(emailOutbox)
        .set({
          sendStatus: 'SENT',
          sentAt: new Date(),
          error: null,
          lastStatusCode: (response as { statusCode?: number } | undefined)?.statusCode ?? null,
          providerMessageId: extractMessageId(response),
          attempts: row.attempts + 1,
          nextAttemptAt: null,
          updatedAt: new Date(),
        })
        .where(eq(emailOutbox.id, row.id));
      result.sent += 1;
    } catch (err) {
      const failure = describeFailure(err);
      const attempts = row.attempts + 1;
      // Schedule another go only while the failure looks transient and we
      // haven't exhausted the budget; otherwise leave next_attempt_at NULL,
      // which is the marker for "do not retry".
      const willRetry = failure.retryable && attempts < MAX_ATTEMPTS;
      const backoffMins = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)];
      await db
        .update(emailOutbox)
        .set({
          sendStatus: 'FAILED',
          error: failure.message.slice(0, 4000),
          lastStatusCode: failure.statusCode,
          attempts,
          nextAttemptAt: willRetry ? new Date(Date.now() + backoffMins * 60_000) : null,
          updatedAt: new Date(),
        })
        .where(eq(emailOutbox.id, row.id));
      result.failed += 1;
      result.errors.push({
        id: row.id,
        error: failure.message,
        statusCode: failure.statusCode,
        attempts,
        willRetry,
      });
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

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface OutboxStatus {
  counts: { PENDING: number; SENT: number; FAILED: number };
  /** FAILED rows with a scheduled retry — these will resolve themselves. */
  awaitingRetry: number;
  /** FAILED rows that will never be retried without intervention. */
  stuck: number;
  /** Age in seconds of the oldest unsent row; null when the queue is clear.
   *  The single most useful number here: a rising value means the drainer has
   *  stopped, which no per-row status reveals on its own. */
  oldestUnsentAgeSeconds: number | null;
  lastSentAt: string | null;
  recentFailures: Array<{
    id: string;
    toEmail: string;
    template: string;
    error: string | null;
    statusCode: number | null;
    attempts: number;
    nextAttemptAt: string | null;
    updatedAt: string;
  }>;
}

/** Snapshot of the outbox for operators. Read-only; sends nothing. */
export async function getOutboxStatus(failureLimit = 10): Promise<OutboxStatus> {
  const db = getDb();

  const grouped = await db
    .select({ status: emailOutbox.sendStatus, n: sql<number>`count(*)::int` })
    .from(emailOutbox)
    .groupBy(emailOutbox.sendStatus);

  const counts = { PENDING: 0, SENT: 0, FAILED: 0 };
  for (const g of grouped) counts[g.status as keyof typeof counts] = Number(g.n);

  const [retryRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(emailOutbox)
    .where(and(eq(emailOutbox.sendStatus, 'FAILED'), sql`${emailOutbox.nextAttemptAt} is not null`));
  const awaitingRetry = Number(retryRow?.n ?? 0);

  const [oldest] = await db
    .select({ createdAt: emailOutbox.createdAt })
    .from(emailOutbox)
    .where(isNull(emailOutbox.sentAt))
    .orderBy(emailOutbox.createdAt)
    .limit(1);

  const [lastSent] = await db
    .select({ sentAt: emailOutbox.sentAt })
    .from(emailOutbox)
    .where(eq(emailOutbox.sendStatus, 'SENT'))
    .orderBy(desc(emailOutbox.sentAt))
    .limit(1);

  const failures = await db
    .select()
    .from(emailOutbox)
    .where(eq(emailOutbox.sendStatus, 'FAILED'))
    .orderBy(desc(emailOutbox.updatedAt))
    .limit(failureLimit);

  return {
    counts,
    awaitingRetry,
    stuck: Math.max(0, counts.FAILED - awaitingRetry),
    oldestUnsentAgeSeconds: oldest?.createdAt
      ? Math.max(0, Math.floor((Date.now() - new Date(oldest.createdAt).getTime()) / 1000))
      : null,
    lastSentAt: lastSent?.sentAt ? new Date(lastSent.sentAt).toISOString() : null,
    recentFailures: failures.map((f) => ({
      id: f.id,
      toEmail: f.toEmail,
      template: f.template,
      error: f.error,
      statusCode: f.lastStatusCode,
      attempts: f.attempts,
      nextAttemptAt: f.nextAttemptAt ? new Date(f.nextAttemptAt).toISOString() : null,
      updatedAt: new Date(f.updatedAt).toISOString(),
    })),
  };
}

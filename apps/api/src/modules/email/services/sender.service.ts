/**
 * The sender. Section 3 stub: in sandbox mode it marks due queued rows sent,
 * so the pipeline is testable end to end; section 6 replaces it with the real
 * SendGrid sender. With EMAIL_SEND_MODE unset it refuses to run.
 */
import { and, eq, lte, sql } from 'drizzle-orm';
import { getDb } from '../../../config/database.js';
import { emailSends } from '../../../db/schema/index.js';
import { configuredSendMode } from '../lib/config.js';

export interface ProcessResult {
  refused?: 'send_mode_unset';
  sent: number;
}

export async function processQueue(opts: { now?: Date; limit?: number } = {}): Promise<ProcessResult> {
  const mode = configuredSendMode();
  if (!mode) return { refused: 'send_mode_unset', sent: 0 };
  const now = opts.now ?? new Date();
  const rows = await getDb()
    .update(emailSends)
    .set({ status: 'sent', sentAt: now, sendgridMessageId: sql`'stub-' || ${emailSends.id}`, updatedAt: now })
    .where(
      and(
        eq(emailSends.status, 'queued'),
        lte(emailSends.notBefore, now),
        sql`${emailSends.id} in (select id from email_sends where status = 'queued' and not_before <= ${now} order by not_before limit ${opts.limit ?? 50} for update skip locked)`,
      ),
    )
    .returning({ id: emailSends.id });
  return { sent: rows.length };
}

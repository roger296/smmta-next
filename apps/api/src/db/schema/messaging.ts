/**
 * Agent message drafts, approval queue, escalations, per-event config
 * (SPEC §13.5, §17). The message factory everything feeds.
 *
 * `message_drafts.id` doubles as the send idempotency key; `trigger_event_id`
 * makes every email traceable to its cause. §17.8 deltas (expires_at,
 * group_key, reject_reason, body_original) are included now per Prompt 2.
 * Enum style follows THE SPEC's text-enum.
 */
import { pgTable, uuid, text, boolean, integer, timestamp } from 'drizzle-orm/pg-core';
import { pk, companyId } from './common.js';
import { storefrontUsers } from './identity.js';
import { domainEvents } from './events.js';
import { chatSessions } from './chat.js';

export const messageDrafts = pgTable('message_drafts', {
  id: pk(), // doubles as send idempotency key
  companyId: companyId(),
  userId: uuid('user_id')
    .notNull()
    .references(() => storefrontUsers.id),
  triggerEventId: uuid('trigger_event_id').references(() => domainEvents.id), // full traceability
  channel: text('channel', { enum: ['email'] }).notNull().default('email'),
  category: text('category', { enum: ['transactional', 'marketing'] }).notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  status: text('status', {
    enum: ['pending', 'approved', 'auto_approved', 'rejected', 'sent', 'failed'],
  })
    .notNull()
    .default('pending'),
  editorNotes: text('editor_notes'),
  sendgridMessageId: text('sendgrid_message_id'),
  // ---- §17.8 deltas ----
  /** For time-sensitive drafts: expired → status failed(reason expired). */
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  /** trigger type + template hash → batch review of homogeneous groups (§17.4). */
  groupKey: text('group_key'),
  /** wrong_facts | wrong_tone | should_not_send | other (§17.5). */
  rejectReason: text('reject_reason', {
    enum: ['wrong_facts', 'wrong_tone', 'should_not_send', 'other', 'expired'],
  }),
  /** pre-edit copy, for the edit diff (§17.5). */
  bodyOriginal: text('body_original'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
});

/** Sales-agent escalations (escalate_to_human) — same inbox, different item
 *  type (§17.3, §17.8). */
export const escalations = pgTable('escalations', {
  id: pk(),
  companyId: companyId(),
  chatSessionId: uuid('chat_session_id').references(() => chatSessions.id),
  reason: text('reason', {
    enum: ['delivery_issue', 'refund_dispute', 'trade_account', 'product_advice_complex', 'other'],
  }).notNull(),
  summary: text('summary').notNull(),
  status: text('status', { enum: ['open', 'resolved'] }).notNull().default('open'),
  /**
   * The chat classifier's category, when the escalation came from the
   * pipeline rather than the older escalate_to_human tool. Kept separate
   * from `reason` because the two vocabularies don't map cleanly —
   * `complaint` could be a delivery_issue or a refund_dispute, and
   * flattening it into one loses what the classifier actually decided.
   * Null for escalations raised by the legacy tool path.
   */
  chatCategory: text('chat_category'),
  /** `high` jumps the queue in the sales@ mailbox. Complaints default to
   *  high; commercial enquiries escalate to high on a large stated value. */
  priority: text('priority', { enum: ['normal', 'high'] }).notNull().default('normal'),
  /** When the sales@ notification actually left SendGrid. Null means it
   *  was never sent — a sandboxed send, a missing API key, or a failure.
   *  Deliberately not defaulted to now(): a row claiming an email went
   *  out when it didn't is worse than an obviously-null column. */
  emailSentAt: timestamp('email_sent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
});

/**
 * Per-event-type agent config (§17.6, §17.8). `auto_send_enabled` graduates a
 * message type to auto-send once its approved-unedited rate is trusted. The
 * rolling stats are computable from `message_drafts`; this row caches the
 * toggle (and optionally the last-computed rate for display).
 */
export const agentConfig = pgTable('agent_config', {
  eventType: text('event_type').primaryKey(),
  companyId: companyId(),
  autoSendEnabled: boolean('auto_send_enabled').notNull().default(false),
  /** Basis points (0–10000) of the last-computed approved-unedited rate. */
  approvedUneditedRateBp: integer('approved_unedited_rate_bp'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

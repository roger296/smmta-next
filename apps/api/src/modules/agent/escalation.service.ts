/**
 * Escalation to a human.
 *
 * Two categories always escalate rather than being answered by a model:
 * commercial offers (trade, bulk, wholesale — founder-only territory)
 * and complaints (an AI-drafted apology on a real complaint is a legal
 * and reputational risk). Both are rule-based: no LLM call, a fixed
 * customer-facing acknowledgement, and an email to the operator.
 *
 * The honesty constraint that shapes this module: the customer is told
 * "someone will be in touch". If the email silently fails, that's a lie
 * we told on the store's behalf. So `emailSentAt` is written ONLY on a
 * genuinely delivered send — a sandboxed send (no API key, non-prod, or
 * SENDGRID_SANDBOX) leaves it null and logs loudly, so an operator
 * auditing the escalations table can see exactly which promises were
 * kept.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { escalations } from '../../db/schema/index.js';
import { getSendGrid } from '../../integrations/sendgrid/sendgrid.js';

export type EscalationPriority = 'normal' | 'high';
export type LegacyReason =
  | 'delivery_issue'
  | 'refund_dispute'
  | 'trade_account'
  | 'product_advice_complex'
  | 'other';

export interface EscalationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface EscalateInput {
  chatSessionId: string;
  /** Classifier category, or 'other' from the legacy tool path. */
  chatCategory: string;
  reason: LegacyReason;
  summary: string;
  priority?: EscalationPriority;
  /** Where to send it — chatbot_config.escalationEmail. */
  to: string;
  storeName: string;
  customerName?: string | null;
  customerEmail?: string | null;
  orderRef?: string | null;
  /** Last few turns for context, oldest first. */
  recentTurns?: EscalationTurn[];
}

export interface EscalateResult {
  escalationId: string;
  /** True only when the message genuinely left SendGrid. */
  emailSent: boolean;
}

/** How many prior turns to quote in the notification email. */
const CONTEXT_TURNS = 3;

/**
 * Values at or above this (in whole pounds, as stated by the customer)
 * bump a commercial enquiry to high priority. A heuristic on purpose:
 * getting a £5,000 enquiry in front of a human quickly is worth
 * occasionally promoting a smaller one.
 */
const HIGH_VALUE_GBP_THRESHOLD = 500;

/**
 * Pull the largest plausible money/quantity figure out of a message.
 * Handles "£5,000", "5000 units", "500 spools". Returns 0 when nothing
 * numeric is found.
 */
export function largestStatedValue(text: string): number {
  const matches = text.matchAll(/(?:£\s*)?(\d[\d,]*(?:\.\d+)?)\s*(k\b)?/gi);
  let max = 0;
  for (const m of matches) {
    const base = Number(m[1]!.replace(/,/g, ''));
    if (!Number.isFinite(base)) continue;
    const value = m[2] ? base * 1000 : base;
    if (value > max) max = value;
  }
  return max;
}

/** Default priority for a category, before any message-content bump. */
export function defaultPriorityFor(category: string, message: string): EscalationPriority {
  // A complaint is someone already unhappy — always jump the queue.
  if (category === 'complaint') return 'high';
  if (category === 'commercial_offer') {
    return largestStatedValue(message) >= HIGH_VALUE_GBP_THRESHOLD ? 'high' : 'normal';
  }
  return 'normal';
}

/** Map a classifier category onto the legacy `reason` enum, which
 *  predates the pipeline and is still what the approvals inbox reads. */
export function legacyReasonFor(category: string): LegacyReason {
  switch (category) {
    case 'commercial_offer':
      return 'trade_account';
    case 'complaint':
      return 'refund_dispute';
    case 'delivery_returns':
      return 'delivery_issue';
    case 'product_advice':
      return 'product_advice_complex';
    default:
      return 'other';
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Build the operator notification. Plain-ish HTML — this goes to a
 *  mailbox a person reads, not a marketing inbox. */
export function buildEscalationEmail(input: EscalateInput, escalationId: string): {
  subject: string;
  html: string;
} {
  const priority = input.priority ?? 'normal';
  const subject = `[chat · ${input.chatCategory} · ${priority}] ${input.summary.slice(0, 80)}`;

  const turns = (input.recentTurns ?? []).slice(-CONTEXT_TURNS);
  const transcript = turns.length
    ? turns
        .map(
          (t) =>
            `<p style="margin:0 0 8px"><strong>${t.role === 'user' ? 'Customer' : 'Assistant'}:</strong> ${escapeHtml(
              t.content,
            )}</p>`,
        )
        .join('')
    : '<p style="margin:0;color:#666">(no prior turns)</p>';

  const row = (label: string, value: string) =>
    `<tr><td style="padding:2px 12px 2px 0;color:#666">${label}</td><td style="padding:2px 0"><strong>${escapeHtml(
      value,
    )}</strong></td></tr>`;

  const html = `
<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.5;color:#1b1d22">
  <h2 style="margin:0 0 4px;font-size:18px">Chat escalation — ${escapeHtml(input.chatCategory)}</h2>
  <p style="margin:0 0 16px;color:#666">${escapeHtml(input.storeName)}</p>

  <table style="border-collapse:collapse;margin-bottom:16px">
    ${row('Category', input.chatCategory)}
    ${row('Priority', priority)}
    ${row('Customer', input.customerName || 'anonymous')}
    ${input.customerEmail ? row('Email', input.customerEmail) : ''}
    ${input.orderRef ? row('Order', input.orderRef) : ''}
    ${row('Escalation', escalationId)}
  </table>

  <h3 style="margin:0 0 6px;font-size:14px">Summary</h3>
  <p style="margin:0 0 16px">${escapeHtml(input.summary)}</p>

  <h3 style="margin:0 0 6px;font-size:14px">Last ${turns.length} turn${turns.length === 1 ? '' : 's'}</h3>
  <div style="border-left:2px solid #ddd;padding-left:12px">${transcript}</div>
</div>`.trim();

  return { subject, html };
}

export class EscalationService {
  private db = getDb();
  private companyId = getSingletonCompanyId();

  /**
   * Record the escalation and notify the operator. Never throws — a
   * failed email must not turn into a failed chat turn, because the
   * customer's message is already worth keeping. The returned
   * `emailSent` tells the caller whether the promise was actually kept.
   */
  async escalate(input: EscalateInput): Promise<EscalateResult> {
    const [row] = await this.db
      .insert(escalations)
      .values({
        companyId: this.companyId,
        chatSessionId: input.chatSessionId,
        reason: input.reason,
        chatCategory: input.chatCategory,
        summary: input.summary,
        priority: input.priority ?? 'normal',
      })
      .returning({ id: escalations.id });
    const escalationId = row!.id;

    let emailSent = false;
    try {
      const { subject, html } = buildEscalationEmail(input, escalationId);
      const result = await getSendGrid().send({
        to: input.to,
        category: 'transactional',
        subject,
        html,
        // The escalation id is a natural idempotency key: one row, one
        // notification, even if a retry re-enters here.
        idempotencyKey: `escalation:${escalationId}`,
      });
      // Sandboxed means SendGrid accepted it but delivered nothing.
      // Treat that as not-sent so the column stays honest.
      emailSent = !result.sandboxed;
      if (emailSent) {
        await this.db
          .update(escalations)
          .set({ emailSentAt: new Date() })
          .where(eq(escalations.id, escalationId));
      }
    } catch {
      // Swallowed deliberately: the row is already saved, so the
      // escalation isn't lost even though the notification failed.
      // emailSentAt stays null, which is the signal to look here.
      emailSent = false;
    }

    return { escalationId, emailSent };
  }
}

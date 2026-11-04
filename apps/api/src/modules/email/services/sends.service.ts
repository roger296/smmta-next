/**
 * enqueueSend — how anything asks for an email (runbook section 3). It runs
 * the gate, then writes one `email_sends` row: `queued` for the sender to
 * pick up, or `dropped` with the gate's reason. Idempotent on the key: asking
 * twice returns the first row.
 *
 * Nothing in this file talks to SendGrid; the sender job does (section 6),
 * and re-runs the gate at send time because consent can change in between.
 */
import { and, desc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import { getDb } from '../../../config/database.js';
import { getSingletonCompanyId } from '../../../shared/auth/company.js';
import { emailSends, type EmailClass } from '../../../db/schema/index.js';
import { canSend, type GateReason } from '../lib/gate.js';
import type { Executor } from '../lib/db.js';
import { ContactsService, type Contact } from './contacts.service.js';
import { getEmailSettings } from './settings.service.js';
import type { EmailSettings } from '../lib/settings-defaults.js';

export type EmailSend = typeof emailSends.$inferSelect;

export interface EnqueueInput {
  contactId: string;
  class: EmailClass;
  kind: string;
  templateKey: string;
  data?: Record<string, unknown>;
  campaignId?: string | null;
  idempotencyKey: string;
  /** Not sent before this time (send window spread, roll-ups). */
  notBefore?: Date;
  variant?: string | null;
  overrideGap?: boolean;
  now?: Date;
}

export interface EnqueueResult {
  send: EmailSend;
  /** False when the key already existed and the earlier row was returned. */
  created: boolean;
  dropped?: GateReason;
}

/** Marketing sends in a row, newest first, with no click and no order after
 *  them (opens do not count). */
export async function unengagedStreak(contact: Pick<Contact, 'id' | 'lastOrderAt'>, limit = 6, ex: Executor = getDb()): Promise<number> {
  const recent = await ex
    .select({ sentAt: emailSends.sentAt, firstClickAt: emailSends.firstClickAt })
    .from(emailSends)
    .where(and(eq(emailSends.contactId, contact.id), eq(emailSends.class, 'marketing'), isNotNull(emailSends.sentAt)))
    .orderBy(desc(emailSends.sentAt))
    .limit(limit);
  let streak = 0;
  for (const s of recent) {
    if (s.firstClickAt) break;
    if (contact.lastOrderAt && s.sentAt && contact.lastOrderAt > s.sentAt) break;
    streak++;
  }
  return streak;
}

export class SendsService {
  private contacts = new ContactsService();

  async enqueue(input: EnqueueInput, ex: Executor = getDb(), settingsIn?: EmailSettings): Promise<EnqueueResult> {
    const existing = await this.byKey(input.idempotencyKey, ex);
    if (existing) return { send: existing, created: false };

    const now = input.now ?? new Date();
    const contact = await this.contacts.get(input.contactId, ex);
    if (!contact) throw new Error(`enqueueSend: contact ${input.contactId} not found`);
    const settings = settingsIn ?? (await getEmailSettings());
    const verdict = canSend(contact, {
      class: input.class,
      kind: input.kind,
      now,
      settings,
      overrideGap: input.overrideGap,
      unengagedStreak: input.class === 'marketing' ? await unengagedStreak(contact, settings.unengaged_limit, ex) : 0,
    });

    const [row] = await ex
      .insert(emailSends)
      .values({
        companyId: getSingletonCompanyId(),
        campaignId: input.campaignId ?? null,
        contactId: contact.id,
        class: input.class,
        kind: input.kind,
        templateKey: input.templateKey,
        data: input.data ?? {},
        variant: input.variant ?? null,
        idempotencyKey: input.idempotencyKey,
        status: verdict.ok ? 'queued' : 'dropped',
        dropReason: verdict.ok ? null : verdict.reason,
        notBefore: input.notBefore ?? now,
        queuedAt: now,
      })
      .onConflictDoNothing({ target: emailSends.idempotencyKey })
      .returning();
    if (!row) {
      const raced = await this.byKey(input.idempotencyKey, ex);
      return { send: raced!, created: false };
    }
    return { send: row, created: true, dropped: verdict.ok ? undefined : verdict.reason };
  }

  async byKey(key: string, ex: Executor = getDb()): Promise<EmailSend | undefined> {
    const [row] = await ex.select().from(emailSends).where(eq(emailSends.idempotencyKey, key)).limit(1);
    return row;
  }

  async get(id: string, ex: Executor = getDb()): Promise<EmailSend | undefined> {
    const [row] = await ex.select().from(emailSends).where(eq(emailSends.id, id)).limit(1);
    return row;
  }

  /** A contact's queued send of this kind that is still waiting (not_before
   *  in the future), for roll-ups to join. */
  async waitingSend(contactId: string, kind: string, now: Date, ex: Executor = getDb()): Promise<EmailSend | undefined> {
    const [row] = await ex
      .select()
      .from(emailSends)
      .where(
        and(
          eq(emailSends.contactId, contactId),
          eq(emailSends.kind, kind),
          eq(emailSends.status, 'queued'),
          gt(emailSends.notBefore, now),
        ),
      )
      .orderBy(emailSends.notBefore)
      .limit(1);
    return row;
  }

  /** Merge items into a waiting send's `data.items`, only while it is still
   *  queued (the sender may claim it at any moment). True when merged. */
  async appendItems(sendId: string, items: Array<Record<string, unknown>>, ex: Executor = getDb()): Promise<boolean> {
    const res = await ex
      .update(emailSends)
      .set({
        data: sql`jsonb_set(${emailSends.data}, '{items}', coalesce(${emailSends.data}->'items', '[]'::jsonb) || ${JSON.stringify(items)}::jsonb)`,
        updatedAt: new Date(),
      })
      .where(and(eq(emailSends.id, sendId), eq(emailSends.status, 'queued')))
      .returning({ id: emailSends.id });
    return res.length > 0;
  }

  async countByStatus(ids: string[], ex: Executor = getDb()) {
    if (ids.length === 0) return [];
    return ex
      .select({ status: emailSends.status, n: sql<number>`count(*)::int` })
      .from(emailSends)
      .where(inArray(emailSends.id, ids))
      .groupBy(emailSends.status);
  }
}

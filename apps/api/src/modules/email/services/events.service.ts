/**
 * SendGrid event processing (spec § Sending pipeline → Webhook). Every event
 * is stored once in `email_events` (keyed on `sg_event_id`, duplicates
 * ignored), matched to its send through the `send_id` custom arg, and applied:
 *
 *   processed            → sent
 *   deferred             → deferred; the third deferral of one send counts as a soft bounce
 *   delivered            → delivered; clears the contact's soft-bounce count
 *   bounce (bounce)      → bounced; contact hard_bounce
 *   bounce (blocked)     → bounced; contact soft bounce (3 in 30 days = hard)
 *   dropped              → dropped; an invalid address marks the contact invalid
 *   open                 → opened (first only); last_open_at
 *   click                → clicked (first only); last_click_at; +2 interest for the link's keys
 *   spamreport           → complained; contact complained + transactional_only (consent event)
 *   unsubscribe / group_unsubscribe → unsubscribed; transactional_only, as a link unsubscribe
 *
 * An event with no send of ours (mail from elsewhere on the account, such as
 * the storefront's order emails) still updates the contact found by address,
 * so a bounce anywhere protects the address everywhere. Unknown send ids are
 * stored, never rejected.
 */
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../../../config/database.js';
import { getSingletonCompanyId } from '../../../shared/auth/company.js';
import { emailContacts, emailEvents, emailSends, type SendStatus } from '../../../db/schema/index.js';
import { normaliseEmail } from '../lib/normalise.js';
import { ContactsService, type Contact } from './contacts.service.js';
import { getEmailSettings } from './settings.service.js';
import type { EmailSend } from './sends.service.js';

export interface SendGridEvent {
  email?: string;
  event?: string;
  sg_event_id?: string;
  sg_message_id?: string;
  timestamp?: number;
  type?: string; // bounce | blocked
  reason?: string;
  url?: string;
  send_id?: string;
  [k: string]: unknown;
}

/** How far along a send is; a later event never moves it back. */
const RANK: Record<SendStatus, number> = {
  queued: 0,
  sent: 1,
  deferred: 2,
  delivered: 3,
  opened: 4,
  clicked: 5,
  bounced: 6,
  dropped: 6,
  unsubscribed: 7,
  complained: 8,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Interest keys a clicked link carries (`ik=material:pla,category:…`). */
export function interestKeysFromUrl(url: string | undefined): string[] {
  if (!url) return [];
  try {
    const u = new URL(url);
    const keys = (u.searchParams.get('ik') ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter((k) => /^(material|category):[a-z0-9-]+$/i.test(k));
    const cid = u.searchParams.get('cid');
    if (cid && UUID.test(cid)) keys.push(`category:${cid}`);
    return [...new Set(keys)];
  } catch {
    return [];
  }
}

export interface IngestResult {
  received: number;
  stored: number;
  duplicates: number;
  unmatched: number;
}

export class EventsService {
  private contacts = new ContactsService();

  async ingest(events: SendGridEvent[]): Promise<IngestResult> {
    const result: IngestResult = { received: events.length, stored: 0, duplicates: 0, unmatched: 0 };
    const settings = await getEmailSettings();
    for (const e of events) {
      if (!e.event) continue;
      const sgEventId = e.sg_event_id ?? `${e.sg_message_id ?? 'none'}:${e.event}:${e.timestamp ?? ''}:${e.email ?? ''}`;
      const send = e.send_id && UUID.test(e.send_id) ? await this.send(e.send_id) : undefined;
      const [stored] = await getDb()
        .insert(emailEvents)
        .values({
          companyId: getSingletonCompanyId(),
          sendId: send?.id ?? null,
          sgEventId,
          event: e.event.slice(0, 40),
          payload: e as Record<string, unknown>,
          occurredAt: e.timestamp ? new Date(e.timestamp * 1000) : null,
        })
        .onConflictDoNothing({ target: emailEvents.sgEventId })
        .returning({ id: emailEvents.id });
      if (!stored) {
        result.duplicates++;
        continue;
      }
      result.stored++;
      if (!send) result.unmatched++;

      const contact = send
        ? await this.contacts.get(send.contactId)
        : e.email
          ? await this.contacts.getByEmail(normaliseEmail(e.email))
          : undefined;
      await this.apply(e, send, contact, settings.soft_bounce_window_days, settings.interest_decay.click_points);
    }
    return result;
  }

  private async send(id: string): Promise<EmailSend | undefined> {
    const [row] = await getDb().select().from(emailSends).where(eq(emailSends.id, id)).limit(1);
    return row;
  }

  private async advance(send: EmailSend | undefined, status: SendStatus, extra: Partial<typeof emailSends.$inferInsert> = {}) {
    if (!send) return;
    const patch: Partial<typeof emailSends.$inferInsert> = { ...extra, updatedAt: new Date() };
    if (RANK[status] > RANK[send.status]) patch.status = status;
    await getDb().update(emailSends).set(patch).where(eq(emailSends.id, send.id));
  }

  private async apply(
    e: SendGridEvent,
    send: EmailSend | undefined,
    contact: Contact | undefined,
    windowDays: number,
    clickPoints: number,
  ): Promise<void> {
    const at = e.timestamp ? new Date(e.timestamp * 1000) : new Date();
    const db = getDb();
    switch (e.event) {
      case 'processed':
        await this.advance(send, 'sent');
        return;
      case 'deferred': {
        await this.advance(send, 'deferred');
        if (send && contact) {
          const [{ n } = { n: 0 }] = await db
            .select({ n: sql<number>`count(*)::int` })
            .from(emailEvents)
            .where(and(eq(emailEvents.sendId, send.id), eq(emailEvents.event, 'deferred')));
          if (n === 3) await this.contacts.recordDeliverability(contact.id, 'soft_bounce', at, windowDays);
        }
        return;
      }
      case 'delivered':
        await this.advance(send, 'delivered', send && !send.deliveredAt ? { deliveredAt: at } : {});
        if (contact) await this.contacts.recordDeliverability(contact.id, 'delivered', at, windowDays);
        return;
      case 'bounce': {
        await this.advance(send, 'bounced', { error: e.reason?.slice(0, 1000) ?? null });
        if (contact) {
          await this.contacts.recordDeliverability(contact.id, e.type === 'blocked' ? 'soft_bounce' : 'hard_bounce', at, windowDays);
        }
        return;
      }
      case 'dropped': {
        await this.advance(send, 'dropped', { dropReason: 'provider_dropped', error: e.reason?.slice(0, 1000) ?? null });
        if (contact && /invalid/i.test(e.reason ?? '')) await this.contacts.recordDeliverability(contact.id, 'invalid', at);
        return;
      }
      case 'open':
        await this.advance(send, 'opened', send && !send.firstOpenAt ? { firstOpenAt: at } : {});
        if (contact) await db.update(emailContacts).set({ lastOpenAt: at }).where(eq(emailContacts.id, contact.id));
        return;
      case 'click': {
        await this.advance(send, 'clicked', send && !send.firstClickAt ? { firstClickAt: at } : {});
        if (contact) {
          await db.update(emailContacts).set({ lastClickAt: at }).where(eq(emailContacts.id, contact.id));
          const keys = interestKeysFromUrl(e.url);
          if (keys.length) await this.contacts.addInterest(contact.id, keys, clickPoints, at);
        }
        return;
      }
      case 'spamreport':
        await this.advance(send, 'complained');
        if (contact) {
          await this.contacts.recordDeliverability(contact.id, 'complained', at);
          await this.downgrade(contact, 'complaint_webhook', 'system', 'spam complaint');
        }
        return;
      case 'unsubscribe':
      case 'group_unsubscribe':
        await this.advance(send, 'unsubscribed');
        if (contact) await this.downgrade(contact, 'link', 'person', 'unsubscribed through SendGrid');
        return;
      default:
        return;
    }
  }

  private async downgrade(contact: Contact, source: string, actor: string, reason: string) {
    if (contact.marketingStatus !== 'all') return;
    await this.contacts.setMarketingStatus(contact.id, 'transactional_only', { source, actor, reason });
  }
}

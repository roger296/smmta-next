/**
 * Back in stock on the shared pipeline (spec § Campaign types → Back in
 * stock; runbook section 3). The existing NotifyMeService still decides who
 * is due (FIFO, capped at free stock); this sender turns each due request
 * into an `email_sends` row of class requested_service through the gate,
 * instead of calling the storefront's email route.
 *
 * Rules:
 *  - One email per request: the send's idempotency key is `bis:<requestId>`,
 *    and the request closes when its send is queued (or dropped by the gate).
 *  - A contact who was sent a back-in-stock email for the same product in the
 *    last 24 hours is not sent another; the request stays open and the daily
 *    re-check sends it once the 24 hours are up.
 *  - A contact with only this one request open is sent straight away. A
 *    contact with other requests open gets one roll-up at 09:00 UK listing
 *    every item that came back since — not one email per item.
 *  - Open requests close after 180 days without a send.
 */
import { and, eq, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { getDb } from '../../../config/database.js';
import { getSingletonCompanyId } from '../../../shared/auth/company.js';
import { emailSends, stockNotifications } from '../../../db/schema/index.js';
import type { NotifyMeSendPayload, NotifyMeSender } from '../../storefront/notify-me.service.js';
import { NotifyMeService } from '../../storefront/notify-me.service.js';
import { nextLocalTime } from '../lib/gate.js';
import { ContactsService } from './contacts.service.js';
import { SendsService } from './sends.service.js';

const DAY_MS = 86_400_000;
export const BIS_ROLLUP_TIME = '09:00';
export const BIS_REQUEST_TTL_DAYS = 180;

/** Thrown to leave a request open for a later attempt. */
export class BackInStockDeferred extends Error {}

export interface BackInStockItem {
  requestId: string;
  productId: string;
  productName: string;
  productSlug: string | null;
  productImageUrl: string | null;
  priceGbp: string | null;
  colour: string | null;
}

export class GateNotifyMeSender implements NotifyMeSender {
  private contacts = new ContactsService();
  private sends = new SendsService();

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async send(payload: NotifyMeSendPayload): Promise<void> {
    const db = getDb();
    const now = this.clock();
    const requestId = payload.requestId;
    if (!requestId) throw new Error('back-in-stock send without a request id');

    const { contact } = await this.contacts.findOrCreateByEmail(payload.email, {
      source: 'back_in_stock_form',
    });
    await db
      .update(stockNotifications)
      .set({ contactId: contact.id })
      .where(and(eq(stockNotifications.id, requestId), isNull(stockNotifications.contactId)));

    // Already told about this product in the last 24 hours (it sold out and
    // came back): leave the request open for the daily re-check.
    const [recent] = await db
      .select({ id: emailSends.id })
      .from(emailSends)
      .where(
        and(
          eq(emailSends.contactId, contact.id),
          eq(emailSends.kind, 'back_in_stock'),
          ne(emailSends.status, 'dropped'),
          sql`${emailSends.queuedAt} > ${new Date(now.getTime() - DAY_MS)}`,
          sql`${emailSends.data}->'items' @> ${JSON.stringify([{ productId: payload.productId }])}::jsonb`,
        ),
      )
      .limit(1);
    if (recent) throw new BackInStockDeferred('notified about this product in the last 24 hours');

    const item: BackInStockItem = {
      requestId,
      productId: payload.productId,
      productName: payload.productName,
      productSlug: payload.productSlug,
      productImageUrl: payload.productImageUrl,
      priceGbp: payload.priceGbp,
      colour: payload.colour,
    };

    const [{ others } = { others: 0 }] = await db
      .select({ others: sql<number>`count(*)::int` })
      .from(stockNotifications)
      .where(
        and(
          sql`lower(${stockNotifications.email}) = ${contact.email}`,
          isNull(stockNotifications.fulfilledAt),
          isNull(stockNotifications.deletedAt),
          ne(stockNotifications.id, requestId),
        ),
      );

    let sendId: string;
    const waiting = await this.sends.waitingSend(contact.id, 'back_in_stock', now);
    if (waiting && (await this.sends.appendItems(waiting.id, [item as unknown as Record<string, unknown>]))) {
      sendId = waiting.id;
    } else {
      const { send } = await this.sends.enqueue({
        contactId: contact.id,
        class: 'requested_service',
        kind: 'back_in_stock',
        templateKey: 'back_in_stock',
        idempotencyKey: `bis:${requestId}`,
        data: { items: [item] },
        notBefore: others > 0 ? nextLocalTime(now, BIS_ROLLUP_TIME, 'Europe/London') : now,
        now,
      });
      sendId = send.id;
    }
    await db.update(stockNotifications).set({ emailSendId: sendId }).where(eq(stockNotifications.id, requestId));
  }
}

export class BackInStockService {
  private notifyMe = new NotifyMeService();

  constructor(private readonly sender: NotifyMeSender = new GateNotifyMeSender()) {}

  /** Daily: send whatever is due — products with open requests and free
   *  stock, including requests held back by the 24-hour rule and stock that
   *  arrived other than through a goods-received note. */
  async recheckOpenRequests(): Promise<number> {
    const products = await getDb()
      .selectDistinct({ productId: stockNotifications.productId })
      .from(stockNotifications)
      .where(and(isNull(stockNotifications.fulfilledAt), isNull(stockNotifications.deletedAt)));
    let sent = 0;
    for (const p of products) {
      sent += await this.notifyMe.fulfilForProduct(getSingletonCompanyId(), p.productId, this.sender);
    }
    return sent;
  }

  /** Nightly: close requests open for more than 180 days, without sending. */
  async closeStale(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - BIS_REQUEST_TTL_DAYS * DAY_MS);
    const rows = await getDb()
      .update(stockNotifications)
      .set({ deletedAt: now, closeReason: 'expired', updatedAt: now })
      .where(
        and(
          isNull(stockNotifications.fulfilledAt),
          isNull(stockNotifications.deletedAt),
          lt(stockNotifications.requestedAt, cutoff),
        ),
      )
      .returning({ id: stockNotifications.id });
    return rows.length;
  }

  /** For reports: the requests a send carried. */
  async requestsForSend(sendId: string): Promise<string[]> {
    const rows = await getDb()
      .select({ id: stockNotifications.id })
      .from(stockNotifications)
      .where(inArray(stockNotifications.emailSendId, [sendId]));
    return rows.map((r) => r.id);
  }
}

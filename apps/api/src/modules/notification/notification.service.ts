/**
 * Notification agent (SPEC F6, §12.4). The proactive layer: reactions to domain
 * events that compose personalised customer messages (through the same compose
 * pipeline + approval queue) and the swap-at-locked-price flow. Boring code
 * detects the condition; the LLM only drafts.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import {
  domainEvents,
  interestFlags,
  messageDrafts,
  preorderOrders,
  preorderOrderLines,
  products,
  stockItems,
} from '../../db/schema/index.js';
import { ComposeService } from '../messaging/compose.service.js';
import { InboundService } from '../inbound/inbound.service.js';

const DAY_MS = 86_400_000;

export class NotificationService {
  private db = getDb();
  private companyId = getSingletonCompanyId();
  private compose: ComposeService;
  private inbound = new InboundService();

  constructor(compose?: ComposeService) {
    this.compose = compose ?? new ComposeService();
  }

  private async eventPayload(eventId: string): Promise<Record<string, unknown> | undefined> {
    const [row] = await this.db
      .select({ payload: domainEvents.payload })
      .from(domainEvents)
      .where(eq(domainEvents.id, eventId))
      .limit(1);
    return row?.payload as Record<string, unknown> | undefined;
  }

  private async draftExistsForGroup(groupKey: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: messageDrafts.id })
      .from(messageDrafts)
      .where(and(eq(messageDrafts.companyId, this.companyId), eq(messageDrafts.groupKey, groupKey)))
      .limit(1);
    return !!row;
  }

  /**
   * back-in-stock-fanout (§12.3): on stock.replenished, compose for every active
   * restock watcher of that SKU under a shared group_key (§17.4 batch review),
   * then clear the flags. (Cleared at compose time rather than on message.sent —
   * logged deviation; the partial unique index lets a customer re-enrol.)
   */
  async backInStockFanout(eventId: string): Promise<number> {
    const payload = await this.eventPayload(eventId);
    const sku = payload?.sku as string | undefined;
    if (!sku) return 0;
    const flags = await this.db
      .select()
      .from(interestFlags)
      .where(
        and(
          eq(interestFlags.companyId, this.companyId),
          eq(interestFlags.sku, sku),
          eq(interestFlags.flagType, 'restock'),
          isNull(interestFlags.clearedAt),
        ),
      );
    const groupKey = `back_in_stock:${sku}`;
    for (const flag of flags) {
      await this.compose.compose({
        userId: flag.userId,
        templateKey: 'back_in_stock',
        triggerEventId: eventId,
        groupKey,
        facts: { sku },
      });
      await this.db.update(interestFlags).set({ clearedAt: new Date() }).where(eq(interestFlags.id, flag.id));
    }
    return flags.length;
  }

  /**
   * shipment.eta_changed (worse): notify each affected pre-order customer with
   * the wait/swap/refund options. Idempotent per (order, new ETA value).
   */
  async reactEtaChanged(eventId: string, thresholdDays = 2): Promise<number> {
    const payload = await this.eventPayload(eventId);
    const shipmentId = payload?.shipmentId as string | undefined;
    const oldEta = payload?.oldEta ? Date.parse(String(payload.oldEta)) : undefined;
    const newEta = payload?.newEta ? Date.parse(String(payload.newEta)) : undefined;
    if (!shipmentId || oldEta == null || newEta == null) return 0;
    if ((newEta - oldEta) / DAY_MS <= thresholdDays) return 0; // not a material worsening

    const orders = await this.db
      .selectDistinct({ orderId: preorderOrders.id, userId: preorderOrders.userId })
      .from(preorderOrderLines)
      .innerJoin(preorderOrders, eq(preorderOrderLines.orderId, preorderOrders.id))
      .where(
        and(
          eq(preorderOrderLines.shipmentId, shipmentId),
          sql`${preorderOrders.status} IN ('awaiting_payment','paid')`,
        ),
      );

    let count = 0;
    for (const o of orders) {
      const groupKey = `eta_slip:${o.orderId}:${newEta}`;
      if (await this.draftExistsForGroup(groupKey)) continue; // idempotent per (order, eta)
      await this.compose.compose({
        userId: o.userId,
        templateKey: 'eta_slip',
        triggerEventId: eventId,
        groupKey,
        facts: {
          orderId: o.orderId,
          oldEta: new Date(oldEta).toISOString(),
          newEta: new Date(newEta).toISOString(),
          options: ['wait', 'swap_at_locked_price', 'refund'],
        },
      });
      count++;
    }
    return count;
  }

  /** consent.revoked / suppression.updated → cancel that user's queued/pending
   *  marketing drafts (§12.4). Returns the number cancelled. */
  async cancelDraftsForUser(userId: string): Promise<number> {
    const rows = await this.db
      .update(messageDrafts)
      .set({ status: 'failed', rejectReason: 'should_not_send', resolvedAt: new Date() })
      .where(
        and(
          eq(messageDrafts.companyId, this.companyId),
          eq(messageDrafts.userId, userId),
          eq(messageDrafts.category, 'marketing'),
          sql`${messageDrafts.status} IN ('pending','approved','auto_approved')`,
        ),
      )
      .returning({ id: messageDrafts.id });
    return rows.length;
  }

  /**
   * Swap a pre-order line to warehouse stock at the LOCKED £ price (§12.4).
   * Releases the presale allocation and consumes warehouse stock; the money
   * (locked unit price) is unchanged, so stock and money both conserve.
   */
  async swapToWarehouse(orderId: string, lineId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [line] = await tx
        .select()
        .from(preorderOrderLines)
        .where(and(eq(preorderOrderLines.id, lineId), eq(preorderOrderLines.orderId, orderId)))
        .for('update');
      if (!line) throw new Error('line not found');
      if (line.poolRef === 'warehouse') return; // already swapped

      // Consume warehouse stock for the SKU's product.
      const [product] = await tx
        .select({ id: products.id })
        .from(products)
        .where(and(eq(products.companyId, this.companyId), eq(products.stockCode, line.sku)))
        .limit(1);
      if (!product) throw new Error('product not found');

      const picked = await tx.execute(sql`
        SELECT id FROM stock_items
        WHERE product_id = ${product.id} AND status = 'IN_STOCK'
        ORDER BY created_at ASC
        LIMIT ${line.qty}
        FOR UPDATE SKIP LOCKED`);
      const ids = (picked.rows as Array<{ id: string }>).map((r) => r.id);
      if (ids.length < line.qty) throw new Error('insufficient warehouse stock to swap');
      await tx
        .update(stockItems)
        .set({ status: 'ALLOCATED', updatedAt: new Date() })
        .where(inArray(stockItems.id, ids));

      // Release the presale allocation on the shipment.
      await this.inbound.releasePresaleTx(tx, line.shipmentId, line.sku, line.qty);

      // Repoint the line to warehouse; keep the locked price (money conserved).
      await tx.update(preorderOrderLines).set({ poolRef: 'warehouse' }).where(eq(preorderOrderLines.id, lineId));
    });
  }
}

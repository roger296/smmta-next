/**
 * Pre-order payment flow (SPEC §16). Creates a bank-only-or-full order against
 * unarrived shipment stock, LOCKING the pre-order band + £ savings onto each
 * line at order time (§15.2). Handles the manual-transfer window (overdue day 3,
 * lapse day 5 → release presale), the thin Mollie webhook normalisation
 * (idempotent), admin mark-paid, and cancel-before-dispatch.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, lte } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import {
  preorderOrders,
  preorderOrderLines,
  inboundShipments,
  pricingRules,
} from '../../db/schema/index.js';
import { emitDomainEvent } from '../../shared/events/emit.js';
import { InboundService } from '../inbound/inbound.service.js';
import { PricingService } from '../pricing/pricing.service.js';
import { getMollie } from '../../integrations/mollie/index.js';
import { isBankOnlyOrder, isMethodAllowed } from './payment-rules.js';

const DAY_MS = 86_400_000;
const OVERDUE_DAYS = 3;
const LAPSE_DAYS = 5;

export class PaymentMethodNotAllowedError extends Error {}

export interface PreorderItem {
  sku: string;
  qty: number;
  poolRef: string; // inbound shipment reference
}

export interface CreatePreorderInput {
  userId: string;
  items: PreorderItem[];
  paymentMethod?: 'bank' | 'manual_transfer' | 'card' | 'wallet' | 'paypal';
  nowMs?: number;
}

export class PreorderService {
  private db = getDb();
  private companyId = getSingletonCompanyId();
  private inbound = new InboundService();
  private pricing = new PricingService();

  private async bankOnlyEtaDays(): Promise<number> {
    const [rule] = await this.db
      .select({ d: pricingRules.bankOnlyEtaDays })
      .from(pricingRules)
      .where(and(eq(pricingRules.companyId, this.companyId), isNull(pricingRules.category)))
      .limit(1);
    return rule?.d ?? 30;
  }

  async createPreorder(input: CreatePreorderInput) {
    const nowMs = input.nowMs ?? Date.now();
    const bankOnlyDays = await this.bankOnlyEtaDays();

    // Resolve each item: shipment, days-to-ETA, and a LOCKED quote.
    const resolved = [] as Array<{
      shipmentId: string;
      poolRef: string;
      sku: string;
      qty: number;
      daysToEta: number;
      lockedUnitPricePence: number;
      lockedBandBp: number;
      lockedSavingPence: number;
    }>;

    for (const item of input.items) {
      const [ship] = await this.db
        .select({ id: inboundShipments.id, eta: inboundShipments.eta, arrivedAt: inboundShipments.arrivedAt })
        .from(inboundShipments)
        .where(
          and(eq(inboundShipments.companyId, this.companyId), eq(inboundShipments.reference, item.poolRef)),
        )
        .limit(1);
      if (!ship || ship.arrivedAt) throw new Error(`pool ${item.poolRef} unavailable`);
      const daysToEta = Math.ceil((ship.eta.getTime() - nowMs) / DAY_MS);
      const quote = await this.pricing.quote({ sku: item.sku, qty: item.qty, pool: item.poolRef, nowMs });
      resolved.push({
        shipmentId: ship.id,
        poolRef: item.poolRef,
        sku: item.sku,
        qty: item.qty,
        daysToEta,
        lockedUnitPricePence: quote.unitPricePence,
        lockedBandBp: quote.preorderDiscountBpInternal,
        lockedSavingPence: quote.savingsVsBasePence,
      });
    }

    const bankOnly = isBankOnlyOrder(resolved.map((r) => ({ daysToEta: r.daysToEta })), bankOnlyDays);
    const method = input.paymentMethod ?? (bankOnly ? 'manual_transfer' : 'card');
    if (!isMethodAllowed(mapMethod(method), resolved.map((r) => ({ daysToEta: r.daysToEta })), bankOnlyDays)) {
      throw new PaymentMethodNotAllowedError(
        `payment method ${method} is not allowed on a >${bankOnlyDays}-day pre-order (bank only)`,
      );
    }

    const totalPence = resolved.reduce((s, r) => s + r.lockedUnitPricePence * r.qty, 0);
    const paymentReference = `PO-${randomUUID().slice(0, 8).toUpperCase()}`;

    const order = await this.db.transaction(async (tx) => {
      // Allocate presale atomically with the order write.
      for (const r of resolved) {
        await this.inbound.allocatePresaleTx(tx, r.shipmentId, r.sku, r.qty);
      }
      const [o] = await tx
        .insert(preorderOrders)
        .values({
          companyId: this.companyId,
          userId: input.userId,
          status: 'awaiting_payment',
          paymentMethod: method,
          paymentReference,
          totalPence,
        })
        .returning();
      await tx.insert(preorderOrderLines).values(
        resolved.map((r) => ({
          companyId: this.companyId,
          orderId: o!.id,
          shipmentId: r.shipmentId,
          poolRef: r.poolRef,
          sku: r.sku,
          qty: r.qty,
          lockedUnitPricePence: r.lockedUnitPricePence,
          lockedBandBp: r.lockedBandBp,
          lockedSavingPence: r.lockedSavingPence,
        })),
      );
      await emitDomainEvent(tx, {
        eventType: 'order.placed',
        aggregateType: 'order',
        aggregateId: o!.id,
        payload: { orderId: o!.id, kind: 'preorder', totalPence, method, bankOnly },
      });
      await emitDomainEvent(tx, {
        eventType: 'order.awaiting_payment',
        aggregateType: 'order',
        aggregateId: o!.id,
        payload: { orderId: o!.id, paymentReference, method },
      });
      return o!;
    });

    // For non-manual methods, open a Mollie payment (fake in dev/test),
    // restricting to bank methods on a >30-day order.
    if (method !== 'manual_transfer') {
      const payment = await getMollie().createPayment({
        amountPence: totalPence,
        description: `Pre-order ${paymentReference}`,
        methods: bankOnly ? ['banktransfer'] : undefined,
        metadata: { kind: 'preorder', orderId: order.id },
      });
      await this.db
        .update(preorderOrders)
        .set({ molliePaymentId: payment.id })
        .where(eq(preorderOrders.id, order.id));
      return { ...order, molliePaymentId: payment.id };
    }
    return order;
  }

  /** Admin "mark paid" for a manual transfer (Luca reconciliation is the future
   *  automation). Idempotent — a second call is a no-op. Emits
   *  order.payment_received → order.paid. */
  async markPaid(orderId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(preorderOrders)
        .where(eq(preorderOrders.id, orderId))
        .for('update');
      if (!order || order.status === 'paid') return; // idempotent
      await tx
        .update(preorderOrders)
        .set({ status: 'paid', paidAt: new Date() })
        .where(eq(preorderOrders.id, orderId));
      await emitDomainEvent(tx, {
        eventType: 'order.payment_received',
        aggregateType: 'order',
        aggregateId: orderId,
        payload: { orderId },
      });
      await emitDomainEvent(tx, {
        eventType: 'order.paid',
        aggregateType: 'order',
        aggregateId: orderId,
        payload: { orderId, paymentRef: order.paymentReference },
      });
    });
  }

  /** Cancel-before-dispatch (§16.2): release presale, emit order.cancelled, and
   *  flag for refund if already paid. */
  async cancel(orderId: string, reason = 'customer_cancel'): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(preorderOrders)
        .where(eq(preorderOrders.id, orderId))
        .for('update');
      if (!order || order.status === 'cancelled' || order.status === 'lapsed') return;
      const wasPaid = order.status === 'paid';
      const lines = await tx
        .select()
        .from(preorderOrderLines)
        .where(eq(preorderOrderLines.orderId, orderId));
      for (const l of lines) {
        await this.inbound.releasePresaleTx(tx, l.shipmentId, l.sku, l.qty);
      }
      await tx
        .update(preorderOrders)
        .set({ status: wasPaid ? 'refund_pending' : 'cancelled', cancelledAt: new Date() })
        .where(eq(preorderOrders.id, orderId));
      await emitDomainEvent(tx, {
        eventType: 'order.cancelled',
        aggregateType: 'order',
        aggregateId: orderId,
        payload: { orderId, reason, wasPaid },
      });
    });
  }

  /** Lapse an unpaid order past the window: release presale, emit
   *  order.lapsed_unpaid. */
  private async lapse(orderId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(preorderOrders)
        .where(eq(preorderOrders.id, orderId))
        .for('update');
      if (!order || order.status !== 'awaiting_payment') return;
      const lines = await tx
        .select()
        .from(preorderOrderLines)
        .where(eq(preorderOrderLines.orderId, orderId));
      for (const l of lines) {
        await this.inbound.releasePresaleTx(tx, l.shipmentId, l.sku, l.qty);
      }
      await tx
        .update(preorderOrders)
        .set({ status: 'lapsed', lapsedAt: new Date() })
        .where(eq(preorderOrders.id, orderId));
      await emitDomainEvent(tx, {
        eventType: 'order.lapsed_unpaid',
        aggregateType: 'order',
        aggregateId: orderId,
        payload: { orderId, paymentRef: order.paymentReference },
      });
    });
  }

  /**
   * payment-window-scan (§16.4, replaces the Prompt 1 stub). Frozen-clock-safe
   * via `nowMs`. Day-3 unpaid → order.payment_overdue (once); day-5 unpaid →
   * lapse. Returns the counts acted on.
   */
  async scanPaymentWindow(nowMs = Date.now()): Promise<{ overdue: number; lapsed: number }> {
    const overdueBefore = new Date(nowMs - OVERDUE_DAYS * DAY_MS);
    const lapseBefore = new Date(nowMs - LAPSE_DAYS * DAY_MS);

    const candidates = await this.db
      .select()
      .from(preorderOrders)
      .where(
        and(
          eq(preorderOrders.companyId, this.companyId),
          eq(preorderOrders.status, 'awaiting_payment'),
          lte(preorderOrders.createdAt, overdueBefore),
        ),
      );

    let overdue = 0;
    let lapsed = 0;
    for (const order of candidates) {
      if (order.createdAt <= lapseBefore) {
        await this.lapse(order.id);
        lapsed++;
      } else if (!order.overdueNotifiedAt) {
        await this.db.transaction(async (tx) => {
          await tx
            .update(preorderOrders)
            .set({ overdueNotifiedAt: new Date(nowMs) })
            .where(eq(preorderOrders.id, order.id));
          await emitDomainEvent(tx, {
            eventType: 'order.payment_overdue',
            aggregateType: 'order',
            aggregateId: order.id,
            payload: { orderId: order.id, paymentRef: order.paymentReference },
          });
        });
        overdue++;
      }
    }
    return { overdue, lapsed };
  }

  /**
   * Thin-webhook normalisation (§4.7): re-fetch the payment from Mollie and act
   * on its true state. Idempotent (markPaid is a no-op if already paid).
   */
  async handleWebhook(molliePaymentId: string): Promise<void> {
    const payment = await getMollie().getPayment(molliePaymentId);
    const orderId = (payment.metadata as { orderId?: string }).orderId;
    if (!orderId) return;
    if (payment.status === 'paid') {
      await this.markPaid(orderId);
    }
    // failed/expired/canceled: leave in the window; the scan lapses it in time.
  }

  async getOrder(orderId: string) {
    const [order] = await this.db
      .select()
      .from(preorderOrders)
      .where(eq(preorderOrders.id, orderId))
      .limit(1);
    if (!order) return undefined;
    const lines = await this.db
      .select()
      .from(preorderOrderLines)
      .where(eq(preorderOrderLines.orderId, orderId));
    return { ...order, lines };
  }
}

/** Map our stored method to a Mollie method name for the allow-check. */
function mapMethod(method: string): string {
  switch (method) {
    case 'bank':
    case 'manual_transfer':
      return 'banktransfer';
    case 'card':
      return 'creditcard';
    case 'wallet':
      return 'applepay';
    default:
      return method;
  }
}

/**
 * Shipping an order: the dispatcher's one button.
 *
 * Available only when the order has a shipping label, a pick note, and every
 * item it ships from the warehouse allocated. Shipping then, in one
 * transaction:
 *   - creates the invoice (or keeps one already made by hand),
 *   - marks the order's allocated stock SOLD,
 *   - sets the order SHIPPED, with the date, courier and tracking number,
 *   - emits order.dispatched, which gets the customer their shipped email.
 * If any step fails, none of it happened.
 *
 * After it commits, the invoice PDF is made and stored, and the pick note and
 * label are combined into one PDF for printing.
 */
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { customerOrders, invoices, shippingLabels, stockItems } from '../../db/schema/index.js';
import { emitDomainEvent } from '../../shared/events/emit.js';
import { courierNameFrom } from '../../integrations/smooth-parcel/smooth-parcel-client.js';
import { InvoiceService } from '../orders/invoice.service.js';
import { InvoiceDocumentService } from '../orders/invoice-document.service.js';
import { combinePdfs } from './dispatch-documents.js';
import { PickNoteNotFoundError, PickNoteService } from './pick-note.service.js';
import { ShippingLabelService } from './shipping-label.service.js';

/** Shown to the customer when Smooth Parcel's reply does not name the carrier. */
const COURIER_FALLBACK = 'Smooth Parcel';

const SHIPPED_STATUSES: readonly string[] = ['SHIPPED', 'PARTIALLY_SHIPPED', 'COMPLETED'];
const BLOCKED_STATUSES: Record<string, string> = {
  CANCELLED: 'This order is cancelled.',
  DRAFT: 'Confirm the order first.',
  ON_HOLD: 'This order is on hold.',
};

export class ShipOrderError extends Error {
  constructor(
    message: string,
    readonly reasons: string[] = [],
  ) {
    super(message);
    this.name = 'ShipOrderError';
  }
}

export class ShipOrderNotFoundError extends Error {
  constructor(orderId: string) {
    super(`Order ${orderId} not found`);
    this.name = 'ShipOrderNotFoundError';
  }
}

export interface UnallocatedItem {
  sku: string | null;
  name: string;
  needed: number;
  allocated: number;
}

export interface ShipReadiness {
  ready: boolean;
  alreadyShipped: boolean;
  /** Why the order cannot be shipped yet, in words for the dispatcher. */
  reasons: string[];
  hasLabel: boolean;
  hasPickNote: boolean;
  allocated: boolean;
  unallocated: UnallocatedItem[];
}

export interface ShipResult {
  orderId: string;
  status: 'SHIPPED';
  shippedDate: string;
  courierName: string;
  trackingNumber: string | null;
  invoiceId: string;
  invoiceNumber: string | null;
  /** Set if the invoice PDF could not be made now; it is made when first opened instead. */
  invoicePdfError: string | null;
}

export interface ShipOrderDeps {
  labels?: ShippingLabelService;
  pickNotes?: PickNoteService;
  invoices?: InvoiceService;
  invoiceDocs?: InvoiceDocumentService;
  now?: () => Date;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export class ShipOrderService {
  private readonly db = getDb();
  private readonly labels: ShippingLabelService;
  private readonly pickNotes: PickNoteService;
  private readonly invoices: InvoiceService;
  private readonly invoiceDocs: InvoiceDocumentService;

  constructor(private readonly deps: ShipOrderDeps = {}) {
    this.labels = deps.labels ?? new ShippingLabelService();
    this.pickNotes = deps.pickNotes ?? new PickNoteService();
    this.invoices = deps.invoices ?? new InvoiceService();
    this.invoiceDocs = deps.invoiceDocs ?? new InvoiceDocumentService();
  }

  async readiness(orderId: string, companyId: string): Promise<ShipReadiness> {
    const order = await this.db.query.customerOrders.findFirst({
      where: and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId), isNull(customerOrders.deletedAt)),
      with: { lines: { where: (l, { isNull: isN }) => isN(l.deletedAt), with: { product: true } } },
    });
    if (!order) throw new ShipOrderNotFoundError(orderId);

    const reasons: string[] = [];
    const alreadyShipped = SHIPPED_STATUSES.includes(order.status);
    if (alreadyShipped) reasons.push('This order has already been shipped.');
    const blocked = BLOCKED_STATUSES[order.status];
    if (blocked) reasons.push(blocked);

    const label = await this.latestLabel(orderId, companyId);
    const hasLabel = label?.status === 'CREATED' && !!label.labelPath;
    if (!hasLabel) reasons.push('Create the shipping label.');

    const pickNote = await this.pickNotes.getForOrder(orderId, companyId);
    const hasPickNote = pickNote?.status === 'CREATED';
    if (!hasPickNote) reasons.push('Create the pick note.');

    const unallocated = await this.unallocatedItems(orderId, companyId, order.lines);
    for (const item of unallocated) {
      reasons.push(
        `Allocate stock: ${item.allocated} of ${plural(item.needed, 'unit')} of ${item.sku ?? item.name} allocated.`,
      );
    }

    return {
      ready: reasons.length === 0,
      alreadyShipped,
      reasons,
      hasLabel,
      hasPickNote,
      allocated: unallocated.length === 0,
      unallocated,
    };
  }

  async ship(orderId: string, companyId: string): Promise<ShipResult> {
    const readiness = await this.readiness(orderId, companyId);
    if (readiness.alreadyShipped) throw new ShipOrderError('This order has already been shipped.');
    if (!readiness.ready) throw new ShipOrderError('This order cannot be shipped yet.', readiness.reasons);

    const label = await this.latestLabel(orderId, companyId);
    const courierName = courierNameFrom(label?.responsePayload) ?? COURIER_FALLBACK;
    const now = this.deps.now?.() ?? new Date();
    const shippedDate = now.toISOString().slice(0, 10);

    const invoice = await this.db.transaction(async (tx) => {
      // Locked, so two dispatchers pressing Ship at once cannot both ship it.
      const [locked] = await tx
        .select({ status: customerOrders.status, trackingNumber: customerOrders.trackingNumber })
        .from(customerOrders)
        .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId), isNull(customerOrders.deletedAt)))
        .for('update');
      if (!locked) throw new ShipOrderNotFoundError(orderId);
      if (SHIPPED_STATUSES.includes(locked.status)) throw new ShipOrderError('This order has already been shipped.');

      // One invoice per order: keep one made by hand before shipping.
      const [existing] = await tx
        .select()
        .from(invoices)
        .where(and(eq(invoices.orderId, orderId), eq(invoices.companyId, companyId), isNull(invoices.deletedAt)))
        .limit(1);
      const inv =
        existing ??
        (await this.invoices.createFromOrderInTx(tx, orderId, companyId, { dateOfInvoice: shippedDate }, { orderStatus: null }));

      await tx
        .update(stockItems)
        .set({ status: 'SOLD', bookedOutDate: shippedDate, updatedAt: now })
        .where(
          and(
            eq(stockItems.salesOrderId, orderId),
            eq(stockItems.companyId, companyId),
            eq(stockItems.status, 'ALLOCATED'),
            isNull(stockItems.deletedAt),
          ),
        );

      await tx
        .update(customerOrders)
        .set({
          status: 'SHIPPED',
          shippedDate,
          courierName,
          trackingNumber: label?.trackingNumber ?? locked.trackingNumber,
          updatedAt: now,
        })
        .where(eq(customerOrders.id, orderId));

      await emitDomainEvent(tx, {
        companyId,
        eventType: 'order.dispatched',
        aggregateType: 'order',
        aggregateId: orderId,
        payload: { orderId, invoiceId: inv.id, shippedDate },
      });
      return inv;
    });

    // Made now so the invoice is on the order straight away. The order has
    // shipped whatever happens here; a failure is recovered on first view.
    let invoicePdfError: string | null = null;
    try {
      await this.invoiceDocs.ensurePdf(invoice.id, companyId);
    } catch (err) {
      invoicePdfError = err instanceof Error ? err.message : String(err);
    }

    return {
      orderId,
      status: 'SHIPPED',
      shippedDate,
      courierName,
      trackingNumber: label?.trackingNumber ?? null,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber ?? null,
      invoicePdfError,
    };
  }

  /** The pick note and shipping label as one PDF, pick note first. Null unless both exist. */
  async dispatchDocuments(orderId: string, companyId: string): Promise<{ buffer: Buffer; filename: string } | null> {
    const [order] = await this.db
      .select({ orderNumber: customerOrders.orderNumber })
      .from(customerOrders)
      .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId), isNull(customerOrders.deletedAt)))
      .limit(1);
    if (!order) throw new ShipOrderNotFoundError(orderId);

    const pickNote = await this.pickNotes.readFile(orderId, companyId).catch((err: unknown) => {
      if (err instanceof PickNoteNotFoundError) return null;
      throw err;
    });
    const label = await this.labels.readLabelFile(orderId, companyId);
    if (!pickNote || !label) return null;
    return { buffer: await combinePdfs([pickNote.buffer, label.buffer]), filename: `dispatch-${order.orderNumber}.pdf` };
  }

  private async latestLabel(orderId: string, companyId: string) {
    const [row] = await this.db
      .select()
      .from(shippingLabels)
      .where(and(eq(shippingLabels.orderId, orderId), eq(shippingLabels.companyId, companyId)))
      .orderBy(desc(shippingLabels.createdAt))
      .limit(1);
    return row ?? null;
  }

  /**
   * Warehouse items not fully allocated. Stock already SOLD to the order (an
   * invoice made by hand before shipping) counts as allocated. Drop-shipped
   * lines are sent by the supplier, so need no stock here.
   */
  private async unallocatedItems(
    orderId: string,
    companyId: string,
    lines: Array<{ productId: string; quantity: number; fulfilmentSource: string; product: { stockCode: string | null; name: string } | null }>,
  ): Promise<UnallocatedItem[]> {
    const needs = new Map<string, UnallocatedItem>();
    for (const line of lines) {
      if (line.fulfilmentSource === 'SUPPLIER') continue;
      const item = needs.get(line.productId) ?? {
        sku: line.product?.stockCode ?? null,
        name: line.product?.name ?? 'Item',
        needed: 0,
        allocated: 0,
      };
      item.needed += Number(line.quantity) || 0;
      needs.set(line.productId, item);
    }
    if (needs.size === 0) return [];

    const rows = await this.db
      .select({ productId: stockItems.productId, quantity: stockItems.quantity })
      .from(stockItems)
      .where(
        and(
          eq(stockItems.companyId, companyId),
          eq(stockItems.salesOrderId, orderId),
          inArray(stockItems.productId, [...needs.keys()]),
          inArray(stockItems.status, ['ALLOCATED', 'SOLD']),
          isNull(stockItems.deletedAt),
        ),
      );
    for (const row of rows) {
      const item = needs.get(row.productId);
      if (item) item.allocated += Number(row.quantity ?? 1);
    }
    return [...needs.values()].filter((item) => item.allocated + 1e-9 < item.needed);
  }
}

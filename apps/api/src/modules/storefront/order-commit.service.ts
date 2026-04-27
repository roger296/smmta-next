/**
 * OrderCommitService — orchestrates the storefront's POST /storefront/orders.
 *
 * Responsibilities:
 *   1. Idempotency  — `(companyId, Idempotency-Key)` returns the original response on replay.
 *   2. Customer / address resolution — find-or-create the customer by email; always
 *      capture the supplied delivery / invoice address as a new row (point-in-time).
 *   3. Total recompute — recompute grand total from the products' `min_selling_price`
 *      values (treated as gross UK retail prices, VAT 20% inclusive) plus
 *      `deliveryCharge`. If the supplied `mollie.amount` disagrees by more than 1p,
 *      throw `TotalMismatchError` (route → 422) and release the reservation.
 *   4. Convert reservation — delegate to `ReservationService.convertReservation`,
 *      which builds `customerOrder` + `orderLines` and flips RESERVED → ALLOCATED.
 *   5. Persist the response under the idempotency key.
 *
 * Does **not** post to Luca GL — GL postings remain at invoice / payment time.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import {
  customerDeliveryAddresses,
  customerInvoiceAddresses,
  customerOrders,
  customers,
  products,
  storefrontIdempotency,
  stockReservations,
} from '../../db/schema/index.js';
import { ReservationService } from './reservation.service.js';

// ---------------------------------------------------------------------------
// Inputs and errors
// ---------------------------------------------------------------------------

export interface OrderCommitAddress {
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postCode: string;
  country: string;
  contactName?: string;
}

export interface OrderCommitInput {
  reservationId: string;
  customer: {
    email: string;
    firstName: string;
    lastName: string;
    phone?: string;
  };
  deliveryAddress: OrderCommitAddress;
  invoiceAddress?: OrderCommitAddress;
  mollie: {
    paymentId: string;
    amount: string; // string to avoid float drift; "24.50" etc.
    currency: string;
    methodPaid: string;
    status: string;
  };
  /** Optional shipping charge in major units (e.g. "4.95"). Defaults to 0. */
  deliveryCharge?: string;
}

export interface OrderCommitResponse {
  orderId: string;
  status: string;
}

export class TotalMismatchError extends Error {
  readonly expected: string;
  readonly received: string;
  constructor(expected: string, received: string) {
    super(`Order total mismatch: expected ${expected}, received ${received}`);
    this.name = 'TotalMismatchError';
    this.expected = expected;
    this.received = received;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert "24.50" → 2450 (pennies). */
function toPence(amount: string): number {
  const n = Number(amount);
  if (!Number.isFinite(n)) throw new Error(`Invalid amount: ${amount}`);
  return Math.round(n * 100);
}

/** Convert pennies (integer) → "24.50". */
function fromPence(pence: number): string {
  return (pence / 100).toFixed(2);
}

/** Compute (gross, taxValue) for a line at 20% UK VAT, prices VAT-inclusive. */
function splitGrossPrice(unitGrossMajor: string, qty: number) {
  const unit = toPence(unitGrossMajor);
  const lineGross = unit * qty;
  // Net = gross / 1.20, tax = gross - net, all in pence.
  const lineNet = Math.round(lineGross / 1.2);
  const lineTax = lineGross - lineNet;
  return { lineGross, lineTax, unit };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class OrderCommitService {
  private db = getDb();
  private reservations = new ReservationService();

  /**
   * Commit an order. Returns `{ status, body }` so the route handler can
   * surface the same shape on first call and replay.
   */
  async commitOrder(
    companyId: string,
    idempotencyKey: string,
    input: OrderCommitInput,
  ): Promise<{ status: number; body: unknown }> {
    // -------- 1. Idempotency replay --------
    const replay = await this.db.query.storefrontIdempotency.findFirst({
      where: and(
        eq(storefrontIdempotency.companyId, companyId),
        eq(storefrontIdempotency.idempotencyKey, idempotencyKey),
        isNull(storefrontIdempotency.deletedAt),
      ),
    });
    if (replay) {
      return { status: replay.responseStatus, body: replay.responseBody };
    }

    // -------- 2. Load reservation + line breakdown --------
    const reservation = await this.db.query.stockReservations.findFirst({
      where: and(
        eq(stockReservations.id, input.reservationId),
        eq(stockReservations.companyId, companyId),
        isNull(stockReservations.deletedAt),
      ),
      with: {
        stockItems: { columns: { id: true, productId: true, status: true } },
      },
    });
    if (!reservation) {
      return this.persist(companyId, idempotencyKey, 404, {
        success: false,
        error: 'Reservation not found',
      });
    }
    if (reservation.status !== 'HELD') {
      return this.persist(companyId, idempotencyKey, 410, {
        success: false,
        error: `Reservation is ${reservation.status}, expected HELD`,
      });
    }

    // Group held stock_items by product → line quantities.
    const heldItems = reservation.stockItems.filter((s) => s.status === 'RESERVED');
    if (heldItems.length === 0) {
      return this.persist(companyId, idempotencyKey, 410, {
        success: false,
        error: 'Reservation has no held stock items',
      });
    }
    const qtyByProduct = new Map<string, number>();
    for (const it of heldItems) {
      qtyByProduct.set(it.productId, (qtyByProduct.get(it.productId) ?? 0) + 1);
    }

    // -------- 3. Recompute totals from canonical product prices --------
    const productIds = Array.from(qtyByProduct.keys());
    const productRows = await this.db.query.products.findMany({
      where: and(
        eq(products.companyId, companyId),
        // We don't filter on isPublished here — even an unpublished product, once
        // reserved, can be committed. This protects in-flight checkouts when an
        // operator unpublishes mid-flow.
        isNull(products.deletedAt),
      ),
      columns: { id: true, minSellingPrice: true, name: true, slug: true, colour: true },
    });
    const priceById = new Map(
      productRows.filter((p) => productIds.includes(p.id)).map((p) => [p.id, p]),
    );
    if (priceById.size !== productIds.length) {
      return this.persist(companyId, idempotencyKey, 422, {
        success: false,
        error: 'One or more reserved products no longer exist',
      });
    }

    const linePrices: Record<
      string,
      { pricePerUnit: string; lineTotal: string; taxRate: number; taxValue: string }
    > = {};
    let orderGrossPence = 0;
    let orderTaxPence = 0;
    for (const [pid, qty] of qtyByProduct) {
      const product = priceById.get(pid)!;
      if (!product.minSellingPrice) {
        return this.persist(companyId, idempotencyKey, 422, {
          success: false,
          error: `Product ${pid} has no min_selling_price; cannot price the order`,
        });
      }
      const { lineGross, lineTax } = splitGrossPrice(product.minSellingPrice, qty);
      orderGrossPence += lineGross;
      orderTaxPence += lineTax;
      linePrices[pid] = {
        pricePerUnit: product.minSellingPrice,
        lineTotal: fromPence(lineGross),
        taxRate: 20,
        taxValue: fromPence(lineTax),
      };
    }

    const deliveryPence = input.deliveryCharge ? toPence(input.deliveryCharge) : 0;
    const grandTotalPence = orderGrossPence + deliveryPence;
    const mollieAmountPence = toPence(input.mollie.amount);
    if (Math.abs(grandTotalPence - mollieAmountPence) > 1) {
      // Release the reservation so the customer can try again with corrected state.
      await this.reservations.releaseReservation(input.reservationId, companyId);
      return this.persist(companyId, idempotencyKey, 422, {
        success: false,
        error: 'Order total mismatch — payment amount does not match recomputed total',
        expected: fromPence(grandTotalPence),
        received: input.mollie.amount,
      });
    }

    // -------- 4. Resolve customer and addresses --------
    const customerName = `${input.customer.firstName} ${input.customer.lastName}`.trim();
    let customer = await this.db.query.customers.findFirst({
      where: and(
        eq(customers.companyId, companyId),
        eq(customers.email, input.customer.email),
        isNull(customers.deletedAt),
      ),
    });
    if (!customer) {
      const [created] = await this.db
        .insert(customers)
        .values({
          companyId,
          name: customerName,
          email: input.customer.email,
          vatTreatment: 'STANDARD_VAT_20',
        })
        .returning();
      if (!created) throw new Error('Failed to insert customer');
      customer = created;
    }

    const [delivery] = await this.db
      .insert(customerDeliveryAddresses)
      .values({
        customerId: customer.id,
        contactName: input.deliveryAddress.contactName ?? customerName,
        line1: input.deliveryAddress.line1,
        line2: input.deliveryAddress.line2 ?? null,
        city: input.deliveryAddress.city,
        region: input.deliveryAddress.region ?? null,
        postCode: input.deliveryAddress.postCode,
        country: input.deliveryAddress.country,
      })
      .returning();
    if (!delivery) throw new Error('Failed to insert delivery address');

    let invoiceAddressId: string | null = null;
    if (input.invoiceAddress) {
      const [invoice] = await this.db
        .insert(customerInvoiceAddresses)
        .values({
          customerId: customer.id,
          contactName: input.invoiceAddress.contactName ?? customerName,
          line1: input.invoiceAddress.line1,
          line2: input.invoiceAddress.line2 ?? null,
          city: input.invoiceAddress.city,
          region: input.invoiceAddress.region ?? null,
          postCode: input.invoiceAddress.postCode,
          country: input.invoiceAddress.country,
        })
        .returning({ id: customerInvoiceAddresses.id });
      if (!invoice) throw new Error('Failed to insert invoice address');
      invoiceAddressId = invoice.id;
    }

    // -------- 5. Convert reservation --------
    const orderNumber = `STORE-${idempotencyKey.slice(-12).toUpperCase()}`;
    const today = new Date().toISOString().slice(0, 10);

    const { orderId } = await this.reservations.convertReservation(
      input.reservationId,
      companyId,
      {
        orderNumber,
        customerId: customer.id,
        deliveryAddressId: delivery.id,
        invoiceAddressId: invoiceAddressId ?? undefined,
        orderDate: today,
        thirdPartyOrderId: input.mollie.paymentId,
        integrationMetadata: {
          mollie: {
            paymentId: input.mollie.paymentId,
            methodPaid: input.mollie.methodPaid,
            amount: input.mollie.amount,
            currency: input.mollie.currency,
            status: input.mollie.status,
          },
        },
        vatTreatment: 'STANDARD_VAT_20',
        totals: {
          deliveryCharge: input.deliveryCharge ?? '0',
          orderTotal: fromPence(orderGrossPence),
          taxTotal: fromPence(orderTaxPence),
          grandTotal: fromPence(grandTotalPence),
        },
        linePrices,
      },
    );

    return this.persist(companyId, idempotencyKey, 201, {
      success: true,
      data: { orderId, status: 'ALLOCATED' satisfies OrderCommitResponse['status'] },
    });
  }

  /**
   * Insert the response under the idempotency key. Race-safe: if another
   * concurrent caller wins, fetch and replay theirs.
   */
  private async persist(
    companyId: string,
    idempotencyKey: string,
    status: number,
    body: unknown,
  ): Promise<{ status: number; body: unknown }> {
    try {
      await this.db.insert(storefrontIdempotency).values({
        companyId,
        idempotencyKey,
        responseStatus: status,
        responseBody: body as Record<string, unknown>,
      });
      return { status, body };
    } catch (err) {
      // Unique violation → another concurrent request won the race; replay theirs.
      const existing = await this.db.query.storefrontIdempotency.findFirst({
        where: and(
          eq(storefrontIdempotency.companyId, companyId),
          eq(storefrontIdempotency.idempotencyKey, idempotencyKey),
        ),
      });
      if (existing) return { status: existing.responseStatus, body: existing.responseBody };
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // GET /storefront/orders/:id — public-safe order projection.
  // -------------------------------------------------------------------------

  async getPublicOrder(companyId: string, orderId: string): Promise<PublicOrder | null> {
    const order = await this.db.query.customerOrders.findFirst({
      where: and(
        eq(customerOrders.id, orderId),
        eq(customerOrders.companyId, companyId),
        isNull(customerOrders.deletedAt),
      ),
      with: {
        lines: { with: { product: { columns: { slug: true, colour: true, name: true } } } },
        deliveryAddress: true,
      },
    });
    if (!order) return null;

    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      orderDate: order.orderDate,
      shippedDate: order.shippedDate,
      currencyCode: order.currencyCode,
      totals: {
        orderTotal: order.orderTotal ?? '0',
        taxTotal: order.taxTotal ?? '0',
        deliveryCharge: order.deliveryCharge ?? '0',
        grandTotal: order.grandTotal ?? '0',
      },
      lines: order.lines.map((l) => ({
        productSlug: l.product?.slug ?? null,
        productName: l.product?.name ?? null,
        colour: l.product?.colour ?? null,
        quantity: Number(l.quantity),
        pricePerUnit: l.pricePerUnit,
        lineTotal: l.lineTotal,
      })),
      deliveryAddress: order.deliveryAddress
        ? {
            line1: order.deliveryAddress.line1 ?? '',
            city: order.deliveryAddress.city ?? '',
            postCode: order.deliveryAddress.postCode ?? '',
          }
        : null,
      tracking:
        order.trackingNumber || order.courierName
          ? {
              trackingNumber: order.trackingNumber ?? null,
              trackingLink: order.trackingLink ?? null,
              courierName: order.courierName ?? null,
            }
          : null,
      // v1: there is no order_status_history table. Surface the status-change
      // dates we do have on customer_orders so the client can render a basic
      // timeline. Full audit history is a follow-up.
      statusHistory: [
        { status: 'CONFIRMED', at: order.createdAt },
        ...(order.shippedDate ? [{ status: 'SHIPPED', at: new Date(order.shippedDate) }] : []),
      ],
    };
  }

  // -------------------------------------------------------------------------
  // POST /storefront/orders/:id/cancel — cancel if not yet shipped, revert
  // ALLOCATED stock_items to IN_STOCK.
  // -------------------------------------------------------------------------

  async cancelOrder(
    companyId: string,
    orderId: string,
  ): Promise<
    | { ok: true; status: 'CANCELLED' }
    | { ok: false; error: 'NOT_FOUND' | 'NOT_CANCELLABLE'; currentStatus?: string }
  > {
    return this.db.transaction(async (tx) => {
      const order = await tx.query.customerOrders.findFirst({
        where: and(
          eq(customerOrders.id, orderId),
          eq(customerOrders.companyId, companyId),
          isNull(customerOrders.deletedAt),
        ),
      });
      if (!order) return { ok: false, error: 'NOT_FOUND' as const };
      const cancellable = ['DRAFT', 'CONFIRMED', 'ALLOCATED', 'PARTIALLY_ALLOCATED', 'BACK_ORDERED', 'ON_HOLD'];
      if (!cancellable.includes(order.status)) {
        return { ok: false, error: 'NOT_CANCELLABLE' as const, currentStatus: order.status };
      }
      await tx
        .update(customerOrders)
        .set({ status: 'CANCELLED', updatedAt: new Date() })
        .where(eq(customerOrders.id, orderId));
      // Revert ALLOCATED stock items back to IN_STOCK so they're re-sellable.
      const { stockItems } = await import('../../db/schema/index.js');
      await tx
        .update(stockItems)
        .set({ status: 'IN_STOCK', salesOrderId: null, updatedAt: new Date() })
        .where(
          and(
            eq(stockItems.companyId, companyId),
            eq(stockItems.salesOrderId, orderId),
            eq(stockItems.status, 'ALLOCATED'),
          ),
        );
      return { ok: true, status: 'CANCELLED' as const };
    });
  }
}

// ---------------------------------------------------------------------------
// Public order projection
// ---------------------------------------------------------------------------

export interface PublicOrderLine {
  productSlug: string | null;
  productName: string | null;
  colour: string | null;
  quantity: number;
  pricePerUnit: string;
  lineTotal: string;
}

export interface PublicOrder {
  id: string;
  orderNumber: string;
  status: string;
  orderDate: string;
  shippedDate: string | null;
  currencyCode: string;
  totals: {
    orderTotal: string;
    taxTotal: string;
    deliveryCharge: string;
    grandTotal: string;
  };
  lines: PublicOrderLine[];
  deliveryAddress: { line1: string; city: string; postCode: string } | null;
  tracking: {
    trackingNumber: string | null;
    trackingLink: string | null;
    courierName: string | null;
  } | null;
  statusHistory: Array<{ status: string; at: Date }>;
}

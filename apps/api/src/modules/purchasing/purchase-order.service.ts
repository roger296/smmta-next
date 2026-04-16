import { eq, and, isNull, ilike, sql, count } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import {
  purchaseOrders, purchaseOrderLines, suppliers,
} from '../../db/schema/index.js';
import type { CreatePurchaseOrderInput } from './purchase-order.schema.js';
import type { SupplierQueryInput } from './supplier.schema.js';
import { paginationOffset, paginationMeta } from '../../shared/utils/pagination.js';
import { roundMoney } from '../../shared/utils/currency.js';

/**
 * PurchaseOrderService — PO lifecycle CRUD.
 *
 * Source: Libraries/DSB.Service/Purchases/PurchaseOrderServices.cs
 *   GetAll, GetById, Insert, Update, Delete, getCompanyPOnumber, ClosingPO
 */
export class PurchaseOrderService {
  private db = getDb();

  // ── List ──

  async list(companyId: string, query: SupplierQueryInput & {
    supplierId?: string;
    deliveryStatus?: string;
    invoicedStatus?: string;
  }) {
    const { page, pageSize, search, supplierId, deliveryStatus, invoicedStatus } = query as any;
    const offset = paginationOffset(page, pageSize);

    const conditions = [eq(purchaseOrders.companyId, companyId), isNull(purchaseOrders.deletedAt)];
    if (supplierId) conditions.push(eq(purchaseOrders.supplierId, supplierId));
    if (deliveryStatus) conditions.push(eq(purchaseOrders.deliveryStatus, deliveryStatus));
    if (invoicedStatus) conditions.push(eq(purchaseOrders.invoicedStatus, invoicedStatus));
    if (search) conditions.push(ilike(purchaseOrders.poNumber, `%${search}%`));

    const where = and(...conditions);

    const [totalResult, rows] = await Promise.all([
      this.db.select({ count: count() }).from(purchaseOrders).where(where),
      this.db.query.purchaseOrders.findMany({
        where,
        with: { supplier: true },
        limit: pageSize,
        offset,
        orderBy: (po, { desc }) => [desc(po.createdAt)],
      }),
    ]);

    return { data: rows, ...paginationMeta(Number(totalResult[0]?.count ?? 0), page, pageSize) };
  }

  // ── Get by ID ──

  async getById(id: string, companyId: string) {
    return this.db.query.purchaseOrders.findFirst({
      where: and(eq(purchaseOrders.id, id), eq(purchaseOrders.companyId, companyId), isNull(purchaseOrders.deletedAt)),
      with: {
        supplier: true,
        contact: true,
        warehouse: true,
        lines: {
          where: isNull(purchaseOrderLines.deletedAt),
          with: { product: true },
        },
        grns: {
          where: (g: any, { isNull: isN }: any) => isN(g.deletedAt),
          with: { lines: true },
        },
        invoices: {
          where: (i: any, { isNull: isN }: any) => isN(i.deletedAt),
        },
      },
    });
  }

  // ── Create PO with lines ──

  async create(companyId: string, input: CreatePurchaseOrderInput) {
    // Generate PO number
    const poNumber = await this.generatePONumber(companyId);

    // Calculate totals from lines
    let lineTotal = 0;
    let taxTotal = 0;
    const lineData = input.lines.map((line) => {
      const lineTotalVal = roundMoney(line.quantity * line.pricePerUnit);
      const taxVal = roundMoney(lineTotalVal * (line.taxRate / 100));
      lineTotal += lineTotalVal;
      taxTotal += taxVal;
      return { ...line, lineTotal: lineTotalVal, taxValue: taxVal, taxName: `VAT ${line.taxRate}%` };
    });

    const grandTotal = roundMoney(lineTotal + taxTotal + input.deliveryCharge);

    // Insert PO
    const [po] = await this.db
      .insert(purchaseOrders)
      .values({
        companyId,
        supplierId: input.supplierId,
        contactId: input.contactId,
        addressId: input.addressId,
        deliveryWarehouseId: input.deliveryWarehouseId,
        currencyCode: input.currencyCode,
        poNumber,
        deliveryCharge: input.deliveryCharge.toString(),
        lineTotal: lineTotal.toString(),
        taxTotal: taxTotal.toString(),
        grandTotal: grandTotal.toString(),
        deliveryStatus: 'PENDING',
        invoicedStatus: 'NOT_INVOICED',
        exchangeRate: input.exchangeRate.toString(),
        vatTreatment: input.vatTreatment,
        expectedDeliveryDate: input.expectedDeliveryDate,
      })
      .returning();

    // Insert PO lines
    const lineInserts = lineData.map((line) => ({
      purchaseOrderId: po.id,
      productId: line.productId,
      quantity: line.quantity,
      pricePerUnit: line.pricePerUnit.toString(),
      taxName: line.taxName,
      taxRate: line.taxRate,
      taxValue: line.taxValue.toString(),
      lineTotal: line.lineTotal.toString(),
      qtyBookedIn: 0,
      qtyInvoiced: 0,
      deliveryStatus: 'PENDING' as const,
      accountCode: line.accountCode,
      expectedDeliveryDate: line.expectedDeliveryDate,
    }));

    await this.db.insert(purchaseOrderLines).values(lineInserts);

    return this.getById(po.id, companyId);
  }

  // ── Update PO header ──

  async update(id: string, companyId: string, input: Record<string, unknown>) {
    const [updated] = await this.db
      .update(purchaseOrders)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.companyId, companyId), isNull(purchaseOrders.deletedAt)))
      .returning();
    return updated;
  }

  // ── Close PO (mark as cancelled) ──

  async close(id: string, companyId: string) {
    const [updated] = await this.db
      .update(purchaseOrders)
      .set({ deliveryStatus: 'CANCELLED', updatedAt: new Date() })
      .where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.companyId, companyId)))
      .returning();
    return updated;
  }

  // ── Soft Delete ──

  async delete(id: string, companyId: string) {
    const result = await this.db
      .update(purchaseOrders)
      .set({ deletedAt: new Date() })
      .where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.companyId, companyId), isNull(purchaseOrders.deletedAt)));
    return (result.rowCount ?? 0) > 0;
  }

  // ── Update delivery status based on GRN quantities ──

  async recalculateDeliveryStatus(poId: string) {
    const lines = await this.db.query.purchaseOrderLines.findMany({
      where: and(eq(purchaseOrderLines.purchaseOrderId, poId), isNull(purchaseOrderLines.deletedAt)),
    });

    const allReceived = lines.every((l) => (l.qtyBookedIn ?? 0) >= l.quantity);
    const someReceived = lines.some((l) => (l.qtyBookedIn ?? 0) > 0);

    const status = allReceived ? 'FULLY_RECEIVED' : someReceived ? 'PARTIALLY_RECEIVED' : 'PENDING';

    await this.db
      .update(purchaseOrders)
      .set({ deliveryStatus: status, updatedAt: new Date() })
      .where(eq(purchaseOrders.id, poId));
  }

  // ── Update invoiced status ──

  async recalculateInvoicedStatus(poId: string) {
    const lines = await this.db.query.purchaseOrderLines.findMany({
      where: and(eq(purchaseOrderLines.purchaseOrderId, poId), isNull(purchaseOrderLines.deletedAt)),
    });

    const allInvoiced = lines.every((l) => (l.qtyInvoiced ?? 0) >= l.quantity);
    const someInvoiced = lines.some((l) => (l.qtyInvoiced ?? 0) > 0);

    const status = allInvoiced ? 'FULLY_INVOICED' : someInvoiced ? 'PARTIALLY_INVOICED' : 'NOT_INVOICED';

    await this.db
      .update(purchaseOrders)
      .set({ invoicedStatus: status, updatedAt: new Date() })
      .where(eq(purchaseOrders.id, poId));
  }

  // ── PO Number Generation ──

  private async generatePONumber(companyId: string): Promise<string> {
    const result = await this.db
      .select({ count: count() })
      .from(purchaseOrders)
      .where(eq(purchaseOrders.companyId, companyId));
    const num = Number(result[0]?.count ?? 0) + 1;
    return `PO-${String(num).padStart(6, '0')}`;
  }
}

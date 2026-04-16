import { eq, and, isNull, ilike, sql, count, gte, lte } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import {
  customerOrders, orderLines, orderNotes, customers,
} from '../../db/schema/index.js';
import type { CreateOrderInput, OrderQueryInput } from './order.schema.js';
import { paginationOffset, paginationMeta } from '../../shared/utils/pagination.js';
import { roundMoney } from '../../shared/utils/currency.js';
import { StockItemService } from '../products/stock-item.service.js';

/**
 * OrderService — Customer order lifecycle CRUD with stock allocation.
 *
 * Source: Libraries/DSB.Service/Orders/CustomerOrderServices.cs (200+ methods)
 *   GetAll, GetById, Insert, Update, Delete, ChangeStatusToCancelled,
 *   getCompanyOrdernumber, InsertNote
 */
export class OrderService {
  private db = getDb();
  private stockService = new StockItemService();

  // ================================================================
  // List / Search with filtering
  // ================================================================

  async list(companyId: string, query: OrderQueryInput) {
    const { page, pageSize, customerId, status, sourceChannel, search, dateFrom, dateTo } = query;
    const offset = paginationOffset(page, pageSize);

    const conditions = [eq(customerOrders.companyId, companyId), isNull(customerOrders.deletedAt)];
    if (customerId) conditions.push(eq(customerOrders.customerId, customerId));
    if (status) conditions.push(eq(customerOrders.status, status));
    if (sourceChannel) conditions.push(eq(customerOrders.sourceChannel, sourceChannel));
    if (search) {
      conditions.push(
        sql`(${ilike(customerOrders.orderNumber, `%${search}%`)} OR ${ilike(customerOrders.customerOrderNumber, `%${search}%`)})`,
      );
    }
    if (dateFrom) conditions.push(gte(customerOrders.orderDate, dateFrom));
    if (dateTo) conditions.push(lte(customerOrders.orderDate, dateTo));

    const where = and(...conditions);

    const [totalResult, rows] = await Promise.all([
      this.db.select({ count: count() }).from(customerOrders).where(where),
      this.db.query.customerOrders.findMany({
        where,
        with: { customer: true },
        limit: pageSize,
        offset,
        orderBy: (o, { desc }) => [desc(o.createdAt)],
      }),
    ]);

    return { data: rows, ...paginationMeta(Number(totalResult[0]?.count ?? 0), page, pageSize) };
  }

  // ================================================================
  // Get by ID (full detail)
  // ================================================================

  async getById(id: string, companyId: string) {
    return this.db.query.customerOrders.findFirst({
      where: and(eq(customerOrders.id, id), eq(customerOrders.companyId, companyId), isNull(customerOrders.deletedAt)),
      with: {
        customer: true,
        contact: true,
        invoiceAddress: true,
        deliveryAddress: true,
        warehouse: true,
        lines: {
          where: isNull(orderLines.deletedAt),
          with: { product: true },
        },
        notes: {
          where: isNull(orderNotes.deletedAt),
          orderBy: (n, { desc }) => [desc(n.createdAt)],
        },
        invoices: {
          where: (i: any, { isNull: isN }: any) => isN(i.deletedAt),
        },
      },
    });
  }

  // ================================================================
  // Create order with lines
  // ================================================================

  async create(companyId: string, input: CreateOrderInput) {
    const orderNumber = await this.generateOrderNumber(companyId);

    // Calculate totals
    let orderTotal = 0;
    let taxTotal = 0;
    const lineData = input.lines.map((line) => {
      const lineTotal = roundMoney(line.quantity * line.pricePerUnit);
      const taxValue = roundMoney(lineTotal * ((line.taxRate ?? 20) / 100));
      orderTotal += lineTotal;
      taxTotal += taxValue;
      return {
        ...line,
        lineTotal,
        taxValue,
        taxName: `VAT ${line.taxRate}%`,
      };
    });

    const deliveryCharge = input.deliveryCharge ?? 0;
    const grandTotal = roundMoney(orderTotal + taxTotal + deliveryCharge);

    const [order] = await this.db
      .insert(customerOrders)
      .values({
        companyId,
        orderNumber,
        customerId: input.customerId,
        contactId: input.contactId,
        invoiceAddressId: input.invoiceAddressId,
        deliveryAddressId: input.deliveryAddressId,
        warehouseId: input.warehouseId,
        currencyCode: input.currencyCode,
        deliveryCharge: deliveryCharge.toString(),
        orderTotal: orderTotal.toString(),
        taxTotal: taxTotal.toString(),
        grandTotal: grandTotal.toString(),
        status: 'CONFIRMED',
        paymentMethod: input.paymentMethod,
        orderDate: input.orderDate,
        deliveryDate: input.deliveryDate,
        taxInclusive: input.taxInclusive,
        vatTreatment: input.vatTreatment,
        sourceChannel: input.sourceChannel,
        customerOrderNumber: input.customerOrderNumber,
        factoryOrderNumber: input.factoryOrderNumber,
        integrationMetadata: input.integrationMetadata,
      })
      .returning();

    // Insert lines
    const lineInserts = lineData.map((line) => ({
      orderId: order.id,
      productId: line.productId,
      quantity: line.quantity,
      pricePerUnit: line.pricePerUnit.toString(),
      taxName: line.taxName,
      taxRate: line.taxRate,
      taxValue: line.taxValue.toString(),
      lineTotal: line.lineTotal.toString(),
      numberShipped: 0,
      remainingQuantity: Math.ceil(line.quantity),
    }));

    await this.db.insert(orderLines).values(lineInserts);

    return this.getById(order.id, companyId);
  }

  // ================================================================
  // Update order header
  // ================================================================

  async update(id: string, companyId: string, input: Record<string, unknown>) {
    const [updated] = await this.db
      .update(customerOrders)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(customerOrders.id, id), eq(customerOrders.companyId, companyId), isNull(customerOrders.deletedAt)))
      .returning();
    return updated;
  }

  // ================================================================
  // Change status
  // ================================================================

  async changeStatus(id: string, companyId: string, status: string) {
    const order = await this.db.query.customerOrders.findFirst({
      where: and(eq(customerOrders.id, id), eq(customerOrders.companyId, companyId)),
    });
    if (!order) return null;

    // If cancelling, deallocate any allocated stock
    if (status === 'CANCELLED' && (order.status === 'ALLOCATED' || order.status === 'PARTIALLY_ALLOCATED')) {
      await this.stockService.deallocateFromOrder(companyId, id);
    }

    const shippedDate = status === 'SHIPPED' ? new Date().toISOString().slice(0, 10) : order.shippedDate;

    const [updated] = await this.db
      .update(customerOrders)
      .set({ status: status as any, shippedDate, updatedAt: new Date() })
      .where(eq(customerOrders.id, id))
      .returning();
    return updated;
  }

  // ================================================================
  // Allocate stock to order (FIFO per line)
  // ================================================================

  async allocateStock(id: string, companyId: string, warehouseId: string) {
    const order = await this.db.query.customerOrders.findFirst({
      where: and(eq(customerOrders.id, id), eq(customerOrders.companyId, companyId)),
      with: { lines: { where: isNull(orderLines.deletedAt) } },
    });
    if (!order) throw new OrderValidationError('Order not found');

    let totalAllocated = 0;
    let totalShortfall = 0;

    for (const line of order.lines) {
      const needed = Math.ceil(line.quantity - (line.numberShipped ?? 0));
      if (needed <= 0) continue;

      const result = await this.stockService.allocateToOrder(
        companyId, id, line.productId, warehouseId, needed,
      );
      totalAllocated += result.allocated;
      totalShortfall += result.shortfall;
    }

    // Update order status based on allocation result
    const newStatus = totalShortfall === 0
      ? 'ALLOCATED'
      : totalAllocated > 0
        ? 'PARTIALLY_ALLOCATED'
        : 'BACK_ORDERED';

    await this.db
      .update(customerOrders)
      .set({ status: newStatus, updatedAt: new Date() })
      .where(eq(customerOrders.id, id));

    return { totalAllocated, totalShortfall, status: newStatus };
  }

  // ================================================================
  // Deallocate stock from order
  // ================================================================

  async deallocateStock(id: string, companyId: string) {
    const result = await this.stockService.deallocateFromOrder(companyId, id);

    await this.db
      .update(customerOrders)
      .set({ status: 'CONFIRMED', updatedAt: new Date() })
      .where(eq(customerOrders.id, id));

    return result;
  }

  // ================================================================
  // Soft delete
  // ================================================================

  async delete(id: string, companyId: string) {
    // Deallocate stock first
    await this.stockService.deallocateFromOrder(companyId, id);

    const result = await this.db
      .update(customerOrders)
      .set({ deletedAt: new Date(), status: 'CANCELLED' })
      .where(and(eq(customerOrders.id, id), eq(customerOrders.companyId, companyId), isNull(customerOrders.deletedAt)));
    return (result.rowCount ?? 0) > 0;
  }

  // ================================================================
  // Notes
  // ================================================================

  async addNote(orderId: string, userId: string, input: {
    note: string; attachmentUrl?: string; isMarked?: boolean; isPickingNote?: boolean;
  }) {
    const [noteRow] = await this.db.insert(orderNotes).values({ orderId, userId, ...input }).returning();
    return noteRow;
  }

  async updateNote(noteId: string, input: { note?: string; isMarked?: boolean; isPickingNote?: boolean }) {
    const [updated] = await this.db
      .update(orderNotes)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(orderNotes.id, noteId), isNull(orderNotes.deletedAt)))
      .returning();
    return updated;
  }

  // ================================================================
  // Order number generation
  // ================================================================

  private async generateOrderNumber(companyId: string): Promise<string> {
    const result = await this.db
      .select({ count: count() })
      .from(customerOrders)
      .where(eq(customerOrders.companyId, companyId));
    const num = Number(result[0]?.count ?? 0) + 1;
    return `SO-${String(num).padStart(6, '0')}`;
  }
}

export class OrderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderValidationError';
  }
}

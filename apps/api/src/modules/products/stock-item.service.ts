import { eq, and, isNull, sql, count, asc } from 'drizzle-orm';
import { getDb, getPool } from '../../config/database.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { stockItems, products } from '../../db/schema/index.js';
import * as schema from '../../db/schema/index.js';
import { LucaGLService } from '../../integrations/luca/luca-gl.service.js';
import type { StockAdjustmentInput, StockTransferInput, StockItemQueryInput, StockReportQueryInput } from './stock-item.schema.js';
import { paginationOffset, paginationMeta } from '../../shared/utils/pagination.js';
import { roundMoney } from '../../shared/utils/currency.js';

/**
 * StockItemService — stock management with FIFO selling,
 * allocation, manual adjustment (with GL posting), and transfer.
 *
 * Mirrors key methods from the old StockItemServices.cs:
 *   GetAll, GetById, SellItemFifo, AllocateStockToOrder,
 *   Insert, Addstock, ManualStockRemove, TransferStock
 *
 * Source: Libraries/DSB.Service/Products/StockItemServices.cs
 */
export class StockItemService {
  private db = getDb();
  private lucaGL = new LucaGLService();

  // ----------------------------------------------------------------
  // List stock items with filtering
  // ----------------------------------------------------------------

  async list(companyId: string, query: StockItemQueryInput) {
    const { page, pageSize, productId, warehouseId, status, serialNumber } = query;
    const offset = paginationOffset(page, pageSize);

    const conditions = [
      eq(stockItems.companyId, companyId),
      isNull(stockItems.deletedAt),
    ];
    if (productId) conditions.push(eq(stockItems.productId, productId));
    if (warehouseId) conditions.push(eq(stockItems.warehouseId, warehouseId));
    if (status) conditions.push(eq(stockItems.status, status));
    if (serialNumber) conditions.push(eq(stockItems.serialNumber, serialNumber));

    const where = and(...conditions);

    const [totalResult, rows] = await Promise.all([
      this.db.select({ count: count() }).from(stockItems).where(where),
      this.db.query.stockItems.findMany({
        where,
        with: { product: true, warehouse: true },
        limit: pageSize,
        offset,
        orderBy: (s, { desc }) => [desc(s.createdAt)],
      }),
    ]);

    const total = Number(totalResult[0]?.count ?? 0);
    return { data: rows, ...paginationMeta(total, page, pageSize) };
  }

  // ----------------------------------------------------------------
  // Get by ID
  // ----------------------------------------------------------------

  async getById(id: string, companyId: string) {
    return this.db.query.stockItems.findFirst({
      where: and(eq(stockItems.id, id), eq(stockItems.companyId, companyId), isNull(stockItems.deletedAt)),
      with: { product: true, warehouse: true },
    });
  }

  // ----------------------------------------------------------------
  // Manual Stock Adjustment (ADD / REMOVE) — triggers GL posting
  //
  // Old: StockItemServices.Addstock (for ADD)
  //      StockItemServices.ManualStockRemove (for REMOVE)
  // ----------------------------------------------------------------

  async adjust(companyId: string, userId: string, input: StockAdjustmentInput) {
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      const txDb = drizzle(client, { schema });

      const product = await txDb.query.products.findFirst({
        where: and(eq(products.id, input.productId), eq(products.companyId, companyId)),
      });
      if (!product) throw new StockValidationError('Product not found');

      let adjustmentId: string;
      const totalValue = roundMoney(input.quantity * input.valuePerUnit);
      const dateNow = new Date();
      const dateStr = dateNow.toISOString().slice(0, 10);

      if (input.type === 'ADD') {
        // Create stock items
        const itemsToInsert = [];
        for (let i = 0; i < input.quantity; i++) {
          itemsToInsert.push({
            companyId,
            productId: input.productId,
            warehouseId: input.warehouseId,
            serialNumber: input.serialNumbers?.[i] ?? null,
            batchId: input.batchId ?? null,
            locationIsle: input.locationIsle ?? null,
            locationShelf: input.locationShelf ?? null,
            locationBin: input.locationBin ?? null,
            quantity: 1,
            status: 'IN_STOCK' as const,
            bookedInDate: dateStr,
            value: input.valuePerUnit.toString(),
            currencyCode: input.currencyCode,
          });
        }

        const inserted = await txDb.insert(stockItems).values(itemsToInsert).returning();
        adjustmentId = inserted[0].id; // Use first item ID as the adjustment reference

        // Post GL: Debit Stock (1150), Credit Write-Back (5020)
        await this.lucaGL.postStockAdjustment(txDb as any, {
          companyId,
          adjustmentId,
          adjustmentDate: dateNow,
          stockValue: totalValue,
          type: 'ADD',
          productName: product.name,
        });
      } else {
        // REMOVE — FIFO: remove oldest IN_STOCK items first
        const availableStock = await txDb
          .select()
          .from(stockItems)
          .where(
            and(
              eq(stockItems.productId, input.productId),
              eq(stockItems.companyId, companyId),
              eq(stockItems.warehouseId, input.warehouseId),
              eq(stockItems.status, 'IN_STOCK'),
              isNull(stockItems.deletedAt),
            ),
          )
          .orderBy(asc(stockItems.createdAt))
          .limit(input.quantity);

        if (availableStock.length < input.quantity) {
          throw new StockValidationError(
            `Insufficient stock: requested ${input.quantity}, available ${availableStock.length}`,
          );
        }

        // Mark items as WRITTEN_OFF
        for (const item of availableStock) {
          await txDb
            .update(stockItems)
            .set({
              status: 'WRITTEN_OFF',
              bookedOutDate: dateStr,
              updatedAt: dateNow,
            })
            .where(eq(stockItems.id, item.id));
        }

        adjustmentId = availableStock[0].id;

        // Calculate actual value removed (from the items themselves)
        const actualValue = availableStock.reduce(
          (sum, item) => sum + Number(item.value ?? 0) * Number(item.quantity),
          0,
        );

        // Post GL: Debit Write-Off (5010), Credit Stock (1150)
        await this.lucaGL.postStockAdjustment(txDb as any, {
          companyId,
          adjustmentId,
          adjustmentDate: dateNow,
          stockValue: roundMoney(actualValue),
          type: 'REMOVE',
          productName: product.name,
        });
      }

      await client.query('COMMIT');
      return { adjustmentId, type: input.type, quantity: input.quantity, totalValue };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ----------------------------------------------------------------
  // Transfer stock between warehouses
  //
  // Old: StockItemServices.TransferStock
  // No GL posting — this is an internal warehouse movement
  // ----------------------------------------------------------------

  async transfer(companyId: string, input: StockTransferInput) {
    if (input.fromWarehouseId === input.toWarehouseId) {
      throw new StockValidationError('Source and destination warehouses must be different');
    }

    const dateNow = new Date();
    let transferred = 0;

    for (const itemId of input.stockItemIds) {
      const result = await this.db
        .update(stockItems)
        .set({
          warehouseId: input.toWarehouseId,
          locationIsle: input.toLocationIsle ?? null,
          locationShelf: input.toLocationShelf ?? null,
          locationBin: input.toLocationBin ?? null,
          updatedAt: dateNow,
        })
        .where(
          and(
            eq(stockItems.id, itemId),
            eq(stockItems.companyId, companyId),
            eq(stockItems.warehouseId, input.fromWarehouseId),
            eq(stockItems.status, 'IN_STOCK'),
            isNull(stockItems.deletedAt),
          ),
        );
      transferred += result.rowCount ?? 0;
    }

    return { transferred, requested: input.stockItemIds.length };
  }

  // ----------------------------------------------------------------
  // Allocate stock to an order (FIFO)
  //
  // Old: StockItemServices.AllocateStockToOrder / SellItemFifo
  // No GL posting here — GL happens at invoice time
  // ----------------------------------------------------------------

  async allocateToOrder(
    companyId: string,
    orderId: string,
    productId: string,
    warehouseId: string,
    quantity: number,
  ) {
    const available = await this.db
      .select()
      .from(stockItems)
      .where(
        and(
          eq(stockItems.productId, productId),
          eq(stockItems.companyId, companyId),
          eq(stockItems.warehouseId, warehouseId),
          eq(stockItems.status, 'IN_STOCK'),
          isNull(stockItems.deletedAt),
        ),
      )
      .orderBy(asc(stockItems.createdAt)) // FIFO
      .limit(quantity);

    if (available.length < quantity) {
      return {
        allocated: available.length,
        requested: quantity,
        shortfall: quantity - available.length,
      };
    }

    const dateNow = new Date();
    for (const item of available) {
      await this.db
        .update(stockItems)
        .set({
          status: 'ALLOCATED',
          salesOrderId: orderId,
          updatedAt: dateNow,
        })
        .where(eq(stockItems.id, item.id));
    }

    return { allocated: available.length, requested: quantity, shortfall: 0 };
  }

  // ----------------------------------------------------------------
  // Deallocate stock from an order
  //
  // Old: CustomerOrderServices.DeallocateOrderUpdatedVersion
  // ----------------------------------------------------------------

  async deallocateFromOrder(companyId: string, orderId: string, productId?: string) {
    const conditions = [
      eq(stockItems.companyId, companyId),
      eq(stockItems.salesOrderId, orderId),
      eq(stockItems.status, 'ALLOCATED'),
      isNull(stockItems.deletedAt),
    ];
    if (productId) conditions.push(eq(stockItems.productId, productId));

    const result = await this.db
      .update(stockItems)
      .set({
        status: 'IN_STOCK',
        salesOrderId: null,
        updatedAt: new Date(),
      })
      .where(and(...conditions));

    return { deallocated: result.rowCount ?? 0 };
  }

  // ----------------------------------------------------------------
  // Mark allocated stock as SOLD (called during invoice creation)
  //
  // Old: StockItemServices.StockItemSale / SellItemFifo
  // ----------------------------------------------------------------

  async markAsSold(orderId: string, companyId: string) {
    const dateNow = new Date();
    const dateStr = dateNow.toISOString().slice(0, 10);

    const result = await this.db
      .update(stockItems)
      .set({
        status: 'SOLD',
        bookedOutDate: dateStr,
        updatedAt: dateNow,
      })
      .where(
        and(
          eq(stockItems.salesOrderId, orderId),
          eq(stockItems.companyId, companyId),
          eq(stockItems.status, 'ALLOCATED'),
          isNull(stockItems.deletedAt),
        ),
      );

    return { sold: result.rowCount ?? 0 };
  }

  // ----------------------------------------------------------------
  // Stock Valuation Report
  //
  // Old: StockItemServices.GetStockReportByDate
  // ----------------------------------------------------------------

  async getStockReport(companyId: string, query: StockReportQueryInput) {
    const conditions = [
      eq(stockItems.companyId, companyId),
      eq(stockItems.status, 'IN_STOCK'),
      isNull(stockItems.deletedAt),
    ];
    if (query.warehouseId) conditions.push(eq(stockItems.warehouseId, query.warehouseId));
    if (query.productId) conditions.push(eq(stockItems.productId, query.productId));

    const rows = await this.db
      .select({
        productId: stockItems.productId,
        productName: products.name,
        stockCode: products.stockCode,
        warehouseId: stockItems.warehouseId,
        totalQuantity: sql<number>`sum(${stockItems.quantity})`,
        totalValue: sql<number>`sum(cast(${stockItems.value} as numeric) * ${stockItems.quantity})`,
        avgUnitCost: sql<number>`avg(cast(${stockItems.value} as numeric))`,
      })
      .from(stockItems)
      .innerJoin(products, eq(stockItems.productId, products.id))
      .where(and(...conditions))
      .groupBy(stockItems.productId, products.name, products.stockCode, stockItems.warehouseId)
      .orderBy(products.name);

    const grandTotal = rows.reduce((sum, r) => sum + Number(r.totalValue ?? 0), 0);

    return { lines: rows, grandTotal: roundMoney(grandTotal) };
  }

  // ----------------------------------------------------------------
  // Check serial number uniqueness
  //
  // Old: StockItemServices.CheckSerialNumberExist
  // ----------------------------------------------------------------

  async checkSerialNumber(serialNumber: string, companyId: string): Promise<boolean> {
    const existing = await this.db.query.stockItems.findFirst({
      where: and(
        eq(stockItems.serialNumber, serialNumber),
        eq(stockItems.companyId, companyId),
        isNull(stockItems.deletedAt),
      ),
    });
    return !!existing;
  }
}

export class StockValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StockValidationError';
  }
}

import { eq, and, isNull, count } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getDb, getPool } from '../../config/database.js';
import {
  goodsReceivedNotes, grnLines, purchaseOrderLines, stockItems, products,
} from '../../db/schema/index.js';
import * as schema from '../../db/schema/index.js';
import { LucaGLService } from '../../integrations/luca/luca-gl.service.js';
import { PurchaseOrderService } from './purchase-order.service.js';
import type { CreateGRNInput } from './purchase-order.schema.js';
import { roundMoney } from '../../shared/utils/currency.js';

/**
 * GRNService — Goods Received Note (book-in stock) with GL posting.
 *
 * When goods arrive against a PO, this service:
 *   1. Creates a GRN record and GRN lines
 *   2. Creates stock items for each booked-in unit
 *   3. Updates PO line quantities
 *   4. Posts a MANUAL_JOURNAL to Luca: Debit Stock (1150), Credit GRNI Accrual (2310)
 *
 * Source: Libraries/DSB.Service/Purchases/GoodsReceivedNoteServices.cs
 *   InsertBookIn, Insert, MarkPurchaseOrderStatus
 * GL source: Libraries/DSB.Service/Ledgers/GeneralLedgerServices.cs
 *   LedgerEntryFromBookInStockLineObject (lines 3192-3299)
 */
export class GRNService {
  private db = getDb();
  private lucaGL = new LucaGLService();
  private poService = new PurchaseOrderService();

  // ── List GRNs for a PO ──

  async listByPO(purchaseOrderId: string) {
    return this.db.query.goodsReceivedNotes.findMany({
      where: and(
        eq(goodsReceivedNotes.purchaseOrderId, purchaseOrderId),
        isNull(goodsReceivedNotes.deletedAt),
      ),
      with: { lines: { with: { product: true } } },
      orderBy: (g, { desc }) => [desc(g.createdAt)],
    });
  }

  // ── Get by ID ──

  async getById(id: string, companyId: string) {
    return this.db.query.goodsReceivedNotes.findFirst({
      where: and(
        eq(goodsReceivedNotes.id, id),
        eq(goodsReceivedNotes.companyId, companyId),
        isNull(goodsReceivedNotes.deletedAt),
      ),
      with: {
        purchaseOrder: { with: { supplier: true } },
        lines: { with: { product: true } },
      },
    });
  }

  // ── Book In Stock (THE main operation) — triggers GL ──

  async bookIn(
    purchaseOrderId: string,
    companyId: string,
    userId: string,
    input: CreateGRNInput,
  ) {
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      const txDb = drizzle(client, { schema });

      // Load PO with lines and supplier
      const po = await txDb.query.purchaseOrders.findFirst({
        where: and(eq(schema.purchaseOrders.id, purchaseOrderId), eq(schema.purchaseOrders.companyId, companyId)),
        with: { supplier: true, lines: { where: isNull(schema.purchaseOrderLines.deletedAt) } },
      });
      if (!po) throw new GRNValidationError('Purchase order not found');

      // Generate GRN number
      const grnNumber = await this.generateGRNNumber(txDb, companyId);
      const dateBookedIn = input.dateBookedIn ?? new Date().toISOString().slice(0, 10);

      // Create GRN record
      const [grn] = await txDb
        .insert(goodsReceivedNotes)
        .values({
          companyId,
          purchaseOrderId,
          grnNumber,
          dateBookedIn,
          supplierDeliveryNoteNo: input.supplierDeliveryNoteNo,
          status: 'COMPLETED',
        })
        .returning();

      let totalStockValue = 0;

      // Process each GRN line
      for (const lineInput of input.lines) {
        // Find the matching PO line
        const poLine = po.lines.find((l) => l.productId === lineInput.productId);
        if (!poLine) throw new GRNValidationError(`Product ${lineInput.productId} not found on PO`);

        // Load product to check if it's SERVICE type
        const product = await txDb.query.products.findFirst({
          where: eq(schema.products.id, lineInput.productId),
        });
        if (!product) throw new GRNValidationError(`Product ${lineInput.productId} not found`);

        // Determine unit value (from input, PO line, or product expected cost)
        const valuePerUnit = lineInput.valuePerUnit
          ?? Number(poLine.pricePerUnit)
          ?? Number(product.expectedNextCost ?? 0);

        const lineValue = roundMoney(lineInput.quantityBookedIn * valuePerUnit);
        totalStockValue += lineValue;

        // Create GRN line
        await txDb
          .insert(grnLines)
          .values({
            grnId: grn.id,
            productId: lineInput.productId,
            quantity: lineInput.quantityBookedIn,
            qtyBookedIn: lineInput.quantityBookedIn,
          });

        // Create individual stock items (one per unit for serial-tracked, or batch)
        const isSerialTracked = product.requireSerialNumber;
        const warehouseId = po.deliveryWarehouseId ?? product.defaultWarehouseId;

        if (!warehouseId) {
          throw new GRNValidationError(`No warehouse specified for product ${product.name}`);
        }

        if (isSerialTracked && lineInput.serialNumbers) {
          // One stock item per serial number
          for (let i = 0; i < lineInput.quantityBookedIn; i++) {
            await txDb.insert(stockItems).values({
              companyId,
              productId: lineInput.productId,
              warehouseId,
              serialNumber: lineInput.serialNumbers[i] ?? null,
              batchId: lineInput.batchId ?? null,
              locationIsle: lineInput.locationIsle ?? null,
              locationShelf: lineInput.locationShelf ?? null,
              locationBin: lineInput.locationBin ?? null,
              quantity: 1,
              status: 'IN_STOCK',
              bookedInDate: dateBookedIn,
              purchaseOrderId,
              value: valuePerUnit.toString(),
              currencyCode: po.currencyCode,
            });
          }
        } else {
          // Single stock item with quantity
          await txDb.insert(stockItems).values({
            companyId,
            productId: lineInput.productId,
            warehouseId,
            batchId: lineInput.batchId ?? null,
            locationIsle: lineInput.locationIsle ?? null,
            locationShelf: lineInput.locationShelf ?? null,
            locationBin: lineInput.locationBin ?? null,
            quantity: lineInput.quantityBookedIn,
            status: 'IN_STOCK',
            bookedInDate: dateBookedIn,
            purchaseOrderId,
            value: valuePerUnit.toString(),
            currencyCode: po.currencyCode,
          });
        }

        // Update PO line booked-in quantity
        const newQtyBookedIn = (poLine.qtyBookedIn ?? 0) + lineInput.quantityBookedIn;
        const lineDeliveryStatus = newQtyBookedIn >= poLine.quantity ? 'FULLY_RECEIVED' : 'PARTIALLY_RECEIVED';

        await txDb
          .update(purchaseOrderLines)
          .set({
            qtyBookedIn: newQtyBookedIn,
            deliveryStatus: lineDeliveryStatus,
            updatedAt: new Date(),
          })
          .where(eq(purchaseOrderLines.id, poLine.id));

        // Update product expected next cost
        await txDb
          .update(schema.products)
          .set({
            expectedNextCost: valuePerUnit.toString(),
            updatedAt: new Date(),
          })
          .where(eq(schema.products.id, lineInput.productId));
      }

      // ── GL POSTING: Debit Stock, Credit GRNI Accrual ──
      const deliveryCharge = Number(po.deliveryCharge ?? 0);
      const isServicePO = (await txDb.query.products.findFirst({
        where: eq(schema.products.id, input.lines[0].productId),
      }))?.productType === 'SERVICE';

      await this.lucaGL.postGoodsReceivedNote(txDb as any, {
        companyId,
        grnId: grn.id,
        grnNumber,
        poNumber: po.poNumber,
        bookedInDate: new Date(dateBookedIn),
        stockValue: totalStockValue,
        deliveryCharge,
        isService: isServicePO,
      });

      await client.query('COMMIT');

      // Recalculate PO delivery status (outside transaction — non-critical)
      await this.poService.recalculateDeliveryStatus(purchaseOrderId);

      return this.getById(grn.id, companyId);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ── GRN Number Generation ──

  private async generateGRNNumber(db: any, companyId: string): Promise<string> {
    const result = await db
      .select({ count: count() })
      .from(goodsReceivedNotes)
      .where(eq(goodsReceivedNotes.companyId, companyId));
    const num = Number(result[0]?.count ?? 0) + 1;
    return `GRN-${String(num).padStart(6, '0')}`;
  }
}

export class GRNValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GRNValidationError';
  }
}

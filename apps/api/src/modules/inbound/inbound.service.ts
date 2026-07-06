/**
 * Inbound-shipment domain (SPEC F1, §13.4).
 *
 * Pre-order stock pools: customers buy against unarrived shipment stock at a
 * discount scaled to ETA distance. This service owns shipment CRUD, ETA change
 * events, presale allocation (row-locked, no oversell), goods-in reconciliation,
 * and the `getStockAndEta` read model that both the storefront and the sales
 * agent consume.
 *
 * Goods-in inventory bridge (logged in BUILD_LOG entry 4): the existing
 * smmta-next warehouse model is one `stock_items` row = one unit (the storefront
 * reservation service locks rows with FOR UPDATE SKIP LOCKED and availability is
 * the COUNT of IN_STOCK rows — see catalogue.service.ts). So receiving N units
 * of a SKU inserts N `stock_items` rows at status IN_STOCK. We do NOT build a
 * parallel inventory; presale pools live only on the shipment line until goods-in.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import {
  inboundShipments,
  inboundShipmentLines,
  products,
  stockItems,
  warehouses,
  pricingRules,
  type TrackingRef,
} from '../../db/schema/index.js';
import { emitDomainEvent, type DbTx } from '../../shared/events/emit.js';

export type ShipmentMode = 'sea' | 'air' | 'road' | 'rail' | 'courier';
export type ShipmentStatus =
  | 'booked'
  | 'in_transit'
  | 'at_port'
  | 'customs'
  | 'received'
  | 'reconciled';
export type StockBand = 'in_stock' | 'low_stock' | 'out_of_stock';

export class PresaleOversellError extends Error {
  constructor(
    public readonly sku: string,
    public readonly available: number,
    public readonly requested: number,
  ) {
    super(`presale oversell for ${sku}: available ${available}, requested ${requested}`);
    this.name = 'PresaleOversellError';
  }
}

export interface CreateShipmentInput {
  reference: string;
  mode?: ShipmentMode;
  supplier?: string;
  carrier?: string;
  eta: Date;
  bufferPct?: number;
  trackingRefs?: TrackingRef[];
  trackingUrl?: string;
  notes?: string;
  lines: Array<{ sku: string; qtyManifested: number }>;
}

export interface StockAndEta {
  sku: string;
  warehouse: { band: StockBand; availableQty: number };
  inbound: Array<{
    shipmentId: string;
    lineId: string;
    shipmentRef: string;
    mode: ShipmentMode;
    eta: Date;
    presaleAvailable: number;
  }>;
}

/** Presale availability for a line: manifested × (1 − buffer/100) − presold, floor 0. */
export function presaleAvailable(
  qtyManifested: number,
  bufferPct: number,
  qtyPresold: number,
): number {
  const usable = Math.floor((qtyManifested * (100 - bufferPct)) / 100);
  return Math.max(0, usable - qtyPresold);
}

export class InboundService {
  private db = getDb();
  private companyId = getSingletonCompanyId();

  async createShipment(input: CreateShipmentInput) {
    return this.db.transaction(async (tx) => {
      const [shipment] = await tx
        .insert(inboundShipments)
        .values({
          companyId: this.companyId,
          reference: input.reference,
          mode: input.mode ?? 'sea',
          supplier: input.supplier,
          carrier: input.carrier,
          etaOriginal: input.eta,
          eta: input.eta,
          status: 'booked',
          bufferPct: input.bufferPct ?? 8,
          trackingRefs: input.trackingRefs ?? [],
          trackingUrl: input.trackingUrl,
          notes: input.notes,
        })
        .returning();

      if (input.lines.length > 0) {
        await tx.insert(inboundShipmentLines).values(
          input.lines.map((l) => ({
            companyId: this.companyId,
            shipmentId: shipment!.id,
            sku: l.sku,
            qtyManifested: l.qtyManifested,
          })),
        );
      }

      await emitDomainEvent(tx, {
        eventType: 'shipment.created',
        aggregateType: 'shipment',
        aggregateId: shipment!.id,
        payload: {
          shipmentId: shipment!.id,
          reference: shipment!.reference,
          mode: shipment!.mode,
          eta: shipment!.eta.toISOString(),
          bufferPct: shipment!.bufferPct,
          lines: input.lines,
        },
      });
      return shipment!;
    });
  }

  async getShipment(id: string) {
    const [shipment] = await this.db
      .select()
      .from(inboundShipments)
      .where(eq(inboundShipments.id, id))
      .limit(1);
    if (!shipment) return undefined;
    const lines = await this.db
      .select()
      .from(inboundShipmentLines)
      .where(eq(inboundShipmentLines.shipmentId, id));
    return { ...shipment, lines };
  }

  async listShipments() {
    return this.db
      .select()
      .from(inboundShipments)
      .where(eq(inboundShipments.companyId, this.companyId))
      .orderBy(inboundShipments.eta);
  }

  /** Update the ETA; emits shipment.eta_changed with old/new when it moves. */
  async updateEta(shipmentId: string, newEta: Date) {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(inboundShipments)
        .where(eq(inboundShipments.id, shipmentId))
        .for('update');
      if (!current) throw new Error('shipment not found');
      const oldEta = current.eta;
      if (oldEta.getTime() === newEta.getTime()) return current;

      const [updated] = await tx
        .update(inboundShipments)
        .set({ eta: newEta, updatedAt: new Date() })
        .where(eq(inboundShipments.id, shipmentId))
        .returning();
      await emitDomainEvent(tx, {
        eventType: 'shipment.eta_changed',
        aggregateType: 'shipment',
        aggregateId: shipmentId,
        payload: {
          shipmentId,
          oldEta: oldEta.toISOString(),
          newEta: newEta.toISOString(),
        },
      });
      return updated!;
    });
  }

  async setStatus(shipmentId: string, status: ShipmentStatus) {
    const [updated] = await this.db
      .update(inboundShipments)
      .set({ status, updatedAt: new Date() })
      .where(eq(inboundShipments.id, shipmentId))
      .returning();
    if (!updated) throw new Error('shipment not found');
    return updated;
  }

  async setTrackingRefs(shipmentId: string, refs: TrackingRef[]) {
    const [updated] = await this.db
      .update(inboundShipments)
      .set({ trackingRefs: refs, updatedAt: new Date() })
      .where(eq(inboundShipments.id, shipmentId))
      .returning();
    if (!updated) throw new Error('shipment not found');
    return updated;
  }

  /**
   * Allocate presale qty against a shipment line, row-locked so two concurrent
   * allocations for the last unit can never both win (§13.4). Throws
   * PresaleOversellError rather than overselling.
   */
  async allocatePresale(shipmentId: string, sku: string, qty: number): Promise<void> {
    await this.db.transaction((tx) => this.allocatePresaleTx(tx, shipmentId, sku, qty));
  }

  /** Transaction-aware presale allocation, so callers (e.g. pre-order creation)
   *  can allocate stock atomically with their own writes. Row-locks the line. */
  async allocatePresaleTx(tx: DbTx, shipmentId: string, sku: string, qty: number): Promise<void> {
    if (qty <= 0 || !Number.isInteger(qty)) throw new Error(`invalid presale qty ${qty}`);
    const [line] = await tx
      .select({
        id: inboundShipmentLines.id,
        qtyManifested: inboundShipmentLines.qtyManifested,
        qtyPresold: inboundShipmentLines.qtyPresold,
        bufferPct: inboundShipments.bufferPct,
      })
      .from(inboundShipmentLines)
      .innerJoin(inboundShipments, eq(inboundShipmentLines.shipmentId, inboundShipments.id))
      .where(and(eq(inboundShipmentLines.shipmentId, shipmentId), eq(inboundShipmentLines.sku, sku)))
      .for('update'); // locks the line row (and joined shipment row) for this tx
    if (!line) throw new Error(`shipment line not found for ${sku}`);

    const available = presaleAvailable(line.qtyManifested, line.bufferPct, line.qtyPresold);
    if (available < qty) throw new PresaleOversellError(sku, available, qty);

    await tx
      .update(inboundShipmentLines)
      .set({ qtyPresold: line.qtyPresold + qty })
      .where(eq(inboundShipmentLines.id, line.id));
  }

  /** Release presale qty (cancel/lapse). Floors qtyPresold at 0. */
  async releasePresale(shipmentId: string, sku: string, qty: number): Promise<void> {
    if (qty <= 0) return;
    await this.db.transaction((tx) => this.releasePresaleTx(tx, shipmentId, sku, qty));
  }

  async releasePresaleTx(tx: DbTx, shipmentId: string, sku: string, qty: number): Promise<void> {
    if (qty <= 0) return;
    const [line] = await tx
      .select()
      .from(inboundShipmentLines)
      .where(and(eq(inboundShipmentLines.shipmentId, shipmentId), eq(inboundShipmentLines.sku, sku)))
      .for('update');
    if (!line) return;
    await tx
      .update(inboundShipmentLines)
      .set({ qtyPresold: Math.max(0, line.qtyPresold - qty) })
      .where(eq(inboundShipmentLines.id, line.id));
  }

  /**
   * Goods-in: record qty_received per line, transfer received units into the
   * warehouse (insert IN_STOCK stock_items), and emit shipment.arrived +
   * shipment.short_shipped (variance) + stock.allocation_broken (received <
   * presold). Sets the shipment status to received.
   */
  async goodsIn(
    shipmentId: string,
    receipts: Array<{ sku: string; qtyReceived: number }>,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [shipment] = await tx
        .select()
        .from(inboundShipments)
        .where(eq(inboundShipments.id, shipmentId))
        .for('update');
      if (!shipment) throw new Error('shipment not found');

      const lines = await tx
        .select()
        .from(inboundShipmentLines)
        .where(eq(inboundShipmentLines.shipmentId, shipmentId));

      const variances: Array<{ sku: string; manifested: number; received: number }> = [];

      for (const receipt of receipts) {
        const line = lines.find((l) => l.sku === receipt.sku);
        if (!line) throw new Error(`goods-in: no manifested line for ${receipt.sku}`);

        await tx
          .update(inboundShipmentLines)
          .set({ qtyReceived: receipt.qtyReceived })
          .where(eq(inboundShipmentLines.id, line.id));

        if (receipt.qtyReceived < line.qtyManifested) {
          variances.push({
            sku: receipt.sku,
            manifested: line.qtyManifested,
            received: receipt.qtyReceived,
          });
        }

        // Allocation broken: a short-shipment left us with fewer units than we
        // already presold.
        if (receipt.qtyReceived < line.qtyPresold) {
          await emitDomainEvent(tx, {
            eventType: 'stock.allocation_broken',
            aggregateType: 'stock',
            aggregateId: shipmentId,
            payload: {
              sku: receipt.sku,
              shipmentId,
              received: receipt.qtyReceived,
              presold: line.qtyPresold,
              shortfall: line.qtyPresold - receipt.qtyReceived,
            },
          });
        }

        // Bridge received units into warehouse inventory.
        if (receipt.qtyReceived > 0) {
          const wasRestocked = await this.receiveIntoWarehouse(tx, receipt.sku, receipt.qtyReceived);
          // out→in transition → back-in-stock trigger (§12.4).
          if (wasRestocked) {
            await emitDomainEvent(tx, {
              eventType: 'stock.replenished',
              aggregateType: 'stock',
              aggregateId: shipmentId,
              payload: { sku: receipt.sku, qty: receipt.qtyReceived, pool: 'warehouse' },
            });
          }
        }
      }

      await tx
        .update(inboundShipments)
        .set({ status: 'received', arrivedAt: new Date(), updatedAt: new Date() })
        .where(eq(inboundShipments.id, shipmentId));

      await emitDomainEvent(tx, {
        eventType: 'shipment.arrived',
        aggregateType: 'shipment',
        aggregateId: shipmentId,
        payload: { shipmentId, reference: shipment.reference, receipts },
      });

      if (variances.length > 0) {
        await emitDomainEvent(tx, {
          eventType: 'shipment.short_shipped',
          aggregateType: 'shipment',
          aggregateId: shipmentId,
          payload: { shipmentId, variances },
        });
      }
    });
  }

  /** Returns true if the SKU went from 0 IN_STOCK to >0 (a restock transition). */
  private async receiveIntoWarehouse(tx: DbTx, sku: string, qty: number): Promise<boolean> {
    const [product] = await tx
      .select({ id: products.id, defaultWarehouseId: products.defaultWarehouseId })
      .from(products)
      .where(and(eq(products.companyId, this.companyId), eq(products.stockCode, sku)))
      .limit(1);
    if (!product) throw new Error(`goods-in: no product with stock code ${sku}`);

    const [{ n: priorInStock }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(stockItems)
      .where(and(eq(stockItems.productId, product.id), eq(stockItems.status, 'IN_STOCK')));

    let warehouseId = product.defaultWarehouseId;
    if (!warehouseId) {
      const [wh] = await tx
        .select({ id: warehouses.id })
        .from(warehouses)
        .where(eq(warehouses.companyId, this.companyId))
        .limit(1);
      if (!wh) throw new Error('goods-in: no warehouse configured to receive stock into');
      warehouseId = wh.id;
    }

    // One row = one unit (matches the reservation/availability model).
    const rows = Array.from({ length: qty }, () => ({
      companyId: this.companyId,
      productId: product.id,
      warehouseId: warehouseId!,
      quantity: 1,
      status: 'IN_STOCK' as const,
    }));
    await tx.insert(stockItems).values(rows);
    return priorInStock === 0 && qty > 0;
  }

  private _lowStockThreshold: number | undefined;
  private async lowStockThreshold(): Promise<number> {
    if (this._lowStockThreshold !== undefined) return this._lowStockThreshold;
    const [rule] = await this.db
      .select({ t: pricingRules.lowStockThreshold })
      .from(pricingRules)
      .where(and(eq(pricingRules.companyId, this.companyId), isNull(pricingRules.category)))
      .limit(1);
    this._lowStockThreshold = rule?.t ?? 10;
    return this._lowStockThreshold;
  }

  /**
   * The single source of truth for "what's available now and what's coming"
   * for one SKU (§13.4). Warehouse band from IN_STOCK row count vs the
   * pricing_rules threshold, plus every unarrived inbound pool with its exact
   * presale availability.
   */
  async getStockAndEta(sku: string): Promise<StockAndEta> {
    const [product] = await this.db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.companyId, this.companyId), eq(products.stockCode, sku)))
      .limit(1);

    let availableQty = 0;
    if (product) {
      const [{ n }] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(stockItems)
        .where(and(eq(stockItems.productId, product.id), eq(stockItems.status, 'IN_STOCK')));
      availableQty = n;
    }

    const threshold = await this.lowStockThreshold();
    const band: StockBand =
      availableQty <= 0 ? 'out_of_stock' : availableQty <= threshold ? 'low_stock' : 'in_stock';

    // Unarrived pools carrying this SKU.
    const rows = await this.db
      .select({
        shipmentId: inboundShipments.id,
        lineId: inboundShipmentLines.id,
        shipmentRef: inboundShipments.reference,
        mode: inboundShipments.mode,
        eta: inboundShipments.eta,
        bufferPct: inboundShipments.bufferPct,
        qtyManifested: inboundShipmentLines.qtyManifested,
        qtyPresold: inboundShipmentLines.qtyPresold,
        arrivedAt: inboundShipments.arrivedAt,
      })
      .from(inboundShipmentLines)
      .innerJoin(inboundShipments, eq(inboundShipmentLines.shipmentId, inboundShipments.id))
      .where(
        and(
          eq(inboundShipmentLines.companyId, this.companyId),
          eq(inboundShipmentLines.sku, sku),
          isNull(inboundShipments.arrivedAt),
        ),
      );

    const inbound = rows.map((r) => ({
      shipmentId: r.shipmentId,
      lineId: r.lineId,
      shipmentRef: r.shipmentRef,
      mode: r.mode as ShipmentMode,
      eta: r.eta,
      presaleAvailable: presaleAvailable(r.qtyManifested, r.bufferPct, r.qtyPresold),
    }));

    return { sku, warehouse: { band, availableQty }, inbound };
  }
}

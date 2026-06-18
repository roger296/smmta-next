/**
 * StockLevelService — applies movements to the per-(product, site) ledger and
 * keeps the `stock_levels.on_hand` cache in lock-step (spec §A5).
 *
 * On-hand is the running sum of an auditable `stock_movements` ledger, never a
 * bare counter. `applyMovement` writes one ledger row and increments the cache
 * atomically in a single transaction; it is idempotent on the movement's
 * `(source_system, source_key, content_hash)` key, so a replayed Square sale or
 * a re-run daily sweep is a no-op. `recomputeOnHand` re-derives the cache from
 * the ledger (used by tests and a repair path).
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { stockLevels, stockMovements } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';

// The transaction handle drizzle hands to `db.transaction(async (tx) => …)`.
type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

export type StockMovementType =
  | 'GRN'
  | 'ADJUSTMENT'
  | 'SALE'
  | 'CONSUMPTION'
  | 'WASTAGE'
  | 'TRANSFER_IN'
  | 'TRANSFER_OUT'
  | 'STOCKTAKE_TRUE_UP'
  | 'OPENING';

export interface MovementInput {
  productId: string;
  siteId: string;
  /** Signed quantity in the product's stock_uom. */
  qtyDelta: number | string;
  movementType: StockMovementType;
  sourceSystem: string;
  sourceKey: string;
  /** Per-movement idempotency discriminator (e.g. a payload hash). */
  contentHash: string;
  unitCost?: number | string | null;
  currencyCode?: string;
  occurredAt?: Date;
  companyId?: string;
}

export interface ApplyResult {
  /** false ⇒ the movement was a duplicate (idempotent no-op). */
  applied: boolean;
  movementId: string | null;
  /** Resulting on-hand for the (product, site), as a numeric string. */
  onHand: string;
}

export class StockLevelService {
  private db = getDb();

  /**
   * Apply a single movement: append the ledger row and increment the on-hand
   * cache atomically. Idempotent on (source_system, source_key, content_hash).
   */
  async applyMovement(input: MovementInput): Promise<ApplyResult> {
    return this.db.transaction((tx) => this.applyInTx(tx, input));
  }

  /** The core apply, parameterised by a transaction so a transfer can run both
   *  legs in one transaction. */
  private async applyInTx(tx: Tx, input: MovementInput): Promise<ApplyResult> {
    const companyId = input.companyId ?? getSingletonCompanyId();
    const qtyDelta = String(input.qtyDelta);

    {
      // 1. Ledger row — no-op insert if this exact movement already landed.
      const inserted = await tx
        .insert(stockMovements)
        .values({
          companyId,
          productId: input.productId,
          siteId: input.siteId,
          qtyDelta,
          movementType: input.movementType,
          sourceSystem: input.sourceSystem,
          sourceKey: input.sourceKey,
          contentHash: input.contentHash,
          unitCost: input.unitCost != null ? String(input.unitCost) : null,
          currencyCode: input.currencyCode ?? 'GBP',
          ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
        })
        .onConflictDoNothing({
          target: [
            stockMovements.sourceSystem,
            stockMovements.sourceKey,
            stockMovements.contentHash,
          ],
        })
        .returning({ id: stockMovements.id });

      if (inserted.length === 0) {
        // Duplicate — leave on-hand untouched, return what's already there.
        const level = await tx.query.stockLevels.findFirst({
          where: and(
            eq(stockLevels.companyId, companyId),
            eq(stockLevels.productId, input.productId),
            eq(stockLevels.siteId, input.siteId),
          ),
          columns: { onHand: true },
        });
        return { applied: false, movementId: null, onHand: level?.onHand ?? '0' };
      }

      // 2. On-hand cache — create the row or increment it by the delta.
      const upserted = await tx
        .insert(stockLevels)
        .values({
          companyId,
          productId: input.productId,
          siteId: input.siteId,
          onHand: qtyDelta,
        })
        .onConflictDoUpdate({
          target: [stockLevels.companyId, stockLevels.productId, stockLevels.siteId],
          set: {
            onHand: sql`${stockLevels.onHand} + ${qtyDelta}::numeric`,
            updatedAt: new Date(),
          },
        })
        .returning({ onHand: stockLevels.onHand });

      return { applied: true, movementId: inserted[0]!.id, onHand: upserted[0]!.onHand };
    }
  }

  /**
   * Manual stock adjustment — an ADJUSTMENT movement (signed). Idempotent on
   * `idempotencyKey` if given, otherwise each call is a distinct adjustment.
   */
  async adjust(params: {
    productId: string;
    siteId: string;
    qtyDelta: number | string;
    unitCost?: number | string | null;
    idempotencyKey?: string;
    companyId?: string;
  }): Promise<ApplyResult> {
    return this.applyMovement({
      productId: params.productId,
      siteId: params.siteId,
      qtyDelta: params.qtyDelta,
      movementType: 'ADJUSTMENT',
      sourceSystem: 'manual',
      sourceKey: params.idempotencyKey ?? randomUUID(),
      contentHash: 'adjust',
      unitCost: params.unitCost,
      companyId: params.companyId,
    });
  }

  /**
   * Inter-site transfer — paired TRANSFER_OUT / TRANSFER_IN movements applied in
   * ONE transaction so total quantity is conserved. Idempotent on `sourceKey`
   * (the two legs share the key, distinguished by content_hash out/in).
   */
  async transfer(params: {
    productId: string;
    fromSiteId: string;
    toSiteId: string;
    qty: number;
    unitCost?: number | string | null;
    sourceKey?: string;
    companyId?: string;
  }): Promise<{ out: ApplyResult; in: ApplyResult }> {
    if (params.qty <= 0) throw new RangeError('transfer qty must be positive');
    if (params.fromSiteId === params.toSiteId) {
      throw new RangeError('transfer source and destination sites must differ');
    }
    const sourceKey = params.sourceKey ?? randomUUID();
    return this.db.transaction(async (tx) => {
      const out = await this.applyInTx(tx, {
        productId: params.productId,
        siteId: params.fromSiteId,
        qtyDelta: -params.qty,
        movementType: 'TRANSFER_OUT',
        sourceSystem: 'transfer',
        sourceKey,
        contentHash: 'out',
        unitCost: params.unitCost,
        companyId: params.companyId,
      });
      const incoming = await this.applyInTx(tx, {
        productId: params.productId,
        siteId: params.toSiteId,
        qtyDelta: params.qty,
        movementType: 'TRANSFER_IN',
        sourceSystem: 'transfer',
        sourceKey,
        contentHash: 'in',
        unitCost: params.unitCost,
        companyId: params.companyId,
      });
      return { out, in: incoming };
    });
  }

  /**
   * Re-derive on-hand for a (product, site) straight from the ledger and write
   * it back to the cache. The reconcile / repair path; also handy in tests to
   * assert the cache never drifts from Σ(qty_delta).
   */
  async recomputeOnHand(productId: string, siteId: string, companyId?: string): Promise<string> {
    const cid = companyId ?? getSingletonCompanyId();
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select({
          sum: sql<string>`coalesce(sum(${stockMovements.qtyDelta}), 0)`,
        })
        .from(stockMovements)
        .where(
          and(
            eq(stockMovements.companyId, cid),
            eq(stockMovements.productId, productId),
            eq(stockMovements.siteId, siteId),
          ),
        );
      const onHand = rows[0]?.sum ?? '0';
      await tx
        .insert(stockLevels)
        .values({ companyId: cid, productId, siteId, onHand })
        .onConflictDoUpdate({
          target: [stockLevels.companyId, stockLevels.productId, stockLevels.siteId],
          set: { onHand, updatedAt: new Date() },
        });
      return onHand;
    });
  }

  /** Current cached on-hand for a (product, site); '0' if no row yet. */
  async getOnHand(productId: string, siteId: string, companyId?: string): Promise<string> {
    const cid = companyId ?? getSingletonCompanyId();
    const level = await this.db.query.stockLevels.findFirst({
      where: and(
        eq(stockLevels.companyId, cid),
        eq(stockLevels.productId, productId),
        eq(stockLevels.siteId, siteId),
      ),
      columns: { onHand: true },
    });
    return level?.onHand ?? '0';
  }
}

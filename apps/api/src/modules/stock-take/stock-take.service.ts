/**
 * StockTakeService (P9, spec §A6).
 *
 * `open` snapshots book stock for the scope into lines; `recordCount(s)` writes
 * counted quantities + variance (offline-tolerant via a client idempotency
 * key); `approve` writes a STOCKTAKE_TRUE_UP movement for each varianced line
 * and posts ONE stock adjustment to Xero, then marks the take APPROVED.
 * `approve` is idempotent — re-approving an APPROVED take re-applies nothing.
 */
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import {
  itemCategories,
  products,
  stockLevels,
  stockTakeLines,
  stockTakes,
} from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { StockLevelService } from '../stock/stock-level.service.js';
import { getStockGLService } from '../../integrations/gl-provider.js';
import type { Actor } from '../../shared/auth/actor.js';

export type StockTake = typeof stockTakes.$inferSelect;
export type StockTakeLine = typeof stockTakeLines.$inferSelect;
export type StockTakeScope = 'FULL' | 'CATEGORY' | 'ZONE' | 'ITEM' | 'CYCLE';

/**
 * A take line WITH the product identity the counter needs (defect D-1b).
 *
 * Opening a take used to return bare `stock_take_lines` rows — `productId` and
 * `bookQty` and nothing else — so the count screen had to make a second,
 * larger, fallible request just to learn what it was asking someone to count.
 * On 12 Aug that request 400d and every row rendered as an eight-character hex
 * fragment; not a single count could be logged. The screen should never have
 * needed a second request to name its own rows.
 */
export interface StockTakeLineWithProduct extends StockTakeLine {
  productName: string | null;
  stockCode: string | null;
  stockUom: string | null;
  itemKind: string | null;
  /** Per-product counting quantum, in the product's own stock UoM. NULL = do
   *  not bucket this count (the only safe default — see defect D-2). */
  countQuantum: string | null;
  /**
   * What this item's counter is told at the shelf, set per product by head
   * office ("weigh, do not count"). NULL means the screen falls back to a
   * sentence built from the stock unit.
   *
   * It travels ON THE LINE for the same reason the name does: the count screen
   * must not need a second request to say what it is asking for. Sourced from
   * the product map instead, a failing lookup would quietly downgrade every
   * operator instruction to the generic wording, and nothing would say so.
   */
  stockCheckInstruction: string | null;
  /**
   * The operator's Item Category, used to split the count sheet into sections
   * (Sept-2026 request). NULL groups under "Uncategorised".
   *
   * On the line, like the name and the instruction — the count screen must not
   * need a second request to lay itself out, and a failed lookup that silently
   * collapsed every section into one would look exactly like a catalogue where
   * nobody had set categories.
   */
  itemCategoryName: string | null;
}

/**
 * A count that is legal but worth a second look before the ledger is trued up
 * to it (Aug-2026 feedback, defect D-2).
 *
 * `countedQty: z.coerce.number().min(0)` accepts 0 without complaint, and
 * approval writes that 0 straight into the ledger. When D-2 was rounding 4 kg
 * counts down to zero, nothing anywhere said a word. A zeroed line against a
 * non-zero book figure is now called out by name.
 */
export interface StockTakeWarning {
  productId: string;
  productName: string | null;
  kind: 'COUNTED_TO_ZERO';
  bookQty: number;
  countedQty: number;
  message: string;
}

/**
 * A take as the "join a count" list shows it: enough for a second counter to
 * pick the right take and see how far it has got, without opening every one.
 */
export interface StockTakeWithProgress extends StockTake {
  lineCount: number;
  countedCount: number;
  /** Everyone who has saved a count on this take, A→Z. */
  counters: string[];
  lastCountedAt: Date | null;
}

/** Counting into a take that is no longer OPEN. Approval has already trued the
 *  ledger up, so a count saved now would be stored and then never used. */
export class StockTakeClosedError extends Error {
  constructor(public readonly status: string) {
    super(
      status === 'APPROVED'
        ? 'This stock-take has already been approved, so these counts can no longer be added to it. Start a new count for anything that still needs counting.'
        : `This stock-take is ${status.toLowerCase()} and no longer takes counts.`,
    );
    this.name = 'StockTakeClosedError';
  }
}

export class StockTakeService {
  private db = getDb();
  private levels = new StockLevelService();

  /** Open a take, snapshotting book stock for the scope into lines. */
  async open(input: {
    siteId: string;
    scope: StockTakeScope;
    scopeRef?: string | null;
    companyId?: string;
    openedBy?: Actor;
  }): Promise<{ take: StockTake; lines: StockTakeLineWithProduct[] }> {
    const companyId = input.companyId ?? getSingletonCompanyId();

    const where = [eq(stockLevels.companyId, companyId), eq(stockLevels.siteId, input.siteId)];
    if (input.scope === 'CATEGORY' && input.scopeRef) {
      where.push(eq(products.categoryId, input.scopeRef));
    } else if (input.scope === 'ITEM' && input.scopeRef) {
      where.push(eq(products.id, input.scopeRef));
    }
    // FULL / CYCLE / ZONE count everything at the site (no zone data in v1).
    const inScope = await this.db
      .select({ productId: stockLevels.productId, onHand: stockLevels.onHand })
      .from(stockLevels)
      .innerJoin(products, eq(products.id, stockLevels.productId))
      .where(and(...where));

    const [take] = await this.db
      .insert(stockTakes)
      .values({
        companyId,
        siteId: input.siteId,
        scope: input.scope,
        scopeRef: input.scopeRef ?? null,
        openedByUserId: input.openedBy?.userId ?? null,
        openedByName: input.openedBy?.name ?? null,
      })
      .returning();

    for (const row of inScope) {
      await this.db
        .insert(stockTakeLines)
        .values({ stockTakeId: take!.id, productId: row.productId, bookQty: row.onHand });
    }
    // Re-read through the join so the caller gets the identity in one round
    // trip. A LEFT join, not an inner one: a line whose product was later
    // deleted must still come back (with nulls) rather than vanishing from the
    // count sheet or throwing.
    return { take: take!, lines: await this.linesWithProduct(take!.id) };
  }

  /** Record a single count. Offline-idempotent on `countIdempotencyKey`. */
  async recordCount(input: {
    stockTakeId: string;
    productId: string;
    countedQty: number;
    countIdempotencyKey?: string;
    photoRefs?: unknown;
    /** Who is saving this count. Recorded on the line so every counter on the
     *  take can see whose number it is. */
    countedBy?: Actor;
  }): Promise<StockTakeLine | null> {
    const line = await this.db.query.stockTakeLines.findFirst({
      where: and(
        eq(stockTakeLines.stockTakeId, input.stockTakeId),
        eq(stockTakeLines.productId, input.productId),
      ),
    });
    if (!line) return null;
    // Offline replay guard: same key already recorded → no-op.
    if (
      input.countIdempotencyKey &&
      line.countIdempotencyKey === input.countIdempotencyKey &&
      line.countedQty != null
    ) {
      return line;
    }
    const variance = input.countedQty - Number(line.bookQty);
    const [updated] = await this.db
      .update(stockTakeLines)
      .set({
        countedQty: String(input.countedQty),
        variance: String(variance),
        countIdempotencyKey: input.countIdempotencyKey ?? line.countIdempotencyKey,
        photoRefs: (input.photoRefs as Record<string, unknown> | undefined) ?? line.photoRefs,
        // The LAST person to save the line is its counter: the number on the
        // line is theirs. A second counter re-saving someone else's line
        // takes it over, and the screen warns them before they do.
        countedByUserId: input.countedBy?.userId ?? null,
        countedByName: input.countedBy?.name ?? null,
        countedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(stockTakeLines.id, line.id))
      .returning();
    return updated ?? null;
  }

  /**
   * Record a batch of counts from one counter.
   *
   * Refuses a take that is no longer OPEN (StockTakeClosedError). Before two
   * people shared a take this could not really happen; now one counter can
   * approve while the other is still saving, and a count written to an
   * approved take is stored and never used — the worst kind of lost work,
   * because nothing says it was lost.
   */
  async recordCounts(
    stockTakeId: string,
    counts: Array<{ productId: string; countedQty: number; countIdempotencyKey?: string }>,
    countedBy?: Actor,
  ): Promise<number> {
    const take = await this.db.query.stockTakes.findFirst({
      where: eq(stockTakes.id, stockTakeId),
      columns: { status: true },
    });
    if (take && take.status !== 'OPEN') throw new StockTakeClosedError(take.status);
    let n = 0;
    for (const c of counts) {
      const r = await this.recordCount({ stockTakeId, ...c, countedBy });
      if (r) n += 1;
    }
    return n;
  }

  /** Approve: true-up the ledger for each varianced line + post one adjustment. */
  async approve(stockTakeId: string, companyId = getSingletonCompanyId()): Promise<StockTake | null> {
    const take = await this.db.query.stockTakes.findFirst({
      where: and(eq(stockTakes.id, stockTakeId), eq(stockTakes.companyId, companyId)),
    });
    if (!take) return null;
    if (take.status !== 'OPEN') return take; // idempotent — already approved/cancelled

    const lines = await this.db
      .select()
      .from(stockTakeLines)
      .where(
        and(eq(stockTakeLines.stockTakeId, stockTakeId), isNotNull(stockTakeLines.countedQty)),
      );

    let netValue = 0;
    for (const line of lines) {
      const variance = Number(line.variance ?? 0);
      if (variance === 0) continue;
      const product = await this.db.query.products.findFirst({
        where: eq(products.id, line.productId),
      });
      const unitCost = Number(product?.expectedNextCost ?? 0);
      netValue += variance * unitCost;
      await this.levels.applyMovement({
        productId: line.productId,
        siteId: take.siteId,
        qtyDelta: variance,
        movementType: 'STOCKTAKE_TRUE_UP',
        sourceSystem: 'stocktake',
        sourceKey: `stocktake:${stockTakeId}:${line.productId}`,
        contentHash: 'true-up',
        unitCost,
        companyId,
      });
    }

    netValue = Math.round(netValue * 100) / 100;
    if (netValue !== 0) {
      await getStockGLService().postStockAdjustment(this.db, {
        companyId,
        adjustmentId: stockTakeId,
        adjustmentDate: new Date(),
        stockValue: Math.abs(netValue),
        type: netValue > 0 ? 'ADD' : 'REMOVE',
        productName: `Stock-take ${stockTakeId.slice(0, 8)}`,
      });
    }

    const [updated] = await this.db
      .update(stockTakes)
      .set({ status: 'APPROVED', approvedAt: new Date(), updatedAt: new Date() })
      .where(eq(stockTakes.id, stockTakeId))
      .returning();
    return updated ?? null;
  }

  /** Take lines joined to their product identity. See StockTakeLineWithProduct. */
  async linesWithProduct(stockTakeId: string): Promise<StockTakeLineWithProduct[]> {
    const rows = await this.db
      .select({
        line: stockTakeLines,
        productName: products.name,
        stockCode: products.stockCode,
        stockUom: products.stockUom,
        itemKind: products.itemKind,
        countQuantum: products.countQuantum,
        stockCheckInstruction: products.stockCheckInstruction,
        itemCategoryName: itemCategories.name,
      })
      .from(stockTakeLines)
      .leftJoin(products, eq(products.id, stockTakeLines.productId))
      .leftJoin(itemCategories, eq(itemCategories.id, products.itemCategoryId))
      .where(eq(stockTakeLines.stockTakeId, stockTakeId));

    return rows.map((r) => ({
      ...r.line,
      productName: r.productName ?? null,
      stockCode: r.stockCode ?? null,
      stockUom: r.stockUom ?? null,
      itemKind: r.itemKind ?? null,
      countQuantum: r.countQuantum ?? null,
      stockCheckInstruction: r.stockCheckInstruction ?? null,
      itemCategoryName: r.itemCategoryName ?? null,
    }));
  }

  async get(
    id: string,
    companyId = getSingletonCompanyId(),
  ): Promise<{ take: StockTake; lines: StockTakeLineWithProduct[] } | null> {
    const take = await this.db.query.stockTakes.findFirst({
      where: and(eq(stockTakes.id, id), eq(stockTakes.companyId, companyId)),
    });
    if (!take) return null;
    return { take, lines: await this.linesWithProduct(id) };
  }

  /**
   * Lines whose count deserves a look before approval. Today that is exactly
   * one shape: counted to zero against a non-zero book figure. It is a
   * *warning*, not a block — a genuinely empty shelf is a real answer, and
   * refusing it would be worse than flagging it.
   */
  async varianceWarnings(stockTakeId: string): Promise<StockTakeWarning[]> {
    const lines = await this.linesWithProduct(stockTakeId);
    const warnings: StockTakeWarning[] = [];
    for (const line of lines) {
      if (line.countedQty == null) continue;
      const counted = Number(line.countedQty);
      const book = Number(line.bookQty);
      if (counted === 0 && book !== 0) {
        warnings.push({
          productId: line.productId,
          productName: line.productName,
          kind: 'COUNTED_TO_ZERO',
          bookQty: book,
          countedQty: counted,
          message: `${line.productName ?? line.productId} counted as 0 against a book figure of ${book}. Approving will write off the difference.`,
        });
      }
    }
    return warnings;
  }

  /**
   * Takes, newest first, each with its progress and who has been counting.
   *
   * The progress is what lets a second counter JOIN a take rather than open a
   * parallel one: "Full count, started 09:40 by Sam — 45 of 400 counted by Sam
   * and Alex" is enough to know it is the right one. One grouped query for the
   * whole page, not one per take.
   */
  async list(
    filter: { siteId?: string; status?: string; companyId?: string } = {},
  ): Promise<StockTakeWithProgress[]> {
    const companyId = filter.companyId ?? getSingletonCompanyId();
    const where = [eq(stockTakes.companyId, companyId)];
    if (filter.siteId) where.push(eq(stockTakes.siteId, filter.siteId));
    if (filter.status) where.push(eq(stockTakes.status, filter.status as never));
    const takes = await this.db.query.stockTakes.findMany({
      where: and(...where),
      orderBy: (s, { desc }) => [desc(s.createdAt)],
    });
    if (takes.length === 0) return [];

    const progress = await this.db
      .select({
        stockTakeId: stockTakeLines.stockTakeId,
        lineCount: sql<number>`count(*)::int`,
        countedCount: sql<number>`count(${stockTakeLines.countedQty})::int`,
        counters: sql<string[] | null>`array_agg(distinct ${stockTakeLines.countedByName}) filter (where ${stockTakeLines.countedByName} is not null)`,
        lastCountedAt: sql<Date | null>`max(${stockTakeLines.countedAt})`,
      })
      .from(stockTakeLines)
      .where(inArray(stockTakeLines.stockTakeId, takes.map((t) => t.id)))
      .groupBy(stockTakeLines.stockTakeId);
    const byTake = new Map(progress.map((p) => [p.stockTakeId, p]));

    return takes.map((t) => {
      const p = byTake.get(t.id);
      const last = p?.lastCountedAt ?? null;
      return {
        ...t,
        lineCount: p?.lineCount ?? 0,
        countedCount: p?.countedCount ?? 0,
        counters: [...(p?.counters ?? [])].sort((a, b) => a.localeCompare(b)),
        // max() over a timestamptz comes back through `sql` as a string.
        lastCountedAt: last == null ? null : new Date(last as unknown as string),
      };
    });
  }
}

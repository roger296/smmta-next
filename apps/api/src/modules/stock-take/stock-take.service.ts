/**
 * StockTakeService (P9, spec §A6).
 *
 * `open` snapshots book stock for the scope into lines; `recordCount(s)` writes
 * counted quantities + variance (offline-tolerant via a client idempotency
 * key); `approve` writes a STOCKTAKE_TRUE_UP movement for each varianced line
 * and posts ONE stock adjustment to Xero, then marks the take APPROVED.
 * `approve` is idempotent — re-approving an APPROVED take re-applies nothing.
 */
import { and, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { inRange } from './stock-take-dates.js';
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

/**
 * Opening a count while the venue already has one OPEN (Oct 2026).
 *
 * Between 20 Sept and 4 Oct the venues opened 49 counts and approved none: 37
 * were empty, and the rest split one venue's count across several sheets —
 * Birmingham's two counters opened two at 10:45 and 10:46 and each counted
 * into their own, so neither sheet was a count of the venue. The start screen
 * offered to join; it did not insist. A venue now has at most one open count,
 * and the screen joins the one that is running.
 */
export class CountInProgressError extends Error {
  constructor(public readonly openTakes: StockTake[]) {
    super(
      'A count is already running at this venue — join it rather than starting another, so everyone counts onto one sheet.',
    );
    this.name = 'CountInProgressError';
  }
}

/** Cancelling a count that can no longer be cancelled (approved, or gone). */
export class StockTakeNotCancellableError extends Error {
  constructor(public readonly status: string) {
    super(
      status === 'APPROVED'
        ? 'This count has been approved — its figures are in the stock levels, so it cannot be cancelled.'
        : `This count is already ${status.toLowerCase()}.`,
    );
    this.name = 'StockTakeNotCancellableError';
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

    const inScope = await this.inScopeProducts({
      companyId,
      siteId: input.siteId,
      scope: input.scope,
      scopeRef: input.scopeRef ?? null,
    });

    // One open count per venue, enforced under a per-venue transaction lock:
    // checking first and inserting after, unlocked, is exactly how two iPads
    // pressing Start a second apart each got a sheet of their own.
    const take = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'stock-take-open:' + input.siteId}))`);
      const running = await tx
        .select()
        .from(stockTakes)
        .where(
          and(
            eq(stockTakes.companyId, companyId),
            eq(stockTakes.siteId, input.siteId),
            eq(stockTakes.status, 'OPEN'),
          ),
        )
        .orderBy(desc(stockTakes.createdAt));
      if (running.length > 0) throw new CountInProgressError(running);

      const [created] = await tx
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
      // In batches rather than one statement per line: a full sheet is ~640.
      for (let i = 0; i < inScope.length; i += 500) {
        await tx.insert(stockTakeLines).values(
          inScope
            .slice(i, i + 500)
            .map((row) => ({ stockTakeId: created!.id, productId: row.productId, bookQty: row.bookQty })),
        );
      }
      return created!;
    });

    // Re-read through the join so the caller gets the identity in one round
    // trip. A LEFT join, not an inner one: a line whose product was later
    // deleted must still come back (with nulls) rather than vanishing from the
    // count sheet or throwing.
    return { take, lines: await this.linesWithProduct(take.id) };
  }

  /**
   * What belongs on a count sheet at this site: every LIVE, STOCKED product in
   * scope, with its book figure there — or 0 where the site has never held it.
   *
   * ⚠️ Driven from `products`, NOT from `stock_levels`. It used to select from
   * `stock_levels` alone, and a site only gets a level row once something has
   * happened to a product there (a delivery, a true-up) or a seeding script
   * made one. `seed-reorder-levels.ts` made one for every product that existed
   * when it ran; every product added afterwards (~110 from 17 Sept on, e.g.
   * COCK-SUMM-CRUM) was simply absent from every venue's sheet — reported at
   * Manchester, 30 Sept 2026. An item nobody has booked in is exactly the one
   * a count must be able to find, so the sheet starts from the catalogue.
   *
   * Also: deleted products no longer appear (a soft-deleted product with a
   * level row used to), and a non-stocked product still appears while its
   * site holds a non-zero quantity of it, so stock is never left uncountable.
   */
  private async inScopeProducts(input: {
    companyId: string;
    siteId: string;
    scope: StockTakeScope;
    scopeRef: string | null;
  }): Promise<Array<{ productId: string; bookQty: string }>> {
    const where = [
      eq(products.companyId, input.companyId),
      isNull(products.deletedAt),
      or(eq(products.isStocked, true), ne(sql`coalesce(${stockLevels.onHand}, 0)`, 0)),
    ];
    if (input.scope === 'CATEGORY' && input.scopeRef) {
      where.push(eq(products.categoryId, input.scopeRef));
    } else if (input.scope === 'ITEM' && input.scopeRef) {
      where.push(eq(products.id, input.scopeRef));
    }
    // FULL / CYCLE / ZONE count everything at the site (no zone data in v1).
    return this.db
      .select({
        productId: products.id,
        bookQty: sql<string>`coalesce(${stockLevels.onHand}, 0)::text`,
      })
      .from(products)
      .leftJoin(
        stockLevels,
        and(
          eq(stockLevels.productId, products.id),
          eq(stockLevels.siteId, input.siteId),
          eq(stockLevels.companyId, input.companyId),
        ),
      )
      .where(and(...where));
  }

  /**
   * Add to an OPEN take any in-scope product it is missing — a product created
   * after the take opened, or one the old `stock_levels`-driven open skipped.
   * Book figure is the site's level NOW (0 if it has never held the item).
   * Idempotent: `stock_take_lines` is unique on (take, product).
   *
   * Run on the count screen's read of an open take, so a count already under
   * way picks the item up on its next refresh (the screen re-reads every
   * 15 s) rather than someone having to abandon a half-finished sheet.
   */
  private async topUpOpenTake(take: StockTake): Promise<void> {
    if (take.status !== 'OPEN') return;
    const [inScope, onSheet] = await Promise.all([
      this.inScopeProducts({
        companyId: take.companyId,
        siteId: take.siteId,
        scope: take.scope as StockTakeScope,
        scopeRef: take.scopeRef,
      }),
      this.db
        .select({ productId: stockTakeLines.productId })
        .from(stockTakeLines)
        .where(eq(stockTakeLines.stockTakeId, take.id)),
    ]);
    const have = new Set(onSheet.map((l) => l.productId));
    const missing = inScope.filter((p) => !have.has(p.productId));
    if (missing.length === 0) return;
    await this.db
      .insert(stockTakeLines)
      .values(missing.map((m) => ({ stockTakeId: take.id, productId: m.productId, bookQty: m.bookQty })))
      .onConflictDoNothing();
  }

  /**
   * Set an OPEN count aside without applying it. Its lines and counts are kept
   * — a cancelled count is still a record of what somebody counted — but it
   * no longer blocks a new count at the venue and can never be approved.
   * For clearing away the empty sheets left by people starting a new count
   * instead of joining one, and for a sheet a manager has decided not to use.
   */
  async cancel(stockTakeId: string, companyId = getSingletonCompanyId()): Promise<StockTake | null> {
    const take = await this.db.query.stockTakes.findFirst({
      where: and(eq(stockTakes.id, stockTakeId), eq(stockTakes.companyId, companyId)),
    });
    if (!take) return null;
    if (take.status !== 'OPEN') throw new StockTakeNotCancellableError(take.status);
    const [updated] = await this.db
      .update(stockTakes)
      .set({ status: 'CANCELLED', updatedAt: new Date() })
      .where(and(eq(stockTakes.id, stockTakeId), eq(stockTakes.status, 'OPEN')))
      .returning();
    return updated ?? null;
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

  /**
   * `topUp` adds any in-scope product an OPEN take is missing before reading
   * it (see topUpOpenTake). Opt-in, and only the count screen's own read asks
   * for it: the MCP tools may READ stock-takes but never change them (§F22),
   * and a read that quietly writes lines would break that.
   */
  async get(
    id: string,
    companyId = getSingletonCompanyId(),
    opts: { topUp?: boolean } = {},
  ): Promise<{ take: StockTake; lines: StockTakeLineWithProduct[] } | null> {
    const take = await this.db.query.stockTakes.findFirst({
      where: and(eq(stockTakes.id, id), eq(stockTakes.companyId, companyId)),
    });
    if (!take) return null;
    if (opts.topUp) await this.topUpOpenTake(take);
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
    filter: {
      siteId?: string;
      status?: string;
      companyId?: string;
      limit?: number;
      /** London calendar days, inclusive: a take opened or approved inside. */
      from?: string;
      to?: string;
    } = {},
  ): Promise<StockTakeWithProgress[]> {
    const companyId = filter.companyId ?? getSingletonCompanyId();
    const where = [eq(stockTakes.companyId, companyId)];
    if (filter.siteId) where.push(eq(stockTakes.siteId, filter.siteId));
    if (filter.status) where.push(eq(stockTakes.status, filter.status as never));
    const dated = Boolean(filter.from || filter.to);
    const found = await this.db.query.stockTakes.findMany({
      where: and(...where),
      orderBy: (s, { desc }) => [desc(s.createdAt)],
      // The date window is applied on London days below, so a limit can only
      // be pushed down to SQL when there is no window.
      ...(filter.limit && !dated ? { limit: filter.limit } : {}),
    });
    let takes = dated
      ? found.filter((t) => inRange(t, filter.from ?? '0000-01-01', filter.to ?? '9999-12-31'))
      : found;
    if (filter.limit && dated) takes = takes.slice(0, filter.limit);
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

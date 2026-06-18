/**
 * SquareDecrementService (P10, spec §A8) — every retail/merch sale through
 * Square decrements the right item at the right site and triggers the reorder
 * check.
 *
 * A sale line is resolved to a product (a pre-resolved BumbleBee `productId`, or
 * the Square item via the `square_item_map`) and a site (a direct `siteId`, or a
 * BumbleBee canonical site name). It then writes a SALE movement, idempotent on
 * the order-line identity `(channel_slug, source_pk, source_line_ref)` — a
 * replay is a no-op. The reorder engine fires automatically off the decrement
 * (StockLevelService.applyMovement hook). An unmapped item or site is
 * **quarantined** (surfaced for the operator), never silently dropped.
 */
import { and, eq, isNull, or } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { products, sites, squareItemMap, squareUnmappedLines } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { StockLevelService } from '../stock/stock-level.service.js';

export interface SaleLineInput {
  channelSlug: string;
  sourcePk: string;
  sourceLineRef: string;
  qty: number;
  productId?: string;
  squareKey?: string;
  siteId?: string;
  siteCanonical?: string;
  companyId?: string;
}

export type IngestStatus = 'applied' | 'duplicate' | 'quarantined';

export class SquareDecrementService {
  private db = getDb();
  private levels = new StockLevelService();

  async ingestLine(input: SaleLineInput): Promise<{ status: IngestStatus; reason?: string }> {
    const companyId = input.companyId ?? getSingletonCompanyId();

    let productId = input.productId ?? null;
    if (!productId && input.squareKey) {
      const m = await this.db.query.squareItemMap.findFirst({
        where: and(eq(squareItemMap.companyId, companyId), eq(squareItemMap.squareKey, input.squareKey)),
      });
      productId = m?.productId ?? null;
    }

    let siteId = input.siteId ?? null;
    if (!siteId && input.siteCanonical) {
      const s = await this.db.query.sites.findFirst({
        where: and(eq(sites.companyId, companyId), eq(sites.canonicalName, input.siteCanonical)),
      });
      siteId = s?.id ?? null;
    }

    if (!productId || !siteId) {
      const reason = !productId ? 'unmapped_item' : 'unmapped_site';
      await this.db
        .insert(squareUnmappedLines)
        .values({
          companyId,
          channelSlug: input.channelSlug,
          sourcePk: input.sourcePk,
          sourceLineRef: input.sourceLineRef,
          squareKey: input.squareKey ?? null,
          siteRef: input.siteCanonical ?? input.siteId ?? null,
          qty: String(input.qty),
          reason,
        })
        .onConflictDoNothing({
          target: [
            squareUnmappedLines.channelSlug,
            squareUnmappedLines.sourcePk,
            squareUnmappedLines.sourceLineRef,
          ],
        });
      return { status: 'quarantined', reason };
    }

    const res = await this.levels.applyMovement({
      productId,
      siteId,
      qtyDelta: -Math.abs(input.qty),
      movementType: 'SALE',
      sourceSystem: 'square',
      sourceKey: `${input.channelSlug}:${input.sourcePk}:${input.sourceLineRef}`,
      contentHash: 'sale',
      companyId,
    });
    return { status: res.applied ? 'applied' : 'duplicate' };
  }

  async ingestBatch(
    lines: SaleLineInput[],
  ): Promise<{ applied: number; duplicate: number; quarantined: number }> {
    let applied = 0;
    let duplicate = 0;
    let quarantined = 0;
    for (const line of lines) {
      const r = await this.ingestLine(line);
      if (r.status === 'applied') applied += 1;
      else if (r.status === 'duplicate') duplicate += 1;
      else quarantined += 1;
    }
    return { applied, duplicate, quarantined };
  }

  // ── Square-item ↔ stock-SKU map admin ──────────────────────────────
  async upsertMap(
    entries: Array<{ squareKey: string; productId: string }>,
    companyId = getSingletonCompanyId(),
  ): Promise<number> {
    for (const e of entries) {
      await this.db
        .insert(squareItemMap)
        .values({ companyId, squareKey: e.squareKey, productId: e.productId, autoMatched: false })
        .onConflictDoUpdate({
          target: [squareItemMap.companyId, squareItemMap.squareKey],
          set: { productId: e.productId, autoMatched: false, updatedAt: new Date() },
        });
    }
    return entries.length;
  }

  /** Auto-suggest matches by barcode / ean. Creates map rows (autoMatched) for
   *  any Square key whose code matches a product. Returns the matched count. */
  async autoMatchByBarcode(
    entries: Array<{ squareKey: string; code: string }>,
    companyId = getSingletonCompanyId(),
  ): Promise<number> {
    let matched = 0;
    for (const e of entries) {
      const product = await this.db.query.products.findFirst({
        where: and(
          eq(products.companyId, companyId),
          isNull(products.deletedAt),
          or(eq(products.barcode, e.code), eq(products.ean, e.code)),
        ),
      });
      if (!product) continue;
      await this.db
        .insert(squareItemMap)
        .values({ companyId, squareKey: e.squareKey, productId: product.id, autoMatched: true })
        .onConflictDoNothing({ target: [squareItemMap.companyId, squareItemMap.squareKey] });
      matched += 1;
    }
    return matched;
  }

  async listMap(companyId = getSingletonCompanyId()) {
    return this.db.query.squareItemMap.findMany({ where: eq(squareItemMap.companyId, companyId) });
  }

  /** Unresolved quarantined lines for the operator to map + retry. */
  async listUnmapped(companyId = getSingletonCompanyId()) {
    return this.db.query.squareUnmappedLines.findMany({
      where: and(eq(squareUnmappedLines.companyId, companyId), isNull(squareUnmappedLines.resolvedAt)),
    });
  }
}

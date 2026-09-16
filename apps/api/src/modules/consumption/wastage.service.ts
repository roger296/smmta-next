/**
 * Standalone wastage (Sept-2026 user testing, item 7).
 *
 * "please take this wastage function out of the end of bake form and create a
 *  separate Wastage form linked to by a new main menu item on the PWA where any
 *  items from stock can be marked as wasted."
 *
 * Wastage used to be a triangle on each ingredient row of the end-of-bake form.
 * That shape decided three things nobody chose: it could only be recorded for
 * an ingredient the recipe expected, only during a bake, and only by whoever
 * was filing that bake. A dropped case of eggs on a Tuesday morning had nowhere
 * to go, so it went unrecorded and turned up later as an unexplained variance.
 *
 * One event writes one WASTAGE movement. The ledger carries the quantity; the
 * `wastage_events` row carries the reason, the note, who said so, and — when
 * the waste did happen during a bake — which one.
 */
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { products, sites, wastageEvents } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { canAccessSite, type JwtPayload } from '../../shared/middleware/auth.js';
import { StockLevelService } from '../stock/stock-level.service.js';
import { getSiteCurrency } from '../sites/site-currency.js';
import { BatchService } from '../stock/batch.service.js';

export type WastageEvent = typeof wastageEvents.$inferSelect;

/**
 * The reasons offered on the form. Free text is still accepted — the list is a
 * keyboard shortcut, not a taxonomy, and a reason nobody can express is worse
 * than one nobody has counted yet.
 */
export const WASTAGE_REASONS = [
  'Spillage',
  'Burnt',
  'Dropped',
  'Over-portioned',
  'Off / expired',
  'Damaged in delivery',
  'Customer return',
] as const;

export interface RecordWastageInput {
  siteId: string;
  productId: string;
  qty: number;
  reason: string;
  note?: string | null;
  recordedBy?: string | null;
  /** Optional bake link — see the schema comment on why it is not required. */
  sessionId?: string | null;
  bake?: string | null;
  occurredAt?: string | null;
  /** Offline idempotency key. A replay returns the original row untouched. */
  clientKey: string;
  companyId?: string;
}

export class WastageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WastageError';
  }
}

export class WastageService {
  private db = getDb();
  private levels = new StockLevelService();
  private batches = new BatchService();

  async record(
    input: RecordWastageInput,
    actor?: Pick<JwtPayload, 'roles' | 'siteId'>,
  ): Promise<WastageEvent> {
    const companyId = input.companyId ?? getSingletonCompanyId();

    if (actor && !canAccessSite({ ...actor, roles: actor.roles ?? [] } as JwtPayload, input.siteId)) {
      throw new WastageError('forbidden_site_scope');
    }
    if (!(input.qty > 0)) {
      // Zero is not "nothing was wasted", it is a form submitted by accident.
      // A negative would ADD stock through a door marked wastage.
      throw new WastageError('Wasted quantity must be more than zero.');
    }
    if (!input.reason.trim()) {
      throw new WastageError(
        'Wastage needs a reason — without one it cannot be told from a counting error.',
      );
    }

    // Replay guard first, before anything is written. An offline queue that
    // retries must not waste the same stock twice.
    const existing = await this.db.query.wastageEvents.findFirst({
      where: and(
        eq(wastageEvents.companyId, companyId),
        eq(wastageEvents.clientKey, input.clientKey),
      ),
    });
    if (existing) return existing;

    const product = await this.db.query.products.findFirst({
      where: and(eq(products.companyId, companyId), eq(products.id, input.productId)),
      columns: { id: true, stockUom: true, expectedNextCost: true },
    });
    if (!product) throw new WastageError('That item is not in the catalogue.');

    const site = await this.db.query.sites.findFirst({
      where: and(eq(sites.companyId, companyId), eq(sites.id, input.siteId)),
      columns: { id: true },
    });
    if (!site) throw new WastageError('That venue does not exist.');

    const unitCost = product.expectedNextCost != null ? Number(product.expectedNextCost) : null;
    const currencyCode = await getSiteCurrency(input.siteId, companyId);
    const qty = Math.round(input.qty * 1000) / 1000;

    const [created] = await this.db
      .insert(wastageEvents)
      .values({
        companyId,
        siteId: input.siteId,
        productId: input.productId,
        qty: String(qty),
        stockUom: product.stockUom,
        reason: input.reason.trim().slice(0, 200),
        note: input.note?.trim() || null,
        recordedBy: input.recordedBy?.trim() || null,
        sessionId: input.sessionId?.trim() || null,
        bake: input.bake?.trim() || null,
        unitCost: unitCost != null ? String(unitCost) : null,
        currencyCode,
        occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
        clientKey: input.clientKey,
      })
      .returning();

    await this.levels.applyMovement({
      productId: input.productId,
      siteId: input.siteId,
      qtyDelta: -qty,
      movementType: 'WASTAGE',
      sourceSystem: 'wastage',
      // Keyed on the EVENT, not the session — this is the whole point of the
      // change, and it keeps these keys clear of the
      // `wastage:<session>:<product>` ones the bake form still owns for
      // records filed before item 7.
      sourceKey: `wastage-event:${created!.id}`,
      contentHash: 'v1',
      unitCost,
      currencyCode,
      companyId,
    });

    // Batch-tracked items come off the earliest use-by first, as everywhere
    // else. Best-effort: the ledger above is the exact record (P21).
    if (await this.batches.isBatchTracked(input.productId, companyId)) {
      await this.batches.decrementFEFO({
        productId: input.productId,
        siteId: input.siteId,
        qty,
        companyId,
      });
    }

    return created!;
  }

  /** Recent wastage for a venue — what the form shows under the entry boxes. */
  async list(
    q: { siteId?: string; from?: string; to?: string; limit?: number },
    companyId = getSingletonCompanyId(),
  ): Promise<Array<WastageEvent & { productName: string }>> {
    const where = [eq(wastageEvents.companyId, companyId)];
    if (q.siteId) where.push(eq(wastageEvents.siteId, q.siteId));
    if (q.from) where.push(gte(wastageEvents.occurredAt, new Date(q.from)));
    if (q.to) where.push(lte(wastageEvents.occurredAt, new Date(q.to)));

    const rows = await this.db
      .select({ event: wastageEvents, productName: products.name })
      .from(wastageEvents)
      .innerJoin(products, eq(products.id, wastageEvents.productId))
      .where(and(...where))
      .orderBy(desc(wastageEvents.occurredAt))
      .limit(Math.min(q.limit ?? 50, 200));

    return rows.map((r) => ({ ...r.event, productName: r.productName }));
  }
}

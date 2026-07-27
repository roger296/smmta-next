/**
 * SessionConsumptionService (P16, spec §A6).
 *
 * The head-baker end-of-session form's engine. `submit` writes one record per
 * BumbleBee session (amend-in-place, never duplicate), decrements site stock by
 * the actual usage (CONSUMPTION) and wastage (WASTAGE), records variance vs the
 * expected (recipe × covers), and computes the true materials cost. Amending
 * posts only the corrective delta (newActual − lastApplied), idempotent per
 * version; an offline replay carrying the same `clientKey` is a no-op.
 *
 * Site scope: a site-bound actor (a head-baker PIN) may only submit for its own
 * site; admins / unscoped users may submit for any site.
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import {
  products,
  sessionConsumption,
  sessionConsumptionLines,
} from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { canAccessSite, type JwtPayload } from '../../shared/middleware/auth.js';
import { StockLevelService } from '../stock/stock-level.service.js';
import { ExpectedConsumptionService } from '../recipes/expected-consumption.service.js';
import { getSiteCurrency } from '../sites/site-currency.js';
import { BatchService } from '../stock/batch.service.js';

export type SessionConsumption = typeof sessionConsumption.$inferSelect;
export type SessionConsumptionLine = typeof sessionConsumptionLines.$inferSelect;

/**
 * How a baker gave us a line.
 *
 * 'CONSUMED'  — they typed how much went in.
 * 'REMAINING' — they typed what's left in the tub, and we derive the usage
 *               from the stock we believe was there.
 *
 * Chosen per line, not per session: flour is easy to weigh out as you go,
 * whereas it is far easier to weigh what's left of the fondant at the end.
 */
export type ConsumptionEntryMode = 'CONSUMED' | 'REMAINING';

export interface SubmitLineInput {
  productId: string;
  /** Required in CONSUMED mode; ignored (and derived) in REMAINING mode. */
  actualQty?: number;
  /** Required in REMAINING mode: what's left. */
  remainingQty?: number;
  entryMode?: ConsumptionEntryMode;
  wastageQty?: number;
  wastageReason?: string | null;
}

/**
 * A line that can't be turned into a defensible usage figure.
 *
 * Thrown rather than absorbed: in REMAINING mode the alternative is inventing
 * a number — and an invented consumption figure silently moves stock and feeds
 * the materials cost, where nobody would ever spot it.
 */
export class ConsumptionEntryError extends Error {
  constructor(
    readonly productId: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConsumptionEntryError';
  }
}

/** Consumed = what we thought was there − what the baker says is left. */
export function derivedActualQty(openingQty: number, remainingQty: number): number {
  return Math.round((openingQty - remainingQty) * 1000) / 1000;
}

export interface SubmitInput {
  sessionId: string;
  siteId: string;
  sessionDate: string; // YYYY-MM-DD
  bakerName: string;
  bakerRef?: string | null;
  /** The cake baked this session + the covers (guest count), to compute
   *  expected consumption = recipe(bake) × covers. */
  bake?: string | null;
  covers?: number;
  lines: SubmitLineInput[];
  notes?: string | null;
  /** Offline idempotency key — a replay with the same key is a no-op. */
  clientKey?: string | null;
  companyId?: string;
}

export class SessionConsumptionService {
  private db = getDb();
  private levels = new StockLevelService();
  private expected = new ExpectedConsumptionService();
  private batches = new BatchService();

  /**
   * Submit (or amend) the consumption record for a session.
   * @param actor when given, enforces site scope (head-baker → own site only).
   */
  async submit(
    input: SubmitInput,
    actor?: Pick<JwtPayload, 'roles' | 'siteId'>,
  ): Promise<{ record: SessionConsumption; lines: SessionConsumptionLine[] }> {
    const companyId = input.companyId ?? getSingletonCompanyId();

    if (actor && !canAccessSite({ ...actor, roles: actor.roles ?? [] } as JwtPayload, input.siteId)) {
      throw new Error('forbidden_site_scope');
    }

    const existing = await this.db.query.sessionConsumption.findFirst({
      where: and(eq(sessionConsumption.companyId, companyId), eq(sessionConsumption.sessionId, input.sessionId)),
    });

    // Offline replay guard — same client key already applied ⇒ no-op.
    if (existing && input.clientKey && existing.clientKey === input.clientKey) {
      return this.get(existing.id, companyId) as Promise<{
        record: SessionConsumption;
        lines: SessionConsumptionLine[];
      }>;
    }

    // Expected consumption per ingredient = recipe(cake) × covers.
    const expectedLines = input.bake && input.covers
      ? await this.expected.expectedForSession({
          bake: input.bake,
          siteId: input.siteId,
          covers: input.covers,
          onDate: input.sessionDate,
          companyId,
        })
      : [];
    const expectedByProduct = new Map(expectedLines.map((l) => [l.productId, l]));

    const totalCovers = input.covers ?? 0;
    const currencyCode = await getSiteCurrency(input.siteId, companyId);
    const version = (existing?.version ?? 0) + 1;
    let record: SessionConsumption;
    if (existing) {
      const [updated] = await this.db
        .update(sessionConsumption)
        .set({
          bakerName: input.bakerName,
          bakerRef: input.bakerRef ?? existing.bakerRef,
          sessionDate: input.sessionDate,
          bake: input.bake ?? existing.bake,
          covers: totalCovers || existing.covers,
          version,
          clientKey: input.clientKey ?? existing.clientKey,
          notes: input.notes ?? existing.notes,
          submittedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(sessionConsumption.id, existing.id))
        .returning();
      record = updated!;
    } else {
      const [created] = await this.db
        .insert(sessionConsumption)
        .values({
          companyId,
          siteId: input.siteId,
          sessionId: input.sessionId,
          sessionDate: input.sessionDate,
          bakerName: input.bakerName,
          bakerRef: input.bakerRef ?? null,
          bake: input.bake ?? null,
          covers: totalCovers,
          version,
          clientKey: input.clientKey ?? null,
          notes: input.notes ?? null,
          submittedAt: new Date(),
        })
        .returning();
      record = created!;
    }

    let materialsCost = 0;
    for (const line of input.lines) {
      const exp = expectedByProduct.get(line.productId);
      const expectedQty = exp?.expectedQty ?? 0;
      const unitCost = exp?.unitCost ?? (await this.productCost(line.productId, companyId));
      const stockUom = exp?.stockUom ?? (await this.productUom(line.productId, companyId));
      const resolved = await this.resolveLineQty(line, input.siteId, companyId);
      const newActual = resolved.actualQty;
      const newWastage = line.wastageQty ?? 0;
      const variance = round3(newActual - expectedQty);
      materialsCost += newActual * (unitCost ?? 0);

      const existingLine = await this.db.query.sessionConsumptionLines.findFirst({
        where: and(
          eq(sessionConsumptionLines.consumptionId, record.id),
          eq(sessionConsumptionLines.productId, line.productId),
        ),
      });
      const oldActual = existingLine ? Number(existingLine.actualQty) : 0;
      const oldWastage = existingLine ? Number(existingLine.wastageQty) : 0;

      if (existingLine) {
        await this.db
          .update(sessionConsumptionLines)
          .set({
            expectedQty: String(expectedQty),
            actualQty: String(newActual),
            wastageQty: String(newWastage),
            wastageReason: line.wastageReason ?? null,
            unitCost: unitCost != null ? String(unitCost) : null,
            variance: String(variance),
            stockUom,
            entryMode: resolved.entryMode,
            openingQty: resolved.openingQty != null ? String(resolved.openingQty) : null,
            remainingQty: resolved.remainingQty != null ? String(resolved.remainingQty) : null,
            updatedAt: new Date(),
          })
          .where(eq(sessionConsumptionLines.id, existingLine.id));
      } else {
        await this.db.insert(sessionConsumptionLines).values({
          companyId,
          consumptionId: record.id,
          productId: line.productId,
          expectedQty: String(expectedQty),
          actualQty: String(newActual),
          wastageQty: String(newWastage),
          wastageReason: line.wastageReason ?? null,
          unitCost: unitCost != null ? String(unitCost) : null,
          variance: String(variance),
          stockUom,
          entryMode: resolved.entryMode,
          openingQty: resolved.openingQty != null ? String(resolved.openingQty) : null,
          remainingQty: resolved.remainingQty != null ? String(resolved.remainingQty) : null,
        });
      }

      // Corrective deltas — consume / waste only the *change* since last applied.
      const consumptionDelta = round3(oldActual - newActual); // negative ⇒ more consumed
      if (consumptionDelta !== 0) {
        await this.levels.applyMovement({
          productId: line.productId,
          siteId: input.siteId,
          qtyDelta: consumptionDelta,
          movementType: 'CONSUMPTION',
          sourceSystem: 'consumption',
          sourceKey: `consumption:${input.sessionId}:${line.productId}`,
          contentHash: `v${version}`,
          unitCost,
          currencyCode,
          companyId,
        });
      }
      const wastageDelta = round3(oldWastage - newWastage);
      if (wastageDelta !== 0) {
        await this.levels.applyMovement({
          productId: line.productId,
          siteId: input.siteId,
          qtyDelta: wastageDelta,
          movementType: 'WASTAGE',
          sourceSystem: 'wastage',
          sourceKey: `wastage:${input.sessionId}:${line.productId}`,
          contentHash: `v${version}`,
          unitCost,
          currencyCode,
          companyId,
        });
      }

      // Batch-tracked items: take the *additional* usage off the lots FEFO
      // (earliest use-by first). Forward-only — an amend-down isn't restored to
      // the lot (the ledger stays exact; batch qty is best-effort, P21).
      const additionalUsed = round3(newActual + newWastage - (oldActual + oldWastage));
      if (additionalUsed > 0 && (await this.batches.isBatchTracked(line.productId, companyId))) {
        await this.batches.decrementFEFO({
          productId: line.productId,
          siteId: input.siteId,
          qty: additionalUsed,
          companyId,
        });
      }
    }

    const [final] = await this.db
      .update(sessionConsumption)
      .set({ materialsCost: String(Math.round(materialsCost * 100) / 100), updatedAt: new Date() })
      .where(eq(sessionConsumption.id, record.id))
      .returning();
    record = final ?? record;

    // Best-effort: push the materials cost to BumbleBee (guarded, dry-run by
    // default). A sync hiccup must never fail the submit (spec §A8, P17).
    try {
      const { MaterialsCostSyncService } = await import('./materials-cost-sync.service.js');
      await new MaterialsCostSyncService().syncSession(input.sessionId, companyId);
    } catch {
      // swallow — materials-cost sync is not on the submit's critical path
    }

    const lines = await this.linesFor(record.id);
    return { record, lines };
  }

  async get(
    id: string,
    companyId = getSingletonCompanyId(),
  ): Promise<{ record: SessionConsumption; lines: SessionConsumptionLine[] } | null> {
    const record = await this.db.query.sessionConsumption.findFirst({
      where: and(eq(sessionConsumption.id, id), eq(sessionConsumption.companyId, companyId)),
    });
    if (!record) return null;
    return { record, lines: await this.linesFor(id) };
  }

  async getBySession(
    sessionId: string,
    companyId = getSingletonCompanyId(),
  ): Promise<{ record: SessionConsumption; lines: SessionConsumptionLine[] } | null> {
    const record = await this.db.query.sessionConsumption.findFirst({
      where: and(eq(sessionConsumption.companyId, companyId), eq(sessionConsumption.sessionId, sessionId)),
    });
    if (!record) return null;
    return { record, lines: await this.linesFor(record.id) };
  }

  async list(
    filter: { siteId?: string; sessionDate?: string; companyId?: string } = {},
  ): Promise<SessionConsumption[]> {
    const companyId = filter.companyId ?? getSingletonCompanyId();
    const where = [eq(sessionConsumption.companyId, companyId)];
    if (filter.siteId) where.push(eq(sessionConsumption.siteId, filter.siteId));
    if (filter.sessionDate) where.push(eq(sessionConsumption.sessionDate, filter.sessionDate));
    return this.db.query.sessionConsumption.findMany({
      where: and(...where),
      orderBy: (s, { desc }) => [desc(s.sessionDate), desc(s.createdAt)],
    });
  }

  /**
   * From a candidate list of the day's sessions (polled from BumbleBee), the
   * ones at the site with no consumption record yet.
   */
  async filterAwaiting<T extends { sessionId: string }>(
    siteId: string,
    sessions: T[],
    companyId = getSingletonCompanyId(),
  ): Promise<T[]> {
    const records = await this.db
      .select({ sessionId: sessionConsumption.sessionId })
      .from(sessionConsumption)
      .where(and(eq(sessionConsumption.companyId, companyId), eq(sessionConsumption.siteId, siteId)));
    const done = new Set(records.map((r) => r.sessionId));
    return sessions.filter((s) => !done.has(s.sessionId));
  }

  private async linesFor(consumptionId: string): Promise<SessionConsumptionLine[]> {
    return this.db
      .select()
      .from(sessionConsumptionLines)
      .where(eq(sessionConsumptionLines.consumptionId, consumptionId));
  }

  private async productCost(productId: string, companyId: string): Promise<number | null> {
    const p = await this.db.query.products.findFirst({
      where: and(eq(products.id, productId), eq(products.companyId, companyId)),
      columns: { expectedNextCost: true },
    });
    return p?.expectedNextCost != null ? Number(p.expectedNextCost) : null;
  }

  private async productUom(productId: string, companyId: string): Promise<string> {
    const p = await this.db.query.products.findFirst({
      where: and(eq(products.id, productId), eq(products.companyId, companyId)),
      columns: { stockUom: true },
    });
    return p?.stockUom ?? 'each';
  }

  /**
   * Turn a submitted line into a usage figure, whichever way it was entered.
   *
   * CONSUMED is a pass-through. REMAINING reads what stock we believe is on
   * hand and subtracts — and refuses outright when that can't be done
   * honestly, because the fallbacks are all worse:
   *
   *  - no stock record at all ⇒ treating opening as 0 would derive a NEGATIVE
   *    usage, which posts as stock arriving. A site that has never counted
   *    would quietly inflate its own inventory every session.
   *  - remaining > opening ⇒ either a delivery landed mid-session or the
   *    opening is wrong. Either way the honest answer is "ask a human", not a
   *    negative consumption movement.
   *
   * The opening is snapshotted onto the line so the derivation stays checkable
   * after stock has moved on.
   */
  private async resolveLineQty(
    line: SubmitLineInput,
    siteId: string,
    companyId: string,
  ): Promise<{
    actualQty: number;
    entryMode: ConsumptionEntryMode;
    openingQty: number | null;
    remainingQty: number | null;
  }> {
    const mode: ConsumptionEntryMode = line.entryMode ?? 'CONSUMED';

    if (mode === 'CONSUMED') {
      const qty = line.actualQty ?? 0;
      if (qty < 0) {
        throw new ConsumptionEntryError(line.productId, 'Used quantity cannot be negative.');
      }
      return { actualQty: qty, entryMode: 'CONSUMED', openingQty: null, remainingQty: null };
    }

    const remaining = line.remainingQty;
    if (remaining == null) {
      throw new ConsumptionEntryError(
        line.productId,
        'Entering what is left needs a remaining quantity.',
      );
    }
    if (remaining < 0) {
      throw new ConsumptionEntryError(line.productId, 'Remaining quantity cannot be negative.');
    }

    const onHandRaw = await this.levels.getOnHand(line.productId, siteId, companyId);
    const opening = Number(onHandRaw);
    if (!Number.isFinite(opening)) {
      throw new ConsumptionEntryError(
        line.productId,
        "This site has no stock figure for this item yet, so what's left can't be turned " +
          'into what was used. Count it in a stock-take first, or enter the amount used.',
      );
    }
    if (remaining > opening) {
      throw new ConsumptionEntryError(
        line.productId,
        `More left (${remaining}) than we think was there (${opening}). If a delivery ` +
          'arrived mid-session, book it in first; otherwise enter the amount used.',
      );
    }

    return {
      actualQty: derivedActualQty(opening, remaining),
      entryMode: 'REMAINING',
      openingQty: opening,
      remainingQty: remaining,
    };
  }

}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

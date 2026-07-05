/**
 * Interest flags & prospective products (SPEC F8, §13.3). The demand-signal
 * registry: one contextual button (restock / offers / register_interest)
 * writing to interest_flags + emitting domain events, plus the threshold-check
 * handler that fires interest.threshold_crossed exactly once.
 *
 * listInterests enriches watched SKUs that sit on an unarrived shipment with the
 * ETA + the per-unit pre-order saving, reusing InboundService.getStockAndEta and
 * PricingService.quote — no pricing/stock logic is duplicated here.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import {
  storefrontUsers,
  interestFlags,
  consentRecords,
  prospectiveProducts,
  domainEvents,
} from '../../db/schema/index.js';
import { emitDomainEvent } from '../../shared/events/emit.js';
import { InboundService, type StockBand } from '../inbound/inbound.service.js';
import { PricingService } from '../pricing/pricing.service.js';

export type FlagType = 'restock' | 'offers' | 'register_interest';

/** The contextual button meaning (F8 table), resolved from product state. */
export function resolveFlagType(state: StockBand | 'prospective'): FlagType {
  if (state === 'prospective') return 'register_interest';
  if (state === 'out_of_stock') return 'restock';
  return 'offers'; // in_stock / low_stock → watch for offers
}

export interface CreateFlagInput {
  userId?: string;
  /** For anonymous/guest capture — a user is created + flag_updates consent recorded. */
  email?: string;
  sku?: string;
  prospectiveId?: string;
  flagType: FlagType;
  sourcePage?: string;
}

export class InterestFlagService {
  private db = getDb();
  private companyId = getSingletonCompanyId();
  private inbound = new InboundService();
  private pricing = new PricingService();

  /**
   * Create (or no-op upsert) an interest flag. For a guest (email, no userId)
   * the user, the flag_updates consent, and the flag are created atomically in
   * one transaction, along with user.created / consent.granted /
   * interest.flag_created events.
   */
  async createInterestFlag(input: CreateFlagInput): Promise<{ userId: string; flagId: string | null }> {
    if (!input.userId && !input.email) throw new Error('createInterestFlag requires userId or email');
    if (!input.sku && !input.prospectiveId) throw new Error('createInterestFlag requires sku or prospectiveId');

    return this.db.transaction(async (tx) => {
      // Resolve the user (create a guest if needed, atomically).
      let userId = input.userId;
      let createdGuest = false;
      if (!userId) {
        const [existing] = await tx
          .select({ id: storefrontUsers.id })
          .from(storefrontUsers)
          .where(eq(storefrontUsers.email, input.email!))
          .limit(1);
        if (existing) {
          userId = existing.id;
        } else {
          const [u] = await tx
            .insert(storefrontUsers)
            .values({ companyId: this.companyId, email: input.email!, kind: 'guest' })
            .returning({ id: storefrontUsers.id });
          userId = u!.id;
          createdGuest = true;
          await emitDomainEvent(tx, {
            eventType: 'user.created',
            aggregateType: 'user',
            aggregateId: userId,
            payload: { source: 'interest_flag', kind: 'guest' },
          });
        }
      }

      // flag_updates consent is implicit in the watch action (F9).
      if (createdGuest || input.email) {
        await tx.insert(consentRecords).values({
          companyId: this.companyId,
          userId: userId!,
          consentType: 'flag_updates',
          granted: true,
          source: input.sourcePage ?? 'interest_flag',
        });
        await emitDomainEvent(tx, {
          eventType: 'consent.granted',
          aggregateType: 'consent',
          aggregateId: userId!,
          payload: { userId, consentType: 'flag_updates', source: 'interest_flag' },
        });
      }

      // Insert the flag; the unique index (user, sku, prospective, flagType)
      // NULLS NOT DISTINCT makes a repeat a no-op.
      const inserted = await tx
        .insert(interestFlags)
        .values({
          companyId: this.companyId,
          userId: userId!,
          sku: input.sku ?? null,
          prospectiveId: input.prospectiveId ?? null,
          flagType: input.flagType,
          sourcePage: input.sourcePage,
        })
        .onConflictDoNothing()
        .returning({ id: interestFlags.id });

      const flagId = inserted[0]?.id ?? null;
      if (flagId) {
        await emitDomainEvent(tx, {
          eventType: 'interest.flag_created',
          aggregateType: input.prospectiveId ? 'prospective' : 'interest',
          aggregateId: input.prospectiveId ?? userId!,
          payload: {
            userId,
            sku: input.sku ?? null,
            prospectiveId: input.prospectiveId ?? null,
            flagType: input.flagType,
          },
        });
      }
      return { userId: userId!, flagId };
    });
  }

  /** The public "coming soon" catalogue (F8): prospective products still open,
   *  with their live interest count + threshold for the progress bar. */
  async listComingSoon() {
    const rows = await this.db
      .select()
      .from(prospectiveProducts)
      .where(
        and(
          eq(prospectiveProducts.companyId, this.companyId),
          sql`${prospectiveProducts.status} IN ('considering','group_buy_open')`,
        ),
      );
    return Promise.all(
      rows.map(async (p) => {
        const [{ n }] = await this.db
          .select({ n: sql<number>`count(*)::int` })
          .from(interestFlags)
          .where(and(eq(interestFlags.prospectiveId, p.id), isNull(interestFlags.clearedAt)));
        return {
          id: p.id,
          name: p.name,
          description: p.description,
          status: p.status,
          interestThreshold: p.interestThreshold,
          interestCount: Number(n),
          creatorPartner: p.creatorPartner,
        };
      }),
    );
  }

  async clearFlag(flagId: string): Promise<void> {
    await this.db
      .update(interestFlags)
      .set({ clearedAt: new Date() })
      .where(and(eq(interestFlags.id, flagId), isNull(interestFlags.clearedAt)));
  }

  /**
   * A customer's active watches, enriched with inbound ETA + per-unit pre-order
   * saving where a watched SKU sits on an unarrived shipment.
   */
  async listInterests(userId: string) {
    const flags = await this.db
      .select()
      .from(interestFlags)
      .where(and(eq(interestFlags.userId, userId), isNull(interestFlags.clearedAt)));

    return Promise.all(
      flags.map(async (f) => {
        let enrichment: { eta: string; preorderSavingPencePerUnit: number; shipmentRef: string } | null = null;
        if (f.sku) {
          const stock = await this.inbound.getStockAndEta(f.sku);
          // Best (largest saving) unarrived pool.
          let best: { eta: Date; saving: number; ref: string } | null = null;
          for (const pool of stock.inbound) {
            try {
              const q = await this.pricing.quote({ sku: f.sku, qty: 1, pool: pool.shipmentRef });
              if (!best || q.savingsVsBasePence > best.saving) {
                best = { eta: pool.eta, saving: q.savingsVsBasePence, ref: pool.shipmentRef };
              }
            } catch {
              // pool not quotable — skip
            }
          }
          if (best) {
            enrichment = {
              eta: best.eta.toISOString(),
              preorderSavingPencePerUnit: best.saving,
              shipmentRef: best.ref,
            };
          }
        }
        return {
          id: f.id,
          sku: f.sku,
          prospectiveId: f.prospectiveId,
          flagType: f.flagType,
          since: f.createdAt.toISOString(),
          inbound: enrichment,
        };
      }),
    );
  }

  /**
   * threshold-check handler (replaces the Prompt 1 stub). On
   * interest.flag_created for a prospective product, count active flags; if the
   * threshold is reached and has not been crossed before, stamp
   * threshold_crossed_at (row-locked) and emit interest.threshold_crossed
   * exactly once. The owner notification is the emitted event itself, surfaced
   * by the digest (Prompt 15) — we do NOT write a message_drafts row here
   * because its user_id FK targets storefront customers, not the owner (logged).
   */
  async thresholdCheck(eventId: string): Promise<void> {
    const [event] = await this.db
      .select({ payload: domainEvents.payload })
      .from(domainEvents)
      .where(eq(domainEvents.id, eventId))
      .limit(1);
    if (!event) return;
    const prospectiveId = (event.payload as { prospectiveId?: string }).prospectiveId;
    if (!prospectiveId) return;

    await this.db.transaction(async (tx) => {
      const [prospective] = await tx
        .select()
        .from(prospectiveProducts)
        .where(eq(prospectiveProducts.id, prospectiveId))
        .for('update');
      if (!prospective || prospective.interestThreshold == null) return;
      if (prospective.thresholdCrossedAt) return; // already crossed — idempotent

      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(interestFlags)
        .where(
          and(eq(interestFlags.prospectiveId, prospectiveId), isNull(interestFlags.clearedAt)),
        );

      if (n < prospective.interestThreshold) return;

      await tx
        .update(prospectiveProducts)
        .set({ thresholdCrossedAt: new Date(), status: 'group_buy_open' })
        .where(eq(prospectiveProducts.id, prospectiveId));

      await emitDomainEvent(tx, {
        eventType: 'interest.threshold_crossed',
        aggregateType: 'prospective',
        aggregateId: prospectiveId,
        payload: { prospectiveId, count: n, threshold: prospective.interestThreshold },
      });
    });
  }
}

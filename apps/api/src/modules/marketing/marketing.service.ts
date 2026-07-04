/**
 * Marketing agent (SPEC F7, §12.3). Nightly: segmentation in plain SQL →
 * personalised composes through the SAME approval pipeline. Selection respects
 * consent, suppression, and remaining frequency-cap headroom BEFORE composing
 * (don't burn LLM spend on unsendables), and a customer in two segments is
 * composed at most once per night.
 */
import { and, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { getEnv } from '../../config/env.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import {
  storefrontUsers,
  consentRecords,
  suppressionList,
  interestFlags,
  messageDrafts,
  runOutPredictions,
  subscriptions,
  preorderOrders,
  preorderOrderLines,
} from '../../db/schema/index.js';
import { ComposeService } from '../messaging/compose.service.js';
import { predictRunOut } from './cadence.js';

const DAY_MS = 86_400_000;
const RUN_OUT_WINDOW_DAYS = 7;

type Segment = 'run_out_due' | 'offer_watcher' | 'subscription_upsell' | 'lapsed';

const SEGMENT_TEMPLATE: Record<Segment, string> = {
  run_out_due: 'run_out_reminder',
  offer_watcher: 'price_drop_offer',
  subscription_upsell: 'subscription_upsell',
  lapsed: 'lapsed_winback',
};

// Priority when a user matches multiple segments (dedupe keeps the first).
const SEGMENT_PRIORITY: Segment[] = ['run_out_due', 'offer_watcher', 'subscription_upsell', 'lapsed'];

interface Candidate {
  userId: string;
  email: string;
  segment: Segment;
  facts: Record<string, unknown>;
}

export interface MarketingConfig {
  enabledSegments?: Partial<Record<Segment, boolean>>;
  maxSendsPerNight?: number;
}

export class MarketingService {
  private db = getDb();
  private companyId = getSingletonCompanyId();
  private compose: ComposeService;

  constructor(compose?: ComposeService) {
    this.compose = compose ?? new ComposeService();
  }

  /** Recompute per (user, sku) cadence from paid pre-orders. */
  async recomputePredictions(): Promise<number> {
    const rows = await this.db
      .select({ userId: preorderOrders.userId, sku: preorderOrderLines.sku, paidAt: preorderOrders.paidAt })
      .from(preorderOrderLines)
      .innerJoin(preorderOrders, eq(preorderOrderLines.orderId, preorderOrders.id))
      .where(and(eq(preorderOrders.companyId, this.companyId), eq(preorderOrders.status, 'paid')));

    const groups = new Map<string, { userId: string; sku: string; ts: number[] }>();
    for (const r of rows) {
      if (!r.paidAt) continue;
      const key = `${r.userId}:${r.sku}`;
      const g = groups.get(key) ?? { userId: r.userId, sku: r.sku, ts: [] };
      g.ts.push(r.paidAt.getTime());
      groups.set(key, g);
    }

    let written = 0;
    for (const g of groups.values()) {
      const pred = predictRunOut(g.ts);
      if (!pred) continue;
      await this.db
        .insert(runOutPredictions)
        .values({
          companyId: this.companyId,
          userId: g.userId,
          sku: g.sku,
          medianIntervalDays: Math.round(pred.medianIntervalDays),
          purchaseCount: pred.purchaseCount,
          lastPurchaseAt: new Date(pred.lastPurchaseMs),
          predictedRunOutAt: new Date(pred.predictedRunOutMs),
          regular: pred.regular ? 'yes' : 'no',
        })
        .onConflictDoUpdate({
          target: [runOutPredictions.userId, runOutPredictions.sku],
          set: {
            medianIntervalDays: Math.round(pred.medianIntervalDays),
            purchaseCount: pred.purchaseCount,
            lastPurchaseAt: new Date(pred.lastPurchaseMs),
            predictedRunOutAt: new Date(pred.predictedRunOutMs),
            regular: pred.regular ? 'yes' : 'no',
            computedAt: new Date(),
          },
        });
      written++;
    }
    return written;
  }

  private async candidates(nowMs: number): Promise<Candidate[]> {
    const out: Candidate[] = [];

    // run-out due within the window.
    const runOut = await this.db
      .select({
        userId: runOutPredictions.userId,
        sku: runOutPredictions.sku,
        email: storefrontUsers.email,
        runOutAt: runOutPredictions.predictedRunOutAt,
      })
      .from(runOutPredictions)
      .innerJoin(storefrontUsers, eq(runOutPredictions.userId, storefrontUsers.id))
      .where(
        and(
          eq(runOutPredictions.companyId, this.companyId),
          lte(runOutPredictions.predictedRunOutAt, new Date(nowMs + RUN_OUT_WINDOW_DAYS * DAY_MS)),
        ),
      );
    for (const r of runOut) {
      if (r.email) out.push({ userId: r.userId, email: r.email, segment: 'run_out_due', facts: { sku: r.sku } });
    }

    // offer watchers with an active flag.
    const offers = await this.db
      .select({ userId: interestFlags.userId, sku: interestFlags.sku, email: storefrontUsers.email })
      .from(interestFlags)
      .innerJoin(storefrontUsers, eq(interestFlags.userId, storefrontUsers.id))
      .where(
        and(
          eq(interestFlags.companyId, this.companyId),
          eq(interestFlags.flagType, 'offers'),
          isNull(interestFlags.clearedAt),
        ),
      );
    for (const r of offers) {
      if (r.email) out.push({ userId: r.userId, email: r.email, segment: 'offer_watcher', facts: { sku: r.sku } });
    }

    // subscription upsell: regular cadence + no active subscription.
    const upsell = await this.db
      .select({ userId: runOutPredictions.userId, email: storefrontUsers.email })
      .from(runOutPredictions)
      .innerJoin(storefrontUsers, eq(runOutPredictions.userId, storefrontUsers.id))
      .where(and(eq(runOutPredictions.companyId, this.companyId), eq(runOutPredictions.regular, 'yes')));
    for (const r of upsell) {
      if (!r.email) continue;
      const [sub] = await this.db
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(and(eq(subscriptions.userId, r.userId), eq(subscriptions.status, 'active')))
        .limit(1);
      if (!sub) out.push({ userId: r.userId, email: r.email, segment: 'subscription_upsell', facts: {} });
    }

    // lapsed: had a paid order, none in the last 90 days.
    const lapsed = await this.db
      .select({ userId: preorderOrders.userId, email: storefrontUsers.email, last: sql<Date>`max(${preorderOrders.paidAt})` })
      .from(preorderOrders)
      .innerJoin(storefrontUsers, eq(preorderOrders.userId, storefrontUsers.id))
      .where(and(eq(preorderOrders.companyId, this.companyId), eq(preorderOrders.status, 'paid')))
      .groupBy(preorderOrders.userId, storefrontUsers.email);
    for (const r of lapsed) {
      if (r.email && r.last && r.last.getTime() < nowMs - 90 * DAY_MS) {
        out.push({ userId: r.userId, email: r.email, segment: 'lapsed', facts: {} });
      }
    }

    return out;
  }

  private async passesGates(userId: string, email: string, nowMs: number): Promise<boolean> {
    // consent
    const [consent] = await this.db
      .select({ granted: consentRecords.granted })
      .from(consentRecords)
      .where(and(eq(consentRecords.userId, userId), eq(consentRecords.consentType, 'general_marketing')))
      .orderBy(desc(consentRecords.createdAt))
      .limit(1);
    if (!consent?.granted) return false;
    // suppression
    const [sup] = await this.db
      .select({ email: suppressionList.email })
      .from(suppressionList)
      .where(eq(suppressionList.email, email))
      .limit(1);
    if (sup) return false;
    // frequency-cap headroom
    const env = getEnv();
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(messageDrafts)
      .where(
        and(
          eq(messageDrafts.userId, userId),
          eq(messageDrafts.category, 'marketing'),
          eq(messageDrafts.status, 'sent'),
          gte(messageDrafts.resolvedAt, new Date(nowMs - env.MARKETING_FREQ_CAP_DAYS * DAY_MS)),
        ),
      );
    if (Number(row?.n ?? 0) >= env.MARKETING_FREQ_CAP_COUNT) return false;
    return true;
  }

  /** The nightly run. Returns per-segment composed counts (for the digest). */
  async runNightly(nowMs = Date.now(), config: MarketingConfig = {}): Promise<Record<Segment, number>> {
    const enabled = config.enabledSegments ?? {};
    const maxSends = config.maxSendsPerNight ?? getEnv().MARKETING_MAX_SENDS_PER_NIGHT;
    const date = new Date(nowMs).toISOString().slice(0, 10);

    const raw = await this.candidates(nowMs);
    // Dedupe: one message per user per night, keeping the highest-priority segment.
    const byUser = new Map<string, Candidate>();
    for (const seg of SEGMENT_PRIORITY) {
      for (const c of raw) {
        if (c.segment === seg && !byUser.has(c.userId)) byUser.set(c.userId, c);
      }
    }

    const counts: Record<Segment, number> = { run_out_due: 0, offer_watcher: 0, subscription_upsell: 0, lapsed: 0 };
    let sent = 0;
    for (const c of byUser.values()) {
      if (sent >= maxSends) break;
      if (enabled[c.segment] === false) continue;
      if (!(await this.passesGates(c.userId, c.email, nowMs))) continue;
      await this.compose.compose({
        userId: c.userId,
        templateKey: SEGMENT_TEMPLATE[c.segment],
        groupKey: `marketing:${c.segment}:${date}`,
        facts: c.facts,
        nowMs,
      });
      counts[c.segment]++;
      sent++;
    }
    return counts;
  }
}

/**
 * Daily agent digest (SPEC §6, §17.9). For a solo operator this beats any
 * dashboard: one 07:00 email summarising what awaits approval, what was auto-
 * sent, what failed, payment-window items, LLM spend vs cap, upcoming renewals,
 * and last night's marketing segment counts. buildDigest assembles the payload;
 * the send is transactional (Prompt 9 pipeline).
 */
import { and, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { getEnv } from '../../config/env.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import {
  messageDrafts,
  escalations,
  preorderOrders,
  subscriptions,
  llmLog,
} from '../../db/schema/index.js';
import { getRecentJobFailures } from '../../worker/job-failures.js';

export interface DigestPayload {
  date: string;
  queue: { pending: number; byType: Record<string, number> };
  autoSent: number;
  failedDrafts: number;
  expiredDrafts: number;
  openEscalations: number;
  paymentWindow: { awaiting: number; overdue: number };
  llmSpend: { spentMicroUsd: number; capMicroUsd: number; overCap: boolean };
  upcomingRenewals: number;
  marketingSegments: Record<string, number>;
  jobFailures: number;
}

export class DigestService {
  private db = getDb();
  private companyId = getSingletonCompanyId();

  async buildDigest(nowMs = Date.now()): Promise<DigestPayload> {
    const dayStart = new Date(nowMs);
    dayStart.setUTCHours(0, 0, 0, 0);
    const date = new Date(nowMs).toISOString().slice(0, 10);

    // Queue: pending drafts grouped by template (group_key prefix).
    const pending = await this.db
      .select({ groupKey: messageDrafts.groupKey })
      .from(messageDrafts)
      .where(and(eq(messageDrafts.companyId, this.companyId), eq(messageDrafts.status, 'pending')));
    const byType: Record<string, number> = {};
    for (const p of pending) {
      const t = p.groupKey?.split(':')[0] ?? 'other';
      byType[t] = (byType[t] ?? 0) + 1;
    }

    const count = async (where: SQL | undefined): Promise<number> => {
      const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(messageDrafts).where(where);
      return Number(row?.n ?? 0);
    };

    const autoSent = await count(
      and(eq(messageDrafts.companyId, this.companyId), eq(messageDrafts.status, 'auto_approved')),
    );
    const failedDrafts = await count(
      and(eq(messageDrafts.companyId, this.companyId), eq(messageDrafts.status, 'failed')),
    );
    const expiredDrafts = await count(
      and(
        eq(messageDrafts.companyId, this.companyId),
        eq(messageDrafts.status, 'failed'),
        eq(messageDrafts.rejectReason, 'expired'),
      ),
    );

    const [esc] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(escalations)
      .where(and(eq(escalations.companyId, this.companyId), eq(escalations.status, 'open')));

    const [awaiting] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(preorderOrders)
      .where(and(eq(preorderOrders.companyId, this.companyId), eq(preorderOrders.status, 'awaiting_payment')));
    const [overdue] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(preorderOrders)
      .where(
        and(
          eq(preorderOrders.companyId, this.companyId),
          eq(preorderOrders.status, 'awaiting_payment'),
          sql`${preorderOrders.overdueNotifiedAt} IS NOT NULL`,
        ),
      );

    const [spend] = await this.db
      .select({ total: sql<number>`coalesce(sum(${llmLog.costMicroUsd}),0)::bigint` })
      .from(llmLog)
      .where(gte(llmLog.createdAt, dayStart));
    const capMicroUsd = getEnv().OPENROUTER_DAILY_CAP_MICROUSD;
    const spentMicroUsd = Number(spend?.total ?? 0);

    const [renewals] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.companyId, this.companyId),
          eq(subscriptions.status, 'active'),
          lte(subscriptions.renewsAt, new Date(nowMs + 7 * 86_400_000)),
        ),
      );

    // Marketing segment counts = drafts created today under a marketing group_key.
    const marketing = await this.db
      .select({ groupKey: messageDrafts.groupKey })
      .from(messageDrafts)
      .where(
        and(
          eq(messageDrafts.companyId, this.companyId),
          gte(messageDrafts.createdAt, dayStart),
          sql`${messageDrafts.groupKey} LIKE 'marketing:%'`,
        ),
      );
    const marketingSegments: Record<string, number> = {};
    for (const m of marketing) {
      const seg = m.groupKey?.split(':')[1] ?? 'unknown';
      marketingSegments[seg] = (marketingSegments[seg] ?? 0) + 1;
    }

    const jobFailures = (await getRecentJobFailures(50)).length;

    return {
      date,
      queue: { pending: pending.length, byType },
      autoSent,
      failedDrafts,
      expiredDrafts,
      openEscalations: Number(esc?.n ?? 0),
      paymentWindow: { awaiting: Number(awaiting?.n ?? 0), overdue: Number(overdue?.n ?? 0) },
      llmSpend: { spentMicroUsd, capMicroUsd, overCap: spentMicroUsd >= capMicroUsd },
      upcomingRenewals: Number(renewals?.n ?? 0),
      marketingSegments,
      jobFailures,
    };
  }
}

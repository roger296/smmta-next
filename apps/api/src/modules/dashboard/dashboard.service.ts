/**
 * The Auto-Stock landing page: what needs attention today, across all sites.
 *
 * Three questions, one per tile:
 *   1. Did every bake leader file yesterday's consumption statement?
 *   2. How much stock does each site hold?
 *   3. What does each site need to order?
 *
 * Every section carries its own `available` flag and `reason`. That is
 * deliberate: the page this replaces fetched four endpoints with `Promise.all`
 * and only caught three of them, so a single unconfigured integration blanked
 * the whole dashboard with "Failed to load dashboard data." Here a section that
 * cannot answer says so and the rest still render — which also makes the
 * dashboard double as a setup checklist while the system is being brought up.
 */
import { getDb } from '../../config/database.js';
import { sites } from '../../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { getEnv } from '../../config/env.js';
import { StockQueryService } from '../stock/stock-query.service.js';
import { ReorderService } from '../reorder/reorder.service.js';
import { SessionConsumptionService } from '../consumption/session-consumption.service.js';
import { BumbleBeeSessionClient } from '../consumption/bumblebee-sessions.js';

export interface DashboardSite {
  id: string;
  name: string;
  slug: string | null;
  currencyCode: string;
}

export interface SessionRow {
  siteId: string;
  sessions: number;
  filed: number;
  missing: number;
  missingSessionIds: string[];
}

export interface StockRow {
  siteId: string;
  value: number;
  currencyCode: string;
  linesTracked: number;
}

export interface ReorderRow {
  siteId: string;
  belowReorderPoint: number;
  openProposals: number;
  topItems: Array<{ productId: string; name: string; onHand: number; reorderPoint: number | null }>;
}

export interface DashboardOverview {
  date: string;
  sites: DashboardSite[];
  sessions: { available: boolean; reason?: string; rows: SessionRow[] };
  stock: { available: boolean; reason?: string; rows: StockRow[]; total: number };
  reorder: { available: boolean; reason?: string; rows: ReorderRow[] };
}

/** Yesterday in ISO date form. Sessions are filed at the end of the day, so
 *  "yesterday" is the first day whose statements should all be in. */
export function previousDay(today = new Date()): string {
  const d = new Date(today);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

export class DashboardService {
  async overview(companyId: string, date?: string): Promise<DashboardOverview> {
    const day = date ?? previousDay();
    const db = getDb();

    const siteRows = await db.query.sites.findMany({
      where: eq(sites.companyId, companyId),
    });
    const siteList: DashboardSite[] = siteRows.map((s) => ({
      id: s.id,
      name: s.name,
      slug: s.slug ?? null,
      currencyCode: s.currencyCode ?? 'GBP',
    }));

    const [sessions, stock, reorder] = await Promise.all([
      this.sessions(companyId, siteRows, day),
      this.stock(companyId),
      this.reorder(companyId, siteList),
    ]);

    return { date: day, sites: siteList, sessions, stock, reorder };
  }

  // ── 1. consumption statements ────────────────────────────────────────
  private async sessions(
    companyId: string,
    siteRows: Array<{ id: string; canonicalName: string }>,
    day: string,
  ): Promise<DashboardOverview['sessions']> {
    if (!getEnv().BUMBLEBEE_API_BASE_URL) {
      return {
        available: false,
        reason:
          'BumbleBee is not connected, so the sessions that ran cannot be looked up. ' +
          'Set BUMBLEBEE_API_BASE_URL (and BUMBLEBEE_API_KEY) on the API.',
        rows: [],
      };
    }
    const client = new BumbleBeeSessionClient();
    const consumption = new SessionConsumptionService();
    const rows: SessionRow[] = [];
    const failures: string[] = [];

    for (const site of siteRows) {
      try {
        const daySessions = await client.listSessionsForDay({
          siteCanonicalName: site.canonicalName,
          date: day,
          companyId,
        });
        const awaiting = await consumption.filterAwaiting(site.id, daySessions, companyId);
        rows.push({
          siteId: site.id,
          sessions: daySessions.length,
          filed: daySessions.length - awaiting.length,
          missing: awaiting.length,
          missingSessionIds: awaiting.map((a) => a.sessionId).slice(0, 20),
        });
      } catch (e) {
        // One site failing must not blank the tile for the others — but it must
        // not be reported as a quiet day either. A bad API key and a bank
        // holiday both produce zero sessions; only one of them is fine.
        failures.push(`${site.canonicalName}: ${e instanceof Error ? e.message : 'failed'}`);
      }
    }

    if (rows.length === 0) {
      return {
        available: false,
        reason: `BumbleBee did not answer. ${failures[0] ?? ''}`.trim(),
        rows: [],
      };
    }
    return {
      available: true,
      reason: failures.length ? `Some sites could not be checked — ${failures.join('; ')}` : undefined,
      rows,
    };
  }

  // ── 2. stock held ────────────────────────────────────────────────────
  private async stock(companyId: string): Promise<DashboardOverview['stock']> {
    const stockQuery = new StockQueryService();
    const [valuation, levels] = await Promise.all([
      stockQuery.valuation({ companyId }),
      stockQuery.listLevels({ companyId }),
    ]);
    const linesBySite = new Map<string, number>();
    for (const l of levels) linesBySite.set(l.siteId, (linesBySite.get(l.siteId) ?? 0) + 1);
    const rows: StockRow[] = valuation.bySite.map((s): StockRow => ({
      siteId: s.siteId,
      value: s.value,
      currencyCode: s.currencyCode,
      linesTracked: linesBySite.get(s.siteId) ?? 0,
    }));
    if (rows.length === 0) {
      return {
        available: true,
        reason: 'Nothing counted yet — run a stock-take to give each site an opening position.',
        rows: [],
        total: 0,
      };
    }
    return { available: true, rows, total: Number(valuation.total ?? 0) };
  }

  // ── 3. what to order ─────────────────────────────────────────────────
  private async reorder(
    companyId: string,
    siteList: DashboardSite[],
  ): Promise<DashboardOverview['reorder']> {
    const stockQuery = new StockQueryService();
    const reorderSvc = new ReorderService();
    const rows: ReorderRow[] = [];
    let anyLevelsSet = false;

    for (const site of siteList) {
      const [low, proposals] = await Promise.all([
        stockQuery.lowStock({ siteId: site.id, companyId }),
        reorderSvc.list({ status: 'PROPOSED', siteId: site.id, companyId }),
      ]);
      if (low.length > 0) anyLevelsSet = true;
      rows.push({
        siteId: site.id,
        belowReorderPoint: low.length,
        openProposals: proposals.length,
        // on_hand / reorder_point are numeric columns, so drizzle hands them
        // back as strings — coerce once here rather than in the browser.
        topItems: low.slice(0, 5).map((l) => ({
          productId: l.productId,
          name: l.productName,
          onHand: Number(l.onHand),
          reorderPoint: l.reorderPoint === null ? null : Number(l.reorderPoint),
        })),
      });
    }

    // Nothing below its reorder point can mean "all healthy" or "no levels set
    // at all", and on a new system it is almost always the latter — so say so
    // rather than implying everything is fine.
    const reason = anyLevelsSet
      ? undefined
      : 'No reorder levels set yet, so nothing can be flagged. Set them on the Reorder levels page.';
    return { available: true, reason, rows };
  }
}

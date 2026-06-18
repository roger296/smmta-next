/**
 * Daily consumption COGS / wastage Xero sweep (P17, spec §A8, locked decision 8).
 *
 * Periodic (not real-time): aggregates the day's consumption into COGS
 * (Σ actual × unit cost) and wastage (Σ wastage × unit cost) per site, and
 * posts ONE balanced journal each to Xero via `postConsumptionCOGS` /
 * `postWastage`. Idempotent on the per-(site, day) GL key, so a re-run is a
 * no-op. Dry-run by default (XERO_DRY_RUN), like every other stock GL post.
 * Wired to a systemd timer in P24.
 */
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { sessionConsumption, sessionConsumptionLines } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { XeroGLService } from '../../integrations/xero/xero-gl.service.js';

export interface SweepResult {
  date: string;
  sites: number;
  cogsPosted: number;
  wastagePosted: number;
  totalCogs: number;
  totalWastage: number;
}

export class ConsumptionSweepService {
  private db = getDb();
  private gl = new XeroGLService();

  /** Aggregate + post COGS / wastage for one day (default: every site with
   *  consumption that date). */
  async runDaily(params: { date: string; companyId?: string }): Promise<SweepResult> {
    const companyId = params.companyId ?? getSingletonCompanyId();

    const rows = await this.db
      .select({
        siteId: sessionConsumption.siteId,
        cogs: sql<string>`coalesce(sum(${sessionConsumptionLines.actualQty} * coalesce(${sessionConsumptionLines.unitCost}, 0)), 0)`,
        wastage: sql<string>`coalesce(sum(${sessionConsumptionLines.wastageQty} * coalesce(${sessionConsumptionLines.unitCost}, 0)), 0)`,
      })
      .from(sessionConsumptionLines)
      .innerJoin(
        sessionConsumption,
        eq(sessionConsumptionLines.consumptionId, sessionConsumption.id),
      )
      .where(
        and(
          eq(sessionConsumption.companyId, companyId),
          eq(sessionConsumption.sessionDate, params.date),
        ),
      )
      .groupBy(sessionConsumption.siteId);

    const date = new Date(`${params.date}T00:00:00.000Z`);
    let cogsPosted = 0;
    let wastagePosted = 0;
    let totalCogs = 0;
    let totalWastage = 0;

    for (const row of rows) {
      const cogs = round2(Number(row.cogs));
      const wastage = round2(Number(row.wastage));
      const label = `${params.date} — site ${row.siteId.slice(0, 8)}`;
      if (cogs > 0) {
        await this.gl.postConsumptionCOGS(getDb(), {
          companyId,
          sourceKey: `${row.siteId}:${params.date}`,
          date,
          amount: cogs,
          label,
        });
        cogsPosted += 1;
        totalCogs += cogs;
      }
      if (wastage > 0) {
        await this.gl.postWastage(getDb(), {
          companyId,
          sourceKey: `${row.siteId}:${params.date}`,
          date,
          amount: wastage,
          label,
        });
        wastagePosted += 1;
        totalWastage += wastage;
      }
    }

    return {
      date: params.date,
      sites: rows.length,
      cogsPosted,
      wastagePosted,
      totalCogs: round2(totalCogs),
      totalWastage: round2(totalWastage),
    };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

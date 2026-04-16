import { LucaClient } from '../../integrations/luca/luca-client.js';

/**
 * YearEndService — Delegates year-end close to Luca's built-in gl_year_end_close.
 *
 * Source: Libraries/DSB.Service/Ledgers/GeneralLedgerServices.cs
 *   PerformFinancialYearEnd (lines 26-105) — reverses P&L, posts to reserves.
 *
 * In the new architecture, Luca handles this natively. We just call the API.
 */
export class YearEndService {
  private client = new LucaClient();

  /**
   * Trigger year-end close in Luca.
   * @param financialYearEnd - Last period of the closing year (e.g. "2026-03")
   * @param newYearFirstPeriod - First period of the new year (e.g. "2026-04")
   */
  async performYearEndClose(financialYearEnd: string, newYearFirstPeriod: string) {
    const result = await this.client.yearEndClose({
      financial_year_end: financialYearEnd,
      new_year_first_period: newYearFirstPeriod,
    });
    return result;
  }

  /**
   * Check period status before year-end close.
   */
  async checkPeriodStatus(periodId: string) {
    return this.client.getPeriodStatus(periodId);
  }
}

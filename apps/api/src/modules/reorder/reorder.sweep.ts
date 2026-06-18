/**
 * Daily reorder sweep (P7, spec §A7). Catches items that are at/below their
 * reorder point but that no decrement happened to touch today (e.g. slow
 * shrinkage, a par raised above current on-hand). Mirrors the supplier-poll
 * worker pattern; wired to a systemd timer in P24.
 */
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { StockQueryService } from '../stock/stock-query.service.js';
import { ReorderService } from './reorder.service.js';

export interface SweepResult {
  evaluated: number;
  created: number;
}

export async function runReorderSweep(companyId = getSingletonCompanyId()): Promise<SweepResult> {
  const low = await new StockQueryService().lowStock({ companyId });
  const svc = new ReorderService();
  let created = 0;
  for (const row of low) {
    const res = await svc.evaluate(row.productId, row.siteId, {
      triggeredBy: 'sweep',
      companyId,
    });
    if (res.created) created += 1;
  }
  return { evaluated: low.length, created };
}

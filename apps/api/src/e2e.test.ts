/**
 * Auto-Stock end-to-end (P25, spec §A1-A12). Real Postgres, isolated company.
 *
 * Drives the whole spine across two sites (UK metric/GBP + Dallas USD/imperial):
 * seed → goods-in → Square sale (reorder fires) → stock-take true-up →
 * head-baker consumption → daily COGS/wastage + BumbleBee sweeps → MCP read
 * tools + one guarded write tool. Then asserts the cross-cutting invariants:
 * ledger sum = on-hand; every GL journal balances + is dry-run (nothing sent to
 * a real org); every idempotent op is a no-op on replay; the two sites value in
 * their own currencies.
 *
 * No real golden dataset is shipped — this builds a representative fixture and
 * asserts the invariants on it. A real sampled golden file is still wanted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import { closeDatabase, getDb } from './config/database.js';
import {
  bumblebeeSyncLog,
  glPostingLog,
  goodsInReceiptLines,
  goodsInReceipts,
  mcpAuditLog,
  products,
  recipeLines,
  recipes,
  reorderProposals,
  sessionConsumption,
  sessionConsumptionLines,
  sites,
  squareItemMap,
  stockLevels,
  stockMovements,
  stockTakeLines,
  stockTakes,
} from './db/schema/index.js';
import { SiteService } from './modules/sites/site.service.js';
import { RecipeService } from './modules/recipes/recipe.service.js';
import { GoodsInService } from './modules/goods-in/goods-in.service.js';
import { SquareDecrementService } from './modules/square/square-decrement.service.js';
import { StockTakeService } from './modules/stock-take/stock-take.service.js';
import { SessionConsumptionService } from './modules/consumption/session-consumption.service.js';
import { ConsumptionSweepService } from './modules/consumption/consumption-sweep.service.js';
import { StockLevelService } from './modules/stock/stock-level.service.js';
import { StockQueryService } from './modules/stock/stock-query.service.js';
import { getMcpTool } from './modules/mcp/tools.js';
import { getMcpActionTool } from './modules/mcp/action-tools.js';

const COMPANY = 'eeeeeeee-e2e2-4e2e-8e2e-eeeeeeeeeeee';
const levels = new StockLevelService();
const query = new StockQueryService();

let ukId: string;
let dallasId: string;
let flourId: string;
let cookieId: string;
let butterId: string;
const DATE = '2026-06-18';
const SESSION = 'e2e-sess';

async function clearAll(): Promise<void> {
  const db = getDb();
  const del = [
    db.delete(bumblebeeSyncLog).where(eq(bumblebeeSyncLog.companyId, COMPANY)),
    db.delete(sessionConsumptionLines).where(eq(sessionConsumptionLines.companyId, COMPANY)),
    db.delete(mcpAuditLog).where(eq(mcpAuditLog.companyId, COMPANY)),
  ];
  await Promise.all(del);
  await db.delete(sessionConsumption).where(eq(sessionConsumption.companyId, COMPANY));
  const takes = await db.select({ id: stockTakes.id }).from(stockTakes).where(eq(stockTakes.companyId, COMPANY));
  for (const t of takes) await db.delete(stockTakeLines).where(eq(stockTakeLines.stockTakeId, t.id));
  await db.delete(stockTakes).where(eq(stockTakes.companyId, COMPANY));
  const receipts = await db.select({ id: goodsInReceipts.id }).from(goodsInReceipts).where(eq(goodsInReceipts.companyId, COMPANY));
  for (const r of receipts) await db.delete(goodsInReceiptLines).where(eq(goodsInReceiptLines.receiptId, r.id));
  await db.delete(goodsInReceipts).where(eq(goodsInReceipts.companyId, COMPANY));
  await db.delete(reorderProposals).where(eq(reorderProposals.companyId, COMPANY));
  await db.delete(squareItemMap).where(eq(squareItemMap.companyId, COMPANY));
  await db.delete(glPostingLog).where(eq(glPostingLog.companyId, COMPANY));
  await db.delete(stockMovements).where(eq(stockMovements.companyId, COMPANY));
  await db.delete(stockLevels).where(eq(stockLevels.companyId, COMPANY));
  await db.delete(recipeLines).where(eq(recipeLines.companyId, COMPANY));
  await db.delete(recipes).where(eq(recipes.companyId, COMPANY));
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
}

beforeAll(async () => {
  const db = getDb();
  await clearAll();

  // ── Sites: UK (GBP/metric) + Dallas (USD/imperial) ───────────────────
  ukId = (await new SiteService().create({ slug: 'e2e-uk', name: 'E2E UK', currencyCode: 'GBP', uomSystem: 'METRIC' }, COMPANY)).id;
  dallasId = (await new SiteService().create({ slug: 'e2e-dallas', name: 'E2E Dallas', currencyCode: 'USD', uomSystem: 'IMPERIAL', timezone: 'America/Chicago' }, COMPANY)).id;

  // ── Products + recipe ────────────────────────────────────────────────
  flourId = (await db.insert(products).values({ companyId: COMPANY, name: 'E2E Flour', slug: 'e2e-flour', itemKind: 'INGREDIENT', stockUom: 'g', purchaseUom: 'kg', purchaseToStockFactor: '1000', expectedNextCost: '0.05' }).returning())[0]!.id;
  cookieId = (await db.insert(products).values({ companyId: COMPANY, name: 'E2E Cookie', slug: 'e2e-cookie', itemKind: 'RETAIL', stockUom: 'each', isSold: true, expectedNextCost: '2.00' }).returning())[0]!.id;
  butterId = (await db.insert(products).values({ companyId: COMPANY, name: 'E2E Butter', slug: 'e2e-butter', itemKind: 'INGREDIENT', stockUom: 'oz', purchaseUom: 'lb', purchaseToStockFactor: '16', expectedNextCost: '0.10' }).returning())[0]!.id;
  await new RecipeService().create({ bake: 'Victoria Sponge', effectiveFrom: '2026-01-01', lines: [{ productId: flourId, qtyPerCover: 100 }], companyId: COMPANY });

  const goodsIn = new GoodsInService();

  // 1. Goods-in: 10 kg flour @ £50/kg → 10000 g at UK; GRN posts (dry-run).
  await goodsIn.receive({ siteId: ukId, idempotencyKey: 'e2e-grn-flour', lines: [{ productId: flourId, qtyPurchase: 10, unitCost: 50 }], companyId: COMPANY });
  // Cookie: 8 each @ £2; then set reorder params.
  await goodsIn.receive({ siteId: ukId, idempotencyKey: 'e2e-grn-cookie', lines: [{ productId: cookieId, qtyPurchase: 8, unitCost: 2 }], companyId: COMPANY });
  await levels.setReorderParams({ productId: cookieId, siteId: ukId, reorderPoint: 5, reorderUpTo: 50, companyId: COMPANY });
  await levels.setReorderParams({ productId: flourId, siteId: ukId, reorderPoint: 2000, reorderUpTo: 12000, companyId: COMPANY });
  // Dallas: 2 lb butter @ $0.10/lb → 32 oz (USD).
  await goodsIn.receive({ siteId: dallasId, idempotencyKey: 'e2e-grn-butter', lines: [{ productId: butterId, qtyPurchase: 2, unitCost: 0.1 }], companyId: COMPANY });

  // 2. Square sale: 5 cookies at UK → on-hand 3 ≤ point 5 → reorder fires.
  await new SquareDecrementService().ingestLine({ channelSlug: 'square', sourcePk: 'ord-1', sourceLineRef: 'L1', qty: 5, productId: cookieId, siteId: ukId, companyId: COMPANY });

  // 3. Stock-take flour: count 9800 vs book 10000 → −200 true-up + SADJ (dry-run).
  const take = await new StockTakeService().open({ siteId: ukId, scope: 'ITEM', scopeRef: flourId, companyId: COMPANY });
  await new StockTakeService().recordCounts(take.take.id, [{ productId: flourId, countedQty: 9800 }]);
  await new StockTakeService().approve(take.take.id, COMPANY);

  // 4. Head-baker consumption: CLASSIC × 8 covers; flour actual 750 + wastage 50.
  await new SessionConsumptionService().submit({
    sessionId: SESSION, siteId: ukId, sessionDate: DATE, bakerName: 'E2E Baker',
    bake: 'Victoria Sponge',
    covers: 8,
    lines: [{ productId: flourId, actualQty: 750, wastageQty: 50, wastageReason: 'spill' }],
    clientKey: 'e2e-c1', companyId: COMPANY,
  });

  // 5. Daily sweeps: COGS/wastage → Xero (dry-run).
  await new ConsumptionSweepService().runDaily({ date: DATE, companyId: COMPANY });
});

afterAll(async () => {
  await clearAll();
  await closeDatabase();
});

describe('ledger invariant — on-hand = Σ movements', () => {
  it('the cache equals the recomputed ledger sum for every (product, site)', async () => {
    for (const [pid, sid] of [[flourId, ukId], [cookieId, ukId], [butterId, dallasId]] as const) {
      const cache = await levels.getOnHand(pid, sid, COMPANY);
      const recomputed = await levels.recomputeOnHand(pid, sid, COMPANY);
      expect(Number(cache)).toBe(Number(recomputed));
    }
    // The spine's arithmetic: flour = 10000 − 200 (stock-take) − 750 − 50 = 9000.
    expect(Number(await levels.getOnHand(flourId, ukId, COMPANY))).toBe(9000);
    expect(Number(await levels.getOnHand(cookieId, ukId, COMPANY))).toBe(3); // 8 − 5
    expect(Number(await levels.getOnHand(butterId, dallasId, COMPANY))).toBe(32); // 2 lb × 16
  });
});

describe('GL invariant — every journal balances + is dry-run', () => {
  it('all gl_posting_log journals net to zero and posted nothing to a real org', async () => {
    const rows = await getDb()
      .select({ payload: glPostingLog.requestPayload, marker: glPostingLog.lucaTransactionId, status: glPostingLog.status })
      .from(glPostingLog)
      .where(eq(glPostingLog.companyId, COMPANY));
    expect(rows.length).toBeGreaterThan(0); // GRNs + SADJ + COGS + wastage
    for (const r of rows) {
      expect(r.status).toBe('SUCCESS');
      expect(r.marker ?? '').toMatch(/^DRYRUN/); // nothing sent to a real Xero org
      const lines = (r.payload as { journalLines?: Array<{ lineAmount: number }> }).journalLines ?? [];
      const net = Math.round(lines.reduce((s, l) => s + l.lineAmount, 0) * 100) / 100;
      expect(net).toBe(0);
    }
  });
});

describe('consumption + sweeps', () => {
  it('records materials cost + variance and posts dry-run COGS/wastage', async () => {
    const rec = await new SessionConsumptionService().getBySession(SESSION, COMPANY);
    expect(Number(rec!.record.materialsCost)).toBe(37.5); // 750 × 0.05
    expect(Number(rec!.lines[0]!.variance)).toBe(-50); // 750 − (100×8)

    // COGS + wastage journals exist for the site/day, dry-run.
    const cogs = await getDb().select({ id: glPostingLog.id }).from(glPostingLog).where(eq(glPostingLog.idempotencyKey, `CCOGS-${ukId}:${DATE}-v1`));
    const waste = await getDb().select({ id: glPostingLog.id }).from(glPostingLog).where(eq(glPostingLog.idempotencyKey, `WASTE-${ukId}:${DATE}-v1`));
    expect(cogs).toHaveLength(1);
    expect(waste).toHaveLength(1);

    // BumbleBee materials-cost push logged dry-run (nothing sent).
    const sync = await getDb().select({ dryRun: bumblebeeSyncLog.dryRun }).from(bumblebeeSyncLog).where(and(eq(bumblebeeSyncLog.companyId, COMPANY), eq(bumblebeeSyncLog.sourceKey, SESSION)));
    expect(sync[0]!.dryRun).toBe(true);
  });
});

describe('reorder fired on the Square sale', () => {
  it('a proposal was raised for the cookie below its reorder point', async () => {
    const proposals = await getDb().select({ id: reorderProposals.id }).from(reorderProposals).where(and(eq(reorderProposals.companyId, COMPANY), eq(reorderProposals.productId, cookieId)));
    expect(proposals.length).toBeGreaterThanOrEqual(1);
  });
});

describe('multi-currency valuation', () => {
  it('the UK site values in GBP and Dallas in USD', async () => {
    const all = await query.valuation({ companyId: COMPANY });
    expect(all.bySite.find((s) => s.siteId === ukId)!.currencyCode).toBe('GBP');
    expect(all.bySite.find((s) => s.siteId === dallasId)!.currencyCode).toBe('USD');
  });
});

describe('MCP read tools + one guarded write tool', () => {
  it('stock_on_hand matches the service', async () => {
    const tool = getMcpTool('stock_on_hand')!;
    const out = (await tool.handler({ site: ukId }, { companyId: COMPANY })) as Array<{ productId: string }>;
    const svc = await query.listLevels({ siteId: ukId, companyId: COMPANY });
    expect(out.length).toBe(svc.length);
  });

  it('adjust_stock (write + confirm) performs exactly one audited movement', async () => {
    const before = await getDb().select({ id: stockMovements.id }).from(stockMovements).where(and(eq(stockMovements.companyId, COMPANY), eq(stockMovements.productId, cookieId)));
    const tool = getMcpActionTool('adjust_stock')!;
    const res = (await tool.execute({ productId: cookieId, site: ukId, qtyDelta: 2, idempotencyKey: 'e2e-adj' }, { companyId: COMPANY })) as { applied: boolean };
    expect(res.applied).toBe(true);
    const after = await getDb().select({ id: stockMovements.id }).from(stockMovements).where(and(eq(stockMovements.companyId, COMPANY), eq(stockMovements.productId, cookieId)));
    expect(after.length).toBe(before.length + 1);
    expect(Number(await levels.getOnHand(cookieId, ukId, COMPANY))).toBe(5); // 3 + 2
  });
});

describe('idempotency — replays are no-ops', () => {
  it('goods-in / consumption-submit / daily-sweep all no-op on replay', async () => {
    // Goods-in replay (same key) → existing receipt, no extra movement.
    const beforeMoves = (await getDb().select({ id: stockMovements.id }).from(stockMovements).where(and(eq(stockMovements.companyId, COMPANY), eq(stockMovements.sourceSystem, 'goods-in')))).length;
    const replay = await new GoodsInService().receive({ siteId: ukId, idempotencyKey: 'e2e-grn-flour', lines: [{ productId: flourId, qtyPurchase: 10, unitCost: 50 }], companyId: COMPANY });
    expect(replay.alreadyExisted).toBe(true);
    const afterMoves = (await getDb().select({ id: stockMovements.id }).from(stockMovements).where(and(eq(stockMovements.companyId, COMPANY), eq(stockMovements.sourceSystem, 'goods-in')))).length;
    expect(afterMoves).toBe(beforeMoves);

    // Consumption replay (same clientKey) → version unchanged.
    const re = await new SessionConsumptionService().submit({
      sessionId: SESSION, siteId: ukId, sessionDate: DATE, bakerName: 'E2E Baker',
      bake: 'Victoria Sponge',
    covers: 8,
      lines: [{ productId: flourId, actualQty: 750, wastageQty: 50, wastageReason: 'spill' }],
      clientKey: 'e2e-c1', companyId: COMPANY,
    });
    expect(re.record.version).toBe(1);

    // Daily sweep replay (same day) → no new COGS journal.
    const cogsBefore = (await getDb().select({ id: glPostingLog.id }).from(glPostingLog).where(like(glPostingLog.idempotencyKey, `CCOGS-${ukId}:${DATE}%`))).length;
    await new ConsumptionSweepService().runDaily({ date: DATE, companyId: COMPANY });
    const cogsAfter = (await getDb().select({ id: glPostingLog.id }).from(glPostingLog).where(like(glPostingLog.idempotencyKey, `CCOGS-${ukId}:${DATE}%`))).length;
    expect(cogsAfter).toBe(cogsBefore);
  });
});

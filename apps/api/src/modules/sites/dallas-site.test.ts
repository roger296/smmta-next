/**
 * Dallas / US site (P20, spec §A5/§7). Real Postgres, isolated company.
 *
 * Proves a first-class USD/imperial site needs no code change: creating Dallas
 * needs no migration; a USD site values stock in USD; an imperial recipe/UoM
 * round-trips in lb/oz; a Dallas GRN posts in USD; valuation segregates Dallas.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import {
  glPostingLog,
  goodsInReceiptLines,
  goodsInReceipts,
  products,
  sites,
  stockLevels,
  stockMovements,
} from '../../db/schema/index.js';
import { SiteService } from './site.service.js';
import { GoodsInService } from '../goods-in/goods-in.service.js';
import { StockQueryService } from '../stock/stock-query.service.js';
import { purchaseToStock, stockToPurchase } from '../stock/uom.js';

const COMPANY = 'b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9b9';
const siteSvc = new SiteService();
const goodsIn = new GoodsInService();
const query = new StockQueryService();

let ukId: string;
let dallasId: string;
let butterId: string;
let flourId: string;

async function clear(): Promise<void> {
  const db = getDb();
  const receipts = await db
    .select({ id: goodsInReceipts.id })
    .from(goodsInReceipts)
    .where(eq(goodsInReceipts.companyId, COMPANY));
  for (const r of receipts) await db.delete(goodsInReceiptLines).where(eq(goodsInReceiptLines.receiptId, r.id));
  await db.delete(goodsInReceipts).where(eq(goodsInReceipts.companyId, COMPANY));
  await db.delete(glPostingLog).where(eq(glPostingLog.companyId, COMPANY));
  await db.delete(stockMovements).where(eq(stockMovements.companyId, COMPANY));
  await db.delete(stockLevels).where(eq(stockLevels.companyId, COMPANY));
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
}

beforeAll(async () => {
  const db = getDb();
  await clear();
  const uk = await siteSvc.create(
    { slug: 'd-uk', name: 'D UK', currencyCode: 'GBP', uomSystem: 'METRIC' },
    COMPANY,
  );
  ukId = uk.id;
  // Dallas — USD, imperial, Central time. No migration, no code change.
  const dallas = await siteSvc.create(
    { slug: 'd-dallas', name: 'Dallas', currencyCode: 'USD', uomSystem: 'IMPERIAL', timezone: 'America/Chicago' },
    COMPANY,
  );
  dallasId = dallas.id;

  const [b] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'D Butter', slug: 'd-butter', itemKind: 'INGREDIENT', stockUom: 'oz', purchaseUom: 'lb', purchaseToStockFactor: '16', expectedNextCost: '0.10' })
    .returning();
  butterId = b!.id;
  const [f] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'D Flour', slug: 'd-flour', itemKind: 'INGREDIENT', stockUom: 'g', expectedNextCost: '0.05' })
    .returning();
  flourId = f!.id;
});

afterAll(async () => {
  await clear();
  await closeDatabase();
});

describe('site creation', () => {
  it('creates a USD/imperial site with no migration', async () => {
    const dallas = await siteSvc.get(dallasId, COMPANY);
    expect(dallas!.currencyCode).toBe('USD');
    expect(dallas!.uomSystem).toBe('IMPERIAL');
    expect(dallas!.timezone).toBe('America/Chicago');
  });
});

describe('imperial UoM round-trip', () => {
  it('round-trips lb ↔ oz via the purchase-to-stock factor (1 lb = 16 oz)', () => {
    expect(purchaseToStock(2, 16)).toBe(32); // 2 lb → 32 oz
    expect(stockToPurchase(32, 16)).toBe(2); // 32 oz → 2 lb
  });
});

describe('Dallas GRN + USD valuation', () => {
  it('a Dallas GRN moves stock + posts in USD, and values in USD', async () => {
    // Receive 2 lb of butter at Dallas @ $0.10/lb → 32 oz on hand.
    await goodsIn.receive({
      siteId: dallasId,
      idempotencyKey: 'd-grn-1',
      lines: [{ productId: butterId, qtyPurchase: 2, unitCost: 0.1 }],
      companyId: COMPANY,
    });

    // The GRN stock movement is in USD.
    const move = await getDb().query.stockMovements.findFirst({
      where: eq(stockMovements.sourceKey, `${(await goodsIn.list({ siteId: dallasId, companyId: COMPANY }))[0]!.id}:${butterId}`),
    });
    expect(move!.currencyCode).toBe('USD');
    expect(Number(move!.qtyDelta)).toBe(32); // 2 lb × 16

    // Valuation reports Dallas in USD.
    const val = await query.valuation({ siteId: dallasId, companyId: COMPANY });
    expect(val.bySite[0]!.currencyCode).toBe('USD');
    // 32 oz × ($0.10/16 per oz); per-stock unit cost rounds to 4dp ⇒ ~$0.20.
    expect(val.bySite[0]!.value).toBeCloseTo(0.2, 2);

    // The Xero GRN journal records USD.
    const posting = await getDb().query.glPostingLog.findFirst({
      where: eq(glPostingLog.idempotencyKey, 'GRN-d-grn-1-v1'),
    });
    expect((posting!.requestPayload as { currencyCode?: string }).currencyCode).toBe('USD');
  });
});

describe('valuation segregates sites by currency', () => {
  it('a GBP site and a USD site value in their own currencies', async () => {
    await goodsIn.receive({
      siteId: ukId,
      idempotencyKey: 'd-grn-uk',
      lines: [{ productId: flourId, qtyPurchase: 1000, unitCost: 0.05 }],
      companyId: COMPANY,
    });
    const val = await query.valuation({ companyId: COMPANY });
    const uk = val.bySite.find((s) => s.siteId === ukId)!;
    const dallas = val.bySite.find((s) => s.siteId === dallasId)!;
    expect(uk.currencyCode).toBe('GBP');
    expect(dallas.currencyCode).toBe('USD');
  });
});

/**
 * Stock-takes (P9, spec §A6). Real Postgres, isolated company.
 *
 * Covers: opening snapshots book stock; counts compute the right variance;
 * approval trues up on-hand and posts one adjustment (idempotent on re-approve);
 * a partial-scope (ITEM) take only touches the in-scope product.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import {
  glPostingLog,
  products,
  sites,
  stockLevels,
  stockMovements,
  stockTakeLines,
  stockTakes,
} from '../../db/schema/index.js';
import { StockLevelService } from '../stock/stock-level.service.js';
import { StockTakeService } from './stock-take.service.js';

const COMPANY = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3';
const svc = new StockTakeService();
const levels = new StockLevelService();
let siteId: string;
let flourId: string;
let sugarId: string;

async function clear(): Promise<void> {
  const db = getDb();
  const takes = await db.select({ id: stockTakes.id }).from(stockTakes).where(eq(stockTakes.companyId, COMPANY));
  for (const t of takes) await db.delete(stockTakeLines).where(eq(stockTakeLines.stockTakeId, t.id));
  await db.delete(stockTakes).where(eq(stockTakes.companyId, COMPANY));
  await db.delete(stockMovements).where(eq(stockMovements.companyId, COMPANY));
  await db.delete(stockLevels).where(eq(stockLevels.companyId, COMPANY));
}

async function setLevel(productId: string, onHand: number): Promise<void> {
  await getDb().insert(stockLevels).values({
    companyId: COMPANY,
    productId,
    siteId,
    onHand: String(onHand),
  });
}

beforeAll(async () => {
  const db = getDb();
  await clear();
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
  const [f] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'ST Flour', slug: 'st-flour', itemKind: 'INGREDIENT', stockUom: 'g', expectedNextCost: '0.01' })
    .returning();
  const [s] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'ST Sugar', slug: 'st-sugar', itemKind: 'INGREDIENT', stockUom: 'g', expectedNextCost: '0.01' })
    .returning();
  flourId = f!.id;
  sugarId = s!.id;
  const [site] = await db
    .insert(sites)
    .values({ companyId: COMPANY, slug: 'st-site', name: 'ST Site', canonicalName: 'ST Site' })
    .returning();
  siteId = site!.id;
});

beforeEach(clear);

afterAll(async () => {
  const db = getDb();
  await clear();
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
  await closeDatabase();
});

describe('open', () => {
  it('snapshots book stock for the scope', async () => {
    await setLevel(flourId, 5000);
    await setLevel(sugarId, 3000);
    const { lines } = await svc.open({ siteId, scope: 'FULL', companyId: COMPANY });
    expect(lines).toHaveLength(2);
    const flourLine = lines.find((l) => l.productId === flourId)!;
    expect(Number(flourLine.bookQty)).toBe(5000);
  });

  // ── D-1b: the count screen must not need a second request to name a row ──
  it('D-1b: returns product identity ON each line', async () => {
    await setLevel(flourId, 5000);
    const { lines } = await svc.open({ siteId, scope: 'FULL', companyId: COMPANY });
    const line = lines.find((l) => l.productId === flourId)!;
    expect(line.productName).toBe('ST Flour');
    expect(line.stockUom).toBe('g');
    expect(line.itemKind).toBe('INGREDIENT');
    expect(line).toHaveProperty('stockCode');
  });

  it('D-1b: GET also carries the identity, so a resumed take is legible too', async () => {
    await setLevel(flourId, 5000);
    const { take } = await svc.open({ siteId, scope: 'FULL', companyId: COMPANY });
    const got = await svc.get(take.id, COMPANY);
    expect(got!.lines[0]!.productName).toBe('ST Flour');
  });

  it('D-1b: the join never drops a line — every stock_take_line comes back', async () => {
    // `stock_take_lines.product_id` has an FK to `products`, so a genuinely
    // orphaned line cannot exist today. The join is nevertheless a LEFT join
    // and the mapper coalesces to null, so if that FK is ever relaxed a
    // nameless line degrades to "Unknown product" on the count sheet rather
    // than vanishing from it. This asserts the no-drop half, which is the
    // half a wrong (inner) join would break.
    await setLevel(flourId, 5000);
    await setLevel(sugarId, 3000);
    const { take, lines } = await svc.open({ siteId, scope: 'FULL', companyId: COMPANY });

    const rows = await getDb()
      .select({ id: stockTakeLines.id })
      .from(stockTakeLines)
      .where(eq(stockTakeLines.stockTakeId, take.id));

    expect(lines).toHaveLength(rows.length);
    expect(lines.every((l) => l.productName !== undefined)).toBe(true);
  });
});

describe('counts + approval', () => {
  it('computes variance, trues up on-hand and posts one adjustment (idempotent)', async () => {
    await setLevel(flourId, 5000);
    const { take } = await svc.open({ siteId, scope: 'FULL', companyId: COMPANY });
    // Counted 4800 vs book 5000 → variance −200.
    await svc.recordCounts(take.id, [{ productId: flourId, countedQty: 4800 }]);
    const got = await svc.get(take.id, COMPANY);
    expect(Number(got!.lines[0]!.variance)).toBe(-200);

    await svc.approve(take.id, COMPANY);
    // On-hand trued up to the counted value.
    expect(Number(await levels.getOnHand(flourId, siteId, COMPANY))).toBe(4800);

    // Exactly one SADJ posted; re-approve is a no-op.
    const sadj = () =>
      getDb().select({ id: glPostingLog.id }).from(glPostingLog).where(eq(glPostingLog.idempotencyKey, `SADJ-${take.id}-v1`));
    expect(await sadj()).toHaveLength(1);
    await svc.approve(take.id, COMPANY);
    expect(await sadj()).toHaveLength(1);
    expect(Number(await levels.getOnHand(flourId, siteId, COMPANY))).toBe(4800); // unchanged
  });

  it('is offline-idempotent on a re-submitted count batch', async () => {
    await setLevel(flourId, 5000);
    const { take } = await svc.open({ siteId, scope: 'FULL', companyId: COMPANY });
    await svc.recordCount({ stockTakeId: take.id, productId: flourId, countedQty: 4800, countIdempotencyKey: 'k1' });
    // Replay the same client key — must not overwrite with a different value.
    await svc.recordCount({ stockTakeId: take.id, productId: flourId, countedQty: 9999, countIdempotencyKey: 'k1' });
    const got = await svc.get(take.id, COMPANY);
    expect(Number(got!.lines[0]!.countedQty)).toBe(4800);
  });
});

describe('partial scope', () => {
  it('an ITEM-scope take only touches the in-scope product', async () => {
    await setLevel(flourId, 5000);
    await setLevel(sugarId, 3000);
    const { take, lines } = await svc.open({ siteId, scope: 'ITEM', scopeRef: flourId, companyId: COMPANY });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.productId).toBe(flourId);
    await svc.recordCounts(take.id, [{ productId: flourId, countedQty: 5200 }]);
    await svc.approve(take.id, COMPANY);
    expect(Number(await levels.getOnHand(flourId, siteId, COMPANY))).toBe(5200); // trued up
    expect(Number(await levels.getOnHand(sugarId, siteId, COMPANY))).toBe(3000); // untouched
  });
});

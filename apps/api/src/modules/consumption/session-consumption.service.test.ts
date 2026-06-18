/**
 * Head-baker consumption (P16, spec §A6). Real Postgres, isolated company.
 *
 * Covers: submit decrements each ingredient by actual qty (CONSUMPTION) and
 * wastage separately (WASTAGE, with reason); variance vs expected; one record
 * per session (re-submit amends + posts the corrective delta, never duplicates);
 * a site-scoped actor can only submit its own site; an offline replay (same
 * client key) is a no-op.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import {
  products,
  recipeLines,
  recipes,
  sessionConsumption,
  sessionConsumptionLines,
  sites,
  stockLevels,
  stockMovements,
} from '../../db/schema/index.js';
import { RecipeService } from '../recipes/recipe.service.js';
import { StockLevelService } from '../stock/stock-level.service.js';
import { SessionConsumptionService } from './session-consumption.service.js';

const COMPANY = 'e6e6e6e6-e6e6-4e6e-8e6e-e6e6e6e6e6e6';
const svc = new SessionConsumptionService();
const levels = new StockLevelService();
const recipeSvc = new RecipeService();

let siteId: string;
let otherSiteId: string;
let flourId: string;
let sugarId: string;

async function clearLedger(): Promise<void> {
  const db = getDb();
  await db.delete(sessionConsumptionLines).where(eq(sessionConsumptionLines.companyId, COMPANY));
  await db.delete(sessionConsumption).where(eq(sessionConsumption.companyId, COMPANY));
  await db.delete(stockMovements).where(eq(stockMovements.companyId, COMPANY));
  await db.delete(stockLevels).where(eq(stockLevels.companyId, COMPANY));
}

async function setLevel(productId: string, onHand: number): Promise<void> {
  await getDb().insert(stockLevels).values({ companyId: COMPANY, productId, siteId, onHand: String(onHand) });
}

beforeAll(async () => {
  const db = getDb();
  await clearLedger();
  await db.delete(recipeLines).where(eq(recipeLines.companyId, COMPANY));
  await db.delete(recipes).where(eq(recipes.companyId, COMPANY));
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));

  const [f] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'C Flour', slug: 'c-flour', itemKind: 'INGREDIENT', stockUom: 'g', expectedNextCost: '0.05' })
    .returning();
  const [s] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'C Sugar', slug: 'c-sugar', itemKind: 'INGREDIENT', stockUom: 'g', expectedNextCost: '0.02' })
    .returning();
  flourId = f!.id;
  sugarId = s!.id;

  const [site] = await db
    .insert(sites)
    .values({ companyId: COMPANY, slug: 'c-site', name: 'C Site', canonicalName: 'C Site' })
    .returning();
  siteId = site!.id;
  const [other] = await db
    .insert(sites)
    .values({ companyId: COMPANY, slug: 'c-other', name: 'C Other', canonicalName: 'C Other' })
    .returning();
  otherSiteId = other!.id;

  // CLASSIC recipe: 100 g flour + 50 g sugar per cover.
  await recipeSvc.create({
    experience: 'CLASSIC',
    effectiveFrom: '2026-01-01',
    lines: [
      { productId: flourId, qtyPerCover: 100 },
      { productId: sugarId, qtyPerCover: 50 },
    ],
    companyId: COMPANY,
  });
});

beforeEach(clearLedger);

afterAll(async () => {
  const db = getDb();
  await clearLedger();
  await db.delete(recipeLines).where(eq(recipeLines.companyId, COMPANY));
  await db.delete(recipes).where(eq(recipes.companyId, COMPANY));
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
  await closeDatabase();
});

const SESSION = 'sess-001';
const baseInput = () => ({
  sessionId: SESSION,
  siteId,
  sessionDate: '2026-06-18',
  bakerName: 'Sam Baker',
  coverGroups: [{ experience: 'CLASSIC' as const, covers: 8 }],
  companyId: COMPANY,
});

describe('submit', () => {
  it('decrements actual + wastage, records reason, computes variance + materials cost', async () => {
    await setLevel(flourId, 5000);
    await setLevel(sugarId, 5000);

    const { record, lines } = await svc.submit({
      ...baseInput(),
      lines: [
        { productId: flourId, actualQty: 750, wastageQty: 50, wastageReason: 'Spillage' },
        { productId: sugarId, actualQty: 400 },
      ],
    });

    // On-hand fell by actual + wastage.
    expect(Number(await levels.getOnHand(flourId, siteId, COMPANY))).toBe(4200); // 5000 − 750 − 50
    expect(Number(await levels.getOnHand(sugarId, siteId, COMPANY))).toBe(4600); // 5000 − 400

    const flour = lines.find((l) => l.productId === flourId)!;
    expect(Number(flour.expectedQty)).toBe(800); // 100 × 8
    expect(Number(flour.variance)).toBe(-50); // 750 − 800
    expect(Number(flour.wastageQty)).toBe(50);
    expect(flour.wastageReason).toBe('Spillage');

    // Materials cost = Σ(actual × unit cost) = 750×0.05 + 400×0.02 = 45.50.
    expect(Number(record.materialsCost)).toBe(45.5);

    // Separate movement types.
    const moves = await getDb()
      .select({ type: stockMovements.movementType, qty: stockMovements.qtyDelta })
      .from(stockMovements)
      .where(and(eq(stockMovements.companyId, COMPANY), eq(stockMovements.productId, flourId)));
    const cons = moves.find((m) => m.type === 'CONSUMPTION')!;
    const waste = moves.find((m) => m.type === 'WASTAGE')!;
    expect(Number(cons.qty)).toBe(-750);
    expect(Number(waste.qty)).toBe(-50);
  });
});

describe('amend', () => {
  it('re-submitting the session amends in place and posts only the corrective delta', async () => {
    await setLevel(flourId, 5000);
    await svc.submit({ ...baseInput(), lines: [{ productId: flourId, actualQty: 750 }] });
    expect(Number(await levels.getOnHand(flourId, siteId, COMPANY))).toBe(4250);

    // Amend down to 700 actual → +50 returned to stock.
    const { record, lines } = await svc.submit({ ...baseInput(), lines: [{ productId: flourId, actualQty: 700 }] });
    expect(record.version).toBe(2);
    expect(Number(await levels.getOnHand(flourId, siteId, COMPANY))).toBe(4300); // 4250 + 50
    expect(Number(lines[0]!.actualQty)).toBe(700);
    expect(Number(lines[0]!.variance)).toBe(-100); // 700 − 800

    // Still exactly one record for the session.
    const all = await getDb()
      .select({ id: sessionConsumption.id })
      .from(sessionConsumption)
      .where(and(eq(sessionConsumption.companyId, COMPANY), eq(sessionConsumption.sessionId, SESSION)));
    expect(all).toHaveLength(1);
  });
});

describe('offline replay', () => {
  it('a replay carrying the same client key is a no-op', async () => {
    await setLevel(flourId, 5000);
    const input = { ...baseInput(), clientKey: 'k1', lines: [{ productId: flourId, actualQty: 750 }] };
    await svc.submit(input);
    expect(Number(await levels.getOnHand(flourId, siteId, COMPANY))).toBe(4250);

    // Same client key replayed — must not decrement again or bump version.
    const { record } = await svc.submit(input);
    expect(record.version).toBe(1);
    expect(Number(await levels.getOnHand(flourId, siteId, COMPANY))).toBe(4250);
  });
});

describe('site scope', () => {
  it('a head-baker bound to another site cannot submit; their own site + admin can', async () => {
    await setLevel(flourId, 5000);
    await expect(
      svc.submit({ ...baseInput(), lines: [{ productId: flourId, actualQty: 750 }] }, {
        roles: ['head_baker'],
        siteId: otherSiteId,
      }),
    ).rejects.toThrow('forbidden_site_scope');

    // Own site is fine.
    const ok = await svc.submit({ ...baseInput(), lines: [{ productId: flourId, actualQty: 750 }] }, {
      roles: ['head_baker'],
      siteId,
    });
    expect(ok.record.id).toBeTruthy();
  });
});

describe('filterAwaiting', () => {
  it('returns only sessions at the site with no consumption record', async () => {
    await setLevel(flourId, 5000);
    await svc.submit({ ...baseInput(), lines: [{ productId: flourId, actualQty: 750 }] });
    const awaiting = await svc.filterAwaiting(
      siteId,
      [{ sessionId: SESSION }, { sessionId: 'sess-002' }],
      COMPANY,
    );
    expect(awaiting.map((s) => s.sessionId)).toEqual(['sess-002']);
  });
});

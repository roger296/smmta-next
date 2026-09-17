/**
 * Re-denominating recipe lines, with the real figures from the live catalogue.
 *
 * The density table is the substance here: 400 g of milk is 0.388 l, not 0.4,
 * and 180 g of rapeseed oil is 0.196 l, not 0.18. A script that split the
 * difference and used water would be 8% out on the oil on every bake.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { products, recipeLines, recipes } from '../src/db/schema/index.js';
import { factorFor, fixRecipeUnits, DENSITY_KG_PER_L } from './fix-recipe-units.js';

const COMPANY = 'ffff2222-ffff-4fff-8fff-ffffffff2222';
const PREFIX = 'FIXUNIT';

async function wipe() {
  const db = getDb();
  const ps = await db.select({ id: products.id }).from(products).where(eq(products.companyId, COMPANY));
  const ids = ps.map((p) => p.id);
  if (ids.length > 0) {
    await db.delete(recipeLines).where(inArray(recipeLines.productId, ids));
    await db.delete(products).where(inArray(products.id, ids));
  }
  await db.delete(recipes).where(eq(recipes.companyId, COMPANY));
}

async function seed(stockCode: string, productUom: string, lineUom: string, qty: string) {
  const db = getDb();
  const [p] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: stockCode, stockCode, stockUom: productUom })
    .returning();
  const [r] = await db
    .insert(recipes)
    .values({ companyId: COMPANY, bake: `${PREFIX} Bake`, effectiveFrom: '2026-01-01' })
    .returning();
  await db.insert(recipeLines).values({
    companyId: COMPANY, recipeId: r!.id, productId: p!.id, qtyPerCover: qty, stockUom: lineUom,
  });
  return p!.id;
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await closeDatabase();
});

describe('factorFor', () => {
  it('uses the plain factor where the units convert on their own', () => {
    expect(factorFor('g', 'kg', 'ANY')).toEqual({ factor: 0.001, via: 'x0.001' });
  });

  /**
   * Water is 1 kg/l. Rapeseed oil is 0.92, so `1 g = 1 ml` overstates the
   * volume by 8% — on every bake, forever.
   */
  it('goes through the density table for mass against volume', () => {
    const r = factorFor('g', 'l', 'LONG-LIFE-RAPESEED-OIL');
    expect('factor' in r).toBe(true);
    if ('factor' in r) {
      expect(180 * r.factor).toBeCloseTo(0.1957, 4);
      expect(r.via).toContain('0.92');
      // Explicitly NOT the water answer.
      expect(180 * r.factor).not.toBeCloseTo(0.18, 3);
    }
  });

  it('converts milk with its own density, not the oil s', () => {
    const r = factorFor('g', 'l', 'SEMI-SKIM-MILK');
    if (!('factor' in r)) throw new Error('expected a factor');
    expect(400 * r.factor).toBeCloseTo(0.3883, 4);
  });

  it('refuses a liquid nobody has written a density for', () => {
    const r = factorFor('g', 'l', 'SOME-NEW-SYRUP');
    expect('refusal' in r).toBe(true);
    if ('refusal' in r) expect(r.refusal).toMatch(/DENSITY_KG_PER_L/);
  });

  it('refuses when there is no stock code to look up', () => {
    expect('refusal' in factorFor('g', 'l', null)).toBe(true);
  });

  it('handles kg against ml, not just the pair in front of us', () => {
    const r = factorFor('kg', 'ml', 'SEMI-SKIM-MILK');
    if (!('factor' in r)) throw new Error('expected a factor');
    // 1 kg of milk at 1.03 kg/l is 0.9709 l = 970.9 ml.
    expect(1 * r.factor).toBeCloseTo(970.87, 1);
  });

  it('round-trips a conversion back to where it started', () => {
    const there = factorFor('g', 'l', 'DAIR-SOYA-MILK');
    const back = factorFor('l', 'g', 'DAIR-SOYA-MILK');
    if (!('factor' in there) || !('factor' in back)) throw new Error('expected factors');
    expect(300 * there.factor * back.factor).toBeCloseTo(300, 6);
  });
});

describe('fixRecipeUnits', () => {
  /** Scones, exactly as production had it. */
  it('rewrites 400 g of milk as 0.3883 l and sets the line unit', async () => {
    const id = await seed('SEMI-SKIM-MILK', 'l', 'g', '400');
    const r = await fixRecipeUnits({ companyId: COMPANY, apply: true });
    expect(r.fixed).toHaveLength(1);
    expect(r.fixed[0]).toMatchObject({ before: 400, after: 0.3883, from: 'g', to: 'l' });
    const [line] = await getDb().select().from(recipeLines).where(eq(recipeLines.productId, id));
    expect(Number(line!.qtyPerCover)).toBe(0.3883);
    expect(line!.stockUom).toBe('l');
  });

  it('writes nothing on a dry run', async () => {
    const id = await seed('SEMI-SKIM-MILK', 'l', 'g', '400');
    const r = await fixRecipeUnits({ companyId: COMPANY });
    expect(r.fixed[0]!.after).toBe(0.3883);
    const [line] = await getDb().select().from(recipeLines).where(eq(recipeLines.productId, id));
    expect(Number(line!.qtyPerCover)).toBe(400);
    expect(line!.stockUom).toBe('g');
  });

  it('leaves a line that already agrees completely alone', async () => {
    await seed('SEMI-SKIM-MILK', 'l', 'l', '0.4');
    const r = await fixRecipeUnits({ companyId: COMPANY, apply: true });
    expect(r.fixed).toHaveLength(0);
    expect(r.refused).toHaveLength(0);
  });

  it('reports a liquid with no density instead of converting it', async () => {
    const id = await seed('MYSTERY-SYRUP', 'l', 'g', '500');
    const r = await fixRecipeUnits({ companyId: COMPANY, apply: true });
    expect(r.fixed).toHaveLength(0);
    expect(r.refused).toHaveLength(1);
    const [line] = await getDb().select().from(recipeLines).where(eq(recipeLines.productId, id));
    expect(Number(line!.qtyPerCover)).toBe(500);
    expect(line!.stockUom).toBe('g');
  });

  it('is idempotent - a second run finds nothing to do', async () => {
    const id = await seed('DAIR-SOYA-MILK', 'l', 'g', '300');
    await fixRecipeUnits({ companyId: COMPANY, apply: true });
    const second = await fixRecipeUnits({ companyId: COMPANY, apply: true });
    expect(second.fixed).toHaveLength(0);
    const [line] = await getDb().select().from(recipeLines).where(eq(recipeLines.productId, id));
    expect(Number(line!.qtyPerCover)).toBeCloseTo(0.2913, 4);
  });

  it('keeps every density it needs for the live data', () => {
    for (const code of [
      'LONG-LIFE-RAPESEED-OIL', 'SEMI-SKIM-MILK', 'DAIR-SOYA-MILK',
    ]) {
      expect(DENSITY_KG_PER_L[code]).toBeGreaterThan(0);
    }
  });
});

/**
 * The duplicate-product diagnostic.
 *
 * Its whole value is the verdict — "retire the idle twin" vs "this is a real
 * merge with a unit conversion in it". Getting that backwards would have
 * someone delete the product the recipes actually use.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { products, recipeLines, recipes, stockLevels, stockMovements, sites } from '../src/db/schema/index.js';
import { findDuplicateProducts } from './find-duplicate-products.js';

const COMPANY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PREFIX = 'DUPTEST';

async function wipe() {
  const db = getDb();
  const ps = await db.select({ id: products.id }).from(products).where(eq(products.companyId, COMPANY));
  const ids = ps.map((p) => p.id);
  if (ids.length > 0) {
    await db.delete(recipeLines).where(inArray(recipeLines.productId, ids));
    await db.delete(stockMovements).where(inArray(stockMovements.productId, ids));
    await db.delete(stockLevels).where(inArray(stockLevels.productId, ids));
    await db.delete(products).where(inArray(products.id, ids));
  }
  await db.delete(recipes).where(eq(recipes.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
}

const mkProduct = async (name: string, stockCode: string, stockUom: string) => {
  const [p] = await getDb()
    .insert(products)
    .values({ companyId: COMPANY, name, stockCode, stockUom })
    .returning();
  return p!.id;
};

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await closeDatabase();
});

describe('findDuplicateProducts', () => {
  it('says nothing when every name is unique', async () => {
    await mkProduct('Caster Sugar', `${PREFIX}-A`, 'kg');
    await mkProduct('Icing Sugar', `${PREFIX}-B`, 'kg');
    expect(await findDuplicateProducts(COMPANY)).toEqual([]);
  });

  it('matches names case- and whitespace-insensitively', async () => {
    await mkProduct('Caster Sugar', `${PREFIX}-A`, 'kg');
    await mkProduct('  caster sugar ', `${PREFIX}-B`, 'g');
    const g = await findDuplicateProducts(COMPANY);
    expect(g).toHaveLength(1);
    expect(g[0]!.twins).toHaveLength(2);
  });

  it('calls a pair with no data anywhere unused', async () => {
    await mkProduct('Caster Sugar', `${PREFIX}-A`, 'kg');
    await mkProduct('Caster Sugar', `${PREFIX}-B`, 'g');
    const [g] = await findDuplicateProducts(COMPANY);
    expect(g!.verdict).toBe('unused');
  });

  /**
   * The common case and the useful one: the count-list twin was created but
   * nothing ever touched it, while the recipe twin is wired into a recipe.
   */
  it('calls it one-sided when only one twin carries data, and says which', async () => {
    const db = getDb();
    const used = await mkProduct('Caster Sugar', `${PREFIX}-USED`, 'g');
    await mkProduct('Caster Sugar', `${PREFIX}-IDLE`, 'kg');
    const [r] = await db
      .insert(recipes)
      .values({ companyId: COMPANY, bake: 'Test Bake', effectiveFrom: '2026-01-01' })
      .returning();
    await db.insert(recipeLines).values({
      companyId: COMPANY, recipeId: r!.id, productId: used, qtyPerCover: '10', stockUom: 'g',
    });

    const [g] = await findDuplicateProducts(COMPANY);
    expect(g!.verdict).toBe('one-sided');
    const usedTwin = g!.twins.find((t) => t.stockCode === `${PREFIX}-USED`)!;
    const idleTwin = g!.twins.find((t) => t.stockCode === `${PREFIX}-IDLE`)!;
    expect(usedTwin.recipeLines).toBe(1);
    expect(idleTwin.recipeLines).toBe(0);
    expect(idleTwin.stockMovements).toBe(0);
    expect(idleTwin.onHand).toBe(0);
  });

  /**
   * The dangerous case: recipes consume one twin while stock lands on the
   * other. Whoever merges these has to convert g to kg, so it must never be
   * reported as a safe retire.
   */
  it('calls it both-used when recipes point at one twin and stock at the other', async () => {
    const db = getDb();
    const recipeSide = await mkProduct('Caster Sugar', `${PREFIX}-RECIPE`, 'g');
    const stockSide = await mkProduct('Caster Sugar', `${PREFIX}-STOCK`, 'kg');
    const [r] = await db
      .insert(recipes)
      .values({ companyId: COMPANY, bake: 'Test Bake', effectiveFrom: '2026-01-01' })
      .returning();
    await db.insert(recipeLines).values({
      companyId: COMPANY, recipeId: r!.id, productId: recipeSide, qtyPerCover: '10', stockUom: 'g',
    });
    const [site] = await db
      .insert(sites)
      .values({ companyId: COMPANY, name: 'Dup Test Site', canonicalName: 'Dup Test Site', slug: `${PREFIX}-site` })
      .returning();
    await db.insert(stockLevels).values({
      companyId: COMPANY, productId: stockSide, siteId: site!.id, onHand: '25',
    });

    const [g] = await findDuplicateProducts(COMPANY);
    expect(g!.verdict).toBe('both-used');
    expect(g!.twins.find((t) => t.stockCode === `${PREFIX}-RECIPE`)!.recipeLines).toBe(1);
    expect(g!.twins.find((t) => t.stockCode === `${PREFIX}-STOCK`)!.onHand).toBe(25);
  });

  it('reports the uom of each twin, which is the thing that differs live', async () => {
    await mkProduct('Caster Sugar', `${PREFIX}-A`, 'g');
    await mkProduct('Caster Sugar', `${PREFIX}-B`, 'kg');
    const [g] = await findDuplicateProducts(COMPANY);
    expect(g!.twins.map((t) => t.stockUom).sort()).toEqual(['g', 'kg']);
  });
});

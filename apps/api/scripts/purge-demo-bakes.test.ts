/**
 * Retiring the demo cakes (Aug-2026 feedback set, F-4).
 *
 * "Displayed recipes are not part of our offering of course."
 *
 * The purge has one job it must never get wrong: a demo NAME on a product does
 * not make the ledger behind it demo data. If a venue has already counted an
 * ingredient or baked with it, those rows are somebody's real work, and
 * deleting them to tidy up a seed would be far worse than an untidy product
 * list. So an in-use ingredient is reported and kept.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { products, recipeLines, recipes, sites, stockMovements } from '../src/db/schema/index.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';
import { RecipeService } from '../src/modules/recipes/recipe.service.js';
import { DEMO_BAKES, DEMO_INGREDIENT_SLUGS } from './demo/seed-bakes.demo.js';
import { inUseReason, purgeDemoBakes } from './purge-demo-bakes.js';

const COMPANY = getSingletonCompanyId();
const DEMO_BAKE = DEMO_BAKES[0]!;
const FLOUR = 'sr-flour';
const SUGAR = 'caster-sugar';

const recipeSvc = new RecipeService();

async function clear(): Promise<void> {
  const db = getDb();
  const demo = await db
    .select({ id: recipes.id })
    .from(recipes)
    .where(and(eq(recipes.companyId, COMPANY), inArray(recipes.bake, DEMO_BAKES)));
  if (demo.length > 0) {
    await db.delete(recipeLines).where(inArray(recipeLines.recipeId, demo.map((r) => r.id)));
    await db.delete(recipes).where(inArray(recipes.id, demo.map((r) => r.id)));
  }
  const demoProducts = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.companyId, COMPANY), inArray(products.slug, DEMO_INGREDIENT_SLUGS)));
  if (demoProducts.length > 0) {
    const ids = demoProducts.map((p) => p.id);
    await db.delete(stockMovements).where(inArray(stockMovements.productId, ids));
    await db.delete(recipeLines).where(inArray(recipeLines.productId, ids));
    await db.delete(products).where(inArray(products.id, ids));
  }
}

async function makeIngredient(slug: string): Promise<string> {
  const db = getDb();
  const [row] = await db
    .insert(products)
    .values({
      companyId: COMPANY,
      slug,
      stockCode: slug.toUpperCase(),
      name: `Demo ${slug}`,
      stockUom: 'g',
      itemKind: 'INGREDIENT',
      isSold: false,
      isStocked: true,
    })
    .returning();
  return row!.id;
}

beforeEach(clear);
afterAll(async () => {
  await clear();
  await closeDatabase();
});

describe('purgeDemoBakes', () => {
  it('removes a demo recipe and the ingredients nothing points at', async () => {
    const flourId = await makeIngredient(FLOUR);
    await recipeSvc.create({
      bake: DEMO_BAKE,
      siteId: null,
      effectiveFrom: '2026-01-01',
      lines: [{ productId: flourId, qtyPerCover: 200 }],
      companyId: COMPANY,
    });

    const report = await purgeDemoBakes();

    expect(report.recipesRemoved).toBe(1);
    expect(report.ingredientsRemoved).toContain(FLOUR);
    expect(report.ingredientsKept).toEqual([]);
    expect(await recipeSvc.list({ bake: DEMO_BAKE, companyId: COMPANY })).toEqual([]);
  });

  it('KEEPS an ingredient with stock movements — that ledger is somebody\'s real count', async () => {
    const db = getDb();
    const flourId = await makeIngredient(FLOUR);
    const site = await db.query.sites.findFirst({ columns: { id: true } });
    if (!site) throw new Error('No site in the test database — run seed-sites first.');

    await db.insert(stockMovements).values({
      companyId: COMPANY,
      productId: flourId,
      siteId: site.id,
      qtyDelta: '1000.000',
      movementType: 'GRN',
      sourceSystem: 'test',
      sourceKey: 'purge-demo-bakes-test',
      contentHash: 'purge-demo-bakes-test-hash',
    });

    expect(await inUseReason(flourId)).toBe('has stock movements');

    const report = await purgeDemoBakes();
    expect(report.ingredientsRemoved).not.toContain(FLOUR);
    expect(report.ingredientsKept).toContainEqual({ slug: FLOUR, reason: 'has stock movements' });

    // Still there, untouched.
    const still = await db.query.products.findFirst({
      where: and(eq(products.companyId, COMPANY), eq(products.slug, FLOUR)),
    });
    expect(still).toBeTruthy();
  });

  it('KEEPS an ingredient the real menu has adopted', async () => {
    const sugarId = await makeIngredient(SUGAR);
    const real = await recipeSvc.create({
      bake: 'ZZ Test Real Menu Cake',
      siteId: null,
      effectiveFrom: '2026-01-01',
      lines: [{ productId: sugarId, qtyPerCover: 100 }],
      companyId: COMPANY,
    });

    try {
      expect(await inUseReason(sugarId)).toBe('used by recipe "ZZ Test Real Menu Cake"');
      const report = await purgeDemoBakes();
      expect(report.ingredientsRemoved).not.toContain(SUGAR);
      expect(report.ingredientsKept.map((k) => k.slug)).toContain(SUGAR);
    } finally {
      const db = getDb();
      await db.delete(recipeLines).where(eq(recipeLines.recipeId, real.recipe.id));
      await db.delete(recipes).where(eq(recipes.id, real.recipe.id));
    }
  });

  it('--dry-run reports without deleting', async () => {
    const flourId = await makeIngredient(FLOUR);
    await recipeSvc.create({
      bake: DEMO_BAKE,
      siteId: null,
      effectiveFrom: '2026-01-01',
      lines: [{ productId: flourId, qtyPerCover: 200 }],
      companyId: COMPANY,
    });

    const report = await purgeDemoBakes(true);
    expect(report.dryRun).toBe(true);
    expect(report.recipesRemoved).toBe(1);
    expect(report.ingredientsRemoved).toContain(FLOUR);

    // …but nothing actually went.
    expect(await recipeSvc.list({ bake: DEMO_BAKE, companyId: COMPANY })).toHaveLength(1);
    const db = getDb();
    const still = await db.query.products.findFirst({
      where: and(eq(products.companyId, COMPANY), eq(products.slug, FLOUR)),
    });
    expect(still).toBeTruthy();
  });
});

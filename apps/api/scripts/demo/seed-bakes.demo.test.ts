/**
 * The demo seed must refuse anywhere it could be mistaken for the real menu
 * (Aug-2026 feedback set, F-4).
 *
 * "Displayed recipes are not part of our offering of course." Four invented
 * cakes reached a live venue test because nothing stopped a demo seed running
 * against a database people were treating as real.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../src/config/database.js';
import { products, recipeLines, recipes } from '../../src/db/schema/index.js';
import { getSingletonCompanyId } from '../../src/shared/auth/company.js';
import { RecipeService } from '../../src/modules/recipes/recipe.service.js';
import { DEMO_BAKES, refusalReason } from './seed-bakes.demo.js';

const COMPANY = getSingletonCompanyId();
const REAL_BAKE = 'ZZ Test Real Menu Cake';
const recipeSvc = new RecipeService();

async function clearReal(): Promise<void> {
  const db = getDb();
  const mine = await db
    .select({ id: recipes.id })
    .from(recipes)
    .where(and(eq(recipes.companyId, COMPANY), eq(recipes.bake, REAL_BAKE)));
  if (mine.length > 0) {
    await db.delete(recipeLines).where(inArray(recipeLines.recipeId, mine.map((r) => r.id)));
    await db.delete(recipes).where(inArray(recipes.id, mine.map((r) => r.id)));
  }
  await db.delete(products).where(and(eq(products.companyId, COMPANY), eq(products.slug, 'zz-test-real-sugar')));
}

afterEach(async () => {
  delete process.env.NODE_ENV;
  await clearReal();
});
afterAll(async () => {
  await clearReal();
  await closeDatabase();
});

describe('refusalReason', () => {
  it('refuses outright in production — the real menu is imported, never seeded', async () => {
    process.env.NODE_ENV = 'production';
    const reason = await refusalReason();
    expect(reason).toMatch(/NODE_ENV=production/);
    expect(reason).toMatch(/imported/);
  });

  it('refuses once the database holds a real recipe', async () => {
    const db = getDb();
    const [sugar] = await db
      .insert(products)
      .values({
        companyId: COMPANY,
        slug: 'zz-test-real-sugar',
        stockCode: 'ZZ-TEST-REAL-SUGAR',
        name: 'ZZ Test Real Sugar',
        stockUom: 'g',
        itemKind: 'INGREDIENT',
        isSold: false,
        isStocked: true,
      })
      .returning();
    await recipeSvc.create({
      bake: REAL_BAKE,
      siteId: null,
      effectiveFrom: '2026-01-01',
      lines: [{ productId: sugar!.id, qtyPerCover: 100 }],
      companyId: COMPANY,
    });

    const reason = await refusalReason();
    expect(reason).toContain(REAL_BAKE);
    expect(reason).toMatch(/non-demo recipe/);
  });

  it('names the four invented cakes so the purge and the guard cannot drift apart', () => {
    expect(DEMO_BAKES).toContain('Battenburg');
    expect(DEMO_BAKES.length).toBeGreaterThanOrEqual(4);
  });
});

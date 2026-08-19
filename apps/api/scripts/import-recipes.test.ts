/**
 * The recipe importer against real Postgres (Aug-2026 feedback set, F-4/F-5).
 *
 * "Displayed recipes are not part of our offering of course." The menu is now
 * imported from head office's spreadsheets. These pin the three properties an
 * operator has to be able to rely on: a clean file lands the whole menu, a
 * re-import supersedes rather than stacks, and `--dry-run` writes nothing.
 *
 * Everything is namespaced `ZZ Test Fixture Cake` / `zz-test-*` — the importer
 * writes under the singleton company, so a fixture that looked like a cake
 * would be indistinguishable from the menu in a product list.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { and, eq, inArray, like } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { products, recipeLines, recipes } from '../src/db/schema/index.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';
import { RecipeService } from '../src/modules/recipes/recipe.service.js';
import { ExpectedConsumptionService } from '../src/modules/recipes/expected-consumption.service.js';
import { parseArgs, runImport } from './import-recipes.js';

const COMPANY = getSingletonCompanyId();
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/recipes');
const INGREDIENTS_CSV = join(FIXTURES, 'ingredients.csv');
const RECIPES_CSV = join(FIXTURES, 'recipes.csv');
const BAKE = 'ZZ Test Fixture Cake';

const recipeSvc = new RecipeService();
const expected = new ExpectedConsumptionService();

async function clearFixture(): Promise<void> {
  const db = getDb();
  const mine = await db
    .select({ id: recipes.id })
    .from(recipes)
    .where(and(eq(recipes.companyId, COMPANY), eq(recipes.bake, BAKE)));
  if (mine.length > 0) {
    await db.delete(recipeLines).where(inArray(recipeLines.recipeId, mine.map((r) => r.id)));
    await db.delete(recipes).where(inArray(recipes.id, mine.map((r) => r.id)));
  }
  await db.delete(products).where(and(eq(products.companyId, COMPANY), like(products.slug, 'zz-test-%')));
}

beforeEach(clearFixture);
afterAll(async () => {
  await clearFixture();
  await closeDatabase();
});

async function fixtureSiteId(): Promise<string> {
  const db = getDb();
  const site = await db.query.sites.findFirst({ columns: { id: true } });
  if (!site) throw new Error('No site in the test database — run seed-sites first.');
  return site.id;
}

describe('parseArgs', () => {
  it('reads the two paths and the dry-run flag', () => {
    expect(parseArgs(['--ingredients', 'a.csv', '--recipes', 'b.csv', '--dry-run'])).toEqual({
      ingredientsPath: 'a.csv',
      recipesPath: 'b.csv',
      dryRun: true,
    });
  });
});

describe('runImport', () => {
  it('imports the whole menu from a clean pair of files', async () => {
    const result = await runImport({
      ingredientsPath: INGREDIENTS_CSV,
      recipesPath: RECIPES_CSV,
      dryRun: false,
    });

    expect(result.problems).toEqual([]);
    expect(result.ingredientsUpserted).toBe(7);
    expect(result.recipesWritten).toBe(1);

    const written = await recipeSvc.list({ bake: BAKE, companyId: COMPANY });
    expect(written).toHaveLength(1);

    // F-5: the variants actually landed. An all-BASE import is exactly what
    // made "selecting Vegan or GF failed to generate required ingredients".
    const full = await recipeSvc.get(written[0]!.id, COMPANY);
    const variants = new Set(full!.lines.map((l) => l.variant));
    expect(variants).toEqual(new Set(['BASE', 'GF_REMOVE', 'GF_ADD', 'VEGAN_REMOVE', 'VEGAN_ADD']));

    // Purchase-side columns (locked decision 3) survive the round trip.
    const db = getDb();
    const flour = await db.query.products.findFirst({
      where: and(eq(products.companyId, COMPANY), eq(products.slug, 'zz-test-flour')),
    });
    expect(flour!.stockUom).toBe('g');
    expect(flour!.purchaseUom).toBe('sack');
    expect(Number(flour!.purchaseToStockFactor)).toBe(16000);
    expect(flour!.packDescription).toBe('16 kg sack');
    // Locked decision 4: numeric(18,6) — a gram of flour is a fraction of 1p.
    expect(Number(flour!.expectedNextCost)).toBeCloseTo(11.4, 6);
    // Blank count_quantum is NULL, never 0 (D-2).
    expect(flour!.countQuantum).toBeNull();

    const egg = await db.query.products.findFirst({
      where: and(eq(products.companyId, COMPANY), eq(products.slug, 'zz-test-egg')),
    });
    expect(Number(egg!.countQuantum)).toBe(30);
  });

  it('is idempotent — a re-import supersedes in place rather than stacking', async () => {
    const args = { ingredientsPath: INGREDIENTS_CSV, recipesPath: RECIPES_CSV, dryRun: false };
    await runImport(args);
    const second = await runImport(args);

    expect(second.problems).toEqual([]);
    expect(second.recipesWritten).toBe(0);
    expect(second.recipesSuperseded).toBe(1);
    expect(await recipeSvc.list({ bake: BAKE, companyId: COMPANY })).toHaveLength(1);
  });

  it('--dry-run writes nothing at all', async () => {
    const result = await runImport({
      ingredientsPath: INGREDIENTS_CSV,
      recipesPath: RECIPES_CSV,
      dryRun: true,
    });

    expect(result.problems).toEqual([]);
    expect(result.dryRun).toBe(true);
    expect(await recipeSvc.list({ bake: BAKE, companyId: COMPANY })).toEqual([]);

    const db = getDb();
    const leaked = await db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.companyId, COMPANY), like(products.slug, 'zz-test-%')));
    expect(leaked).toEqual([]);
  });

  it('refuses the WHOLE import when any row is bad — a half menu is worse than none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recipe-import-'));
    const bad = join(dir, 'recipes.csv');
    writeFileSync(
      bad,
      [
        'bake,effective_from,site_slug,variant,ingredient_slug,qty_per_table,unit_cost',
        `${BAKE},2026-01-01,,BASE,zz-test-flour,400,`,
        // Removes something the BASE recipe never had — silently no-ops.
        `${BAKE},2026-01-01,,GF_REMOVE,zz-test-butter,,`,
      ].join('\n'),
    );

    const result = await runImport({
      ingredientsPath: INGREDIENTS_CSV,
      recipesPath: bad,
      dryRun: false,
    });

    expect(result.problems.map((p) => p.rule)).toContain('remove-not-in-base');
    expect(result.recipesWritten).toBe(0);
    expect(result.ingredientsUpserted).toBe(0);
    // Not even the ingredients, which validated fine.
    const db = getDb();
    const leaked = await db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.companyId, COMPANY), like(products.slug, 'zz-test-%')));
    expect(leaked).toEqual([]);
  });

  it('F-5: the imported variants produce different ingredients for a GF table', async () => {
    await runImport({ ingredientsPath: INGREDIENTS_CSV, recipesPath: RECIPES_CSV, dryRun: false });
    const siteId = await fixtureSiteId();

    const plain = await expected.expectedForSession({
      bake: BAKE, siteId, onDate: '2026-06-01', covers: 10, companyId: COMPANY,
    });
    const withGf = await expected.expectedForSession({
      bake: BAKE, siteId, onDate: '2026-06-01', covers: 10, glutenFreeTables: 2, companyId: COMPANY,
    });

    const qty = (rows: typeof plain, slugName: string) =>
      rows.find((r) => r.productName === slugName)?.expectedQty ?? 0;

    // 10 tables of flour, less the 2 gluten-free ones.
    expect(qty(plain, 'ZZ Test Plain Flour')).toBe(4000);
    expect(qty(withGf, 'ZZ Test Plain Flour')).toBe(3200);
    // …and the substitute appears, which is what the tester never saw.
    expect(qty(plain, 'ZZ Test Gluten-Free Flour Blend')).toBe(0);
    expect(qty(withGf, 'ZZ Test Gluten-Free Flour Blend')).toBe(840);
  });

  it('F-6: names the blocker instead of returning an empty list', async () => {
    const siteId = await fixtureSiteId();
    const missing = await expected.expectedForSessionWithCoverage({
      bake: 'ZZ Cake That Does Not Exist', siteId, onDate: '2026-06-01', covers: 4, companyId: COMPANY,
    });
    expect(missing.lines).toEqual([]);
    expect(missing.blockers.map((b) => b.kind)).toEqual(['NO_RECIPE']);
    expect(missing.blockers[0]!.message).toContain('ZZ Cake That Does Not Exist');
    expect(missing.blockers[0]!.message).toContain('2026-06-01');
  });

  it('F-5: booking a vegan table against a cake with no vegan recipe is a blocker', async () => {
    // Import BASE + GF only — no vegan lines.
    const dir = mkdtempSync(join(tmpdir(), 'recipe-import-'));
    const onlyGf = join(dir, 'recipes.csv');
    writeFileSync(
      onlyGf,
      [
        'bake,effective_from,site_slug,variant,ingredient_slug,qty_per_table,unit_cost',
        `${BAKE},2026-01-01,,BASE,zz-test-flour,400,`,
        `${BAKE},2026-01-01,,GF_REMOVE,zz-test-flour,,`,
        `${BAKE},2026-01-01,,GF_ADD,zz-test-gf-flour,420,`,
      ].join('\n'),
    );
    await runImport({ ingredientsPath: INGREDIENTS_CSV, recipesPath: onlyGf, dryRun: false });

    const siteId = await fixtureSiteId();
    const coverage = await expected.dietaryCoverage({
      bake: BAKE, siteId, onDate: '2026-06-01', companyId: COMPANY,
    });
    expect(coverage).toEqual({ hasRecipe: true, glutenFree: true, vegan: false });

    const result = await expected.expectedForSessionWithCoverage({
      bake: BAKE, siteId, onDate: '2026-06-01', covers: 6, veganTables: 1, companyId: COMPANY,
    });
    expect(result.blockers.map((b) => b.kind)).toEqual(['NO_VEGAN_VARIANT']);
    expect(result.blockers[0]!.message).toMatch(/no vegan recipe/i);
  });
});

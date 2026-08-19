/**
 * DEMO cake menu + recipes — **not the Big Bakes offering** (Aug-2026, F-4).
 *
 *   DATABASE_URL=... npx tsx apps/api/scripts/demo/seed-bakes.demo.ts
 *
 * "Displayed recipes are not part of our offering of course."
 *
 * These four cakes (Victoria Sponge, Coffee & Walnut Delight, Battenburg,
 * Burger Cake) were invented to have *something* on screen during the build.
 * They reached a live venue test, where a baker was asked to record a bake of
 * a cake Big Bakes does not sell. Worse, every line here is `BASE`, so the
 * GF / vegan variant machinery had nothing to act on and selecting either
 * silently produced the standard ingredient list (F-5).
 *
 * **The real menu is imported, not seeded** —
 * `npx tsx apps/api/scripts/import-recipes.ts` and `docs/RECIPE_IMPORT.md`.
 * This file survives only for local development and demos, and it now refuses
 * to run anywhere it could be mistaken for real data:
 *
 *   - never with `NODE_ENV=production`;
 *   - never against a database that already holds non-demo recipes.
 *
 * `scripts/purge-demo-bakes.ts` removes what it created.
 */
import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../src/config/database.js';
import { products } from '../../src/db/schema/index.js';
import { getSingletonCompanyId } from '../../src/shared/auth/company.js';
import { RecipeService } from '../../src/modules/recipes/recipe.service.js';

const COMPANY = getSingletonCompanyId();

// Shared ingredients: slug → { name, stock uom, £ cost per stock unit }.
const INGREDIENTS: Record<string, { name: string; uom: string; cost: number }> = {
  'sr-flour': { name: 'Self-raising flour', uom: 'g', cost: 0.0012 },
  'caster-sugar': { name: 'Caster sugar', uom: 'g', cost: 0.001 },
  'butter': { name: 'Butter', uom: 'g', cost: 0.007 },
  'eggs': { name: 'Eggs', uom: 'each', cost: 0.2 },
  'vanilla-extract': { name: 'Vanilla extract', uom: 'ml', cost: 0.1 },
  'baking-powder': { name: 'Baking powder', uom: 'g', cost: 0.01 },
  'raspberry-jam': { name: 'Raspberry jam', uom: 'g', cost: 0.004 },
  'walnuts': { name: 'Walnuts', uom: 'g', cost: 0.015 },
  'instant-coffee': { name: 'Instant coffee', uom: 'g', cost: 0.03 },
  'icing-sugar': { name: 'Icing sugar', uom: 'g', cost: 0.0012 },
  'ground-almonds': { name: 'Ground almonds', uom: 'g', cost: 0.012 },
  'almond-extract': { name: 'Almond extract', uom: 'ml', cost: 0.12 },
  'apricot-jam': { name: 'Apricot jam', uom: 'g', cost: 0.004 },
  'marzipan': { name: 'Marzipan', uom: 'g', cost: 0.008 },
  'pink-colouring': { name: 'Pink food colouring', uom: 'ml', cost: 0.2 },
  'cocoa-powder': { name: 'Cocoa powder', uom: 'g', cost: 0.006 },
  'fondant-icing': { name: 'Fondant icing', uom: 'g', cost: 0.005 },
  'food-colouring': { name: 'Food colouring', uom: 'ml', cost: 0.2 },
  'sesame-seeds': { name: 'Sesame seeds', uom: 'g', cost: 0.01 },
};

// Per-cover (per cake) quantities, in the ingredient's stock unit.
const RECIPES: Record<string, Array<[slug: string, qty: number]>> = {
  'Victoria Sponge': [
    ['sr-flour', 200], ['caster-sugar', 200], ['butter', 200], ['eggs', 4],
    ['vanilla-extract', 5], ['baking-powder', 5], ['raspberry-jam', 60],
  ],
  'Coffee & Walnut Delight': [
    ['sr-flour', 175], ['butter', 175], ['caster-sugar', 175], ['eggs', 3],
    ['walnuts', 100], ['instant-coffee', 10], ['baking-powder', 5], ['icing-sugar', 150],
  ],
  'Battenburg': [
    ['sr-flour', 140], ['butter', 175], ['caster-sugar', 175], ['eggs', 3],
    ['ground-almonds', 50], ['almond-extract', 3], ['apricot-jam', 60],
    ['marzipan', 250], ['pink-colouring', 2],
  ],
  'Burger Cake': [
    ['sr-flour', 250], ['butter', 250], ['caster-sugar', 250], ['eggs', 4],
    ['cocoa-powder', 40], ['fondant-icing', 200], ['icing-sugar', 200],
    ['food-colouring', 5], ['sesame-seeds', 10],
  ],
};

async function findOrCreateIngredient(slug: string): Promise<string> {
  const db = getDb();
  const existing = await db.query.products.findFirst({
    where: and(eq(products.companyId, COMPANY), eq(products.slug, slug)),
    columns: { id: true },
  });
  if (existing) return existing.id;
  const def = INGREDIENTS[slug]!;
  const [row] = await db
    .insert(products)
    .values({
      companyId: COMPANY,
      name: def.name,
      slug,
      stockCode: slug.toUpperCase(),
      itemKind: 'INGREDIENT',
      isSold: false,
      stockUom: def.uom,
      expectedNextCost: String(def.cost),
    })
    .returning();
  return row!.id;
}

/** The four invented cakes, so the purge and the guard both know them. */
export const DEMO_BAKES = Object.keys(RECIPES);

/** The ingredient slugs this seed introduces. */
export const DEMO_INGREDIENT_SLUGS = Object.keys(INGREDIENTS);

/**
 * Refuse to run where the data could be mistaken for the real menu.
 *
 * Returns a reason to refuse, or null to proceed.
 */
export async function refusalReason(): Promise<string | null> {
  if (process.env.NODE_ENV === 'production') {
    return 'NODE_ENV=production. The real menu is imported (see docs/RECIPE_IMPORT.md), never seeded.';
  }
  const existing = await new RecipeService().list({ companyId: COMPANY });
  const real = existing.filter((r) => !DEMO_BAKES.includes(r.bake));
  if (real.length > 0) {
    const names = [...new Set(real.map((r) => r.bake))].slice(0, 5).join(', ');
    return `this database already holds ${real.length} non-demo recipe(s) (${names}). Adding invented cakes beside a real menu is how the 12 Aug test ended up asking a baker to bake a Burger Cake.`;
  }
  return null;
}

async function main(): Promise<void> {
  const refusal = await refusalReason();
  if (refusal) {
    console.error(`[seed-bakes.demo] REFUSED — ${refusal}`);
    process.exitCode = 1;
    return;
  }
  console.warn(
    '[seed-bakes.demo] Seeding DEMO cakes. These are not the Big Bakes menu; ' +
      'import the real one with scripts/import-recipes.ts.',
  );
  const recipes = new RecipeService();
  const ids = new Map<string, string>();
  for (const slug of Object.keys(INGREDIENTS)) ids.set(slug, await findOrCreateIngredient(slug));
  console.log(`[seed-bakes.demo] ${ids.size} ingredient products ready`);

  for (const [bake, lines] of Object.entries(RECIPES)) {
    const already = await recipes.list({ bake, companyId: COMPANY });
    if (already.length) {
      console.log(`[seed-bakes.demo] ${bake} — recipe already exists, skipped`);
      continue;
    }
    await recipes.create({
      bake,
      effectiveFrom: '2026-01-01',
      lines: lines.map(([slug, qty]) => ({ productId: ids.get(slug)!, qtyPerCover: qty })),
      companyId: COMPANY,
    });
    console.log(`[seed-bakes.demo] ${bake} — recipe created (${lines.length} ingredients)`);
  }
}

const isCliEntry = process.argv[1]?.endsWith('seed-bakes.demo.ts') ?? false;
if (isCliEntry) {
  main()
    .then(() => console.log('[seed-bakes.demo] done'))
    .catch((err) => {
      console.error('[seed-bakes.demo] FAILED:', err);
      process.exitCode = 1;
    })
    .finally(() => void closeDatabase());
}

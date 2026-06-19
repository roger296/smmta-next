/**
 * Seed the Big Bakes cake menu + recipes (demo data).
 *
 *   DATABASE_URL=... npx tsx apps/api/scripts/seed-bakes.ts
 *
 * Creates the shared ingredient products and a global recipe for each cake
 * (Burger Cake, Victoria Sponge, Coffee & Walnut Delight, Battenburg). A recipe
 * is keyed by the CAKE, not the experience package — quantities are per cover
 * (per guest, who bakes one cake). Idempotent: re-running tops up nothing it
 * already created. Ingredient lists from standard British recipes.
 */
import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { products } from '../src/db/schema/index.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';
import { RecipeService } from '../src/modules/recipes/recipe.service.js';

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

async function main(): Promise<void> {
  const recipes = new RecipeService();
  const ids = new Map<string, string>();
  for (const slug of Object.keys(INGREDIENTS)) ids.set(slug, await findOrCreateIngredient(slug));
  console.log(`[seed-bakes] ${ids.size} ingredient products ready`);

  for (const [bake, lines] of Object.entries(RECIPES)) {
    const already = await recipes.list({ bake, companyId: COMPANY });
    if (already.length) {
      console.log(`[seed-bakes] ${bake} — recipe already exists, skipped`);
      continue;
    }
    await recipes.create({
      bake,
      effectiveFrom: '2026-01-01',
      lines: lines.map(([slug, qty]) => ({ productId: ids.get(slug)!, qtyPerCover: qty })),
      companyId: COMPANY,
    });
    console.log(`[seed-bakes] ${bake} — recipe created (${lines.length} ingredients)`);
  }
}

const isCliEntry = process.argv[1]?.endsWith('seed-bakes.ts') ?? false;
if (isCliEntry) {
  main()
    .then(() => console.log('[seed-bakes] done'))
    .catch((err) => {
      console.error('[seed-bakes] FAILED:', err);
      process.exitCode = 1;
    })
    .finally(() => void closeDatabase());
}

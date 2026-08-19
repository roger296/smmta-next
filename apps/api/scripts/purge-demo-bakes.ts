/**
 * Remove the demo cakes (Aug-2026 feedback set, F-4).
 *
 *   DATABASE_URL=... npx tsx apps/api/scripts/purge-demo-bakes.ts [--dry-run]
 *
 * "Displayed recipes are not part of our offering of course." This deletes the
 * four invented cakes and the ingredient products they introduced — but **only
 * where nothing real depends on them**.
 *
 * An ingredient with stock movements or consumption history is REPORTED, never
 * deleted. Those rows are somebody's actual count or actual bake; a demo name
 * on a product does not make the ledger behind it demo data, and destroying it
 * to tidy up a seed would be a far worse outcome than an untidy product list.
 */
import 'dotenv/config';
import { and, eq, inArray } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import {
  products,
  recipeLines,
  recipes as recipesTable,
  sessionConsumptionLines,
  stockLevels,
  stockMovements,
} from '../src/db/schema/index.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';
import { DEMO_BAKES, DEMO_INGREDIENT_SLUGS } from './demo/seed-bakes.demo.js';

const COMPANY = getSingletonCompanyId();

export interface PurgeReport {
  recipesRemoved: number;
  ingredientsRemoved: string[];
  /** Kept because something real points at them, with the reason. */
  ingredientsKept: Array<{ slug: string; reason: string }>;
  dryRun: boolean;
}

/** Why this product cannot be deleted, or null if it can. */
export async function inUseReason(productId: string): Promise<string | null> {
  const db = getDb();

  const movements = await db
    .select({ id: stockMovements.id })
    .from(stockMovements)
    .where(eq(stockMovements.productId, productId))
    .limit(1);
  if (movements.length > 0) return 'has stock movements';

  const consumption = await db
    .select({ id: sessionConsumptionLines.id })
    .from(sessionConsumptionLines)
    .where(eq(sessionConsumptionLines.productId, productId))
    .limit(1);
  if (consumption.length > 0) return 'has consumption history';

  const levels = await db
    .select({ id: stockLevels.id })
    .from(stockLevels)
    .where(eq(stockLevels.productId, productId))
    .limit(1);
  if (levels.length > 0) return 'has a stock level at a site';

  // A line in a recipe that is NOT one of the demo cakes — i.e. the real menu
  // has adopted this ingredient.
  const otherRecipeUse = await db
    .select({ id: recipeLines.id, bake: recipesTable.bake })
    .from(recipeLines)
    .innerJoin(recipesTable, eq(recipesTable.id, recipeLines.recipeId))
    .where(eq(recipeLines.productId, productId));
  const realUse = otherRecipeUse.filter((r) => !DEMO_BAKES.includes(r.bake));
  if (realUse.length > 0) return `used by recipe "${realUse[0]!.bake}"`;

  return null;
}

export async function purgeDemoBakes(dryRun = false): Promise<PurgeReport> {
  const db = getDb();
  const report: PurgeReport = {
    recipesRemoved: 0,
    ingredientsRemoved: [],
    ingredientsKept: [],
    dryRun,
  };

  const demoRecipes = await db
    .select({ id: recipesTable.id })
    .from(recipesTable)
    .where(and(eq(recipesTable.companyId, COMPANY), inArray(recipesTable.bake, DEMO_BAKES)));

  if (!dryRun) {
    for (const recipe of demoRecipes) {
      await db.delete(recipeLines).where(eq(recipeLines.recipeId, recipe.id));
      await db.delete(recipesTable).where(eq(recipesTable.id, recipe.id));
    }
  }
  report.recipesRemoved = demoRecipes.length;

  const demoProducts = await db
    .select({ id: products.id, slug: products.slug })
    .from(products)
    .where(and(eq(products.companyId, COMPANY), inArray(products.slug, DEMO_INGREDIENT_SLUGS)));

  for (const product of demoProducts) {
    // `products.slug` is nullable in the schema; a demo row always has one,
    // but fall back to the id rather than printing "null" in the report.
    const label = product.slug ?? product.id;
    const reason = await inUseReason(product.id);
    if (reason) {
      report.ingredientsKept.push({ slug: label, reason });
      continue;
    }
    if (!dryRun) {
      await db.delete(products).where(eq(products.id, product.id));
    }
    report.ingredientsRemoved.push(label);
  }

  return report;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const report = await purgeDemoBakes(dryRun);

  const verb = dryRun ? 'would remove' : 'removed';
  console.log(`[purge-demo-bakes] ${verb} ${report.recipesRemoved} demo recipe(s).`);
  console.log(
    `[purge-demo-bakes] ${verb} ${report.ingredientsRemoved.length} ingredient(s): ` +
      (report.ingredientsRemoved.join(', ') || '(none)'),
  );

  if (report.ingredientsKept.length > 0) {
    console.log(
      `\n[purge-demo-bakes] KEPT ${report.ingredientsKept.length} — something real points at them:`,
    );
    for (const kept of report.ingredientsKept) {
      console.log(`  ${kept.slug}: ${kept.reason}`);
    }
    console.log(
      '\nThese are reported, not deleted. A demo name on a product does not make\n' +
        'the ledger behind it demo data.',
    );
  }
  if (dryRun) console.log('\n[purge-demo-bakes] --dry-run: nothing was written.');
}

const isCliEntry = process.argv[1]?.endsWith('purge-demo-bakes.ts') ?? false;
if (isCliEntry) {
  main()
    .catch((err) => {
      console.error('[purge-demo-bakes] FAILED:', err);
      process.exitCode = 1;
    })
    .finally(() => void closeDatabase());
}

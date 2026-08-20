/**
 * Import the real cake menu from CSV (Aug-2026 feedback set, F-4 / F-5).
 *
 *   DATABASE_URL=... npx tsx apps/api/scripts/import-recipes.ts \
 *     --ingredients ./ingredients.csv --recipes ./recipes.csv [--dry-run]
 *
 * "Displayed recipes are not part of our offering of course." The four demo
 * cakes were invented, and every seeded line was BASE — so the GF / vegan
 * machinery had nothing to act on and "Selecting Vegan or GF options for
 * Battenburg failed to generate required ingredients."
 *
 * See `docs/RECIPE_IMPORT.md` for the schemas and a worked Battenburg example.
 *
 * **Idempotent by `(bake, effective_from, site, variant, ingredient)`.** A
 * re-import supersedes the matching recipe version in place rather than
 * stacking another one beside it.
 *
 * **The validation report is a gate, not advice.** Any problem fails the whole
 * import: a half-imported menu is harder to reason about than none, and every
 * rule describes something that becomes invisible once it is in the database.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { parse as csvParse } from 'csv-parse/sync';
import { closeDatabase, getDb } from '../src/config/database.js';
import { products, sites } from '../src/db/schema/index.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';
import { RecipeService } from '../src/modules/recipes/recipe.service.js';
import {
  crossValidate,
  formatProblems,
  groupRecipes,
  missingColumns,
  parseIngredients,
  parseRecipes,
  type ImportProblem,
  type IngredientRow,
} from '../src/modules/recipes/recipe-import.js';

const COMPANY = getSingletonCompanyId();

interface Args {
  ingredientsPath: string;
  recipesPath: string;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    ingredientsPath: get('--ingredients') ?? 'ingredients.csv',
    recipesPath: get('--recipes') ?? 'recipes.csv',
    dryRun: argv.includes('--dry-run'),
  };
}

function readCsv(path: string): Array<Record<string, string>> {
  const text = readFileSync(path, 'utf8');
  return csvParse(text, {
    columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
    skip_empty_lines: true,
    trim: true,
    // A trailing comma or a short row is a typo, not a reason to abort before
    // the report has had a chance to name every problem at once.
    relax_column_count: true,
  }) as Array<Record<string, string>>;
}

/** Create or update the ingredient product for one CSV row. */
async function upsertIngredient(row: IngredientRow): Promise<string> {
  const db = getDb();
  const existing = await db.query.products.findFirst({
    where: and(eq(products.companyId, COMPANY), eq(products.slug, row.slug)),
    columns: { id: true },
  });

  const values = {
    name: row.name,
    stockUom: row.stockUom,
    purchaseUom: row.purchaseUom,
    purchaseToStockFactor: String(row.purchaseToStockFactor),
    packDescription: row.packDescription,
    expectedNextCost: String(row.expectedNextCost),
    barcode: row.barcode,
    countQuantum: row.countQuantum === null ? null : String(row.countQuantum),
    updatedAt: new Date(),
  };

  if (existing) {
    await db.update(products).set(values).where(eq(products.id, existing.id));
    return existing.id;
  }

  const [created] = await db
    .insert(products)
    .values({
      companyId: COMPANY,
      slug: row.slug,
      stockCode: row.slug.toUpperCase(),
      itemKind: 'INGREDIENT',
      isSold: false,
      isStocked: true,
      ...values,
    })
    .returning();
  return created!.id;
}

export interface ImportResult {
  problems: ImportProblem[];
  ingredientsUpserted: number;
  recipesWritten: number;
  recipesSuperseded: number;
  dryRun: boolean;
}

export async function runImport(args: Args): Promise<ImportResult> {
  const ingredientRows = readCsv(args.ingredientsPath);
  const recipeRows = readCsv(args.recipesPath);

  // An empty file has no first row to read a header from, so the column check
  // below would report every required column as "missing" — which is both
  // wrong and baffling when the header is plainly there. Say what is actually
  // the matter. The blank templates in docs/templates/ hit this exactly.
  const emptyFileProblems: ImportProblem[] = [];
  if (ingredientRows.length === 0) {
    emptyFileProblems.push({
      row: 1,
      file: 'ingredients.csv',
      rule: 'no-data-rows',
      message: 'Header only — no ingredients. Fill the template in before importing.',
    });
  }
  if (recipeRows.length === 0) {
    emptyFileProblems.push({
      row: 1,
      file: 'recipes.csv',
      rule: 'no-data-rows',
      message: 'Header only — no recipe lines. Fill the template in before importing.',
    });
  }

  const missingIngredientCols =
    ingredientRows.length === 0
      ? []
      : missingColumns(Object.keys(ingredientRows[0]!), ['slug', 'name', 'stock_uom']);
  const missingRecipeCols =
    recipeRows.length === 0
      ? []
      : missingColumns(Object.keys(recipeRows[0]!), [
          'bake',
          'effective_from',
          'variant',
          'ingredient_slug',
          'qty_per_table',
        ]);

  const problems: ImportProblem[] = [
    ...emptyFileProblems,
    ...missingIngredientCols.map((c) => ({
      row: 1,
      file: 'ingredients.csv' as const,
      rule: 'missing-column',
      message: `Required column "${c}" is missing.`,
    })),
    ...missingRecipeCols.map((c) => ({
      row: 1,
      file: 'recipes.csv' as const,
      rule: 'missing-column',
      message: `Required column "${c}" is missing.`,
    })),
  ];

  const parsedIngredients = parseIngredients(ingredientRows);
  const parsedRecipes = parseRecipes(recipeRows);
  problems.push(...parsedIngredients.problems, ...parsedRecipes.problems);
  problems.push(...crossValidate(parsedIngredients.ingredients, parsedRecipes.recipes));

  if (problems.length > 0 || args.dryRun) {
    return {
      problems,
      ingredientsUpserted: 0,
      recipesWritten: 0,
      recipesSuperseded: 0,
      dryRun: args.dryRun,
    };
  }

  // ── Write ────────────────────────────────────────────────────────────
  const db = getDb();
  const ids = new Map<string, string>();
  for (const ingredient of parsedIngredients.ingredients) {
    ids.set(ingredient.slug, await upsertIngredient(ingredient));
  }

  const recipeService = new RecipeService();
  let written = 0;
  let superseded = 0;

  for (const group of groupRecipes(parsedRecipes.recipes)) {
    let siteId: string | null = null;
    if (group.siteSlug) {
      const site = await db.query.sites.findFirst({
        where: and(eq(sites.companyId, COMPANY), eq(sites.slug, group.siteSlug)),
        columns: { id: true },
      });
      if (!site) {
        // Reached only if the site was deleted between validation and write.
        throw new Error(`Unknown site slug "${group.siteSlug}" for ${group.bake}.`);
      }
      siteId = site.id;
    }

    // Idempotent: an existing version with the same key is REPLACED wholesale
    // rather than duplicated beside itself.
    const existing = await recipeService.list({ bake: group.bake, companyId: COMPANY });
    const match = existing.find(
      (r) =>
        r.effectiveFrom === group.effectiveFrom && (r.siteId ?? null) === siteId,
    );

    const lines = group.lines.map((l) => ({
      productId: ids.get(l.ingredientSlug)!,
      variant: l.variant,
      qtyPerCover: l.qtyPerTable,
      unitCost: l.unitCost,
    }));

    if (match) {
      await recipeService.update(match.id, { lines }, COMPANY);
      superseded += 1;
    } else {
      await recipeService.create({
        bake: group.bake,
        siteId,
        effectiveFrom: group.effectiveFrom,
        lines,
        companyId: COMPANY,
      });
      written += 1;
    }
  }

  return {
    problems,
    ingredientsUpserted: ids.size,
    recipesWritten: written,
    recipesSuperseded: superseded,
    dryRun: false,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runImport(args);

  console.log(formatProblems(result.problems));

  if (result.problems.length > 0) {
    console.error(
      `\n[import-recipes] REFUSED — ${result.problems.length} problem(s). Nothing was written.`,
    );
    process.exitCode = 1;
    return;
  }
  if (result.dryRun) {
    console.log('\n[import-recipes] --dry-run: validation passed, nothing written.');
    return;
  }
  console.log(
    `\n[import-recipes] ${result.ingredientsUpserted} ingredients, ` +
      `${result.recipesWritten} new recipes, ${result.recipesSuperseded} superseded.`,
  );
}

const isCliEntry = process.argv[1]?.endsWith('import-recipes.ts') ?? false;
if (isCliEntry) {
  main()
    .catch((err) => {
      console.error('[import-recipes] FAILED:', err);
      process.exitCode = 1;
    })
    .finally(() => void closeDatabase());
}

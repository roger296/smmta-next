/**
 * Recipe lines whose unit disagrees with the product they name.
 *
 *   npx tsx apps/api/scripts/check-recipe-units.ts
 *
 * READ-ONLY.
 *
 * A recipe line carries its own `stock_uom` alongside `qty_per_cover`, and
 * `ExpectedConsumptionService` passes that unit straight through into the
 * expected figure and the stock movement behind it. Nothing in the system
 * converts units (see modules/stock/uom.ts), so the line's unit and the
 * product's are only ever correct when they are THE SAME STRING. When they
 * drift apart nothing errors: a line reading 500 g against a product tracked in
 * litres produces an expected consumption of 500 litres, a variance that looks
 * like theft, and a reorder for a tanker of milk.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * `merge-duplicate-products.ts` only converts when the two PRODUCTS' units
 * differ. Change a product's unit by hand — which is exactly what the operator
 * is told to do for the pairs the merge refuses on density — and the merge then
 * sees two products agreeing, moves the lines untouched, and the quantities
 * silently mean something new. The merge cannot detect that on its own: by the
 * time it looks, the units already agree. This does, afterwards, by comparing
 * the line against the product rather than the product against its twin.
 *
 * Worth running after ANY by-hand change to a product's stock unit.
 */
import 'dotenv/config';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { products, recipeLines, recipes } from '../src/db/schema/index.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';
import { canonicalUom, conversionFactor } from '../src/modules/products/product-merge.js';

export interface UnitMismatch {
  bake: string;
  productName: string;
  stockCode: string | null;
  lineUom: string;
  productUom: string;
  qtyPerCover: number;
  /** What the quantity would be if the line's number is right in ITS unit. */
  suggested: number | null;
  /** Null when the two units cannot be converted at all. */
  factor: number | null;
}

export async function checkRecipeUnits(
  companyId = getSingletonCompanyId(),
): Promise<UnitMismatch[]> {
  const db = getDb();
  const rows = await db
    .select({
      bake: recipes.bake,
      productName: products.name,
      stockCode: products.stockCode,
      lineUom: recipeLines.stockUom,
      productUom: products.stockUom,
      qtyPerCover: recipeLines.qtyPerCover,
    })
    .from(recipeLines)
    .innerJoin(recipes, eq(recipes.id, recipeLines.recipeId))
    .innerJoin(products, eq(products.id, recipeLines.productId))
    .where(
      and(
        eq(recipeLines.companyId, companyId),
        isNull(products.deletedAt),
        ne(recipeLines.stockUom, products.stockUom),
      ),
    );

  return rows
    // `ne` is a string comparison, so `kg` vs `KG` shows up as a difference and
    // is not one. Only a real unit disagreement is worth an operator's time.
    .filter((r) => canonicalUom(r.lineUom) !== canonicalUom(r.productUom))
    .map((r) => {
      const f = conversionFactor(r.lineUom, r.productUom);
      const qty = Number(r.qtyPerCover);
      return {
        bake: r.bake,
        productName: r.productName,
        stockCode: r.stockCode,
        lineUom: r.lineUom,
        productUom: r.productUom,
        qtyPerCover: qty,
        factor: typeof f === 'number' ? f : null,
        suggested: typeof f === 'number' ? qty * f : null,
      };
    })
    .sort((a, b) => a.bake.localeCompare(b.bake) || a.productName.localeCompare(b.productName));
}

const isCliEntry = process.argv[1]?.endsWith('check-recipe-units.ts') ?? false;

if (isCliEntry) {
  checkRecipeUnits()
    .then((rows) => {
      if (rows.length === 0) {
        console.log('[check-recipe-units] Every recipe line agrees with its product. Nothing to fix.');
        return;
      }
      console.log(`[check-recipe-units] READ-ONLY - nothing changed\n`);
      console.log(`  ${rows.length} recipe line(s) are denominated in a unit their product does not use.`);
      console.log('  Nothing converts these, so the quantity means whatever the PRODUCT says it does.\n');
      for (const r of rows) {
        const fix =
          r.suggested != null
            ? `should read ${r.suggested} ${r.productUom}`
            : `${r.lineUom} and ${r.productUom} do not convert - decide by hand`;
        console.log(
          `  ${r.bake} - ${r.productName} (${r.stockCode ?? '-'})\n` +
            `     line says ${r.qtyPerCover} ${r.lineUom}, product is tracked in ${r.productUom}  ->  ${fix}`,
        );
      }
      console.log('\n  Fix on the recipe, not the product: changing the product back would');
      console.log('  move the problem to the stock-take instead of solving it.');
      process.exitCode = 1;
    })
    .catch((err) => {
      console.error('[check-recipe-units] FAILED:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => closeDatabase());
}

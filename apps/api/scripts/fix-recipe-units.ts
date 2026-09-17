/**
 * Re-denominate recipe lines into the unit their product actually uses.
 *
 *   npx tsx apps/api/scripts/fix-recipe-units.ts            # dry run
 *   npx tsx apps/api/scripts/fix-recipe-units.ts --apply
 *
 * Run `check-recipe-units.ts` first — it is read-only and lists what is wrong.
 *
 * Where the units convert on their own (g to kg, ml to l) this just applies the
 * factor. The interesting case is MASS AGAINST VOLUME, which does not convert
 * without knowing what the liquid is:
 *
 *     Scones - Long Life Semi Skimmed Milk: line says 400 g, product is in l
 *
 * 400 g of milk is 0.388 l, not 0.4 — and 180 g of rapeseed oil is 0.196 l, not
 * 0.18. Treating 1 g as 1 ml is water's density and is 8% out on the oil, which
 * is a cost error on every bake and a stock error on every count.
 *
 * ⚠️ SO THE DENSITIES ARE WRITTEN DOWN HERE, BY STOCK CODE, AND NOTHING ELSE
 * CONVERTS. A product not in this table is reported, not guessed at. The values
 * are the published ones for each liquid; if the kitchen disagrees, change them
 * here — that is the point of having them in one visible place rather than
 * buried in an expression.
 */
import 'dotenv/config';
import { and, eq, isNull } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { products, recipeLines, recipes } from '../src/db/schema/index.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';
import { canonicalUom, conversionFactor } from '../src/modules/products/product-merge.js';

/**
 * Kilograms per litre, by stock code. Published figures at room temperature.
 * Only these three are needed today; a fourth liquid means a fourth line here,
 * deliberately, rather than a rule that quietly covers everything.
 */
export const DENSITY_KG_PER_L: Record<string, number> = {
  'LONG-LIFE-RAPESEED-OIL': 0.92,
  'LONG-LIFE-RAPE': 0.92,
  'SEMI-SKIM-MILK': 1.03,
  'LONG-LIFE-SEMI-SKIMMED-MILK': 1.03,
  'DAIR-SOYA-MILK': 1.03,
  'LONG-LIFE-SOYA-MILK': 1.03,
};

const MASS = new Set(['g', 'kg']);
const VOLUME = new Set(['ml', 'l']);

/** Grams per unit of the given mass unit. */
const inGrams = (uom: string) => (canonicalUom(uom) === 'kg' ? 1000 : 1);
/** Litres per unit of the given volume unit. */
const inLitres = (uom: string) => (canonicalUom(uom) === 'l' ? 1 : 0.001);

/**
 * How to get from `from` to `to` for one product, or why not.
 *
 * Mass to volume (and back) goes through the density table; everything else
 * through the plain factor. Returns null when it cannot be done, and the caller
 * reports rather than writes.
 */
export function factorFor(
  from: string,
  to: string,
  stockCode: string | null,
): { factor: number; via: string } | { refusal: string } {
  const f = canonicalUom(from);
  const t = canonicalUom(to);
  const plain = conversionFactor(f, t);
  if (typeof plain === 'number') return { factor: plain, via: plain === 1 ? 'no change' : `x${plain}` };

  const crossing = (MASS.has(f) && VOLUME.has(t)) || (VOLUME.has(f) && MASS.has(t));
  if (!crossing) return { refusal: `${f} and ${t} are not the same kind of measurement` };

  const density = stockCode ? DENSITY_KG_PER_L[stockCode.trim().toUpperCase()] : undefined;
  if (density == null) {
    return {
      refusal:
        `${f} to ${t} needs a density and ${stockCode ?? 'this product'} is not in DENSITY_KG_PER_L. ` +
        'Add it there rather than guessing 1 g = 1 ml, which is water.',
    };
  }
  // grams -> litres: divide by (kg/l x 1000). Then scale for the actual units.
  const factor = MASS.has(f)
    ? (inGrams(f) / (density * 1000)) / inLitres(t)
    : (inLitres(f) * density * 1000) / inGrams(t);
  return { factor, via: `density ${density} kg/l` };
}

export interface FixRow {
  bake: string;
  productName: string;
  stockCode: string | null;
  from: string;
  to: string;
  before: number;
  after: number | null;
  via: string;
  refusal?: string;
}

export interface FixReport {
  dryRun: boolean;
  fixed: FixRow[];
  refused: FixRow[];
}

export async function fixRecipeUnits(
  opts: { apply?: boolean; companyId?: string } = {},
): Promise<FixReport> {
  const companyId = opts.companyId ?? getSingletonCompanyId();
  const apply = opts.apply ?? false;
  const db = getDb();

  const rows = await db
    .select({
      lineId: recipeLines.id,
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
    .where(and(eq(recipeLines.companyId, companyId), isNull(products.deletedAt)));

  const report: FixReport = { dryRun: !apply, fixed: [], refused: [] };

  for (const r of rows) {
    if (canonicalUom(r.lineUom) === canonicalUom(r.productUom)) continue;
    const res = factorFor(r.lineUom, r.productUom, r.stockCode);
    const before = Number(r.qtyPerCover);
    const base: FixRow = {
      bake: r.bake,
      productName: r.productName,
      stockCode: r.stockCode,
      from: r.lineUom,
      to: r.productUom,
      before,
      after: null,
      via: '',
    };
    if ('refusal' in res) {
      report.refused.push({ ...base, refusal: res.refusal });
      continue;
    }
    // Four decimals is the column's scale; rounding here rather than letting
    // Postgres do it keeps the reported figure and the stored one identical.
    const after = Math.round(before * res.factor * 10_000) / 10_000;
    report.fixed.push({ ...base, after, via: res.via });
    if (!apply) continue;
    await db
      .update(recipeLines)
      .set({ qtyPerCover: String(after), stockUom: r.productUom })
      .where(eq(recipeLines.id, r.lineId));
  }

  const order = (a: FixRow, b: FixRow) =>
    a.bake.localeCompare(b.bake) || a.productName.localeCompare(b.productName);
  report.fixed.sort(order);
  report.refused.sort(order);
  return report;
}

const isCliEntry = process.argv[1]?.endsWith('fix-recipe-units.ts') ?? false;

if (isCliEntry) {
  const apply = process.argv.includes('--apply');
  fixRecipeUnits({ apply })
    .then((r) => {
      if (r.fixed.length === 0 && r.refused.length === 0) {
        console.log('[fix-recipe-units] Every recipe line already agrees with its product.');
        return;
      }
      console.log(
        `[fix-recipe-units] ${r.dryRun ? 'DRY RUN - nothing written (pass --apply to commit)' : 'APPLIED'}\n`,
      );
      if (r.fixed.length > 0) {
        console.log(`  ${r.fixed.length} line(s) re-denominated:\n`);
        for (const f of r.fixed) {
          console.log(
            `  ${f.bake} - ${f.productName}\n` +
              `     ${f.before} ${f.from}  ->  ${f.after} ${f.to}   (${f.via})`,
          );
        }
        console.log('');
      }
      if (r.refused.length > 0) {
        console.log(`  ${r.refused.length} left alone:\n`);
        for (const f of r.refused) console.log(`  ${f.bake} - ${f.productName}\n     ${f.refusal}`);
        console.log('');
      }
      if (r.dryRun) {
        console.log('  Check the numbers against what the kitchen actually measures,');
        console.log('  then re-run with --apply.');
      }
    })
    .catch((err) => {
      console.error('[fix-recipe-units] FAILED:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => closeDatabase());
}

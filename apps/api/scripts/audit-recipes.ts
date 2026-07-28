/**
 * Report recipe lines that point at products which no longer exist, and the
 * unit mismatches that repairing them can introduce.
 *
 *   npx tsx apps/api/scripts/audit-recipes.ts
 *
 * Read-only. Fixing is deliberately left to a human, because the dangerous
 * part is not finding the broken lines — it is what happens next.
 *
 * ⚠️ THE UNIT TRAP. The four sample recipes were seeded in June against demo
 * products measured in GRAMS and MILLILITRES ("250" meaning 250 g of flour).
 * The real catalogue is in KILOGRAMS and LITRES. Re-pointing a line at the
 * real product without converting turns 250 g into 250 kg — a thousandfold
 * error that no validation catches, because 250 kg of flour is a perfectly
 * legal number. It surfaces as an enormous expected consumption, an enormous
 * materials cost, and a reorder proposal nobody can explain.
 *
 * So this reports the line's stored unit next to the product's unit and says
 * plainly when they differ.
 */
import 'dotenv/config';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { products, recipeLines, recipes, sites } from '../src/db/schema/index.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';

/** Grams/millilitres to their base unit — the conversions that bite. */
const SCALE: Record<string, { to: string; factor: number }> = {
  g: { to: 'kg', factor: 0.001 },
  ml: { to: 'l', factor: 0.001 },
  cl: { to: 'l', factor: 0.01 },
};

export interface RecipeAudit {
  recipeId: string;
  bake: string;
  site: string;
  version: number;
  totalLines: number;
  orphanedLines: Array<{ productId: string; qtyPerCover: string; stockUom: string }>;
  unitMismatches: Array<{
    product: string;
    lineUom: string;
    productUom: string;
    qtyPerCover: string;
    suggested: string | null;
  }>;
}

export async function auditRecipes(companyId = getSingletonCompanyId()): Promise<RecipeAudit[]> {
  const db = getDb();

  const allRecipes = await db.query.recipes.findMany({
    where: eq(recipes.companyId, companyId),
  });
  if (allRecipes.length === 0) return [];

  const siteRows = await db.query.sites.findMany({ where: eq(sites.companyId, companyId) });
  const siteName = (id: string | null) =>
    id ? (siteRows.find((s) => s.id === id)?.name ?? id.slice(0, 8)) : 'Global';

  const lines = await db
    .select()
    .from(recipeLines)
    .where(
      inArray(
        recipeLines.recipeId,
        allRecipes.map((r) => r.id),
      ),
    );

  // Only products that still exist — a soft-deleted one is as unusable to a
  // recipe as one that was never there.
  const live = await db.query.products.findMany({
    where: and(eq(products.companyId, companyId), isNull(products.deletedAt)),
    columns: { id: true, name: true, stockUom: true },
  });
  const byId = new Map(live.map((p) => [p.id, p]));

  return allRecipes
    .map((r) => {
      const mine = lines.filter((l) => l.recipeId === r.id);
      const audit: RecipeAudit = {
        recipeId: r.id,
        bake: r.bake,
        site: siteName(r.siteId),
        version: r.version,
        totalLines: mine.length,
        orphanedLines: [],
        unitMismatches: [],
      };
      for (const l of mine) {
        const product = byId.get(l.productId);
        if (!product) {
          audit.orphanedLines.push({
            productId: l.productId,
            qtyPerCover: String(l.qtyPerCover),
            stockUom: l.stockUom,
          });
          continue;
        }
        if (product.stockUom !== l.stockUom) {
          const conv = SCALE[l.stockUom];
          audit.unitMismatches.push({
            product: product.name,
            lineUom: l.stockUom,
            productUom: product.stockUom,
            qtyPerCover: String(l.qtyPerCover),
            suggested:
              conv && conv.to === product.stockUom
                ? String(Number(l.qtyPerCover) * conv.factor)
                : null,
          });
        }
      }
      return audit;
    })
    .filter((a) => a.orphanedLines.length > 0 || a.unitMismatches.length > 0);
}

const isCliEntry = process.argv[1]?.endsWith('audit-recipes.ts') ?? false;

if (isCliEntry) {
  auditRecipes()
    .then((results) => {
      if (results.length === 0) {
        console.log('[audit-recipes] Every recipe line points at a live product. Nothing to do.');
        return;
      }
      console.log(`[audit-recipes] ${results.length} recipe(s) need attention\n`);
      for (const r of results) {
        const dead = r.orphanedLines.length;
        console.log(`  ${r.bake} — ${r.site} v${r.version}`);
        console.log(`    ${dead} of ${r.totalLines} ingredient(s) point at a deleted product`);
        if (dead === r.totalLines) {
          console.log('    ⚠ EVERY line is dead — this recipe expects nothing at all.');
        }
        for (const o of r.orphanedLines) {
          console.log(`      · ${o.qtyPerCover} ${o.stockUom}  (product ${o.productId.slice(0, 8)} gone)`);
        }
        for (const m of r.unitMismatches) {
          console.log(
            `      ⚠ ${m.product}: line is in ${m.lineUom}, product is in ${m.productUom}` +
              (m.suggested ? ` — ${m.qtyPerCover} ${m.lineUom} is ${m.suggested} ${m.productUom}` : ''),
          );
        }
        console.log('');
      }
      console.log('  The quantities above are the ORIGINAL demo values, in grams and');
      console.log('  millilitres. The real catalogue is in kilograms and litres, so a');
      console.log('  line reading 250 means 250 g — re-point it without converting and');
      console.log('  it becomes 250 kg per guest. Divide by 1000 when repairing.');
      console.log('');
      console.log('  Nothing here has been changed. Repair at');
      console.log('  https://stock.thebigbakes.com/recipes — or delete and rebuild.');
    })
    .catch((err) => {
      console.error('[audit-recipes] FAILED:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => closeDatabase());
}

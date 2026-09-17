/**
 * Merge each duplicated product into the twin that survives.
 *
 *   npx tsx apps/api/scripts/merge-duplicate-products.ts            # dry run
 *   npx tsx apps/api/scripts/merge-duplicate-products.ts --apply
 *
 * Run `find-duplicate-products.ts` first — it is read-only and shows the same
 * pairs with their usage.
 *
 * WHICH TWIN SURVIVES. The one carrying supplier codes: that is the count-list
 * product, in the unit the venue actually counts ("count this item in
 * Kilograms"), and it is what the invoice import already attached codes to.
 * Recipe lines move onto it, converted. See `decideMerge`.
 *
 * ⚠️ THE CONVERSION IS THE WHOLE RISK. Recipes are denominated in the product's
 * own `stock_uom` and nothing in the system converts between units. A line
 * reading `qty_per_cover: 250` on a grams product means 250 kg the moment it
 * lands on a kilograms one — every bake consuming a thousand times too much,
 * the variance reading as theft, reorder buying a tonne of sugar. Pairs that
 * cannot be converted exactly (litres against grams needs a DENSITY, and it
 * differs per liquid) are refused by name and left alone.
 *
 * ⚠️ IT DOES NOT CARRY STOCK ACROSS. Every quantity in the system today came
 * out of user testing and is due to be zeroed before the first real count
 * (`reset-stock-ledger.ts`). Carrying an invented number through a unit change
 * would be inventing a different number; the retired twin's movements and
 * levels are deleted instead. Say so out loud rather than quietly repointing
 * them, because "the count said 4600 g" becoming "4.6 kg on the other product"
 * looks like data and is not.
 *
 * ⚠️ THE TEST HISTORY IS DELETED, NOT MOVED. Stock-take lines, consumption
 * lines and wastage events all carry a quantity in the RETIRED twin's unit. A
 * line reading 250 is 250 grams where it was written and 250 kilograms once it
 * hangs off a kilograms product, and unlike a recipe line there is nothing to
 * convert it for — it is a record of what somebody typed during testing, not a
 * position. They also collide: `stock_take_lines` is unique on
 * (stock_take_id, product_id), and a count sheet listing both twins — which is
 * exactly what a duplicated product does — has a row for each. The first live
 * run died on that constraint. Deleting is both the honest answer and the one
 * that cannot collide.
 *
 * What moves: recipe lines (converted) and supplier codes. What goes: the test
 * history above, the retired twin's stock, and the product itself, soft-deleted.
 */
import 'dotenv/config';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import {
  products,
  recipeLines,
  sessionConsumptionLines,
  stockLevels,
  stockMovements,
  stockTakeLines,
  supplierProducts,
  wastageEvents,
} from '../src/db/schema/index.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';
import { decideMerge, type MergeDecision, type MergeSide } from '../src/modules/products/product-merge.js';

export interface MergeOutcome {
  name: string;
  keep: string;
  retire: string;
  factor: number | null;
  /** How the quantities were handled, for the operator to read at a glance. */
  conversion: string;
  recipeLinesMoved: number;
  supplierCodesMoved: number;
  movementsDeleted: number;
  /** Test-history rows removed with the retired twin. See the header. */
  historyDeleted: number;
  refusal?: string;
}

export interface MergeReport {
  dryRun: boolean;
  merged: MergeOutcome[];
  refused: MergeOutcome[];
}

/** The bake whose recipe names both twins in one section, if any. */
async function recipeLineCollision(keepId: string, retireId: string): Promise<string | null> {
  const db = getDb();
  const rows = await db
    .select({
      recipeId: recipeLines.recipeId,
      productId: recipeLines.productId,
      variant: recipeLines.variant,
      component: recipeLines.component,
    })
    .from(recipeLines)
    .where(inArray(recipeLines.productId, [keepId, retireId]));
  const seen = new Set<string>();
  for (const r of rows.filter((r) => r.productId === keepId)) {
    seen.add(`${r.recipeId}|${r.variant}|${r.component}`);
  }
  for (const r of rows.filter((r) => r.productId === retireId)) {
    const k = `${r.recipeId}|${r.variant}|${r.component}`;
    if (seen.has(k)) return k;
  }
  return null;
}

async function countFor(table: { productId: unknown }, productId: string): Promise<number> {
  const db = getDb();
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(table as never)
    .where(eq(table.productId as never, productId));
  return r?.n ?? 0;
}

export async function mergeDuplicateProducts(
  opts: { apply?: boolean; companyId?: string } = {},
): Promise<MergeReport> {
  const companyId = opts.companyId ?? getSingletonCompanyId();
  const apply = opts.apply ?? false;
  const db = getDb();

  const live = await db
    .select({ id: products.id, name: products.name, stockCode: products.stockCode, stockUom: products.stockUom })
    .from(products)
    .where(and(eq(products.companyId, companyId), isNull(products.deletedAt)));

  const byName = new Map<string, typeof live>();
  for (const p of live) {
    const k = p.name.trim().toLowerCase();
    if (!k) continue;
    const at = byName.get(k);
    if (at) at.push(p);
    else byName.set(k, [p]);
  }

  const report: MergeReport = { dryRun: !apply, merged: [], refused: [] };

  for (const [, rows] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
    // Three or more under one name is not a pair and not this script's job.
    if (rows.length !== 2) continue;

    const sides: MergeSide[] = [];
    for (const p of rows) {
      sides.push({
        id: p.id,
        stockCode: p.stockCode,
        stockUom: p.stockUom,
        recipeLines: await countFor(recipeLines, p.id),
        supplierCodes: await countFor(supplierProducts, p.id),
      });
    }
    const d: MergeDecision = decideMerge(rows[0]!.name, sides[0]!, sides[1]!);

    /**
     * `recipe_lines` is unique on (recipe, product, variant, component). A
     * recipe naming BOTH twins in one section would collide on the repoint —
     * and unlike the test history there is no honest way to resolve it here:
     * summing means adding two numbers in different units, and dropping one
     * silently loses an ingredient from a cake. Refused, named, left alone.
     *
     * It does not arise on the live data (every contested pair has recipes on
     * one side only), which is precisely why it would go unnoticed until the
     * day it did.
     */
    const collision = await recipeLineCollision(d.keep.id, d.retire.id);

    const movements = await countFor(stockMovements, d.retire.id);
    const outcome: MergeOutcome = {
      name: d.name,
      keep: d.keep.stockCode ?? d.keep.id,
      retire: d.retire.stockCode ?? d.retire.id,
      factor: d.factor,
      conversion: d.nothingToConvert
        ? d.unitsDiffer
          ? `nothing to convert (units differ: ${d.retire.stockUom} vs ${d.keep.stockUom})`
          : 'nothing to convert'
        : d.factor === 1
          ? 'same unit'
          : `x${d.factor}`,
      recipeLinesMoved: d.retire.recipeLines,
      supplierCodesMoved: d.retire.supplierCodes,
      movementsDeleted: movements,
      historyDeleted:
        (await countFor(stockTakeLines, d.retire.id)) +
        (await countFor(sessionConsumptionLines, d.retire.id)) +
        (await countFor(wastageEvents, d.retire.id)),
      refusal:
        d.refusal ??
        (collision
          ? `a recipe uses BOTH twins in the same section (${collision}) - ` +
            'merging would either add two different units together or drop an ingredient. Fix that recipe first.'
          : undefined),
    };
    if (outcome.refusal || d.factor == null) {
      report.refused.push(outcome);
      continue;
    }
    report.merged.push(outcome);
    if (!apply) continue;

    const factor = d.factor;
    // One transaction per pair: a product half-merged — recipes moved, codes
    // still on the dead twin — is worse than one not merged at all, and
    // nothing downstream would flag it.
    await db.transaction(async (tx) => {
      if (factor === 1) {
        await tx
          .update(recipeLines)
          .set({ productId: d.keep.id })
          .where(eq(recipeLines.productId, d.retire.id));
      } else {
        await tx
          .update(recipeLines)
          .set({
            productId: d.keep.id,
            qtyPerCover: sql`${recipeLines.qtyPerCover} * ${factor}`,
            stockUom: d.keep.stockUom ?? '',
          })
          .where(eq(recipeLines.productId, d.retire.id));
      }

      /**
       * `supplier_products` is unique on (product, supplier, sku). Both twins
       * carrying the same supplier's same code is possible, so repoint only
       * the ones that would not collide and drop the rest — the survivor's own
       * row already says the same thing.
       */
      const keepCodes = await tx
        .select({ supplierId: supplierProducts.supplierId, sku: supplierProducts.supplierSku })
        .from(supplierProducts)
        .where(eq(supplierProducts.productId, d.keep.id));
      const held = new Set(keepCodes.map((c) => `${c.supplierId}::${c.sku.trim().toLowerCase()}`));
      const retireCodes = await tx
        .select({ id: supplierProducts.id, supplierId: supplierProducts.supplierId, sku: supplierProducts.supplierSku })
        .from(supplierProducts)
        .where(eq(supplierProducts.productId, d.retire.id));
      for (const c of retireCodes) {
        const clash = held.has(`${c.supplierId}::${c.sku.trim().toLowerCase()}`);
        if (clash) await tx.delete(supplierProducts).where(eq(supplierProducts.id, c.id));
        else {
          await tx
            .update(supplierProducts)
            .set({ productId: d.keep.id })
            .where(eq(supplierProducts.id, c.id));
        }
      }

      // NOT carried: an invented quantity through a unit change is a different
      // invented quantity, and the take/consumption lines collide besides. See
      // the header.
      await tx.delete(stockMovements).where(eq(stockMovements.productId, d.retire.id));
      await tx.delete(stockLevels).where(eq(stockLevels.productId, d.retire.id));
      await tx.delete(stockTakeLines).where(eq(stockTakeLines.productId, d.retire.id));
      await tx.delete(sessionConsumptionLines).where(eq(sessionConsumptionLines.productId, d.retire.id));
      await tx.delete(wastageEvents).where(eq(wastageEvents.productId, d.retire.id));

      await tx
        .update(products)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(products.id, d.retire.id));
    });
  }
  return report;
}

const isCliEntry = process.argv[1]?.endsWith('merge-duplicate-products.ts') ?? false;

if (isCliEntry) {
  const apply = process.argv.includes('--apply');
  mergeDuplicateProducts({ apply })
    .then((r) => {
      console.log(
        `[merge-duplicate-products] ${r.dryRun ? 'DRY RUN - nothing written (pass --apply to commit)' : 'APPLIED'}\n`,
      );
      console.log(`  merged  : ${r.merged.length}`);
      console.log(`  refused : ${r.refused.length}\n`);
      if (r.merged.length > 0) {
        console.log('  ── would merge ──');
        for (const m of r.merged) {
          console.log(
            `  ${m.name}\n     keep ${m.keep}  <-  retire ${m.retire}  ` +
              `(${m.recipeLinesMoved} recipe line(s) ${m.conversion}, ${m.supplierCodesMoved} code(s), ` +
              `${m.movementsDeleted} movement(s) + ${m.historyDeleted} test history row(s) discarded)`,
          );
        }
        console.log('');
      }
      if (r.refused.length > 0) {
        console.log('  ── REFUSED, left exactly as they are ──');
        for (const m of r.refused) console.log(`  ${m.name}\n     ${m.refusal}`);
        console.log('');
      }
      if (r.dryRun) console.log('  Re-run with --apply to commit.');
    })
    .catch((err) => {
      console.error('[merge-duplicate-products] FAILED:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => closeDatabase());
}

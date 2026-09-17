/**
 * Merge each duplicated product into the twin that survives.
 *
 *   npx tsx apps/api/scripts/merge-duplicate-products.ts            # dry run
 *   npx tsx apps/api/scripts/merge-duplicate-products.ts --apply
 *   npx tsx apps/api/scripts/merge-duplicate-products.ts --pairs     # named pairs
 *
 * Run `find-duplicate-products.ts` first — it is read-only and shows the same
 * pairs with their usage.
 *
 * TWO MODES. By default it groups by NAME, which is what a duplicate usually
 * looks like. `--pairs` instead reads `data/product-merge-pairs.csv`, where a
 * human has named both twins by stock code and said which survives.
 *
 * That exists because the two duplicates worth merging here are NOT
 * same-named: "Olives" [PITT-MIXD-OLIV] and "Pitted Mixed Olives"
 * [PITT-MIXE-OLIV] are one item the decisions sheet described two ways, so no
 * scan groups them. They are also the exact shape `decideMerge` refuses on its
 * own - same unit, supplier codes on both sides - because with nothing to tell
 * two products apart, choosing between them is a judgement. Naming the
 * survivor IS that judgement, and the file records who made it and why.
 *
 * Named-pairs mode REPLACES the name scan rather than adding to it, so a dry
 * run shows exactly the pairs you listed and nothing else.
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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { parse as csvParse } from 'csv-parse/sync';
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

const DATA_DIR = join(import.meta.dirname, '..', 'data');

export interface MergePairRow {
  keepStockCode: string;
  retireStockCode: string;
  why: string;
}

/**
 * Pairs a human has named, for duplicates the name scan cannot see.
 *
 * "Olives" and "Pitted Mixed Olives" are one item under two names, so nothing
 * groups them automatically - and they are the shape `decideMerge` refuses on
 * its own, since both are kilograms and both carry supplier codes. Naming the
 * survivor IS the judgement; the file records who made it and why.
 */
export function readMergePairsCsv(text: string): MergePairRow[] {
  const records = csvParse(text, { columns: true, skip_empty_lines: true, bom: true }) as Array<
    Record<string, string>
  >;
  return records
    .map((r) => ({
      keepStockCode: (r.keep_stock_code ?? '').trim(),
      retireStockCode: (r.retire_stock_code ?? '').trim(),
      why: (r.why ?? '').trim(),
    }))
    .filter((r) => r.keepStockCode && r.retireStockCode);
}

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
  opts: { apply?: boolean; companyId?: string; pairsFile?: string } = {},
): Promise<MergeReport> {
  const companyId = opts.companyId ?? getSingletonCompanyId();
  const apply = opts.apply ?? false;
  const db = getDb();

  const live = await db
    .select({ id: products.id, name: products.name, stockCode: products.stockCode, stockUom: products.stockUom })
    .from(products)
    .where(and(eq(products.companyId, companyId), isNull(products.deletedAt)));

  const report: MergeReport = { dryRun: !apply, merged: [], refused: [] };

  /**
   * Candidate pairs, and who chose the survivor.
   *
   * Named-pairs mode replaces the name scan rather than adding to it: the two
   * answer different questions, and a run that silently did both would make
   * "what is this about to change?" harder to read off a dry run than it needs
   * to be.
   */
  const candidates: Array<{ rows: typeof live; preferKeepId: string | null }> = [];
  if (opts.pairsFile) {
    const byCode = new Map(live.filter((p) => p.stockCode).map((p) => [p.stockCode!.trim().toUpperCase(), p]));
    for (const pair of readMergePairsCsv(readFileSync(opts.pairsFile, 'utf8'))) {
      const keep = byCode.get(pair.keepStockCode.toUpperCase());
      const retire = byCode.get(pair.retireStockCode.toUpperCase());
      // A named pair whose codes do not both resolve is a stale file, not a
      // merge. Say which, rather than silently doing nothing.
      if (!keep || !retire) {
        report.refused.push({
          name: `${pair.keepStockCode} <- ${pair.retireStockCode}`,
          keep: pair.keepStockCode, retire: pair.retireStockCode,
          factor: null, conversion: '-', recipeLinesMoved: 0, supplierCodesMoved: 0,
          movementsDeleted: 0, historyDeleted: 0,
          refusal: `no live product with stock code ${!keep ? pair.keepStockCode : pair.retireStockCode}`,
        });
        continue;
      }
      candidates.push({ rows: [keep, retire], preferKeepId: keep.id });
    }
  } else {
    const byName = new Map<string, typeof live>();
    for (const p of live) {
      const k = p.name.trim().toLowerCase();
      if (!k) continue;
      const at = byName.get(k);
      if (at) at.push(p);
      else byName.set(k, [p]);
    }
    for (const [, rows] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
      // Three or more under one name is not a pair and not this script's job.
      if (rows.length !== 2) continue;
      candidates.push({ rows, preferKeepId: null });
    }
  }

  for (const { rows, preferKeepId } of candidates) {

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
    const d: MergeDecision = decideMerge(
      preferKeepId ? `${rows[0]!.name} <- ${rows[1]!.name}` : rows[0]!.name,
      sides[0]!,
      sides[1]!,
      preferKeepId,
    );

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
  // `--pairs` with no value uses the committed file; `--pairs=<path>` takes
  // another. Named-pairs mode REPLACES the name scan - see the header.
  const pairsArg = process.argv.find((a) => a === '--pairs' || a.startsWith('--pairs='));
  const pairsFile = pairsArg
    ? (pairsArg.includes('=') ? pairsArg.slice('--pairs='.length) : join(DATA_DIR, 'product-merge-pairs.csv'))
    : undefined;
  if (pairsFile) console.log(`[merge-duplicate-products] named pairs from ${pairsFile}\n`);
  mergeDuplicateProducts({ apply, pairsFile })
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

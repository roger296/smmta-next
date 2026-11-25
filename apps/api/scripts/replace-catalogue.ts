/**
 * Replace the product catalogue with head office's new list (Nov 2026).
 *
 *   npx tsx apps/api/scripts/replace-catalogue.ts            # dry run
 *   npx tsx apps/api/scripts/replace-catalogue.ts --apply
 *
 * Reads `data/catalogue-2026-11/new-list.csv` (the 438-line list, every line
 * with a new stock code, name, sub-category, unit and count instruction) and
 * `data/catalogue-2026-11/mapping.csv` (which existing product(s) each line
 * replaces — the list itself does not say, so the pairing was made by hand and
 * the judgement calls carry a note in its `check` column).
 *
 * WHAT IT DOES, per list line:
 *   - no old product  -> a new product is created;
 *   - one old product -> that product is RE-CODED IN PLACE: new stock code,
 *     name, item category, pack description, unit and count instruction. The
 *     product id does not change, so its recipes, supplier codes, purchase
 *     orders and history stay attached — which is the whole reason for doing
 *     it this way rather than importing 438 new rows beside the old ones;
 *   - two or more     -> the first is re-coded as above and the others are
 *     MERGED into it (recipe lines and supplier codes move across, converted;
 *     the duplicate is soft-deleted). Same rules as `merge-duplicate-products`.
 * Then every live product the mapping does not mention is RETIRED (soft
 * deleted, its supplier codes with it) — unless a recipe or a Square item still
 * uses it (or it is an experience-ticket package), in which case it is KEPT and
 * listed, because retiring it would take an ingredient out of a cake or stop a
 * till sale decrementing stock.
 *
 * ⚠️ THE UNIT. Recipes, reorder points and the stock position are all in the
 * product's own `stock_uom`, and the list changes it for most products (Caster
 * Sugar: kilograms -> one 25 kg sack). When the factor between the two is
 * known, every one of those quantities is multiplied by it, in the same
 * transaction. When it is NOT known — litres against grams, "1 lemon", a
 * bottle becoming litres — or converting would round a recipe quantity away,
 * the product is still re-coded and re-named but KEEPS ITS OLD UNIT AND ITS
 * OLD COUNT INSTRUCTION, and is listed. An instruction saying "count tubs" on a
 * product whose number is read as kilograms is worse than either alone.
 *
 * ⚠️ MERGED DUPLICATES LOSE THEIR STOCK-TAKE LINES. As in
 * `merge-duplicate-products`: the duplicate's quantities are in its own unit,
 * and its count lines collide with the survivor's on the same sheet. They are
 * deleted, and the dry run says how many.
 *
 * ALL OR NOTHING. One transaction: a catalogue half re-coded cannot be put back
 * by hand. The dry run is the same code inside a transaction that is rolled
 * back at the end, so what it reports is what --apply does.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import {
  itemCategories,
  products,
  recipeLines,
  sessionConsumptionLines,
  squareItemMap,
  stockBatches,
  stockLevels,
  stockMovements,
  stockTakeLines,
  stockTakes,
  supplierProductAliases,
  supplierProducts,
  wastageEvents,
} from '../src/db/schema/index.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';
import {
  crossCheck,
  newProductKind,
  packDescriptionFor,
  readCatalogueMapping,
  readNewCatalogue,
  scaleQty,
  unitFactor,
  type NewCatalogueRow,
} from '../src/modules/products/catalogue-replace.js';

const DATA_DIR = join(import.meta.dirname, '..', 'data', 'catalogue-2026-11');

export interface ReplaceReport {
  dryRun: boolean;
  updated: Array<{ code: string; from: string; oldName: string; unit: string; recipeLines: number; check: string }>;
  /** Re-coded and re-named, but the unit could not be converted. */
  unitKept: Array<{ code: string; from: string; keptUom: string; listUom: string; reason: string }>;
  created: Array<{ code: string; name: string }>;
  merged: Array<{
    code: string; retired: string; oldName: string; recipeLines: number; supplierCodes: number;
    historyDeleted: number; unit: string;
  }>;
  /** Duplicates left exactly as they were. */
  mergeRefused: Array<{ code: string; duplicate: string; oldName: string; reason: string }>;
  retired: Array<{ code: string; name: string; supplierCodes: number; onHand: number }>;
  /** Not on the list, still used — left live for a decision. */
  keptNotOnList: Array<{ code: string; name: string; recipeLines: number; squareItems: number }>;
  categoriesCreated: string[];
  categoriesRetired: string[];
  openStockTakes: number;
}

class DryRunRollback extends Error {}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

const N = sql<number>`count(*)::int`;

async function countWhere(tx: Tx, table: { productId: unknown }, productId: string): Promise<number> {
  // Every table passed here has a product_id column; the cast is for drizzle.
  const t = table as unknown as typeof recipeLines;
  const [r] = await tx.select({ n: N }).from(t).where(eq(t.productId, productId));
  return r?.n ?? 0;
}

/**
 * Multiply every quantity this product holds in its stock unit by `factor`.
 * Recipe lines are checked first by the caller (a rounding loss there is a
 * refusal); the stock position is test data due for the ledger reset, so it is
 * converted as faithfully as its 3-dp columns allow and not refused.
 */
async function convertProductQuantities(tx: Tx, productId: string, factor: number, newUom: string): Promise<void> {
  if (factor === 1) {
    await tx.update(recipeLines).set({ stockUom: newUom }).where(eq(recipeLines.productId, productId));
    return;
  }
  const f = String(factor);
  await tx
    .update(recipeLines)
    .set({
      qtyPerCover: sql`round(${recipeLines.qtyPerCover} * ${f}::numeric, 4)`,
      unitCost: sql`round(${recipeLines.unitCost} / ${f}::numeric, 4)`,
      stockUom: newUom,
    })
    .where(eq(recipeLines.productId, productId));
  await tx
    .update(stockMovements)
    .set({ qtyDelta: sql`round(${stockMovements.qtyDelta} * ${f}::numeric, 3)` })
    .where(eq(stockMovements.productId, productId));
  // on_hand is a cache of the ledger (see reset-stock-ledger.ts), so it is
  // re-derived from the converted movements rather than rounded separately.
  await tx
    .update(stockLevels)
    .set({
      onHand: sql`coalesce((select sum(m.qty_delta) from stock_movements m
                  where m.product_id = ${stockLevels.productId} and m.site_id = ${stockLevels.siteId}), 0)`,
      allocated: sql`round(${stockLevels.allocated} * ${f}::numeric, 3)`,
      reorderPoint: sql`round(${stockLevels.reorderPoint} * ${f}::numeric, 3)`,
      reorderUpTo: sql`round(${stockLevels.reorderUpTo} * ${f}::numeric, 3)`,
      updatedAt: new Date(),
    })
    .where(eq(stockLevels.productId, productId));
  await tx
    .update(stockBatches)
    .set({
      originalQty: sql`round(${stockBatches.originalQty} * ${f}::numeric, 3)`,
      qtyRemaining: sql`round(${stockBatches.qtyRemaining} * ${f}::numeric, 3)`,
      unitCost: sql`round(${stockBatches.unitCost} / ${f}::numeric, 4)`,
    })
    .where(eq(stockBatches.productId, productId));
  await tx
    .update(stockTakeLines)
    .set({
      bookQty: sql`round(${stockTakeLines.bookQty} * ${f}::numeric, 3)`,
      countedQty: sql`round(${stockTakeLines.countedQty} * ${f}::numeric, 3)`,
      variance: sql`round(${stockTakeLines.variance} * ${f}::numeric, 3)`,
    })
    .where(eq(stockTakeLines.productId, productId));
}

/** Would converting this product's recipe lines by `factor` lose anything? */
async function recipeRoundingProblem(tx: Tx, productId: string, factor: number): Promise<string | null> {
  if (factor === 1) return null;
  const lines = await tx
    .select({ qty: recipeLines.qtyPerCover })
    .from(recipeLines)
    .where(eq(recipeLines.productId, productId));
  for (const l of lines) {
    const s = scaleQty(l.qty, factor, 4);
    if (!s.ok) {
      return `a recipe line of ${Number(l.qty)} becomes ${s.value} in the new unit - too small to keep 4 decimal places`;
    }
  }
  return null;
}

/** Soft-delete a supplier mapping and its aliases (aliasConflict sees dead owners). */
async function retireSupplierCode(tx: Tx, supplierProductId: string, now: Date): Promise<void> {
  await tx
    .update(supplierProductAliases)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(supplierProductAliases.supplierProductId, supplierProductId), isNull(supplierProductAliases.deletedAt)));
  await tx.update(supplierProducts).set({ deletedAt: now, updatedAt: now }).where(eq(supplierProducts.id, supplierProductId));
}

/**
 * Move a duplicate's live supplier codes onto the survivor. `supplier_products`
 * is unique on (product, supplier, sku) INCLUDING soft-deleted rows, so a code
 * the survivor already holds (live or not) is not moved: the survivor's row is
 * revived if it was dead, the duplicate's aliases move onto it, and the
 * duplicate's row is retired.
 */
async function moveSupplierCodes(tx: Tx, keepId: string, retireId: string, now: Date): Promise<number> {
  const keepRows = await tx
    .select({ id: supplierProducts.id, supplierId: supplierProducts.supplierId, sku: supplierProducts.supplierSku, deletedAt: supplierProducts.deletedAt })
    .from(supplierProducts)
    .where(eq(supplierProducts.productId, keepId));
  const held = new Map(keepRows.map((r) => [`${r.supplierId}::${r.sku}`, r]));
  const retireRows = await tx
    .select({ id: supplierProducts.id, supplierId: supplierProducts.supplierId, sku: supplierProducts.supplierSku })
    .from(supplierProducts)
    .where(and(eq(supplierProducts.productId, retireId), isNull(supplierProducts.deletedAt)));
  for (const r of retireRows) {
    const clash = held.get(`${r.supplierId}::${r.sku}`);
    if (!clash) {
      await tx.update(supplierProducts).set({ productId: keepId, updatedAt: now }).where(eq(supplierProducts.id, r.id));
      continue;
    }
    if (clash.deletedAt) {
      await tx.update(supplierProducts).set({ deletedAt: null, updatedAt: now }).where(eq(supplierProducts.id, clash.id));
    }
    await tx
      .update(supplierProductAliases)
      .set({ supplierProductId: clash.id, updatedAt: now })
      .where(and(eq(supplierProductAliases.supplierProductId, r.id), isNull(supplierProductAliases.deletedAt)));
    await tx.update(supplierProducts).set({ deletedAt: now, updatedAt: now }).where(eq(supplierProducts.id, r.id));
  }
  return retireRows.length;
}

export async function replaceCatalogue(
  opts: { apply?: boolean; companyId?: string; listText?: string; mappingText?: string } = {},
): Promise<ReplaceReport> {
  const companyId = opts.companyId ?? getSingletonCompanyId();
  const apply = opts.apply ?? false;
  const list = readNewCatalogue(opts.listText ?? readFileSync(join(DATA_DIR, 'new-list.csv'), 'utf8'));
  const mapping = readCatalogueMapping(opts.mappingText ?? readFileSync(join(DATA_DIR, 'mapping.csv'), 'utf8'));
  const fileProblems = crossCheck(list, mapping);
  if (fileProblems.length > 0) throw new Error(`the list and the mapping disagree:\n  ${fileProblems.join('\n  ')}`);

  const report: ReplaceReport = {
    dryRun: !apply, updated: [], unitKept: [], created: [], merged: [], mergeRefused: [],
    retired: [], keptNotOnList: [], categoriesCreated: [], categoriesRetired: [], openStockTakes: 0,
  };
  const listByCode = new Map(list.map((r) => [r.stockCode.toUpperCase(), r]));
  const db = getDb();

  try {
    await db.transaction(async (tx) => {
      const now = new Date();
      const live = await tx
        .select({
          id: products.id, name: products.name, stockCode: products.stockCode, stockUom: products.stockUom,
          expectedNextCost: products.expectedNextCost, itemCategoryId: products.itemCategoryId,
          isExperienceBooking: products.isExperienceBooking,
        })
        .from(products)
        .where(and(eq(products.companyId, companyId), isNull(products.deletedAt)));
      const byCode = new Map(live.filter((p) => p.stockCode).map((p) => [p.stockCode!.trim().toUpperCase(), p]));

      // The mapping must describe THIS database. A code it names that is not
      // live, or a new code another product already carries, means the file
      // and the catalogue have drifted apart: stop, rather than guess.
      const drift: string[] = [];
      const mentioned = new Set<string>();
      for (const m of mapping) {
        for (const o of m.oldStockCodes) {
          if (!byCode.has(o.toUpperCase())) drift.push(`${m.newStockCode}: no live product with stock code ${o}`);
          mentioned.add(o.toUpperCase());
        }
        const holder = byCode.get(m.newStockCode.toUpperCase());
        if (holder && !m.oldStockCodes.some((o) => o.toUpperCase() === m.newStockCode.toUpperCase())) {
          drift.push(`${m.newStockCode} is already the stock code of "${holder.name}"`);
        }
      }
      if (drift.length > 0) throw new Error(`the mapping does not match this catalogue:\n  ${drift.join('\n  ')}`);

      const [open] = await tx
        .select({ n: N })
        .from(stockTakes)
        .where(and(eq(stockTakes.companyId, companyId), eq(stockTakes.status, 'OPEN')));
      report.openStockTakes = open?.n ?? 0;

      // ── Item categories: the list's sub-categories, reused case-insensitively.
      const cats = await tx
        .select({ id: itemCategories.id, name: itemCategories.name })
        .from(itemCategories)
        .where(and(eq(itemCategories.companyId, companyId), isNull(itemCategories.deletedAt)));
      const catByName = new Map(cats.map((c) => [c.name.trim().toLowerCase(), c.id]));
      const wanted = [...new Set(list.map((r) => r.subCategory))].sort((a, b) => a.localeCompare(b));
      for (const [i, name] of wanted.entries()) {
        const existing = catByName.get(name.toLowerCase());
        if (existing) {
          // Reused (e.g. "Creation Corner"): put it in its alphabetical place too.
          await tx.update(itemCategories).set({ sortOrder: (i + 1) * 10, updatedAt: now }).where(eq(itemCategories.id, existing));
          continue;
        }
        const [c] = await tx
          .insert(itemCategories)
          .values({ companyId, name, sortOrder: (i + 1) * 10 })
          .returning({ id: itemCategories.id });
        catByName.set(name.toLowerCase(), c!.id);
        report.categoriesCreated.push(name);
      }
      const categoryFor = (r: NewCatalogueRow) => catByName.get(r.subCategory.toLowerCase())!;

      for (const m of mapping) {
        const row = listByCode.get(m.newStockCode.toUpperCase())!;
        if (m.oldStockCodes.length === 0) {
          const kind = newProductKind(row);
          await tx.insert(products).values({
            companyId,
            name: row.name,
            stockCode: row.stockCode,
            stockUom: row.stockUom,
            itemCategoryId: categoryFor(row),
            stockCheckInstruction: row.stockCheckInstruction || null,
            packDescription: packDescriptionFor(row),
            itemKind: kind.itemKind,
            isSold: kind.isSold,
            isStocked: true,
          });
          report.created.push({ code: row.stockCode, name: row.name });
          continue;
        }

        const keep = byCode.get(m.oldStockCodes[0]!.toUpperCase())!;
        const recipeCount = await countWhere(tx, recipeLines, keep.id);
        const uf = unitFactor(keep.stockUom, row.stockUom, row.size);
        let finalUom = keep.stockUom;
        const refusal = 'refusal' in uf ? uf.refusal : await recipeRoundingProblem(tx, keep.id, uf.factor);

        const patch: Partial<typeof products.$inferInsert> = {
          stockCode: row.stockCode,
          name: row.name,
          itemCategoryId: categoryFor(row),
          packDescription: packDescriptionFor(row),
          updatedAt: now,
        };
        if (!refusal && 'factor' in uf) {
          await convertProductQuantities(tx, keep.id, uf.factor, row.stockUom);
          finalUom = row.stockUom;
          patch.stockUom = row.stockUom;
          patch.stockCheckInstruction = row.stockCheckInstruction || null;
          if (keep.expectedNextCost != null && uf.factor !== 1) {
            patch.expectedNextCost = (Number(keep.expectedNextCost) / uf.factor).toFixed(6);
          }
          report.updated.push({
            code: row.stockCode, from: keep.stockCode ?? '', oldName: keep.name,
            unit: uf.factor === 1 ? uf.how : `${uf.how} (x${Number(uf.factor.toPrecision(6))})`,
            recipeLines: recipeCount, check: m.check,
          });
        } else {
          report.unitKept.push({
            code: row.stockCode, from: keep.stockCode ?? '', keptUom: keep.stockUom, listUom: row.stockUom,
            reason: refusal ?? 'no factor',
          });
        }
        await tx.update(products).set(patch).where(eq(products.id, keep.id));

        // ── Duplicates folded into the survivor.
        for (const dupCode of m.oldStockCodes.slice(1)) {
          const dup = byCode.get(dupCode.toUpperCase())!;
          const dupRecipes = await countWhere(tx, recipeLines, dup.id);
          const df = unitFactor(dup.stockUom, finalUom, row.size);
          let why: string | null = null;
          let factor = 1;
          if (dupRecipes > 0) {
            if ('refusal' in df) why = df.refusal;
            else {
              factor = df.factor;
              why = await recipeRoundingProblem(tx, dup.id, factor);
            }
            if (!why) {
              const clash = await tx.execute(sql`
                select 1 from recipe_lines a join recipe_lines b
                  on a.recipe_id = b.recipe_id and a.variant = b.variant and a.component = b.component
                 where a.product_id = ${keep.id} and b.product_id = ${dup.id} limit 1`);
              if (clash.rows.length > 0) {
                why = 'a recipe uses both products in the same section - merging would add two quantities or drop one';
              }
            }
          }
          if (why) {
            report.mergeRefused.push({ code: row.stockCode, duplicate: dup.stockCode ?? '', oldName: dup.name, reason: why });
            continue;
          }
          if (dupRecipes > 0) {
            await tx
              .update(recipeLines)
              .set(
                factor === 1
                  ? { productId: keep.id, stockUom: finalUom }
                  : {
                      productId: keep.id,
                      stockUom: finalUom,
                      qtyPerCover: sql`round(${recipeLines.qtyPerCover} * ${String(factor)}::numeric, 4)`,
                      unitCost: sql`round(${recipeLines.unitCost} / ${String(factor)}::numeric, 4)`,
                    },
              )
              .where(eq(recipeLines.productId, dup.id));
          }
          const codes = await moveSupplierCodes(tx, keep.id, dup.id, now);
          await tx.update(squareItemMap).set({ productId: keep.id, updatedAt: now }).where(eq(squareItemMap.productId, dup.id));
          const history =
            (await countWhere(tx, stockTakeLines, dup.id)) +
            (await countWhere(tx, sessionConsumptionLines, dup.id)) +
            (await countWhere(tx, wastageEvents, dup.id));
          await tx.delete(stockMovements).where(eq(stockMovements.productId, dup.id));
          await tx.delete(stockBatches).where(eq(stockBatches.productId, dup.id));
          await tx.delete(stockLevels).where(eq(stockLevels.productId, dup.id));
          await tx.delete(stockTakeLines).where(eq(stockTakeLines.productId, dup.id));
          await tx.delete(sessionConsumptionLines).where(eq(sessionConsumptionLines.productId, dup.id));
          await tx.delete(wastageEvents).where(eq(wastageEvents.productId, dup.id));
          await tx.update(products).set({ deletedAt: now, updatedAt: now }).where(eq(products.id, dup.id));
          report.merged.push({
            code: row.stockCode, retired: dup.stockCode ?? '', oldName: dup.name, recipeLines: dupRecipes,
            supplierCodes: codes, historyDeleted: history,
            unit: dupRecipes === 0 ? 'no recipe lines to convert' : factor === 1 ? 'same unit' : `x${Number(factor.toPrecision(6))}`,
          });
        }
      }

      // ── Everything the mapping does not mention.
      for (const p of live) {
        if (p.stockCode && mentioned.has(p.stockCode.trim().toUpperCase())) continue;
        const recipeCount = await countWhere(tx, recipeLines, p.id);
        const squareCount = await countWhere(tx, squareItemMap, p.id);
        // A ticket package sums a session's covers; never retire one as "stock".
        if (recipeCount > 0 || squareCount > 0 || p.isExperienceBooking) {
          report.keptNotOnList.push({ code: p.stockCode ?? '', name: p.name, recipeLines: recipeCount, squareItems: squareCount });
          continue;
        }
        const codes = await tx
          .select({ id: supplierProducts.id })
          .from(supplierProducts)
          .where(and(eq(supplierProducts.productId, p.id), isNull(supplierProducts.deletedAt)));
        for (const c of codes) await retireSupplierCode(tx, c.id, now);
        const [oh] = await tx
          .select({ total: sql<string>`coalesce(sum(${stockLevels.onHand}), 0)` })
          .from(stockLevels)
          .where(eq(stockLevels.productId, p.id));
        await tx.update(products).set({ deletedAt: now, updatedAt: now }).where(eq(products.id, p.id));
        report.retired.push({ code: p.stockCode ?? '', name: p.name, supplierCodes: codes.length, onHand: Number(oh?.total ?? 0) });
      }

      // ── Item categories nothing live uses any more (the old six, mostly).
      const used = await tx
        .select({ id: products.itemCategoryId })
        .from(products)
        .where(and(eq(products.companyId, companyId), isNull(products.deletedAt)));
      const inUse = new Set(used.map((u) => u.id).filter(Boolean));
      const allCats = await tx
        .select({ id: itemCategories.id, name: itemCategories.name })
        .from(itemCategories)
        .where(and(eq(itemCategories.companyId, companyId), isNull(itemCategories.deletedAt)));
      const keepNames = new Set(wanted.map((w) => w.toLowerCase()));
      const dead = allCats.filter((c) => !inUse.has(c.id) && !keepNames.has(c.name.trim().toLowerCase()));
      if (dead.length > 0) {
        await tx
          .update(itemCategories)
          .set({ deletedAt: now, updatedAt: now })
          .where(inArray(itemCategories.id, dead.map((c) => c.id)));
        report.categoriesRetired.push(...dead.map((c) => c.name));
      }

      if (!apply) throw new DryRunRollback();
    });
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err;
  }
  return report;
}

const isCliEntry = process.argv[1]?.endsWith('replace-catalogue.ts') ?? false;

if (isCliEntry) {
  const apply = process.argv.includes('--apply');
  replaceCatalogue({ apply })
    .then((r) => {
      const say = (s = '') => console.log(s);
      say(`[replace-catalogue] ${r.dryRun ? 'DRY RUN - nothing written (pass --apply to commit)' : 'APPLIED'}`);
      say();
      say(`  re-coded in place     : ${r.updated.length + r.unitKept.length}  (${r.unitKept.length} keep their old unit - see below)`);
      say(`  created               : ${r.created.length}`);
      say(`  duplicates merged in  : ${r.merged.length}`);
      say(`  duplicates NOT merged : ${r.mergeRefused.length}`);
      say(`  retired (not on list) : ${r.retired.length}`);
      say(`  KEPT, not on list     : ${r.keptNotOnList.length}  (still used by a recipe or Square)`);
      say(`  categories created    : ${r.categoriesCreated.length}  ${r.categoriesCreated.join(', ')}`);
      say(`  categories retired    : ${r.categoriesRetired.length}  ${r.categoriesRetired.join(', ')}`);
      if (r.openStockTakes > 0) say(`  ⚠️  ${r.openStockTakes} stock-take(s) are OPEN - best cancelled or approved first`);
      say();
      if (r.unitKept.length > 0) {
        say('  ── RE-CODED BUT UNIT KEPT (change these by hand once decided) ──');
        for (const u of r.unitKept) say(`  ${u.code}  (was ${u.from})  keeps ${u.keptUom}, list says ${u.listUom}: ${u.reason}`);
        say();
      }
      if (r.keptNotOnList.length > 0) {
        say('  ── NOT ON THE LIST BUT STILL USED - left live ──');
        for (const k of r.keptNotOnList) say(`  ${k.code}  ${k.name}  (${k.recipeLines} recipe line(s), ${k.squareItems} Square item(s))`);
        say();
      }
      if (r.mergeRefused.length > 0) {
        say('  ── DUPLICATES NOT MERGED - left exactly as they were ──');
        for (const m of r.mergeRefused) say(`  ${m.duplicate}  ${m.oldName}  (into ${m.code}): ${m.reason}`);
        say();
      }
      if (r.merged.length > 0) {
        say('  ── duplicates merged ──');
        for (const m of r.merged) {
          say(`  ${m.retired}  ${m.oldName}  -> ${m.code}  (${m.recipeLines} recipe line(s) ${m.unit}, ` +
            `${m.supplierCodes} supplier code(s), ${m.historyDeleted} count/bake/wastage line(s) deleted)`);
        }
        say();
      }
      if (r.retired.length > 0) {
        say('  ── retired ──');
        for (const x of r.retired) {
          say(`  ${x.code}  ${x.name}${x.supplierCodes ? `  (${x.supplierCodes} supplier code(s) retired)` : ''}` +
            `${x.onHand ? `  [on hand ${x.onHand}]` : ''}`);
        }
        say();
      }
      say('  ── re-coded, unit converted ──');
      for (const u of r.updated) say(`  ${u.code}  <- ${u.from}  ${u.unit}${u.recipeLines ? `, ${u.recipeLines} recipe line(s)` : ''}`);
      say();
      if (r.dryRun) say('  Re-run with --apply to commit.');
    })
    .catch((err) => {
      console.error('[replace-catalogue] FAILED:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => closeDatabase());
}

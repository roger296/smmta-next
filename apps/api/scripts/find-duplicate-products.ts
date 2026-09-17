/**
 * Which of a pair of duplicate products is the system actually using?
 *
 *   npx tsx apps/api/scripts/find-duplicate-products.ts
 *
 * READ-ONLY. It changes nothing; it answers the one question you need before
 * you can safely merge anything.
 *
 * ── What it found, and why it matters ────────────────────────────────────
 * The live catalogue has 29 names used by two live products each — 58 rows.
 * They arrived in two batches: the recipe import created ingredients in GRAMS,
 * and the count-list import created the same ingredients again in KILOGRAMS.
 *
 *     Caster Sugar  CASTER-SUGAR    stock_uom g    created 15 Jul
 *     Caster Sugar  BAKE-CAST-SUGR  stock_uom kg   created 27 Jul
 *
 * That is not a tidiness problem. If recipes consume from one twin while
 * stock-takes and goods-in land on the other, then for those ingredients the
 * stock level is wrong, the expected-vs-actual variance on the bake form is
 * wrong, and the reorder proposal is wrong — and every screen still looks
 * perfectly normal, because both products exist and both have plausible
 * numbers.
 *
 * So before anything is merged, this reports per pair which twin carries
 * recipe lines, stock movements, stock on hand, consumption history and
 * supplier codes. The twin the system uses is the one to keep; the other is
 * the one to retire. Where BOTH sides carry data the merge is a real decision
 * with a unit conversion in it (g vs kg), and it says so rather than choosing.
 */
import 'dotenv/config';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import {
  products,
  recipeLines,
  sessionConsumptionLines,
  stockLevels,
  stockMovements,
  supplierProducts,
} from '../src/db/schema/index.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';

export interface TwinUsage {
  id: string;
  stockCode: string | null;
  stockUom: string | null;
  createdAt: Date | null;
  recipeLines: number;
  stockMovements: number;
  consumptionLines: number;
  supplierCodes: number;
  onHand: number;
}

export interface DuplicateGroup {
  name: string;
  twins: TwinUsage[];
  /**
   * 'one-sided'  — only one twin is used; the other is safe to retire.
   * 'unused'     — neither is used; either can go.
   * 'both-used'  — both carry data. A real merge, with a g/kg conversion.
   */
  verdict: 'one-sided' | 'unused' | 'both-used';
}

const countFor = async (
  table: { productId: unknown },
  productId: string,
): Promise<number> => {
  const db = getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(table as never)
    .where(eq(table.productId as never, productId));
  return row?.n ?? 0;
};

export async function findDuplicateProducts(
  companyId = getSingletonCompanyId(),
): Promise<DuplicateGroup[]> {
  const db = getDb();
  const live = await db
    .select({
      id: products.id,
      name: products.name,
      stockCode: products.stockCode,
      stockUom: products.stockUom,
      createdAt: products.createdAt,
    })
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

  const out: DuplicateGroup[] = [];
  for (const [, rows] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
    if (rows.length < 2) continue;
    const twins: TwinUsage[] = [];
    for (const p of rows) {
      const [rl, sm, scl, sp] = await Promise.all([
        countFor(recipeLines, p.id),
        countFor(stockMovements, p.id),
        countFor(sessionConsumptionLines, p.id),
        countFor(supplierProducts, p.id),
      ]);
      const [lvl] = await db
        .select({ q: sql<string>`coalesce(sum(${stockLevels.onHand}), 0)::text` })
        .from(stockLevels)
        .where(eq(stockLevels.productId, p.id));
      twins.push({
        id: p.id,
        stockCode: p.stockCode,
        stockUom: p.stockUom,
        createdAt: p.createdAt,
        recipeLines: rl,
        stockMovements: sm,
        consumptionLines: scl,
        supplierCodes: sp,
        onHand: Number(lvl?.q ?? 0),
      });
    }
    const used = (t: TwinUsage) =>
      t.recipeLines + t.stockMovements + t.consumptionLines + t.supplierCodes > 0 ||
      t.onHand !== 0;
    const usedCount = twins.filter(used).length;
    out.push({
      name: rows[0]!.name,
      twins,
      verdict: usedCount === 0 ? 'unused' : usedCount === 1 ? 'one-sided' : 'both-used',
    });
  }
  return out;
}

const isCliEntry = process.argv[1]?.endsWith('find-duplicate-products.ts') ?? false;

if (isCliEntry) {
  findDuplicateProducts()
    .then((groups) => {
      if (groups.length === 0) {
        console.log('[find-duplicate-products] No duplicate product names. Nothing to do.');
        return;
      }
      const by = (v: DuplicateGroup['verdict']) => groups.filter((g) => g.verdict === v);
      console.log(`[find-duplicate-products] READ-ONLY - nothing changed\n`);
      console.log(`  duplicate names   : ${groups.length}  (${groups.reduce((n, g) => n + g.twins.length, 0)} products)`);
      console.log(`  one side unused   : ${by('one-sided').length}  - safe to retire the idle twin`);
      console.log(`  neither used      : ${by('unused').length}  - either can go`);
      console.log(`  BOTH sides in use : ${by('both-used').length}  - a real merge, mind the g/kg conversion\n`);

      const show = (g: DuplicateGroup) => {
        console.log(`  ${g.name}  [${g.verdict}]`);
        for (const t of g.twins) {
          const bits = [
            `uom=${t.stockUom ?? '-'}`,
            `recipes=${t.recipeLines}`,
            `movements=${t.stockMovements}`,
            `consumption=${t.consumptionLines}`,
            `supplierCodes=${t.supplierCodes}`,
            `onHand=${t.onHand}`,
          ].join(' ');
          console.log(`     ${(t.stockCode ?? t.id).padEnd(30)} ${bits}`);
        }
      };
      if (by('both-used').length > 0) {
        console.log('  ── BOTH SIDES IN USE (decide these first) ──');
        by('both-used').forEach(show);
        console.log('');
      }
      console.log('  ── the rest ──');
      [...by('one-sided'), ...by('unused')].forEach(show);
    })
    .catch((err) => {
      console.error('[find-duplicate-products] FAILED:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => closeDatabase());
}
